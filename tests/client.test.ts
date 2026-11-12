import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HitGuard } from '../src/hitGuard.js';
import { ClockSync } from '../src/clock.js';

test('HitGuard: 10 rapid clicks on the same coin produce exactly one request', () => {
  const g = new HitGuard(150, 2000);
  const sent = Array.from({ length: 10 }, (_, i) => g.tryHit('coin-1', 1000 + i * 100)).filter(d => d.send);
  assert.equal(sent.length, 1);
});

test('HitGuard: coin stays locked after the verdict', () => {
  const g = new HitGuard(0, 2000);
  const d = g.tryHit('c', 0);
  assert.ok(d.send);
  assert.equal(g.settle('c', d.requestId), true);
  assert.equal(g.tryHit('c', 5000).send, false);
});

test('HitGuard: ignores stale verdicts and unlocks after a lost verdict times out', () => {
  const g = new HitGuard(0, 2000);
  const d = g.tryHit('c', 0);
  assert.ok(d.send);
  assert.equal(g.settle('c', 'someone-else'), false);
  assert.equal(g.isLocked('c', 1999), true);
  assert.equal(g.isLocked('c', 2000), false);
  assert.equal(g.tryHit('c', 2000).send, true);
});

test('HitGuard: global throttle across different coins', () => {
  const g = new HitGuard(150, 2000);
  assert.equal(g.tryHit('a', 0).send, true);
  assert.deepEqual(g.tryHit('b', 100), { send: false, reason: 'throttled' });
  assert.equal(g.tryHit('b', 150).send, true);
});

test('ClockSync: estimates offset from round trips and prefers the lowest-RTT sample', () => {
  const c = new ClockSync();
  // Server clock is 5000ms ahead. Sample 1: symmetric 40ms RTT.
  c.add(1000, 1000 + 20 + 5000, 1040);
  assert.equal(c.offset, 5000);
  // Sample 2: 300ms RTT with asymmetric delay (250 up / 50 down) -> worse estimate, ignored.
  c.add(2000, 2000 + 250 + 5000, 2300);
  assert.equal(c.offset, 5000);
  assert.equal(c.rtt, 300);
  assert.equal(c.serverNow(10_000), 15_000);
});

test('ClockSync: rejects negative RTT samples', () => {
  const c = new ClockSync();
  assert.equal(c.add(100, 0, 50), null);
  assert.equal(c.ready, false);
});
