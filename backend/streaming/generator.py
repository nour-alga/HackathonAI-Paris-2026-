"""
Générateur de stream Ethereum-like + orchestrateur IA temps réel.

Le backend produit en continu des transactions avec une distribution réaliste
calibrée sur le dataset Salam Ammari, agrège un TaintGraph rolling, et fait
tourner périodiquement GAT (à chaque batch), LSTM (toutes les 4s) et Cerebras
(toutes les ~25s, en streaming token-par-token).

Tous les events sortent sur le bus WebSocket — le front est purement render.
"""
from __future__ import annotations

import asyncio
import os
import random
import secrets
import time
from collections import deque
from typing import Any

from backend.websocket.manager import manager
from backend.streaming import proof

# ── Distribution de catégories calibrée sur Salam Ammari ────────────────────
# (ratios approx tirés de verify_dataset.py : Scamming 13.7%, Phishing 2.6%, le reste null)
_CATEGORY_DIST = [
    ("clean", 0.83),
    ("Scamming", 0.137),
    ("Phishing", 0.026),
    ("Mixer", 0.005),
    ("Bridge", 0.002),
]


def _sample_category() -> str:
    r = random.random()
    cum = 0.0
    for name, p in _CATEGORY_DIST:
        cum += p
        if r <= cum:
            return name
    return "clean"


def _rand_addr() -> str:
    return "0x" + secrets.token_hex(20)


def _rand_value_eth() -> float:
    """Distribution log-normale ETH (calibrée sur le mainnet)."""
    return max(0.0001, random.lognormvariate(mu=-2.0, sigma=2.0))


# ── État partagé ────────────────────────────────────────────────────────────
_running = False
_task: asyncio.Task | None = None
_lifecycle_lock = asyncio.Lock()
_last_reset_ts = 0.0
RESET_MIN_INTERVAL_S = 1.5
_nodes: dict[str, dict] = {}
_edges: deque[dict] = deque(maxlen=400)
_recent_txs: deque[dict] = deque(maxlen=120)

# Topologie tier (réaliste hack-trail) :
#   tier 0 = source du hack (1 wallet)
#   tier 1 = splitters (~6-8)
#   tier 2 = mixers / intermédiaires (~25-35)
#   tier 3 = terminaux (CEX hot wallets, bridges, dust pool)
_tiers: dict[int, list[str]] = {0: [], 1: [], 2: [], 3: []}
_source_addr: str | None = None

MAX_NODES = 50
TIER_TARGETS = {0: 1, 1: 5, 2: 14, 3: 28}
GEN_INTERVAL_S = 1.4            # ~0.7 tx/sec — calme, lisible
GAT_BATCH_EVERY = 4             # GAT toutes les ~5 secondes
LSTM_EVERY_S = 6.0
CEREBRAS_EVERY_S = 30.0


def _new_node(tier: int, blacklisted: bool = False, is_cex: bool = False) -> str:
    addr = _rand_addr()
    base_score = {0: 0.95, 1: 0.7, 2: 0.4, 3: 0.15}[tier]
    score = min(1.0, max(0.0, base_score + random.uniform(-0.1, 0.1)))
    _nodes[addr] = {
        "id": addr,
        "address": addr,
        "score": round(score, 3),
        "criticality": int(round(score * 100)),
        "balance": round(random.uniform(0.05, 200), 3),
        "hops": tier,
        "blacklisted": blacklisted or tier == 0,
        "blacklistLinks": 1 if blacklisted else 0,
        "velocity": round(random.uniform(0.5, 12), 2),
        "isCex": is_cex,
        "isSource": tier == 0,
        "label": "HACK_SOURCE" if tier == 0 else None,
    }
    _tiers[tier].append(addr)
    return addr


def _seed_topology() -> None:
    """Initialise 1 source + splitters + premiers mixers."""
    global _source_addr
    if _source_addr is not None:
        return
    _source_addr = _new_node(0, blacklisted=True)
    for _ in range(4):
        addr = _new_node(1, blacklisted=random.random() < 0.4)
        _edges.append({
            "source": _source_addr, "target": addr,
            "amount": round(random.uniform(50, 800), 3),
            "hash": "0x" + secrets.token_hex(32),
        })
    for _ in range(12):
        parent = random.choice(_tiers[1])
        addr = _new_node(2, blacklisted=random.random() < 0.25)
        _edges.append({
            "source": parent, "target": addr,
            "amount": round(random.uniform(5, 120), 3),
            "hash": "0x" + secrets.token_hex(32),
        })


