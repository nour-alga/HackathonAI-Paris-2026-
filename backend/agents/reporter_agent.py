"""Agent 3 — IncidentReporter : génère le rapport narratif final."""
import json
import os
from pathlib import Path
from cerebras.cloud.sdk import Cerebras

_client: Cerebras | None = None
_FEW_SHOT_PATH = Path(__file__).resolve().parent / "few_shot_examples.json"
_few_shot_cache: list[dict] | None = None

DEFAULT_MODEL = "qwen-3-235b-a22b-instruct-2507"


def get_client() -> Cerebras:
    global _client
    if _client is None:
        _client = Cerebras(api_key=os.getenv("CEREBRAS_API_KEY"))
    return _client


def _load_few_shot() -> list[dict]:
    """Charge les exemples few-shot générés par scripts/cerebras_finetune.py (mode fewshot)."""
    global _few_shot_cache
    if _few_shot_cache is not None:
        return _few_shot_cache
    if _FEW_SHOT_PATH.exists():
        try:
            data = json.loads(_FEW_SHOT_PATH.read_text(encoding="utf-8"))
            _few_shot_cache = data.get("examples", []) or []
        except Exception:
            _few_shot_cache = []
    else:
        _few_shot_cache = []
    return _few_shot_cache


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
    if not os.getenv("CEREBRAS_API_KEY"):
        # Fallback offline pour démo sans Cerebras.
        return _stub_report(taint_analysis, path_prediction, hack_context)

    client = get_client()
    model = os.getenv("CEREBRAS_FINE_TUNED_MODEL") or DEFAULT_MODEL

    system_prompt = """Tu es IncidentReporter, analyste en sécurité DeFi d'élite.
Tu synthétises les findings de multiples agents en un rapport d'incident clair,
urgent et actionnable pour les équipes de sécurité et les autorités."""

    few_shot = _load_few_shot()
    if few_shot:
        examples_text = "\n\n".join(
            f"EXEMPLE {i+1} —\nInput: {ex['prompt']}\nClassification: {ex['completion']}"
            for i, ex in enumerate(few_shot[:12])
        )
        system_prompt += (
            "\n\nVoici des exemples annotés (Salam Ammari) pour calibrer ton jugement "
            "sur ce qui constitue une fraude vs un flux légitime :\n\n" + examples_text
        )

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
        model=model,
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


def _stub_report(taint_analysis: dict, path_prediction: dict, hack_context: dict) -> str:
    """Rapport de fallback quand Cerebras n'est pas disponible."""
    n = len(taint_analysis)
    dest = path_prediction.get("next_destination", "unknown")
    prob = path_prediction.get("probability", 0) or 0
    return (
        f"1. RÉSUMÉ EXÉCUTIF\n"
        f"Incident détecté sur {hack_context.get('protocol', 'Unknown')} — "
        f"{n} wallets taintés identifiés, destination probable : {dest} ({prob:.0%}).\n\n"
        f"2. ANALYSE TECHNIQUE\n"
        f"Le pipeline a propagé un score de taint via les transactions sortantes "
        f"depuis l'adresse source. Les wallets impliqués présentent une concentration "
        f"de fonds suspects et une vélocité de transfert élevée.\n\n"
        f"3. PRÉDICTION\n"
        f"Le modèle LSTM anticipe un transfert vers {dest} dans les "
        f"{path_prediction.get('eta_minutes', '?')} prochaines minutes.\n\n"
        f"4. ACTIONS IMMÉDIATES\n"
        f"- Geler on-chain les {n} adresses taintées via le DAO.\n"
        f"- Notifier les CEX et bridges partenaires.\n"
        f"- Surveiller la destination {dest} pour confirmation.\n\n"
        f"[Rapport généré en mode offline — CEREBRAS_API_KEY non configurée]"
    )
