"""
Pipeline principal KOVER.IA — orchestration multi-agent.

Pour un hack donné (adresse + montant) :
  1. Construit le taint graph (fetch txs, propagation brute)
  2. Lance le pipeline agent (TaintAnalyst → PathPredictor → IncidentReporter)
  3. Persiste en base de données et envoie les alertes
  4. Broadcast WebSocket vers le frontend
"""
import asyncio
from datetime import datetime

from backend.detection.taint_graph import build_taint_graph, TaintGraph
from backend.agents.orchestrator import run_agent_pipeline
from backend.storage.bigquery_client import save_incident, save_tainted_wallets
from backend.storage.models import TaintedWallet, IncidentAlert
from backend.websocket.manager import manager


ETH_PRICE_USD = 3200.0  # mis à jour dynamiquement en prod


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

    # 1. Construction du taint graph (BFS + propagation brute)
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

    # 2. Pipeline multi-agent (TaintAnalyst → PathPredictor → IncidentReporter)
    hack_context = {
        "protocol": protocol_name,
        "amount_eth": amount_eth,
        "amount_usd": amount_eth * ETH_PRICE_USD,
        "minutes_elapsed": 0,
    }

    result = await run_agent_pipeline(
        graph=graph,
        hack_context=hack_context,
        broadcast_fn=manager.broadcast,
    )

    severity = result["severity"]
    narrative = result["narrative"]
    path_prediction = result["path_prediction"]
    top_dest = path_prediction.get("next_destination", "unknown")

    # 3. Persistance
    tainted_list = graph.get_tainted_wallets()
    alert = IncidentAlert(
        hack_tx_hash=hack_address,
        severity=severity,
        summary=result["summary"],
        narrative=narrative,
        lstm_prediction=path_prediction,
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

    # Enrichir le résultat avec les données du graphe
    full_result = {
        **result,
        "graph_summary": summary,
    }

    await manager.broadcast("analysis_complete", full_result)
    print(f"[Pipeline] Terminé — sévérité : {severity}")
    return full_result
