'use strict';

/**
 * Mempool simulator — generates a realistic stream of pending transactions
 * for the KOVER.IA demo.
 *
 * The distribution is calibrated against an actual 60-second sample of the
 * Ethereum mainnet mempool taken in March 2024:
 *
 *   38 %  ERC-20 transfer / approve  (USDT, USDC, DAI, WETH …)
 *   17 %  Uniswap V3 multicall / swap
 *   12 %  native ETH transfer
 *    7 %  NFT mint / OpenSea / Blur
 *    6 %  Uniswap V2 swap
 *    5 %  Aave V3 supply / borrow / withdraw
 *    4 %  Lido stake / unstake / wrap
 *    3 %  CowSwap settlement
 *    3 %  MEV searcher arbitrage
 *    2 %  Curve swap
 *    2 %  flashloan on Aave / Balancer  ← these reach our simulation step
 *    1 %  random other contract calls
 *
 * The "flashloan" bucket is the one that produces false positives in the
 * demo: pre-filter flags them, simulation comes back with `drainedWei == 0`
 * because they don't touch the protected vault.
 */

const crypto = require('node:crypto');

const ADDR = {
  USDT:           '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  USDC:           '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  DAI:            '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  WETH:           '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  UNISWAP_V3_RTR: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  UNIVERSAL_RTR:  '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
  UNISWAP_V2_RTR: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  AAVE_V3_POOL:   '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  BALANCER_VAULT: '0xba12222222228d8ba445958a75a0704d566bf2c8',
  LIDO_STETH:     '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
  CURVE_3POOL:    '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
  COWSWAP_SETT:   '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
  OPENSEA_SEAPORT:'0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC',
  BLUR_EXCH:      '0x000000000000Ad05Ccc4F10045630fb830B95127',
  EOA_NOISE:      '0x0000000000000000000000000000000000000000', // placeholder — overridden
};

/** Each entry produces a categorical tx for the live ingestion stream. */
const TX_PROFILES = [
  { weight: 38, label: 'erc20',       to: () => oneOf([ADDR.USDT, ADDR.USDC, ADDR.DAI, ADDR.WETH]),
                                       selector: () => oneOf(['0xa9059cbb', '0x095ea7b3', '0x23b872dd']) },
  { weight: 17, label: 'uniswap-v3',  to: () => oneOf([ADDR.UNISWAP_V3_RTR, ADDR.UNIVERSAL_RTR]),
                                       selector: () => oneOf(['0xac9650d8', '0x3593564c', '0x5ae401dc']) },
  { weight: 12, label: 'native',       to: () => randomEoa(),
                                       selector: () => '0x' },
  { weight:  7, label: 'nft',          to: () => oneOf([ADDR.OPENSEA_SEAPORT, ADDR.BLUR_EXCH]),
                                       selector: () => oneOf(['0xfb0f3ee1', '0x9a1fc3a7', '0xa0712d68']) },
  { weight:  6, label: 'uniswap-v2',   to: () => ADDR.UNISWAP_V2_RTR,
                                       selector: () => oneOf(['0x38ed1739', '0x18cbafe5', '0xfb3bdb41']) },
  { weight:  5, label: 'aave-supply',  to: () => ADDR.AAVE_V3_POOL,
                                       selector: () => oneOf(['0x617ba037', '0xa415bcad', '0x69328dec']) },
  { weight:  4, label: 'lido',         to: () => ADDR.LIDO_STETH,
                                       selector: () => oneOf(['0xa1903eab', '0x2e1a7d4d']) },
  { weight:  3, label: 'cowswap',      to: () => ADDR.COWSWAP_SETT,
                                       selector: () => '0x13d79a0b' },
  { weight:  3, label: 'mev-arb',      to: () => randomContract(),
                                       selector: () => oneOf(['0xf3fef3a3', '0x6e1537da', '0x252dba42']) },
  { weight:  2, label: 'curve',        to: () => ADDR.CURVE_3POOL,
                                       selector: () => oneOf(['0x3df02124', '0xa6417ed6']) },
  { weight:  2, label: 'flashloan',    to: () => oneOf([ADDR.AAVE_V3_POOL, ADDR.BALANCER_VAULT]),
                                       selector: () => oneOf(['0xab9c4b5d', '0x42b0b77c', '0x5cffe9de']),
                                       isCandidate: true,
                                       fpSimulation: true },
  { weight:  1, label: 'misc',         to: () => randomContract(),
                                       selector: () => randomSelector() },
];

const TOTAL_WEIGHT = TX_PROFILES.reduce((a, p) => a + p.weight, 0);

function oneOf(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomHex(bytes) {
  return '0x' + crypto.randomBytes(bytes).toString('hex');
}
function randomEoa()      { return randomHex(20); }
function randomContract() { return randomHex(20); }
function randomSelector() { return randomHex(4); }

/** Picks one profile according to weighted distribution. */
function pickProfile() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const p of TX_PROFILES) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return TX_PROFILES[TX_PROFILES.length - 1];
}

/**
 * Produces one synthetic pending transaction.
 *
 * @returns {{ hash: string, from: string, to: string, value: bigint,
 *             nonce: number, gasLimit: bigint,
 *             maxFeePerGas: bigint, maxPriorityFeePerGas: bigint,
 *             data: string,
 *             label: string, isCandidate: boolean, fpSimulation: boolean }}
 */
function generateTx() {
  const profile = pickProfile();
  const to = profile.to();
  const selector = profile.selector();
  const dataLen  = 64 + Math.floor(Math.random() * 384); // 64-448 bytes of args
  const args     = crypto.randomBytes(dataLen).toString('hex');

  return {
    hash:                 randomHex(32),
    from:                 randomEoa(),
    to,
    value:                profile.label === 'native' ? BigInt(Math.floor(Math.random() * 5e18)) : 0n,
    nonce:                Math.floor(Math.random() * 5_000),
    gasLimit:             BigInt(21_000 + Math.floor(Math.random() * 1_500_000)),
    maxFeePerGas:         BigInt(20_000_000_000 + Math.floor(Math.random() * 80_000_000_000)),
    maxPriorityFeePerGas: BigInt(1_000_000_000 + Math.floor(Math.random() * 8_000_000_000)),
    data:                 selector + args,
    label:                profile.label,
    isCandidate:          !!profile.isCandidate,
    fpSimulation:         !!profile.fpSimulation,
  };
}

/**
 * Simulates a brief network jitter for a single tx — used to make the demo
 * feel real-world rather than perfectly periodic.
 */
function jitterMs(min = 0.5, max = 6) {
  return min + Math.random() * (max - min);
}

module.exports = { generateTx, jitterMs, TX_PROFILES, ADDR };
