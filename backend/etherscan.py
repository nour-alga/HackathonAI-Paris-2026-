"""
Etherscan API client — fetches real on-chain data.
Docs: https://docs.etherscan.io/
"""

import httpx
import json
from pathlib import Path

BASE_URL = "https://api.etherscan.io/v2/api"
CACHE_FILE = Path(__file__).parent.parent / "data" / "euler_cache.json"

EULER_HACKER = "0xb66cd966670d962C227B3EABA30a872DbFb995db"
ATTACK_BLOCK_START = 16817000
ATTACK_BLOCK_END = 16820000


class EtherscanClient:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.client = httpx.AsyncClient(timeout=15.0)

    async def _get(self, params: dict) -> dict:
        params["apikey"] = self.api_key
        params["chainid"] = 1
        response = await self.client.get(BASE_URL, params=params)
        response.raise_for_status()
        data = response.json()
        if data.get("status") == "0" and data.get("message") != "No transactions found":
            raise ValueError(f"Etherscan error: {data.get('result')}")
        return data

    async def get_transactions(self, address: str, start_block: int = 0, end_block: int = 99999999) -> list:
        """Normal transactions for an address."""
        data = await self._get({
            "module": "account",
            "action": "txlist",
            "address": address,
            "startblock": start_block,
            "endblock": end_block,
            "sort": "asc",
        })
        return data.get("result", [])

    async def get_token_transfers(self, address: str, start_block: int = 0, end_block: int = 99999999) -> list:
        """ERC-20 token transfers for an address."""
        data = await self._get({
            "module": "account",
            "action": "tokentx",
            "address": address,
            "startblock": start_block,
            "endblock": end_block,
            "sort": "asc",
        })
        return data.get("result", [])

    async def get_internal_transactions(self, tx_hash: str) -> list:
        """Internal transactions for a specific transaction hash."""
        data = await self._get({
            "module": "account",
            "action": "txlistinternal",
            "txhash": tx_hash,
        })
        return data.get("result", [])

    async def get_euler_attack_data(self) -> dict:
        """
        Fetches all data around the Euler Finance attack window.
        Results are cached to avoid redundant API calls.
        """
        if CACHE_FILE.exists():
            with open(CACHE_FILE, "r") as f:
                return json.load(f)

        txs = await self.get_transactions(
            EULER_HACKER,
            start_block=ATTACK_BLOCK_START,
            end_block=ATTACK_BLOCK_END,
        )
        token_transfers = await self.get_token_transfers(
            EULER_HACKER,
            start_block=ATTACK_BLOCK_START,
            end_block=ATTACK_BLOCK_END,
        )

        result = {
            "address": EULER_HACKER,
            "block_range": {"start": ATTACK_BLOCK_START, "end": ATTACK_BLOCK_END},
            "transactions": txs,
            "token_transfers": token_transfers,
        }

        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(CACHE_FILE, "w") as f:
            json.dump(result, f, indent=2)

        return result

    async def close(self):
        await self.client.aclose()
