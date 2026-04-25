"""
Lance ce script UNE fois : python fetch_euler.py
Il récupère les vraies données du hack Euler sur Etherscan
et les sauvegarde dans data/euler_hack.json
"""

import httpx
import json
from pathlib import Path
from dotenv import find_dotenv, load_dotenv
import os

load_dotenv(find_dotenv(usecwd=True))
API_KEY = os.getenv("ETHERSCAN_API_KEY", "")

BASE = "https://api.etherscan.io/v2/api"
HACKER = "0xb66cd966670d962C227B3EABA30a872DbFb995db"
ATTACK_TX = "0xc310a0affe2169d1f6feec1c63dbc7f7c62a887ad48b6276cbe600ad69a2834f"


def get(params):
    params["apikey"] = API_KEY
    params["chainid"] = 1
    r = httpx.get(BASE, params=params, timeout=20)
    r.raise_for_status()
    return r.json().get("result", [])


print("Récupération des transactions du hacker...")
txs = get({
    "module": "account",
    "action": "txlist",
    "address": HACKER,
    "startblock": 16817000,
    "endblock": 16820000,
    "sort": "asc",
})

print("Récupération des transferts de tokens...")
tokens = get({
    "module": "account",
    "action": "tokentx",
    "address": HACKER,
    "startblock": 16817000,
    "endblock": 16820000,
    "sort": "asc",
})

print("Récupération des transactions internes de l'attaque...")
internals = get({
    "module": "account",
    "action": "txlistinternal",
    "txhash": ATTACK_TX,
})

result = {
    "hacker_address": HACKER,
    "attack_tx": ATTACK_TX,
    "transactions": txs,
    "token_transfers": tokens,
    "internal_transactions": internals,
}

out = Path("data/euler_hack.json")
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(result, indent=2))

print(f"\nDone!")
print(f"  Transactions:           {len(txs)}")
print(f"  Token transfers:        {len(tokens)}")
print(f"  Internal transactions:  {len(internals)}")
print(f"  Sauvegardé dans: {out}")