def _pick_parent_for(tier: int) -> str | None:
    parent_tier = tier - 1
    pool = [a for a in _tiers[parent_tier] if a in _nodes]
    if not pool:
        return None
    weights = [_nodes[a].get("score", 0.1) for a in pool]
    return random.choices(pool, weights=weights, k=1)[0]


def _gen_tx() -> dict:
    """Tx réaliste : 70% downstream, 20% lateral, 10% upstream."""
    target_tier = None
    for t in (3, 2, 1):
        if len(_tiers[t]) < TIER_TARGETS[t] and random.random() < 0.6:
            target_tier = t
            break

    cat = _sample_category()
    is_fraud = cat in ("Scamming", "Phishing", "Mixer")

    if target_tier is not None:
        parent = _pick_parent_for(target_tier) or random.choice(list(_nodes))
        is_cex = (target_tier == 3 and cat == "Bridge")
        new_addr = _new_node(target_tier, blacklisted=is_fraud, is_cex=is_cex)
        src, dst = parent, new_addr
    else:
        roll = random.random()
        if roll < 0.7:
            from_tier = random.choices([1, 2, 3], weights=[3, 5, 2], k=1)[0]
            to_tier = from_tier + 1 if from_tier < 3 else 3
        elif roll < 0.9:
            from_tier = random.choice([2, 3])
            to_tier = from_tier
        else:
            from_tier = random.choice([2, 3])
            to_tier = max(1, from_tier - 1)
        from_pool = [a for a in _tiers[from_tier] if a in _nodes]
        to_pool = [a for a in _tiers[to_tier] if a in _nodes]
        if not from_pool or not to_pool:
            src, dst = random.sample(list(_nodes), 2)
        else:
            src = random.choice(from_pool)
            dst = random.choice(to_pool)
            tries = 0
            while dst == src and tries < 5:
                dst = random.choice(to_pool); tries += 1

    return {
        "hash": "0x" + secrets.token_hex(32),
        "from": src,
        "to": dst,
        "value_eth": round(_rand_value_eth(), 6),
        "category": cat,
        "is_fraud": is_fraud,
        "ts_ms": int(time.time() * 1000),
    }


def _add_tx_to_graph(tx: dict) -> None:
    src, dst = tx["from"], tx["to"]
    _edges.append({"source": src, "target": dst, "amount": tx["value_eth"], "hash": tx["hash"]})
    if tx["is_fraud"] and dst in _nodes:
        _nodes[dst]["blacklisted"] = True
        _nodes[dst]["blacklistLinks"] = _nodes[dst].get("blacklistLinks", 0) + 1

    # Eviction : préserve la source, évince les terminaux les plus anciens d'abord
    while len(_nodes) > MAX_NODES:
        evicted = None
        for tier in (3, 2, 1):
            for addr in list(_tiers[tier]):
                if addr in _nodes and addr != _source_addr:
                    evicted = addr
                    _nodes.pop(addr, None)
                    _tiers[tier].remove(addr)
                    break
            if evicted:
                break
        if not evicted:
            break


# ── GAT inference ───────────────────────────────────────────────────────────

async def _run_gat_batch() -> None:
    if len(_nodes) < 3:
        return
    t0 = time.perf_counter()
    try:
        import sys, pathlib
        root = pathlib.Path(__file__).resolve().parent.parent.parent
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))
        import gat_scorer  # type: ignore
        if not gat_scorer.MODEL_PATH.exists():
            return
        scores = gat_scorer.score_nodes(
            {a: {} for a in list(_nodes)[:MAX_NODES]},
            list(_edges),
        )
    except Exception as e:
        await manager.broadcast("ai_error", {"model": "gat", "error": str(e)[:200]})
        return
    latency_ms = (time.perf_counter() - t0) * 1000
    # Override des scores
    max_score = 0.0
    for addr, s in scores.items():
        if addr in _nodes:
            _nodes[addr]["score"] = float(s)
            _nodes[addr]["criticality"] = int(round(s * 100))
            if s > max_score:
                max_score = float(s)

    proof.record_inference("gat", latency_ms, {"nodes": len(scores), "max_score": round(max_score, 4)})
    await manager.broadcast("gat_inference", {
        "model": "FraudGAT",
        "latency_ms": round(latency_ms, 2),
        "nodes_scored": len(scores),
        "max_score": round(max_score, 4),
        "score_distribution": [round(s, 3) for s in sorted(scores.values(), reverse=True)[:10]],
    })


# ── LSTM inference ──────────────────────────────────────────────────────────

