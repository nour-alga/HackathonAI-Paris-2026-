'use strict';

/**
 * KOVER.IA — Multi-Chain Runtime
 * ===========================================================================
 *
 * Boots the full stack with simultaneous mempool surveillance across every
 * chain in `defi_registry`:
 *
 *   1. HTTP dashboard (SSE + UI) on http://127.0.0.1:DASHBOARD_PORT
 *   2. Multi-chain bridge — one WSS subscription per chain, in parallel
 *   3. Synthetic generator (background pulse, optional)
 *   4. Burst generator (high-throughput benchmark, optional)
 *   5. AI Threat Analyst (Cerebras / Anthropic / mock)
 *   6. Periodic synthetic attack injection (demo only)
 *
 * Hard guarantees:
 *   - Failure of any one chain's RPC does not affect the others.
 *   - No transactions are ever broadcast; the engine is read-only.
 *   - All graceful-shutdown handlers from start_demo.js apply here.
 *
 * Run:    npm run start:multichain
 *         (open http://127.0.0.1:8787 in your browser)
 *
 * @author KOVER.IA platform team — proprietary
 */

require('dotenv').config();

const dashboard      = require('../dashboard/server');
const bus            = require('./eventBus');
const { logger }     = require('./logger');
const { AIAnalyst }  = require('./aiAnalyst');
const { BurstGenerator } = require('./burst');
const { MultiChainBridge } = require('./multichain');
const { ATTACK_TX, SIMULATION_TRACE, TARGETED_VAULT, VAULT_TVL_ETH,
        ATTACKER_EOA } = require('../demo/scenario');

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

const aiAnalyst = new AIAnalyst();
const burst     = new BurstGenerator();
const bridge    = new MultiChainBridge();

// ---------------------------------------------------------------------------
// Synthetic attack injection — fires at intervals so the dashboard always
// has something to show even on quiet chains.
// ---------------------------------------------------------------------------

const ATTACK_AFTER_MS  = Number(process.env.MC_INJECT_AFTER_MS  || '20000');
const ATTACK_PERIOD_MS = Number(process.env.MC_INJECT_PERIOD_MS || '90000');

function injectAttack() {
  const hash = ATTACK_TX.hash;
  const drainedEth = 847.32;
  const ratio = (drainedEth / Number(VAULT_TVL_ETH)) * 100;
  const riposteHash = '0xc1rcu1tbreakerc1rcu1tbreakerc1rcu1tbreakerc1rcu1tbreaker0deadbf1';

  logger.warn({ hash }, '[multichain] injecting synthetic attack scenario');

  bus.publish('pending', { hash, chain: 'ethereum' });
  setTimeout(() => bus.publish('candidate', {
    hash, chain: 'ethereum', from: ATTACKER_EOA, to: ATTACK_TX.to,
    selector: ATTACK_TX.data.slice(0, 10),
    reasons: ['to ∈ flashloan_providers (Aave V3)',
              `selector ${ATTACK_TX.data.slice(0, 10)}`,
              'vault in calldata'],
  }), 50);
  setTimeout(() => bus.publish('simulation', {
    hash, drainedWei: '847320000000000000000', drainedEth, latencyMs: 47,
  }), 250);
  setTimeout(() => bus.publish('attack', {
    hash, from: ATTACKER_EOA, drainedEth, ratio, threshold: 10,
  }), 700);
  setTimeout(() => bus.publish('riposte', {
    hackerHash: hash, riposteHash, maxFee: 120, maxPriority: 62,
    strategy: process.env.GAS_STRATEGY || 'additive',
  }), 1150);
  setTimeout(() => bus.publish('halt', {
    riposteHash, blockNumber: 19_243_521, position: 3,
  }), 2400);

  aiAnalyst
    .analyzeAndPublish({
      tx: { hash, from: ATTACKER_EOA, to: ATTACK_TX.to,
            data: ATTACK_TX.data, value: ATTACK_TX.value,
            gasLimit: ATTACK_TX.gasLimit,
            maxFeePerGas: ATTACK_TX.maxFeePerGas,
            maxPriorityFeePerGas: ATTACK_TX.maxPriorityFeePerGas },
      trace: SIMULATION_TRACE,
      drainedWei: BigInt('847320000000000000000'),
      drainedEth, vaultAddress: TARGETED_VAULT,
      tvlEth: Number(VAULT_TVL_ETH),
    }, hash)
    .catch((err) => logger.error({ err: err.message }, '[multichain] analyst publish failed'));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let _shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 5000;

async function gracefulShutdown(signal, exitCode) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  logger.info({ signal }, '[multichain] shutting down');
  const force = setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS);
  force.unref();
  try { await bridge.stop();      } catch { /* ignore */ }
  try { await dashboard.stop?.(); } catch { /* ignore */ }
  try { burst.stop();             } catch { /* ignore */ }
  process.exit(exitCode);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT', 130));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0));
process.on('unhandledRejection', (err) =>
  logger.error({ err: String(err) }, '[multichain] unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, '[multichain] uncaught');
  gracefulShutdown('uncaught', 1);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  logger.info({
    port: process.env.DASHBOARD_PORT || 8787,
    burstEnabled: burst.enabled,
  }, '[multichain] starting full stack');

  // 1. Dashboard
  dashboard.start();

  // 2. Burst (capacity benchmark) — gated by BURST_TARGET_EPS
  burst.start();

  // 3. Multi-chain mempool bridges
  await bridge.start();

  // 4. Periodic synthetic attack so the demo always shows something
  setTimeout(() => {
    injectAttack();
    if (ATTACK_PERIOD_MS > 0) setInterval(injectAttack, ATTACK_PERIOD_MS);
  }, ATTACK_AFTER_MS);

  logger.info({
    firstAttackInSec: ATTACK_AFTER_MS / 1000,
    repeatEverySec: ATTACK_PERIOD_MS > 0 ? ATTACK_PERIOD_MS / 1000 : 'never',
  }, '[multichain] demo schedule');
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, '[multichain] boot failed');
  process.exit(1);
});
