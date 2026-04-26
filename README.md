# KOVER.IA

> **Real-time crypto laundering detection — graph + sequence + language models, in one pipeline.**

KOVER.IA is an AI-powered surveillance system for the Ethereum DeFi
ecosystem. It ingests live transactions, identifies money-laundering
patterns as they form, predicts where the funds are heading, and
generates an actionable incident report — all in less than five seconds,
end to end.

It also ships with a sister module — **kover-bfd-mev** — which watches
the public mempool for flashloan attack signatures and triggers a
programmable response (halt, alert, on-chain freeze) before the
malicious transaction is mined.

---

## Table of contents

- [What this project does](#what-this-project-does)
- [Technical stack](#technical-stack)
- [Architecture overview](#architecture-overview)
- [How to run it (5 minutes)](#how-to-run-it-5-minutes)
- [What you should see](#what-you-should-see)
- [Trust the AI: provenance + tests](#trust-the-ai-provenance--tests)
- [Repository layout](#repository-layout)
- [Project report](#project-report)

---

## What this project does

DeFi protocols lost more than **$2.2 billion** to hacks in 2024. Once
funds are stolen, the attacker has 15 to 90 minutes to launder them
through mixers, cross-chain bridges and unregulated CEX deposits before
human security teams can react. Existing AML tools (Chainalysis, TRM
Labs, Elliptic) are built around retrospective investigation; they
produce reports *after* the funds are gone.

KOVER.IA closes that gap with three complementary AI models running in
parallel on the live transaction stream:

1. **GAT (Graph Attention Network)** — assigns a learned fraud
   probability to every wallet by attending to its neighbours in the
   transaction graph. Trained on the **Salam Ammari Ethereum dataset**
   (71,250 transactions, 73,034 wallets). Validation accuracy **97 %**,
   fraud recall **94 %**.
2. **PathLSTM** — a 2-layer LSTM that predicts the next destination
   class (`Uniswap`, `Binance`, `Hyperliquid`) from the last five
   wallets in the laundering trail, weighted by their GAT scores.
   Per-class accuracy on validation: **clean 89 %, Scamming 91 %,
   Phishing 58 %**.
3. **Qwen 3 235B (Cerebras)** — a 235-billion-parameter LLM hosted on
   Cerebras wafer-scale infrastructure that streams a structured
   incident report (executive summary, technical analysis, prediction,
   recommended actions) at **~50 tokens/sec**.

Every prediction is bundled into a **HMAC-SHA256-signed manifest** so
auditors and regulators can verify the chain of custody — model
checksums, training metadata, inference timestamps and latencies.

The complementary **kover-bfd-mev** sentinel (in `ia/kover-bfd-mev/`)
processes more than **6.5 million events per second** in benchmark, and
issues a flashloan-attack verdict within ~5 s of seeing a candidate
transaction.

---

## Technical stack

### Backend (Python 3.11)

- **FastAPI 0.136** — REST + WebSocket API, CORS open for the demo.
- **PyTorch 2.4 + torch-geometric 2.6** — GAT and LSTM training and
  inference (CPU only, no GPU required for the demo).
- **Cerebras Cloud SDK** — streaming LLM inference; falls back to a
  deterministic stub if the API key is missing.
- **NetworkX 3.3** — in-memory graph operations (PageRank, clustering,
  precomputed feature cache).
- **pydantic 2** — schema validation across the WebSocket boundary.
- **pytest + pytest-asyncio + pytest-cov** — test suite (80 tests,
  >95 % coverage on core business modules).

### Frontend (TypeScript + Vite + React 18)

- **Vite 5** — dev server with hot module replacement.
- **react-force-graph-2d + d3-force** — animated force-directed graph
  visualisation of the live wallet network.
- **shadcn/ui + Tailwind CSS** — accessible component primitives,
  monochrome KOVER.IA design system.
- **WebSocket client** — single `useBackendDataStream` hook is the only
  data source; the front is purely a render layer.

### Behavioral Flow Detection (`ia/kover-bfd-mev/`)

- **Node 20 + ethers.js 6** — mempool listener, transaction simulation
  via `eth_call`, multi-sig wiring.
- **Server-Sent Events** — pushes verdicts to the static dashboard.
- **Pino** — structured JSON logging.

### CI / quality

- **GitHub Actions** — runs the pytest suite on every push.
- **SonarCloud** — code quality, security hot-spots, coverage badge.
- **`/ai/proof` endpoint** — HMAC-signed JSON manifest exposing model
  hashes, parameter counts, training metrics and inference history for
  external audit.

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Vite, :8080)                       │
│  ─────────────────────────────────────────────────────────────────   │
│  ForceGraph 2D ◀── nodes/links     SidePanel ◀── tx feed             │
│  AiTelemetryPanel ◀── checksums, latencies, softmax bars,            │
│                       streaming Cerebras tokens                      │
└────────────────────────────▲─────────────────────────────────────────┘
                             │
                  WebSocket  │  /ws (events: tx_generated, graph_state,
                             │       gat_inference, lstm_inference,
                             │       cerebras_token, ai_manifest, …)
                             │
┌────────────────────────────┴─────────────────────────────────────────┐
│                  BACKEND  (FastAPI + uvicorn, :8000)                 │
│  ─────────────────────────────────────────────────────────────────   │
│  /stream/start /stream/reset /stream/stats   /ai/proof   /launch/…   │
│                                                                      │
│  streaming/generator.py                                              │
│  ├── topology (1 source → 5 splitters → 14 mixers → 28 terminals)    │
│  ├── _gen_tx() — log-normal value distribution + Salam Ammari cats   │
│  └── orchestrates  ──► GAT (5 s)   LSTM (6 s)   Cerebras (30 s)      │
│                                                                      │
│  pipeline.py · agents/ · models/path_lstm.py · gat_scorer.py         │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ click "⚡ DETECT_HACK_FLASHLOAN"
                             │ POST /launch/flashloan
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│   ia/kover-bfd-mev/  Node sentinel  (Server-Sent Events on :8787)    │
│   mempool listener → simulator → AI verdict → halt/alert             │
└──────────────────────────────────────────────────────────────────────┘
```

---

## How to run it (5 minutes)

The project is designed to be picked up by anyone who can clone a git
repo. There is a single Python virtualenv for the backend and a single
`npm` install for the frontend — no Docker, no Kubernetes, no cloud
account required for the demo.

### 0. Prerequisites

- **Python 3.11** (3.10 may work; 3.12+ may need wheel adjustments for
  torch-geometric).
- **Node.js 20+** and **npm**.
- **Git**.
- *(Optional)* a **Cerebras API key** to run the LLM in real streaming
  mode. Without it, the backend falls back to a stub report — every
  other AI piece (GAT + LSTM) keeps working.

### 1. Clone

```bash
git clone https://github.com/nour-alga/HackathonAI-Paris-2026-.git
cd HackathonAI-Paris-2026-
```

### 2. Backend — Python venv + dependencies

```bash
# Create a dedicated Python 3.11 venv
python3.11 -m venv .venv-train
# Linux / macOS
source .venv-train/bin/activate
# Windows
# .venv-train\Scripts\activate

pip install --upgrade pip
pip install fastapi==0.136.1 "uvicorn[standard]" pydantic httpx websockets \
            networkx==3.3 python-dotenv \
            torch==2.4.1 torch-geometric==2.6.1 numpy==1.26.4 pandas==2.2.3 \
            scikit-learn==1.5.2 cerebras-cloud-sdk \
            pytest pytest-asyncio pytest-cov
```

### 3. (Optional) Cerebras API key

Create a `.env` file at the repo root:

```env
CEREBRAS_API_KEY=csk-...your-key...
```

Without this file the LLM step gracefully degrades to a fallback stub
that ships a sensible incident report. The GAT and LSTM still run as
trained models.

### 4. Start the backend

```bash
python -m uvicorn backend.main:app --port 8000 --host 127.0.0.1
```

The trained checkpoints are committed in the repo (`gat_model.pt`,
`backend/models/path_lstm.pt`), so the server is ready immediately —
no training step required.

Verify:
```bash
curl http://127.0.0.1:8000/health
# → {"status":"ok","service":"KOVER.IA"}
curl -X POST http://127.0.0.1:8000/stream/start
# → {"status":"started"}
```

### 5. Frontend — Vite dev server

In a second terminal:

```bash
cd frontend
cp .env.example .env       # the defaults point to http://localhost:8000
npm install
npm run dev
```

Vite will print:

```
  ➜  Local:   http://localhost:8080/
```

### 6. (Optional) Flashloan sentinel

In a third terminal — only needed if you want to demo the
behavioural-flow side:

```bash
cd ia/kover-bfd-mev
npm install
DEMO_INJECT_AFTER_TX=150 DEMO_INJECT_FALLBACK_MS=8000 npm run start:demo
```

Or, easier: leave the sentinel alone and click the
**⚡ DETECT_HACK_FLASHLOAN** button in the KOVER.IA header — the backend
will spawn it for you, and a new browser tab opens to
`http://localhost:8787` once it is ready.

---

## What you should see

Open `http://localhost:8080`.

### Header

- Live volume in ETH, transaction count, laundering count.
- An `AI_PIPELINE` indicator that walks through
  `BUILDING_GRAPH → PATH_PREDICTION → NARRATIVE → COMPLETE` once per
  cycle.
- A red `⚡ DETECT_HACK_FLASHLOAN` button (spawns the Node sentinel and
  opens its dashboard).
- A green `● LIVE_AI` toggle (start/stop the backend stream).
- A `↻ RESET` button (debounced 1.5 s) that clears the graph and seeds
  a fresh hack source.

### Center — force-directed graph

A live network of about 50 wallets, organised in four tiers:

- 1 **HACK_SOURCE** at the centre (red, blacklisted).
- ~5 **splitters** (tier 1).
- ~14 **mixers** (tier 2).
- ~28 **terminal wallets** (tier 3, including CEX-shaped destinations).

Node colour and size update in real time as the GAT rescore arrives —
a visibly suspicious node lights up within a few seconds of joining the
graph.

### Right side — `LIVE_TRACKING` and `AI_TELEMETRY` panels

- Scrolling feed of every transaction, with the laundering ones flagged
  in red.
- An **AI_ANALYSIS** card showing the LSTM most likely destination and
  a **VIEW_INCIDENT_REPORT** button that opens the Cerebras-streamed
  narrative.
- Three **AI_TELEMETRY** cards (one per model) exposing:
  - SHA-256 of the loaded checkpoint (truncated, full one is in
    `/ai/proof`),
  - parameter count,
  - last inference latency in milliseconds,
  - LSTM softmax bars for the three classes (animated on every
    inference),
  - Cerebras token-by-token stream with a blinking cursor.
- An HMAC signature footer that proves the manifest has not been
  tampered with.

---

## Trust the AI: provenance + tests

Two things make the demo verifiable rather than magical:

### Cryptographic manifest

```bash
curl http://127.0.0.1:8000/ai/proof
```

Returns a JSON document with:

- `manifest.models.gat.checkpoint_sha256` — recompute it locally with
  `sha256sum gat_model.pt` and compare.
- `manifest.models.lstm.checkpoint_sha256` — same for
  `backend/models/path_lstm.pt`.
- `manifest.models.cerebras.model_id` — the actual model identifier
  used at inference time.
- `manifest.inference_log_recent` — rolling buffer of the last 50
  inferences with their latencies, on a wall-clock timeline.
- `signature_hmac_sha256` — a deterministic HMAC of the canonical JSON
  body using a server secret. Reserialise the body sorted/compact, run
  `HMAC-SHA256(secret, body)`, and check.

### Test suite

```bash
pytest
```

Should print **80 passed in ~9 s**. Coverage on the modules where it
matters:

| Module | Coverage |
| --- | ---: |
| `backend/streaming/proof.py` | **100 %** |
| `backend/websocket/manager.py` | **100 %** |
| `backend/storage/models.py` | **100 %** |
| `backend/pipeline.py` | **98 %** |
| `backend/streaming/generator.py` | **95 %** |

---

## Repository layout

```
HackathonAI-Paris-2026-/
├── backend/
│   ├── main.py                  # FastAPI app + routes
│   ├── pipeline.py              # run_pipeline_from_graph (skip Etherscan)
│   ├── agents/                  # PathPredictor, IncidentReporter, …
│   ├── models/path_lstm.py      # PathLSTM (3-class destination classifier)
│   ├── streaming/
│   │   ├── generator.py         # tx generator + GAT/LSTM/Cerebras orchestrator
│   │   └── proof.py             # SHA-256 + HMAC manifest
│   ├── storage/                 # Pydantic schemas + optional BigQuery
│   └── websocket/manager.py     # broadcast bus
│
├── frontend/                    # Vite + React 18 dashboard
│   └── src/
│       ├── pages/Index.tsx
│       ├── hooks/useBackendDataStream.ts   # single source of truth
│       └── components/aml/
│           ├── ForceGraph.tsx
│           ├── SidePanel.tsx
│           ├── AiTelemetryPanel.tsx
│           └── Header.tsx
│
├── ia/
│   ├── kover-bfd/               # passive monitoring dashboard
│   └── kover-bfd-mev/           # flashloan sentinel + simulator
│
├── tests/                       # 80 pytest tests
├── scripts/                     # train_gat.py, train_path_lstm.py, …
├── salam_ammari_dataset/        # placeholder (download CSV from Kaggle)
│
├── gat_model.pt                 # trained GAT checkpoint (5 666 params)
├── backend/models/path_lstm.pt  # trained LSTM checkpoint (54 403 params)
│
├── pytest.ini                   # test config + coverage
├── sonar-project.properties     # SonarCloud config
├── .github/workflows/sonarcloud.yml   # CI: pytest + Sonar scan
│
├── RAPPORT_KOVER_IA.tex         # 9-page LaTeX project report (FR)
├── TESTING.md                   # deeper testing/Sonar setup notes
└── README.md                    # ← you are here
```

---

## Project report

A full written report (in French, ~9 pages, tcolorbox-styled LaTeX
document) is included as
[`RAPPORT_KOVER_IA.tex`](./RAPPORT_KOVER_IA.tex). Compile it with
`pdflatex RAPPORT_KOVER_IA.tex` (run twice for the table of contents).
It covers the introduction, the regulatory and technical problem
statement, the architecture, the competitive landscape
(Chainalysis / TRM / Elliptic / Forta) and the business model
(four-tier SaaS pricing, COGS analysis, three-stage funding plan).

---

**Hackathon AI Paris 2026** — KOVER.IA team. Built in 24 hours.
Trained models, signed manifest, force-directed UI, flashloan sentinel,
80-test suite — all in one repo, all reproducible from a `git clone`.
