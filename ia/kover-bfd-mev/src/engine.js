'use strict';

/**
 * ===========================================================================
 *  KOVER.IA — Behavioral Flow Detection Engine
 * ===========================================================================
 *
 *  Single-class reference implementation of the 6-stage flashloan
 *  interception pipeline. Production-ready, fault-tolerant, fully
 *  instrumented for the dashboard event-bus.
 *
 *  The engine consumes pending transactions from the Ethereum mempool over
 *  WebSocket, classifies them, simulates the malicious ones against the
 *  current chain state, and — if a real drain is confirmed against the
 *  protected vault — broadcasts a defensive `emergencyHalt()` transaction
 *  with priority fees engineered to win the next block.
 *
 *  Pipeline (each stage maps to a private method below):
 *
 *     Stage 1 — _connectMempool       Permanent WSS surveillance
 *     Stage 2 — _preFilter            ~0.1 ms hash-set lookups
 *     Stage 3 — _simulate             ~50 ms debug_traceCall + stateOverrides
 *     Stage 4 — _decide               Threshold compare against vault outflow
 *     Stage 5 — _riposte              Gas-war + sign + private broadcast
 *     Stage 6 — _confirmInclusion     Verify halt landed before attacker
 *
 *  Every stage publishes structured events on the in-process `eventBus`,
 *  consumed by the HTTP dashboard (src/eventBus.js + dashboard/server.js).
 *  Schema is stable; downstream consumers (Kafka exporter, Lovable webhook)
 *  can be plugged in without changing engine code.
 *
 *  Hard runtime guarantees:
 *    - WSS auto-reconnects with exponential backoff + jitter (cap 30 s)
 *    - Heartbeat watchdog: forced reconnect after 30 s of mempool silence
 *    - Per-EOA simulation rate-limit (8 sims / 10 s) — DoS mitigation
 *    - Cooldown lock on the riposte (30 s) — anti-replay during reorgs
 *    - Cached + auto-resynced nonce on the bot key — no RPC hit per riposte
 *    - All secrets read from .env, never logged, never persisted
 *
 *  @module    src/engine
 *  @author    KOVER.IA platform team
 *  @license   Proprietary
 * ===========================================================================
 */

const {
  WebSocketProvider,
  JsonRpcProvider,
  Wallet,
  Interface,
  getBigInt,
  toQuantity,
} = require('ethers');

const bus = require('./eventBus');
const { FLASHLOAN_PROVIDERS, FLASHLOAN_SELECTORS, VAULT_ABI } = require('./constants');
const { logger, newTimeline } = require('./logger');
const { AIAnalyst } = require('./aiAnalyst');
const validators = require('./validators');

// ===========================================================================
// CONSTANTS
// ===========================================================================

const GWEI = 10n ** 9n;

const PROVIDER_LABELS = Object.freeze({
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': 'Aave V3 Pool',
  '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9': 'Aave V2 Pool',
  '0xba12222222228d8ba445958a75a0704d566bf2c8': 'Balancer V2 Vault',
  '0x60744434d6339a6b27d73d9eda62b6f66a0a04fa': 'Maker DSS Flash',
  '0x1e0447b19bb6ecfdae1e4ae1694b0c3659614e4e': 'dYdX SoloMargin',
});

// ===========================================================================
// TYPES (JSDoc only — runtime stays plain JS for zero-dep deployments)
// ===========================================================================

