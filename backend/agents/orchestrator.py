"""Orchestrator — coordonne les 3 agents (TaintAnalyst, PathPredictor, IncidentReporter)."""
import asyncio
import json
from typing import Callable, Optional

from backend.agents.taint_agent import analyze_taint
from backend.agents.path_agent import predict_path
from backend.agents.reporter_agent import generate_report
from backend.storage.models import TaintedWallet


async def run_agent_pipeline(
    graph: "TaintGraph",
    hack_context: dict,
    broadcast_fn: Optional[Callable] = None,
) -> dict:
    """
    Lance le pipeline multi-agent complet.

    Args:
        graph: TaintGraph construit par build_taint_graph()
        hack_context: {protocol, amount_usd, amount_eth, minutes_elapsed}
        broadcast_fn: fonction broadcast WebSocket (async)

    Returns:
        {
            severity, summary, narrative,
            taint_analysis, path_prediction,
            graph_summary, tainted_wallets
        }
    """
    if broadcast_fn is None:
        broadcast_fn = lambda event, data: None

    # ─── AGENT 1 : TaintAnalyst ──────────────────────────────────
    await broadcast_fn("pipeline_status", {"step": "taint_analysis", "agent": "TaintAnalyst"})

    wallets_for_analysis = [
        {
            "address": addr,
            "amount_eth": node.amount_received_eth,
            "hops": node.hops,
            "entity_type": node.entity_type,
        }
        for addr, node in list(graph.nodes.items())[:20]
    ]

    taint_analysis = analyze_taint(
        wallets=wallets_for_analysis,
        source_address=graph.source,
        amount_eth=hack_context["amount_eth"],
    )

    # Mettre à jour les scores du graphe avec les résultats de l'agent
    for addr, result in taint_analysis.items():
        if addr in graph.nodes:
            graph.nodes[addr].taint_score = result.get("taint_score", 0.3)

    await broadcast_fn("agent_result", {"agent": "TaintAnalyst", "wallets_analyzed": len(taint_analysis)})

    # ─── AGENT 2 : PathPredictor ──────────────────────────────────
    await broadcast_fn("pipeline_status", {"step": "path_prediction", "agent": "PathPredictor"})

    summary = graph.summary()
    path_prediction = predict_path(
        tainted_count=summary["tainted_count"],
        max_taint_score=summary["max_taint_score"],
        move_sequence=summary["move_sequence"],
        amount_eth=hack_context["amount_eth"],
        protocol=hack_context.get("protocol", "Unknown"),
    )

    await broadcast_fn("agent_result", {
        "agent": "PathPredictor",
        "prediction": path_prediction.get("next_destination"),
        "probability": path_prediction.get("probability"),
    })

    # ─── AGENT 3 : IncidentReporter ──────────────────────────────
    await broadcast_fn("pipeline_status", {"step": "generating_narrative", "agent": "IncidentReporter"})

    hack_context_for_report = {
        **hack_context,
        "tainted_count": summary["tainted_count"],
    }

    narrative = generate_report(
        taint_analysis=taint_analysis,
        path_prediction=path_prediction,
        hack_context=hack_context_for_report,
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
    tainted_list = graph.get_tainted_wallets()

    result = {
        "severity": severity,
        "summary": f"{severity} — {summary['tainted_count']} wallets taintés, destination probable : {path_prediction.get('next_destination')}",
        "narrative": narrative,
        "taint_analysis": taint_analysis,
        "path_prediction": path_prediction,
        "graph_summary": summary,
        "tainted_wallets": [
            {"address": n.address, "score": n.taint_score, "type": n.entity_type}
            for n in tainted_list[:20]
        ],
    }

    return result
