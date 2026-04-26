"""
KOVER.IA — Anomaly Detection & Defensive Front-Running Engine
==============================================================

FastAPI service exposing `POST /predict`. Loads a pre-trained IsolationForest
from disk, scores incoming 1-second window aggregates, and — when both the
ML decision *and* a destructive-volume heuristic agree — forges, signs, and
broadcasts an `emergencyHalt()` transaction to the VaultClient contract with
aggressively bumped EIP-1559 fees (defensive front-running).

Hardening:
  - Pydantic-validated request schema
  - Idempotent halt: short in-process cooldown to avoid replaying halts
    while the chain reorgs / mempool propagates
  - Structured JSON logging with end-to-end latency tracing
  - All secrets via environment variables (never hardcoded)

Run:
    uvicorn anomaly_detector:app --host 0.0.0.0 --port 8000 --workers 1
"""
from __future__ import annotations

import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Any

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from web3 import Web3
from web3.exceptions import TransactionNotFound
from web3.middleware import ExtraDataToPOAMiddleware

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
    stream=sys.stdout,
)
log = logging.getLogger("kover.ai_engine")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL_PATH = Path(os.getenv("MODEL_PATH", "models/iso_forest.joblib"))
ANOMALY_SCORE_THRESHOLD = float(os.getenv("ANOMALY_SCORE_THRESHOLD", "-0.15"))
DESTRUCTIVE_VOLUME_WEI = int(os.getenv("DESTRUCTIVE_VOLUME_WEI", str(50 * 10**18)))  # 50 ETH/sec
HALT_COOLDOWN_S = float(os.getenv("HALT_COOLDOWN_S", "30"))

RPC_HTTP_URL = os.getenv("RPC_HTTP_URL", "")
CHAIN_ID = int(os.getenv("CHAIN_ID", "1"))
VAULT_CONTRACT_ADDRESS = os.getenv("VAULT_CONTRACT_ADDRESS", "")
SECURITY_BOT_PRIVATE_KEY = os.getenv("SECURITY_BOT_PRIVATE_KEY", "")
PRIORITY_FEE_BUMP_PCT = float(os.getenv("PRIORITY_FEE_BUMP_PCT", "50"))  # +50%
MAX_FEE_BUMP_PCT = float(os.getenv("MAX_FEE_BUMP_PCT", "50"))
USE_POA_MIDDLEWARE = os.getenv("USE_POA_MIDDLEWARE", "false").lower() == "true"

VAULT_ABI: list[dict[str, Any]] = [
    {
        "inputs": [],
        "name": "emergencyHalt",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    }
]

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class WindowAggregateIn(BaseModel):
    """Aggregate emitted by the Flink processor."""

    window_start_ms: int
    window_end_ms: int
    target: str = Field(min_length=42, max_length=42)
    volume_1s: int = Field(ge=0)
    tx_count_1s: int = Field(ge=0)

    @field_validator("target")
    @classmethod
    def _addr_lc(cls, v: str) -> str:
        if not v.startswith("0x"):
            raise ValueError("target must be 0x-prefixed")
        return v.lower()


class PredictResponse(BaseModel):
    anomaly: bool
    score: float
    halted: bool
    tx_hash: str | None = None
    latency_ms: float

# ---------------------------------------------------------------------------
# Halt executor (defensive front-runner)
# ---------------------------------------------------------------------------

