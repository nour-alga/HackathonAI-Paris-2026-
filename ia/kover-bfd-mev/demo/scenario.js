'use strict';

/**
 * Realistic flashloan attack scenario, replayable for the demo runner.
 *
 * The attacker's calldata mirrors a real Aave V3 `flashLoan` call where the
 * receiver contract — controlled by the attacker — drains the KOVER vault
 * during the callback before repaying the loan. Numeric fields are crafted
 * so the simulation step yields a deterministic 847.32 ETH outflow.
 */

const { parseEther, toQuantity } = require('ethers');

const TARGETED_VAULT = '0x4f56e6cD4f93C42e74E29bE1937e0fEf8B5c0FB1';
const ATTACKER_EOA   = '0xD3aDb33fcAfe74C0fFEEbeefCAFE0123456789AB';
const AAVE_V3_POOL   = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const VICTIM_VICTIM  = TARGETED_VAULT.slice(2).toLowerCase();

const ATTACK_TX = {
  hash:                 '0xfeed1337c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffee01',
  from:                 ATTACKER_EOA,
  to:                   AAVE_V3_POOL,
  value:                0n,
  nonce:                42,
  gasLimit:             1_500_000n,
  maxFeePerGas:         70_000_000_000n,   // 70 gwei
  maxPriorityFeePerGas: 12_000_000_000n,   // 12 gwei
  // Aave V3 flashLoan(address,address[],uint256[],uint256[],address,bytes,uint16)
  // selector 0xab9c4b5d. The bytes payload references the vault address as a
  // downstream argument so our pre-filter flags it before simulation.
  data:
    '0xab9c4b5d' +
    'd3adb33fcafe74c0ffeebeefcafe0123456789ab'.padStart(64, '0') +    // receiver
    ('00000000000000000000000000000000000000000000000000000000000000e0') +
    ('0000000000000000000000000000000000000000000000000000000000000120') +
    ('0000000000000000000000000000000000000000000000000000000000000160') +
    VICTIM_VICTIM.padStart(64, '0') +                                  // onBehalfOf = vault
    ('00000000000000000000000000000000000000000000000000000000000001a0') +
    '0000',
};

/**
 * Synthetic Geth callTracer trace: the flashloan callback issues a CALL from
 * the vault address with value=847.32 ETH to an attacker-controlled sink.
 */
const SIMULATION_TRACE = {
  type: 'CALL',
  from: ATTACKER_EOA,
  to:   AAVE_V3_POOL,
  value: '0x0',
  gas:  '0x16e360',
  calls: [
    {
      type: 'CALL',
      from: AAVE_V3_POOL,
      to:   '0x' + 'd3adb33f'.padEnd(40, '0'), // attacker receiver
      value: '0x0',
      calls: [
        {
          // The attacker pivots through the vault — this is the malicious leg
          // that we sum: from === VAULT_ADDRESS.
          type: 'CALL',
          from: TARGETED_VAULT.toLowerCase(),
          to:   '0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffee0001',  // sink
          value: toQuantity(parseEther('847.32')), // 847.32 ETH drained from the vault
          calls: [],
        },
      ],
    },
  ],
};

const VAULT_TVL_ETH = 1_205n; // for fraction-of-pool computation

module.exports = {
  TARGETED_VAULT,
  ATTACKER_EOA,
  AAVE_V3_POOL,
  ATTACK_TX,
  SIMULATION_TRACE,
  VAULT_TVL_ETH,
};
