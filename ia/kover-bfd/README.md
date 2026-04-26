# KOVER.IA — Behavioral Flow Detection

Production reference implementation of the 4-stage circuit-breaker pipeline.

```
┌──────────────┐   ┌────────────┐   ┌──────────────────┐   ┌────────────────┐   ┌──────────────┐
│ WSS Mempool  │ → │ Node.js    │ → │ Kafka            │ → │ PyFlink 1s     │ → │ FastAPI +    │
│ (Erigon/     │   │ Ingester   │   │ kover-mempool-   │   │ Tumbling Window│   │ IsolationFor.│
│  Alchemy)    │   │            │   │ raw              │   │ (volume, count)│   │ → web3.py    │
└──────────────┘   └────────────┘   └──────────────────┘   └────────────────┘   └──────┬───────┘
                                                                                       │
                                                                              emergencyHalt()
                                                                                       ▼
                                                                              VaultClient.sol
```

## Layout

| Path | Service |
| ---- | ------- |
| `contracts/VaultClient.sol`               | Solidity vault + circuit breaker |
| `ingester/mempool_streamer.js`            | Node.js WSS → Kafka producer     |
| `processor/time_series_aggregator.py`     | PyFlink 1s tumbling aggregator   |
| `ai_engine/anomaly_detector.py`           | FastAPI inference + tx broadcast |
| `ai_engine/train_model.py`                | Baseline IsolationForest trainer |

## Quickstart

```bash
cp .env.example .env  # fill in secrets

# 1. Smart contract (Foundry/Hardhat) — deploy VaultClient with bot address.

# 2. Ingester
cd ingester && npm install && npm start

# 3. AI engine (train then serve)
cd ai_engine && pip install -r requirements.txt
python train_model.py
uvicorn anomaly_detector:app --host 0.0.0.0 --port 8000

# 4. Processor
cd processor && pip install -r requirements.txt
python time_series_aggregator.py
```