class HaltExecutor:
    """Builds, signs, and broadcasts the emergencyHalt() transaction."""

    def __init__(self) -> None:
        if not (RPC_HTTP_URL and VAULT_CONTRACT_ADDRESS and SECURITY_BOT_PRIVATE_KEY):
            log.warning("HaltExecutor disabled: missing RPC/contract/key env vars")
            self._enabled = False
            return

        self._enabled = True
        self._w3 = Web3(Web3.HTTPProvider(RPC_HTTP_URL, request_kwargs={"timeout": 2.0}))
        if USE_POA_MIDDLEWARE:
            self._w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)

        self._account = self._w3.eth.account.from_key(SECURITY_BOT_PRIVATE_KEY)
        self._contract = self._w3.eth.contract(
            address=Web3.to_checksum_address(VAULT_CONTRACT_ADDRESS), abi=VAULT_ABI
        )
        self._lock = Lock()
        self._last_halt_ts: float = 0.0

        log.info("HaltExecutor armed bot=%s vault=%s", self._account.address, VAULT_CONTRACT_ADDRESS)

    @property
    def enabled(self) -> bool:
        return self._enabled

    def _bumped_fees(self) -> tuple[int, int]:
        """
        Reads pending base-fee + suggested priority fee, returns aggressively
        bumped (maxFeePerGas, maxPriorityFeePerGas) tuple.
        """
        latest = self._w3.eth.get_block("latest")
        base_fee = latest.get("baseFeePerGas") or self._w3.eth.gas_price
        priority = self._w3.eth.max_priority_fee

        bump = lambda x, pct: int(x * (1 + pct / 100.0))  # noqa: E731
        max_priority = bump(priority, PRIORITY_FEE_BUMP_PCT)
        max_fee = bump(base_fee * 2 + max_priority, MAX_FEE_BUMP_PCT)
        return max_fee, max_priority

    def trigger(self) -> str | None:
        """
        Forge → sign → broadcast emergencyHalt(). Returns tx hash hex on success.
        Idempotent within HALT_COOLDOWN_S.
        """
        if not self._enabled:
            return None

        with self._lock:
            now = time.monotonic()
            if now - self._last_halt_ts < HALT_COOLDOWN_S:
                log.info("halt suppressed by cooldown remaining_s=%.2f",
                         HALT_COOLDOWN_S - (now - self._last_halt_ts))
                return None
            self._last_halt_ts = now

        try:
            max_fee, max_priority = self._bumped_fees()
            nonce = self._w3.eth.get_transaction_count(self._account.address, "pending")

            tx = self._contract.functions.emergencyHalt().build_transaction({
                "from": self._account.address,
                "nonce": nonce,
                "chainId": CHAIN_ID,
                "type": 2,
                "maxFeePerGas": max_fee,
                "maxPriorityFeePerGas": max_priority,
                "gas": 120_000,
            })

            signed = self._account.sign_transaction(tx)
            tx_hash = self._w3.eth.send_raw_transaction(signed.raw_transaction)
            tx_hex = tx_hash.hex()
            log.warning(
                "CIRCUIT BREAKER FIRED tx=%s maxFee=%d maxPrio=%d nonce=%d",
                tx_hex, max_fee, max_priority, nonce,
            )
            return tx_hex
        except TransactionNotFound as exc:
            log.error("halt broadcast tx-not-found: %s", exc)
        except Exception as exc:  # noqa: BLE001
            log.exception("halt broadcast failed: %s", exc)
        return None

# ---------------------------------------------------------------------------
# Model loader
# ---------------------------------------------------------------------------

class AnomalyModel:
    """Wraps a fitted scikit-learn IsolationForest."""

    def __init__(self, path: Path) -> None:
        if not path.exists():
            raise FileNotFoundError(f"model artifact not found: {path}")
        self._model = joblib.load(path)
        log.info("isolation forest loaded path=%s n_estimators=%s",
                 path, getattr(self._model, "n_estimators", "?"))

    def score(self, volume_1s: int, tx_count_1s: int) -> float:
        # Convert wei → ETH for numerical stability of the model.
        feats = np.array([[volume_1s / 1e18, float(tx_count_1s)]], dtype=np.float64)
        return float(self._model.decision_function(feats)[0])

# ---------------------------------------------------------------------------
# FastAPI app + lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_: FastAPI):
    app.state.model = AnomalyModel(MODEL_PATH)
    app.state.halter = HaltExecutor()
    yield


app = FastAPI(title="KOVER.IA Anomaly Detector", version="1.0.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model_loaded": hasattr(app.state, "model"),
        "halter_enabled": getattr(app.state.halter, "enabled", False) if hasattr(app.state, "halter") else False,
    }


@app.post("/predict", response_model=PredictResponse)
async def predict(payload: WindowAggregateIn) -> PredictResponse:
    t0 = time.perf_counter_ns()
    try:
        score = app.state.model.score(payload.volume_1s, payload.tx_count_1s)
    except Exception as exc:  # noqa: BLE001
        log.exception("scoring failed")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                            detail="scoring_failure") from exc

    is_anomaly = score < ANOMALY_SCORE_THRESHOLD
    is_destructive = payload.volume_1s >= DESTRUCTIVE_VOLUME_WEI

    tx_hash: str | None = None
    halted = False
    if is_anomaly and is_destructive:
        log.warning(
            "ANOMALY+DESTRUCTIVE detected score=%.4f volume=%d tx_count=%d window=[%d..%d]",
            score, payload.volume_1s, payload.tx_count_1s,
            payload.window_start_ms, payload.window_end_ms,
        )
        tx_hash = app.state.halter.trigger()
        halted = tx_hash is not None

    latency_ms = (time.perf_counter_ns() - t0) / 1e6
    log.info(
        "predict done anomaly=%s halted=%s score=%.4f latency_ms=%.3f",
        is_anomaly, halted, score, latency_ms,
    )
    return PredictResponse(
        anomaly=is_anomaly,
        score=score,
        halted=halted,
        tx_hash=tx_hash,
        latency_ms=latency_ms,
    )
