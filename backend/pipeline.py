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


async def run_pipeline_from_graph(
    nodes: list[dict],
    edges: list[dict],
    seed_address: str | None = None,
    amount_eth: float | None = None,
    protocol_name: str = "Simulated Stream",
) -> dict:
    """
    Variante du pipeline qui prend un graphe déjà construit (front simulation)
    et skip totalement Etherscan. Réutilise TaintGraph + run_agent_pipeline.
    """
    from backend.detection.taint_graph import TaintGraph, TxEdge, KNOWN_ENTITIES

    # Choix du seed : explicite, sinon node avec le plus gros score, sinon premier
    seed = (seed_address or "").lower()
    if not seed and nodes:
        sorted_nodes = sorted(
            nodes,
            key=lambda n: float(n.get("score", n.get("taint_score", 0)) or 0),
            reverse=True,
        )
        seed = str(sorted_nodes[0].get("id") or sorted_nodes[0].get("address", "")).lower()

    total_in = amount_eth or sum(float(e.get("amount", e.get("amount_eth", 0)) or 0) for e in edges) or 1.0

    await manager.broadcast("pipeline_status", {"step": "building_graph", "address": seed})

    graph = TaintGraph(seed or "0x0", total_in)

    for n in nodes:
        addr = str(n.get("id") or n.get("address", "")).lower()
        if not addr or addr == seed:
            continue
        score = float(n.get("score", n.get("taint_score", 0)) or 0)
        amt = float(n.get("balance", n.get("amount_eth", 0)) or 0)
        hops = int(n.get("hops", 1) or 1)
        graph._add_node(addr, taint_raw=score, hops=hops, amount_eth=amt)

    from datetime import datetime as _dt
    for i, e in enumerate(edges):
        src = str(e.get("source") or "").lower()
        dst = str(e.get("target") or "").lower()
        if not src or not dst:
            continue
        amt = float(e.get("amount", e.get("amount_eth", 0)) or 0)
        if src not in graph.nodes:
            graph._add_node(src, taint_raw=0.0, hops=1, amount_eth=0.0)
        if dst not in graph.nodes:
            graph._add_node(dst, taint_raw=0.0, hops=1, amount_eth=amt)
        edge_obj = TxEdge(
            tx_hash=str(e.get("tx_hash", f"sim_{i}")),
            amount_eth=amt,
            timestamp=_dt.utcnow(),
            block_number=0,
        )
        parent_taint = graph.nodes[src].taint_raw or 1.0
        graph.add_transaction(src, dst, edge_obj, parent_taint)

    graph.initialize_taint_scores()

    # Override des scores via le GAT entraîné (gat_model.pt) si dispo.
    try:
        import sys as _sys
        from pathlib import Path as _Path
        _root = _Path(__file__).resolve().parent.parent
        if str(_root) not in _sys.path:
            _sys.path.insert(0, str(_root))
        import gat_scorer  # type: ignore
        if gat_scorer.MODEL_PATH.exists():
            nodes_dict = {addr: {} for addr in graph.nodes}
            simple_edges = [
                {"source": u, "target": v, "amount_eth": d.get("amount_eth", 0)}
                for u, v, d in graph.graph.edges(data=True)
            ]
            scores = gat_scorer.score_nodes(nodes_dict, simple_edges)
            for addr, s in scores.items():
                if addr in graph.nodes:
                    graph.nodes[addr].taint_score = float(s)
            print(f"[Pipeline/sim] GAT override : {len(scores)} scores")
    except Exception as e:
        print(f"[Pipeline/sim] GAT override skipped: {e}")

    summary = graph.summary()

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

    hack_context = {
        "protocol": protocol_name,
        "amount_eth": total_in,
        "amount_usd": total_in * ETH_PRICE_USD,
        "minutes_elapsed": 0,
    }

    result = await run_agent_pipeline(
        graph=graph,
        hack_context=hack_context,
        broadcast_fn=manager.broadcast,
    )

    full_result = {**result, "graph_summary": summary}
    await manager.broadcast("analysis_complete", full_result)
    print(f"[Pipeline/sim] Terminé — sévérité : {result['severity']}")
    return full_result