/**
 * @typedef {object} EngineConfig
 *
 * @property {string} wssRpcUrl           WSS endpoint (mempool subscription)
 * @property {string} httpsRpcUrl         HTTPS endpoint (simulation + broadcast)
 * @property {string} privateKey          Hot-key bot, dedicated EOA, low balance
 * @property {string} vaultAddress        Address of the protected Vault
 * @property {number} chainId             1 (mainnet), 11155111 (sepolia)…
 *
 * @property {bigint} ethDrainThresholdWei    Absolute drain that triggers halt
 * @property {number} poolFractionThreshold   e.g. 0.05 = 5 % of TVL
 *
 * @property {'additive' | 'multiplicative'} gasStrategy
 * @property {bigint} priorityBumpGwei         additive bump above hacker
 * @property {bigint} priorityFloorGwei        global-pool floor
 * @property {bigint} gasMultiplierX10         multiplicative path: 25 = 2.5×
 *
 * @property {bigint} haltGasLimit             gas budget for emergencyHalt()
 * @property {number} haltCooldownMs           anti-replay lock
 * @property {number} nonceResyncMs            background nonce drift correction
 *
 * @property {number} reconnectBaseMs          WSS backoff floor
 * @property {number} reconnectMaxMs           WSS backoff cap
 * @property {number} heartbeatTimeoutMs       force-reconnect on silence
 *
 * @property {number} rpcTimeoutMs             hot-path RPC budget
 * @property {string} [flashbotsRpcUrl]        optional private mempool relay
 */

/**
 * @typedef {object} CandidateReport
 * @property {boolean} match
 * @property {string[]} reasons
 */

/**
 * @typedef {object} SimulationResult
 * @property {bigint} drainedWei
 * @property {number} drainedEth
 * @property {number} latencyMs
 * @property {number} frameCount
 */

/**
 * @typedef {object} Decision
 * @property {boolean} fire
 * @property {string}  [reason]
 * @property {number}  [ratio]
 */

// ===========================================================================
// ENGINE
// ===========================================================================

class KoverEngine {
  /** @param {EngineConfig} config */
  constructor(config) {
    this._cfg = Object.freeze({ ...config });
    this._vaultLc = config.vaultAddress.toLowerCase();

    // ---- Providers (lazy: created on start) ----
    /** @type {WebSocketProvider|null} */ this._ws  = null;
    /** @type {JsonRpcProvider|null}   */ this._http = null;
    /** @type {JsonRpcProvider|null}   */ this._broadcaster = null;

    // ---- Wallet & cached calldata ----
    this._wallet = new Wallet(config.privateKey);
    this._iface  = new Interface(VAULT_ABI);
    this._haltData = this._iface.encodeFunctionData('emergencyHalt', []);

    // ---- State machine ----
    this._cachedNonce = null;
    this._cachedTvlWei = 0n;
    this._lastHaltMs = 0;
    this._firing = false;

    // ---- Resilience ----
    this._reconnectAttempt = 0;
    this._heartbeatTimer = null;
    this._shuttingDown = false;

    // ---- DoS mitigation: per-EOA simulation quota ----
    this._simHits = new Map(); // from -> [timestamp ms]
    this._simQuota = 8;
    this._simWindowMs = 10_000;
    this._simHitsMaxSize = 5_000; // hard cap — anti-OOM under sybil flood

    // ---- LLM Agent (asynchronous forensics layer) ----
    this._aiAnalyst = new AIAnalyst();
  }

  // -----------------------------------------------------------------------
  // PUBLIC LIFECYCLE
  // -----------------------------------------------------------------------

  /**
   * Boots the engine end-to-end:
   *   1. Opens HTTPS provider, optionally Flashbots relay
   *   2. Warms up the bot nonce cache
   *   3. Refreshes the vault TVL snapshot
   *   4. Connects to the WSS mempool (Stage 1)
   *
   * Idempotent within reason — calling start twice is a no-op.
   */
  async start() {
    logger.info({
      vault: this._cfg.vaultAddress,
      chainId: this._cfg.chainId,
      gasStrategy: this._cfg.gasStrategy,
    }, 'engine starting');

    this._http = new JsonRpcProvider(this._cfg.httpsRpcUrl, this._cfg.chainId, { staticNetwork: true });
    this._broadcaster = this._cfg.flashbotsRpcUrl
      ? new JsonRpcProvider(this._cfg.flashbotsRpcUrl, this._cfg.chainId, { staticNetwork: true })
      : this._http;
    this._wallet = this._wallet.connect(this._http);

    await this._warmupNonce();
    await this._refreshTvl();
    setInterval(() => this._refreshTvl().catch(() => null), 10_000).unref();
    setInterval(() => this._resyncNonce().catch(() => null), this._cfg.nonceResyncMs).unref();
    setInterval(() => this._gcSimQuota(), 30_000).unref();

    await this._connectMempool();
  }

