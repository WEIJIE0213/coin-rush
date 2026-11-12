import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, RoomState, ServerMessage } from '../shared/protocol';
import { ClockSync } from './clock';
import { HitGuard } from './hitGuard';

export type Status = 'idle' | 'connecting' | 'joined' | 'reconnecting';
export type EffectKind = 'pending' | 'won' | 'lost';
export interface HitEffect { coinId: string; cell: number; kind: EffectKind; text?: string; at: number }
export interface Notice { id: number; text: string; tone: 'info' | 'error' }

const STORAGE_KEY = 'coinrush:session';
interface Saved { code: string; name: string; token?: string }
export function loadSaved(): Saved | null {
  try { const raw = sessionStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) as Saved : null; } catch { return null; }
}
function save(value: Saved | null) {
  try { if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); else sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}

const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const RETRY_DELAYS = [300, 800, 1500, 3000, 5000];
// Errors after which reconnecting is pointless: the room is full or the round already started.
const FATAL_JOIN = new Set(['ROOM_FULL', 'ROUND_STARTED', 'BAD_CODE', 'BAD_NAME', 'BUSY', 'ALREADY_JOINED']);

export function useGame() {
  const [status, setStatus] = useState<Status>('idle');
  const [state, setState] = useState<RoomState | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [effects, setEffects] = useState<HitEffect[]>([]);
  const [rtt, setRtt] = useState(0);

  const ws = useRef<WebSocket | null>(null);
  const target = useRef<Saved | null>(null);
  const version = useRef(-1);
  const retries = useRef(0);
  const retryTimer = useRef<number | undefined>(undefined);
  const clock = useRef(new ClockSync());
  const guard = useRef(new HitGuard());
  const noticeSeq = useRef(0);
  const effectCells = useRef(new Map<string, number>());

  const notify = useCallback((text: string, tone: Notice['tone'] = 'info') => {
    const id = ++noticeSeq.current;
    setNotices(list => [...list.slice(-3), { id, text, tone }]);
    window.setTimeout(() => setNotices(list => list.filter(n => n.id !== id)), 3200);
  }, []);

  /** Accept a snapshot only if it is newer than what we have (messages can race). */
  const applyState = useCallback((next: RoomState) => {
    if (next.version <= version.current) return;
    version.current = next.version;
    setState(next);
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const socket = ws.current;
    if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify(msg)); return true; }
    return false;
  }, []);

  const setEffect = useCallback((effect: HitEffect) => {
    setEffects(list => [...list.filter(e => e.coinId !== effect.coinId), effect]);
    // Final verdicts fade out; a pending effect is dropped if no verdict ever arrives.
    window.setTimeout(() => setEffects(list => list.filter(e => e !== effect)), effect.kind === 'pending' ? 2000 : 900);
  }, []);

  const teardown = useCallback(() => {
    window.clearTimeout(retryTimer.current);
    const socket = ws.current;
    ws.current = null;
    if (socket) { socket.onclose = null; socket.onmessage = null; socket.onerror = null; socket.close(); }
  }, []);

  const connect = useCallback(() => {
    teardown();
    const socket = new WebSocket(wsUrl());
    ws.current = socket;
    let syncTimer: number | undefined;
    let joinedHere = false;
    const sync = () => send({ type: 'sync', clientTime: Date.now() });

    socket.onopen = () => {
      const t = target.current;
      if (!t) { socket.close(); return; }
      send({ type: 'join', code: t.code, name: t.name, token: t.token });
      // A burst of samples first for a quick estimate, then refresh periodically.
      clock.current.reset();
      for (let i = 0; i < 4; i++) window.setTimeout(sync, i * 120);
      syncTimer = window.setInterval(sync, 5000);
    };

    socket.onmessage = event => {
      let msg: ServerMessage;
      try { msg = JSON.parse(event.data as string) as ServerMessage; } catch { return; }
      switch (msg.type) {
        case 'sync': {
          clock.current.add(msg.clientTime, msg.serverTime, Date.now());
          setRtt(Math.round(clock.current.rtt));
          break;
        }
        case 'joined': {
          joinedHere = true;
          retries.current = 0;
          version.current = -1;
          guard.current.reset();
          target.current = { ...target.current!, code: msg.state.code, token: msg.token };
          save(target.current);
          setPlayerId(msg.playerId);
          setError(null);
          setStatus('joined');
          applyState(msg.state);
          break;
        }
        case 'state': applyState(msg.state); break;
        case 'notice': notify(msg.text); break;
        case 'hit_result': {
          if (!guard.current.settle(msg.coinId, msg.requestId)) break;
          applyState(msg.state);
          const cell = effectCells.current.get(msg.coinId) ?? -1;
          effectCells.current.delete(msg.coinId);
          setEffect({ coinId: msg.coinId, cell, kind: msg.accepted ? 'won' : 'lost', text: msg.accepted ? '+1' : '慢了一步', at: Date.now() });
          break;
        }
        case 'error': {
          if (FATAL_JOIN.has(msg.code) && !joinedHere) {
            // Join refused: drop back to the lobby with a clear reason.
            target.current = null; save(null); teardown();
            setStatus('idle'); setState(null); setPlayerId(null);
            setError(msg.message);
          } else notify(msg.message, 'error');
          break;
        }
      }
    };

    socket.onclose = event => {
      window.clearInterval(syncTimer);
      if (ws.current !== socket) return;
      ws.current = null;
      if (!target.current || event.code === 4001) {
        if (event.code === 4001) setError('你已在其他标签页打开了本房间');
        setStatus('idle'); setState(null); setPlayerId(null);
        return;
      }
      const delay = RETRY_DELAYS[retries.current];
      if (delay === undefined) {
        target.current = null; save(null);
        setStatus('idle'); setState(null); setPlayerId(null);
        setError('无法连接服务器，请检查网络后重试');
        return;
      }
      retries.current++;
      setStatus(s => (s === 'joined' || s === 'reconnecting' ? 'reconnecting' : 'connecting'));
      retryTimer.current = window.setTimeout(connect, delay);
    };
    socket.onerror = () => { /* onclose handles recovery */ };
  }, [applyState, notify, send, setEffect, teardown]);

  const join = useCallback((code: string, name: string) => {
    const saved = loadSaved();
    const token = saved && saved.code.toUpperCase() === code.toUpperCase() ? saved.token : undefined;
    target.current = { code: code.toUpperCase(), name, token };
    retries.current = 0;
    setError(null);
    setStatus('connecting');
    connect();
  }, [connect]);

  const leave = useCallback(() => {
    send({ type: 'leave' });
    target.current = null; save(null); teardown();
    version.current = -1;
    setStatus('idle'); setState(null); setPlayerId(null); setEffects([]);
  }, [send, teardown]);

  const restart = useCallback(() => { send({ type: 'restart' }); }, [send]);

  /**
   * Optimistic hit: the animation starts immediately, but the score only changes when the
   * server's authoritative state arrives.
   */
  const hit = useCallback((coinId: string, cell: number) => {
    const decision = guard.current.tryHit(coinId);
    if (!decision.send) return false;
    if (!send({ type: 'hit', coinId, requestId: decision.requestId })) return false;
    effectCells.current.set(coinId, cell);
    if (effectCells.current.size > 50) effectCells.current.delete(effectCells.current.keys().next().value as string);
    setEffect({ coinId, cell, kind: 'pending', at: Date.now() });
    return true;
  }, [send, setEffect]);

  useEffect(() => teardown, [teardown]);

  const serverNow = useCallback(() => clock.current.serverNow(), []);
  const isLocked = useCallback((coinId: string) => guard.current.isLocked(coinId), []);

  return { status, state, playerId, error, notices, effects, rtt, join, leave, restart, hit, serverNow, isLocked, setError };
}
