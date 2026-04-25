"""Orchestrator — coordonne 2 agents (PathPredictor, IncidentReporter). Taint scores viennent du TaintGraph."""
import asyncio
import json
from typing import Callable, Optional

from backend.agents.path_agent import predict_path
from backend.agents.reporter_agent import generate_report
from backend.storage.models import TaintedWallet


async def run_agent_pipeline(
    graph: "TaintGraph",
    hack_context: dict,
    broadcast_fn: Optional[Callable] = None,
) -> dict:
    """
    Lance le pipeline agent optimisé (2 agents).

    Args:
        graph: TaintGraph construit par build_taint_graph() (scores déjà calculés)
        hack_context: {protocol, amount_usd, amount_eth, minutes_elapsed}
        broadcast_fn: fonction broadcast WebSocket (async)

    Returns:
        {severity, summary, narrative, path_prediction, graph_summary, tainted_wallets}
    """
    if broadcast_fn is None:
        broadcast_fn = lambda event, data: None

    # Taint scores viennent du TaintGraph (déjà calculés par BFS)
    summary = graph.summary()

    # ─── AGENT 1 : PathPredictor ──────────────────────────────────
    await broadcast_fn("pipeline_status", {"step": "path_prediction", "agent": "PathPredictor"})

    path_prediction = predict_path(
        tainted_count=summary["tainted_count"],
        max_taint_score=summary["max_taint_score"],
        move_sequence=summary["move_sequence"],
        amount_eth=hack_context["amount_eth"],
        protocol=hack_context.get("protocol", "Unknown"),
        graph=graph,
    )

    await broadcast_fn("agent_result", {
        "agent": "PathPredictor",
        "prediction": path_prediction.get("next_destination"),
        "probability": path_prediction.get("probability"),
    })

    # ─── AGENT 2 : IncidentReporter ──────────────────────────────
    await broadcast_fn("pipeline_status", {"step": "generating_narrative", "agent": "IncidentReporter"})

    # Extraire les scores du graphe pour le rapport
    tainted_wallets = graph.get_tainted_wallets()
    taint_analysis = {
        node.address: {
            "taint_score": node.taint_score,
            "hops": node.hops,
            "type": node.entity_type,
        }
        for node in tainted_wallets[:20]
    }

    narrative = generate_report(
        taint_analysis=taint_analysis,
        path_prediction=path_prediction,
        hack_context=hack_context,
    )

    await broadcast_fn("agent_result", {"agent": "IncidentReporter", "report_length": len(narrative)})

    # ─── Compute Severity ────────────────────────────────────────
    has_critical = len(summary["critical_entities"]) > 0
    max_score = summary.get("max_taint_score", 0)

    if has_critical or max_score > 0.9:
        severity = "CRITICAL"
    elif summary["tainted_count"] > 20 or max_score > 0.7:
        severity = "HIGH"
    elif summary["tainted_count"] > 5 or max_score > 0.5:
        severity = "MEDIUM"
    else:
        severity = "LOW"

    # ─── Build Result ────────────────────────────────────────────
    result = {
        "severity": severity,
        "summary": f"{severity} — {summary['tainted_count']} wallets taintés, destination probable : {path_prediction.get('next_destination')}",
        "narrative": narrative,
        "path_prediction": path_prediction,
        "graph_summary": summary,
        "tainted_wallets": [
            {"address": n.address, "score": n.taint_score, "type": n.entity_type}
            for n in tainted_wallets[:20]
        ],
    }

    return result
