"""Google BigQuery client pour la persistence des incidents et wallets taintés."""
import os
from datetime import datetime
from typing import Optional

from google.cloud import bigquery

from backend.storage.models import TaintedWallet, IncidentAlert

# Client BigQuery (authentifié via GOOGLE_APPLICATION_CREDENTIALS)
_client: Optional[bigquery.Client] = None

PROJECT_ID = os.getenv("GCP_PROJECT_ID", "")
DATASET_ID = os.getenv("BIGQUERY_DATASET", "kover_ia")

# Tables
INCIDENTS_TABLE = f"{PROJECT_ID}.{DATASET_ID}.incidents"
TAINTED_WALLETS_TABLE = f"{PROJECT_ID}.{DATASET_ID}.tainted_wallets"


def get_client() -> bigquery.Client:
    """Retourne le client BigQuery singleton."""
    global _client
    if _client is None:
        _client = bigquery.Client(project=PROJECT_ID)
    return _client


async def save_incident(alert: IncidentAlert) -> str:
    """Sauvegarde un incident dans BigQuery. Retourne l'ID de la ligne."""
    client = get_client()

    row = {
        "hack_tx_hash": alert.hack_tx_hash,
        "severity": alert.severity,
        "summary": alert.summary,
        "narrative": alert.narrative,
        "tainted_wallets_count": alert.tainted_wallets_count,
        "lstm_prediction": alert.lstm_prediction,
        "created_at": datetime.utcnow().isoformat(),
        "acknowledged": False,
    }

    errors = client.insert_rows_json(INCIDENTS_TABLE, [row])
    if errors:
        raise Exception(f"BigQuery insert errors: {errors}")

    return alert.hack_tx_hash


async def save_tainted_wallets(wallets: list[TaintedWallet]) -> int:
    """Sauvegarde une liste de wallets taintés. Retourne le count."""
    if not wallets:
        return 0

    client = get_client()

    rows = [
        {
            "address": w.address,
            "taint_score": float(w.taint_score),
            "hops_from_source": w.hops_from_source,
            "amount_usd": float(w.amount_usd),
            "detected_at": w.detected_at.isoformat() if isinstance(w.detected_at, datetime) else w.detected_at,
            "hack_tx_hash": w.hack_tx_hash,
        }
        for w in wallets
    ]

    errors = client.insert_rows_json(TAINTED_WALLETS_TABLE, rows)
    if errors:
        raise Exception(f"BigQuery insert errors: {errors}")

    return len(wallets)


async def get_recent_incidents(limit: int = 20) -> list[dict]:
    """Récupère les derniers incidents."""
    client = get_client()

    query = f"""
    SELECT
        hack_tx_hash,
        severity,
        summary,
        narrative,
        tainted_wallets_count,
        created_at,
        acknowledged
    FROM `{INCIDENTS_TABLE}`
    ORDER BY created_at DESC
    LIMIT {limit}
    """

    results = client.query(query).to_list(max_results=limit)
    return [dict(row) for row in results]
