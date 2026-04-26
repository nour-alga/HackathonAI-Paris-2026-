'use strict';

/**
 * KOVER.IA — Combined dashboard + live-mempool + attack-injection runtime
 * ===========================================================================
 *
 * What this script does
 * ---------------------
 *   1. Boots the HTTP dashboard (SSE + UI) at http://127.0.0.1:DASHBOARD_PORT
 *   2. Connects to the QuickNode WSS endpoint (read-only) and publishes
 *      every observed pending tx to the in-process event bus.
 *   3. Sampled candidates (1 in N) are fetched in full and pre-filtered;
 *      every match emits a `candidate` + `simulation` event (drain=0).
 *   4. Every `attackPeriodSec` seconds, a SYNTHETIC flashloan attack scenario
 *      is injected into the bus — the dashboard reacts with a full incident
 *      flow (candidate → simulation → attack → riposte → halt).
 *
 * Why this entrypoint exists
 * --------------------------
 *   The real sentinel only fires a riposte when an actual flashloan tx
 *   targeting our vault appears in the public mempool — extremely rare in
 *   practice. To make the dashboard usable for demos / training / QA, we
 *   stage a deterministic attack that exercises the full reaction pipeline
 *   without ever touching the chain.
 *
 *   Hard guarantees:
 *     - Every event is in-process. No transaction is broadcast.
 *     - No real signing key is used. No tx is sent to Flashbots.
 *     - The injected attack is a fixture from `demo/scenario.js`.
 *
 * Run:    npm run start:demo
 *         (then open http://127.0.0.1:8787 in your browser)
 *
 * @author KOVER.IA platform team
 */

require('dotenv').config();

const { WebSocketProvider, JsonRpcProvider } = require('ethers');

const dashboard = require('../dashboard/server');
const bus       = require('./eventBus');
const { FLASHLOAN_PROVIDERS, FLASHLOAN_SELECTORS } = require('./constants');
const { AIAnalyst } = require('./aiAnalyst');
const { ATTACK_TX, SIMULATION_TRACE, TARGETED_VAULT, VAULT_TVL_ETH,
        ATTACKER_EOA } = require('../demo/scenario');
const { generateTx } = require('../demo/mempool_simulator');
const { BurstGenerator } = require('./burst');

const aiAnalyst = new AIAnalyst();
const burst = new BurstGenerator();

// ===========================================================================
// CONFIGURATION
// ===========================================================================

const CONFIG = Object.freeze({
  txFetchStride:        Number(process.env.DEMO_FETCH_STRIDE      || '2'),

  // ---- Attack injection trigger (count-based) ----
  // First attack fires once N pending transactions have streamed through.
  // Set DEMO_INJECT_PERIOD_TX > 0 to re-inject every M additional tx.
  attackAfterTxCount:   Number(process.env.DEMO_INJECT_AFTER_TX   || '2000'),
  attackRepeatTxCount:  Number(process.env.DEMO_INJECT_PERIOD_TX  || '2000'),

  // ---- Wall-clock safety net ----
  // If mempool is slow / WSS stalls, fire the first attack after this many
  // ms regardless of the tx count. Set to 0 to disable.
  attackFallbackMs:     Number(process.env.DEMO_INJECT_FALLBACK_MS|| '180000'),

  // ---- Synthetic mempool generator ----
  // Guarantees the dashboard always shows scrolling traffic even when the
  // QuickNode WSS is throttled, dead, or rate-limited. Synthetic tx publish
  // realistic `pending` events on the bus alongside any real tx the live
  // bridge delivers. Set rate to 0 to disable.
  syntheticTxPerSec:    Number(process.env.DEMO_SYNTH_RATE        || '30'),

  ethDrainThreshold: 10,
  poolFractionThreshold: 0.05,
});

const VAULT_LC = TARGETED_VAULT.toLowerCase();

// ===========================================================================
// MEMPOOL → BUS BRIDGE
// ===========================================================================

/**
 * Pre-filter heuristic, kept in lock-step with src/sentinel.isFlashloanCandidate.
 *
 * @param {{ to?: string|null, data?: string|null }} tx
 * @returns {string[]} reasons; empty array means non-candidate
 */
