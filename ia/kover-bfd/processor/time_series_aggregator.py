"""
KOVER.IA — Time-Series Aggregator (Stream Processor)
=====================================================

PyFlink job that consumes raw mempool transactions from Kafka, applies a
1-second tumbling event-time window, computes per-window aggregates
(volume, tx_count), and forwards each aggregate as an async HTTP POST to the
AI inference engine (`/predict`).

Topology:
    Kafka(kover-mempool-raw)
      → KeyBy(target_contract)
      → TumblingEventTimeWindow(1s)
      → ReduceFunction(sum value, sum count)
      → AsyncHttpSink(POST /predict)

Run:
    python time_series_aggregator.py
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from typing import Iterable

import aiohttp
from pydantic import BaseModel, Field, ValidationError, field_validator

from pyflink.common import Duration, Time, Types, WatermarkStrategy
from pyflink.common.serialization import SimpleStringSchema
from pyflink.common.watermark_strategy import TimestampAssigner
from pyflink.datastream import StreamExecutionEnvironment
from pyflink.datastream.connectors.kafka import KafkaSource, KafkaOffsetsInitializer
from pyflink.datastream.functions import ReduceFunction, ProcessWindowFunction
from pyflink.datastream.window import TumblingEventTimeWindows

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
    stream=sys.stdout,
)
log = logging.getLogger("kover.processor")

# ---------------------------------------------------------------------------
# Config (env-driven)
# ---------------------------------------------------------------------------

KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "localhost:9092")
KAFKA_TOPIC = os.getenv("KAFKA_TOPIC", "kover-mempool-raw")
KAFKA_GROUP = os.getenv("KAFKA_GROUP", "kover-flink-processor")
AI_ENGINE_URL = os.getenv("AI_ENGINE_URL", "http://localhost:8000/predict")
WINDOW_SECONDS = int(os.getenv("WINDOW_SECONDS", "1"))
HTTP_TIMEOUT_S = float(os.getenv("HTTP_TIMEOUT_S", "0.250"))  # 250ms — HFT budget

# ---------------------------------------------------------------------------
# Pydantic schemas (validation at the kafka boundary)
# ---------------------------------------------------------------------------

class MempoolTx(BaseModel):
    """Validated mempool transaction payload produced by the Node.js ingester."""

    txHash: str
    from_: str = Field(alias="from")
    to: str
    value: int  # wei
    gasPrice: int
    nonce: int
    timestamp: int  # ms epoch

    model_config = {"populate_by_name": True}

    @field_validator("value", "gasPrice", mode="before")
    @classmethod
    def _coerce_int(cls, v: object) -> int:
        # Ingester sends decimal strings to preserve BigInt precision.
        return int(v) if isinstance(v, str) else v  # type: ignore[arg-type]


class WindowAggregate(BaseModel):
    """Aggregate emitted per 1-second window."""

    window_start_ms: int
    window_end_ms: int
    target: str
    volume_1s: int          # sum of value (wei)
    tx_count_1s: int

# ---------------------------------------------------------------------------
# Flink operators
# ---------------------------------------------------------------------------

@dataclass
class PartialAgg:
    target: str
    volume: int
    count: int

    def to_tuple(self) -> tuple[str, int, int]:
        return (self.target, self.volume, self.count)


class _TsAssigner(TimestampAssigner):
    """Extracts event-time millis from validated payload tuple."""

    def extract_timestamp(self, value, record_timestamp):  # noqa: ANN001
        # value: (target, volume, count, ts_ms)
        return value[3]


class _ParseAndProject:
    """Parses Kafka JSON → (target, value, 1, ts_ms). Drops malformed records."""

    def __call__(self, raw: str):  # noqa: D401
        try:
            tx = MempoolTx.model_validate_json(raw)
        except ValidationError as exc:
            log.warning("drop malformed mempool tx: %s", exc.errors()[:1])
            return None
        return (tx.to.lower(), tx.value, 1, tx.timestamp)


class _SumReducer(ReduceFunction):
    """Combines two partial aggregates within the same window."""

    def reduce(self, a, b):  # noqa: ANN001
        # tuple shape: (target, volume, count, ts_ms) — keep latest ts.
        return (a[0], a[1] + b[1], a[2] + b[2], max(a[3], b[3]))


class _EmitWindow(ProcessWindowFunction):
    """Wraps the reducer's single output with explicit window bounds."""

    def process(self, key, context, elements):  # noqa: ANN001
        window = context.window()
        for el in elements:
            agg = WindowAggregate(
                window_start_ms=window.start,
                window_end_ms=window.end,
                target=el[0],
                volume_1s=el[1],
                tx_count_1s=el[2],
            )
            yield agg.model_dump_json()

