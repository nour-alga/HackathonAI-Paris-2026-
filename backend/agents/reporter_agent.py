"""Agent 3 — IncidentReporter : génère le rapport narratif final."""
import json
import os
from cerebras.cloud.sdk import Cerebras

_client: Cerebras | None = None


def get_client() -> Cerebras:
    global _client
    if _client is None:
        _client = Cerebras(api_key=os.getenv("CEREBRAS_API_KEY"))
    return _client


def generate_report(
    taint_analysis: dict,
    path_prediction: dict,
    hack_context: dict,
) -> str:
    """
    Génère un rapport d'incident narratif en streaming.

    Args:
        taint_analysis: résultat de TaintAnalyst
        path_prediction: résultat de PathPredictor
        hack_context: {protocol, amount_usd, minutes_elapsed, tainted_count}

    Returns:
        Rapport texte complet
    """
    client = get_client()

    system_prompt = """Tu es IncidentReporter, analyste en sécurité DeFi d'élite.
Tu synthétises les findings de multiples agents en un rapport d'incident clair,
urgent et actionnable pour les équipes de sécurité et les autorités."""

    user_prompt = f"""
Incident détecté :
- Protocole hacké : {hack_context.get('protocol', 'Unknown')}
- Montant volé : ${hack_context.get('amount_usd', 0):,.0f}
- Minutes écoulées : {hack_context.get('minutes_elapsed', 0)}

Analyse TaintAnalyst :
- Wallets taintés détectés : {hack_context.get('tainted_count', 0)}
- Scores taint : {json.dumps(taint_analysis, indent=2)[:500]}...

Prédiction PathPredictor :
- Prochaine destination : {path_prediction.get('next_destination')}
- Probabilité : {path_prediction.get('probability', 0):.0%}
- ETA : {path_prediction.get('eta_minutes')} minutes

Génère un rapport structuré :

1. RÉSUMÉ EXÉCUTIF (1-2 phrases)
2. ANALYSE TECHNIQUE (ce qui se passe)
3. PRÉDICTION (prochaines actions du hacker)
4. ACTIONS IMMÉDIATES RECOMMANDÉES (par ordre de priorité)
"""

    report = ""
    stream = client.chat.completions.create(
        model="qwen-3-235b-a22b-instruct-2507",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        stream=True,
        max_tokens=512,
    )

    for chunk in stream:
        delta = chunk.choices[0].delta.content or ""
        report += delta

    return report
