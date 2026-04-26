# KOVER.IA — Security Hardening Audit

This document tracks every defense-in-depth measure applied to the codebase
and the threat each one mitigates. It is the companion of `SECURITY.md`
(threat model) — that document explains *why*, this one explains *what*.

Every item below is implemented in code and tagged with the file it lives in.

---

## 1. Secret hygiene

| Mitigation | Location | Threat |
|---|---|---|
| Pino redaction list (`privateKey`, `*.privateKey`, `apiKey`, `authorization`, `WSS_RPC_URL`, ...) | `src/logger.js` | Accidental log exposure of credentials |
| `.env` excluded via `.gitignore`; `.env.example` template only contains placeholders | repo root | Secrets in version control |
| Constant-time comparison for the dashboard bearer token | `dashboard/server.js` (`authOk`) | Timing-oracle leak on token |
| `validators.privateKey()` throws on the zero key, on wrong length, on non-hex | `src/validators.js` | Misconfigured deployment with a placeholder key |
| AI Analyst payload field-level allowlist + size cap (8 KB) | `src/aiAnalyst.js` (`_buildUserPayload`) | Accidental PII / private-key leak to a third-party LLM |
| Self-check: refuses to send any payload that contains a substring resembling a private key in an unexpected position | `src/aiAnalyst.js` (`_looksLikePrivateKey`) | Future regression that adds a sensitive field to the payload |

## 2. Input validation at trust boundaries

Every input that crosses a trust boundary into the engine is validated
through `src/validators.js` before reaching business logic. The validators
return cleaned/normalized values or throw `ValidationError`.

| Boundary | Validator | Caps enforced |
|---|---|---|
| Mempool tx body (RPC) | `validators.mempoolTx` | calldata ≤ 256 KB; uint256 range; address/hash format |
| `debug_traceCall` result | `validators.traceFrame` | depth ≤ 32; fan-out ≤ 256 calls/frame |
| Env-derived addresses | `validators.address` | 0x + 40 hex |
| Env-derived chain ID | `validators.chainId` | 1 ≤ x ≤ 2³¹-1 |
| Env-derived URLs | `validators.url` | scheme allowlist; rejects userinfo-in-URL |

## 3. Resource exhaustion / DoS

| Mitigation | Location | Defends against |
|---|---|---|
| Per-EOA simulation quota (8 sims / 10 s) | `src/engine.js` (`_consumeSimQuota`) | Sybil flood that pumps cheap candidates to exhaust `debug_traceCall` quota |
| Hard cap on simHits map size (5 000 entries) | `src/engine.js` | OOM via unique-`from`-per-tx flood |
| Periodic GC on simHits (30 s) | `src/engine.js` (`_gcSimQuota`) | Long-tail map growth |
| Bounded event-bus listener count (64) | `src/eventBus.js` | Subscriber leak via buggy clients |
| Per-event payload cap (32 KB) | `src/eventBus.js` | Single oversized event blocking the SSE pump |
| SSE connection cap (32) | `dashboard/server.js` | Subscriber accumulation on the bus |
| Per-IP SSE rate limit (60/min token bucket) | `dashboard/server.js` | Reconnect-storm DoS |
| Rate-limit map GC (10-min idle eviction) | `dashboard/server.js` | Map growth under churn |
| HTTP request size & timeout caps (30 s / 10 s headers / 256 reqs/socket) | `dashboard/server.js` | Slowloris, oversized requests |
| Hard timeout on AI Analyst calls (12 s, configurable) | `src/aiAnalyst.js` | Hung LLM provider blocking the dashboard pipeline |
| Heuristic fallback on Analyst failure | `src/aiAnalyst.js` (`_heuristic`) | Provider outage / rate-limit / malformed JSON |

## 4. Dashboard HTTP security

| Mitigation | Location | Threat |
|---|---|---|
| Bound to 127.0.0.1 by default | `dashboard/server.js` | Accidental public exposure |
| Optional bearer-token auth (`DASHBOARD_TOKEN`) | `dashboard/server.js` | Unauthorized access if exposed |
| Strict Content-Security-Policy (no inline JS, no eval, no foreign origins) | `dashboard/server.js` | XSS via tx data echoed in feed |
| `X-Content-Type-Options: nosniff` | `dashboard/server.js` | MIME-type confusion |
| `X-Frame-Options: DENY` | `dashboard/server.js` | Clickjacking |
| `Referrer-Policy: no-referrer` | `dashboard/server.js` | Referrer leak |
| `Permissions-Policy` denying geo/mic/camera | `dashboard/server.js` | Browser-API abuse |
| Path-traversal guard on static-file serving (null-byte + prefix check) | `dashboard/server.js` (`resolvePublic`) | Reading files outside `public/` |
| Refuses non-GET methods | `dashboard/server.js` (`handle`) | CSRF (no state-changing endpoints) |
| `X-Forwarded-For` only honored when `DASHBOARD_TRUST_PROXY=1` | `dashboard/server.js` (`clientIp`) | IP spoofing in rate limit |
| HTML-escape in feed renderer (`esc`) | `dashboard/public/app.js` | XSS via attacker-controlled tx fields |

