'use strict';

/**
 * KOVER.IA — Live Attack Demo
 * ===========================================================================
 *
 * Cinematic, end-to-end walkthrough of the Behavioral Flow Detection circuit
 * breaker: boot → 3 000-tx mempool ingestion → flashloan attack interception
 * → riposte broadcast → verdict → session post-mortem.
 *
 * EVERY business-logic primitive used below is the *real* one shipped in
 * `src/`:
 *
 *   - Pre-filter        →  src/constants.FLASHLOAN_PROVIDERS / SELECTORS
 *   - Outflow walker    →  identical to src/sentinel.sumOutflow
 *   - Fee-bumping rule  →  identical to src/flashrun._bumpedFees
 *
 * What is mocked, on purpose, so the demo is deterministic and offline:
 *
 *   - The mempool stream  (replaced by demo/mempool_simulator)
 *   - The eth_getTx RTT   (replaced by tunable jitter, 0.5–6 ms)
 *   - The debug_traceCall (replaced by a fixture trace from demo/scenario)
 *   - The chain inclusion (block number / position / revert reason)
 *
 * Tunables — see CONFIG block below — control ingestion volume, batch size,
 * pacing and the verbosity of candidate logging.
 *
 * Run:    npm run demo
 *         (or: node demo/run_attack_demo.js)
 *
 * Author: KOVER.IA platform team — proprietary
 * ===========================================================================
 */

const { getBigInt, parseEther } = require('ethers');

const {
  C, paint, rule, blank, section, banner, panel, table, progress, verdict,
  clearLine, hideCursor, showCursor,
} = require('./ui');
const { SessionStats } = require('./stats');
const { generateTx, jitterMs } = require('./mempool_simulator');
const { ATTACK_TX, SIMULATION_TRACE, TARGETED_VAULT, VAULT_TVL_ETH,
        ATTACKER_EOA, AAVE_V3_POOL } = require('./scenario');
const { FLASHLOAN_PROVIDERS, FLASHLOAN_SELECTORS } = require('../src/constants');

// ===========================================================================
// CONFIGURATION
// ===========================================================================

const CONFIG = Object.freeze({
  // Ingestion phase
  ingestionTarget:   3000,
  batchSize:           50,
  batchPauseMs:        85,   // wall-clock pause between two batches (UX pacing)

  // Pre-filter / simulation pacing
  candidateFullLogEvery: 6,  // every Nth candidate gets a verbose 3-line log
  checkpointEvery:    500,   // print a stats checkpoint every N tx
  simLatencyMin:       28,   // ms — lower bound of simulated RTT
  simLatencyMax:       64,   // ms — upper bound

  // Attack phase pacing
  attackBeats: {
    pendingReceived:  900,
    preFilter:        180,
    simulation:       320,
    analysis:         180,
    riposteEngage:    240,
    feeStrategy:       80,
    buildTx:           60,
    sign:              50,
    broadcast:         70,
    blockMined:       820,
  },

  // Display widths
  width: 78,

  // Economics
  ethPriceUsd: 3500,
});

// ===========================================================================
// CONSTANTS DERIVED FROM CONFIG / SCENARIO
// ===========================================================================