# ---------------------------------------------------------------------------
# Async HTTP sink (executed on the JVM-bridged Python side)
# ---------------------------------------------------------------------------

class AsyncHttpSink:
    """
    Lightweight async POST sink with bounded concurrency. Uses a single
    aiohttp session per task slot to amortize TLS handshakes.
    """

    def __init__(self, url: str, timeout_s: float, max_inflight: int = 64) -> None:
        self._url = url
        self._timeout = aiohttp.ClientTimeout(total=timeout_s)
        self._sem = asyncio.Semaphore(max_inflight)
        self._session: aiohttp.ClientSession | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            self._session = aiohttp.ClientSession(timeout=self._timeout)
        return self._loop

    async def _post(self, payload: str) -> None:
        assert self._session is not None
        t0 = time.perf_counter_ns()
        async with self._sem:
            try:
                async with self._session.post(
                    self._url, data=payload, headers={"content-type": "application/json"}
                ) as resp:
                    if resp.status >= 400:
                        body = await resp.text()
                        log.error("ai_engine non-2xx status=%s body=%s", resp.status, body[:256])
            except asyncio.TimeoutError:
                log.error("ai_engine timeout url=%s", self._url)
            except aiohttp.ClientError as exc:
                log.error("ai_engine client error: %s", exc)
            finally:
                latency_us = (time.perf_counter_ns() - t0) // 1_000
                log.info("forwarded window agg latency_us=%d", latency_us)

    def emit(self, payload: str) -> None:
        """Schedule a POST on the sink's loop. Non-blocking."""
        loop = self._ensure_loop()
        asyncio.run_coroutine_threadsafe(self._post(payload), loop)

# ---------------------------------------------------------------------------
# Job definition
# ---------------------------------------------------------------------------

def build_pipeline() -> StreamExecutionEnvironment:
    env = StreamExecutionEnvironment.get_execution_environment()
    env.set_parallelism(int(os.getenv("FLINK_PARALLELISM", "2")))

    source = (
        KafkaSource.builder()
        .set_bootstrap_servers(KAFKA_BROKERS)
        .set_topics(KAFKA_TOPIC)
        .set_group_id(KAFKA_GROUP)
        .set_starting_offsets(KafkaOffsetsInitializer.latest())
        .set_value_only_deserializer(SimpleStringSchema())
        .build()
    )

    watermark_strategy = (
        WatermarkStrategy.for_bounded_out_of_orderness(Duration.of_millis(500))
        .with_timestamp_assigner(_TsAssigner())
    )

    raw_stream = env.from_source(source, WatermarkStrategy.no_watermarks(), "kafka-mempool")

    parser = _ParseAndProject()
    parsed = (
        raw_stream
        .map(parser, output_type=Types.TUPLE([Types.STRING(), Types.LONG(), Types.LONG(), Types.LONG()]))
        .filter(lambda x: x is not None)
        .assign_timestamps_and_watermarks(watermark_strategy)
    )

    aggregated = (
        parsed
        .key_by(lambda t: t[0], key_type=Types.STRING())
        .window(TumblingEventTimeWindows.of(Time.seconds(WINDOW_SECONDS)))
        .reduce(_SumReducer(), window_function=_EmitWindow(), output_type=Types.STRING())
    )

    sink = AsyncHttpSink(AI_ENGINE_URL, HTTP_TIMEOUT_S)
    aggregated.map(lambda payload: (sink.emit(payload), payload)[1], output_type=Types.STRING())

    return env


def main() -> None:
    log.info("starting kover time-series aggregator brokers=%s topic=%s", KAFKA_BROKERS, KAFKA_TOPIC)
    env = build_pipeline()
    env.execute("kover-bfd-aggregator")


if __name__ == "__main__":
    main()
