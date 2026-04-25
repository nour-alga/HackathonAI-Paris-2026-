"""
Test rapide Cerebras.
Usage : python backend/test_cerebras.py
"""
import os, sys
from dotenv import load_dotenv
load_dotenv(dotenv_path=".env")

api_key = os.getenv("CEREBRAS_API_KEY", "")
if not api_key:
    print("ERREUR : CEREBRAS_API_KEY manquante dans le .env")
    sys.exit(1)

from cerebras.cloud.sdk import Cerebras
client = Cerebras(api_key=api_key)

print(f"Clé : {api_key[:8]}{'*'*20}")

# Lister les modèles correctement
models_response = client.models.list()
model_ids = [m.id for m in models_response.data]
print(f"Modèles disponibles : {model_ids}")

# Meilleur modèle disponible
preferred = ["qwen-3-235b-a22b-instruct-2507", "gpt-oss-120b", "llama3.1-8b"]
chosen = next((m for m in preferred if m in model_ids), model_ids[0])
print(f"Modèle choisi : {chosen}\n")

# Test de génération
response = client.chat.completions.create(
    model=chosen,
    messages=[{"role": "user", "content": "Réponds uniquement 'KOVER.IA opérationnel'."}],
    max_tokens=10,
)
print(f"Réponse : {response.choices[0].message.content.strip()}")
print(f"Tokens utilisés : {response.usage.total_tokens}")
print(f"\nCerebras prêt — modèle : {chosen}")

# Estimation du coût
tokens_used = response.usage.total_tokens
cost_per_million = 0.60  # $ pour Qwen 3 235B sur Cerebras
cost = (tokens_used / 1_000_000) * cost_per_million
print(f"\nEstimation coût ce test : ${cost:.6f}")
print(f"Budget hackathon ($50) → {int(50 / cost_per_million * 1_000_000):,} tokens disponibles")
