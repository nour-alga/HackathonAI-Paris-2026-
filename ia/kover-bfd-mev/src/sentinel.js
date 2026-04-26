'use strict';

/**
 * Sentinel — mempool ingestion + flashloan detection + state-override simulation.
 *
 * Hot-path budget (target < 100 ms end-to-end):
 *   1. WSS  pending event           ~0   ms
 *   2. eth_getTransactionByHash     ~5–20 ms (provider RTT)
 *   3. flashloan heuristic          ~0.1 ms (set lookups)
 *   4. debug_traceCall (callTracer) ~30–80 ms
 *   5. fee bump + sign              ~5 ms
 *   6. eth_sendRawTransaction       ~10–30 ms
 *
 * Resilience:
 *   - Exponential backoff WSS reconnect with jitter
 *   - Heartbeat watchdog forces reconnect on 30s silence
 *   - All RPC calls have an explicit AbortController-based timeout
 */

require('dotenv').config();

const { WebSocketProvider, JsonRpcProvider, getBigInt, toQuantity } = require('ethers');
const { FLASHLOAN_PROVIDERS, FLASHLOAN_SELECTORS } = require('./constants');
const { FlashRun } = require('./flashrun');
const { logger, newTimeline } = require('./logger');
const bus = require('./eventBus');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const {
  WSS_RPC_URL,
  HTTPS_RPC_URL,
  PRIVATE_KEY,
  VAULT_ADDRESS,
  CHAIN_ID = '1',
  ETH_DRAIN_THRESHOLD = '10',           // ETH outflow that triggers riposte
  POOL_FRACTION_THRESHOLD = '0.05',     // 5% of TVL
  HEARTBEAT_TIMEOUT_MS = '30000',
  RECONNECT_BASE_MS = '500',
  RECONNECT_MAX_MS = '30000',
  RPC_TIMEOUT_MS = '120',
} = process.env;

if (!WSS_RPC_URL || !HTTPS_RPC_URL || !PRIVATE_KEY || !VAULT_ADDRESS) {
  logger.fatal('missing env: WSS_RPC_URL, HTTPS_RPC_URL, PRIVATE_KEY, VAULT_ADDRESS');
  process.exit(1);
}

const VAULT_LC = VAULT_ADDRESS.toLowerCase();
const DRAIN_WEI = BigInt(Math.floor(Number(ETH_DRAIN_THRESHOLD) * 1e18));
const POOL_FRACTION = Number(POOL_FRACTION_THRESHOLD);
const HEARTBEAT_TIMEOUT = Number(HEARTBEAT_TIMEOUT_MS);
const RECONNECT_BASE = Number(RECONNECT_BASE_MS);
const RECONNECT_MAX = Number(RECONNECT_MAX_MS);
const RPC_TIMEOUT = Number(RPC_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// Riposte engine + http provider used for simulation
// ---------------------------------------------------------------------------

const httpProvider = new JsonRpcProvider(HTTPS_RPC_URL, Number(CHAIN_ID), { staticNetwork: true });

/**
 * Per-EOA rate-limiter. Mitigates a DoS where the attacker floods the
 * mempool with cheap candidate-shaped tx to exhaust our trace-call budget.
 * 8 simulations / 10s / EOA is plenty for legitimate flashloan strategies.
 */
const SIM_QUOTA = 8;
const SIM_WINDOW_MS = 10_000;
const _simHits = new Map(); // from -> [timestamps]
function consumeSimQuota(from) {
  const now = Date.now();
  const arr = (_simHits.get(from) || []).filter((t) => now - t < SIM_WINDOW_MS);
  if (arr.length >= SIM_QUOTA) return false;
  arr.push(now);
  _simHits.set(from, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _simHits) {
    const fresh = v.filter((t) => now - t < SIM_WINDOW_MS);
    if (fresh.length === 0) _simHits.delete(k); else _simHits.set(k, fresh);
  }
}, 30_000).unref();

const flashrun = new FlashRun({
  httpsRpcUrl: HTTPS_RPC_URL,
  privateKey: PRIVATE_KEY,
  vaultAddress: VAULT_ADDRESS,
  chainId: Number(CHAIN_ID),
});

// Cached vault TVL — refreshed every 10s. Allows 5%-of-pool checks at zero cost
// during the hot path.
let cachedTvlWei = 0n;

