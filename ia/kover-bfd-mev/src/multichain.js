'use strict';

/**
 * KOVER.IA — Multi-Chain Mempool Bridge
 * ===========================================================================
 *
 * Spins up one mempool listener per chain in parallel, all feeding the
 * same in-process event bus. Each `pending` event is tagged with its
 * source chain so the dashboard can group / colour / filter by network.
 *
 * Resilience
 * ----------
 *   - One WSS provider per chain — if Polygon's RPC dies, Ethereum keeps
 *     running.
 *   - Per-chain exponential backoff reconnect (cap 30 s, jitter ±250 ms).
 *   - Per-chain heartbeat watchdog: 60 s of mempool silence forces a
 *     reconnect (chains with low mempool throughput need a longer window
 *     than the single-chain default).
 *   - Bounded fetch — `txFetchStride` controls how many real `getTransaction`
 *     calls we make. Free-tier public RPCs WILL rate-limit aggressive
 *     fetching, so we sample by default.
 *
 * Cost on free public RPCs
 * ------------------------
 *   Subscribing to `pending` is free; fetching tx bodies is what costs
 *   request quota. With `txFetchStride=20` (default), we hit each chain's
 *   RPC ~ once per 20 mempool events — well under any free-tier limit.
 *
 * @module    src/multichain
 * @author    KOVER.IA platform team
 * @license   Proprietary
 */

const { WebSocketProvider, JsonRpcProvider } = require('ethers');
const bus = require('./eventBus');
const { logger } = require('./logger');
const { FLASHLOAN_PROVIDERS, FLASHLOAN_SELECTORS } = require('./constants');
const { CHAIN_IDS, PUBLIC_RPC } = require('./defi_registry');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TX_FETCH_STRIDE     = Number(process.env.MC_FETCH_STRIDE        || '20');
const RECONNECT_BASE_MS   = Number(process.env.MC_RECONNECT_BASE_MS   || '500');
const RECONNECT_MAX_MS    = Number(process.env.MC_RECONNECT_MAX_MS    || '30000');
const HEARTBEAT_TIMEOUT_MS= Number(process.env.MC_HEARTBEAT_TIMEOUT_MS|| '60000');

/**
 * Comma-separated chain allowlist. Empty = all chains in the registry.
 *   KOVER_CHAINS=ethereum,polygon,arbitrum
 */
const CHAIN_ALLOWLIST = (process.env.KOVER_CHAINS || '').toLowerCase()
  .split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// ChainConnection — one instance per active chain
// ---------------------------------------------------------------------------

class ChainConnection {
  constructor(chain, vaultLcSlice) {
    this.chain = chain;
    this.chainId = CHAIN_IDS[chain];
    this.wssUrl = (PUBLIC_RPC[chain]?.wss   || [])[0];
    this.httpUrl= (PUBLIC_RPC[chain]?.https || [])[0];
    this.vaultLcSlice = vaultLcSlice;

    this._ws = null;
    this._http = null;
    this._heartbeatTimer = null;
    this._reconnectAttempt = 0;
    this._shutdown = false;

    this.stats = {
      chain,
      chainId: this.chainId,
      pendingObserved: 0,
      candidatesFound: 0,
      bodiesFetched: 0,
      reconnects: 0,
      lastEventAt: 0,
      connected: false,
    };
  }

  async start() {
    if (!this.wssUrl || !this.httpUrl) {
      logger.warn({ chain: this.chain }, '[multichain] no RPC endpoint — skipping');
      return;
    }
    await this._connect();
  }

  async stop() {
    this._shutdown = true;
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    try { if (this._ws) await this._ws.destroy(); } catch { /* ignore */ }
  }

  async _connect() {
    if (this._shutdown) return;
    try {
      this._ws = new WebSocketProvider(this.wssUrl, this.chainId, { staticNetwork: true });
      this._http = new JsonRpcProvider(this.httpUrl, this.chainId, { staticNetwork: true });

      // ethers v6 surfaces socket-level events on the underlying ws.
      const sock = this._ws.websocket;
      sock?.once?.('error', (err) => {
        logger.warn({ chain: this.chain, err: err.message }, '[multichain] ws error');
        this._scheduleReconnect();
      });
      sock?.once?.('close', () => {
        if (!this._shutdown) {
          logger.warn({ chain: this.chain }, '[multichain] ws closed');
          this._scheduleReconnect();
        }
      });

      this._ws.on('pending', (hash) => this._onPending(hash));

      this.stats.connected = true;
      this._reconnectAttempt = 0;
      this._bumpHeartbeat();
      logger.info({ chain: this.chain, chainId: this.chainId },
        '[multichain] subscribed to mempool');
    } catch (err) {
      logger.error({ chain: this.chain, err: err.message }, '[multichain] connect failed');
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._shutdown) return;
    this.stats.connected = false;
    this.stats.reconnects += 1;

    if (this._ws) {
      try { this._ws.removeAllListeners(); this._ws.destroy(); } catch { /* ignore */ }
      this._ws = null;
    }
    const exp = Math.min(RECONNECT_BASE_MS * 2 ** this._reconnectAttempt, RECONNECT_MAX_MS);
    const delay = exp + Math.floor(Math.random() * 250);
    this._reconnectAttempt += 1;
    setTimeout(() => this._connect(), delay);
  }