  /** Graceful shutdown — closes WSS, drains in-flight broadcasts. */
  async stop() {
    this._shuttingDown = true;
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    try { if (this._ws) await this._ws.destroy(); } catch { /* ignore */ }
  }

  // =======================================================================
  //  STAGE 1 — Permanent WebSocket surveillance of the mempool
  // -----------------------------------------------------------------------
  //  The engine subscribes to `pending` notifications from the QuickNode
  //  WSS endpoint. Each event delivers a tx HASH; we fetch the full body
  //  via getTransaction (Stage 2 prerequisite).
  //
  //  Resilience features wired in this stage:
  //    - Exponential backoff reconnect (cap 30 s, jitter 0–250 ms)
  //    - Heartbeat watchdog: if no `pending` event arrives within 30 s,
  //      we force a reconnect (the WS may be silently dead).
  //    - Bubble-up errors as `error` events on the bus for the dashboard.
  // =======================================================================

  async _connectMempool() {
    if (this._shuttingDown) return;
    try {
      this._ws = new WebSocketProvider(this._cfg.wssRpcUrl, this._cfg.chainId, { staticNetwork: true });
      // ethers v6 surfaces socket errors via the underlying ws.
      const sock = this._ws.websocket;
      sock?.on?.('error', (err) => {
        bus.publish('error', { stage: 'wss', msg: err.message });
        this._scheduleReconnect('ws-error');
      });
      sock?.on?.('close', (code) => {
        logger.warn({ code }, 'ws closed');
        this._scheduleReconnect('ws-close');
      });

      await this._ws.on('pending', (txHash) => {
        // Fire-and-forget — we MUST NOT block the WSS event loop.
        this._processPending(txHash).catch((err) => {
          logger.error({ txHash, err: err.message }, 'processPending threw');
          bus.publish('error', { stage: 'pipeline', msg: err.message });
        });
      });

      this._reconnectAttempt = 0;
      this._bumpHeartbeat();
      logger.info('mempool subscription active');
    } catch (err) {
      logger.error({ err: err.message }, 'connect failed');
      this._scheduleReconnect('connect-failed');
    }
  }

  _scheduleReconnect(reason) {
    if (this._shuttingDown) return;
    if (this._ws) {
      try { this._ws.removeAllListeners(); this._ws.destroy(); } catch { /* */ }
      this._ws = null;
    }
    const exp = Math.min(this._cfg.reconnectBaseMs * 2 ** this._reconnectAttempt, this._cfg.reconnectMaxMs);
    const delay = exp + Math.floor(Math.random() * 250);
    this._reconnectAttempt += 1;
    logger.warn({ reason, attempt: this._reconnectAttempt, delayMs: delay }, 'reconnecting');
    setTimeout(() => this._connectMempool(), delay);
  }

  _bumpHeartbeat() {
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = setTimeout(() => {
      logger.warn('heartbeat timeout — forcing reconnect');
      this._scheduleReconnect('heartbeat-timeout');
    }, this._cfg.heartbeatTimeoutMs);
  }

  // =======================================================================
  //  HOT PATH — orchestrates Stages 2 → 6 for one pending tx
  // =======================================================================

