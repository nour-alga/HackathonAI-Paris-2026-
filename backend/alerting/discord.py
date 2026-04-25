"""Envoi d'alertes sur Discord via webhook."""
import os
import httpx


async def send_alert(severity: str, summary: str, details: str, tx_hash: str = ""):
    webhook_url = os.getenv("DISCORD_WEBHOOK_URL")
    if not webhook_url:
        return

    colors = {"LOW": 0x3498db, "MEDIUM": 0xf39c12, "HIGH": 0xe67e22, "CRITICAL": 0xe74c3c}
    color = colors.get(severity, 0x95a5a6)

    payload = {
        "embeds": [{
            "title": f"🚨 KOVER.IA — {severity}",
            "description": summary,
            "color": color,
            "fields": [
                {"name": "Analyse", "value": details[:1000], "inline": False},
                {"name": "TX Hash", "value": tx_hash or "N/A", "inline": True},
            ],
            "footer": {"text": "KOVER.IA — Tainted Flow Detection"},
        }]
    }

    async with httpx.AsyncClient() as client:
        await client.post(webhook_url, json=payload)