  _bumpHeartbeat() {
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = setTimeout(() => {
      logger.warn({ chain: this.chain }, '[multichain] heartbeat timeout');
      this._scheduleReconnect();
    }, HEARTBEAT_TIMEOUT_MS).unref();
  }

  async _onPending(hash) {
    this._bumpHeartbeat();
    this.stats.pendingObserved += 1;
    this.stats.lastEventAt = Date.now();

    bus.publish('pending', { hash, chain: this.chain, chainId: this.chainId });

    // Sample to limit RPC fetch load. Free-tier public RPCs are not
    // generous, so we keep this conservative by default.
    if (this.stats.pendingObserved % TX_FETCH_STRIDE !== 0) return;

    let tx;
    try { tx = await this._http.getTransaction(hash); }
    catch (_) { return; }
    if (!tx || !tx.to || !tx.data) return;
    this.stats.bodiesFetched += 1;

    const reasons = this._isFlashloanCandidate(tx);
    if (reasons.length === 0) return;
    this.stats.candidatesFound += 1;

    bus.publish('candidate', {
      hash, chain: this.chain, chainId: this.chainId,
      from: tx.from, to: tx.to,
      selector: tx.data.slice(0, 10),
      reasons,
    });
  }

  _isFlashloanCandidate(tx) {
    const to  = tx.to.toLowerCase();
    const sel = tx.data.slice(0, 10).toLowerCase();
    const reasons = [];
    if (FLASHLOAN_PROVIDERS.has(to))      reasons.push('to ∈ flashloan_providers');
    if (FLASHLOAN_SELECTORS.has(sel))     reasons.push(`selector ${sel}`);
    if (this.vaultLcSlice && tx.data.toLowerCase().includes(this.vaultLcSlice)) {
      reasons.push('vault address in calldata');
    }
    return reasons;
  }
}

// ---------------------------------------------------------------------------
// MultiChainBridge — orchestrator
// ---------------------------------------------------------------------------

class MultiChainBridge {
  constructor() {
    /** @type {ChainConnection[]} */
    this._chains = [];
    this._statsTimer = null;
  }

  /**
   * Determines which chains to activate. If KOVER_CHAINS is set, only those
   * chains are spun up. Otherwise every chain with a public RPC entry is
   * activated.
   */
  _resolveChains() {
    const all = Object.keys(CHAIN_IDS).filter((c) => PUBLIC_RPC[c]);
    if (CHAIN_ALLOWLIST.length === 0) return all;
    return all.filter((c) => CHAIN_ALLOWLIST.includes(c));
  }

  async start() {
    const chains = this._resolveChains();
    const vaultLcSlice = (process.env.VAULT_ADDRESS || '').slice(2).toLowerCase() || null;

    logger.info({
      chains,
      txFetchStride: TX_FETCH_STRIDE,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    }, '[multichain] booting bridges');

    for (const c of chains) {
      const conn = new ChainConnection(c, vaultLcSlice);
      this._chains.push(conn);
      // Don't await — connections happen in parallel.
      conn.start().catch((err) =>
        logger.error({ chain: c, err: err.message }, '[multichain] start failed'));
    }

    // 1-Hz aggregated stats fan-out for the dashboard.
    this._statsTimer = setInterval(() => this._publishStats(), 1000).unref();
  }

  async stop() {
    if (this._statsTimer) clearInterval(this._statsTimer);
    await Promise.all(this._chains.map((c) => c.stop()));
  }

  _publishStats() {
    const perChain = this._chains.map((c) => c.stats);
    const totals = perChain.reduce((acc, s) => ({
      activeChains:  acc.activeChains  + (s.connected ? 1 : 0),
      pendingObserved: acc.pendingObserved + s.pendingObserved,
      candidatesFound: acc.candidatesFound + s.candidatesFound,
      bodiesFetched:   acc.bodiesFetched   + s.bodiesFetched,
    }), { activeChains: 0, pendingObserved: 0, candidatesFound: 0, bodiesFetched: 0 });

    bus.publish('multichain', {
      chainCount: this._chains.length,
      activeChains: totals.activeChains,
      totals,
      perChain,
    });
  }
}

module.exports = { MultiChainBridge, ChainConnection };
