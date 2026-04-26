"""Tests des fonctions async du générateur (GAT/LSTM/Cerebras runs).

On mock les modules externes (gat_scorer, path_lstm, cerebras SDK) pour
isoler la logique d'orchestration et de broadcast WS.
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.streaming import generator as gen


# ── _run_gat_batch ──────────────────────────────────────────────────────────

class TestRunGatBatch:
    @pytest.mark.asyncio
    async def test_skip_if_too_few_nodes(self, monkeypatch):
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        # Moins de 3 nodes
        gen._new_node(0)
        await gen._run_gat_batch()
        broadcast.assert_not_called()

    @pytest.mark.asyncio
    async def test_broadcasts_inference_event(self, monkeypatch):
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        gen._seed_topology()  # 17 nodes

        fake_scorer = MagicMock()
        fake_scorer.MODEL_PATH = MagicMock()
        fake_scorer.MODEL_PATH.exists = MagicMock(return_value=True)
        fake_scorer.score_nodes = MagicMock(return_value={
            list(gen._nodes)[0]: 0.9,
            list(gen._nodes)[1]: 0.5,
        })
        with patch.dict("sys.modules", {"gat_scorer": fake_scorer}):
            await gen._run_gat_batch()

        events = [c.args[0] for c in broadcast.call_args_list]
        assert "gat_inference" in events
        # Score override appliqué sur les nodes
        first = list(gen._nodes)[0]
        assert gen._nodes[first]["score"] == 0.9

    @pytest.mark.asyncio
    async def test_skip_if_checkpoint_missing(self, monkeypatch):
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        gen._seed_topology()
        fake_scorer = MagicMock()
        fake_scorer.MODEL_PATH = MagicMock()
        fake_scorer.MODEL_PATH.exists = MagicMock(return_value=False)
        with patch.dict("sys.modules", {"gat_scorer": fake_scorer}):
            await gen._run_gat_batch()
        # Pas de gat_inference broadcasté quand le checkpoint manque
        events = [c.args[0] for c in broadcast.call_args_list]
        assert "gat_inference" not in events

    @pytest.mark.asyncio
    async def test_emits_ai_error_on_exception(self, monkeypatch):
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        gen._seed_topology()
        fake_scorer = MagicMock()
        fake_scorer.MODEL_PATH = MagicMock()
        fake_scorer.MODEL_PATH.exists = MagicMock(return_value=True)
        fake_scorer.score_nodes = MagicMock(side_effect=RuntimeError("boom"))
        with patch.dict("sys.modules", {"gat_scorer": fake_scorer}):
            await gen._run_gat_batch()
        events = [(c.args[0], c.args[1]) for c in broadcast.call_args_list]
        ai_errors = [e for e in events if e[0] == "ai_error"]
        assert len(ai_errors) == 1
        assert ai_errors[0][1]["model"] == "gat"


# ── _run_lstm ───────────────────────────────────────────────────────────────

class TestRunLstm:
    @pytest.mark.asyncio
    async def test_skip_if_too_few_nodes(self, monkeypatch):
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        # Moins de 5 nodes
        for _ in range(3):
            gen._new_node(0)
        await gen._run_lstm()
        broadcast.assert_not_called()

    @pytest.mark.asyncio
    async def test_broadcasts_lstm_inference(self, monkeypatch):
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        gen._seed_topology()  # 17 nodes

        fake_predict = MagicMock(return_value={
            "destination_type": "Binance",
            "confidence": 0.82,
            "probabilities": {"Uniswap": 0.05, "Binance": 0.82, "Hyperliquid": 0.13},
        })
        fake_load = MagicMock(return_value=MagicMock())
        with patch("backend.models.path_lstm.predict_next", fake_predict), \
             patch("backend.models.path_lstm.load_path_lstm", fake_load):
            await gen._run_lstm()

        events = [c.args[0] for c in broadcast.call_args_list]
        assert "lstm_inference" in events
        payload = next(c.args[1] for c in broadcast.call_args_list if c.args[0] == "lstm_inference")
        assert payload["prediction"] == "Binance"
        assert payload["confidence"] == 0.82

    @pytest.mark.asyncio
    async def test_emits_ai_error_on_exception(self, monkeypatch):
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        gen._seed_topology()
        fake_load = MagicMock(side_effect=RuntimeError("model file corrupt"))
        with patch("backend.models.path_lstm.load_path_lstm", fake_load):
            await gen._run_lstm()
        events = [(c.args[0], c.args[1]) for c in broadcast.call_args_list]
        ai_errors = [e for e in events if e[0] == "ai_error"]
        assert len(ai_errors) == 1
        assert ai_errors[0][1]["model"] == "lstm"


# ── _run_cerebras_streaming ─────────────────────────────────────────────────

class TestCerebrasStreaming:
    @pytest.mark.asyncio
    async def test_skip_when_no_api_key(self, monkeypatch):
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        monkeypatch.delenv("CEREBRAS_API_KEY", raising=False)
        gen._seed_topology()
        await gen._run_cerebras_streaming()
        events = [c.args[0] for c in broadcast.call_args_list]
        assert "cerebras_skipped" in events
        assert "cerebras_start" not in events

    @pytest.mark.asyncio
    async def test_skip_when_no_top_wallets(self, monkeypatch):
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        monkeypatch.setenv("CEREBRAS_API_KEY", "fake")
        # Pas de seed → _nodes vide → top vide
        await gen._run_cerebras_streaming()
        events = [c.args[0] for c in broadcast.call_args_list]
        assert "cerebras_start" not in events

    @pytest.mark.asyncio
    async def test_streams_tokens(self, monkeypatch):
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        monkeypatch.setenv("CEREBRAS_API_KEY", "fake")
        gen._seed_topology()

        # Mock du SDK Cerebras
        chunks = []
        for tok in ["Niveau", " de", " risque", " : ", "élevé."]:
            ch = MagicMock()
            ch.choices = [MagicMock(delta=MagicMock(content=tok))]
            chunks.append(ch)
        # Un chunk vide pour exercer le skip
        empty = MagicMock()
        empty.choices = [MagicMock(delta=MagicMock(content=None))]
        chunks.insert(2, empty)

        fake_client = MagicMock()
        fake_client.chat.completions.create = MagicMock(return_value=iter(chunks))
        fake_cerebras_module = MagicMock()
        fake_cerebras_module.Cerebras = MagicMock(return_value=fake_client)

        fake_reporter = MagicMock()
        fake_reporter._load_few_shot = MagicMock(return_value=[])
        fake_reporter.DEFAULT_MODEL = "qwen-3-235b-a22b-instruct-2507"

        with patch.dict("sys.modules", {
            "cerebras.cloud.sdk": fake_cerebras_module,
            "backend.agents.reporter_agent": fake_reporter,
        }):
            await gen._run_cerebras_streaming()

        events = [c.args[0] for c in broadcast.call_args_list]
        assert "cerebras_start" in events
        assert events.count("cerebras_token") == 5  # 5 vrais tokens
        assert "cerebras_complete" in events

    @pytest.mark.asyncio
    async def test_emits_ai_error_on_exception(self, monkeypatch):
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        monkeypatch.setenv("CEREBRAS_API_KEY", "fake")
        gen._seed_topology()
        fake_cerebras_module = MagicMock()
        fake_cerebras_module.Cerebras = MagicMock(side_effect=RuntimeError("net down"))
        with patch.dict("sys.modules", {"cerebras.cloud.sdk": fake_cerebras_module}):
            await gen._run_cerebras_streaming()
        events = [(c.args[0], c.args[1]) for c in broadcast.call_args_list]
        ai_errors = [e for e in events if e[0] == "ai_error"]
        assert len(ai_errors) == 1
        assert ai_errors[0][1]["model"] == "cerebras"


# ── Stream loop (court-circuit pour test) ──────────────────────────────────

class TestStreamLoop:
    @pytest.mark.asyncio
    async def test_loop_seeds_and_broadcasts_once(self, monkeypatch):
        """On laisse tourner _stream_loop le temps d'un seul tick puis on stop."""
        broadcast = AsyncMock()
        monkeypatch.setattr(gen.manager, "broadcast", broadcast)
        # Court-circuiter les inférences pour rester rapide
        monkeypatch.setattr(gen, "_run_gat_batch", AsyncMock())
        monkeypatch.setattr(gen, "_run_lstm", AsyncMock())
        monkeypatch.setattr(gen, "_run_cerebras_streaming", AsyncMock())
        monkeypatch.setattr(gen, "GEN_INTERVAL_S", 0.05)  # tick rapide

        await gen.start()
        import asyncio as _asyncio
        await _asyncio.sleep(0.2)  # laisse le loop générer ~3-4 tx
        await gen.stop()

        events = [c.args[0] for c in broadcast.call_args_list]
        assert "ai_manifest" in events
        assert "tx_generated" in events
        assert events.count("graph_state") >= 1