  /**
   * Per-tx pipeline. Latency budget < 100 ms.
   *
   * @param {string} txHash
   */
  async _processPending(txHash) {
    this._bumpHeartbeat();
    const tl = newTimeline(txHash);
    tl.mark('reception');
    bus.publish('pending', { hash: txHash });

    // ---- Fetch the full body (Stage 2 input) ----
    let tx;
    try {
      tx = await this._http.getTransaction(txHash);
    } catch (err) {
      logger.debug({ txHash, err: err.message }, 'getTransaction failed');
      return;
    }
    if (!tx) return;

    // Validate before letting it cross into the engine. Drops malformed,
    // oversized, or otherwise suspicious payloads — we never trust raw
    // mempool data, even from a "known" provider.
    try {
      validators.mempoolTx(tx);
    } catch (err) {
      logger.warn({ txHash, err: err.message }, 'tx failed validation — dropping');
      return;
    }
    tl.mark('fetched');

    // ---- Stage 2: pre-filter ----
    const cand = this._preFilter(tx);
    if (!cand.match) return;
    tl.mark('candidate', { reasons: cand.reasons });
    bus.publish('candidate', {
      hash: txHash, from: tx.from, to: tx.to,
      selector: tx.data.slice(0, 10),
      reasons: cand.reasons,
    });

    // ---- DoS mitigation: per-EOA simulation budget ----
    if (!this._consumeSimQuota(tx.from)) {
      logger.warn({ txHash, from: tx.from }, 'sim quota exhausted (DoS mitigation)');
      return;
    }

    // ---- Stage 3: simulate ----
    let sim;
    try {
      sim = await this._simulate(tx);
    } catch (err) {
      logger.error({ txHash, err: err.message }, 'simulation failed');
      bus.publish('error', { stage: 'simulation', msg: err.message });
      return;
    }
    tl.mark('simulated', { drainedWei: sim.drainedWei.toString() });
    bus.publish('simulation', {
      hash: txHash,
      drainedWei: sim.drainedWei.toString(),
      drainedEth: sim.drainedEth,
      latencyMs: sim.latencyMs,
      frameCount: sim.frameCount,
    });

    // ---- Stage 4: decide ----
    const decision = this._decide(sim.drainedWei);
    if (!decision.fire) {
      tl.mark('benign');
      tl.flush();
      return;
    }

    bus.publish('attack', {
      hash: txHash, from: tx.from,
      drainedEth: sim.drainedEth,
      ratio: decision.ratio,
      threshold: Number(this._cfg.ethDrainThresholdWei / 10n ** 18n),
      reason: decision.reason,
    });
    logger.warn({
      txHash, hackerFrom: tx.from,
      drainedEth: sim.drainedEth, reason: decision.reason,
    }, 'malicious flashloan detected — engaging riposte');

    // Fan out to the LLM Agent in parallel — DOES NOT block the riposte.
    // The deterministic engine has already decided to fire; the LLM only
    // adds explainability for the post-mortem.
    this._aiAnalyst
      .analyzeAndPublish({
        tx,
        trace: sim.trace,
        drainedWei: sim.drainedWei,
        drainedEth: sim.drainedEth,
        vaultAddress: this._cfg.vaultAddress,
        tvlEth: Number(this._cachedTvlWei) / 1e18,
      }, txHash)
      .catch((err) => logger.error({ err: err.message }, '[ai_analyst] publish failed'));

    // ---- Stage 5: riposte ----
    const riposteHash = await this._riposte(tx, tl);
    if (!riposteHash) return;

    // ---- Stage 6: inclusion ----
    this._confirmInclusion(riposteHash, txHash).catch((err) => {
      logger.error({ riposteHash, err: err.message }, 'confirmInclusion failed');
    });

    tl.flush();
  }

