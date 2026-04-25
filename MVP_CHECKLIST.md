# KOVER.IA MVP — Checklist Hackathon

## DONE

### Core Architecture
- [x] Taint graph with BFS traversal
- [x] Entity type detection (mixer, bridge, CEX, unknown)
- [x] Taint score propagation algorithm
- [x] 2-agent orchestration (PathPredictor + IncidentReporter)

### Agents (Cerebras Qwen 3 235B)
- [x] PathPredictor agent — predicts next destination
- [x] IncidentReporter agent — generates structured reports
- [x] Orchestrator — coordinates agent pipeline

### Storage & Alerting
- [x] BigQuery integration (incidents + tainted_wallets tables)
- [x] Discord alerting REMOVED per user request
- [x] WebSocket real-time broadcast

### Testing
- [x] Unit tests for individual components
- [x] Integration test (mock graph → full pipeline)
- [x] Cached result test (shows full incident report)
- [x] Real data evaluation (Salam Ammari dataset: 71k txs)

### Documentation
- [x] ARCHITECTURE.md — system design
- [x] CLAUDE.md — updated with agent architecture
- [x] Inline code comments (where non-obvious)

---

## TODO (In Priority Order)

### 1. Real Etherscan Integration (BLOCKING)
**Status:** Not started
**Why:** Must fetch actual transaction data to demo

```python
# Needed in backend/detection/etherscan_client.py
async def fetch_transactions(wallet_address, api_key) -> list[dict]
async def fetch_wallet_labels(wallet_address) -> dict  # Tornado, Bridge, etc
```

**Estimate:** 2 hours
**Impact:** Unlocks real-world demo

### 2. Frontend Dashboard (DEMO-CRITICAL)
**Status:** Not started
**Why:** Jury needs to see something working visually

```
Show:
- Real-time ECG-style graph (wallet taint scores)
- Incident alerts list
- Top wallets table
- Destination prediction
```

**Stack:** Next.js 14 + Tailwind + WebSocket client
**Estimate:** 4 hours
**Impact:** Demo wow factor

### 3. Deploy to Google Cloud Run (DEMO-CRITICAL)
**Status:** Not started
**Why:** Jury expects production-ready deployment

```bash
# Need:
- Dockerfile (ready, just needs testing)
- GCP project setup + Cloud Run config
- .env secrets in Cloud Run
```

**Estimate:** 1 hour
**Impact:** Credibility

### 4. Live Demo Scenario (POLISH)
**Status:** Not started
**Why:** Show system working end-to-end

```
Scenario: Inject fake hack from Euler/Aave
→ Watch ECG break
→ Agents analyze in real-time
→ Report streams to dashboard
→ Prediction arrives
```

**Estimate:** 1 hour

---

## Current Time Budget

**Assumption:** Hackathon ends in ~18 hours

**Critical path:**
1. Real Etherscan integration — 2h
2. Frontend dashboard — 4h
3. Deploy + test — 1h
4. Buffer/fixes — 3h
5. **Total: 10 hours** ✓ Fits!

**Nice-to-have (if time):**
- Graph visualization (Cytoscape.js) — 3h
- Real-time monitoring (WebSocket loop) — 2h
- Advanced detection rules — 2h

---

## What Jury Will See (Demo Flow)

### 60-second demo

```
1. [Timestamp: T+0] Dashboard shows normal Aave metrics
   → "Everything running normally"

2. [T+5] Inject Euler hack via API
   → POST /analyze?address=0xhacked&amount=61000

3. [T+8] TaintGraph builds 50-wallet network
   → "Detected suspicious flows..."

4. [T+12] PathPredictor + IncidentReporter agents run
   → "Analyzing destination patterns..."

5. [T+15] Dashboard shows:
   - Red CRITICAL alert
   - 47 tainted wallets with scores
   - "Next destination: Tornado Cash (92% confidence)"
   - Full incident report streaming in

6. [T+20] Report appears on screen
   → "This entire analysis happened in 15 seconds"

7. [T+25] Jury asks questions
   → Explain architecture, show code
```

---

## Success Criteria

- [x] Architecture documented and clean
- [x] All agents working (cached test passes)
- [ ] Etherscan integration working
- [ ] Frontend deployed
- [ ] End-to-end demo runs in <30 seconds
- [ ] No crashes or errors in demo
- [ ] Jury impressed by AI reasoning + speed combo

---

## Known Issues / Assumptions

1. **Etherscan rate limits** — Need API key, ~1000 req/day free tier
2. **BigQuery costs** — Minimal, <$1 for hackathon volume
3. **Cerebras limits** — $50 budget = 50k incidents (plenty)
4. **No real blockchain data** — Using mock graph for now, real data after integration

---

## Questions for User Before Starting

1. Do you want the dashboard as part of MVP, or just CLI proof-of-concept?
2. Should the live demo use real Ethereum data or mock hack data?
3. Any specific styling/branding for the dashboard?