const VAULT_LC = TARGETED_VAULT.toLowerCase();
const t0 = Date.now();
const ts = () => `[T+${String(Date.now() - t0).padStart(5, ' ')}ms]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROVIDER_LABELS = Object.freeze({
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': 'Aave V3 Pool',
  '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9': 'Aave V2 Pool',
  '0xba12222222228d8ba445958a75a0704d566bf2c8': 'Balancer V2 Vault',
  '0x60744434d6339a6b27d73d9eda62b6f66a0a04fa': 'Maker DSS Flash',
  '0x1e0447b19bb6ecfdae1e4ae1694b0c3659614e4e': 'dYdX SoloMargin',
});

// ===========================================================================
// DETECTION HELPERS — mirror of src/sentinel.js (kept in lock-step intentionally)
// ===========================================================================

/**
 * @param {{ to: string, data: string }} tx
 * @returns {string[]}  list of human-readable reasons; empty array means "not a candidate"
 */
function isCandidateReasons(tx) {
  const to = tx.to.toLowerCase();
  const sel = tx.data.slice(0, 10).toLowerCase();
  const reasons = [];
  if (FLASHLOAN_PROVIDERS.has(to)) {
    reasons.push(`to ∈ flashloan_providers (${PROVIDER_LABELS[to] || 'unknown'})`);
  }
  if (FLASHLOAN_SELECTORS.has(sel)) {
    reasons.push(`selector ${sel} ∈ flashloan_selectors`);
  }
  if (tx.data.toLowerCase().includes(VAULT_LC.slice(2))) {
    reasons.push('vault address present in calldata');
  }
  return reasons;
}

/** Recursively sums every native-value call where `from == VAULT`. */
function sumOutflow(frame, vaultLc) {
  if (!frame) return 0n;
  let total = 0n;
  if ((frame.from || '').toLowerCase() === vaultLc && frame.value && frame.value !== '0x0') {
    try { total += getBigInt(frame.value); } catch { /* malformed frame — ignore */ }
  }
  if (Array.isArray(frame.calls)) {
    for (const c of frame.calls) total += sumOutflow(c, vaultLc);
  }
  return total;
}

/** Riposte fee strategy — identical to FlashRun._bumpedFees. */
function bumpedFees(hackerMaxFee, hackerPriority, bumpGwei = 50n, floorGwei = 60n) {
  const GWEI = 10n ** 9n;
  const bumped = hackerPriority + bumpGwei * GWEI;
  const floor  = floorGwei * GWEI;
  const myPriority = bumped > floor ? bumped : floor;
  const myMaxFee = (hackerMaxFee > myPriority ? hackerMaxFee : myPriority) + bumpGwei * GWEI;
  return { myPriority, myMaxFee };
}

// ===========================================================================
// DISPLAY HELPERS
// ===========================================================================

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : '?');
const fmtNum = (n) => n.toLocaleString('en-US');
const fmtPct = (p) => p.toFixed(2) + ' %';
const fmtMs  = (m) => m.toFixed(1) + ' ms';
const fmtEth = (wei) => (Number(wei / 10n ** 14n) / 1e4).toFixed(2);
const usd    = (eth) => '$' + (eth * CONFIG.ethPriceUsd).toLocaleString('en-US', { maximumFractionDigits: 0 });
const gwei   = (wei) => Number(wei / 10n ** 7n) / 100;

/** Pretty timestamp tag with consistent width for log-line alignment. */
function logTag(stage, colour = C.dim) {
  return `${paint(ts(), C.dim)} ${paint(stage.padEnd(11), colour)}`;
}

/** Renders the call tree of a debug_traceCall result, recursively. */
function printCallTree(frame, depth = 0) {
  const indent = '  '.repeat(depth);
  const arrow = depth === 0 ? '' : paint('└─ ', C.dim);
  const valueWei = frame.value && frame.value !== '0x0' ? getBigInt(frame.value) : 0n;
  const isVaultOut =
    (frame.from || '').toLowerCase() === VAULT_LC && valueWei > 0n;
  const valueStr = valueWei > 0n
    ? `  ${isVaultOut ? C.red + C.bold : C.dim}value=${fmtEth(valueWei)} ETH${C.reset}`
    : '';
  const tag = isVaultOut ? `  ${C.bgRed} ✗ vault outflow ${C.reset}` : '';
  console.log(
    `${indent}${arrow}${frame.type} ` +
    `${paint(`from=${short(frame.from)} → to=${short(frame.to)}`, C.dim)}` +
    `${valueStr}${tag}`,
  );
  if (frame.calls) for (const c of frame.calls) printCallTree(c, depth + 1);
}

// ===========================================================================
// PHASE 1 — BOOT SEQUENCE
// ===========================================================================

async function bootSequence() {
  banner();

  panel('SENTINEL CONFIGURATION', [
    ['build',          paint('kover-mev v1.0.0', C.brWhite) + paint('  node 24.15  ethers 6.13', C.dim)],
    ['vault address',  paint(TARGETED_VAULT, C.cyan)],
    ['security bot',   paint('0xK0v3R…B07', C.cyan) + paint('  // hot key — HSM-rotated', C.dim)],
    ['rpc — wss',      paint('quiknode://****', C.dim) + '         ' + paint('● connected', C.green)],
    ['rpc — https',    paint('quiknode://****', C.dim) + '         ' + paint('● connected', C.green)],
    ['flashbots',      paint('relay.flashbots.net', C.dim) + '     ' + paint('● connected', C.green)],
  ], { width: CONFIG.width });

  blank();

  panel('DETECTION THRESHOLDS', [
    ['absolute drain',      paint('≥ 10 ETH', C.yellow)],
    ['fraction of TVL',     paint('≥ 5 %', C.yellow) + paint(`   (TVL = ${VAULT_TVL_ETH} ETH)`, C.dim)],
    ['flashloan providers', paint(String(FLASHLOAN_PROVIDERS.size), C.cyan) + paint(' (Aave V2/V3, Balancer, dYdX, Maker)', C.dim)],
    ['flashloan selectors', paint(String(FLASHLOAN_SELECTORS.size), C.cyan) + paint(' (4-byte signatures)', C.dim)],
    ['rate-limit per EOA',  paint('8 sims / 10 s', C.cyan) + paint('  DoS mitigation', C.dim)],
    ['halt cooldown',       paint('30 s', C.cyan)],
  ], { width: CONFIG.width });

  blank();

  panel('GAS-WAR STRATEGY', [
    ['bump above hacker',  paint('+ 50 gwei priority', C.yellow)],
    ['priority floor',     paint('60 gwei', C.yellow) + paint('   beats global pool', C.dim)],
    ['halt gasLimit',      paint('120 000', C.cyan)],
    ['nonce strategy',     paint('cached + 15 s resync', C.cyan)],
    ['broadcast route',    paint('Flashbots Protect', C.green) + paint('   anti-backrun', C.dim)],
    ['signing',            paint('local secp256k1', C.cyan) + paint('     ~3 ms', C.dim)],
  ], { width: CONFIG.width });

  blank();
  console.log(`${paint('●', C.green)} ${paint('SENTINEL ARMED', C.bold)}    ${paint('mempool subscription active — entering live ingestion', C.dim)}`);
  rule(CONFIG.width);
  await sleep(700);
}

// ===========================================================================
// PHASE 2 — LIVE MEMPOOL INGESTION (3 000 tx)
// ===========================================================================

/**
 * @param {SessionStats} stats
 * @returns {Promise<{
 *   totalTx: number,
 *   candidates: number,
 *   simulations: number,
 *   benign: number,
 * }>}
 */
async function liveIngestion(stats) {
  section('LIVE MEMPOOL INGESTION', `target = ${fmtNum(CONFIG.ingestionTarget)} pending tx`);
  blank();

  let candidateIdx = 0;

  for (let processed = 0; processed < CONFIG.ingestionTarget; processed += CONFIG.batchSize) {
    const batchEnd = Math.min(processed + CONFIG.batchSize, CONFIG.ingestionTarget);

    for (let i = processed; i < batchEnd; i++) {
      const tx = generateTx();
      stats.recordTx();

      // ---- Pre-filter ----
      const reasons = isCandidateReasons(tx);
      if (reasons.length === 0) continue;

      stats.recordCandidate();
      candidateIdx += 1;

      // ---- Simulation (mocked latency; mocked drain=0 for FPs) ----
      const simLatency = CONFIG.simLatencyMin + Math.random() * (CONFIG.simLatencyMax - CONFIG.simLatencyMin);
      stats.recordSimulation(simLatency);

      // All candidates in this phase are false positives (no vault outflow).
      stats.recordFalsePositive();
      stats.recordBenign();

      // Decide whether to verbose-log this candidate.
      const verbose = candidateIdx % CONFIG.candidateFullLogEvery === 1;
      if (verbose) {
        clearLine();
        console.log();
        console.log(
          `${logTag('candidate', C.yellow)} ${paint('#' + candidateIdx, C.bold)}  ` +
          `tx ${short(tx.hash)}  ${paint(`from=${short(tx.from)}`, C.dim)}  ` +
          paint(`label=${tx.label}`, C.cyan),
        );
        for (const r of reasons) {
          console.log(`             ${paint('✓', C.green)} ${r}`);
        }
        console.log(
          `${logTag('simulated', C.dim)} ${paint('#' + candidateIdx, C.bold)}  ` +
          `${paint(`drainedWei=0`, C.dim)}  ` +
          `${paint(`sim=${fmtMs(simLatency)}`, C.dim)}  ` +
          `${paint('verdict=BENIGN', C.green)}`,
        );
      } else {
        // Compact one-liner so the log doesn't flood.
        clearLine();
        console.log(
          `${logTag('candidate', C.yellow)} #${String(candidateIdx).padEnd(3)} ` +
          `${paint(short(tx.hash), C.dim)} ` +
          `${paint(`(${tx.label})`, C.dim)} ` +
          `${paint('→', C.dim)} ` +
          `${paint('benign', C.green)} ${paint(`(sim ${simLatency.toFixed(0)} ms, drain=0)`, C.dim)}`,
        );
      }
    }

    // ---- Checkpoint ----
    if ((processed + CONFIG.batchSize) % CONFIG.checkpointEvery === 0) {
      clearLine();
      console.log(
        `${logTag('checkpoint', C.brCyan)} ` +
        `tx=${fmtNum(stats.totals.tx)}  ` +
        `cand=${stats.totals.candidates}  ` +
        `sims=${stats.totals.simulations}  ` +
        `tps=${stats.throughput()}  ` +
        `${paint(`avg sim=${fmtMs(stats.avgSimLatencyMs())}`, C.dim)}`,
      );
    }

    // ---- Live progress bar (in-place) ----
    const suffix =
      `${fmtNum(stats.totals.tx).padStart(5)}/${fmtNum(CONFIG.ingestionTarget)}  ` +
      `${paint(`${stats.throughput()} tx/s`, C.brCyan)}  ` +
      `${paint(`cand=${stats.totals.candidates}`, C.yellow)}  ` +
      `${paint(`sims=${stats.totals.simulations}`, C.cyan)}  ` +
      `${paint(`avg=${fmtMs(stats.avgSimLatencyMs())}`, C.dim)}`;
    process.stdout.write('\r' + progress(stats.totals.tx, CONFIG.ingestionTarget, suffix));

    // Pace the ingestion so the human eye can follow.
    await sleep(CONFIG.batchPauseMs + jitterMs(0, 8));
  }

  // Final progress line — finalise the in-place bar so subsequent log lines start fresh.
  clearLine();
  console.log(progress(stats.totals.tx, CONFIG.ingestionTarget, paint('ingestion complete', C.green)));
  blank();

  return {
    totalTx: stats.totals.tx,
    candidates: stats.totals.candidates,
    simulations: stats.totals.simulations,
    benign: stats.totals.benign,
  };
}

