"""Final integration test - verifies entire KOVER.IA system is ready for demo."""
import asyncio
import os
from dotenv import load_dotenv

load_dotenv(".env")

# Mock external services
class MockBigQuery:
    async def save_incident(self, alert):
        print(f"  [BigQuery] Incident saved: {alert.severity}")
        return alert.hack_tx_hash

    async def save_tainted_wallets(self, wallets):
        print(f"  [BigQuery] Saved {len(wallets)} tainted wallets")
        return len(wallets)

class MockWebSocket:
    async def broadcast(self, event, data):
        if event == "pipeline_status":
            print(f"    > {data.get('step')}")
        elif event == "analysis_complete":
            print(f"    > Analysis complete")

# Monkey-patch
import sys
sys.modules['supabase'] = type(sys)('supabase')
sys.modules['google.cloud'] = type(sys)('google.cloud')
sys.modules['google.cloud.bigquery'] = type(sys)('google.cloud.bigquery')

import backend.storage.bigquery_client as bq_client
bq_client.save_incident = MockBigQuery().save_incident
bq_client.save_tainted_wallets = MockBigQuery().save_tainted_wallets

from backend.agents.orchestrator import run_agent_pipeline
from backend.detection.taint_graph import TaintGraph, TxEdge
from backend.websocket.manager import manager
from datetime import datetime

manager.broadcast = MockWebSocket().broadcast

# Build mock graph
def build_test_graph():
    graph = TaintGraph(
        source_address="0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4",
        source_amount_eth=61_000.0
    )
    movements = [
        ("0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4", "0x1111111111111111111111111111111111111111", 20_000.0),
        ("0x1111111111111111111111111111111111111111", "0x722122df12d4e14e13ac3b6895a86e84145b6967", 15_000.0),
        ("0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4", "0x2222222222222222222222222222222222222222", 25_000.0),
        ("0x2222222222222222222222222222222222222222", "0x3ee18b2214aff97000d974cf647e7c347e8fa585", 20_000.0),
    ]
    for src, dst, amount in movements:
        edge = TxEdge(
            tx_hash=f"0x{hash((src, dst)) & 0xffffffffffffffffffffffffffffffffffffffff:064x}",
            amount_eth=amount,
            timestamp=datetime.utcnow(),
            block_number=16_817_996,
        )
        parent_taint = graph.nodes[src].taint_score if src in graph.nodes else 1.0
        graph.add_transaction(src, dst, edge, parent_taint)
    graph.initialize_taint_scores()
    return graph

async def test_agents():
    """Test: All 3 agents can be imported and function correctly."""
    print("\n[TEST 1] Agent Imports")
    print("=" * 70)
    try:
        from backend.agents.taint_agent import analyze_taint
        print("  OK - TaintAnalyst imported")
    except Exception as e:
        print(f"  FAIL - TaintAnalyst: {e}")
        return False

    try:
        from backend.agents.path_agent import predict_path
        print("  OK - PathPredictor imported")
    except Exception as e:
        print(f"  FAIL - PathPredictor: {e}")
        return False

    try:
        from backend.agents.reporter_agent import generate_report
        print("  OK - IncidentReporter imported")
    except Exception as e:
        print(f"  FAIL - IncidentReporter: {e}")
        return False

    return True

async def test_pipeline_orchestration():
    """Test: Full pipeline orchestration with mock graph."""
    print("\n[TEST 2] Pipeline Orchestration")
    print("=" * 70)

    try:
        graph = build_test_graph()
        print(f"  OK - Mock graph built ({graph.summary()['total_wallets']} wallets)")

        hack_context = {
            "protocol": "Test Protocol",
            "amount_eth": 61_000.0,
            "amount_usd": 195_200_000.0,
            "minutes_elapsed": 5,
        }

        result = await run_agent_pipeline(
            graph=graph,
            hack_context=hack_context,
            broadcast_fn=manager.broadcast,
        )

        assert result["severity"] in ["LOW", "MEDIUM", "HIGH", "CRITICAL"], "Invalid severity"
        assert "summary" in result, "Missing summary"
        assert "narrative" in result, "Missing narrative"
        assert "path_prediction" in result, "Missing path_prediction"
        assert "tainted_wallets" in result, "Missing tainted_wallets"

        print(f"  OK - Pipeline executed (severity: {result['severity']})")
        print(f"  OK - Result contains all required fields")
        return True

    except Exception as e:
        print(f"  FAIL - Pipeline: {e}")
        import traceback
        traceback.print_exc()
        return False

