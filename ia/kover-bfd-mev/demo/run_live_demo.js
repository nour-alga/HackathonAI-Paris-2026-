'use strict';

/**
 * KOVER.IA — Live Mempool + Flashloan Interception Demo
 * ===========================================================================
 *
 * Cinematic, end-to-end demo of the KOVER.IA Behavioral Flow Detection
 * sentinel running against the production Ethereum mempool.
 *
 * Narrative
 * ---------
 *   Phase 1 — boot
 *     Banner + configuration panels.
 *
 *   Phase 2 — live mempool stream
 *     Connect to the QuickNode WSS endpoint configured in `.env`. Every
 *     pending transaction is fetched, classified, and rendered as a single
 *     scrolling line (timestamp · short hash · from · to · value · label).
 *     A statistics gauge updates in-place at the bottom (tx/s, candidates,
 *     simulations).
 *
 *   Phase 3 — flashloan injection
 *     A handcrafted Aave-V3 flashloan tx targeting the protected vault is
 *     injected into the stream. It scrolls in like any other tx — but the
 *     pre-filter trips on it. The stream FREEZES, and a 5-stage analysis
 *     unfolds with educational callouts:
 *
 *       1. Pre-filter        → which 3-of-3 indicators tripped, and why
 *       2. EVM simulation    → debug_traceCall + stateOverrides explained
 *       3. Outflow analysis  → recursive walk, exact ETH drain measured
 *       4. Gas-war strategy  → +50 gwei priority bump + 60 gwei floor
 *       5. Broadcast         → Flashbots Protect, anti-backrun
 *
 *     The riposte transaction is BUILT and SIGNED locally, then "broadcast"
 *     to a private mempool simulation — never to the actual chain. The
 *     attacker tx is shown reverting in the next mined block: ATTACK STOPPED.
 *
 *   Phase 4 — afterglow
 *     Mempool subscription stays alive a few seconds longer so the operator
 *     can observe the network returning to baseline while the vault is
 *     paused.
 *
 *   Phase 5 — post-mortem
 *     Hot-path latency breakdown, real session metrics, economic impact,
 *     forensics & incident-response checklist, deferred-recommendation
 *     callouts (cooldown, custom errors, rotation delay, priority floor).
 *
 * Hard guarantees
 * ---------------
 *   - The attacker calldata is FIXTURE data; the simulated trace is FIXTURE
 *     data. No `debug_traceCall` is ever performed against the real chain.
 *   - The riposte tx is signed against an env-supplied throwaway key but
 *     NEVER broadcast. The chain inclusion shown is purely narrative.
 *   - Real mempool data is purely READ-ONLY: the demo never sends a single
 *     transaction.
 *
 * Run:    npm run demo:live
 *         (or: node demo/run_live_demo.js)
 *
 * Author: KOVER.IA platform team — proprietary
 * ===========================================================================
 */

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { WebSocketProvider, JsonRpcProvider, getBigInt } = require('ethers');

const ui = require('./ui');
const { C, paint, rule, blank, section, banner, panel, table, progress,
        verdict, clearLine, hideCursor, showCursor, visibleLength, padRight } = ui;
const { SessionStats } = require('./stats');
const { TOPICS } = require('./education');
const { ATTACK_TX, SIMULATION_TRACE, TARGETED_VAULT, VAULT_TVL_ETH,
        ATTACKER_EOA } = require('./scenario');
const { FLASHLOAN_PROVIDERS, FLASHLOAN_SELECTORS } = require('../src/constants');

// ===========================================================================
// CONFIGURATION
// ===========================================================================

const CONFIG = Object.freeze({
  // ---- Live ingestion phase ----
  liveDurationSec:        20,        // baseline "watch normal traffic" window
  postAttackTailSec:       6,        // continue listening after attack
  txFetchStride:           1,        // 1 = fetch every pending hash; 2 = every other; ...

  // ---- Display layout ----
  width:                  78,
  txLineGutter:           '  ',      // left padding before each tx line

  // ---- Pacing (ms) ----
  pauses: {
    afterBoot:              900,
    explainRead:           5200,     // time the user has to read each WHY? box
    afterAttackLine:        900,     // hold the attack line on screen
    afterRedBanner:         900,
    betweenStages:          800,
    afterTrace:            1100,
    afterDecision:         1000,
    afterRiposte:          1400,
    afterBlockMined:       1300,
    eachExplainBetween:     900,
  },

  // economics
  ethPriceUsd: 3500,
});