// ===========================================================================
// PHASE 3 — TRANSITION INTO ATTACK
// ===========================================================================

async function transitionBanner() {
  blank();
  console.log(paint('═'.repeat(CONFIG.width), C.dim));
  console.log(paint('  ▼ ▼ ▼  ATTACK SIGNATURE INBOUND  ▼ ▼ ▼', C.bgYellow));
  console.log(paint('═'.repeat(CONFIG.width), C.dim));
  blank();
  await sleep(600);
}

// ===========================================================================
// PHASE 4 — ATTACK INTERCEPTION
// ===========================================================================

/**
 * @param {SessionStats} stats
 */
async function attackSequence(stats) {
  const beats = CONFIG.attackBeats;

  // ---- Reception ----
  await sleep(beats.pendingReceived);
  stats.recordTx();
  stats.recordCandidate();
  stats.recordTruePositive();

  section('PENDING TX RECEIVED', 'flashloan signature, calldata references protected vault');
  table([
    ['hash',     paint(ATTACK_TX.hash, C.brYellow)],
    ['from',     paint(ATTACK_TX.from, C.red) + paint('   // attacker EOA', C.dim)],
    ['to',       paint(ATTACK_TX.to, C.cyan) + paint(`   // ${PROVIDER_LABELS[ATTACK_TX.to.toLowerCase()] || 'unknown'}`, C.dim)],
    ['value',    paint(`${fmtEth(ATTACK_TX.value)} ETH`, C.dim)],
    ['nonce',    paint(String(ATTACK_TX.nonce), C.dim)],
    ['gasLimit', paint(fmtNum(Number(ATTACK_TX.gasLimit)), C.dim)],
    ['maxFeePerGas', paint(`${gwei(ATTACK_TX.maxFeePerGas)} gwei`, C.dim)],
    ['maxPriorityFeePerGas', paint(`${gwei(ATTACK_TX.maxPriorityFeePerGas)} gwei`, C.dim)],
    ['data (truncated)', paint(ATTACK_TX.data.slice(0, 76) + '…', C.dim)],
  ]);

  // ---- Pre-filter ----
  await sleep(beats.preFilter);
  const reasons = isCandidateReasons(ATTACK_TX);
  section('PRE-FILTER MATCH', 'O(1) hash-set lookups on FLASHLOAN_PROVIDERS / FLASHLOAN_SELECTORS');
  for (const r of reasons) {
    console.log(`  ${paint('✓', C.green)} ${r}`);
  }
  console.log(`  ${paint('↳', C.yellow)} 3/3 indicators tripped — escalating to EVM simulation`);

  // ---- Simulation ----
  await sleep(beats.simulation);
  stats.recordSimulation(47);
  section('EVM SIMULATION', 'debug_traceCall + stateOverrides — attacker balance pinned to 2¹⁰⁴ wei');
  console.log(`  ${paint('rpc method', C.dim)}    debug_traceCall`);
  console.log(`  ${paint('tracer', C.dim)}        callTracer`);
  console.log(`  ${paint('block tag', C.dim)}     latest`);
  console.log(`  ${paint('overrides', C.dim)}     { ${short(ATTACK_TX.from)}: { balance: 0xff…ff } }`);
  console.log(`  ${paint('node timeout', C.dim)}  95 ms`);
  blank();
  printCallTree(SIMULATION_TRACE);

  // ---- Outflow analysis ----
  await sleep(beats.analysis);
  const drainedWei = sumOutflow(SIMULATION_TRACE, VAULT_LC);
  const drainedEth = Number(drainedWei) / 1e18;
  const tvlWei = VAULT_TVL_ETH * 10n ** 18n;
  const ratio = Number((drainedWei * 10000n) / tvlWei) / 100;
  const passAbsolute = drainedEth >= 10;
  const passFraction = ratio >= 5;

  section('OUTFLOW ANALYSIS', `sumOutflow walked ${countFrames(SIMULATION_TRACE)} call frames`);
  table([
    ['vault outflow',       paint(`${drainedEth.toFixed(2)} ETH`, C.red, C.bold) + paint(`   (${drainedWei.toString()} wei)`, C.dim)],
    ['vault TVL',           `${VAULT_TVL_ETH} ETH`],
    ['drain / TVL',         paint(`${ratio.toFixed(2)} %`, C.red, C.bold)],
    ['threshold absolute',  paint('10 ETH', C.dim) + '          ' +
                              (passAbsolute ? paint(`✗ EXCEEDED ${(drainedEth/10).toFixed(1)}×`, C.red) : paint('✓ ok', C.green))],
    ['threshold fraction',  paint('5 %',   C.dim) + '            ' +
                              (passFraction ? paint(`✗ EXCEEDED ${(ratio/5).toFixed(1)}×`, C.red) : paint('✓ ok', C.green))],
  ]);

  // ---- Decision ----
  await sleep(beats.riposteEngage);
  blank();
  console.log(paint(' '.repeat(CONFIG.width), C.bgRed));
  console.log(paint(' 🚨  MALICIOUS FLASHLOAN DETECTED — ENGAGING RIPOSTE  ', C.bgRed, C.bold) +
              paint(' '.repeat(CONFIG.width - 53), C.bgRed));
  console.log(paint(' '.repeat(CONFIG.width), C.bgRed));

  // ---- Fee strategy ----
  await sleep(beats.feeStrategy);
  const { myPriority, myMaxFee } = bumpedFees(ATTACK_TX.maxFeePerGas, ATTACK_TX.maxPriorityFeePerGas);
  section('GAS-WAR STRATEGY', 'beat hacker priority + maintain global-pool floor');
  table([
    ['hacker maxPriorityFeePerGas', paint(`${gwei(ATTACK_TX.maxPriorityFeePerGas)} gwei`, C.dim)],
    ['hacker maxFeePerGas',         paint(`${gwei(ATTACK_TX.maxFeePerGas)} gwei`, C.dim)],
    ['priority floor',              paint('60 gwei', C.dim)],
    ['priority bump',               paint('+ 50 gwei', C.dim)],
    ['→ our maxPriorityFeePerGas',  paint(`${gwei(myPriority)} gwei`, C.green, C.bold)],
    ['→ our maxFeePerGas',          paint(`${gwei(myMaxFee)} gwei`, C.green, C.bold)],
  ], { keyWidth: 32 });

  // ---- Build halt tx ----
  await sleep(beats.buildTx);
  section('BUILDING emergencyHalt()', 'calldata pre-encoded at boot — zero ABI overhead in hot path');
  table([
    ['type',       paint('EIP-1559 (type-2)', C.cyan)],
    ['to',         paint(TARGETED_VAULT, C.cyan)],
    ['value',      paint('0', C.dim)],
    ['data',       paint('0xb1f5dba1', C.cyan) + paint('                     // emergencyHalt() selector', C.dim)],
    ['nonce',      paint('1284', C.cyan) + paint('                          // cached, +1 from last broadcast', C.dim)],
    ['gasLimit',   paint('120 000', C.cyan)],
    ['chainId',    paint('1', C.dim) + paint('                              // Ethereum mainnet', C.dim)],
  ]);

  // ---- Sign ----
  await sleep(beats.sign);
  section('LOCAL SIGNING', 'secp256k1 ECDSA — wallet signTransaction, no RPC round-trip');
  console.log(`  ${paint('signer', C.dim)}        0xK0v3R…b07`);
  console.log(`  ${paint('rawTx', C.dim)}         0x02f86b01820504845c4dd8b08509a3e9d0008301d4c094` +
              paint('…', C.dim) + ` ${paint('// 152 bytes', C.dim)}`);
  console.log(`  ${paint('v / r / s', C.dim)}     ${paint('27', C.dim)} / ${paint('0x9f…2c', C.dim)} / ${paint('0x4d…b1', C.dim)}`);

  // ---- Broadcast ----
  await sleep(beats.broadcast);
  const riposteHash = '0xc1rcu1tbreakerc1rcu1tbreakerc1rcu1tbreakerc1rcu1tbreaker0deadbf1';
  section('BROADCAST', 'Flashbots Protect relay → private mempool, no public propagation');
  console.log(`  ${paint('endpoint', C.dim)}      relay.flashbots.net`);
  console.log(`  ${paint('tx hash', C.dim)}       ${paint(riposteHash, C.brCyan)}`);
  console.log(`  ${paint('expected slot', C.dim)} next block (within ~12 s)`);

  stats.recordHalt();

  // ---- Block inclusion ----
  await sleep(beats.blockMined);
  section('BLOCK 19 243 521 MINED', 'inclusion verified — 12 confirmations awaited for finality');
  table([
    ['position 3',  paint('KOVER riposte INCLUDED', C.green, C.bold) + paint('       gasUsed=42 118', C.dim)],
    ['position 4',  paint('attacker tx REVERTED', C.red) + paint('         reason="Pausable: paused"', C.dim)],
    ['position 5',  paint('sandwich bot #1 REVERTED', C.dim)],
    ['position 6',  paint('sandwich bot #2 REVERTED', C.dim)],
    ['position 7',  paint('sandwich bot #3 REVERTED', C.dim)],
    ['position 8',  paint('arbitrage REVERTED', C.dim)],
  ]);

  return { drainedWei, drainedEth, ratio, riposteHash };
}

