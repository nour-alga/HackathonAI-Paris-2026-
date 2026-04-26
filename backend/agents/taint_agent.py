"""Agent 1 — TaintAnalyst : détecte et score les wallets taintés."""
import json
import os
from typing import Any

try:  # pragma: no cover
    from cerebras.cloud.sdk import Cerebras as _CerebrasClient  # type: ignore
except Exception:  # pragma: no cover
    _CerebrasClient = None  # type: ignore

_client: Any = None


def get_client() -> Any:
    global _client
    if _client is None:
        if _CerebrasClient is None:
            raise RuntimeError("cerebras-cloud-sdk not installed")
        _client = _CerebrasClient(api_key=os.getenv("CEREBRAS_API_KEY"))
    return _client


def analyze_taint(wallets: list[dict], source_address: str | None, amount_eth: float) -> dict:
    """
    Analyse une liste de wallets pour scorer leur niveau de taint.

    Args:
        wallets: list[{address, amount_eth, hops, tx_count}]
        source_address: adresse du hacker
        amount_eth: montant volé en ETH

    Returns:
        {wallet_address: {score: float, flags: [str], reasoning: str}}
    """
    client = get_client()

    system_prompt = """Tu es TaintAnalyst, un expert en forensics blockchain spécialisé dans
la détection de fonds volés Ethereum. Tu analyses des wallets et identifies lesquels
contiennent probablement des fonds volés (taintés).

Indicateurs de taint :
- Proximité au wallet source (hops < 3 → suspect)
- Montants multiples de la somme volée
- Patterns de splitting rapide entre wallets
- Interactions avec Tornado Cash ou bridges anonymes
- Mouvements rapides (volonté de cacher les fonds)"""

    wallet_json = json.dumps(wallets[:20], indent=2)  # Max 20 pour économiser tokens

    user_prompt = f"""
Hack détecté :
- Wallet source : {source_address}
- Montant volé : {amount_eth:.2f} ETH
- Wallets à analyser : {len(wallets)}

Données wallets :
{wallet_json}

Pour chaque wallet, retourne un JSON structuré avec :
- taint_score : float 0.0-1.0 (0=propre, 1=certain taint)
- flags : liste de flags détectés
- reasoning : explication courte

Format réponse (JSON valide, une ligne par wallet) :
{{
  "wallet_address": {{
    "taint_score": 0.75,
    "flags": ["hops_close", "suspicious_amount"],
    "reasoning": "3 hops du source, amount = 2x stolen"
  }}
}}
"""

    response = ""
    stream = client.chat.completions.create(
        model="qwen-3-235b-a22b-instruct-2507",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        stream=True,
        max_tokens=1024,
    )

    for chunk in stream:
        delta = chunk.choices[0].delta.content or ""
        response += delta

    try:
        result = json.loads(response)
    except json.JSONDecodeError:
        result = {w["address"]: {"score": 0.5, "flags": ["parse_error"], "reasoning": "Could not parse response"}
                  for w in wallets[:20]}

    return result
