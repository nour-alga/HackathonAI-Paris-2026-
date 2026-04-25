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
from backend.pipeline import run_pipeline
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