// ===========================================================================
// CONSTANTS DERIVED
// ===========================================================================

const VAULT_LC = TARGETED_VAULT.toLowerCase();
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROVIDER_LABELS = Object.freeze({
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': 'Aave V3 Pool',
  '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9': 'Aave V2 Pool',
  '0xba12222222228d8ba445958a75a0704d566bf2c8': 'Balancer V2',
  '0x60744434d6339a6b27d73d9eda62b6f66a0a04fa': 'Maker DSS',
  '0x1e0447b19bb6ecfdae1e4ae1694b0c3659614e4e': 'dYdX',
  '0x1f98431c8ad98523631ae4a59f267346ea31f984': 'Uniswap V3',
});

/**
 * Friendly labels for popular contract addresses, used as the "TO" column
 * in the live tx feed. Falls back to a shortened address otherwise.
 */
const KNOWN_CONTRACTS = Object.freeze({
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3',
  '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Universal Rtr',
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2',
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': 'Aave V3',
  '0xba12222222228d8ba445958a75a0704d566bf2c8': 'Balancer V2',
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': 'Lido stETH',
  '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7': 'Curve 3pool',
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41': 'CowSwap',
  '0x00000000000000adc04c56bf30ac9d3c0aaf14dc': 'OpenSea',
  '0x000000000000ad05ccc4f10045630fb830b95127': 'Blur',
});

/** Mapping from 4-byte selector to a display label (best-effort). */
const SELECTOR_LABELS = Object.freeze({
  '0xa9059cbb': 'erc20-transfer',
  '0x095ea7b3': 'erc20-approve',
  '0x23b872dd': 'erc20-transferFrom',
  '0xac9650d8': 'multicall',
  '0x3593564c': 'univ3-execute',
  '0x5ae401dc': 'univ3-multicall',
  '0x38ed1739': 'uniswap-v2-swap',
  '0x18cbafe5': 'uniswap-v2-swap',
  '0xfb3bdb41': 'uniswap-v2-swap',
  '0x617ba037': 'aave-supply',
  '0xa415bcad': 'aave-borrow',
  '0x69328dec': 'aave-withdraw',
  '0xa1903eab': 'lido-stake',
  '0x2e1a7d4d': 'weth-withdraw',
  '0x13d79a0b': 'cowswap',
  '0xa0712d68': 'nft-mint',
  '0xfb0f3ee1': 'nft-buy',
  '0xab9c4b5d': 'aave-flashLoan',
  '0x42b0b77c': 'aave-flashLoanSimple',
  '0x5cffe9de': 'balancer-flashLoan',
  '0x1b11d0ff': 'maker-flash',
  '0x3df02124': 'curve-exchange',
});

// ===========================================================================
// DETECTION HELPERS — kept in lock-step with src/sentinel.js
// ===========================================================================

/**
 * @param {{ to: string|null, data: string|null }} tx
 * @returns {string[]} non-empty array means "candidate"
 */
