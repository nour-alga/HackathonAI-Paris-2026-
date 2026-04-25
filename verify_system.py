"""
System verification script — tests all components work together.
Run this before jury presentation to ensure everything is ready.
"""
import asyncio
import sys
from datetime import datetime


async def test_imports():
    """Verify all modules can be imported."""
    print("[1/5] Testing imports...", end=" ")
    try:
        from backend.detection.taint_graph import TaintGraph
        from backend.agents.orchestrator import run_agent_pipeline
        from backend.agents.path_agent import predict_path
        from backend.agents.reporter_agent import generate_report
        print("OK")
        return True
    except Exception as e:
        print(f"FAILED: {e}")
        return False


async def test_taint_graph():
    """Verify TaintGraph algorithm works."""
    print("[2/5] Testing TaintGraph algorithm...", end=" ")
    try:
        from backend.detection.taint_graph import TaintGraph, TxEdge

        graph = TaintGraph(
            source_address="0xtest1",
            source_amount_eth=100.0
        )

        edge = TxEdge(
            tx_hash="0xhash1",
            amount_eth=50.0,
            timestamp=datetime.utcnow(),
            block_number=12345,
        )

        graph.add_transaction("0xtest1", "0xtest2", edge, 1.0)
        graph.initialize_taint_scores()

        summary = graph.summary()
        assert summary['total_wallets'] > 0, "No wallets detected"
        print("OK")
        return True
    except Exception as e:
        print(f"FAILED: {e}")
        return False


async def test_path_prediction():
    """Verify PathPredictor LSTM works."""
    print("[3/5] Testing PathPredictor LSTM...", end=" ")
    try:
        from backend.agents.path_agent import predict_path
        from backend.detection.taint_graph import TaintGraph

        graph = TaintGraph("0xtest", 100.0)

        result = predict_path(
            tainted_count=5,
            max_taint_score=0.85,
            move_sequence=["0xtest1", "0xtest2"],
            amount_eth=100.0,
            protocol="Test Protocol",
            graph=graph,
        )

        assert "next_destination" in result
        assert "probability" in result
        assert "eta_minutes" in result
        print("OK")
        return True
    except Exception as e:
        print(f"FAILED: {e}")
        return False


async def test_reporter():
    """Verify IncidentReporter LLM works."""
    print("[4/5] Testing IncidentReporter LLM...", end=" ")
    try:
        from backend.agents.reporter_agent import generate_report

        result = generate_report(
            taint_analysis={
                "0xtest1": {"taint_score": 0.9, "hops": 1, "type": "unknown"}
            },
            path_prediction={
                "next_destination": "Tornado Cash",
                "probability": 0.92,
                "eta_minutes": 8,
                "reasoning": "Pattern matches known behavior"
            },
            hack_context={
                "protocol": "Test Protocol",
                "amount_eth": 100.0,
                "amount_usd": 320000.0,
                "minutes_elapsed": 5,
            }
        )

        assert isinstance(result, str)
        assert len(result) > 100, "Report too short"
        print("OK")
        return True
    except Exception as e:
        print(f"FAILED: {e}")
        return False


async def test_orchestrator():
    """Verify full pipeline orchestration works."""
    print("[5/5] Testing full pipeline orchestration...", end=" ")
    try:
        from backend.detection.taint_graph import TaintGraph, TxEdge
        from backend.agents.orchestrator import run_agent_pipeline

        # Build minimal graph
        graph = TaintGraph(
            source_address="0xeulator1",
            source_amount_eth=100.0
        )
        edge = TxEdge(
            tx_hash="0xhash",
            amount_eth=100.0,
            timestamp=datetime.utcnow(),
            block_number=16817996,
        )
        graph.add_transaction("0xeulator1", "0xeulator2", edge, 1.0)
        graph.initialize_taint_scores()

        # Run pipeline
        result = await run_agent_pipeline(
            graph=graph,
            hack_context={
                "protocol": "Test Protocol",
                "amount_eth": 100.0,
                "amount_usd": 320000.0,
                "minutes_elapsed": 0,
            },
            broadcast_fn=None,  # No WebSocket for test
        )

        assert "severity" in result
        assert "narrative" in result
        assert "path_prediction" in result
        assert len(result["narrative"]) > 100
        print("OK")
        return True
    except Exception as e:
        print(f"FAILED: {e}")
        return False


async def main():
    """Run all verification tests."""
    print("\n" + "="*70)
    print("KOVER.IA — System Verification")
    print("="*70 + "\n")

    results = []
    results.append(await test_imports())
    results.append(await test_taint_graph())
    results.append(await test_path_prediction())
    results.append(await test_reporter())
    results.append(await test_orchestrator())

    print("\n" + "="*70)
    passed = sum(results)
    total = len(results)

    if passed == total:
        print(f"RESULT: ALL TESTS PASSED ({passed}/{total}) ✓")
        print("="*70)
        print("\nSystem is ready for jury presentation.")
        print("\nTo start backend:")
        print("  uvicorn backend.main:app --reload")
        print("\nTo run demo:")
        print("  python demo_realtime.py")
        print("="*70 + "\n")
        return 0
    else:
        print(f"RESULT: {passed}/{total} tests passed")
        print("="*70)
        print("Fix failing components before jury presentation.")
        print("="*70 + "\n")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
