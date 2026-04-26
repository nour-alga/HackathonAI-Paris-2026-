'use strict';

/**
 * KOVER.IA — DeFi Protocol Registry
 * ===========================================================================
 *
 * Single source of truth for every smart-contract address and 4-byte selector
 * KOVER monitors. Scoped by chain so the engine can subscribe to multiple
 * mempools simultaneously and apply the right filter set per chain.
 *
 * What's included
 * ---------------
 *   - Flashloan providers — every contract that exposes a `flashLoan`-style
 *     entrypoint, on every chain where DeFi has measurable TVL.
 *   - Lending pools — Aave, Compound, Morpho, Spark, Radiant, Granary, …
 *   - DEX routers — Uniswap V2/V3/V4, SushiSwap, Curve, Balancer, PancakeSwap.
 *   - Yield vaults — Yearn V3, Convex, Lido.
 *
 * Each entry: protocol name · chain · address · type · notes.
 * All addresses are LOWERCASE by convention so `Set.has()` is comparison-safe
 * once `tx.to` has also been lowercased by the engine.
 *
 * Provenance
 * ----------
 *   Addresses sourced from:
 *     - Official protocol docs (Aave, Balancer, Maker, Compound, …)
 *     - https://docs.aave.com/developers/deployed-contracts
 *     - https://etherscan.io/labelcloud (verified protocol labels)
 *     - https://defillama.com (chain coverage)
 *
 *   Cross-checked against chain explorers as of 2026-04-25. Addresses are
 *   immutable once deployed, but new chains/versions appear constantly —
 *   this list is meant to be PR'd, not frozen.
 *
 * @module    src/defi_registry
 * @author    KOVER.IA platform team
 * @license   Proprietary
 */

// ---------------------------------------------------------------------------
// Chain metadata
// ---------------------------------------------------------------------------

const CHAIN_IDS = Object.freeze({
  ethereum:  1,
  optimism:  10,
  bnb:       56,
  gnosis:    100,
  polygon:   137,
  fantom:    250,
  base:      8453,
  arbitrum:  42161,
  avalanche: 43114,
  linea:     59144,
  scroll:    534352,
  blast:     81457,
});

/**
 * Public RPC endpoints (free tier). Replace with QuickNode / Alchemy /
 * Infura paid endpoints in production for low-latency mempool subscription.
 * Order = priority (first one is the default).
 */
const PUBLIC_RPC = Object.freeze({
  ethereum: {
    https: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'],
    wss:   ['wss://ethereum-rpc.publicnode.com',   'wss://mainnet.gateway.tenderly.co'],
  },
  optimism: {
    https: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
    wss:   ['wss://optimism-rpc.publicnode.com'],
  },
  bnb: {
    https: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'],
    wss:   ['wss://bsc-rpc.publicnode.com'],
  },
  polygon: {
    https: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
    wss:   ['wss://polygon-bor-rpc.publicnode.com'],
  },
  arbitrum: {
    https: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    wss:   ['wss://arbitrum-one-rpc.publicnode.com'],
  },
  base: {
    https: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    wss:   ['wss://base-rpc.publicnode.com'],
  },
  avalanche: {
    https: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
    wss:   ['wss://avalanche-c-chain-rpc.publicnode.com'],
  },
  gnosis: {
    https: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com'],
    wss:   ['wss://gnosis-rpc.publicnode.com'],
  },
  fantom: {
    https: ['https://fantom-rpc.publicnode.com', 'https://rpc.ftm.tools'],
    wss:   ['wss://fantom-rpc.publicnode.com'],
  },
  linea: {
    https: ['https://linea-rpc.publicnode.com', 'https://rpc.linea.build'],
    wss:   ['wss://linea-rpc.publicnode.com'],
  },
  scroll: {
    https: ['https://scroll-rpc.publicnode.com', 'https://rpc.scroll.io'],
    wss:   ['wss://scroll-rpc.publicnode.com'],
  },
  blast: {
    https: ['https://blast-rpc.publicnode.com', 'https://rpc.blast.io'],
    wss:   ['wss://blast-rpc.publicnode.com'],
  },
});

// ---------------------------------------------------------------------------
// Flashloan providers — primary KOVER target set
// ---------------------------------------------------------------------------

