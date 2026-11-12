/**
 * Front-end protection against click spam on the same coin.
 *
 * 1. Per-coin lock: the first click on a coin (unique id) locks it locally. Every further click
 *    on that coin is ignored until the server's verdict arrives — and since a coin can only be
 *    taken once, it stays locked after the verdict too.
 * 2. Global throttle: at most one hit request per `minIntervalMs`, regardless of coin.
 * 3. Safety valve: if a verdict never arrives (dropped socket, rate limited) the lock is released
 *    after `pendingTimeoutMs`, so a coin that is still alive can be retried.
 */
export type HitDecision =
  | { send: true; requestId: string }
  | { send: false; reason: 'locked' | 'throttled' };

interface Pending { requestId: string; sentAt: number }

export class HitGuard {
  private pending = new Map<string, Pending>();
  private settled = new Set<string>();
  private lastSentAt = -Infinity;
  private seq = 0;

  constructor(private readonly minIntervalMs = 150, private readonly pendingTimeoutMs = 2000) {}

  tryHit(coinId: string, now = Date.now()): HitDecision {
    const p = this.pending.get(coinId);
    if (p && now - p.sentAt >= this.pendingTimeoutMs) this.pending.delete(coinId);
    if (this.settled.has(coinId) || this.pending.has(coinId)) return { send: false, reason: 'locked' };
    if (now - this.lastSentAt < this.minIntervalMs) return { send: false, reason: 'throttled' };
    const requestId = `${now.toString(36)}-${(++this.seq).toString(36)}`;
    this.pending.set(coinId, { requestId, sentAt: now });
    this.lastSentAt = now;
    return { send: true, requestId };
  }

  /** Record the server verdict. Returns false for unknown / stale request ids. */
  settle(coinId: string, requestId: string): boolean {
    const p = this.pending.get(coinId);
    if (!p || p.requestId !== requestId) return false;
    this.pending.delete(coinId);
    this.settled.add(coinId);
    if (this.settled.size > 200) this.settled.delete(this.settled.values().next().value as string);
    return true;
  }

  isLocked(coinId: string, now = Date.now()) {
    const p = this.pending.get(coinId);
    return this.settled.has(coinId) || (!!p && now - p.sentAt < this.pendingTimeoutMs);
  }

  reset() { this.pending.clear(); this.settled.clear(); this.lastSentAt = -Infinity; }
}
