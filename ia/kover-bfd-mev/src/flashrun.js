'use strict';

/**
 * Riposte engine — gas war + pre-built emergencyHalt() transaction.
 *
 * Optimisations:
 *   - The unsigned tx template (data, to, gasLimit, chainId) is built ONCE at
 *     boot. At fire time we only patch nonce + EIP-1559 fees, sign and broadcast.
 *   - Nonce is cached in-memory and pre-incremented to avoid an extra RPC hop.
 *   - A periodic refresh re-syncs nonce against the chain (in case of manual
 *     txs from the bot key).
 *   - Cooldown lock prevents replay storms while the chain propagates.
 */

const { Wallet, JsonRpcProvider, Interface, getBigInt, toQuantity } = require('ethers');
const { VAULT_ABI } = require('./constants');
const { logger } = require('./logger');

// ---------------------------------------------------------------------------
// Gas-strategy configuration
// ---------------------------------------------------------------------------
//
// Two gas-bump strategies are supported, selected via GAS_STRATEGY:
//
//   "additive"       (default)  → priority = max(hacker_prio + BUMP_GWEI, FLOOR_GWEI)
//                                  Bounded worst-case: even if attacker signs
//                                  at 10 000 gwei, our cost grows linearly.
//
//   "multiplicative"            → priority = max(hacker_prio × MULT, FLOOR_GWEI)
//                                  Wins more aggressively in low-fee regimes
//                                  but exposes us to fee griefing if attacker
//                                  signs at high priority.
//
// In production we recommend "additive". The "multiplicative" mode is exposed
// for parity with the historical KOVER.IA spec (× 2.5 of the attacker fee).
// ---------------------------------------------------------------------------

const GAS_STRATEGY      = (process.env.GAS_STRATEGY || 'additive').toLowerCase();
const GAS_MULTIPLIER_x10= BigInt(process.env.GAS_MULTIPLIER_x10 || '25'); // 25 = 2.5×
const PRIORITY_BUMP_GWEI = BigInt(process.env.PRIORITY_BUMP_GWEI || '50');
const PRIORITY_FLOOR_GWEI = BigInt(process.env.PRIORITY_FLOOR_GWEI || '60');
const FALLBACK_PRIORITY_GWEI = BigInt(process.env.FALLBACK_PRIORITY_GWEI || '3');
const HALT_GAS_LIMIT = BigInt(process.env.HALT_GAS_LIMIT || '120000');
const COOLDOWN_MS = Number(process.env.HALT_COOLDOWN_MS || '30000');
const NONCE_RESYNC_MS = Number(process.env.NONCE_RESYNC_MS || '15000');
const FLASHBOTS_RPC_URL = process.env.FLASHBOTS_RPC_URL || ''; // optional private mempool
const GWEI = 10n ** 9n;

class FlashRun {
  /**
   * @param {Object} cfg
   * @param {string} cfg.httpsRpcUrl
   * @param {string} cfg.privateKey
   * @param {string} cfg.vaultAddress
   * @param {number} cfg.chainId
   */
  constructor({ httpsRpcUrl, privateKey, vaultAddress, chainId }) {
    if (!httpsRpcUrl || !privateKey || !vaultAddress || !chainId) {
      throw new Error('FlashRun: missing required config');
    }
    this._provider = new JsonRpcProvider(httpsRpcUrl, chainId, { staticNetwork: true });
    // Optional private-mempool relay (Flashbots Protect) for the riposte tx.
    // Falls back to the public RPC provider if not configured.
    this._broadcaster = FLASHBOTS_RPC_URL
      ? new JsonRpcProvider(FLASHBOTS_RPC_URL, chainId, { staticNetwork: true })
      : this._provider;
    this._wallet = new Wallet(privateKey, this._provider);
    this._vault = vaultAddress;
    this._chainId = chainId;
    this._iface = new Interface(VAULT_ABI);

    // Pre-encoded calldata for emergencyHalt() — no per-fire encoding cost.
    this._haltData = this._iface.encodeFunctionData('emergencyHalt', []);

    this._nonce = null;
    this._lastFireMs = 0;
    this._firing = false;
  }

  async warmup() {
    this._nonce = await this._provider.getTransactionCount(this._wallet.address, 'pending');
    logger.info({ bot: this._wallet.address, nonce: this._nonce, vault: this._vault },
      'flashrun warmed up');

    setInterval(() => this._resyncNonce(), NONCE_RESYNC_MS).unref();
  }

