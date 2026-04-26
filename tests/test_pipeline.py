"""Tests du pipeline IA (run_pipeline_from_graph) avec agents mockés."""
from unittest.mock import AsyncMock, patch

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
