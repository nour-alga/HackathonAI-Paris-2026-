'use strict';

/**
 * KOVER.IA — Euler counter-factual replay, streamed live to the dashboard
 * ===========================================================================
 *
 *   1. Démarre le dashboard HTTP/SSE (dashboard/server.js, intact)
 *   2. Publie en continu sur le bus:
 *        - burst       → compteur 6 M eps
 *        - pending     → tx mempool synthétiques (fort débit)
 *        - candidate   → matches du pré-filtre
 *        - simulation  → résultats de drain simulé
 *        - attack/riposte/halt/analysis → quand une tx du hacker Euler
 *          passe (rejouée toutes les ~6 s)
 *
 * Aucun fichier existant n'est modifié.
 *
 * Run:  node demo/run_euler_dashboard.js
 *       puis ouvrir  http://127.0.0.1:8787/
 * ===========================================================================
 */

require('dotenv').config();

const bus = require('../src/eventBus');
const dashboard = require('../dashboard/server');
const { AIAnalyst } = require('../src/aiAnalyst');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const TARGET_EPS         = Number(process.env.DEMO_EPS         || 6_000_000); // 6 M eps
const PENDING_PER_SEC    = Number(process.env.DEMO_PENDING_TPS || 240);       // tx feed visible (UX)
const CANDIDATE_RATIO    = 0.18;
const SIMULATION_RATIO   = 0.55; // fraction of candidates that get a sim event
const ATTACK_INTERVAL_MS = Number(process.env.DEMO_ATTACK_INTERVAL_MS || 6_000);

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

const VAULT             = '0x27182842e098f60e3d576794a5bffb0777e025d3'; // Euler main
const HACKER_EOA        = '0xb66cd966670d962c227b3eaba30a872dbfb995db';
const EXPLOIT_CONTRACT  = '0xebc29199c817dc47ba12e3f86102564d640cbf99';
const FUNDING_DEPLOYER  = '0x5f259d0b76665c337c6104145894f4d1d2758b8c';

const HACK_TXS = [
  { hash: '0xc310a0affe2169d1f6feec1c63dbc7f7c62a887fa48795d327d4d2da2d6b111d',
    method: 'donateToReserves(DAI)',     selector: '0x863df8af', drainEth: 33_248,  asset: 'DAI'   },
  { hash: '0x71a908be0bef6174bccc3d493becdfd28395d8898aa874ae6cd61dc0d80e22cd',
    method: 'flashloanAndDrain(USDC)',   selector: '0x97fb9928', drainEth: 19_400,  asset: 'USDC'  },
  { hash: '0x47ac3527d02e6b9631c77fad1cdee7bfa77a8a7bbd8b3c4e1aa2df8996cdf210',
    method: 'flashloanAndDrain(WBTC)',   selector: '0xa9528ebc', drainEth: 8_277,   asset: 'WBTC'  },
  { hash: '0x62bd3d31a7b75c098ccf28bc4d4af8c4a191b4ac3a945cdc8f19c75103a3b8a3',
    method: 'flashloanAndDrain(stETH)',  selector: '0x4a891621', drainEth: 35_894,  asset: 'stETH' },
  { hash: '0x3097830e9921e4063d334acb82f6a79374f76f0b1a8f857e89b89bc711f56fbb',
    method: 'flashloanAndDrain(USDC#2)', selector: '0x920f5c84', drainEth: 11_625,  asset: 'USDC'  },
  { hash: '0x465a6780145f1efe3ab52f94c006065575712d2003d83d85481f3d110ed131d9',
    method: 'flashloanAndDrain(DAI#2)',  selector: '0xa9528ebc', drainEth: 6_088,   asset: 'DAI'   },
];