async function refreshTvl() {
  try {
    const bal = await httpProvider.getBalance(VAULT_ADDRESS);
    cachedTvlWei = bal;
    logger.debug({ tvlEth: Number(bal / 10n ** 14n) / 1e4 }, 'tvl refreshed');
  } catch (err) {
    logger.error({ err: err.message }, 'tvl refresh failed');
  }
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Cheap pre-filter: is this calldata from / to a known flashloan vector?
 *
 * @param {{ to?: string|null, data?: string|null }} tx
 */
function isFlashloanCandidate(tx) {
  if (!tx?.to || !tx?.data || tx.data.length < 10) return false;
  const to = tx.to.toLowerCase();
  if (FLASHLOAN_PROVIDERS.has(to)) return true;
  const selector = tx.data.slice(0, 10).toLowerCase();
  if (FLASHLOAN_SELECTORS.has(selector)) return true;
  // Calldata mentions our vault as a downstream argument? worth simulating.
  return tx.data.toLowerCase().includes(VAULT_LC.slice(2));
}

/**
 * Sums all native-value calls *out of* the vault during the simulated execution.
 * Uses Geth's `callTracer` which is supported on QuickNode / Alchemy / Erigon.
 *
 * @param {object} tx ethers TransactionResponse-like
 * @returns {Promise<bigint>} total wei drained from VAULT_ADDRESS
 */
async function simulateDrain(tx) {
  // Geth/Erigon enforce strict QUANTITY hex (no leading zeros) on debug_traceCall.
  const callObj = {
    from: tx.from,
    to: tx.to,
    value: tx.value ? toQuantity(tx.value) : '0x0',
    gas: tx.gasLimit ? toQuantity(tx.gasLimit) : '0x1c9c380',
    data: tx.data ?? '0x',
    maxFeePerGas: tx.maxFeePerGas ? toQuantity(tx.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? toQuantity(tx.maxPriorityFeePerGas) : undefined,
  };

  // State override: ensures the attacker can't blame insufficient balance for
  // a failed simulation, and lets us pin the vault state at the latest block.
  const stateOverride = {
    [tx.from]: { balance: '0xffffffffffffffffffffffffffff' },
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RPC_TIMEOUT);
  let trace;
  try {
    trace = await httpProvider.send('debug_traceCall', [
      callObj,
      'latest',
      { tracer: 'callTracer', stateOverrides: stateOverride, timeout: '95ms' },
    ]);
  } finally {
    clearTimeout(timer);
  }

  return sumOutflow(trace, VAULT_LC);
}

/**
 * Walks a callTracer frame tree and sums every call where `from == vault`
 * (these are funds leaving the vault) and every internal value transfer.
 *
 * @param {any} frame
 * @param {string} vaultLc lowercase address
 * @returns {bigint}
 */
function sumOutflow(frame, vaultLc) {
  if (!frame) return 0n;
  let total = 0n;
  const fromLc = (frame.from || '').toLowerCase();
  if (fromLc === vaultLc && frame.value && frame.value !== '0x0' && frame.value !== '0x') {
    try { total += getBigInt(frame.value); } catch { /* ignore malformed */ }
  }
  if (Array.isArray(frame.calls)) {
    for (const child of frame.calls) total += sumOutflow(child, vaultLc);
  }
  return total;
}

/**
 * Decision: drain exceeds absolute threshold OR fraction-of-TVL threshold.
 *
 * @param {bigint} drainedWei
 */
function shouldFire(drainedWei) {
  if (drainedWei >= DRAIN_WEI) return { fire: true, reason: 'absolute-threshold' };
  if (cachedTvlWei > 0n) {
    // Compute fraction in fixed-point (basis points * 100 for precision).
    const ratioBps = Number((drainedWei * 1_000_000n) / cachedTvlWei) / 1_000_000;
    if (ratioBps >= POOL_FRACTION) return { fire: true, reason: 'pool-fraction', ratio: ratioBps };
  }
  return { fire: false };
}

// ---------------------------------------------------------------------------
// Hot path
// ---------------------------------------------------------------------------

async function onPendingTx(provider, txHash) {
  bumpHeartbeat();
  const tl = newTimeline(txHash);
  tl.mark('reception');
  bus.publish('pending', { hash: txHash });

  let tx;
  try {
    tx = await provider.getTransaction(txHash);
  } catch (err) {
    logger.debug({ txHash, err: err.message }, 'getTransaction failed');
    return;
  }
  if (!tx) return;
  tl.mark('fetched');

  if (!isFlashloanCandidate(tx)) return;
  const reasons = describeCandidate(tx);
  tl.mark('candidate', { to: tx.to, selector: tx.data.slice(0, 10) });
  bus.publish('candidate', {
    hash: txHash,
    from: tx.from,
    to: tx.to,
    selector: tx.data.slice(0, 10),
    reasons,
  });

  if (!consumeSimQuota(tx.from)) {
    logger.warn({ txHash, from: tx.from }, 'sim quota exhausted — skipping (DoS mitigation)');
    return;
  }

  const simStart = Date.now();
  let drainedWei = 0n;
  try {
    drainedWei = await simulateDrain(tx);
  } catch (err) {
    logger.error({ txHash, err: err.message }, 'simulation failed');
    bus.publish('error', { stage: 'simulation', msg: err.message });
    return;
  }
  const simLatencyMs = Date.now() - simStart;
  const drainedEth = Number(drainedWei) / 1e18;
  tl.mark('simulated', { drainedWei: drainedWei.toString() });
  bus.publish('simulation', {
    hash: txHash,
    drainedWei: drainedWei.toString(),
    drainedEth,
    latencyMs: simLatencyMs,
  });

  const decision = shouldFire(drainedWei);
  if (!decision.fire) {
    tl.mark('benign');
    tl.flush();
    return;
  }

  const tvlEth = Number(cachedTvlWei) / 1e18;
  const ratio  = tvlEth > 0 ? (drainedEth / tvlEth) * 100 : 0;
  bus.publish('attack', {
    hash: txHash,
    from: tx.from,
    drainedEth,
    ratio,
    threshold: ETH_DRAIN_THRESHOLD,
    reason: decision.reason,
  });
  logger.warn({ txHash, hackerFrom: tx.from, drainedWei: drainedWei.toString(), reason: decision.reason },
    'malicious flashloan detected — engaging riposte');

  const riposteHash = await flashrun.trigger(tx, tl);
  if (riposteHash) {
    bus.publish('riposte', {
      hackerHash: txHash,
      riposteHash,
    });
  }
  tl.flush();
}

/** Returns the human-readable list of indicators that tripped on this tx. */
function describeCandidate(tx) {
  const to = tx.to.toLowerCase();
  const sel = tx.data.slice(0, 10).toLowerCase();
  const out = [];
  if (FLASHLOAN_PROVIDERS.has(to))      out.push(`to ∈ flashloan_providers`);
  if (FLASHLOAN_SELECTORS.has(sel))     out.push(`selector ${sel} known`);
  if (tx.data.toLowerCase().includes(VAULT_LC.slice(2))) out.push('vault in calldata');
  return out;
}

// ---------------------------------------------------------------------------
// WebSocket lifecycle (exponential backoff + heartbeat watchdog)
// ---------------------------------------------------------------------------

let provider = null;
let reconnectAttempt = 0;
let heartbeatTimer = null;
let shuttingDown = false;

function backoff() {
  const exp = Math.min(RECONNECT_BASE * 2 ** reconnectAttempt, RECONNECT_MAX);
  return exp + Math.floor(Math.random() * 250);
}

function bumpHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    logger.warn('heartbeat timeout — forcing WSS reconnect');
    forceReconnect('heartbeat-timeout');
  }, HEARTBEAT_TIMEOUT);
}