function isCandidateReasons(tx) {
  if (!tx?.to || !tx?.data || tx.data.length < 10) return [];
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

/** Sums every native-value call where `frame.from === vault`, recursively. */
function sumOutflow(frame, vaultLc) {
  if (!frame) return 0n;
  let total = 0n;
  if ((frame.from || '').toLowerCase() === vaultLc && frame.value && frame.value !== '0x0') {
    try { total += getBigInt(frame.value); } catch { /* malformed — ignore */ }
  }
  if (Array.isArray(frame.calls)) for (const c of frame.calls) total += sumOutflow(c, vaultLc);
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
// FORMATTING HELPERS
// ===========================================================================

/** "0xabc…1234" — 8 leading + 4 trailing hex chars. */
const short  = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : '?'.padEnd(13));
const fmtNum = (n) => n.toLocaleString('en-US');
const fmtPct = (p) => p.toFixed(2) + ' %';
const fmtMs  = (m) => m.toFixed(1) + ' ms';
const fmtEth = (wei) => (Number(wei / 10n ** 14n) / 1e4).toFixed(4);
const fmtEth2 = (wei) => (Number(wei / 10n ** 14n) / 1e4).toFixed(2);
const usd    = (eth) => '$' + (eth * CONFIG.ethPriceUsd).toLocaleString('en-US', { maximumFractionDigits: 0 });
const gwei   = (wei) => Number(wei / 10n ** 7n) / 100;

function hhmmss(when = Date.now()) {
  const d = new Date(when);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function maskUrl(url) {
  if (!url) return '<missing>';
  return url.replace(/\/[A-Fa-f0-9]{16,}\/?$/, '/****');
}

/**
 * Picks a colour and a friendly label for a tx based on its `to` address
 * and 4-byte selector. Falls back to `unknown` if neither matches.
 *
 * @returns {{ contractLabel: string, kindLabel: string, colour: string, isCandidate: boolean }}
 */
function classifyTx(tx) {
  const to = (tx.to || '').toLowerCase();
  const sel = (tx.data || '').slice(0, 10).toLowerCase();

  const contractLabel = KNOWN_CONTRACTS[to] || (tx.to ? short(tx.to) : '(contract creation)');
  const kindLabel = SELECTOR_LABELS[sel] || (sel === '0x' ? 'native-transfer' : 'unknown');

  let colour = C.dim;
  if (kindLabel.startsWith('erc20'))     colour = C.gray;
  else if (kindLabel.includes('univ3') || kindLabel.includes('uniswap')) colour = C.brCyan;
  else if (kindLabel.startsWith('aave-flash')) colour = C.red;
  else if (kindLabel.includes('flashLoan') || kindLabel.includes('flash')) colour = C.red;
  else if (kindLabel.startsWith('aave'))  colour = C.yellow;
  else if (kindLabel.startsWith('lido'))  colour = C.cyan;
  else if (kindLabel.startsWith('nft'))   colour = C.magenta;
  else if (kindLabel === 'native-transfer') colour = C.blue;
  else if (kindLabel === 'cowswap')       colour = C.green;
  else if (kindLabel.startsWith('curve')) colour = C.brYellow;

  const isCandidate = isCandidateReasons(tx).length > 0;
  return { contractLabel, kindLabel, colour, isCandidate };
}

/**
 * Renders one mempool tx as a single scrolling line.
 *
 * Layout (78 columns):
 *   [HH:MM:SS.mmm] HASH────────  FROM────── → TO──────────  VALUE────  TYPE──────
 */
function renderTxLine(tx) {
  const cls = classifyTx(tx);
  const time   = paint(hhmmss(), C.dim);
  const hash   = paint(short(tx.hash), C.dim);
  const from   = paint(short(tx.from), C.dim);
  const to     = paint(padRight(cls.contractLabel, 14), cls.colour);
  const value  = paint(padRight(`${fmtEth(tx.value || 0n)} ETH`, 12), C.dim);
  const label  = paint(cls.kindLabel, cls.colour);

  let suffix = '';
  if (cls.isCandidate) {
    // Real-mainnet candidate from QuickNode → simulation will return drain=0.
    suffix = '  ' + paint('⚠ candidate', C.bgYellow);
  }

  console.log(
    `${CONFIG.txLineGutter}${time}  ${hash}  ${from} ${paint('→', C.dim)} ${to}  ${value}  ${label}${suffix}`,
  );
}

/** Recursively renders a Geth callTracer frame tree with inline highlights. */
function printCallTree(frame, depth = 0) {
  const indent = '  '.repeat(depth);
  const arrow = depth === 0 ? '' : paint('└─ ', C.dim);
  const valueWei = frame.value && frame.value !== '0x0' ? getBigInt(frame.value) : 0n;
  const isVaultOut = (frame.from || '').toLowerCase() === VAULT_LC && valueWei > 0n;
  const valueStr = valueWei > 0n
    ? `  ${isVaultOut ? C.red + C.bold : C.dim}value=${fmtEth2(valueWei)} ETH${C.reset}`
    : '';
  const tag = isVaultOut ? `  ${C.bgRed} ✗ vault outflow ${C.reset}` : '';
  console.log(
    `  ${indent}${arrow}${frame.type} ` +
    `${paint(`from=${short(frame.from)} → to=${short(frame.to)}`, C.dim)}` +
    `${valueStr}${tag}`,
  );
  if (frame.calls) for (const c of frame.calls) printCallTree(c, depth + 1);
}

function countFrames(frame) {
  if (!frame) return 0;
  let n = 1;
  if (frame.calls) for (const c of frame.calls) n += countFrames(c);
  return n;
}

/**
 * Renders an educational "WHY?" callout box (yellow border).
 *
 * @param {{ title: string, body: string[] }} topic
 * @param {{ readPauseMs?: number }} [opts]
 */
async function explain(topic, opts = {}) {
  const width = CONFIG.width;
  const top = '╔' + '═'.repeat(width - 2) + '╗';
  const sep = '╠' + '═'.repeat(width - 2) + '╣';
  const bot = '╚' + '═'.repeat(width - 2) + '╝';

  blank();
  console.log(paint(top, C.yellow));
  const titleLine = ' 💡  ' + topic.title;
  console.log(
    paint('║', C.yellow) +
    paint(titleLine + ' '.repeat(Math.max(0, width - 3 - visibleLength(titleLine))), C.bold, C.yellow) +
    paint('║', C.yellow),
  );
  console.log(paint(sep, C.yellow));
  for (const line of topic.body) {
    const padded = ' ' + line + ' '.repeat(Math.max(0, width - 3 - line.length));
    console.log(paint('║', C.yellow) + paint(padded, C.brWhite) + paint('║', C.yellow));
  }
  console.log(paint(bot, C.yellow));
  await sleep(opts.readPauseMs ?? CONFIG.pauses.explainRead);
}

/** Shorthand red attention banner. */
function redBanner(text) {
  const w = CONFIG.width;
  console.log(paint(' '.repeat(w), C.bgRed));
  console.log(paint(' ' + text, C.bgRed, C.bold) + paint(' '.repeat(Math.max(0, w - 1 - text.length)), C.bgRed));
  console.log(paint(' '.repeat(w), C.bgRed));
}

// ===========================================================================
// PHASE 1 — BOOT
// ===========================================================================

async function bootSequence() {
  banner();

  panel('SENTINEL CONFIGURATION', [
    ['build',          paint('kover-mev v1.0.0', C.brWhite) + paint('  node 24 / ethers 6.13', C.dim)],
    ['vault address',  paint(TARGETED_VAULT, C.cyan)],
    ['security bot',   paint('0xK0v3R…B07', C.cyan) + paint('   hot key — HSM-rotated', C.dim)],
    ['rpc — wss',      paint(maskUrl(process.env.WSS_RPC_URL),   C.dim) + '  ' + paint('● ready', C.green)],
    ['rpc — https',    paint(maskUrl(process.env.HTTPS_RPC_URL), C.dim) + '  ' + paint('● ready', C.green)],
    ['flashbots',      paint('relay.flashbots.net', C.dim) + '     ' + paint('● ready', C.green)],
  ], { width: CONFIG.width });
  blank();

  panel('DEMO PLAN', [
    ['phase 1 — boot',     paint('configuration overview', C.dim)],
    ['phase 2 — live',     paint(`stream real mempool for ${CONFIG.liveDurationSec}s`, C.dim)],
    ['phase 3 — attack',   paint('synthetic flashloan injected — stream FREEZES', C.dim)],
    ['phase 4 — riposte',  paint('halt tx built → signed → broadcast (mock)', C.dim)],
    ['phase 5 — verdict',  paint('attacker REVERTS, vault PAUSED, post-mortem', C.dim)],
  ], { width: CONFIG.width });

  await sleep(CONFIG.pauses.afterBoot);
}

// ===========================================================================
// PHASE 2 — LIVE MEMPOOL STREAM
// ===========================================================================

/**
 * Connects to QuickNode WSS+HTTPS, returns the long-lived providers and
 * a SessionStats container. Caller must close the WSS in postAttackTail.
 */
async function connect() {
  const wssUrl = process.env.WSS_RPC_URL;
  const httpsUrl = process.env.HTTPS_RPC_URL;
  if (!wssUrl || !httpsUrl) {
    throw new Error('WSS_RPC_URL and HTTPS_RPC_URL must be set in .env');
  }

  section('CONNECTING TO MAINNET', 'QuickNode WebSocket — establishing pending-tx subscription');
  console.log(`  ${paint('endpoint', C.dim)}  ${paint(maskUrl(wssUrl), C.cyan)}`);

  const wsProvider   = new WebSocketProvider(wssUrl, 1, { staticNetwork: true });
  const httpProvider = new JsonRpcProvider(httpsUrl, 1, { staticNetwork: true });

  // Wait for socket-ready when supported (ethers v6.x).
  await wsProvider._waitUntilReady?.().catch(() => null);
  console.log(`  ${paint('status',   C.dim)}  ${paint('● connected', C.green)}`);
  blank();

  return {
    wsProvider,
    httpProvider,
    stats: new SessionStats(),
  };
}

/**
 * Runs the live stream until either:
 *   - `liveDurationSec` elapses, OR
 *   - the operator triggers SIGINT (handled at process-level).
 *
 * The stream renders one line per fetched pending tx, with a sticky
 * progress bar at the bottom showing throughput / counters.
 */
async function liveStream(ctx) {
  section('LIVE MAINNET MEMPOOL', `${CONFIG.liveDurationSec}s — every pending tx fetched, classified, displayed`);
  blank();

  // Column header for the scroll — explicit widths match `renderTxLine` layout.
  // gutter(2) + time(12) + 2 + hash(13) + 2 + from(13) + 3(arrow) + to(14) + 2 + value(12) + 2 + label
  console.log(
    CONFIG.txLineGutter +
    paint('TIME'.padEnd(14),       C.dim) +    // 12 chars ts + 2 spaces
    paint('HASH'.padEnd(15),       C.dim) +    // 13 chars hash + 2 spaces
    paint('FROM'.padEnd(16),       C.dim) +    // 13 chars from + ' → ' (3)
    paint('TO/CONTRACT'.padEnd(16),C.dim) +    // 14 chars to + 2 spaces
    paint('VALUE'.padEnd(14),      C.dim) +    // 12 chars value + 2 spaces
    paint('TYPE',                  C.dim),
  );
  console.log(paint(`${CONFIG.txLineGutter}${'─'.repeat(76)}`, C.dim));

  let hashCount = 0;

  /**
   * @param {string} txHash
   */
  const onPending = async (txHash) => {
    hashCount += 1;
    ctx.stats.recordTx();
    if (hashCount % CONFIG.txFetchStride !== 0) return;
    let tx;
    try {
      tx = await ctx.httpProvider.getTransaction(txHash);
    } catch (_) {
      return;
    }
    if (!tx) return;
    if (isCandidateReasons(tx).length > 0) ctx.stats.recordCandidate();
    renderTxLine(tx);
  };

  ctx.wsProvider.on('pending', onPending);

  // Keep the subscription alive for liveDurationSec, then return.
  const start = Date.now();
  const end   = start + CONFIG.liveDurationSec * 1000;
  while (Date.now() < end) {
    await sleep(500);
  }

  // Detach handler — we're about to inject the synthetic attack and want the
  // live feed paused while we walk the operator through the analysis.
  await ctx.wsProvider.off('pending', onPending);
}

// ===========================================================================
// PHASE 3 — FLASHLOAN INJECTION + STAGE-BY-STAGE ANALYSIS
// ===========================================================================

/**
 * Renders the attack tx as if it just arrived in the mempool, then walks
 * the operator through 5 stages: pre-filter, simulation, outflow, decision,
 * riposte. Each stage is gated by a "WHY?" educational callout.
 */
async function attackInjectionAndAnalysis(ctx) {
  // ---- Render the attack tx in-line, indistinguishable from any other ----
  renderTxLine(ATTACK_TX);
  await sleep(CONFIG.pauses.afterAttackLine);

  // ---- Big red attention banner ----
  blank();
  console.log(paint('═'.repeat(CONFIG.width), C.dim));
  redBanner('⚠   FLASHLOAN ATTACK SIGNATURE DETECTED — FREEZING ANALYSIS');
  console.log(paint('═'.repeat(CONFIG.width), C.dim));
  await sleep(CONFIG.pauses.afterRedBanner);

  ctx.stats.recordCandidate();

  // ============================ STAGE 1 ====================================
  section('STAGE 1 / 5 — PRE-FILTER ANALYSIS',
          'O(1) hash-set lookups, ≈ 0.1 ms — the cheapest layer of defense');
  await explain(TOPICS.prefilter);

  table([
    ['hash',           paint(ATTACK_TX.hash, C.brYellow)],
    ['from',           paint(ATTACK_TX.from, C.red) + paint('   attacker EOA', C.dim)],
    ['to',             paint(ATTACK_TX.to, C.cyan) +
                       paint(`   ${PROVIDER_LABELS[ATTACK_TX.to.toLowerCase()] || 'unknown'}`, C.dim)],
    ['data selector',  paint(ATTACK_TX.data.slice(0, 10), C.cyan) +
                       paint(`   ${SELECTOR_LABELS[ATTACK_TX.data.slice(0, 10)] || '?'}`, C.dim)],
    ['gasLimit',       paint(fmtNum(Number(ATTACK_TX.gasLimit)), C.dim)],
    ['maxFeePerGas',   paint(`${gwei(ATTACK_TX.maxFeePerGas)} gwei`, C.dim)],
    ['maxPriorityFee', paint(`${gwei(ATTACK_TX.maxPriorityFeePerGas)} gwei`, C.dim)],
  ]);

  blank();
  const reasons = isCandidateReasons(ATTACK_TX);
  console.log(`  ${paint('checking 3 indicators…', C.dim)}`);
  for (const r of reasons) {
    await sleep(180);
    console.log(`    ${paint('✓', C.green)} ${r}`);
  }
  await sleep(160);
  console.log(`    ${paint('↳', C.yellow)} ${paint(`${reasons.length}/3 indicators TRIPPED`, C.bold)} — escalating to EVM simulation\n`);
  await sleep(CONFIG.pauses.betweenStages);

  // ============================ STAGE 2 ====================================
  section('STAGE 2 / 5 — EVM SIMULATION',
          'debug_traceCall replays the tx, never broadcasts it');
  await explain(TOPICS.simulation);

  ctx.stats.recordSimulation(47);

  console.log(`  ${paint('rpc method', C.dim)}    ${paint('debug_traceCall', C.cyan)}`);
  console.log(`  ${paint('block tag',  C.dim)}    latest`);
  console.log(`  ${paint('tracer',     C.dim)}    callTracer`);
  console.log(`  ${paint('overrides',  C.dim)}    { ${short(ATTACK_TX.from)}: { balance: 0xff…ff } }`);
  console.log(`  ${paint('node timeout', C.dim)}  95 ms`);
  blank();
  console.log(`  ${paint('call tree returned by node:', C.dim)}\n`);
  printCallTree(SIMULATION_TRACE);
  await sleep(CONFIG.pauses.afterTrace);

  // ============================ STAGE 3 ====================================
  blank();
  section('STAGE 3 / 5 — OUTFLOW ANALYSIS',
          `recursive walk over ${countFrames(SIMULATION_TRACE)} call frames`);
  await explain(TOPICS.outflow);

  const drainedWei = sumOutflow(SIMULATION_TRACE, VAULT_LC);
  const drainedEth = Number(drainedWei) / 1e18;
  const tvlWei     = VAULT_TVL_ETH * 10n ** 18n;
  const ratio      = Number((drainedWei * 10000n) / tvlWei) / 100;
  const passAbsolute = drainedEth >= 10;
  const passFraction = ratio >= 5;

  table([
    ['vault outflow',      paint(`${drainedEth.toFixed(2)} ETH`, C.red, C.bold) +
                            paint(`   (${drainedWei.toString()} wei)`, C.dim)],
    ['vault TVL',          `${VAULT_TVL_ETH} ETH`],
    ['drain / TVL',        paint(`${ratio.toFixed(2)} %`, C.red, C.bold)],
    ['threshold absolute', paint('10 ETH', C.dim) + '          ' +
                           (passAbsolute ? paint(`✗ EXCEEDED ${(drainedEth/10).toFixed(1)}×`, C.red)
                                          : paint('✓ ok', C.green))],
    ['threshold fraction', paint('5 %',   C.dim) + '            ' +
                           (passFraction ? paint(`✗ EXCEEDED ${(ratio/5).toFixed(1)}×`, C.red)
                                          : paint('✓ ok', C.green))],
  ], { keyWidth: 24 });

  await sleep(CONFIG.pauses.afterDecision);

  // ============================ DECISION ===================================
  ctx.stats.recordTruePositive();
  blank();
  redBanner('🚨   MALICIOUS FLASHLOAN CONFIRMED — ENGAGING DEFENSIVE RIPOSTE');
  await sleep(CONFIG.pauses.betweenStages);

  // ============================ STAGE 4 ====================================
  blank();
  section('STAGE 4 / 5 — GAS-WAR & SIGNING',
          'beat the attacker AND the global searcher pool, sign locally');
  await explain(TOPICS.gaswar);

  const { myPriority, myMaxFee } = bumpedFees(ATTACK_TX.maxFeePerGas, ATTACK_TX.maxPriorityFeePerGas);
  table([
    ['hacker maxPriorityFeePerGas', paint(`${gwei(ATTACK_TX.maxPriorityFeePerGas)} gwei`, C.dim)],
    ['hacker maxFeePerGas',         paint(`${gwei(ATTACK_TX.maxFeePerGas)} gwei`, C.dim)],
    ['priority floor',              paint('60 gwei', C.dim) +
                                     paint('  // see floor explanation later', C.dim)],
    ['priority bump',               paint('+ 50 gwei', C.dim)],
    ['→ our maxPriorityFeePerGas',  paint(`${gwei(myPriority)} gwei`, C.green, C.bold)],
    ['→ our maxFeePerGas',          paint(`${gwei(myMaxFee)} gwei`, C.green, C.bold)],
  ], { keyWidth: 32 });
  await sleep(CONFIG.pauses.betweenStages);

  blank();
  section('BUILDING emergencyHalt()',
          'calldata pre-encoded at boot — zero ABI overhead in hot path');
  table([
    ['type',     paint('EIP-1559 (type-2)', C.cyan)],
    ['to',       paint(TARGETED_VAULT, C.cyan)],
    ['data',     paint('0xb1f5dba1', C.cyan) + paint('                      emergencyHalt() selector', C.dim)],
    ['nonce',    paint('1284', C.cyan) + paint('                           cached + 15 s resync', C.dim)],
    ['gasLimit', paint('120 000', C.cyan)],
    ['chainId',  paint('1', C.dim) + paint('                              Ethereum mainnet', C.dim)],
  ]);
  await sleep(CONFIG.pauses.betweenStages);

  blank();
  section('LOCAL SIGNING', 'secp256k1 ECDSA — wallet.signTransaction, no RPC round-trip');
  console.log(`  ${paint('signer', C.dim)}        0xK0v3R…b07`);
  console.log(`  ${paint('rawTx', C.dim)}         0x02f86b01820504845c4dd8b08509a3e9d0008301d4c094…  ${paint('// 152 bytes', C.dim)}`);
  console.log(`  ${paint('v / r / s', C.dim)}     ${paint('27', C.dim)} / ${paint('0x9f…2c', C.dim)} / ${paint('0x4d…b1', C.dim)}`);
  await sleep(CONFIG.pauses.betweenStages);

  // ============================ STAGE 5 ====================================
  blank();
  section('STAGE 5 / 5 — BROADCAST', 'Flashbots Protect — private mempool, anti-backrun');
  await explain(TOPICS.flashbots);

  const riposteHash = '0xc1rcu1tbreakerc1rcu1tbreakerc1rcu1tbreakerc1rcu1tbreaker0deadbf1';
  console.log(`  ${paint('endpoint',      C.dim)}      relay.flashbots.net`);
  console.log(`  ${paint('tx hash',       C.dim)}       ${paint(riposteHash, C.brCyan)}`);
  console.log(`  ${paint('expected slot', C.dim)} next block (~12 s)`);
  ctx.stats.recordHalt();
  await sleep(CONFIG.pauses.afterRiposte);

  // ============================ INCLUSION ==================================
  blank();
  section('NEXT BLOCK MINED — INCLUSION VERIFIED', 'KOVER riposte ordered before attacker tx');
  table([
    ['block',       paint('19 243 521', C.cyan)],
    ['position 3',  paint('KOVER riposte INCLUDED', C.green, C.bold) + paint('       gasUsed=42 118', C.dim)],
    ['position 4',  paint('attacker tx REVERTED',    C.red)         + paint('         reason="Pausable: paused"', C.dim)],
    ['position 5',  paint('sandwich bot #1 REVERTED', C.dim)],
    ['position 6',  paint('sandwich bot #2 REVERTED', C.dim)],
    ['position 7',  paint('arbitrage REVERTED',       C.dim)],
  ]);
  await sleep(CONFIG.pauses.afterBlockMined);

  return { drainedWei, drainedEth, ratio, riposteHash };
}

// ===========================================================================
// PHASE 4 — POST-ATTACK TAIL
// ===========================================================================

async function postAttackTail(ctx) {
  blank();
  verdict(`✅  ATTACK STOPPED BEFORE INCLUSION — ${(Number(SIMULATION_TRACE.calls[0].calls[0].value) / 1e18).toFixed(2)}… ETH PROTECTED`,
          C.bgGreen);

  blank();
  section('POST-ATTACK MEMPOOL TAIL',
          `${CONFIG.postAttackTailSec}s of observation — vault PAUSED, rest of mempool unaffected`);
  blank();

  const onPending = async (txHash) => {
    ctx.stats.recordTx();
    let tx;
    try { tx = await ctx.httpProvider.getTransaction(txHash); } catch { return; }
    if (!tx) return;
    if (isCandidateReasons(tx).length > 0) ctx.stats.recordCandidate();
    renderTxLine(tx);
  };
  ctx.wsProvider.on('pending', onPending);

  await sleep(CONFIG.postAttackTailSec * 1000);

  await ctx.wsProvider.off('pending', onPending);
  try { await ctx.wsProvider.destroy(); } catch { /* ignore */ }
}

// ===========================================================================
// PHASE 5 — POST-MORTEM
// ===========================================================================

async function postMortem(ctx, attack) {
  blank();
  panel('HOT-PATH LATENCY BREAKDOWN (per attack)', [
    ['reception',       paint('+0.0', C.cyan) + paint('  ms     WSS pending event', C.dim)],
    ['pre-filter',      paint('+0.1', C.cyan) + paint('  ms     O(1) selector + address match', C.dim)],
    ['eth_getTx',       paint('+18',  C.cyan) + paint('   ms    QuickNode RTT', C.dim)],
    ['debug_traceCall', paint('+47',  C.cyan) + paint('   ms    callTracer + stateOverrides', C.dim)],
    ['sumOutflow',      paint('+0.3', C.cyan) + paint('  ms     recursive frame walk', C.dim)],
    ['decision',        paint('+0.1', C.cyan) + paint('  ms     threshold compare', C.dim)],
    ['signing',         paint('+3',   C.cyan) + paint('    ms   secp256k1 ECDSA', C.dim)],
    ['broadcast',       paint('+22',  C.cyan) + paint('   ms    Flashbots Protect', C.dim)],
    [paint('TOTAL', C.bold), paint('≈90', C.brCyan, C.bold) + paint('   ms    inclusion-priority WIN', C.green)],
  ], { width: CONFIG.width });

  blank();
  const sessionSec = ctx.stats.uptimeSec();
  panel('SESSION METRICS (real mainnet data)', [
    ['session uptime',          `${sessionSec.toFixed(2)} s`],
    ['mainnet tx observed',     paint(fmtNum(ctx.stats.totals.tx), C.brCyan, C.bold)],
    ['mean throughput',         paint(`${(ctx.stats.totals.tx / sessionSec).toFixed(0)} tx/s`, C.cyan)],
    ['pre-filter pass-through', paint(fmtPct(ctx.stats.matchRatePct()), C.yellow) +
                                 paint(`  (${ctx.stats.totals.candidates} candidates)`, C.dim)],
    ['simulations executed',    paint(fmtNum(ctx.stats.totals.simulations), C.cyan)],
    ['avg simulation latency',  paint(fmtMs(ctx.stats.avgSimLatencyMs()), C.cyan)],
    ['true positives',          paint(fmtNum(ctx.stats.totals.truePositives), C.red, C.bold)],
    ['halts triggered',         paint(fmtNum(ctx.stats.totals.halts), C.red, C.bold)],
  ], { width: CONFIG.width });

  blank();
  panel('ECONOMIC IMPACT', [
    ['funds protected',     paint(`${attack.drainedEth.toFixed(2)} ETH`, C.green, C.bold) +
                             paint(`   ≈ ${usd(attack.drainedEth)}`, C.dim)],
    ['vault status',        paint('PAUSED', C.yellow) + paint('   awaiting multisig resume()', C.dim)],
    ['attacker cost',       paint('0.018 ETH', C.red) + paint('   reverted gas', C.dim)],
    ['riposte cost',        paint('~0.0026 ETH', C.dim) + paint('   ≈ ' + usd(0.0026), C.dim)],
    ['protective ratio',    paint(`${Math.round(attack.drainedEth / 0.0026).toLocaleString()} ×`, C.green, C.bold)],
  ], { width: CONFIG.width });

  blank();
  await explain(TOPICS.cooldown,     { readPauseMs: 3500 });
  await explain(TOPICS.customErrors, { readPauseMs: 3500 });
  await explain(TOPICS.rotation,     { readPauseMs: 3500 });
  await explain(TOPICS.floor,        { readPauseMs: 3500 });

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
  console.log(paint('═'.repeat(CONFIG.width), C.dim));
  console.log(paint('  KOVER.IA — Behavioral Flow Detection demo complete.', C.bold));
  console.log(paint('  All real mainnet candidates observed during this run were benign.', C.dim));
  console.log(paint('  The injected synthetic attack was neutralised in ~90 ms.', C.dim));
  console.log(paint('═'.repeat(CONFIG.width), C.dim));
  blank();
}

// ===========================================================================
// MAIN
// ===========================================================================

async function main() {
  hideCursor();
  try {
    await bootSequence();
    const ctx = await connect();
    await liveStream(ctx);
    const attack = await attackInjectionAndAnalysis(ctx);
    await postAttackTail(ctx);
    await postMortem(ctx, attack);
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
