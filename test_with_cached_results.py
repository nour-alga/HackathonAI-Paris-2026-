"""Test avec resultats agents en cache (pas d'appels Cerebras)."""
import asyncio
import json

# Mock agents avec resultats pre-computes (PathPredictor + IncidentReporter)

def mock_predict_path(tainted_count, max_taint_score, move_sequence, amount_eth, protocol):
    return {
        "next_destination": "Tornado Cash Mixing Pool",
        "probability": 0.92,
        "eta_minutes": 8,
        "reasoning": "Pattern matches known Euler hack flow - immediate mixing behavior"
    }

def mock_generate_report(taint_analysis, path_prediction, hack_context):
    return """INCIDENT REPORT - EULER FINANCE PROTOCOL BREACH

EXECUTIVE SUMMARY:
Critical security incident detected on Euler Finance. Approximately 61,000 ETH ($197M USD) identified as flowing through suspicious wallets with high-confidence taint scores (0.78-1.0). Immediate protocol shutdown and law enforcement notification recommended.

TECHNICAL ANALYSIS:
The source address (0xb269...) has initiated 6 major transactions within minutes of the exploit detection. Transaction flow analysis reveals:
- 20,000 ETH split into consolidation wallets
- 15,000 ETH routed to Tornado Cash mixer
- 25,000 ETH destined for cross-chain bridge (Wormhole)
- 1,000 ETH in CEX deposit wallets (Binance hot wallets)

Network analysis indicates sophisticated laundering methodology: immediate splitting, parallel routing through multiple anonymization vectors (Tornado Cash + Wormhole bridge), and CEX deposit attempts.

ATTACKER NEXT MOVES:
1. Complete Tornado Cash mixing cycle (8-15 minutes remaining)
2. Initiate cross-chain bridge transactions to Solana/Polygon
3. Deposit mixed funds into CEX hot wallets via multiple accounts
4. Withdrawal to cold storage wallets after 72-hour regulatory delay window

CONFIDENCE: 92% - Pattern matches known Euler Finance attacker operational timeline

IMMEDIATE ACTIONS REQUIRED:
1. [CRITICAL] Pause all outbound transfers from affected protocol immediately
2. [CRITICAL] Notify liquidity providers and users of potential insolvency
3. [URGENT] Coordinate with Tornado Cash protocol monitors for transaction tracking
4. [URGENT] Alert Binance/Kraken/Coinbase security teams of incoming deposit attempts
5. [HIGH] File incident report with CISA and local law enforcement
6. [HIGH] Begin forensic analysis of transaction signatures for attacker attribution

TIME TO ACT: <30 minutes before maximum funds are irretrievably mixed"""

# Mock services
class MockBigQuery:
    async def save_incident(self, alert):
        print(f"\n[BigQuery] Incident saved:")
        print(f"  Hash: {alert.hack_tx_hash[:16]}...")
        print(f"  Severity: {alert.severity}")
        return alert.hack_tx_hash

    async def save_tainted_wallets(self, wallets):
        print(f"[BigQuery] Saved {len(wallets)} tainted wallets")
        return len(wallets)

class MockDiscord:
    async def send_alert(self, severity, summary, details, tx_hash):
        print(f"\n[Discord Alert]")
        print(f"  [{severity}] {summary}")

class MockWebSocket:
    async def broadcast(self, event, data):
        if event == "pipeline_status":
            print(f"\n[>] {data.get('step')} ({data.get('agent', '')})")

# Patch
import sys
sys.modules['supabase'] = type(sys)('supabase')
sys.modules['google.cloud'] = type(sys)('google.cloud')
sys.modules['google.cloud.bigquery'] = type(sys)('google.cloud.bigquery')

import backend.agents.path_agent as pa
import backend.agents.reporter_agent as ra
pa.predict_path = mock_predict_path
ra.generate_report = mock_generate_report

import backend.storage.bigquery_client as bq
bq.save_incident = MockBigQuery().save_incident
bq.save_tainted_wallets = MockBigQuery().save_tainted_wallets

import backend.alerting.discord as discord
discord.send_alert = MockDiscord().send_alert

from backend.detection.taint_graph import TaintGraph, TxEdge
from backend.agents.orchestrator import run_agent_pipeline
from backend.websocket.manager import manager
from datetime import datetime

manager.broadcast = MockWebSocket().broadcast

# Build mock graph
def build_graph():
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
            tx_hash=f"0x{hash((src, dst)) & 0xffffffffffffffffffffffff:064x}",
            amount_eth=amount,
            timestamp=datetime.utcnow(),
            block_number=16_817_996,
        )
        parent_taint = graph.nodes[src].taint_score if src in graph.nodes else 1.0
        graph.add_transaction(src, dst, edge, parent_taint)
    graph.initialize_taint_scores()
    return graph

async def main():
    print("\n" + "=" * 75)
    print("KOVER.IA - EULER FINANCE HACK DETECTION TEST")
    print("=" * 75)

    graph = build_graph()
    summary = graph.summary()

    print(f"\nGraphe: {summary['total_wallets']} wallets detected")
    print(f"Movement pattern: {' -> '.join(summary['move_sequence'])}")

    hack_context = {
        "protocol": "Euler Finance",
        "amount_eth": 61_000.0,
        "amount_usd": 197_000_000.0,
        "minutes_elapsed": 2,
    }

    result = await run_agent_pipeline(graph, hack_context, manager.broadcast)

    print("\n" + "=" * 75)
    print("ANALYSIS RESULTS")
    print("=" * 75)

    print(f"\nSEVERITY: {result['severity']}")
    print(f"SUMMARY: {result['summary']}\n")

    print("FULL INCIDENT REPORT:")
    print("-" * 75)
    print(result['narrative'])
    print("-" * 75)

    print(f"\nDESTINATION PREDICTION:")
    print(f"  Next target: {result['path_prediction']['next_destination']}")
    print(f"  Confidence: {result['path_prediction']['probability']:.0%}")
    print(f"  ETA: {result['path_prediction']['eta_minutes']} minutes")

    print("\n" + "=" * 75)
    print("SUCCESS - Full pipeline completed")
    print("=" * 75 + "\n")

if __name__ == "__main__":
    asyncio.run(main())
