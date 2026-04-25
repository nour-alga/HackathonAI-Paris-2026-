"""Test complet du pipeline KOVER.IA avec données Euler Finance."""
import asyncio
import os
from dotenv import load_dotenv

load_dotenv(".env")

# Mock les services externes pour le test
class MockBigQuery:
    async def save_incident(self, alert):
        print(f"[BigQuery] Saved incident: {alert.severity} - {alert.summary}")
        return alert.hack_tx_hash

    async def save_tainted_wallets(self, wallets):
        print(f"[BigQuery] Saved {len(wallets)} tainted wallets")
        return len(wallets)

class MockWebSocket:
    async def broadcast(self, event, data):
        print(f"[WebSocket] {event}: {data}")

# Monkey-patch les imports
import sys
sys.modules['supabase'] = type(sys)('supabase')
sys.modules['google.cloud'] = type(sys)('google.cloud')
sys.modules['google.cloud.bigquery'] = type(sys)('google.cloud.bigquery')

# Patches
import backend.storage.bigquery_client as bq_client
bq_client.save_incident = MockBigQuery().save_incident
bq_client.save_tainted_wallets = MockBigQuery().save_tainted_wallets

# Now import the pipeline
from backend.pipeline import run_pipeline
from backend.websocket.manager import manager

# Override manager broadcast
manager.broadcast = MockWebSocket().broadcast

# ─── Données Euler Finance Hack ──────────────────────────────────
EULER_HACK = {
    "address": "0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4",
    "amount_eth": 61_000.0,      # ~$197M au prix de l'époque
    "protocol_name": "Euler Finance",
    "start_block": 16_817_996,   # bloc du hack (13 mars 2023)
}

async def main():
    print("=" * 70)
    print("KOVER.IA — Test complet du pipeline")
    print("=" * 70)
    print(f"\nHack: {EULER_HACK['protocol_name']}")
    print(f"Address: {EULER_HACK['address']}")
    print(f"Amount: {EULER_HACK['amount_eth']:.0f} ETH")
    print(f"Block: {EULER_HACK['start_block']}")
    print("\n" + "=" * 70)
    print("Lancement du pipeline...")
    print("=" * 70 + "\n")

    try:
        result = await run_pipeline(
            hack_address=EULER_HACK['address'],
            amount_eth=EULER_HACK['amount_eth'],
            protocol_name=EULER_HACK['protocol_name'],
            start_block=EULER_HACK['start_block'],
        )

        print("\n" + "=" * 70)
        print("RÉSULTATS DU PIPELINE")
        print("=" * 70)

        print(f"\nSévérité: {result['severity']}")
        print(f"Résumé: {result['summary']}")

        print(f"\nNarratif (premiers 500 chars):\n{result['narrative'][:500]}")

        if 'graph_summary' in result:
            summary = result['graph_summary']
            print(f"\nGraphe:")
            print(f"  - Total wallets: {summary.get('total_wallets', 0)}")
            print(f"  - Tainted count: {summary.get('tainted_count', 0)}")
            print(f"  - Max taint score: {summary.get('max_taint_score', 0):.2f}")
            print(f"  - Hops reached: {summary.get('hops_reached', 0)}")

        if 'tainted_wallets' in result:
            print(f"\nTop 5 Tainted Wallets:")
            for i, w in enumerate(result['tainted_wallets'][:5], 1):
                print(f"  {i}. {w['address'][:10]}... (score: {w['score']:.2f}, type: {w['type']})")

        print("\n" + "=" * 70)
        print("SUCCESS - Pipeline completed!")
        print("=" * 70)

    except Exception as e:
        print(f"\nERROR in pipeline: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
