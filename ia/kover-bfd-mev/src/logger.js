'use strict';

/**
 * High-precision structured logger.
 * Uses pino for low-overhead JSON output and exposes `traceTimeline()` to
 * record a [Reception → Simulation → Envoi] timeline with millisecond
 * resolution, suitable for post-mortem analysis of riposte latency.
 */

const pino = require('pino');

/**
 * Redaction list — these paths are zero'd out before pino serializes any log
 * record. We never log private keys, API keys, bearer tokens, or signed raw
 * transactions. The `*.privateKey` syntax matches the field at any depth.
 *
 * Adding a new sensitive field? Append it here AND audit existing call-sites.
 */
const REDACT_PATHS = [
  // Wallet / signing
  'privateKey', 'PRIVATE_KEY',
  '*.privateKey', '*.PRIVATE_KEY',
  'rawTransaction', 'rawTx', '*.rawTransaction', '*.rawTx',
  'signedTx', 'signed', '*.signedTx', '*.signed',
  // Provider credentials
  'apiKey', 'api_key', 'API_KEY',
  '*.apiKey', '*.api_key', '*.API_KEY',
  'CEREBRAS_API_KEY', '*.CEREBRAS_API_KEY',
  'ANTHROPIC_API_KEY', '*.ANTHROPIC_API_KEY',
  // HTTP auth
  'authorization', 'Authorization',
  '*.authorization', '*.Authorization',
  'cookie', 'Cookie', '*.cookie', '*.Cookie',
  // RPC URLs (contain auth tokens)
  'WSS_RPC_URL', 'HTTPS_RPC_URL', 'FLASHBOTS_RPC_URL',
  '*.wssRpcUrl', '*.httpsRpcUrl', '*.flashbotsRpcUrl',
];

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'kover-mev', pid: process.pid },
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
});

/**
 * Returns a fresh timeline tracker. Each `mark()` records a stage and the
 * elapsed time from the previous stage AND from t0.
 *
 * @param {string} txHash
 */
function newTimeline(txHash) {
  const start = process.hrtime.bigint();
  let last = start;
  const stages = [];

  return {
    mark(stage, extra = {}) {
      const now = process.hrtime.bigint();
      const sinceStart = Number((now - start) / 1_000_000n);
      const sinceLast = Number((now - last) / 1_000_000n);
      last = now;
      stages.push({ stage, sinceStartMs: sinceStart, sinceLastMs: sinceLast, ...extra });
      logger.info({ txHash, stage, sinceStartMs: sinceStart, sinceLastMs: sinceLast, ...extra },
        `timeline ${stage}`);
    },
    flush() {
      const totalMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      logger.info({ txHash, totalMs, stages }, 'timeline complete');
      return totalMs;
    },
  };
}

module.exports = { logger, newTimeline };
