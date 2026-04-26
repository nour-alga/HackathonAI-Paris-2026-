'use strict';

/**
 * Rolling session statistics for the demo dashboard.
 *
 * Tracks all the operational counters a real sentinel exposes (Prometheus-
 * style in production), plus a small ring buffer of per-window throughput
 * samples used to render the live tx/s gauge.
 *
 * This module is pure data — no IO, no rendering.
 */

class SessionStats {
  /**
   * @param {{ windowMs?: number, samples?: number }} [opts]
   *   windowMs : duration of one throughput-bucket (default 250 ms)
   *   samples  : how many buckets we keep for the moving average (default 8 → ~2 s)
   */
  constructor({ windowMs = 250, samples = 8 } = {}) {
    this._t0 = process.hrtime.bigint();
    this._windowMs = windowMs;
    this._samples = samples;

    /** @type {{ at: number, count: number }[]} */
    this._buckets = [{ at: Date.now(), count: 0 }];

    this.totals = {
      tx: 0,
      candidates: 0,
      simulations: 0,
      benign: 0,
      truePositives: 0,
      falsePositives: 0,
      halts: 0,
      simLatencyMs: 0,
      simRunCount: 0,
    };
  }

  /** Records one observed pending tx. */
  recordTx() {
    this.totals.tx += 1;
    const now = Date.now();
    const head = this._buckets[this._buckets.length - 1];
    if (now - head.at < this._windowMs) {
      head.count += 1;
    } else {
      this._buckets.push({ at: now, count: 1 });
      while (this._buckets.length > this._samples) this._buckets.shift();
    }
  }

  recordCandidate()      { this.totals.candidates += 1; }
  recordBenign()         { this.totals.benign += 1; }
  recordFalsePositive()  { this.totals.falsePositives += 1; }
  recordTruePositive()   { this.totals.truePositives += 1; }
  recordHalt()           { this.totals.halts += 1; }

  /** Records a simulation run with its latency in ms. */
  recordSimulation(latencyMs) {
    this.totals.simulations += 1;
    this.totals.simLatencyMs += latencyMs;
    this.totals.simRunCount  += 1;
  }

  /** Average sim latency in ms (returns 0 before the first sim). */
  avgSimLatencyMs() {
    return this.totals.simRunCount === 0 ? 0
      : this.totals.simLatencyMs / this.totals.simRunCount;
  }

  /** Throughput (tx/s) over the last `samples * windowMs` window. */
  throughput() {
    if (this._buckets.length === 0) return 0;
    const totalCount = this._buckets.reduce((a, b) => a + b.count, 0);
    const span = (this._buckets[this._buckets.length - 1].at - this._buckets[0].at) || this._windowMs;
    return Math.round((totalCount / span) * 1000);
  }

  /** Match-rate of the pre-filter (candidates / total). */
  matchRatePct() {
    return this.totals.tx === 0 ? 0 : (this.totals.candidates / this.totals.tx) * 100;
  }

  /** Session duration in seconds. */
  uptimeSec() {
    return Number((process.hrtime.bigint() - this._t0) / 1_000_000n) / 1000;
  }
}

module.exports = { SessionStats };