## 5. Smart-contract hardening (Vault.sol)

| Mitigation | Threat |
|---|---|
| `Pausable + Ownable + ReentrancyGuard` | Reentrancy, unauthorized admin |
| Custom errors (gas-cheap reverts) | Higher gas cost slows the riposte |
| `onlySecurityBot` modifier on `emergencyHalt()` | Unauthorized halt |
| 6-hour `ROTATION_DELAY` on `rotateSecurityBot` | Compromised owner silently disarming the breaker |
| `maxDepositPerUser` + `maxTotalValueLocked` caps | Concentrated risk if one user/aggregator gains outsized exposure |
| `forceWithdraw(user)` (paused-only, owner-only) | Locked user funds during a long incident-recovery |
| `recoverDust(beneficiary)` for unaccounted ETH (selfdestruct gifts, refunds) | Donation-based accounting drift |
| `receive()` and `fallback()` revert | Bypass of the `deposit()` accounting path |
| `CircuitBreakerTriggered(origin, bot, ts)` event includes both `tx.origin` and the bot | Forensic clarity in relayer scenarios |
| CEI pattern on `withdraw` and `forceWithdraw` | Reentrancy via callback |
| Solidity 0.8 default overflow checks; `unchecked` only after explicit bound checks | Integer overflow |

## 6. Process hardening

| Mitigation | Location | Threat |
|---|---|---|
| Graceful shutdown on SIGINT/SIGTERM with 5 s force-exit timer | `src/start_demo.js` (`gracefulShutdown`) | Hanging shutdown → orphaned sockets / zombie process |
| `unhandledRejection` and `uncaughtException` handlers | `src/start_demo.js` | Silent process death without telemetry |
| Dashboard `stop()` for clean socket close | `dashboard/server.js` | Port-in-use on next boot |

## 7. Operational

| Mitigation | Location | Threat |
|---|---|---|
| Cooldown lock (30 s) between halt broadcasts | `src/engine.js` / `src/flashrun.js` | Replay storm during chain reorg |
| Optimistic nonce roll-back on broadcast failure | `src/flashrun.js` | Nonce gap freezing the bot key |
| Background nonce resync (15 s) | `src/engine.js` (`_resyncNonce`) | Drift if the bot key is used out-of-band |
| Heartbeat watchdog (30 s) on WSS subscription | `src/engine.js` (`_bumpHeartbeat`) | Silent dead WS held open by intermediaries |
| Exponential backoff with jitter on WSS reconnect | `src/engine.js` (`_scheduleReconnect`) | Hot reconnect-loop on a flapping endpoint |
| Optional Flashbots Protect relay for the riposte | `src/flashrun.js` | Public-mempool backrun by other searchers |
| Multi-strategy gas pricing (additive default; ×2.5 multiplicative opt-in) | `src/flashrun.js` (`_bumpedFees`) | Lowball-prio bait + fee-grief |

## 8. Pre-deployment checklist

Before mainnet:

- [ ] `Vault.sol` audited by an external firm
- [ ] Owner replaced by a 3-of-5 multisig
- [ ] `securityBot` is a dedicated EOA funded for ~50 halts only
- [ ] `DASHBOARD_TOKEN` set; dashboard fronted by TLS-terminating proxy
- [ ] `FLASHBOTS_RPC_URL` configured
- [ ] All secrets stored in KMS / HSM (no plain `.env` in production)
- [ ] Logs shipped to a SIEM with the redact list verified
- [ ] At least N=3 sentinels in distinct regions with a coordinator
- [ ] Bug-bounty live (Immunefi ≥ $100k)
- [ ] Runbook + quarterly drill recorded
- [ ] `setLimits(maxDepositPerUser, maxTotalValueLocked)` set to product-realistic values

## 9. What's deliberately NOT mitigated

These are conscious trade-offs — they cost more than they protect against
in the current architecture, but should be revisited if circumstances change.

- **Per-tool input validation on the AI Analyst response**. The analyst's
  output is treated as advisory text only; even if a malicious prompt
  injection produced a fake "BENIGN" verdict, the deterministic engine
  has already fired the riposte. JSON-schema enforcement at the LLM API
  layer is sufficient.
- **Encryption of the in-process event bus**. Bus traffic never leaves the
  Node process; TLS would add CPU cost and zero security.
- **Cryptographic signing of dashboard events**. Same reason — same-origin.
  If/when a remote pub/sub backend replaces the bus, this becomes mandatory.
- **Replay protection on `emergencyHalt()`**. The function is idempotent
  (`_pause()` on an already-paused contract reverts), and the cooldown
  in `flashrun.js` prevents the bot from re-broadcasting within a short
  window. On-chain replay protection would add gas.
