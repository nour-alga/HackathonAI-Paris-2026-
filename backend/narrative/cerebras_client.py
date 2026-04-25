"""
Génération du rapport d'incident via Llama 3.1 70B sur Cerebras.
Reçoit les outputs structurés du GAT + LSTM et génère un rapport humain.
"""
import os
from cerebras.cloud.sdk import Cerebras

_client: Cerebras | None = None

SYSTEM_PROMPT = """Tu es KOVER.IA, un système expert en détection de blanchiment \
de cryptomonnaies. Tu analyses les outputs de modèles ML (GAT + LSTM) et génères \
des rapports d'incident clairs et actionnables pour les équipes de sécurité et \
les autorités. Tu connais les techniques de blanchiment DeFi : peel chains, \
mixeurs (Tornado Cash), bridges cross-chain, et les hacks majeurs historiques."""


def get_client() -> Cerebras:
    global _client
    if _client is None:
        _client = Cerebras(api_key=os.getenv("CEREBRAS_API_KEY"))
    return _client


def generate_report(
    gat_scores: dict[str, float],
    lstm_prediction: dict[str, float],
    sequence: list[str],
    hack_context: dict,
) -> str:
    """
    Génère un rapport d'incident narratif en streaming.
    Retourne le texte complet du rapport.
    """
    client = get_client()

    top_destination = max(lstm_prediction, key=lstm_prediction.get)
    top_prob = lstm_prediction[top_destination]
    tainted_count = sum(1 for s in gat_scores.values() if s > 0.5)

    prompt = f"""
Analyse d'incident de blanchiment en cours :

CONTEXTE :
- Protocole hacké : {hack_context.get('protocol', 'inconnu')}
- Montant volé estimé : ${hack_context.get('amount_usd', 0):,.0f}
- Minutes depuis le hack : {hack_context.get('minutes_elapsed', 0)}

RÉSULTATS GAT (détection réseau) :
- Wallets analysés : {len(gat_scores)}
- Wallets taintés (score > 0.5) : {tainted_count}
- Score maximum détecté : {max(gat_scores.values(), default=0):.2f}

RÉSULTATS LSTM (prédiction destination) :
- Séquence observée : {' → '.join(sequence)}
- Prochaine destination probable : {top_destination} ({top_prob*100:.0f}%)

Génère un rapport d'incident structuré avec :
1. Résumé exécutif (2 phrases)
2. Ce qui se passe techniquement
3. Prochaine action du hacker et délai estimé
4. Actions immédiates recommandées (prioriser)
"""

    report = ""
    stream = client.chat.completions.create(
        model="qwen-3-235b-a22b-instruct-2507",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        stream=True,
        max_tokens=512,
    )

    for chunk in stream:
        delta = chunk.choices[0].delta.content or ""
        report += delta

    return report