async def _run_lstm() -> None:
    if len(_nodes) < 5:
        return
    t0 = time.perf_counter()
    try:
        import networkx as nx  # noqa: PLC0415
        from backend.models.path_lstm import predict_next, load_path_lstm  # noqa: PLC0415

        # Construit un mini-graphe à partir des edges récents
        g = nx.DiGraph()
        for e in list(_edges)[-200:]:
            g.add_edge(e["source"], e["target"], amount=e["amount"])
        for addr, n in _nodes.items():
            if addr in g:
                g.nodes[addr]["taint_score"] = n["score"]

        # Top 5 wallets par score
        top = sorted(_nodes.values(), key=lambda n: n["score"], reverse=True)[:5]
        addrs = [n["address"] for n in top]
        if len(addrs) < 5:
            return
        model = load_path_lstm(str((proof.ROOT / "backend" / "models" / "path_lstm.pt")))
        result = predict_next(addrs, g, model)
    except Exception as e:
        await manager.broadcast("ai_error", {"model": "lstm", "error": str(e)[:200]})
        return
    latency_ms = (time.perf_counter() - t0) * 1000
    proof.record_inference("lstm", latency_ms, {"prediction": result.get("destination_type")})
    await manager.broadcast("lstm_inference", {
        "model": "PathLSTM",
        "latency_ms": round(latency_ms, 2),
        "input_addresses": addrs,
        "prediction": result.get("destination_type"),
        "confidence": round(float(result.get("confidence", 0)), 4),
        "probabilities": {k: round(float(v), 4) for k, v in (result.get("probabilities") or {}).items()},
    })


# ── Cerebras streaming inference ────────────────────────────────────────────

async def _run_cerebras_streaming() -> None:
    api_key = os.getenv("CEREBRAS_API_KEY")
    if not api_key:
        await manager.broadcast("cerebras_skipped", {"reason": "no_api_key"})
        return

    top = sorted(_nodes.values(), key=lambda n: n["score"], reverse=True)[:8]
    if not top:
        return
    summary = {n["address"][:12] + "…": round(n["score"], 3) for n in top}
    fraud_count = sum(1 for n in _nodes.values() if n["score"] > 0.5)
    total_value = sum(e["amount"] for e in _edges)

    user_prompt = (
        f"Analyse ce flux de transactions Ethereum en temps réel :\n"
        f"- {len(_nodes)} wallets observés, {fraud_count} avec score taint > 0.5\n"
        f"- Volume total : {total_value:.2f} ETH\n"
        f"- Top wallets suspects (score GAT) : {summary}\n\n"
        f"Donne en 4 lignes max : (1) niveau de risque, (2) pattern dominant, "
        f"(3) action recommandée, (4) destination probable du blanchiment."
    )

    t0 = time.perf_counter()
    request_id = secrets.token_hex(8)
    await manager.broadcast("cerebras_start", {
        "request_id": request_id,
        "model_id": os.getenv("CEREBRAS_FINE_TUNED_MODEL") or "qwen-3-235b-a22b-instruct-2507",
        "prompt_chars": len(user_prompt),
    })

    try:
        from cerebras.cloud.sdk import Cerebras  # noqa: PLC0415
        from backend.agents.reporter_agent import _load_few_shot, DEFAULT_MODEL  # type: ignore

        client = Cerebras(api_key=api_key)
        few_shot = _load_few_shot()
        sys_prompt = "Tu es IncidentReporter, analyste DeFi temps réel. Réponse FR très concise."
        if few_shot:
            sys_prompt += "\nCalibration via exemples annotés Salam Ammari (FRAUD/CLEAN)."

        token_index = 0
        full = ""
        stream = client.chat.completions.create(
            model=os.getenv("CEREBRAS_FINE_TUNED_MODEL") or DEFAULT_MODEL,
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_prompt},
            ],
            stream=True,
            max_tokens=240,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            if not delta:
                continue
            full += delta
            token_index += 1
            await manager.broadcast("cerebras_token", {
                "request_id": request_id,
                "token_index": token_index,
                "delta": delta,
                "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
            })
            await asyncio.sleep(0)  # yield au loop pour que le WS pousse vraiment

    except Exception as e:
        await manager.broadcast("ai_error", {"model": "cerebras", "error": str(e)[:200]})
        return

    latency_ms = (time.perf_counter() - t0) * 1000
    proof.record_inference("cerebras", latency_ms, {
        "tokens": token_index,
        "tokens_per_sec": round(token_index / (latency_ms / 1000), 1) if latency_ms > 0 else 0,
    })
    await manager.broadcast("cerebras_complete", {
        "request_id": request_id,
        "tokens": token_index,
        "latency_ms": round(latency_ms, 1),
        "tokens_per_sec": round(token_index / (latency_ms / 1000), 1) if latency_ms > 0 else 0,
        "full_text": full,
    })