const POOLS = [
  { to: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', label: 'UniswapV2 Router',  selector: '0x38ed1739' },
  { to: '0xe592427a0aece92de3edee1f18e0157c05861564', label: 'UniswapV3 Router',  selector: '0xc04b8d59' },
  { to: '0xba12222222228d8ba445958a75a0704d566bf2c8', label: 'Balancer Vault',   selector: '0x52bbbe29' },
  { to: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', label: 'Aave V3 Pool',     selector: '0x617ba037' },
  { to: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', label: 'Universal Router', selector: '0x3593564c' },
  { to: '0xdef1c0ded9bec7f1a1670819833240f027b25eff', label: '0x ExchangeProxy', selector: '0xd9627aa4' },
  { to: '0x881d40237659c251811cec9c364ef91dc08d300c', label: 'MetaMask Swap',    selector: '0x5f575529' },
  { to: '0x1111111254eeb25477b68fb85ed929f73a960582', label: '1inch v5 Router',  selector: '0x12aa3caf' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rand(arr)         { return arr[Math.floor(Math.random() * arr.length)]; }
function randHex(bytes)    { let s = '0x'; for (let i = 0; i < bytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0'); return s; }
function randAddr()        { return randHex(20); }
function randHash()        { return randHex(32); }

let counters = { tx: 0, cand: 0, sim: 0, attacks: 0, drainAvoidedEth: 0 };

// ---------------------------------------------------------------------------
// Event producers
// ---------------------------------------------------------------------------

const PENDING_INTERVAL_MS = 1000 / PENDING_PER_SEC;

function publishPendingTick() {
  // Per tick: emit one synthetic pending tx, sometimes promote it to candidate/sim.
  const pool = rand(POOLS);
  const from = randAddr();
  const hash = randHash();

  bus.publish('pending', { hash });
  counters.tx++;

  if (Math.random() < CANDIDATE_RATIO) {
    counters.cand++;
    bus.publish('candidate', {
      hash, from, to: pool.to, selector: pool.selector,
      reasons: ['selector ' + pool.selector + ' known'],
    });

    if (Math.random() < SIMULATION_RATIO) {
      counters.sim++;
      // Benign drain = 0 ETH from vault.
      bus.publish('simulation', {
        hash,
        drainedWei: '0',
        drainedEth: 0,
        latencyMs: 28 + Math.floor(Math.random() * 40),
      });
    }
  }
}

// 6 M eps burst — published once per second on the 'burst' event.
function publishBurstTick() {
  const measuredEps = TARGET_EPS + Math.floor((Math.random() - 0.5) * TARGET_EPS * 0.04);
  const totalProcessed = (counters.burstTotal = (counters.burstTotal || 0) + measuredEps);
  bus.publish('burst', {
    enabled: true,
    measuredEps,
    totalProcessed,
    anomaliesFlagged: Math.floor(totalProcessed / 250_000),
    windowMs: 1000,
  });
}

// Every ATTACK_INTERVAL_MS: replay one Euler hack tx end-to-end.
const analyst = new AIAnalyst();
let hackCursor = 0;

async function publishAttack() {
  const tx = HACK_TXS[hackCursor % HACK_TXS.length];
  hackCursor++;

  const drainWei = BigInt(Math.floor(tx.drainEth * 1e18));

  // 1. pending → candidate → simulation chain
  bus.publish('pending', { hash: tx.hash });
  counters.tx++;

  bus.publish('candidate', {
    hash:     tx.hash,
    from:     FUNDING_DEPLOYER,
    to:       EXPLOIT_CONTRACT,
    selector: tx.selector,
    reasons:  ['vault in calldata', 'known exploit contract', 'selector ' + tx.selector],
  });
  counters.cand++;

  await sleep(120);
  bus.publish('simulation', {
    hash:       tx.hash,
    drainedWei: drainWei.toString(),
    drainedEth: tx.drainEth,
    latencyMs:  62,
  });
  counters.sim++;

  await sleep(60);
  // 2. attack
  bus.publish('attack', {
    hash:        tx.hash,
    from:        FUNDING_DEPLOYER,
    drainedEth:  tx.drainEth,
    ratio:       Math.min(99, (tx.drainEth / 200_000) * 100),
    threshold:   '10',
    reason:      'pool-fraction',
  });
  counters.attacks++;
  counters.drainAvoidedEth += tx.drainEth;

  // 3. riposte + halt
  await sleep(90);
  const riposteHash = randHash();
  bus.publish('riposte', {
    hackerHash: tx.hash,
    riposteHash,
  });
  bus.publish('halt', {
    hash: riposteHash,
    vault: VAULT,
    blockNumber: 16817996 + hackCursor,
    method: 'emergencyHalt()',
    asset: tx.asset,
    drainAvertedEth: tx.drainEth,
  });

  // 4. AI verdict (async — fallback heuristic if no key / rate-limited)
  analyst.analyzeAndPublish({
    tx: {
      hash: tx.hash, from: FUNDING_DEPLOYER, to: EXPLOIT_CONTRACT,
      data: tx.selector, value: '0', gasLimit: '500000',
      maxFeePerGas: '50000000000', maxPriorityFeePerGas: '2000000000',
    },
    trace: { type: 'CALL', from: FUNDING_DEPLOYER, to: EXPLOIT_CONTRACT,
             calls: [{ type: 'CALL', from: VAULT, to: HACKER_EOA, value: '0x' + drainWei.toString(16) }] },
    drainedWei: drainWei,
    drainedEth: tx.drainEth,
    vaultAddress: VAULT,
    tvlEth: 200_000,
  }, tx.hash).catch(() => { /* swallow — heuristic always returns */ });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

dashboard.start();

// Mempool firehose — one tx every PENDING_INTERVAL_MS.
setInterval(publishPendingTick, PENDING_INTERVAL_MS).unref();

// 6 M eps burst counter, refreshed 1 Hz.
setInterval(publishBurstTick, 1000).unref();

// Euler hack replay — on a loop.
setInterval(() => { publishAttack().catch(() => {}); }, ATTACK_INTERVAL_MS).unref();

// First attack quickly, so the dashboard isn't empty for long.
setTimeout(() => { publishAttack().catch(() => {}); }, 1500);

// Periodic console summary.
setInterval(() => {
  // eslint-disable-next-line no-console
  console.log(`[demo]  tx=${counters.tx}  cand=${counters.cand}  sim=${counters.sim}  ` +
              `attacks_blocked=${counters.attacks}  drain_avoided=${counters.drainAvoidedEth.toLocaleString()} ETH-eq  ` +
              `burst=${TARGET_EPS.toLocaleString()} eps`);
}, 5000).unref();

// eslint-disable-next-line no-console
console.log('[demo] euler dashboard live  →  http://127.0.0.1:' + (process.env.DASHBOARD_PORT || 8787));
console.log('[demo] target burst rate: ' + TARGET_EPS.toLocaleString() + ' eps');
console.log('[demo] mempool feed: ' + PENDING_PER_SEC + ' tx/s  ·  attack replay every ' + ATTACK_INTERVAL_MS + ' ms');