function isCandidateReasons(tx) {
  if (!tx?.to || !tx?.data || tx.data.length < 10) return [];
  const to = tx.to.toLowerCase();
  const sel = tx.data.slice(0, 10).toLowerCase();
  const reasons = [];
  if (FLASHLOAN_PROVIDERS.has(to))       reasons.push(`to ∈ flashloan_providers`);
  if (FLASHLOAN_SELECTORS.has(sel))      reasons.push(`selector ${sel} known`);
  if (tx.data.toLowerCase().includes(VAULT_LC.slice(2))) reasons.push('vault in calldata');
  return reasons;
}

/**
 * Subscribes to QuickNode WSS, samples 1 in `txFetchStride`, fetches the
 * full body of each sample, runs the pre-filter, and publishes events.
 *
 * Keeps the real sentinel's resilience semantics minimal here — this entry-
 * point is for the demo dashboard, not for production guarding (the real
 * sentinel ships in src/sentinel.js).
 */
async function startMempoolBridge() {
  const wssUrl   = process.env.WSS_RPC_URL;
  const httpsUrl = process.env.HTTPS_RPC_URL;
  if (!wssUrl || !httpsUrl) {
    // eslint-disable-next-line no-console
    console.error('[start_demo] missing WSS_RPC_URL / HTTPS_RPC_URL in .env');
    process.exit(1);
  }

  const ws   = new WebSocketProvider(wssUrl, 1, { staticNetwork: true });
  const http = new JsonRpcProvider(httpsUrl, 1, { staticNetwork: true });
  await ws._waitUntilReady?.().catch(() => null);
  // eslint-disable-next-line no-console
  console.log('[start_demo] WSS connected — streaming pending tx into the bus');

  ws.on('pending', async (hash) => {
    onPendingTx(hash);

    if (totalCount % CONFIG.txFetchStride !== 0) return;

    let tx;
    try { tx = await http.getTransaction(hash); }
    catch (_) { return; }
    if (!tx || !tx.to || !tx.data) return;

    const reasons = isCandidateReasons(tx);
    if (reasons.length === 0) return;

    bus.publish('candidate', {
      hash, from: tx.from, to: tx.to,
      selector: tx.data.slice(0, 10),
      reasons,
    });

    // Mocked simulation for real-mainnet candidates: they don't touch our
    // vault, so drainedWei is 0. We still publish so the dashboard shows
    // the simulation step happening.
    const latencyMs = 28 + Math.random() * 36;
    setTimeout(() => {
      bus.publish('simulation', {
        hash,
        drainedWei: '0',
        drainedEth: 0,
        latencyMs,
      });
    }, latencyMs);
  });

  // Auto-reconnect on socket close, with proper teardown of the previous
  // provider to avoid piling on duplicate listeners. Backoff is constant 2 s
  // for the demo (the production sentinel uses exponential backoff).
  let _wsAlive = ws;
  const reconnect = async () => {
    if (_wsAlive) {
      try { await _wsAlive.removeAllListeners(); await _wsAlive.destroy(); } catch { /* ignore */ }
      _wsAlive = null;
    }
    setTimeout(() => startMempoolBridge().catch((e) =>
      // eslint-disable-next-line no-console
      console.error('[start_demo] reconnect failed:', e.message)), 2000);
  };

  const wsRaw = ws.websocket;
  wsRaw?.once?.('close', () => {
    // eslint-disable-next-line no-console
    console.warn('[start_demo] WSS closed — reconnecting in 2 s');
    reconnect();
  });
  wsRaw?.once?.('error', (err) => {
    bus.publish('error', { stage: 'wss', msg: err.message });
    reconnect();
  });
}

// ===========================================================================
// SYNTHETIC ATTACK INJECTION
// ===========================================================================

/**
 * Replays the canonical flashloan-attack scenario against the bus, with
 * realistic inter-stage pacing so the dashboard animates the incident.
 *
 * Stage timing (ms):
 *
 *   t+0     candidate  : pre-filter trips on the synthetic tx
 *   t+200   simulation : 47 ms simulated, drain=847.32 ETH
 *   t+650   attack     : decision threshold breached
 *   t+1100  riposte    : halt tx broadcast (mocked)
 *   t+2400  halt       : included @ block 19,243,521 pos 3
 */