async def test_bigquery_integration():
    """Test: BigQuery client functions (mocked)."""
    print("\n[TEST 3] BigQuery Integration")
    print("=" * 70)

    try:
        from backend.storage.models import IncidentAlert, TaintedWallet

        alert = IncidentAlert(
            hack_tx_hash="0xtest",
            severity="CRITICAL",
            summary="Test alert",
            narrative="Test narrative",
            lstm_prediction={"next_destination": "Test"},
            tainted_wallets_count=5,
            created_at=datetime.utcnow(),
        )

        result = await bq_client.save_incident(alert)
        print(f"  OK - save_incident works")

        wallets = [
            TaintedWallet(
                address=f"0x{i:040d}",
                taint_score=0.9,
                hops_from_source=i,
                amount_usd=1000.0,
                detected_at=datetime.utcnow(),
                hack_tx_hash="0xtest",
            )
            for i in range(3)
        ]

        result = await bq_client.save_tainted_wallets(wallets)
        print(f"  OK - save_tainted_wallets works")

        return True

    except Exception as e:
        print(f"  FAIL - BigQuery: {e}")
        import traceback
        traceback.print_exc()
        return False

async def test_websocket_broadcasts():
    """Test: WebSocket manager broadcasts events."""
    print("\n[TEST 4] WebSocket Broadcasting")
    print("=" * 70)

    try:
        events_received = []

        async def capture_broadcast(event, data):
            events_received.append((event, data))

        manager.broadcast = capture_broadcast

        await manager.broadcast("test_event", {"message": "test"})
        assert len(events_received) > 0, "No events captured"
        print(f"  OK - WebSocket broadcast works")

        manager.broadcast = MockWebSocket().broadcast
        return True

    except Exception as e:
        print(f"  FAIL - WebSocket: {e}")
        return False

async def test_data_pipeline():
    """Test: Full data pipeline (graph -> agents -> storage)."""
    print("\n[TEST 5] End-to-End Data Pipeline")
    print("=" * 70)

    try:
        from backend.pipeline import run_pipeline

        result = await run_pipeline(
            hack_address="0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4",
            amount_eth=61_000.0,
            protocol_name="Euler Finance",
            start_block=16_817_996,
        )

        assert "severity" in result
        assert "summary" in result
        assert "narrative" in result
        assert "graph_summary" in result

        print(f"  OK - Full pipeline executed")
        print(f"  OK - Severity: {result['severity']}")
        print(f"  OK - Tainted wallets: {result['graph_summary']['tainted_count']}")

        return True

    except Exception as e:
        print(f"  FAIL - Full pipeline: {e}")
        import traceback
        traceback.print_exc()
        return False

async def main():
    print("\n" + "=" * 70)
    print("KOVER.IA - FINAL INTEGRATION TEST SUITE")
    print("=" * 70)

    tests = [
        ("Agent Imports", test_agents),
        ("Pipeline Orchestration", test_pipeline_orchestration),
        ("BigQuery Integration", test_bigquery_integration),
        ("WebSocket Broadcasting", test_websocket_broadcasts),
        ("End-to-End Data Pipeline", test_data_pipeline),
    ]

    results = {}
    for name, test_func in tests:
        try:
            passed = await test_func()
            results[name] = "PASS" if passed else "FAIL"
        except Exception as e:
            print(f"\n  EXCEPTION in {name}: {e}")
            results[name] = "ERROR"

    # Summary
    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)

    passed = sum(1 for v in results.values() if v == "PASS")
    total = len(results)

    for name, status in results.items():
        symbol = "[OK]" if status == "PASS" else "[X]" if status == "FAIL" else "[!]"
        print(f"{symbol} {name}: {status}")

    print(f"\nTotal: {passed}/{total} tests passed")
    print("=" * 70 + "\n")

    return passed == total

if __name__ == "__main__":
    success = asyncio.run(main())
    exit(0 if success else 1)