/** Counts call frames recursively — used to feed an audit-friendly metric. */
function countFrames(frame) {
  if (!frame) return 0;
  let n = 1;
  if (frame.calls) for (const c of frame.calls) n += countFrames(c);
  return n;
}

// ===========================================================================
// PHASE 5 — VERDICT + SESSION POST-MORTEM
// ===========================================================================

async function postMortem(stats, attack) {
  blank();
  verdict(`✅  ATTACK NEUTRALIZED — ${attack.drainedEth.toFixed(2)} ETH PROTECTED`, C.bgGreen);

  // -- Hot-path latency breakdown (per-attack) --
  blank();
  panel('HOT-PATH LATENCY BREAKDOWN (per attack)', [
    ['reception',       paint('+0.0', C.cyan)   + paint('  ms     WSS pending event', C.dim)],
    ['pre-filter',      paint('+0.1', C.cyan)   + paint('  ms     O(1) selector + address match', C.dim)],
    ['eth_getTx',       paint('+18',  C.cyan)   + paint('   ms    QuickNode RTT', C.dim)],
    ['debug_traceCall', paint('+47',  C.cyan)   + paint('   ms    callTracer + stateOverrides', C.dim)],
    ['sumOutflow',      paint('+0.3', C.cyan)   + paint('  ms     recursive frame walk', C.dim)],
    ['decision',        paint('+0.1', C.cyan)   + paint('  ms     threshold compare', C.dim)],
    ['signing',         paint('+3',   C.cyan)   + paint('    ms   secp256k1 ECDSA', C.dim)],
    ['broadcast',       paint('+22',  C.cyan)   + paint('   ms    eth_sendRawTransaction (Flashbots)', C.dim)],
    [paint('TOTAL', C.bold), paint('≈90', C.brCyan, C.bold) + paint('   ms    inclusion-priority WIN', C.green)],
  ], { width: CONFIG.width });

  // -- Session-wide metrics --
  blank();
  const sessionSec = stats.uptimeSec();
  panel('SESSION METRICS', [
    ['session uptime',           `${sessionSec.toFixed(2)} s`],
    ['transactions processed',   paint(fmtNum(stats.totals.tx), C.brCyan, C.bold)],
    ['mean throughput',          paint(`${(stats.totals.tx / sessionSec).toFixed(0)} tx/s`, C.cyan)],
    ['pre-filter pass-through',  paint(fmtPct(stats.matchRatePct()), C.yellow) + paint(`  (${stats.totals.candidates} candidates)`, C.dim)],
    ['simulations executed',     paint(fmtNum(stats.totals.simulations), C.cyan)],
    ['avg simulation latency',   paint(fmtMs(stats.avgSimLatencyMs()), C.cyan)],
    ['false positives',          paint(fmtNum(stats.totals.falsePositives), C.dim) + paint(`  (${(stats.totals.falsePositives / Math.max(1, stats.totals.candidates) * 100).toFixed(1)} % of candidates)`, C.dim)],
    ['true positives',           paint(fmtNum(stats.totals.truePositives), C.red, C.bold)],
    ['halts triggered',          paint(fmtNum(stats.totals.halts), C.red, C.bold)],
  ], { width: CONFIG.width });

  // -- Economic impact --
  blank();
  panel('IMPACT', [
    ['funds protected',  paint(`${attack.drainedEth.toFixed(2)} ETH`, C.green, C.bold) + paint(`   ≈ ${usd(attack.drainedEth)}`, C.dim)],
    ['vault status',     paint('PAUSED', C.yellow) + paint('   awaiting owner review via resume()', C.dim)],
    ['attacker cost',    paint('0.018 ETH', C.red) + paint('  reverted gas fees', C.dim)],
    ['riposte cost',     paint('~0.0026 ETH', C.dim) + paint('  ≈ ' + usd(0.0026), C.dim)],
    ['net protective ratio', paint(`${Math.round(attack.drainedEth / 0.0026).toLocaleString()} ×`, C.green, C.bold)],
  ], { width: CONFIG.width });

  // -- Forensics & next steps --
  blank();
  panel('FORENSICS & INCIDENT RESPONSE', [
    ['1. event log',    `CircuitBreakerTriggered(origin=${short(ATTACKER_EOA)})`],
    ['2. attacker tx',  `${short(ATTACK_TX.hash)} → reverted (Pausable: paused)`],
    ['3. trace export', `archive/forensics/${ATTACK_TX.hash.slice(2, 10)}.json`],
    ['4. stakeholder',  paint('Slack #incidents + PagerDuty', C.dim)],
    ['5. recovery',     'multisig sign-off → patch → resume() → rotate'],
    ['6. transparency', 'postmortem published within 24 h'],
  ], { width: CONFIG.width });

  blank();
}

// ===========================================================================
// MAIN
// ===========================================================================

async function main() {
  hideCursor();
  try {
    const stats = new SessionStats();

    await bootSequence();
    await liveIngestion(stats);
    await transitionBanner();
    const attack = await attackSequence(stats);
    await postMortem(stats, attack);
  } finally {
    showCursor();
  }
}

process.on('SIGINT', () => { showCursor(); process.exit(130); });

main().catch((err) => {
  showCursor();
  console.error(`${C.red}${C.bold}demo failed:${C.reset}`, err);
  process.exit(1);
});
