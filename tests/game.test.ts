import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, GameError, type Config } from '../server/game.js';

const cfg: Config = { prepareMs: 30_000, countdownMs: 3000, gameMs: 60_000, coinLifeMs: 2800, spawnMinMs: 1000, spawnMaxMs: 2400, hitGraceMs: 150 };
const T0 = 1_000_000;

function playingRoom() {
  const room = new Room('R', cfg, T0);
  room.add('a', T0); room.add('b', T0);
  room.tick(T0 + 30_000); // -> countdown
  room.tick(T0 + 33_000); // -> playing, first coin spawns
  assert.equal(room.phase, 'playing');
  assert.ok(room.coin);
  return room;
}

test('first player starts a 30s prepare window, then 3s countdown with current players', () => {
  const room = new Room('R', cfg, T0);
  room.add('a', T0);
  assert.equal(room.phase, 'waiting');
  room.tick(T0 + 29_999); assert.equal(room.phase, 'waiting');
  room.tick(T0 + 30_000); assert.equal(room.phase, 'countdown');
  assert.equal(room.deadline, T0 + 33_000);
  room.tick(T0 + 33_000); assert.equal(room.phase, 'playing');
  assert.equal(room.deadline, T0 + 93_000);
  room.tick(T0 + 93_000); assert.equal(room.phase, 'finished');
});

test('fifth player cuts the prepare window short and starts the 3s countdown immediately', () => {
  const room = new Room('R', cfg, T0);
  for (let i = 0; i < 4; i++) room.add(`p${i}`, T0 + i);
  assert.equal(room.phase, 'waiting');
  room.add('p4', T0 + 5000);
  assert.equal(room.phase, 'countdown');
  assert.equal(room.deadline, T0 + 5000 + 3000);
});

test('a sixth player is rejected with ROOM_FULL', () => {
  const room = new Room('R', cfg, T0);
  for (let i = 0; i < 5; i++) room.add(`p${i}`, T0);
  assert.throws(() => room.add('late', T0), (e: unknown) => e instanceof GameError && e.code === 'ROOM_FULL');
  assert.equal(room.players.size, 5);
});

test('joining after the round started is rejected', () => {
  const room = playingRoom();
  assert.throws(() => room.add('late', T0 + 34_000), (e: unknown) => e instanceof GameError && e.code === 'ROUND_STARTED');
});

test('two hits on the same coin: exactly one point is awarded', () => {
  const room = playingRoom();
  const [a, b] = [...room.players.values()];
  const coinId = room.coin!.id;
  const t = T0 + 33_100;
  const r1 = room.hit(a.id, coinId, t);
  const r2 = room.hit(b.id, coinId, t + 10); // 10ms later
  assert.equal(r1.accepted, true);
  assert.equal(r2.accepted, false);
  assert.equal(a.score + b.score, 1);
});

test('the same player spamming a coin scores only once', () => {
  const room = playingRoom();
  const [a] = [...room.players.values()];
  const coinId = room.coin!.id;
  const results = Array.from({ length: 10 }, (_, i) => room.hit(a.id, coinId, T0 + 33_100 + i));
  assert.equal(results.filter(r => r.accepted).length, 1);
  assert.equal(a.score, 1);
});

test('hits on stale or unknown coin ids are rejected', () => {
  const room = playingRoom();
  const [a] = [...room.players.values()];
  assert.equal(room.hit(a.id, 'nope', T0 + 33_100).accepted, false);
  assert.equal(a.score, 0);
});

test('lag compensation: a hit arriving inside the grace window still counts, after it does not', () => {
  const room = playingRoom();
  const [a, b] = [...room.players.values()];
  const coin = room.coin!;
  assert.equal(room.hit(a.id, coin.id, coin.expiresAt + 100).accepted, true);
  // The next coin: arrive after the grace window.
  room.tick(room.nextSpawn);
  const next = room.coin!;
  assert.ok(next && next.id !== coin.id);
  assert.equal(room.hit(b.id, next.id, next.expiresAt + cfg.hitGraceMs!).accepted, false);
  assert.equal(b.score, 0);
});

test('coins keep spawning on the board during a round and never after it ends', () => {
  const room = playingRoom();
  const seen = new Set<string>();
  for (let t = T0 + 33_000; t < T0 + 93_000; t += 50) { room.tick(t); if (room.coin) { seen.add(room.coin.id); assert.ok(room.coin.cell >= 0 && room.coin.cell < 25); } }
  assert.ok(seen.size > 10, `expected many coins, got ${seen.size}`);
  room.tick(T0 + 93_000);
  assert.equal(room.phase, 'finished');
  assert.equal(room.coin, null);
});

test('restart resets scores and returns to waiting', () => {
  const room = playingRoom();
  const [a] = [...room.players.values()];
  room.hit(a.id, room.coin!.id, T0 + 33_100);
  assert.throws(() => room.restart(T0 + 40_000), (e: unknown) => e instanceof GameError && e.code === 'NOT_FINISHED');
  room.tick(T0 + 93_000);
  room.restart(T0 + 94_000);
  assert.equal(room.phase, 'waiting');
  assert.equal(room.round, 2);
  assert.equal(a.score, 0);
});

test('snapshots never leak resume tokens', () => {
  const room = new Room('R', cfg, T0);
  const p = room.add('a', T0);
  assert.ok(!JSON.stringify(room.snapshot(T0)).includes(p.token));
});
