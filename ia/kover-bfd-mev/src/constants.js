'use strict';

/**
 * Flashloan providers + selectors used in the hot-path pre-filter.
 *
 * These two `Set`s are imported by the engine and tested via O(1) `Set.has()`
 * on every pending tx. Lowercase by convention so `tx.to.toLowerCase()` is
 * comparison-safe.
 *
 * The legacy literals below remain for back-compat with existing tests.
 * The full multi-chain registry is loaded from `./defi_registry` and merged
 * into both sets at module load — see the merge block at the bottom.
 */

const FLASHLOAN_PROVIDERS = new Set([
  // Aave V3 — Pool
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  // Aave V2 — LendingPool
  '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9',
  // Balancer V2 — Vault
  '0xba12222222228d8ba445958a75a0704d566bf2c8',
  // dYdX SoloMargin
  '0x1e0447b19bb6ecfdae1e4ae1694b0c3659614e4e',
  // Uniswap V3 factory (flash() lives on pools, but factory is a useful proxy
  // for downstream resolution if you maintain a pool index)
  '0x1f98431c8ad98523631ae4a59f267346ea31f984',
  // Maker DSS Flash
  '0x60744434d6339a6b27d73d9eda62b6f66a0a04fa',
]);

/**
 * Selectors of common flashloan entry-points. Used to short-circuit the
 * detection before we even look at calldata args.
 *
 *   Aave V3 flashLoan       ─ keccak256("flashLoan(address,address[],uint256[],uint256[],address,bytes,uint16)")[:4]
 *   Aave V3 flashLoanSimple ─ keccak256("flashLoanSimple(address,address,uint256,bytes,uint16)")[:4]
 *   Balancer flashLoan      ─ keccak256("flashLoan(address,address[],uint256[],bytes)")[:4]
 *   Maker DSS flash         ─ keccak256("flash(address,uint256,bytes)")[:4]
 *   ERC-3156 flashLoan      ─ keccak256("flashLoan(address,address,uint256,bytes)")[:4]
 */
const FLASHLOAN_SELECTORS = new Set([
  '0xab9c4b5d', // Aave V3 flashLoan
  '0x42b0b77c', // Aave V3 flashLoanSimple
  '0x5cffe9de', // Balancer flashLoan
  '0x1b11d0ff', // Maker DSS flash
  '0x5cffe9de', // ERC-3156 (collision OK — superset)
]);

/** Minimal Vault ABI used by the riposte. */
const VAULT_ABI = [
  'function emergencyHalt() external',
  'function totalValueLocked() view returns (uint256)',
];

// ---------------------------------------------------------------------------
// MULTI-CHAIN MERGE — pulls every protocol address & selector tracked in
// `defi_registry.js` (Aave V2/V3 across 10 chains, Balancer V2, Compound V3,
// Morpho Blue, Spark, Radiant, Granary, dYdX, Maker DSS, Uniswap V3 factory,
// 4-byte selectors, …) into the hot-path Sets. Result: ~50+ flashloan
// addresses pre-filtered in O(1) on every pending tx without code changes
// elsewhere.
// ---------------------------------------------------------------------------

const registry = require('./defi_registry');
for (const addr of registry.FLASHLOAN_ADDRESSES_ALL) FLASHLOAN_PROVIDERS.add(addr);
for (const sel  of registry.FLASHLOAN_SELECTORS_SET) FLASHLOAN_SELECTORS.add(sel);

module.exports = {
  FLASHLOAN_PROVIDERS,
  FLASHLOAN_SELECTORS,
  VAULT_ABI,
  // Re-exported for callers that want the full structured registry.
  REGISTRY: registry,
};