  async _resyncNonce() {
    try {
      const onchain = await this._provider.getTransactionCount(this._wallet.address, 'pending');
      if (onchain > this._nonce) {
        logger.warn({ cached: this._nonce, onchain }, 'nonce drift — resyncing upward');
        this._nonce = onchain;
      }
    } catch (err) {
      logger.error({ err: err.message }, 'nonce resync failed');
    }
  }

  /**
   * Build the EIP-1559 fee envelope that beats the hacker's tx.
   *
   * Strategy selected by GAS_STRATEGY env var:
   *   "additive" (default)  : prio = max(hacker_prio + BUMP, FLOOR)
   *   "multiplicative"      : prio = max(hacker_prio × MULT,  FLOOR)
   *
   * @param {{ maxFeePerGas?: bigint, maxPriorityFeePerGas?: bigint, gasPrice?: bigint }} hackerTx
   * @returns {{ maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, strategy: string }}
   */
  _bumpedFees(hackerTx) {
    const hackerPriority =
      getBigInt(hackerTx.maxPriorityFeePerGas ?? hackerTx.gasPrice ?? FALLBACK_PRIORITY_GWEI * GWEI);
    const hackerMaxFee =
      getBigInt(hackerTx.maxFeePerGas ?? hackerTx.gasPrice ?? hackerPriority);

    const floorPriority = PRIORITY_FLOOR_GWEI * GWEI;

    let myPriority;
    if (GAS_STRATEGY === 'multiplicative') {
      // x2.5 by default — multiplied by GAS_MULTIPLIER_x10 / 10 to keep BigInt arithmetic.
      const scaled = (hackerPriority * GAS_MULTIPLIER_x10) / 10n;
      myPriority = scaled > floorPriority ? scaled : floorPriority;
    } else {
      // Additive bump (production default).
      const bumped = hackerPriority + PRIORITY_BUMP_GWEI * GWEI;
      myPriority = bumped > floorPriority ? bumped : floorPriority;
    }

    // maxFee must cover base + our priority. Ensure it strictly exceeds the
    // hacker's max, plus our priority bump headroom.
    const myMaxFee = (hackerMaxFee > myPriority ? hackerMaxFee : myPriority) + PRIORITY_BUMP_GWEI * GWEI;

    return { maxFeePerGas: myMaxFee, maxPriorityFeePerGas: myPriority, strategy: GAS_STRATEGY };
  }

  /**
   * Fire emergencyHalt() with fees bumped above the hacker's tx.
   *
   * @param {object} hackerTx ethers.TransactionResponse-like
   * @param {object} timeline logger timeline tracker
   * @returns {Promise<string|null>} broadcast tx hash or null
   */
  async trigger(hackerTx, timeline) {
    const now = Date.now();
    if (this._firing) {
      logger.warn('riposte already in flight — skipping');
      return null;
    }
    if (now - this._lastFireMs < COOLDOWN_MS) {
      logger.warn({ remainingMs: COOLDOWN_MS - (now - this._lastFireMs) },
        'riposte suppressed by cooldown');
      return null;
    }
    this._firing = true;

    try {
      const { maxFeePerGas, maxPriorityFeePerGas } = this._bumpedFees(hackerTx);
      const nonce = this._nonce++;

      const tx = {
        to: this._vault,
        data: this._haltData,
        nonce,
        chainId: this._chainId,
        type: 2,
        gasLimit: HALT_GAS_LIMIT,
        maxFeePerGas,
        maxPriorityFeePerGas,
        value: 0n,
      };

      timeline?.mark('signing', { nonce, maxFeePerGas: toQuantity(maxFeePerGas) });
      const signed = await this._wallet.signTransaction(tx);
      timeline?.mark('signed');

      const sent = await this._broadcaster.broadcastTransaction(signed);
      timeline?.mark('broadcast', { txHash: sent.hash });

      this._lastFireMs = Date.now();
      logger.warn({
        riposteTx: sent.hash,
        hackerTx: hackerTx.hash,
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      }, 'CIRCUIT BREAKER FIRED');
      return sent.hash;
    } catch (err) {
      // Roll back optimistic nonce bump on failure.
      this._nonce = Math.max(this._nonce - 1, 0);
      logger.error({ err: err.message, hackerTx: hackerTx.hash }, 'riposte broadcast failed');
      return null;
    } finally {
      this._firing = false;
    }
  }
}

module.exports = { FlashRun };
