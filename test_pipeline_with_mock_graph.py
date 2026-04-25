"""Test du pipeline avec graphe mocké (pas besoin d'Etherscan/BigQuery)."""
import asyncio
import os
from dotenv import load_dotenv

load_dotenv(".env")

# ─── Mock Graph Builder ──────────────────────────────────────────
from backend.detection.taint_graph import TaintGraph, TxEdge
from datetime import datetime

def build_mock_euler_graph():
    """Construit un graphe mocké du hack Euler Finance."""
    graph = TaintGraph(
        source_address="0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4",
        source_amount_eth=61_000.0
    )

    # Simuler le mouvement des fonds volés
    movements = [
        # (from, to, amount_eth, entity_type)
        ("0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4", "0x1111111111111111111111111111111111111111", 20_000.0, "unknown"),
        ("0x1111111111111111111111111111111111111111", "0x722122df12d4e14e13ac3b6895a86e84145b6967", 15_000.0, "tornado_cash"),
        ("0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4", "0x2222222222222222222222222222222222222222", 25_000.0, "unknown"),
        ("0x2222222222222222222222222222222222222222", "0x3ee18b2214aff97000d974cf647e7c347e8fa585", 20_000.0, "bridge_crosschain"),
        ("0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4", "0x3333333333333333333333333333333333333333", 16_000.0, "unknown"),
        ("0x3333333333333333333333333333333333333333", "0xd551234ae421e3bcba99a0da6d736074f22192ff", 12_000.0, "depot_cex"),
    ]

    for src, dst, amount, entity in movements:
        edge = TxEdge(
            tx_hash=f"0x{hash((src, dst, amount)) & 0xffffffffffffffffffffffffffffffffffffffff:064x}",
            amount_eth=amount,
            timestamp=datetime.utcnow(),
            block_number=16_817_996,
        )

        parent_taint = graph.nodes[src].taint_score if src in graph.nodes else 1.0
        graph.add_transaction(src, dst, edge, parent_taint)

    graph.initialize_taint_scores()
    return graph

# ─── Mock Services ──────────────────────────────────────────────
class MockBigQuery:
    async def save_incident(self, alert):
        print(f"\n[BigQuery] Incident saved:")
        print(f"  Hash: {alert.hack_tx_hash}")
        print(f"  Severity: {alert.severity}")
        return alert.hack_tx_hash

    async def save_tainted_wallets(self, wallets):
        print(f"[BigQuery] Saved {len(wallets)} tainted wallets")
        return len(wallets)

class MockDiscord:
    async def send_alert(self, severity, summary, details, tx_hash):
        print(f"\n[Discord] ALERT")
        print(f"  [{severity}] {summary}")

class MockWebSocket:
    async def broadcast(self, event, data):
        if event == "pipeline_status":
            print(f"\n[Pipeline] Step: {data.get('step')} (agent: {data.get('agent', 'N/A')})")
        elif event == "graph_update":
            print(f"[Graph] {len(data['nodes'])} nodes, {len(data['edges'])} edges")
        elif event == "agent_result":
            print(f"  > Agent {data.get('agent')}: {data}")

# Patch
import sys
sys.modules['supabase'] = type(sys)('supabase')
sys.modules['google.cloud'] = type(sys)('google.cloud')
sys.modules['google.cloud.bigquery'] = type(sys)('google.cloud.bigquery')

import backend.storage.bigquery_client as bq_client
bq_client.save_incident = MockBigQuery().save_incident
bq_client.save_tainted_wallets = MockBigQuery().save_tainted_wallets

import backend.alerting.discord as discord_client
discord_client.send_alert = MockDiscord().send_alert

from backend.agents.orchestrator import run_agent_pipeline
from backend.websocket.manager import manager
manager.broadcast = MockWebSocket().broadcast

# ─── Test ───────────────────────────────────────────────────────
async def main():
    print("\n" + "=" * 70)
    print("KOVER.IA - Full test with mocked graph")
    print("=" * 70)

    print("\n[1] Building mocked graph (Euler Finance)...")
    graph = build_mock_euler_graph()

    summary = graph.summary()
    print(f"    OK {summary['total_wallets']} wallets, {summary['tainted_count']} tainted")
    print(f"    OK Max taint: {summary['max_taint_score']:.2f}")
    print(f"    OK Movement: {' -> '.join(summary['move_sequence'])}")

    print("\n[2] Starting multi-agent pipeline...")
    print("    (TaintAnalyst -> PathPredictor -> IncidentReporter)")

    hack_context = {
        "protocol": "Euler Finance",
        "amount_eth": 61_000.0,
        "amount_usd": 197_000_000.0,
        "minutes_elapsed": 5,
    }

    try:
        result = await run_agent_pipeline(
            graph=graph,
            hack_context=hack_context,
            broadcast_fn=manager.broadcast,
        )

        print("\n" + "=" * 70)
        print("RESULTS")
        print("=" * 70)

        print(f"\nSeverity: {result['severity']}")
        print(f"Summary: {result['summary']}")

        print(f"\nIA Report (first 400 chars):")
        print(f"  {result['narrative'][:400]}...")

        if 'path_prediction' in result:
            pred = result['path_prediction']
            print(f"\nDestination prediction:")
            print(f"  -> {pred.get('next_destination')} ({pred.get('probability', 0):.0%} probability)")
            print(f"  ETA: {pred.get('eta_minutes')} minutes")

        print(f"\nTop tainted wallets:")
        for i, w in enumerate(result.get('tainted_wallets', [])[:3], 1):
            print(f"  {i}. {w['address'][:16]}... score={w['score']:.2f} ({w['type']})")

        print("\n" + "=" * 70)
        print("SUCCESS - Pipeline completed!")
        print("=" * 70 + "\n")

    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