# ── Main loop ───────────────────────────────────────────────────────────────

def _filtered_edges() -> list[dict]:
    """N'expose que les edges dont source/target sont encore dans _nodes
    (sinon d3 plante en silence côté front)."""
    keys = set(_nodes)
    return [e for e in _edges if e["source"] in keys and e["target"] in keys]


async def _stream_loop():
    global _running
    _seed_topology()
    # Broadcast immédiat l'état seedé pour que le front se remplisse vite (sinon
    # il faut attendre la prochaine fenêtre throttle de graph_state, ~1-2s).
    await manager.broadcast("graph_state", {
        "nodes": list(_nodes.values()),
        "edges": _filtered_edges(),
        "recent_count": 0,
        "fraud_count": sum(1 for n in _nodes.values() if n.get("score", 0) > 0.5),
    })
    last_lstm = 0.0
    last_cerebras = 0.0
    last_graph_state = 0.0
    tx_count_since_gat = 0

    # Broadcast initial du manifest IA
    await manager.broadcast("ai_manifest", proof.build_manifest())

    while _running:
        tx = _gen_tx()
        _add_tx_to_graph(tx)
        _recent_txs.append(tx)

        await manager.broadcast("tx_generated", tx)
        now = time.time()

        # Throttle le graph_state à 1Hz max — sinon d3 redémarre la simulation
        # à chaque tx (320ms) et le graph ne se stabilise jamais.
        if now - last_graph_state >= 1.0:
            last_graph_state = now
            await manager.broadcast("graph_state", {
                "nodes": list(_nodes.values()),
                "edges": _filtered_edges(),
                "recent_count": len(_recent_txs),
                "fraud_count": sum(1 for n in _nodes.values() if n.get("score", 0) > 0.5),
            })

        tx_count_since_gat += 1

        if tx_count_since_gat >= GAT_BATCH_EVERY:
            tx_count_since_gat = 0
            asyncio.create_task(_run_gat_batch())

        if now - last_lstm >= LSTM_EVERY_S:
            last_lstm = now
            asyncio.create_task(_run_lstm())

        if now - last_cerebras >= CEREBRAS_EVERY_S:
            last_cerebras = now
            asyncio.create_task(_run_cerebras_streaming())

        await asyncio.sleep(GEN_INTERVAL_S)


def is_running() -> bool:
    return _running


async def start():
    global _running, _task
    async with _lifecycle_lock:
        if _running:
            return {"status": "already_running"}
        _running = True
        _task = asyncio.create_task(_stream_loop())
    return {"status": "started"}


async def stop():
    global _running, _task
    async with _lifecycle_lock:
        _running = False
        if _task:
            _task.cancel()
            try:
                await _task
            except (asyncio.CancelledError, Exception):
                pass
            _task = None
    return {"status": "stopped"}


async def reset():
    """Vide tout le state et redémarre proprement avec un nouveau hack source.
    Verrouillé + rate-limité pour éviter les races et le crash Windows asyncio."""
    global _source_addr, _running, _task, _last_reset_ts
    now = time.time()
    if now - _last_reset_ts < RESET_MIN_INTERVAL_S:
        return {"status": "rate_limited", "retry_after_s": round(RESET_MIN_INTERVAL_S - (now - _last_reset_ts), 2)}
    _last_reset_ts = now
    async with _lifecycle_lock:
        was_running = _running
        # Arrêt inline (sans réacquérir le lock)
        _running = False
        if _task:
            _task.cancel()
            try:
                await _task
            except (asyncio.CancelledError, Exception):
                pass
            _task = None
        _nodes.clear()
        _edges.clear()
        _recent_txs.clear()
        for t in _tiers:
            _tiers[t].clear()
        _source_addr = None
        proof.reset_log()
        # Event explicite pour que le front vide aussi son state IA
        await manager.broadcast("stream_reset", {"reason": "user_reset"})
        await manager.broadcast("graph_state", {"nodes": [], "edges": [], "recent_count": 0, "fraud_count": 0})
        if was_running:
            _running = True
            _task = asyncio.create_task(_stream_loop())
    return {"status": "reset", "running": _running}


def stats() -> dict:
    return {
        "running": _running,
        "nodes": len(_nodes),
        "edges": len(_edges),
        "recent_txs": len(_recent_txs),
        "fraud_count": sum(1 for n in _nodes.values() if n.get("score", 0) > 0.5),
        "inference_counts": proof.inference_counts(),
    }
