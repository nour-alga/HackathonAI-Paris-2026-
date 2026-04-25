"""
Filtre et normalise les transactions brutes reçues de QuickNode.
Extrait les infos utiles pour le pipeline de détection.
"""
from pydantic import BaseModel
from datetime import datetime


class NormalizedTransaction(BaseModel):
    tx_hash: str
    from_address: str
    to_address: str
    value_eth: float
    block_number: int
    timestamp: datetime
    gas_price_gwei: float
    is_contract_interaction: bool


def normalize(raw_tx: dict) -> NormalizedTransaction | None:
    """Transforme une tx brute QuickNode en format standard."""
    try:
        return NormalizedTransaction(
            tx_hash=raw_tx.get("transactionHash", ""),
            from_address=raw_tx.get("address", "").lower(),
            to_address=raw_tx.get("topics", ["", ""])[1] if raw_tx.get("topics") else "",
            value_eth=int(raw_tx.get("data", "0x0") or "0x0", 16) / 1e18,
            block_number=int(raw_tx.get("blockNumber", "0x0"), 16),
            timestamp=datetime.utcnow(),
            gas_price_gwei=0.0,
            is_contract_interaction=bool(raw_tx.get("topics")),
        )
    except Exception:
        return None
