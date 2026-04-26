"""
KOVER.IA — FastAPI Backend
Routes principales + WebSocket
"""
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

from backend.websocket.manager import manager
from backend.pipeline import run_pipeline, run_pipeline_from_graph
from backend.streaming import generator as ai_stream
from backend.streaming import proof as ai_proof
from backend.storage.bigquery_client import get_recent_incidents

load_dotenv()

app = FastAPI(title="KOVER.IA", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Health ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "KOVER.IA"}


# ─── WebSocket ───────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            await ws.receive_text()  # maintenir la connexion ouverte
    except WebSocketDisconnect:
        manager.disconnect(ws)


# ─── Analyse principale ──────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    address: str        # adresse du hacker ou tx hash
    amount_eth: float   # montant volé estimé en ETH
    protocol_name: str = "Unknown Protocol"
    start_block: int = 0


@app.post("/analyze")
async def analyze(req: AnalyzeRequest, background: BackgroundTasks):
    """
    Lance l'analyse complète en arrière-plan.
    Les résultats arrivent via WebSocket en temps réel.
    """
    background.add_task(
        run_pipeline,
        req.address,
        req.amount_eth,
        req.protocol_name,
        req.start_block,
    )
    return {"status": "started", "address": req.address}


@app.post("/analyze/sync")
async def analyze_sync(req: AnalyzeRequest):
    """Version synchrone pour les tests — attend le résultat complet."""
    result = await run_pipeline(
        req.address,
        req.amount_eth,
        req.protocol_name,
        req.start_block,
    )
    return result


# ─── Analyse depuis graphe simulé (front) ────────────────────────────────────

class AnalyzeGraphRequest(BaseModel):
    nodes: list[dict]
    edges: list[dict]
    seed_address: str | None = None
    amount_eth: float | None = None
    protocol_name: str = "Simulated Stream"


# ─── AI Stream + provenance ──────────────────────────────────────────────────

@app.post("/stream/start")
async def stream_start():
    return await ai_stream.start()


@app.post("/stream/stop")
async def stream_stop():
    return await ai_stream.stop()


@app.post("/stream/reset")
async def stream_reset():
    return await ai_stream.reset()


@app.get("/stream/stats")
async def stream_stats():
    return ai_stream.stats()


@app.get("/ai/proof")
async def ai_proof_endpoint():
    """Manifest signé HMAC : checksums modèles, métadonnées training, log
    d'inférences. Le jury peut vérifier la signature."""
    return ai_proof.build_manifest()


# ─── Flashloan dashboard launcher (kover-bfd-mev) ────────────────────────────

import subprocess
from pathlib import Path

_FLASHLOAN_DIR = Path(__file__).resolve().parent.parent / "ia" / "kover-bfd-mev"
_FLASHLOAN_PORT = 8787
_flashloan_proc: subprocess.Popen | None = None


@app.post("/launch/flashloan")
async def launch_flashloan():
    """Lance (si pas déjà actif) le dashboard Node de kover-bfd-mev sur le port 8787."""
    global _flashloan_proc

    if _flashloan_proc is not None and _flashloan_proc.poll() is None:
        return {"status": "already_running", "url": f"http://localhost:{_FLASHLOAN_PORT}"}

    if not _FLASHLOAN_DIR.exists():
        return {"status": "error", "message": f"{_FLASHLOAN_DIR} introuvable"}

    import os as _os
    log_path = _FLASHLOAN_DIR / "flashloan.log"
    env = _os.environ.copy()
    # Démo rapide : fire la première attaque après ~150 tx (~5s à 30tx/s),
    # répète toutes les 200 tx. Pas besoin de QuickNode WSS.
    env["DEMO_SYNTH_RATE"] = "30"
    env["DEMO_INJECT_AFTER_TX"] = "150"
    env["DEMO_INJECT_REPEAT_TX"] = "200"
    env["DEMO_INJECT_FALLBACK_MS"] = "8000"

    # Lance node directement (pas via npm) pour éviter les problèmes de wrapper
    # cmd.exe / forking sur Windows. Redirige stdout/stderr vers un fichier log.
    log_fh = open(log_path, "w", encoding="utf-8", errors="replace")
    try:
        _flashloan_proc = subprocess.Popen(
            ["node", "src/start_demo.js"],
            cwd=str(_FLASHLOAN_DIR),
            env=env,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            shell=False,
        )
    except FileNotFoundError:
        return {"status": "error", "message": "Node.js introuvable dans le PATH"}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    except FileNotFoundError:
        return {"status": "error", "message": "npm/Node.js introuvable dans le PATH"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

    return {"status": "started", "url": f"http://localhost:{_FLASHLOAN_PORT}", "pid": _flashloan_proc.pid}


@app.post("/analyze/graph")
async def analyze_graph(req: AnalyzeGraphRequest, background: BackgroundTasks):
    """
    Reçoit un graphe déjà construit côté front (simulation de flux de tx)
    et lance le pipeline agent IA dessus. Skip Etherscan.
    Résultats broadcastés via WebSocket.
    """
    background.add_task(
        run_pipeline_from_graph,
        req.nodes,
        req.edges,
        req.seed_address,
        req.amount_eth,
        req.protocol_name,
    )
    return {"status": "started", "nodes": len(req.nodes), "edges": len(req.edges)}


# ─── Mode Replay (démo jury) ─────────────────────────────────────────────────

REPLAY_HACKS = {
    "euler": {
        "address": "0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4",
        "amount_eth": 61_000.0,      # ~$197M au prix de l'époque
        "protocol_name": "Euler Finance",
        "start_block": 16_817_996,   # bloc du hack (13 mars 2023)
    },
    "ronin": {
        "address": "0x098b716b8aaf21512996dc57eb0615e2383e2f96",
        "amount_eth": 173_600.0,     # ~$625M
        "protocol_name": "Ronin Bridge",
        "start_block": 14_442_834,
    },
}


@app.post("/replay/{hack_name}")
async def replay(hack_name: str, background: BackgroundTasks):
    """Rejoue un hack historique depuis les données BigQuery."""
    hack = REPLAY_HACKS.get(hack_name)
    if not hack:
        return {"error": f"Hack inconnu. Disponibles : {list(REPLAY_HACKS.keys())}"}

    background.add_task(
        run_pipeline,
        hack["address"],
        hack["amount_eth"],
        hack["protocol_name"],
        hack["start_block"],
    )
    return {"status": "replay_started", "hack": hack_name, **hack}


# ─── Historique ──────────────────────────────────────────────────────────────

@app.get("/incidents")
async def get_incidents():
    incidents = await get_recent_incidents(limit=20)
    return {"incidents": incidents}
