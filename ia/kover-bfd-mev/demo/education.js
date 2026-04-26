'use strict';

/**
 * Educational callout boxes used between phases of the live demo.
 * Each entry follows the same structure:
 *   - id     : stable key for ordering
 *   - title  : short header (≤ 60 chars)
 *   - body   : array of paragraph strings (lines auto-wrap)
 *   - link   : optional reference / further reading
 *
 * The narrative arc:
 *   1. why mempool monitoring matters
 *   2. why a pre-filter is mandatory
 *   3. why we run EVM simulation
 *   4. why we sum vault outflow recursively
 *   5. why we bump priority + 50 gwei
 *   6. why we keep a priority floor
 *   7. why Flashbots Protect for the riposte
 *   8. why we cool down halts
 *   9. why we use custom errors
 *  10. why we delay bot rotation
 */

const TOPICS = Object.freeze({
  mempool: {
    title: 'WHY MONITOR THE MEMPOOL?',
    body: [
      'A flashloan exploit is ATOMIC — once mined, the funds are gone in the',
      'same block. The on-chain "circuit breaker" cannot trigger after the',
      'fact: we must intercept the malicious tx BEFORE it is included.',
      '',
      'The public mempool is the only attack-window we have, ≈ 12 seconds',
      'between propagation and block inclusion. Every millisecond of latency',
      'in our pipeline directly shrinks our riposte window.',
    ],
  },

  prefilter: {
    title: 'WHY A PRE-FILTER BEFORE SIMULATION?',
    body: [
      'Mainnet processes 250-500 pending tx per second. Running an EVM',
      'simulation (debug_traceCall) on each one would cost > 200 ms × 500 =',
      '100 seconds of compute per real second. Impossible.',
      '',
      'The pre-filter is two O(1) hash-set lookups (provider address + 4-byte',
      'selector) plus one substring search of the vault address in calldata.',
      'It runs in ~ 0.1 ms and discards ~ 99 % of traffic before we spend',
      'a single RPC call on simulation.',
    ],
  },

  simulation: {
    title: 'WHY EVM SIMULATION (debug_traceCall)?',
    body: [
      'A flashloan tx that ATTACKS our vault looks identical, by selector,',
      'to a flashloan tx that legitimately uses Aave for arbitrage. The',
      'pre-filter cannot tell them apart — only EXECUTING the tx reveals',
      'the value flows.',
      '',
      'debug_traceCall replays the tx against the latest state without',
      'broadcasting it, returns the full call tree, and lets us measure',
      'EXACTLY how much value would leave our vault. Zero economic risk.',
      '',
      'stateOverrides pin the attacker balance to 2^104 wei so they cannot',
      'orchestrate an artificial revert to hide intent.',
    ],
  },

  outflow: {
    title: 'WHY SUM ONLY from = VAULT CALLS?',
    body: [
      'We do NOT care about funds entering our vault, only funds LEAVING.',
      'The malicious callback pivots through the vault and issues internal',
      'CALLs whose `from` field equals our address.',
      '',
      'Walking the trace tree recursively and summing those CALLs gives us',
      'the exact native-ETH outflow that would occur — independent of the',
      'attacker contract structure or how cleverly they nest the pivot.',
    ],
  },

  gaswar: {
    title: 'WHY +50 GWEI PRIORITY?',
    body: [
      'Block builders order pending tx by maxPriorityFeePerGas (descending).',
      'To be included BEFORE the attacker, our halt must offer strictly',
      'more priority than theirs.',
      '',
      'A flat +50 gwei bump is enough to outbid any reasonable attacker',
      'and survive the natural variance of the global searcher pool. We',
      'avoid multiplicative bumps (× 1.5) because a malicious attacker could',
      'sign at 10 000 gwei to make our riposte explode in cost — a flat',
      'additive bump bounds the worst-case fee to a known constant.',
    ],
  },

  floor: {
    title: 'WHY A 60 GWEI PRIORITY FLOOR?',
    body: [
      'A subtle attack: the attacker signs at 1 gwei priority knowing that',
      'naive bots will only bump by +50, leaving the attacker around 51 gwei',
      'and STILL competitive against the broader pool.',
      '',
      'A floor of 60 gwei means we ALWAYS beat the global mainnet searcher',
      'pool, not just the specific attacker. Defense in depth.',
    ],
  },

  flashbots: {
    title: 'WHY BROADCAST VIA FLASHBOTS PROTECT?',
    body: [
      'If we send the halt to the public mempool, OTHER searchers see it',
      'and may attempt to back-run our halt to extract MEV from the now-',
      'paused vault state, or even bribe a builder to reorder.',
      '',
      'A private mempool relay (Flashbots Protect, MEV-Share) delivers the',
      'tx directly to honest builders without ever exposing it publicly.',
      'No public propagation, no copycats, no front-running of the protector.',
    ],
  },

  cooldown: {
    title: 'WHY A 30 SECOND COOLDOWN?',
    body: [
      'During chain reorgs (1-2 blocks), our halt may briefly disappear',
      'from the canonical chain. Without a cooldown, the sentinel would',
      'detect the same attack again and re-fire — wasting gas, depleting',
      'the bot key, and emitting duplicate forensics events.',
      '',
      'A 30 second in-process lock guarantees one halt per attack window,',
      'while still allowing genuine new attacks to fire as soon as the',
      'cooldown expires.',
    ],
  },

  customErrors: {
    title: 'WHY CUSTOM ERRORS IN SOLIDITY 0.8.20?',
    body: [
      '`error Unauthorized()` reverts in ~ 50 gas vs ~ 100-150 gas for an',
      'equivalent require-string. In a gas-war scenario, every avoidable',
      'gas unit makes our halt cheaper to include — improving inclusion',
      'odds when builders are at capacity.',
      '',
      'Custom errors also surface clean ABI-decoded reasons in forensics',
      'tools without parsing free-form strings.',
    ],
  },

  rotation: {
    title: 'WHY A 6-HOUR ROTATION DELAY ON THE BOT KEY?',
    body: [
      'If the owner private key gets compromised, the attacker first move',
      'is to call rotateSecurityBot(attackerEOA) — neutralising the',
      'circuit-breaker before draining the vault.',
      '',
      'The 6-hour delay between two rotations means a compromised owner',
      'cannot instantly disarm protection. The team has 6 hours of',
      'on-chain visibility (event Resumed / SecurityBotRotated) to react,',
      'transfer ownership to a fresh multisig, or pause the contract.',
    ],
  },
});

module.exports = { TOPICS };