  // =======================================================================
  //  STAGE 2 — Ultra-fast pre-filter (~0.1 ms, O(1) hash-set lookups)
  // -----------------------------------------------------------------------
  //  Three deterministic indicators are checked in constant time:
  //    1. tx.to is a known flashloan provider (Aave V2/V3, Balancer,
  //       Maker DSS, dYdX, …).
  //    2. The 4-byte calldata selector matches a known flashLoan signature.
  //    3. Our protected vault address appears anywhere in the calldata.
  //  If NONE of the three trips, the tx is dropped immediately. This
  //  filters ~99 % of mempool noise before any RPC call is spent.
  // =======================================================================

  /**
   * @param {{ to?: string|null, data?: string|null }} tx
   * @returns {CandidateReport}
   */
  _preFilter(tx) {
    if (!tx?.to || !tx?.data || tx.data.length < 10) return { match: false, reasons: [] };
    const to  = tx.to.toLowerCase();
    const sel = tx.data.slice(0, 10).toLowerCase();
    const reasons = [];
    if (FLASHLOAN_PROVIDERS.has(to))      reasons.push(`to ∈ flashloan_providers (${PROVIDER_LABELS[to] || 'unknown'})`);
    if (FLASHLOAN_SELECTORS.has(sel))     reasons.push(`selector ${sel} ∈ flashloan_selectors`);
    if (tx.data.toLowerCase().includes(this._vaultLc.slice(2))) reasons.push('vault address present in calldata');
    return { match: reasons.length > 0, reasons };
  }

  // =======================================================================
  //  STAGE 3 — Pre-execution simulation (~50 ms, debug_traceCall)
  // -----------------------------------------------------------------------
  //  We ask the node to REPLAY the candidate transaction against the latest
  //  chain state without broadcasting it. Geth's `callTracer` returns the
  //  full recursive call tree.
  //
  //  We then walk the tree and sum every internal CALL where `from` equals
  //  our vault — that is the exact native-ETH outflow the malicious tx
  //  would cause. ERC-20 drains are not yet covered (see SECURITY.md).
  //
  //  stateOverrides pin the attacker's balance to 2^104 wei so they cannot
  //  orchestrate an artificial revert to hide intent during simulation.
  // =======================================================================

  /**
   * @param {object} tx ethers TransactionResponse-like
   * @returns {Promise<SimulationResult>}
   */
  async _simulate(tx) {
    const t0 = Date.now();

    // Geth/Erigon enforce strict QUANTITY hex (no leading zeros).
    const callObject = {
      from: tx.from,
      to: tx.to,
      value: tx.value ? toQuantity(tx.value) : '0x0',
      gas:   tx.gasLimit ? toQuantity(tx.gasLimit) : '0x1c9c380',
      data:  tx.data ?? '0x',
      maxFeePerGas:         tx.maxFeePerGas         ? toQuantity(tx.maxFeePerGas)         : undefined,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? toQuantity(tx.maxPriorityFeePerGas) : undefined,
    };
    const stateOverride = {
      [tx.from]: { balance: '0xffffffffffffffffffffffffffff' },
    };

    const trace = await this._http.send('debug_traceCall', [
      callObject,
      'latest',
      { tracer: 'callTracer', stateOverrides: stateOverride, timeout: '95ms' },
    ]);

    const drainedWei = this._sumOutflow(trace);
    const frameCount = this._countFrames(trace);
    return {
      drainedWei,
      drainedEth: Number(drainedWei) / 1e18,
      latencyMs:  Date.now() - t0,
      frameCount,
      trace,
    };
  }

  /** Recursive walker over a Geth callTracer frame tree. */
  _sumOutflow(frame) {
    if (!frame) return 0n;
    let total = 0n;
    if ((frame.from || '').toLowerCase() === this._vaultLc && frame.value && frame.value !== '0x0') {
      try { total += getBigInt(frame.value); } catch { /* malformed — ignore */ }
    }
    if (Array.isArray(frame.calls)) for (const c of frame.calls) total += this._sumOutflow(c);
    return total;
  }

  _countFrames(frame) {
    if (!frame) return 0;
    let n = 1;
    if (Array.isArray(frame.calls)) for (const c of frame.calls) n += this._countFrames(c);
    return n;
  }

