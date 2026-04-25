"""
Connexion WebSocket QuickNode — écoute les transactions en temps réel
sur une adresse cible (wallet hacké ou protocole).
"""
import asyncio
import json
import os
import websockets


async def stream_transactions(address: str, callback):
    """
    S'abonne aux transactions d'une adresse via QuickNode WebSocket.
    Appelle callback(tx) pour chaque transaction reçue.
    """
    ws_url = os.getenv("QUICKNODE_WS_URL")

    subscription = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_subscribe",
        "params": [
            "logs",
            {"address": address}
        ]
    }

    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps(subscription))
        async for message in ws:
            data = json.loads(message)
            if "params" in data:
                await callback(data["params"]["result"])
