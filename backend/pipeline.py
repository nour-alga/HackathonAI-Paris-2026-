"""
Pipeline principal KOVER.IA — orchestration complète.

Pour un hack donné (adresse + montant) :
  1. Construit le taint graph (fetch txs + GAT scoring)
  2. Prédit la prochaine destination (LSTM)
  3. Génère le rapport narratif (Llama 3.1 sur Cerebras)
  4. Détermine la sévérité et envoie les alertes
  5. Persiste en base de données
  6. Broadcast WebSocket vers le frontend
"""
import asyncio
from datetime import datetime

from backend.detection.taint_graph import build_taint_graph, TaintGraph
from backend.models.lstm.predict import predict_next
from backend.narrative.cerebras_client import generate_report
from backend.alerting.discord import send_alert
from backend.storage.supabase_client import save_incident, save_tainted_wallets
from backend.storage.models import TaintedWallet, IncidentAlert
from backend.websocket.manager import manager


ETH_PRICE_USD = 3200.0  # mis à jour dynamiquement en prod


def compute_severity(tainted_count: int, max_score: float, has_critical_entity: bool) -> str:
    if has_critical_entity or max_score > 0.9:
        return "CRITICAL"
    if tainted_count > 20 or max_score > 0.7:
        return "HIGH"
    if tainted_count > 5 or max_score > 0.5:
        return "MEDIUM"
    return "LOW"


async def run_pipeline(
    hack_address: str,
    amount_eth: float,
    protocol_name: str = "Unknown Protocol",
    start_block: int = 0,
) -> dict:
    """
    Point d'entrée principal du pipeline.
    Retourne un dict avec l'analyse complète.
    """
    print(f"[Pipeline] Démarrage analyse : {hack_address}")

    # 1. Construction du taint graph
    await manager.broadcast("pipeline_status", {"step": "building_graph", "address": hack_address})
    graph = await build_taint_graph(hack_address, amount_eth, start_block)
    summary = graph.summary()
    print(f"[Pipeline] Graphe : {summary['total_wallets']} wallets, {summary['tainted_count']} taintés")

    # Broadcast du graphe pour visualisation
    await manager.broadcast("graph_update", {
        "nodes": [
            {
                "id": addr,
                "taint_score": node.taint_score,
                "entity_type": node.entity_type,
                "hops": node.hops,
                "amount_eth": node.amount_received_eth,
            }
            for addr, node in graph.nodes.items()
        ],
        "edges": [
            {"source": u, "target": v, "amount_eth": d.get("amount_eth", 0)}
            for u, v, d in graph.graph.edges(data=True)
        ],
    })

    # 2. Prédiction LSTM
    await manager.broadcast("pipeline_status", {"step": "lstm_prediction"})
    lstm_prediction = predict_next(summary["move_sequence"])
    top_dest = max(lstm_prediction, key=lstm_prediction.get)
    print(f"[Pipeline] LSTM → {top_dest} ({lstm_prediction[top_dest]*100:.0f}%)")

    # 3. Sévérité
    has_critical = len(summary["critical_entities"]) > 0
    severity = compute_severity(summary["tainted_count"], summary["max_taint_score"], has_critical)

    # 4. Rapport narratif (Llama sur Cerebras)
    await manager.broadcast("pipeline_status", {"step": "generating_narrative"})
    gat_scores = {addr: node.taint_score for addr, node in graph.nodes.items()}
    narrative = generate_report(
        gat_scores=gat_scores,
        lstm_prediction=lstm_prediction,
        sequence=summary["move_sequence"],
        hack_context={
            "protocol": protocol_name,
            "amount_usd": amount_eth * ETH_PRICE_USD,
            "minutes_elapsed": 0,
        },
    )

    # 5. Persistance
    tainted_list = graph.get_tainted_wallets()
    alert = IncidentAlert(
        hack_tx_hash=hack_address,
        severity=severity,
        summary=f"{severity} — {summary['tainted_count']} wallets taintés, destination probable : {top_dest}",
        narrative=narrative,
        lstm_prediction=lstm_prediction,
        tainted_wallets_count=summary["tainted_count"],
        created_at=datetime.utcnow(),
    )

    wallets_to_save = [
        TaintedWallet(
            address=n.address,
            taint_score=n.taint_score,
            hops_from_source=n.hops,
            amount_usd=n.amount_received_eth * ETH_PRICE_USD,
            detected_at=datetime.utcnow(),
            hack_tx_hash=hack_address,
        )
        for n in tainted_list
    ]

    await asyncio.gather(
        save_incident(alert),
        save_tainted_wallets(wallets_to_save),
    )

    # 6. Alerte Discord
    await send_alert(
        severity=severity,
        summary=alert.summary,
        details=narrative[:800],
        tx_hash=hack_address,
    )

    result = {
        "severity": severity,
        "summary": alert.summary,
        "narrative": narrative,
        "lstm_prediction": lstm_prediction,
        "graph_summary": summary,
        "tainted_wallets": [
            {"address": n.address, "score": n.taint_score, "type": n.entity_type}
            for n in tainted_list[:20]
        ],
    }

    await manager.broadcast("analysis_complete", result)
    print(f"[Pipeline] Terminé — sévérité : {severity}")
    return result