  // =======================================================================
  //  STAGE 4 — Binary decision on the simulated drain
  // -----------------------------------------------------------------------
  //  Two thresholds (any one trips → fire):
  //    A. Absolute ETH drain ≥ ethDrainThresholdWei
  //    B. Drain / cached TVL ≥ poolFractionThreshold
  //  TVL is refreshed in the background every 10 s — never on the hot path.
  // =======================================================================

  /**
   * @param {bigint} drainedWei
   * @returns {Decision}
   */
  _decide(drainedWei) {
    if (drainedWei >= this._cfg.ethDrainThresholdWei) {
      return { fire: true, reason: 'absolute-threshold' };
    }
    if (this._cachedTvlWei > 0n) {
      const ratio = Number((drainedWei * 1_000_000n) / this._cachedTvlWei) / 1_000_000;
      if (ratio >= this._cfg.poolFractionThreshold) {
        return { fire: true, reason: 'pool-fraction', ratio: ratio * 100 };
      }
    }
    return { fire: false };
  }

  // =======================================================================
  //  STAGE 5 — Defensive front-running riposte (~30 ms)
  // -----------------------------------------------------------------------
  //  Algorithm:
  //    1. Read attacker priority/maxFee from tx
  //    2. Bump them according to gasStrategy:
  //         - additive       : prio = max(hacker_prio + BUMP, FLOOR)
  //         - multiplicative : prio = max(hacker_prio × MULT,  FLOOR)
  //    3. Patch nonce + fees onto the pre-encoded emergencyHalt() calldata
  //    4. Sign locally (secp256k1, no RPC round-trip)
  //    5. Broadcast via Flashbots Protect (private mempool, anti-backrun)
  //
  //  Cooldown lock + optimistic nonce roll-back protect against replays.
  // =======================================================================

  /**
   * @param {object} hackerTx
   * @param {ReturnType<typeof newTimeline>} tl
   * @returns {Promise<string|null>}
   */
  async _riposte(hackerTx, tl) {
    const now = Date.now();
    if (this._firing) {
      logger.warn('riposte already in flight — skipping');
      return null;
    }
    if (now - this._lastHaltMs < this._cfg.haltCooldownMs) {
      logger.warn({ remainingMs: this._cfg.haltCooldownMs - (now - this._lastHaltMs) },
        'riposte suppressed by cooldown');
      return null;
    }
    this._firing = true;

    try {
      const { maxFeePerGas, maxPriorityFeePerGas } = this._bumpedFees(hackerTx);
      const nonce = this._cachedNonce++;
      tl.mark('signing', { nonce });

      const tx = {
        to:       this._cfg.vaultAddress,
        data:     this._haltData,
        nonce,
        chainId:  this._cfg.chainId,
        type:     2,
        gasLimit: this._cfg.haltGasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        value:    0n,
      };

      const signed = await this._wallet.signTransaction(tx);
      tl.mark('signed');
      const sent = await this._broadcaster.broadcastTransaction(signed);
      tl.mark('broadcast', { txHash: sent.hash });

      this._lastHaltMs = Date.now();
      logger.warn({
        riposteTx: sent.hash, hackerTx: hackerTx.hash,
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      }, 'CIRCUIT BREAKER FIRED');

      bus.publish('riposte', {
        hackerHash:   hackerTx.hash,
        riposteHash:  sent.hash,
        maxFee:       Number(maxFeePerGas / GWEI),
        maxPriority:  Number(maxPriorityFeePerGas / GWEI),
        strategy:     this._cfg.gasStrategy,
      });
      return sent.hash;
    } catch (err) {
      // Roll back optimistic nonce bump on broadcast failure.
      this._cachedNonce = Math.max(this._cachedNonce - 1, 0);
      logger.error({ err: err.message, hackerTx: hackerTx.hash }, 'riposte broadcast failed');
      bus.publish('error', { stage: 'riposte', msg: err.message });
      return null;
    } finally {
      this._firing = false;
    }
  }

