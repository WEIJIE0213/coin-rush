import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.js';
import type { Config } from '../server/game.js';
import type { ServerMessage, ClientMessage } from '../shared/protocol.js';

const fast: Config = { prepareMs: 200, countdownMs: 100, gameMs: 5000, coinLifeMs: 3000, spawnMinMs: 300, spawnMaxMs: 400, hitGraceMs: 100 };

async function start(opts: Parameters<typeof createGameServer>[0] = {}) {
  const app = createGameServer({ config: fast, ...opts });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address() as AddressInfo;
  return { app, url: `ws://127.0.0.1:${port}/ws` };
}

class Client {
  messages: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  constructor(public ws: WebSocket) {
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      this.messages.push(msg);
      this.waiters = this.waiters.filter(w => (w.pred(msg) ? (w.resolve(msg), false) : true));
    });
  }
  static async open(url: string, options?: ConstructorParameters<typeof WebSocket>[2]) {
    const ws = new WebSocket(url, options);
    const c = new Client(ws);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    return c;
  }
  send(m: ClientMessage) { this.ws.send(JSON.stringify(m)); }
  wait<T extends ServerMessage['type']>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, ms = 3000) {
    const hit = this.messages.find(m => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
    if (hit) return Promise.resolve(hit as Extract<ServerMessage, { type: T }>);
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
      this.waiters.push({ pred: m => m.type === type && pred(m as Extract<ServerMessage, { type: T }>), resolve: m => { clearTimeout(timer); resolve(m as Extract<ServerMessage, { type: T }>); } });
    });
  }
  close() { this.ws.close(); }
}

test('6th player is rejected; join broadcasts a notice to the room', async () => {
  const { app, url } = await start({ config: { ...fast, prepareMs: 10_000 } });
  try {
    const clients: Client[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await Client.open(url);
      c.send({ type: 'join', code: 'full', name: `p${i}` });
      await c.wait('joined');
      clients.push(c);
    }
    await clients[0].wait('notice', m => m.text.includes('p4 加入了房间'));
    const sixth = await Client.open(url);
    sixth.send({ type: 'join', code: 'FULL', name: 'late' });
    const err = await sixth.wait('error');
    assert.equal(err.code, 'ROOM_FULL');
    // Room went straight to the 3s countdown when the 5th joined.
    const st = await clients[0].wait('state', m => m.state.phase === 'countdown');
    assert.equal(st.state.players.length, 5);
    [...clients, sixth].forEach(c => c.close());
  } finally { await app.close(); }
});

test('concurrent hits from two players on one coin: exactly one accepted, scores consistent', async () => {
  const { app, url } = await start();
  try {
    const a = await Client.open(url), b = await Client.open(url);
    a.send({ type: 'join', code: 'race', name: 'A' }); await a.wait('joined');
    b.send({ type: 'join', code: 'race', name: 'B' }); await b.wait('joined');
    let wins = 0, rounds = 0;
    const seen = new Set<string>();
    while (rounds < 5) {
      const st = await a.wait('state', m => m.state.phase === 'playing' && !!m.state.coin && !seen.has(m.state.coin.id), 5000);
      const coinId = st.state.coin!.id; seen.add(coinId);
      // Fire both requests back to back (well under 10ms apart), plus spam from each.
      for (let i = 0; i < 3; i++) { a.send({ type: 'hit', coinId, requestId: `a${rounds}-${i}` }); b.send({ type: 'hit', coinId, requestId: `b${rounds}-${i}` }); }
      const results = await Promise.all([0, 1, 2].flatMap(i => [a.wait('hit_result', m => m.requestId === `a${rounds}-${i}`), b.wait('hit_result', m => m.requestId === `b${rounds}-${i}`)]));
      const accepted = results.filter(r => r.accepted).length;
      assert.equal(accepted, 1, `coin ${coinId} awarded ${accepted} times`);
      wins += accepted; rounds++;
    }
    const final = await a.wait('state', m => m.state.players.reduce((n, p) => n + p.score, 0) === wins);
    assert.equal(final.state.players.reduce((n, p) => n + p.score, 0), 5);
    a.close(); b.close();
  } finally { await app.close(); }
});

test('heartbeat removes zombie players whose socket stopped answering pings', async () => {
  const { app, url } = await start({ config: { ...fast, prepareMs: 10_000 }, heartbeatMs: 50, staleMs: 200 });
  try {
    const alive = await Client.open(url);
    alive.send({ type: 'join', code: 'zz', name: 'alive' }); await alive.wait('joined');
    const zombie = await Client.open(url, { autoPong: false });
    zombie.send({ type: 'join', code: 'zz', name: 'zombie' }); await zombie.wait('joined');
    await alive.wait('state', m => m.state.players.length === 2);
    alive.messages = []; // only look at what happens after both are in
    const t0 = Date.now();
    const st = await alive.wait('state', m => m.state.players.length === 1 && m.state.players[0].name === 'alive', 3000);
    assert.equal(st.state.players.length, 1);
    await alive.wait('notice', m => m.text.includes('zombie'));
    assert.ok(Date.now() - t0 >= 150, 'zombie was removed before it went stale');
    alive.close();
  } finally { await app.close(); }
});

test('leaving frees the slot and the empty room is cleaned up', async () => {
  const { app, url } = await start({ config: { ...fast, prepareMs: 10_000 } });
  try {
    const a = await Client.open(url);
    a.send({ type: 'join', code: 'bye', name: 'A' }); await a.wait('joined');
    assert.equal(app.rooms.size, 1);
    a.send({ type: 'leave' });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(app.rooms.size, 0);
    a.close();
  } finally { await app.close(); }
});

test('rejects invalid input', async () => {
  const { app, url } = await start();
  try {
    const c = await Client.open(url);
    c.send({ type: 'join', code: 'bad code!', name: 'x' });
    assert.equal((await c.wait('error')).code, 'BAD_CODE');
    c.ws.send('not json');
    await c.wait('error', m => m.code === 'BAD_MESSAGE');
    c.send({ type: 'hit', coinId: 'x', requestId: 'y' });
    await c.wait('error', m => m.code === 'NOT_JOINED');
    c.close();
  } finally { await app.close(); }
});