function injectAttack() {
  const hash    = ATTACK_TX.hash;
  const fromEoa = ATTACK_TX.from;
  const drainedEth = 847.32;
  const ratio   = (drainedEth / Number(VAULT_TVL_ETH)) * 100;
  const riposteHash = '0xc1rcu1tbreakerc1rcu1tbreakerc1rcu1tbreakerc1rcu1tbreaker0deadbf1';

  // eslint-disable-next-line no-console
  console.log(`[start_demo] injecting attack scenario  hash=${hash}`);

  bus.publish('pending', { hash });

  setTimeout(() => bus.publish('candidate', {
    hash, from: fromEoa, to: ATTACK_TX.to,
    selector: ATTACK_TX.data.slice(0, 10),
    reasons: [
      'to ∈ flashloan_providers (Aave V3 Pool)',
      `selector ${ATTACK_TX.data.slice(0, 10)} known`,
      'vault address present in calldata',
    ],
  }), 50);

  setTimeout(() => bus.publish('simulation', {
    hash,
    drainedWei: '847320000000000000000',
    drainedEth,
    latencyMs: 47,
  }), 250);

  setTimeout(() => bus.publish('attack', {
    hash,
    from: fromEoa,
    drainedEth,
    ratio,
    threshold: CONFIG.ethDrainThreshold,
    reason: 'absolute-and-fraction-threshold',
  }), 700);

  setTimeout(() => bus.publish('riposte', {
    hackerHash: hash,
    riposteHash,
    maxFee:      120,
    maxPriority: 62,
    strategy:    process.env.GAS_STRATEGY || 'additive',
  }), 1150);

  setTimeout(() => bus.publish('halt', {
    riposteHash,
    blockNumber: 19_243_521,
    position:    3,
  }), 2400);

  // Fan out to the LLM Agent — runs asynchronously so the dashboard sees
  // the deterministic stages first, then the analysis verdict ~3-5s later.
  aiAnalyst
    .analyzeAndPublish({
      tx: {
        hash, from: fromEoa, to: ATTACK_TX.to,
        data: ATTACK_TX.data, value: ATTACK_TX.value,
        gasLimit: ATTACK_TX.gasLimit,
        maxFeePerGas: ATTACK_TX.maxFeePerGas,
        maxPriorityFeePerGas: ATTACK_TX.maxPriorityFeePerGas,
      },
      trace: SIMULATION_TRACE,
      drainedWei: BigInt('847320000000000000000'),
      drainedEth,
      vaultAddress: TARGETED_VAULT,
      tvlEth: Number(VAULT_TVL_ETH),
    }, hash)
    .catch((err) => console.error('[ai_analyst] publish failed:', err.message));
}

// ===========================================================================
// MAIN
// ===========================================================================

// ---------------------------------------------------------------------------
// COUNT-BASED ATTACK INJECTION
// ---------------------------------------------------------------------------
//
// We let the user *see* legitimate mempool traffic scroll first (real Aave
// flashloans, ERC-20 transfers, Uniswap swaps, etc.) — then, once N pending
// transactions have flowed through, we inject the synthetic vault-drain
// attack. This makes the demo cinematically clear: "watch normal traffic
// for 2,000 tx … then the attacker shows up, and KOVER catches him."
//
// `attacksInjected` is the running count of attacks fired. The next attack
// fires when:  count ≥ attackAfterTxCount + attacksInjected × attackRepeatTxCount
//
// Set `attackRepeatTxCount` to 0 to inject only ONCE.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SHARED PENDING-TX COUNTER
// ---------------------------------------------------------------------------
// Both the real WSS handler and the synthetic generator increment this
// counter. The attack-injection trigger is keyed off it, so we never have
// to care which source delivered the tx.

let totalCount = 0;
let attacksInjected = 0;

function onPendingTx(hash) {
  totalCount += 1;
  bus.publish('pending', { hash });
  maybeInjectByCount(totalCount);
}

function maybeInjectByCount(currentCount) {
  // First injection
  if (attacksInjected === 0 && currentCount >= CONFIG.attackAfterTxCount) {
    attacksInjected = 1;
    // eslint-disable-next-line no-console
    console.log(`[start_demo] tx threshold ${CONFIG.attackAfterTxCount} reached — injecting attack`);
    injectAttack();
    return;
  }
  // Repeats
  if (CONFIG.attackRepeatTxCount > 0 && attacksInjected >= 1) {
    const nextThreshold =
      CONFIG.attackAfterTxCount + attacksInjected * CONFIG.attackRepeatTxCount;
    if (currentCount >= nextThreshold) {
      attacksInjected += 1;
      // eslint-disable-next-line no-console
      console.log(`[start_demo] tx threshold ${nextThreshold} reached — injecting attack #${attacksInjected}`);
      injectAttack();
    }
  }
}