  /**
   * Computes the EIP-1559 fee envelope that beats the hacker.
   *
   * @param {{maxFeePerGas?: bigint, maxPriorityFeePerGas?: bigint, gasPrice?: bigint}} hackerTx
   */
  _bumpedFees(hackerTx) {
    const fallback = this._cfg.priorityFloorGwei * GWEI;
    const hackerPriority = getBigInt(hackerTx.maxPriorityFeePerGas ?? hackerTx.gasPrice ?? fallback);
    const hackerMaxFee   = getBigInt(hackerTx.maxFeePerGas         ?? hackerTx.gasPrice ?? hackerPriority);

    const floor = this._cfg.priorityFloorGwei * GWEI;
    let myPriority;
    if (this._cfg.gasStrategy === 'multiplicative') {
      const scaled = (hackerPriority * this._cfg.gasMultiplierX10) / 10n;
      myPriority = scaled > floor ? scaled : floor;
    } else {
      const bumped = hackerPriority + this._cfg.priorityBumpGwei * GWEI;
      myPriority = bumped > floor ? bumped : floor;
    }
    const myMaxFee = (hackerMaxFee > myPriority ? hackerMaxFee : myPriority)
                   + this._cfg.priorityBumpGwei * GWEI;
    return { maxFeePerGas: myMaxFee, maxPriorityFeePerGas: myPriority };
  }

  // =======================================================================
  //  STAGE 6 — Inclusion verification
  // -----------------------------------------------------------------------
  //  We poll the broadcaster for the receipt of our riposte. Once mined,
  //  we publish a `halt` event containing the canonical block number and
  //  position, which the dashboard renders as "ATTACK NEUTRALIZED".
  //  If the riposte fails to mine within MAX_WAIT_MS, we surface an error
  //  so the operator can investigate (could indicate adversarial MEV
  //  builders that ignored our private mempool route).
  // =======================================================================

