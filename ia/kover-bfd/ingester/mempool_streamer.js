'use strict';

/**
 * KOVER.IA — Mempool Streamer (Ingestion Layer)
 * ---------------------------------------------------------------------------
 * High-frequency WebSocket listener for pending transactions on Ethereum.
 * Filters by TARGET_CONTRACT, normalizes BigInt-safe payloads, and produces
 * to Kafka topic `kover-mempool-raw` with at-most-once non-blocking semantics
 * tuned for sub-millisecond hand-off.
 *
 * Resilience:
 *   - Exponential backoff reconnection (cap = 30s, jitter 0-250ms)
 *   - Kafka producer auto-recovery + idempotent retry
 *   - Heartbeat watchdog: forces reconnect if no `pending` event for 30s
 *
 * @author  KOVER.IA Platform Team
 * @license Proprietary
 */

const { WebSocketProvider } = require('ethers');
const { Kafka, Partitioners, CompressionTypes, logLevel } = require('kafkajs');
const winston = require('winston');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const {
  WSS_RPC_URL,
  TARGET_CONTRACT,
  KAFKA_BROKERS,
  KAFKA_CLIENT_ID = 'kover-mempool-ingester',
  KAFKA_TOPIC = 'kover-mempool-raw',
  RECONNECT_BASE_MS = '500',
  RECONNECT_MAX_MS = '30000',
  HEARTBEAT_TIMEOUT_MS = '30000',
} = process.env;

if (!WSS_RPC_URL || !TARGET_CONTRACT || !KAFKA_BROKERS) {
  // eslint-disable-next-line no-console
  console.error('Missing required env: WSS_RPC_URL, TARGET_CONTRACT, KAFKA_BROKERS');
  process.exit(1);
}

const TARGET_LC = TARGET_CONTRACT.toLowerCase();
const RECONNECT_BASE = Number(RECONNECT_BASE_MS);
const RECONNECT_MAX = Number(RECONNECT_MAX_MS);
const HEARTBEAT_TIMEOUT = Number(HEARTBEAT_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// Structured logger (JSON, latency-trace ready)
// ---------------------------------------------------------------------------

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: KAFKA_CLIENT_ID },
  transports: [new winston.transports.Console()],
});

// ---------------------------------------------------------------------------
// Kafka producer
// ---------------------------------------------------------------------------

const kafka = new Kafka({
  clientId: KAFKA_CLIENT_ID,
  brokers: KAFKA_BROKERS.split(',').map((s) => s.trim()),
  logLevel: logLevel.WARN,
  retry: { retries: 8, initialRetryTime: 100, maxRetryTime: 5_000 },
});

const producer = kafka.producer({
  allowAutoTopicCreation: false,
  createPartitioner: Partitioners.DefaultPartitioner,
  idempotent: true,
  maxInFlightRequests: 5,
});

/**
 * BigInt-safe JSON serializer. ethers.js v6 returns BigInt for value/gasPrice;
 * we coerce to decimal string to remain interoperable with downstream Python.
 *
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
function fastSerialize(payload) {
  return JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

// ---------------------------------------------------------------------------
// Reconnection state machine
// ---------------------------------------------------------------------------

let provider = null;
let reconnectAttempt = 0;
let heartbeatTimer = null;
let shuttingDown = false;

/**
 * Computes exponential backoff with jitter.
 * @param {number} attempt
 * @returns {number} delay in ms
 */
function backoffDelay(attempt) {
  const exp = Math.min(RECONNECT_BASE * 2 ** attempt, RECONNECT_MAX);
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

/**
 * Resets the heartbeat watchdog. Triggered on every `pending` event.
 */
function bumpHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    logger.warn('Heartbeat timeout — forcing WSS reconnect', { timeoutMs: HEARTBEAT_TIMEOUT });
    forceReconnect('heartbeat-timeout');
  }, HEARTBEAT_TIMEOUT);
}

/**
 * Tears down the current provider and schedules a reconnect.
 * @param {string} reason
 */
async function forceReconnect(reason) {
  if (shuttingDown) return;
  if (provider) {
    try {
      await provider.removeAllListeners();
      await provider.destroy();
    } catch (err) {
      logger.debug('Provider teardown error (ignored)', { err: err.message });
    }
    provider = null;
  }
  const delay = backoffDelay(reconnectAttempt++);
  logger.warn('Scheduling reconnect', { reason, attempt: reconnectAttempt, delayMs: delay });
  setTimeout(connect, delay);
}

// ---------------------------------------------------------------------------
// Tx handler — hot path
// ---------------------------------------------------------------------------

/**
 * Handles a pending tx hash from the mempool. Latency-critical: avoid await
 * chains where possible; fire-and-forget the Kafka send.
 *
 * @param {string} txHash
 */
async function onPendingTx(txHash) {
  bumpHeartbeat();
  const t0 = process.hrtime.bigint();

  let tx;
  try {
    tx = await provider.getTransaction(txHash);
  } catch (err) {
    logger.debug('getTransaction failed', { txHash, err: err.message });
    return;
  }
  if (!tx || !tx.to) return;
  if (tx.to.toLowerCase() !== TARGET_LC) return;

  const payload = {
    txHash: tx.hash,
    from: tx.from,
    to: tx.to,
    value: tx.value.toString(),                    // wei, decimal string
    gasPrice: (tx.gasPrice ?? tx.maxFeePerGas ?? 0n).toString(),
    nonce: tx.nonce,
    timestamp: Date.now(),                          // ingestion ts (ms epoch)
  };

  const serialized = fastSerialize(payload);

  producer
    .send({
      topic: KAFKA_TOPIC,
      compression: CompressionTypes.LZ4,
      messages: [{ key: tx.from, value: serialized }],
    })
    .then(() => {
      const latencyUs = Number((process.hrtime.bigint() - t0) / 1000n);
      logger.info('Produced mempool tx', { txHash: tx.hash, latencyUs });
    })
    .catch((err) => {
      logger.error('Kafka produce failed', { txHash: tx.hash, err: err.message });
    });
}

// ---------------------------------------------------------------------------
// Connection bootstrap
// ---------------------------------------------------------------------------

async function connect() {
  if (shuttingDown) return;
  try {
    logger.info('Connecting to WSS', { url: WSS_RPC_URL.replace(/\/.*@/, '/***@') });
    provider = new WebSocketProvider(WSS_RPC_URL);

    // ethers v6 surfaces socket errors via the underlying ws.
    const ws = provider.websocket;
    ws.on?.('error', (err) => {
      logger.error('WebSocket error', { err: err.message });
      forceReconnect('ws-error');
    });
    ws.on?.('close', (code) => {
      logger.warn('WebSocket closed', { code });
      forceReconnect('ws-close');
    });

    await provider.on('pending', onPendingTx);

    reconnectAttempt = 0;
    bumpHeartbeat();
    logger.info('Subscribed to pending mempool', { target: TARGET_CONTRACT });
  } catch (err) {
    logger.error('Connect failed', { err: err.message });
    forceReconnect('connect-failed');
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  shuttingDown = true;
  logger.info('Shutdown initiated', { signal });
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  try {
    if (provider) await provider.destroy();
    await producer.disconnect();
  } catch (err) {
    logger.error('Shutdown error', { err: err.message });
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

(async () => {
  await producer.connect();
  logger.info('Kafka producer connected', { brokers: KAFKA_BROKERS });
  await connect();
})().catch((err) => {
  logger.error('Fatal bootstrap error', { err: err.message, stack: err.stack });
  process.exit(1);
});
