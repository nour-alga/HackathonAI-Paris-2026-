"""Tests du pipeline IA (run_pipeline_from_graph) avec agents mockés."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend import pipeline


class TestRunPipelineFromGraph:
    @pytest.mark.asyncio
    async def test_empty_graph_does_not_crash(self):
        with patch.object(pipeline.manager, "broadcast", AsyncMock()), \
             patch("backend.pipeline.run_agent_pipeline", AsyncMock(return_value={
                "severity": "LOW", "summary": "ok", "narrative": "test",
                "path_prediction": {"next_destination": "Uniswap", "probability": 0.5},
                "graph_summary": {}, "tainted_wallets": [],
             })):
            result = await pipeline.run_pipeline_from_graph(
                nodes=[], edges=[], seed_address=None, amount_eth=10.0
            )
            assert "severity" in result
            assert result["severity"] == "LOW"

    @pytest.mark.asyncio
    async def test_with_real_nodes_invokes_agents(self):
        nodes = [
            {"id": "0xa", "score": 0.9, "balance": 1.0, "hops": 0},
            {"id": "0xb", "score": 0.5, "balance": 0.5, "hops": 1},
        ]
        edges = [{"source": "0xa", "target": "0xb", "amount": 0.5}]
        agent_mock = AsyncMock(return_value={
            "severity": "CRITICAL", "summary": "summary",
            "narrative": "narrative",
            "path_prediction": {"next_destination": "Binance", "probability": 0.8},
            "graph_summary": {"tainted_count": 2},
            "tainted_wallets": [],
        })
        with patch.object(pipeline.manager, "broadcast", AsyncMock()), \
             patch("backend.pipeline.run_agent_pipeline", agent_mock):
            result = await pipeline.run_pipeline_from_graph(
                nodes=nodes, edges=edges, seed_address="0xa", amount_eth=2.0
            )
            assert result["severity"] == "CRITICAL"
            agent_mock.assert_called_once()

    @pytest.mark.asyncio
    async def test_chooses_seed_from_max_score_when_not_provided(self):
        nodes = [
            {"id": "0xa", "score": 0.2, "balance": 1.0, "hops": 1},
            {"id": "0xtop", "score": 0.95, "balance": 5.0, "hops": 0},
            {"id": "0xc", "score": 0.4, "balance": 2.0, "hops": 2},
        ]
        edges = [{"source": "0xa", "target": "0xc", "amount": 1.0}]

        captured = {}

        async def capture_agent(graph, hack_context, broadcast_fn):
            captured["seed"] = graph.source
            return {
                "severity": "MEDIUM", "summary": "", "narrative": "",
                "path_prediction": {}, "graph_summary": {}, "tainted_wallets": [],
            }

        with patch.object(pipeline.manager, "broadcast", AsyncMock()), \
             patch("backend.pipeline.run_agent_pipeline", capture_agent):
            await pipeline.run_pipeline_from_graph(nodes=nodes, edges=edges, seed_address=None)
        assert captured["seed"] == "0xtop"

    @pytest.mark.asyncio
    async def test_broadcast_events_sequence(self):
        broadcast = AsyncMock()
        with patch.object(pipeline.manager, "broadcast", broadcast), \
             patch("backend.pipeline.run_agent_pipeline", AsyncMock(return_value={
                "severity": "HIGH", "summary": "", "narrative": "",
                "path_prediction": {}, "graph_summary": {}, "tainted_wallets": [],
             })):
            await pipeline.run_pipeline_from_graph(
                nodes=[{"id": "0xa", "score": 0.5, "balance": 1.0, "hops": 0}],
                edges=[], seed_address="0xa",
            )
        events = [call.args[0] for call in broadcast.call_args_list]
        assert "pipeline_status" in events
        assert "graph_update" in events
        assert "analysis_complete" in events

    @pytest.mark.asyncio
    async def test_amount_eth_defaults_to_sum_of_edge_amounts(self):
        edges = [
            {"source": "0xa", "target": "0xb", "amount": 1.5},
            {"source": "0xb", "target": "0xc", "amount": 2.5},
        ]
        captured = {}

        async def capture_agent(graph, hack_context, broadcast_fn):
            captured["amount"] = hack_context["amount_eth"]
            return {"severity": "LOW", "summary": "", "narrative": "",
                    "path_prediction": {}, "graph_summary": {}, "tainted_wallets": []}

        with patch.object(pipeline.manager, "broadcast", AsyncMock()), \
             patch("backend.pipeline.run_agent_pipeline", capture_agent):
            await pipeline.run_pipeline_from_graph(
                nodes=[{"id": "0xa"}, {"id": "0xb"}, {"id": "0xc"}],
                edges=edges, seed_address="0xa", amount_eth=None,
            )
        assert captured["amount"] == pytest.approx(4.0)


class TestEdgeCases:
    @pytest.mark.asyncio
    async def test_skips_edges_with_missing_endpoints(self):
        nodes = [{"id": "0xa", "score": 0.9, "balance": 1.0, "hops": 0}]
        edges = [
            {"source": "", "target": "0xb", "amount": 1.0},
            {"source": "0xa", "target": None, "amount": 0.5},
            {"source": "0xa", "target": "0xc", "amount": 0.3},
        ]
        with patch.object(pipeline.manager, "broadcast", AsyncMock()), \
             patch("backend.pipeline.run_agent_pipeline", AsyncMock(return_value={
                "severity": "LOW", "summary": "", "narrative": "",
                "path_prediction": {}, "graph_summary": {}, "tainted_wallets": [],
             })):
            result = await pipeline.run_pipeline_from_graph(
                nodes=nodes, edges=edges, seed_address="0xa"
            )
        assert "severity" in result

    @pytest.mark.asyncio
    async def test_auto_creates_missing_nodes_for_edges(self):
        edges = [{"source": "0xnewsrc", "target": "0xnewdst", "amount": 1.0}]
        with patch.object(pipeline.manager, "broadcast", AsyncMock()), \
             patch("backend.pipeline.run_agent_pipeline", AsyncMock(return_value={
                "severity": "LOW", "summary": "", "narrative": "",
                "path_prediction": {}, "graph_summary": {}, "tainted_wallets": [],
             })):
            result = await pipeline.run_pipeline_from_graph(
                nodes=[], edges=edges, seed_address="0xnewsrc"
            )
        assert result["severity"] == "LOW"

    @pytest.mark.asyncio
    async def test_gat_override_handles_exception_gracefully(self):
        nodes = [{"id": "0xa", "score": 0.5, "balance": 1.0, "hops": 0}]
        import sys as _sys
        bad_scorer = MagicMock()
        bad_scorer.MODEL_PATH = MagicMock()
        bad_scorer.MODEL_PATH.exists = MagicMock(return_value=True)
        bad_scorer.score_nodes = MagicMock(side_effect=RuntimeError("torch broken"))
        with patch.object(pipeline.manager, "broadcast", AsyncMock()), \
             patch("backend.pipeline.run_agent_pipeline", AsyncMock(return_value={
                "severity": "LOW", "summary": "", "narrative": "",
                "path_prediction": {}, "graph_summary": {}, "tainted_wallets": [],
             })), \
             patch.dict(_sys.modules, {"gat_scorer": bad_scorer}):
            result = await pipeline.run_pipeline_from_graph(
                nodes=nodes, edges=[], seed_address="0xa"
            )
        assert result["severity"] == "LOW"

    @pytest.mark.asyncio
    async def test_run_pipeline_etherscan_branch_with_mocks(self):
        """Couvre run_pipeline (la branche Etherscan) en mockant build_taint_graph."""
        from backend.detection.taint_graph import TaintGraph

        fake_graph = TaintGraph("0xhack", 100.0)
        fake_graph._add_node("0xa", taint_raw=0.7, hops=1, amount_eth=10.0)
        fake_graph.initialize_taint_scores()

        async def fake_build(*args, **kwargs):
            return fake_graph

        async def fake_save(_):
            return "ok"

        async def fake_save_wallets(_):
            return 0

        with patch("backend.pipeline.build_taint_graph", fake_build), \
             patch("backend.pipeline.save_incident", fake_save), \
             patch("backend.pipeline.save_tainted_wallets", fake_save_wallets), \
             patch.object(pipeline.manager, "broadcast", AsyncMock()), \
             patch("backend.pipeline.run_agent_pipeline", AsyncMock(return_value={
                "severity": "HIGH", "summary": "summary",
                "narrative": "narrative",
                "path_prediction": {"next_destination": "Binance"},
                "graph_summary": {"tainted_count": 1},
                "tainted_wallets": [],
             })):
            result = await pipeline.run_pipeline(
                hack_address="0xhack",
                amount_eth=100.0,
                protocol_name="TestProtocol",
                start_block=0,
            )
        assert result["severity"] == "HIGH"
        assert "graph_summary" in result
