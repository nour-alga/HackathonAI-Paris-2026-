"""Client Supabase — persistance des incidents et wallets taintés."""
import os
from datetime import datetime
from supabase import create_client, Client
from .models import TaintedWallet, IncidentAlert

_client: Client | None = None

CREATE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS tainted_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address TEXT NOT NULL,
  taint_score FLOAT,
  hops_from_source INTEGER,
  amount_usd FLOAT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  hack_tx_hash TEXT,
  entity_type TEXT DEFAULT 'unknown'
);

CREATE TABLE IF NOT EXISTS incident_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hack_tx_hash TEXT NOT NULL,
  severity TEXT,
  summary TEXT,
  narrative TEXT,
  lstm_prediction JSONB,
  tainted_wallets_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  acknowledged BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_wallets_hack ON tainted_wallets(hack_tx_hash);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON incident_alerts(created_at DESC);
"""


def get_client() -> Client:
    global _client
    if _client is None:
        url = os.getenv("SUPABASE_URL", "")
        key = os.getenv("SUPABASE_SERVICE_KEY", "")
        _client = create_client(url, key)
    return _client


async def save_incident(alert: IncidentAlert) -> str:
    db = get_client()
    result = db.table("incident_alerts").insert({
        "hack_tx_hash": alert.hack_tx_hash,
        "severity": alert.severity,
        "summary": alert.summary,
        "narrative": alert.narrative,
        "lstm_prediction": alert.lstm_prediction,
        "tainted_wallets_count": alert.tainted_wallets_count,
        "created_at": alert.created_at.isoformat(),
    }).execute()
    return result.data[0]["id"] if result.data else ""


async def save_tainted_wallets(wallets: list[TaintedWallet]):
    if not wallets:
        return
    db = get_client()
    rows = [
        {
            "address": w.address,
            "taint_score": w.taint_score,
            "hops_from_source": w.hops_from_source,
            "amount_usd": w.amount_usd,
            "detected_at": w.detected_at.isoformat(),
            "hack_tx_hash": w.hack_tx_hash,
        }
        for w in wallets
    ]
    db.table("tainted_wallets").insert(rows).execute()


async def get_recent_incidents(limit: int = 20) -> list[dict]:
    db = get_client()
    result = (
        db.table("incident_alerts")
        .select("*")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data or []