const FLASHLOAN_PROVIDERS = Object.freeze([
  // ---- Aave V3 (the dominant flashloan provider on every chain) ----
  { protocol: 'aave-v3', chain: 'ethereum',  addr: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', type: 'lending+flashloan' },
  { protocol: 'aave-v3', chain: 'polygon',   addr: '0x794a61358d6845594f94dc1db02a252b5b4814ad', type: 'lending+flashloan' },
  { protocol: 'aave-v3', chain: 'arbitrum',  addr: '0x794a61358d6845594f94dc1db02a252b5b4814ad', type: 'lending+flashloan' },
  { protocol: 'aave-v3', chain: 'optimism',  addr: '0x794a61358d6845594f94dc1db02a252b5b4814ad', type: 'lending+flashloan' },
  { protocol: 'aave-v3', chain: 'base',      addr: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5', type: 'lending+flashloan' },
  { protocol: 'aave-v3', chain: 'avalanche', addr: '0x794a61358d6845594f94dc1db02a252b5b4814ad', type: 'lending+flashloan' },
  { protocol: 'aave-v3', chain: 'bnb',       addr: '0x6807dc923806fe8fd134338eabca509979a7e0cb', type: 'lending+flashloan' },
  { protocol: 'aave-v3', chain: 'gnosis',    addr: '0xb50201558b00496a145fe76f7424749556e326d8', type: 'lending+flashloan' },
  { protocol: 'aave-v3', chain: 'scroll',    addr: '0x11fcfe756c05ad438e312a7fd934381537d3cffe', type: 'lending+flashloan' },
  { protocol: 'aave-v3', chain: 'fantom',    addr: '0x794a61358d6845594f94dc1db02a252b5b4814ad', type: 'lending+flashloan' },

  // ---- Aave V2 (legacy but still active) ----
  { protocol: 'aave-v2', chain: 'ethereum',  addr: '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9', type: 'lending+flashloan' },
  { protocol: 'aave-v2', chain: 'polygon',   addr: '0x8dff5e27ea6b7ac08ebfdf9eb090f32ee9a30fcf', type: 'lending+flashloan' },
  { protocol: 'aave-v2', chain: 'avalanche', addr: '0x4f01aed16d97e3ab5ab2b501154dc9bb0f1a5a2c', type: 'lending+flashloan' },

  // ---- Balancer V2 (every flashloan free of fee — main MEV target) ----
  { protocol: 'balancer-v2', chain: 'ethereum',  addr: '0xba12222222228d8ba445958a75a0704d566bf2c8', type: 'dex+flashloan' },
  { protocol: 'balancer-v2', chain: 'polygon',   addr: '0xba12222222228d8ba445958a75a0704d566bf2c8', type: 'dex+flashloan' },
  { protocol: 'balancer-v2', chain: 'arbitrum',  addr: '0xba12222222228d8ba445958a75a0704d566bf2c8', type: 'dex+flashloan' },
  { protocol: 'balancer-v2', chain: 'optimism',  addr: '0xba12222222228d8ba445958a75a0704d566bf2c8', type: 'dex+flashloan' },
  { protocol: 'balancer-v2', chain: 'base',      addr: '0xba12222222228d8ba445958a75a0704d566bf2c8', type: 'dex+flashloan' },
  { protocol: 'balancer-v2', chain: 'gnosis',    addr: '0xba12222222228d8ba445958a75a0704d566bf2c8', type: 'dex+flashloan' },

  // ---- MakerDAO DSS Flash ----
  { protocol: 'maker-dss-flash', chain: 'ethereum', addr: '0x60744434d6339a6b27d73d9eda62b6f66a0a04fa', type: 'flashloan' },

  // ---- dYdX (Solo Margin, deprecated but still serves flash) ----
  { protocol: 'dydx-solo', chain: 'ethereum', addr: '0x1e0447b19bb6ecfdae1e4ae1694b0c3659614e4e', type: 'flashloan' },

  // ---- Uniswap V3 (every pool exposes flash() — too many to enum, so we
  //      tag the factory and the engine recognises pools via Factory address) ----
  { protocol: 'uniswap-v3-factory', chain: 'ethereum', addr: '0x1f98431c8ad98523631ae4a59f267346ea31f984', type: 'dex-factory' },
  { protocol: 'uniswap-v3-factory', chain: 'polygon',  addr: '0x1f98431c8ad98523631ae4a59f267346ea31f984', type: 'dex-factory' },
  { protocol: 'uniswap-v3-factory', chain: 'arbitrum', addr: '0x1f98431c8ad98523631ae4a59f267346ea31f984', type: 'dex-factory' },
  { protocol: 'uniswap-v3-factory', chain: 'optimism', addr: '0x1f98431c8ad98523631ae4a59f267346ea31f984', type: 'dex-factory' },
  { protocol: 'uniswap-v3-factory', chain: 'base',     addr: '0x33128a8fc17869897dce68ed026d694621f6fdfd', type: 'dex-factory' },

  // ---- Morpho Blue (oracle-less lending, flashloan-capable) ----
  { protocol: 'morpho-blue', chain: 'ethereum', addr: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', type: 'lending+flashloan' },
  { protocol: 'morpho-blue', chain: 'base',     addr: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', type: 'lending+flashloan' },

  // ---- Spark Lend (Aave fork, MakerDAO ecosystem) ----
  { protocol: 'spark-lend', chain: 'ethereum', addr: '0xc13e21b648a5ee794902342038ff3adab66be987', type: 'lending+flashloan' },
  { protocol: 'spark-lend', chain: 'gnosis',   addr: '0x2dae5307c5e3fd1cf5a72cb6f698f915860607e0', type: 'lending+flashloan' },

  // ---- Radiant Capital (cross-chain, BNB + Arbitrum) ----
  { protocol: 'radiant-v2', chain: 'arbitrum', addr: '0xf4b1486dd74d07706052a33d31d7c0aafd0659e1', type: 'lending+flashloan' },
  { protocol: 'radiant-v2', chain: 'bnb',      addr: '0xd50cf00b6e600dd036ba8ef475677d816d6c4281', type: 'lending+flashloan' },

  // ---- Granary Finance (Aave fork) ----
  { protocol: 'granary', chain: 'arbitrum',  addr: '0x9b9c9bcd6bd34019e9da6708b4dc3a13f5e9dec5', type: 'lending+flashloan' },
  { protocol: 'granary', chain: 'optimism',  addr: '0x4f4d34c4ca5d2dc7ba4ea4d8e51ed30db7a98a44', type: 'lending+flashloan' },

  // ---- Compound V3 (Comet) ----
  { protocol: 'compound-v3', chain: 'ethereum', addr: '0xc3d688b66703497daa19211eedff47f25384cdc3', type: 'lending' },
  { protocol: 'compound-v3', chain: 'polygon',  addr: '0xf25212e676d1f7f89cd72ffee66158f541246445', type: 'lending' },
  { protocol: 'compound-v3', chain: 'arbitrum', addr: '0xa5edbdd9646f8dff606d7448e414884c7d905dca', type: 'lending' },
  { protocol: 'compound-v3', chain: 'base',     addr: '0xb125e6687d4313864e53df431d5425969c15eb2f', type: 'lending' },
]);

// ---------------------------------------------------------------------------
// DEX routers — frequently traversed by flashloan attackers for swaps
// ---------------------------------------------------------------------------

const DEX_ROUTERS = Object.freeze([
  // Uniswap
  { protocol: 'uniswap-v2-router02',     chain: 'ethereum', addr: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', type: 'dex' },
  { protocol: 'uniswap-v3-swap-router',  chain: 'ethereum', addr: '0xe592427a0aece92de3edee1f18e0157c05861564', type: 'dex' },
  { protocol: 'uniswap-v3-swap-router02',chain: 'ethereum', addr: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', type: 'dex' },
  { protocol: 'uniswap-universal-router',chain: 'ethereum', addr: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af', type: 'dex' },
  { protocol: 'uniswap-v4-pool-manager', chain: 'ethereum', addr: '0x000000000004444c5dc75cb358380d2e3de08a90', type: 'dex' },

  // SushiSwap
  { protocol: 'sushiswap-v2',  chain: 'ethereum', addr: '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', type: 'dex' },

  // Curve
  { protocol: 'curve-3pool',   chain: 'ethereum', addr: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7', type: 'dex' },
  { protocol: 'curve-router',  chain: 'ethereum', addr: '0x99a58482bd75cbab83b27ec03ca68ff489b5788f', type: 'dex' },

  // PancakeSwap (BNB-dominant)
  { protocol: 'pancake-v2',    chain: 'bnb',      addr: '0x10ed43c718714eb63d5aa57b78b54704e256024e', type: 'dex' },
  { protocol: 'pancake-v3',    chain: 'bnb',      addr: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4', type: 'dex' },

  // 1inch / aggregators
  { protocol: '1inch-v5',      chain: 'ethereum', addr: '0x1111111254eeb25477b68fb85ed929f73a960582', type: 'dex-aggregator' },
  { protocol: '1inch-v6',      chain: 'ethereum', addr: '0x111111125421ca6dc452d289314280a0f8842a65', type: 'dex-aggregator' },
  { protocol: 'cowswap',       chain: 'ethereum', addr: '0x9008d19f58aabd9ed0d60971565aa8510560ab41', type: 'dex-aggregator' },
  { protocol: '0x-exchange-proxy', chain: 'ethereum', addr: '0xdef1c0ded9bec7f1a1670819833240f027b25eff', type: 'dex-aggregator' },
]);

// ---------------------------------------------------------------------------
// Yield / staking vaults — high-value KOVER protection candidates
// ---------------------------------------------------------------------------

const YIELD_VAULTS = Object.freeze([
  // Lido
  { protocol: 'lido-stETH',        chain: 'ethereum', addr: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', type: 'lst' },
  { protocol: 'lido-wstETH',       chain: 'ethereum', addr: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', type: 'lst' },
  // Rocket Pool
  { protocol: 'rocketpool-rETH',   chain: 'ethereum', addr: '0xae78736cd615f374d3085123a210448e74fc6393', type: 'lst' },
  // EtherFi
  { protocol: 'etherfi-eETH',      chain: 'ethereum', addr: '0x35fa164735182de50811e8e2e824cfb9b6118ac2', type: 'lst' },
  // Yearn
  { protocol: 'yearn-yvDAI',       chain: 'ethereum', addr: '0xda816459f1ab5631232fe5e97a05bbbb94970c95', type: 'yield' },
  { protocol: 'yearn-yvUSDC',      chain: 'ethereum', addr: '0xa354f35829ae975e850e23e9615b11da1b3dc4de', type: 'yield' },
  // Convex / Curve LP
  { protocol: 'convex-booster',    chain: 'ethereum', addr: '0xf403c135812408bfbe8713b5a23a04b3d48aae31', type: 'yield' },
  // Pendle
  { protocol: 'pendle-router-v4',  chain: 'ethereum', addr: '0x888888888889758f76e7103c6cbf23abbf58f946', type: 'yield' },
  // EigenLayer
  { protocol: 'eigenlayer-strategy-manager', chain: 'ethereum', addr: '0x858646372cc42e1a627fce94aa7a7033e7cf075a', type: 'restaking' },
]);

// ---------------------------------------------------------------------------
// Selectors — flashloan-related 4-byte function signatures
// ---------------------------------------------------------------------------

const FLASHLOAN_SELECTORS = Object.freeze({
  // Aave family
  '0xab9c4b5d': { name: 'flashLoan',         protocol: 'aave-v3' },
  '0x42b0b77c': { name: 'flashLoanSimple',   protocol: 'aave-v3' },

  // Balancer V2
  '0x5cffe9de': { name: 'flashLoan',         protocol: 'balancer-v2' },

  // Maker DSS
  '0x1b11d0ff': { name: 'flash',             protocol: 'maker-dss' },

  // ERC-3156 (universal flashloan standard)
  '0x5cffe9de': { name: 'flashLoan',         protocol: 'erc3156' },

  // Uniswap V3 pool flash
  '0x490e6cbc': { name: 'flash',             protocol: 'uniswap-v3-pool' },

  // dYdX SoloMargin operate
  '0xa67a6a45': { name: 'operate',           protocol: 'dydx-solo' },
});

// ---------------------------------------------------------------------------
// Aggregations — convenient flat sets the engine can consume directly
// ---------------------------------------------------------------------------

/** Flat lowercase Set of every protocol address worth pre-filtering on. */
const PROTOCOL_ADDRESSES_ALL = new Set([
  ...FLASHLOAN_PROVIDERS.map((e) => e.addr),
  ...DEX_ROUTERS.map((e) => e.addr),
  ...YIELD_VAULTS.map((e) => e.addr),
]);

/** Flat lowercase Set of just flashloan-capable contracts (highest priority). */
const FLASHLOAN_ADDRESSES_ALL = new Set(FLASHLOAN_PROVIDERS.map((e) => e.addr));

/** Flat Set of 4-byte selectors. */
const FLASHLOAN_SELECTORS_SET = new Set(Object.keys(FLASHLOAN_SELECTORS));

/** Per-chain index for multi-chain engines. */
const BY_CHAIN = (() => {
  const out = {};
  for (const chain of Object.keys(CHAIN_IDS)) {
    out[chain] = {
      flashloan: FLASHLOAN_PROVIDERS.filter((e) => e.chain === chain).map((e) => e.addr),
      dex:       DEX_ROUTERS.filter((e) => e.chain === chain).map((e) => e.addr),
      vault:     YIELD_VAULTS.filter((e) => e.chain === chain).map((e) => e.addr),
    };
  }
  return Object.freeze(out);
})();

// ---------------------------------------------------------------------------
// Stats / sanity
// ---------------------------------------------------------------------------

const STATS = Object.freeze({
  chains:                 Object.keys(CHAIN_IDS).length,
  flashloanProviders:     FLASHLOAN_PROVIDERS.length,
  dexRouters:             DEX_ROUTERS.length,
  yieldVaults:            YIELD_VAULTS.length,
  uniqueAddresses:        PROTOCOL_ADDRESSES_ALL.size,
  knownFlashloanSelectors:Object.keys(FLASHLOAN_SELECTORS).length,
});

module.exports = {
  CHAIN_IDS,
  PUBLIC_RPC,
  FLASHLOAN_PROVIDERS,
  DEX_ROUTERS,
  YIELD_VAULTS,
  FLASHLOAN_SELECTORS,
  PROTOCOL_ADDRESSES_ALL,
  FLASHLOAN_ADDRESSES_ALL,
  FLASHLOAN_SELECTORS_SET,
  BY_CHAIN,
  STATS,
};
