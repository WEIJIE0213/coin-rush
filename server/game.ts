import { randomUUID } from 'node:crypto';
import type { Coin, Phase, Player, RoomState } from '../shared/protocol.js';

export interface Member extends Player { token: string }
export interface Config { prepareMs: number; countdownMs: number; gameMs: number; coinLifeMs: number; spawnMinMs: number; spawnMaxMs: number; hitGraceMs?: number }
// hitGraceMs: lag compensation. Clients hide a coin at expiresAt (in server time), but a click
// made just before that moment still needs ~RTT/2 to reach us, so the server keeps the coin
// claimable for a short extra window. It must stay well below spawnMinMs.
export const defaults: Config = { prepareMs: 30_000, countdownMs: 3000, gameMs: 60_000, coinLifeMs: 2800, spawnMinMs: 1000, spawnMaxMs: 2400, hitGraceMs: 150 };
export class GameError extends Error { constructor(public code: string, message: string) { super(message); } }
export class Room {
  players = new Map<string, Member>();
  phase: Phase = 'waiting';
  deadline: number;
  coin: Coin | null = null;
  round = 1;
  version = 0;
  nextSpawn = 0;
  constructor(public code: string, public config: Config = defaults, now = Date.now()) { this.deadline = now + config.prepareMs; }
  add(name: string, now = Date.now()): Member {
    this.tick(now);
    if (this.players.size >= 5) throw new GameError('ROOM_FULL', '房间已满，最多允许 5 位玩家');
    if (this.phase !== 'waiting') throw new GameError('ROUND_STARTED', '本局已开始，请等待本局结束后加入新房间');
    const player = { id: randomUUID(), token: randomUUID(), name, score: 0, connected: true };
    this.players.set(player.id, player);
    if (this.players.size === 5) { this.phase = 'countdown'; this.deadline = now + this.config.countdownMs; }
    this.version++;
    return player;
  }
  remove(id: string) { this.players.delete(id); this.version++; }
  snapshot(now = Date.now()): RoomState {
    return { code: this.code, phase: this.phase, deadline: this.deadline, coin: this.coin ? { ...this.coin } : null, round: this.round, version: this.version, serverTime: now,
      players: [...this.players.values()].map(({ token: _token, ...player }) => ({ ...player })) };
  }
  tick(now = Date.now()): boolean {
    let changed = false;
    // Preserve absolute deadlines even when the event loop stalls.
    if (this.phase === 'waiting' && now >= this.deadline) { this.phase = 'countdown'; this.deadline += this.config.countdownMs; changed = true; }
    if (this.phase === 'countdown' && now >= this.deadline) { this.phase = 'playing'; this.deadline += this.config.gameMs; this.nextSpawn = now; changed = true; }
    if (this.phase === 'playing') {
      if (now >= this.deadline) { this.phase = 'finished'; this.coin = null; changed = true; }
      else {
        if (this.coin && now >= this.coin.expiresAt + this.grace) { this.coin = null; changed = true; }
        if (!this.coin && now >= this.nextSpawn) {
          this.coin = { id: randomUUID(), cell: Math.floor(Math.random() * 25), spawnedAt: now, expiresAt: Math.min(now + this.config.coinLifeMs, this.deadline) };
          this.nextSpawn = this.coin.expiresAt + this.spawnDelay(); changed = true;
        }
      }
    }
    if (changed) this.version++;
    return changed;
  }
  private get grace() { return Math.max(0, Math.min(this.config.hitGraceMs ?? 0, 500)); }
  private spawnDelay() { return this.config.spawnMinMs + Math.random() * (this.config.spawnMaxMs - this.config.spawnMinMs); }
  hit(playerId: string, coinId: string, now = Date.now()) {
    this.tick(now);
    const player = this.players.get(playerId);
    if (!player || !player.connected) return { accepted: false, reason: '玩家已离线' };
    if (this.phase !== 'playing') return { accepted: false, reason: '当前不在对战时间内' };
    if (!this.coin || this.coin.id !== coinId || now >= this.coin.expiresAt + this.grace) return { accepted: false, reason: '慢了一步，金币已被抢走或过期' };
    // Single-process in-memory critical section: no await, I/O or callbacks between
    // checking the unique ID, consuming the coin and incrementing the score.
    // Node dispatches message handlers serially; the next handler sees coin === null.
    this.coin = null;
    player.score++;
    this.nextSpawn = now + this.spawnDelay();
    this.version++;
    return { accepted: true, reason: '抢到了！+1' };
  }
  restart(now = Date.now()) {
    if (this.phase !== 'finished') throw new GameError('NOT_FINISHED', '本局尚未结束');
    for (const p of this.players.values()) p.score = 0;
    this.round++; this.coin = null;
    this.phase = this.players.size === 5 ? 'countdown' : 'waiting';
    this.deadline = now + (this.phase === 'countdown' ? this.config.countdownMs : this.config.prepareMs);
    this.version++;
  }
}
