'use strict';

/**
 * In-process event bus shared between the sentinel pipeline and any
 * subscriber (HTTP dashboard, metrics exporter, alerting hook, …).
 *
 * Why an EventEmitter instead of a Kafka topic?
 *   - Zero-cost in-process pub/sub (microsecond fan-out)
 *   - The dashboard runs in the same Node process as the sentinel
 *   - Production deployments can replace this module with a Kafka producer
 *     without changing publisher call-sites — schema is stable.
 *
 * Hardening
 * ---------
 *   - listener cap (default 64) — blocks unbounded subscriber accumulation
 *     if a buggy client opens connections in a loop without cleaning up
 *   - per-event payload size cap (default 32 KB after JSON serialization) —
 *     refuses to publish anything larger, which would either OOM the SSE
 *     pump or hint at a bug upstream
 *   - publish() never throws — a subscriber that throws is caught and
 *     logged; the rest of the fan-out continues
 *
 * Event taxonomy (stable wire format):
 *
 *   pending     { hash, ts }
 *   candidate   { hash, from, to, reasons[], ts }
 *   simulation  { hash, drainedWei, drainedEth, latencyMs, ts }
 *   attack      { hash, from, drainedEth, ratio, threshold, ts }
 *   riposte     { hackerHash, riposteHash, maxFee, maxPriority, ts }
 *   halt        { riposteHash, blockNumber, position, ts }
 *   analysis    { hash, verdict, severity, exploitClass, ts, ... }
 *   error       { stage, msg, ts }
 *   stats       { tx, candidates, simulations, halts, tps, ts }
 *
 * All `ts` fields are millisecond Unix timestamps (Number).
 *
 * @module    src/eventBus
 * @author    KOVER.IA platform team
 * @license   Proprietary
 */

const { EventEmitter } = require('node:events');

const MAX_LISTENERS         = Number(process.env.BUS_MAX_LISTENERS         || '64');
const MAX_PAYLOAD_BYTES     = Number(process.env.BUS_MAX_PAYLOAD_BYTES     || String(32 * 1024));
const PUBLISH_DROP_LOG_RATE = 50; // log 1-in-N drops to avoid log spam

class EventBus extends EventEmitter {
  constructor() {
    super({ captureRejections: true });
    this.setMaxListeners(MAX_LISTENERS);
    this._dropCount = 0;
  }

  /**
   * Publishes an event with a `ts` field auto-injected if missing.
   * Validates payload size; oversized events are dropped (with periodic logs)
   * rather than propagating — this protects downstream consumers (SSE pump,
   * Kafka producer, etc.) from a single misbehaving publisher.
   *
   * @param {string} type  one of the event names listed above
   * @param {object} [payload]
   * @returns {boolean} true if delivered, false if dropped
   */
  publish(type, payload = {}) {
    if (typeof type !== 'string' || !type) return false;

    const enriched = { ts: Date.now(), ...payload };

    // Cap payload size — anti-OOM. We tolerate the JSON serialization cost
    // because event volume is low and the cap is rarely hit on legitimate
    // events (typical payload < 2 KB).
    let serialized;
    try {
      serialized = JSON.stringify(enriched, _bigintReplacer);
    } catch (err) {
      this._safeWarn('publish: payload JSON-serialization failed', { type, err: err.message });
      return false;
    }
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      this._dropCount += 1;
      if (this._dropCount % PUBLISH_DROP_LOG_RATE === 1) {
        this._safeWarn(`publish: dropping oversize ${type} payload`, {
          size: serialized.length, cap: MAX_PAYLOAD_BYTES, dropped: this._dropCount,
        });
      }
      return false;
    }

    try {
      this.emit(type, enriched);
      this.emit('*', { type, ...enriched });
      return true;
    } catch (err) {
      this._safeWarn('publish: subscriber threw', { type, err: err.message });
      return false;
    }
  }

  /** Best-effort warn that won't crash if the logger itself misbehaves. */
  _safeWarn(msg, ctx) {
    try {
      // Avoid cyclic require on the logger module by lazy-loading.
      const { logger } = require('./logger');
      logger.warn(ctx, `[eventBus] ${msg}`);
    } catch { /* swallow — we're already in an error path */ }
  }
}

/** JSON.stringify replacer that coerces BigInt to decimal string. */
function _bigintReplacer(_k, v) {
  return typeof v === 'bigint' ? v.toString() : v;
}

// Singleton — every importer shares the same bus instance.
const bus = new EventBus();

// Surface unhandled rejections from listeners.
bus.on('error', (err) => bus._safeWarn('listener error captured by bus', { err: err?.message }));

module.exports = bus;
