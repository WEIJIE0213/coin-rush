/**
 * Client/server clock alignment (NTP-style).
 *
 * The coin's spawnedAt / expiresAt and all phase deadlines are server timestamps. The client
 * clock may be skewed by seconds, and every message is delayed by network latency, so we
 * estimate `offset = serverTime - clientTime` from round trips:
 *
 *   client sends t0  ->  server stamps ts  ->  client receives t1
 *   rtt = t1 - t0, and the server stamped roughly at t0 + rtt / 2, so offset ≈ ts - (t0 + rtt / 2)
 *
 * Samples with the smallest RTT have the least asymmetric-queueing error, so we use the
 * best sample among the recent ones.
 */
export interface ClockSample { offset: number; rtt: number }

export class ClockSync {
  private samples: ClockSample[] = [];
  constructor(private readonly keep = 8) {}

  add(clientSent: number, serverTime: number, clientReceived: number): ClockSample | null {
    const rtt = clientReceived - clientSent;
    if (!Number.isFinite(rtt) || rtt < 0) return null;
    const sample = { rtt, offset: serverTime - (clientSent + rtt / 2) };
    this.samples.push(sample);
    if (this.samples.length > this.keep) this.samples.shift();
    return sample;
  }

  get ready() { return this.samples.length > 0; }

  /** Best estimate of serverTime - clientTime (0 until the first sample arrives). */
  get offset() { return this.best()?.offset ?? 0; }

  /** Most recent RTT, which is what a player "feels" as ping. */
  get rtt() { return this.samples.at(-1)?.rtt ?? 0; }

  serverNow(clientNow = Date.now()) { return clientNow + this.offset; }

  reset() { this.samples = []; }

  private best() {
    let best: ClockSample | undefined;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best;
  }
}