// ---------------------------------------------------------------------------
// SYNTHETIC MEMPOOL GENERATOR
// ---------------------------------------------------------------------------
//
// Emits realistic-looking pending tx on the bus at a steady rate. The
// distribution comes from `demo/mempool_simulator` which is calibrated
// against a 60-second sample of mainnet (38% ERC-20, 17% Uniswap V3,
// 12% native, 2% flashloan, ...).
//
// The dashboard treats synthetic tx exactly like real ones — the scrolling
// feed is identical. This guarantees a usable demo even when the live WSS
// is throttled, the API key has expired, or the user is offline.
//
// Set `DEMO_SYNTH_RATE=0` to disable and rely solely on the real mempool.
// ---------------------------------------------------------------------------

function startSyntheticGenerator() {
  if (CONFIG.syntheticTxPerSec <= 0) return;

  // Use a 100 ms tick and emit floor(rate / 10) tx per tick. A rate of 30
  // tx/s → 3 tx every 100 ms — feels like a continuous scroll without
  // overloading the SSE channel.
  const TICK_MS = 100;
  const txPerTick = Math.max(1, Math.round((CONFIG.syntheticTxPerSec * TICK_MS) / 1000));

  // eslint-disable-next-line no-console
  console.log(`[start_demo] synthetic generator: ${CONFIG.syntheticTxPerSec} tx/s ` +
              `(${txPerTick} per ${TICK_MS} ms tick)`);

  setInterval(() => {
    for (let i = 0; i < txPerTick; i++) {
      const tx = generateTx();
      onPendingTx(tx.hash);
    }
  }, TICK_MS);
}

async function main() {
  // 1. Dashboard
  dashboard.start();
  // eslint-disable-next-line no-console
  console.log(`[start_demo] dashboard → http://127.0.0.1:${process.env.DASHBOARD_PORT || 8787}`);

  // 2. Synthetic generator — starts immediately, guarantees the demo works
  //    even if the real WSS never connects.
  startSyntheticGenerator();

  // 2b. Burst generator — high-throughput pre-filter benchmark. Off by
  //     default; enable with BURST_TARGET_EPS=1500000 to push 1.5M eps.
  burst.start();

  // 3. Real mempool → bus (best effort; fails gracefully if WSS is down)
  startMempoolBridge().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[start_demo] live WSS unavailable — synthetic stream only:', err.message);
  });

  // 3. Wall-clock safety net — if the mempool is too slow to reach the tx
  //    threshold within `attackFallbackMs`, fire the attack anyway. Prevents
  //    the demo from stalling silently when QuickNode is throttled.
  if (CONFIG.attackFallbackMs > 0) {
    setTimeout(() => {
      if (attacksInjected === 0) {
        // eslint-disable-next-line no-console
        console.warn(`[start_demo] fallback ${CONFIG.attackFallbackMs / 1000}s elapsed — injecting attack`);
        attacksInjected = 1;
        injectAttack();
      }
    }, CONFIG.attackFallbackMs);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[start_demo] attack will fire after ${CONFIG.attackAfterTxCount} pending tx ` +
    (CONFIG.attackRepeatTxCount > 0
      ? `(then every ${CONFIG.attackRepeatTxCount} tx) `
      : '(single shot) ') +
    `· fallback after ${CONFIG.attackFallbackMs / 1000}s`,
  );
}

// ---------------------------------------------------------------------------
// Graceful shutdown — drain in-flight, close subscriptions, exit cleanly.
// ---------------------------------------------------------------------------

let _shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 5000;

async function gracefulShutdown(signal, exitCode) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[start_demo] ${signal} — shutting down (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`);

  // Hard timer: if cleanup hangs, force exit.
  const force = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error('[start_demo] shutdown timeout — forcing exit');
    process.exit(exitCode);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();

  try { await dashboard.stop?.(); } catch { /* ignore */ }
  process.exit(exitCode);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT', 130));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0));

process.on('unhandledRejection', (err) => {
  // eslint-disable-next-line no-console
  console.error('[start_demo] unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[start_demo] uncaught exception — shutting down:', err);
  gracefulShutdown('uncaught', 1);
});

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[start_demo] fatal:', err);
  process.exit(1);
});
