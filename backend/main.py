import os
from contextlib import asynccontextmanager
from dotenv import find_dotenv, load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from etherscan import EtherscanClient
from static_data import (
    get_alert_details,
    get_dispersion_graph,
    get_summary_stats,
    get_timeline,
)

# find_dotenv() walks up the directory tree to find the .env file
load_dotenv(find_dotenv(usecwd=True))

etherscan: EtherscanClient = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global etherscan
    api_key = os.getenv("ETHERSCAN_API_KEY", "")
    etherscan = EtherscanClient(api_key=api_key)
    yield
    await etherscan.close()


app = FastAPI(title="KOVER.IA API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok", "project": "KOVER.IA"}


@app.get("/api/debug")
def debug():
    key = os.getenv("ETHERSCAN_API_KEY", "")
    return {"key_set": bool(key), "key_preview": key[:6] + "..." if key else "empty"}


@app.get("/api/euler/stats")
def stats():
    """High-level summary stats for the dashboard header."""
    return get_summary_stats()


@app.get("/api/euler/timeline")
def timeline():
    """Block-by-block risk score progression — drives the animated score bar."""
    return get_timeline()


@app.get("/api/euler/alert")
def alert():
    """Full alert details: attacker, stolen funds, AI analysis, alerts sent."""
    return get_alert_details()


@app.get("/api/euler/graph")
def graph():
    """Tainted flow graph — nodes (wallets/entities) and edges (transfers)."""
    return get_dispersion_graph()


@app.get("/api/euler/transactions")
async def transactions():
    """
    Live Etherscan data for the Euler hacker wallet.
    Cached in data/euler_cache.json after first call.
    """
    if not os.getenv("ETHERSCAN_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="ETHERSCAN_API_KEY not set. Add it to your .env file.",
        )
    try:
        data = await etherscan.get_euler_attack_data()
        return data
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
