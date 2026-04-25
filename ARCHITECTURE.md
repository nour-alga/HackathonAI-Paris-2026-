# KOVER.IA — Architecture Finale

## Pipeline Optimisé (2 Agents + Algorithm)

```
┌─ Etherscan API (fetch transactions) ─┐
│                                       │
├─ TaintGraph (BFS propagation)    [ALGORITHM - ~0.5s]
│  Output: taint_score per wallet
│
├─ PathPredictor Agent            [LLM - ~1s]
│  Input: graph summary + taint scores
│  Output: next_destination, probability, eta
│
├─ IncidentReporter Agent         [LLM - ~1s]
│  Input: taint scores + path prediction + context
│  Output: structured incident narrative
│
├─ BigQuery                       [STORAGE]
│  Save incidents + tainted wallets
│
└─ WebSocket → Frontend Dashboard [REAL-TIME]
```

---

## Pourquoi cette architecture est meilleure

| Component | Old | New | Why |
|-----------|-----|-----|-----|
| **TaintAnalyst** | Agent (Cerebras) | Removed | Graph algo better + cheaper |
| **Taint Scoring** | LLM reasoning | TaintGraph BFS | Deterministic, proven, fast |
| **PathPredictor** | Agent (Cerebras) | Agent (Cerebras) | ✓ LLM needed for pattern reasoning |
| **IncidentReporter** | Agent (Cerebras) | Agent (Cerebras) | ✓ LLM perfect for text synthesis |

---

## Méthodologie TaintGraph

**Input:** Source address + transaction graph from Etherscan

**Algorithm:**
1. BFS traversal from source address
2. Propagate taint score through edges:
   - Direct child: score * 0.95
   - 2-hop: score * 0.8
   - 3-hop: score * 0.6
3. Mark high-risk entities (Tornado Cash, bridges) as taint_score = 0.9
4. Final: sort wallets by taint_score (0.0 = clean, 1.0 = definitely stolen)

**Output:** TaintGraph object with all wallets scored

---

## Budget Impact

| Agent | Tokens | Cost |
|-------|--------|------|
| PathPredictor | ~300 | $0.0003 |
| IncidentReporter | ~600 | $0.0007 |
| **Per incident** | | **$0.001** |
| **$50 budget** | | **~50,000 incidents** |

*Removed TaintAnalyst = 50% cost reduction*

---

## Performance (Cached Results)

**Euler Finance Hack (61k ETH, 5 wallets)**

```
[+] TaintGraph: 7 wallets analyzed
    Max taint score: 1.00
    Critical entities detected: Tornado Cash, bridges

[+] PathPredictor: 92% confidence → Tornado Cash Mixing Pool (8 min ETA)

[+] IncidentReporter: Full narrative + action items generated

Total time: ~2 seconds
Total cost: ~$0.001
```

---

## Test Coverage

- ✓ test_pipeline_with_mock_graph.py — full pipeline with 7-wallet graph
- ✓ test_with_cached_results.py — cached agent responses
- ✓ evaluate_agents_on_real_data.py — heuristic scoring on 71k real txs
- ✓ final_integration_test.py — all components working together

---

## What's Left for MVP

- [ ] Real Etherscan API integration (replace mock graph builder)
- [ ] Frontend dashboard (show graph + alerts)
- [ ] Deploy backend to Google Cloud Run
- [ ] Live demo with real attack scenario
