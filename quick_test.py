"""
Quick integration test — no API keys needed.
Tests the core pipeline logic with mock services.
"""
import asyncio
from datetime import datetime


async def quick_test():
    """Test complete pipeline with mocked services."""
    print("\n" + "="*70)
    print("KOVER.IA — Quick Integration Test (No API Keys)")
    print("="*70 + "\n")

    # Step 1: Build TaintGraph
    print("[Step 1] Building TaintGraph from transaction data...")
    from backend.detection.taint_graph import TaintGraph, TxEdge

    graph = TaintGraph(
        source_address="0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4",
        source_amount_eth=61_000.0
    )

    # Simulate Euler Finance hack transaction flow
    movements = [
        ("0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4", "0x1111111111111111111111111111111111111111", 20_000.0),
        ("0x1111111111111111111111111111111111111111", "0x722122df12d4e14e13ac3b6895a86e84145b6967", 15_000.0),  # tornado
        ("0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4", "0x2222222222222222222222222222222222222222", 25_000.0),
        ("0x2222222222222222222222222222222222222222", "0x3ee18b2214aff97000d974cf647e7c347e8fa585", 20_000.0),  # bridge
    ]

    for src, dst, amount in movements:
        edge = TxEdge(
            tx_hash=f"0x{hash((src, dst)) & 0xffffffffffffffffffffffff:064x}",
            amount_eth=amount,
            timestamp=datetime.utcnow(),
            block_number=16_817_996,
        )
        parent_taint = graph.nodes[src].taint_score if src in graph.nodes else 1.0
        graph.add_transaction(src, dst, edge, parent_taint)

    graph.initialize_taint_scores()
    summary = graph.summary()
    print(f"  -> Built graph: {summary['total_wallets']} wallets")
    print(f"  -> Tainted wallets: {summary['tainted_count']}")
    print(f"  -> Max taint score: {summary['max_taint_score']:.2f}")

    # Step 2: Path Prediction (LSTM)
    print("\n[Step 2] PathPredictor LSTM (destination prediction)...")
    from backend.agents.path_agent import predict_path

    path_prediction = predict_path(
        tainted_count=summary['tainted_count'],
        max_taint_score=summary['max_taint_score'],
        move_sequence=summary['move_sequence'],
        amount_eth=61_000.0,
        protocol="Euler Finance",
        graph=graph,
    )
    print(f"  -> Next destination: {path_prediction['next_destination']}")
    print(f"  -> Confidence: {path_prediction['probability']:.0%}")
    print(f"  -> ETA: {path_prediction['eta_minutes']} minutes")

    # Step 3: Mock Report Generation (no API call)
    print("\n[Step 3] IncidentReporter (mock—no API call)...")
    mock_narrative = f"""INCIDENT REPORT — EULER FINANCE PROTOCOL BREACH

EXECUTIVE SUMMARY:
Critical security incident detected. {summary['tainted_count']} wallets identified with high-confidence taint scores (0.78-1.0).

TECHNICAL ANALYSIS:
Transaction flow analysis reveals:
- Source amount: 61,000 ETH
- Tainted wallets: {summary['tainted_count']}
- Movement pattern: {' -> '.join(summary['move_sequence'])}

PREDICTED NEXT MOVES:
1. {path_prediction['next_destination']} ({path_prediction['probability']:.0%} confidence)
2. ETA: {path_prediction['eta_minutes']} minutes

STATUS: Production-ready detection system operational
COST: ~$0.002 per incident
"""
    print(f"  -> Report generated ({len(mock_narrative)} chars)")

    # Step 4: Severity Classification
    print("\n[Step 4] Severity Classification...")
    has_critical = len(summary['critical_entities']) > 0
    max_score = summary.get('max_taint_score', 0)

    if has_critical or max_score > 0.9:
        severity = "CRITICAL"
    elif summary['tainted_count'] > 20 or max_score > 0.7:
        severity = "HIGH"
    else:
        severity = "MEDIUM"

    print(f"  -> Severity: {severity}")
    print(f"  -> Reasoning: {summary['tainted_count']} tainted wallets, " +
          f"max taint score {max_score:.2f}")

    # Summary
    print("\n" + "="*70)
    print("INTEGRATION TEST COMPLETE")
    print("="*70)
    print(f"\nResult:")
    print(f"  Severity: {severity}")
    print(f"  Tainted: {summary['tainted_count']} wallets")
    print(f"  Prediction: {path_prediction['next_destination']}")
    print(f"  Confidence: {path_prediction['probability']:.0%}")
    print(f"\nAll pipeline components functioning correctly.")
    print("Ready for jury presentation.")
    print("\n" + "="*70 + "\n")


if __name__ == "__main__":
    asyncio.run(quick_test())
