"""Agent 2 — PathPredictor : prédit la prochaine destination des fonds volés."""
import json
import os
from cerebras.cloud.sdk import Cerebras

_client: Cerebras | None = None


def get_client() -> Cerebras:
    global _client
    if _client is None:
        _client = Cerebras(api_key=os.getenv("CEREBRAS_API_KEY"))
    return _client


def predict_path(
    tainted_count: int,
    max_taint_score: float,
    move_sequence: list[str],
    amount_eth: float,
    protocol: str,
) -> dict:
    """
    Prédit la prochaine destination des fonds volés.

    Args:
        tainted_count: nombre de wallets taintés détectés
        max_taint_score: score de taint maximum observé
        move_sequence: séquence de mouvements observée
        amount_eth: montant volé en ETH
        protocol: nom du protocole hacké

    Returns:
        {
            next_destination: str,
            probability: float (0-1),
            eta_minutes: int,
            reasoning: str
        }
    """
    client = get_client()

    system_prompt = """Tu es PathPredictor, expert en tracking de fonds volés dans DeFi.
Tu prédit où vont aller les fonds volés basé sur les patterns observés et les destinations historiques.

Destinations connues :
- Tornado Cash : mixer privé populaire (illégal US)
- Bridges anonymes : Stargate, HOP Protocol, Across
- CEX on-ramps : Binance, Coinbase, Kraken (KYC requis)
- Wallets dormants : pour attendre que les soupçons diminuent
- RenBTC / THORChain : bridges de sortie vers Bitcoin
- Pools de liquidité : masquer via farming
- Contrats de tiers : transferts à d'autres hackers / gangs

Patterns observés :
- Vol rapide → mixer rapide (Tornado Cash dans 5-30 min)
- Vol patient → accumulation puis bridge lent
- Vol lancé depuis CEX → redirection simple vers hot wallet"""

    user_prompt = f"""
Hack analysé :
- Protocole : {protocol}
- Montant volé : {amount_eth:.2f} ETH
- Wallets taintés : {tainted_count}
- Taint score max : {max_taint_score:.2f}/1.0
- Mouvement observé : {' → '.join(move_sequence)}

Basé sur le pattern, prédit la prochaine étape du hacker.

Retourne un JSON :
{{
  "next_destination": "Tornado Cash | Binance | Stargate Bridge | Dormant Wallet | ...",
  "probability": 0.85,
  "eta_minutes": 15,
  "reasoning": "explication courte du pattern prédit"
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
        max_tokens=256,
    )

    for chunk in stream:
        delta = chunk.choices[0].delta.content or ""
        response += delta

    try:
        result = json.loads(response)
    except json.JSONDecodeError:
        result = {
            "next_destination": "Unknown",
            "probability": 0.5,
            "eta_minutes": 30,
            "reasoning": "Could not parse agent response",
        }

    return result
