"""Modèles Pydantic — schéma des données stockées dans Supabase."""
from pydantic import BaseModel
from datetime import datetime


class TaintedWallet(BaseModel):
    address: str
    taint_score: float          # 0.0 → 1.0
    hops_from_source: int       # distance depuis le wallet hacké
    amount_usd: float
    detected_at: datetime
    hack_tx_hash: str           # transaction initiale du hack


class IncidentAlert(BaseModel):
    hack_tx_hash: str
    severity: str               # LOW | MEDIUM | HIGH | CRITICAL
    summary: str
    narrative: str              # rapport Llama complet
    lstm_prediction: dict       # {"tornado_cash": 0.72, ...}
    tainted_wallets_count: int
    created_at: datetime
    acknowledged: bool = False
