import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { Room, GameError, defaults, type Config } from './game.js';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

interface Session { room?: Room; playerId?: string; lastPong: number; connectedAt: number; windowAt: number; messages: number }
export function createGameServer(options: { config?: Config; heartbeatMs?: number; staleMs?: number; joinTimeoutMs?: number } = {}) {
  const rooms = new Map<string, Room>();
  const sessions = new Map<WebSocket, Session>();
  const root = resolve('dist');
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  const server = createServer((req, res) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (path === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) })); return; }
    let file: string;
    try { file = resolve(root, '.' + decodeURIComponent(path)); } catch { res.writeHead(400); res.end(); return; }
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    if (path === '/' || (!extname(path) && !path.startsWith('/api'))) file = resolve(root, 'index.html');
    if (!existsSync(file) || file === root) { res.writeHead(404); res.end('Not found. Run npm run build first.'); return; }
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    const stream = createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res);
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  const send = (ws: WebSocket, message: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 1024 * 1024) ws.terminate(); else ws.send(JSON.stringify(message)); } };
  const broadcast = (room: Room, message: ServerMessage) => { for (const [ws, s] of sessions) if (s.room === room) send(ws, message); };
  const publish = (room: Room) => broadcast(room, { type: 'state', state: room.snapshot() });
  function detach(ws: WebSocket, explicit = false) {
    const s = sessions.get(ws);
    if (!s?.room || !s.playerId) return;
    const room = s.room, player = room.players.get(s.playerId);
    s.room = undefined; s.playerId = undefined;
    if (!player) return;
    // Transport closure immediately frees the slot. Reconnect may rejoin only in waiting.
    room.remove(player.id);
    broadcast(room, { type: 'notice', text: `${player.name}${explicit ? ' 离开了房间' : ' 已断开连接'}` });
    if (!room.players.size) rooms.delete(room.code); else publish(room);
  }
  wss.on('connection', ws => {
    const now = Date.now();
    const session: Session = { lastPong: now, connectedAt: now, windowAt: now, messages: 0 };
    sessions.set(ws, session);
    ws.on('pong', () => { session.lastPong = Date.now(); });
    ws.on('error', () => {});
    ws.on('close', () => { detach(ws); sessions.delete(ws); });
    ws.on('message', raw => {
      const now = Date.now();
      if (now - session.windowAt >= 1000) { session.windowAt = now; session.messages = 0; }
      if (++session.messages > 40) { send(ws, { type: 'error', code: 'RATE_LIMIT', message: '操作过于频繁，请稍候' }); if (session.messages > 80) ws.close(1008, 'Rate limit'); return; }
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        if (!msg || typeof msg !== 'object') throw new GameError('BAD_MESSAGE', '消息格式错误');
        if (msg.type === 'sync') { if (!Number.isFinite(msg.clientTime)) throw new GameError('BAD_MESSAGE', '时间参数无效'); send(ws, { type: 'sync', clientTime: msg.clientTime, serverTime: now }); return; }
        if (msg.type === 'join') {
          if (session.room) throw new GameError('ALREADY_JOINED', '请先离开当前房间');
          if (typeof msg.code !== 'string' || !/^[A-Za-z0-9]{1,12}$/.test(msg.code)) throw new GameError('BAD_CODE', '房间号需为 1–12 位字母或数字');
          if (typeof msg.name !== 'string' || !msg.name.trim() || [...msg.name.trim()].length > 12) throw new GameError('BAD_NAME', '昵称需为 1–12 个字符');
          const code = msg.code.toUpperCase();
          let room = rooms.get(code);
          if (!room) { if (rooms.size >= 1000) throw new GameError('BUSY', '服务器繁忙，请稍后再试'); room = new Room(code, options.config || defaults, now); rooms.set(code, room); }
          room.tick(now);
          // A refresh can replace its own still-open socket using a private resume token.
          const existing = typeof msg.token === 'string' ? [...room.players.values()].find(p => p.token === msg.token) : undefined;
          const player = existing || room.add(msg.name.trim(), now);
          if (existing) for (const [other, s] of sessions) if (other !== ws && s.room === room && s.playerId === player.id) { s.room = undefined; s.playerId = undefined; other.close(4001, 'Session replaced'); }
          session.room = room; session.playerId = player.id;
          send(ws, { type: 'joined', playerId: player.id, token: player.token, state: room.snapshot() });
          broadcast(room, { type: 'notice', text: `${player.name}${existing ? ' 恢复了连接' : ' 加入了房间'}` }); publish(room); return;
        }
        if (!session.room || !session.playerId) throw new GameError('NOT_JOINED', '请先加入房间');
        const room = session.room;
        if (msg.type === 'leave') { detach(ws, true); return; }
        if (msg.type === 'restart') { room.restart(now); broadcast(room, { type: 'notice', text: '新一局准备开始' }); publish(room); return; }
        if (msg.type === 'hit') {
          if (typeof msg.coinId !== 'string' || msg.coinId.length > 64 || typeof msg.requestId !== 'string' || msg.requestId.length > 64) throw new GameError('BAD_MESSAGE', '金币参数无效');
          const result = room.hit(session.playerId, msg.coinId, now);
          send(ws, { type: 'hit_result', coinId: msg.coinId, requestId: msg.requestId, ...result, state: room.snapshot() }); publish(room); return;
        }
        throw new GameError('BAD_MESSAGE', '不支持的消息类型');
      } catch (error) { send(ws, { type: 'error', code: error instanceof GameError ? error.code : 'BAD_MESSAGE', message: error instanceof GameError ? error.message : '消息格式错误，请检查后重试' }); }
    });
  });
  const loop = setInterval(() => { for (const room of rooms.values()) if (room.tick()) publish(room); }, 50);
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [ws, s] of sessions) {
      if (now - s.lastPong > (options.staleMs ?? 30_000) || (!s.room && now - s.connectedAt > (options.joinTimeoutMs ?? 60_000))) { detach(ws); ws.terminate(); }
      else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, options.heartbeatMs ?? 10_000);
  return { server, rooms, close: async () => { clearInterval(loop); clearInterval(heartbeat); for (const ws of sessions.keys()) ws.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createGameServer(); const port = Number(process.env.PORT || 3001);
  app.server.listen(port, '0.0.0.0', () => console.log(`Coin Rush server: http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}