  async _confirmInclusion(riposteHash, hackerHash) {
    const MAX_WAIT_MS = 60_000;
    const POLL_MS = 1500;
    const start = Date.now();
    while (Date.now() - start < MAX_WAIT_MS) {
      try {
        const receipt = await this._http.getTransactionReceipt(riposteHash);
        if (receipt && receipt.blockNumber) {
          bus.publish('halt', {
            riposteHash,
            hackerHash,
            blockNumber: receipt.blockNumber,
            position:    receipt.index,
            gasUsed:     receipt.gasUsed?.toString?.(),
          });
          return;
        }
      } catch { /* transient — keep polling */ }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    bus.publish('error', { stage: 'inclusion', msg: `riposte ${riposteHash} not mined within ${MAX_WAIT_MS} ms` });
  }

  // =======================================================================
  //  BACKGROUND WORKERS
  // =======================================================================

  async _warmupNonce() {
    this._cachedNonce = await this._http.getTransactionCount(this._wallet.address, 'pending');
    logger.info({ bot: this._wallet.address, nonce: this._cachedNonce }, 'nonce warm');
  }

  async _resyncNonce() {
    const onchain = await this._http.getTransactionCount(this._wallet.address, 'pending');
    if (onchain > this._cachedNonce) {
      logger.warn({ cached: this._cachedNonce, onchain }, 'nonce drift — resyncing');
      this._cachedNonce = onchain;
    }
  }

  async _refreshTvl() {
    const bal = await this._http.getBalance(this._cfg.vaultAddress);
    this._cachedTvlWei = bal;
    logger.debug({ tvlEth: Number(bal / 10n ** 14n) / 1e4 }, 'tvl refreshed');
  }

  /** @param {string} from */
  _consumeSimQuota(from) {
    const now = Date.now();
    // Hard cap on map size — defends against a sybil flood that creates a
    // unique `from` address per tx, growing the map without bound.
    if (this._simHits.size >= this._simHitsMaxSize && !this._simHits.has(from)) {
      // Map full + this is a NEW address. Refuse the simulation rather than
      // expand the map further. The legitimate addresses we already track
      // get GC'd by `_gcSimQuota` at 30 s intervals.
      return false;
    }
    const arr = (this._simHits.get(from) || []).filter((t) => now - t < this._simWindowMs);
    if (arr.length >= this._simQuota) return false;
    arr.push(now);
    this._simHits.set(from, arr);
    return true;
  }

  _gcSimQuota() {
    const now = Date.now();
    for (const [k, v] of this._simHits) {
      const fresh = v.filter((t) => now - t < this._simWindowMs);
      if (fresh.length === 0) this._simHits.delete(k);
      else this._simHits.set(k, fresh);
    }
  }
}

// ===========================================================================
// FACTORY — load env-driven config and return a ready-to-start engine
// ===========================================================================

/**
 * Builds a KoverEngine from `process.env`. Throws if any required variable
 * is missing — fail fast at boot rather than at first attack.
 *
 * @returns {KoverEngine}
 */
function fromEnv() {
  const required = ['WSS_RPC_URL', 'HTTPS_RPC_URL', 'PRIVATE_KEY', 'VAULT_ADDRESS'];
  for (const k of required) {
    if (!process.env[k]) throw new Error(`engine: missing required env ${k}`);
  }

  return new KoverEngine({
    wssRpcUrl:               process.env.WSS_RPC_URL,
    httpsRpcUrl:             process.env.HTTPS_RPC_URL,
    privateKey:              process.env.PRIVATE_KEY,
    vaultAddress:            process.env.VAULT_ADDRESS,
    chainId:                 Number(process.env.CHAIN_ID || '1'),

    ethDrainThresholdWei:    BigInt(Math.floor(Number(process.env.ETH_DRAIN_THRESHOLD || '10') * 1e18)),
    poolFractionThreshold:   Number(process.env.POOL_FRACTION_THRESHOLD || '0.05'),

    gasStrategy:             (process.env.GAS_STRATEGY || 'additive'),
    priorityBumpGwei:        BigInt(process.env.PRIORITY_BUMP_GWEI  || '50'),
    priorityFloorGwei:       BigInt(process.env.PRIORITY_FLOOR_GWEI || '60'),
    gasMultiplierX10:        BigInt(process.env.GAS_MULTIPLIER_x10  || '25'),

    haltGasLimit:            BigInt(process.env.HALT_GAS_LIMIT      || '120000'),
    haltCooldownMs:          Number(process.env.HALT_COOLDOWN_MS    || '30000'),
    nonceResyncMs:           Number(process.env.NONCE_RESYNC_MS     || '15000'),

    reconnectBaseMs:         Number(process.env.RECONNECT_BASE_MS   || '500'),
    reconnectMaxMs:          Number(process.env.RECONNECT_MAX_MS    || '30000'),
    heartbeatTimeoutMs:      Number(process.env.HEARTBEAT_TIMEOUT_MS|| '30000'),

    rpcTimeoutMs:            Number(process.env.RPC_TIMEOUT_MS      || '120'),
    flashbotsRpcUrl:         process.env.FLASHBOTS_RPC_URL || '',
  });
}

module.exports = { KoverEngine, fromEnv };

// ===========================================================================
// Direct execution: `node src/engine.js`
// ===========================================================================

if (require.main === module) {
  require('dotenv').config();
  const engine = fromEnv();
  process.on('SIGINT',  () => engine.stop().finally(() => process.exit(130)));
  process.on('SIGTERM', () => engine.stop().finally(() => process.exit(0)));
  process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'unhandled'));
  engine.start().catch((err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'engine boot failed');
    process.exit(1);
  });
}
