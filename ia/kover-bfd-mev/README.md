# KOVER.IA — Flashloan Sentinel

Production-grade flashloan interception system. Listens to the mempool over
WebSocket, detects suspicious flashloan flows, simulates their impact via
`debug_traceCall` with state override, and broadcasts a defensive
`emergencyHalt()` transaction with aggressive EIP-1559 fees to win the gas war.

## Layout

| File | Role |
| ---- | ---- |
| `contracts/Vault.sol`     | Pausable vault with `emergencyHalt()` + custom errors |
| `src/sentinel.js`         | Mempool listener + flashloan detection + simulation |
| `src/flashrun.js`         | Pre-built halt tx + gas-war broadcaster |
| `src/constants.js`        | Flashloan provider addresses + 4-byte selectors |
| `src/logger.js`           | pino logger + ms-precision timeline tracker |

## Latency budget (target < 100 ms)

```
[reception]     pending event arrives
[fetched]       getTransaction        +5–20 ms
[candidate]     selector / addr match +0.1 ms
[simulated]     debug_traceCall       +30–80 ms
[signed]        local signing         +5 ms
[broadcast]     eth_sendRawTransaction +10–30 ms
```

Each stage is logged via `newTimeline()` with both `sinceLastMs` and
`sinceStartMs` for post-mortem analysis.

## Quickstart

```bash
cp .env.example .env   # fill in WSS, HTTPS, PRIVATE_KEY, VAULT_ADDRESS
npm install
npm start
```

## Deploy the Vault (Foundry)

```bash
forge create contracts/Vault.sol:Vault \
  --rpc-url $HTTPS_RPC_URL --private-key $OWNER_KEY \
  --constructor-args $BOT_ADDRESS
```

## Detection logic

1. **Pre-filter** (O(1)): `tx.to` ∈ known flashloan providers (Aave V3/V2,
   Balancer V2, dYdX, Maker DSS), or 4-byte selector ∈ flashloan signatures,
   or vault address appears anywhere in calldata.
2. **Simulate**: `debug_traceCall` with `callTracer` and a state override that
   gifts the attacker enough native balance — we only care about value flows.
3. **Score**: sum every internal call where `from == VAULT_ADDRESS`. If the
   sum exceeds `ETH_DRAIN_THRESHOLD` OR `POOL_FRACTION_THRESHOLD × TVL`, fire.
4. **Riposte**: read hacker's `maxPriorityFeePerGas`, add `PRIORITY_BUMP_GWEI`
   (default 50), bump `maxFeePerGas` accordingly, sign the pre-encoded
   `emergencyHalt()` calldata, broadcast.

## Security notes

- Use a dedicated bot EOA with **only enough ETH for ~50 halts**. The owner
  key (HSM/multisig) handles `resume()` and `rotateSecurityBot()`.
- Rotate the bot key periodically; the contract supports it without redeploy.
- `HALT_COOLDOWN_MS` prevents replay storms during reorgs.
- For mainnet, prefer private mempools (Flashbots Protect, MEV-Share) for
  the riposte tx itself to avoid backrun by other searchers.
