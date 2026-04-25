"""
Récupère toutes les données utiles du hack Euler Finance.
Lance avec : python fetch_euler.py

Sources :
- Contrat Euler Finance (les fonds drainés)
- Wallet du hacker (dispersion des fonds)
- Contrat exploit déployé par le hacker
- Transactions internes des TXs d'attaque
"""

import httpx
import json
from pathlib import Path
from dotenv import find_dotenv, load_dotenv
import os
import time

load_dotenv(find_dotenv(usecwd=True))
API_KEY = os.getenv("ETHERSCAN_API_KEY", "")
if not API_KEY:
    raise SystemExit("ETHERSCAN_API_KEY manquant dans .env")

BASE = "https://api.etherscan.io/v2/api"

# Adresses clés du hack
HACKER_EOA       = "0xb66cd966670d962C227B3EABA30a872DbFb995db"
EULER_CONTRACT   = "0x27182842E098f60e3D576794A5bFFb0777E025d3"  # Euler Finance principal
EXPLOIT_CONTRACT = "0xeBC29199C817Dc47BA12E3F86102564D640CBf99"  # Contrat d'exploit du hacker

# Transactions d'attaque principales (plusieurs TXs)
ATTACK_TXS = [
    "0xc310a0affe2169d1f6feec1c63dbc7f7c62a887ad48b6276cbe600ad69a2834f",
    "0x71a908be0bef6174bccc3d493becdfd28395d78898e355d451cb52f7bac0c1dd",
    "0x62bd3d31a7b75c98ccf2b7e7d5abf30a1f5c2e7ef3a2a5c2a9f1f4d3b0c8e24",
]

# Fenêtre large autour du hack (±200 000 blocs ≈ ±1 mois)
BLOCK_START = 16600000
BLOCK_END   = 17000000


def get(params: dict, retries=3) -> list:
    params = {**params, "apikey": API_KEY, "chainid": 1}
    for attempt in range(retries):
        try:
            r = httpx.get(BASE, params=params, timeout=30)
            r.raise_for_status()
            data = r.json()
            if data.get("status") == "0":
                msg = data.get("result", "")
                if "No transactions" in str(msg) or "No records" in str(msg):
                    return []
                if "Max rate limit" in str(msg):
                    print(f"  Rate limit, attente 2s...")
                    time.sleep(2)
                    continue
                print(f"  Etherscan warning: {msg}")
                return []
            return data.get("result", [])
        except Exception as e:
            print(f"  Erreur (tentative {attempt+1}): {e}")
            time.sleep(1)
    return []


def get_paginated(base_params: dict, label: str) -> list:
    """Récupère toutes les pages (10 000 max par appel Etherscan)."""
    all_results = []
    page = 1
    offset = 10000
    while True:
        params = {**base_params, "page": page, "offset": offset}
        print(f"  {label} — page {page} ({len(all_results)} récupérés)...")
        batch = get(params)
        if not batch:
            break
        all_results.extend(batch)
        if len(batch) < offset:
            break  # Dernière page
        page += 1
        time.sleep(0.25)  # Respecte le rate limit
    return all_results


print("=" * 60)
print("KOVER.IA — Fetch Euler Finance Hack Data")
print("=" * 60)

result = {
    "meta": {
        "hacker_eoa": HACKER_EOA,
        "euler_contract": EULER_CONTRACT,
        "exploit_contract": EXPLOIT_CONTRACT,
        "block_range": {"start": BLOCK_START, "end": BLOCK_END},
    },
    "euler_contract": {},
    "hacker_eoa": {},
    "exploit_contract": {},
    "attack_internals": {},
}

# 1. Contrat Euler Finance — transactions normales
print("\n[1/7] Transactions du contrat Euler Finance...")
result["euler_contract"]["transactions"] = get_paginated({
    "module": "account", "action": "txlist",
    "address": EULER_CONTRACT,
    "startblock": BLOCK_START, "endblock": BLOCK_END, "sort": "asc",
}, "Euler txs")

# 2. Contrat Euler Finance — token transfers (les fonds drainés)
print("\n[2/7] Token transfers du contrat Euler Finance...")
result["euler_contract"]["token_transfers"] = get_paginated({
    "module": "account", "action": "tokentx",
    "address": EULER_CONTRACT,
    "startblock": BLOCK_START, "endblock": BLOCK_END, "sort": "asc",
}, "Euler token transfers")

# 3. Wallet du hacker — transactions (plage large)
print("\n[3/7] Transactions du wallet hacker (plage large)...")
result["hacker_eoa"]["transactions"] = get_paginated({
    "module": "account", "action": "txlist",
    "address": HACKER_EOA,
    "startblock": 16600000, "endblock": 17500000, "sort": "asc",
}, "Hacker txs")

# 4. Wallet du hacker — token transfers
print("\n[4/7] Token transfers du wallet hacker...")
result["hacker_eoa"]["token_transfers"] = get_paginated({
    "module": "account", "action": "tokentx",
    "address": HACKER_EOA,
    "startblock": 16600000, "endblock": 17500000, "sort": "asc",
}, "Hacker token transfers")

# 5. Contrat exploit — transactions
print("\n[5/7] Transactions du contrat exploit...")
result["exploit_contract"]["transactions"] = get_paginated({
    "module": "account", "action": "txlist",
    "address": EXPLOIT_CONTRACT,
    "startblock": BLOCK_START, "endblock": BLOCK_END, "sort": "asc",
}, "Exploit contract txs")

# 6. Contrat exploit — token transfers
print("\n[6/7] Token transfers du contrat exploit...")
result["exploit_contract"]["token_transfers"] = get_paginated({
    "module": "account", "action": "tokentx",
    "address": EXPLOIT_CONTRACT,
    "startblock": BLOCK_START, "endblock": BLOCK_END, "sort": "asc",
}, "Exploit token transfers")

# 7. Transactions internes des TXs d'attaque
print("\n[7/7] Transactions internes des TXs d'attaque...")
for tx_hash in ATTACK_TXS:
    print(f"  TX: {tx_hash[:20]}...")
    internals = get({
        "module": "account", "action": "txlistinternal",
        "txhash": tx_hash,
    })
    result["attack_internals"][tx_hash] = internals
    time.sleep(0.2)

# Sauvegarde
out = Path("data/euler_hack.json")
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(result, indent=2))

# Résumé
total = (
    len(result["euler_contract"]["transactions"]) +
    len(result["euler_contract"]["token_transfers"]) +
    len(result["hacker_eoa"]["transactions"]) +
    len(result["hacker_eoa"]["token_transfers"]) +
    len(result["exploit_contract"]["transactions"]) +
    len(result["exploit_contract"]["token_transfers"]) +
    sum(len(v) for v in result["attack_internals"].values())
)

print("\n" + "=" * 60)
print("RÉSUMÉ")
print("=" * 60)
print(f"  Euler contract — txs:            {len(result['euler_contract']['transactions'])}")
print(f"  Euler contract — token transfers: {len(result['euler_contract']['token_transfers'])}")
print(f"  Hacker EOA — txs:                {len(result['hacker_eoa']['transactions'])}")
print(f"  Hacker EOA — token transfers:    {len(result['hacker_eoa']['token_transfers'])}")
print(f"  Exploit contract — txs:          {len(result['exploit_contract']['transactions'])}")
print(f"  Exploit contract — token txfers: {len(result['exploit_contract']['token_transfers'])}")
for tx, lst in result["attack_internals"].items():
    print(f"  Internal {tx[:16]}...:  {len(lst)}")
print(f"\n  TOTAL : {total} enregistrements")
print(f"  Sauvegardé dans : {out}")