async function forceReconnect(reason) {
  if (shuttingDown) return;
  if (provider) {
    try { await provider.removeAllListeners(); await provider.destroy(); } catch { /* ignore */ }
    provider = null;
  }
  const delay = backoff();
  reconnectAttempt += 1;
  logger.warn({ reason, attempt: reconnectAttempt, delayMs: delay }, 'scheduling reconnect');
  setTimeout(connect, delay);
}

async function connect() {
  if (shuttingDown) return;
  try {
    provider = new WebSocketProvider(WSS_RPC_URL, Number(CHAIN_ID), { staticNetwork: true });
    const ws = provider.websocket;
    ws.on?.('error', (err) => { logger.error({ err: err.message }, 'ws error'); forceReconnect('ws-error'); });
    ws.on?.('close', (code) => { logger.warn({ code }, 'ws closed'); forceReconnect('ws-close'); });

    await provider.on('pending', (txHash) => { onPendingTx(provider, txHash); });

    reconnectAttempt = 0;
    bumpHeartbeat();
    logger.info({ vault: VAULT_ADDRESS, drainThresholdEth: ETH_DRAIN_THRESHOLD },
      'sentinel armed — listening to mempool');
  } catch (err) {
    logger.error({ err: err.message }, 'connect failed');
    forceReconnect('connect-failed');
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  shuttingDown = true;
  logger.info({ signal }, 'shutdown initiated');
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  try { if (provider) await provider.destroy(); } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'unhandled rejection'));

(async () => {
  await flashrun.warmup();
  await refreshTvl();
  setInterval(refreshTvl, 10_000).unref();
  await connect();
})().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'fatal bootstrap error');
  process.exit(1);
});
