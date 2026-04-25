"""
Taint Graph — cœur algorithmique de KOVER.IA.

Construit le graphe de transactions à partir d'une adresse source (hacker)
et propage le score de taint à travers le réseau de wallets.

Étapes :
  1. Fetch des transactions sortantes du wallet hacké (QuickNode/Etherscan)
  2. Construction du graphe NetworkX (wallets = nœuds, txs = arêtes)
  3. Score de taint initial basé sur les montants
  4. Inférence GAT pour affiner les scores
  5. Classification de chaque nœud (mixer, bridge, CEX, unknown)
"""
import asyncio
import os
from dataclasses import dataclass, field
from datetime import datetime

import httpx
import networkx as nx
import torch

from backend.models.gat.predict import score_graph

ETHERSCAN_API = "https://api.etherscan.io/api"
ETHERSCAN_KEY = os.getenv("ETHERSCAN_API_KEY", "")
TAINT_THRESHOLD = float(os.getenv("TAINT_THRESHOLD", "0.3"))
MAX_HOPS = 4  # profondeur maximale de propagation

# Adresses connues classifiées
KNOWN_ENTITIES: dict[str, str] = {
    # Mixeurs
    "0x722122df12d4e14e13ac3b6895a86e84145b6967": "tornado_cash",
    "0xdd4c48c0b24039969fc16d1cdf626eab821d3384": "tornado_cash",
    "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b": "tornado_cash",
    # Bridges
    "0x3ee18b2214aff97000d974cf647e7c347e8fa585": "bridge_crosschain",  # Wormhole
    "0xa0c68c638235ee32657e8f720a23cec1bfc77c77": "bridge_crosschain",  # Polygon Bridge
    # CEX hot wallets (exemples)
    "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be": "depot_cex",  # Binance
    "0xd551234ae421e3bcba99a0da6d736074f22192ff": "depot_cex",  # Binance 2
    "0xa910f92acdaf488fa6ef02174fb86208ad7ea4": "depot_cex",   # Coinbase
}


@dataclass
class WalletNode:
    address: str
    taint_score: float = 0.0        # score ML du GAT
    taint_raw: float = 0.0          # propagation de montant
    hops: int = 0
    amount_received_eth: float = 0.0
    entity_type: str = "unknown"    # tornado_cash | bridge_crosschain | depot_cex | unknown
    first_seen: datetime = field(default_factory=datetime.utcnow)


@dataclass
class TxEdge:
    tx_hash: str
    amount_eth: float
    timestamp: datetime
    block_number: int


class TaintGraph:
    def __init__(self, source_address: str, source_amount_eth: float):
        self.source = source_address.lower()
        self.source_amount = source_amount_eth
        self.graph = nx.DiGraph()
        self.nodes: dict[str, WalletNode] = {}
        self.move_sequence: list[str] = ["vol_initial"]

        # Nœud source
        self._add_node(source_address, taint_raw=1.0, hops=0)

    def _add_node(self, address: str, taint_raw: float, hops: int, amount_eth: float = 0.0):
        addr = address.lower()
        entity = KNOWN_ENTITIES.get(addr, "unknown")
        node = WalletNode(
            address=addr,
            taint_raw=taint_raw,
            hops=hops,
            amount_received_eth=amount_eth,
            entity_type=entity,
        )
        self.nodes[addr] = node
        self.graph.add_node(addr, **{
            "taint_raw": taint_raw,
            "hops": hops,
            "entity_type": entity,
            "amount_eth": amount_eth,
            # features pour le GAT (10 features par nœud)
            "x": self._compute_node_features(node),
        })

    def _compute_node_features(self, node: WalletNode) -> list[float]:
        """10 features par nœud pour le GAT."""
        return [
            node.taint_raw,
            float(node.hops),
            node.amount_received_eth,
            float(node.entity_type == "tornado_cash"),
            float(node.entity_type == "bridge_crosschain"),
            float(node.entity_type == "depot_cex"),
            float(node.entity_type == "unknown"),
            min(node.amount_received_eth / (self.source_amount + 1e-9), 1.0),
            float(node.hops <= 1),
            float(node.hops <= 2),
        ]

    def add_transaction(self, src: str, dst: str, edge: TxEdge, parent_taint: float):
        dst = dst.lower()
        src = src.lower()

        # Propagation du taint proportionnelle au montant
        child_taint = parent_taint * min(edge.amount_eth / (self.source_amount + 1e-9), 1.0)
        child_taint = min(child_taint, 1.0)

        if dst not in self.nodes:
            hops = self.nodes.get(src, WalletNode(src)).hops + 1
            self._add_node(dst, taint_raw=child_taint, hops=hops, amount_eth=edge.amount_eth)

        self.graph.add_edge(src, dst, **{
            "tx_hash": edge.tx_hash,
            "amount_eth": edge.amount_eth,
            "block_number": edge.block_number,
        })

        # Mise à jour de la séquence de mouvements
        entity = self.nodes[dst].entity_type
        if entity != "unknown" and entity not in self.move_sequence:
            self.move_sequence.append(entity)

        return child_taint

    def run_gat_scoring(self):
        """Lance l'inférence GAT sur le graphe courant et met à jour les scores."""
        if len(self.nodes) < 2:
            # Pas assez de nœuds pour le GAT
            for addr, node in self.nodes.items():
                node.taint_score = node.taint_raw
            return

        # Ajouter les features comme tensor au graphe NetworkX
        for addr, node in self.nodes.items():
            self.graph.nodes[addr]["x"] = torch.tensor(
                self._compute_node_features(node), dtype=torch.float
            )

        try:
            gat_scores = score_graph(self.graph)
            for addr, score in gat_scores.items():
                if addr in self.nodes:
                    self.nodes[addr].taint_score = score
        except Exception:
            # Si le modèle n'est pas encore entraîné, fallback sur taint_raw
            for addr, node in self.nodes.items():
                node.taint_score = node.taint_raw

    def get_tainted_wallets(self) -> list[WalletNode]:
        """Retourne les wallets avec un score > TAINT_THRESHOLD, triés par score."""
        tainted = [n for n in self.nodes.values() if n.taint_score >= TAINT_THRESHOLD]
        return sorted(tainted, key=lambda n: n.taint_score, reverse=True)

    def get_critical_entities(self) -> list[WalletNode]:
        """Retourne les wallets qui ont atteint un mixeur, bridge ou CEX."""
        return [n for n in self.nodes.values() if n.entity_type != "unknown"]

    def summary(self) -> dict:
        tainted = self.get_tainted_wallets()
        critical = self.get_critical_entities()
        return {
            "total_wallets": len(self.nodes),
            "tainted_count": len(tainted),
            "critical_entities": [
                {"address": n.address, "type": n.entity_type, "score": n.taint_score}
                for n in critical
            ],
            "move_sequence": self.move_sequence,
            "max_taint_score": max((n.taint_score for n in self.nodes.values()), default=0.0),
            "hops_reached": max((n.hops for n in self.nodes.values()), default=0),
        }


async def fetch_transactions(address: str, start_block: int = 0) -> list[dict]:
    """Récupère les transactions sortantes d'une adresse via Etherscan."""
    params = {
        "module": "account",
        "action": "txlist",
        "address": address,
        "startblock": start_block,
        "endblock": 99999999,
        "sort": "asc",
        "apikey": ETHERSCAN_KEY or "YourApiKeyToken",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(ETHERSCAN_API, params=params)
        data = resp.json()
        if data.get("status") == "1":
            return data.get("result", [])
        return []


async def build_taint_graph(
    source_address: str,
    source_amount_eth: float,
    start_block: int = 0,
    max_hops: int = MAX_HOPS,
) -> TaintGraph:
    """
    Construit itérativement le graphe de taint depuis une adresse source.
    Explore jusqu'à max_hops niveaux de profondeur.
    """
    graph = TaintGraph(source_address, source_amount_eth)
    to_explore = [(source_address, 1.0, 0)]  # (adresse, taint_parent, hop)
    explored = {source_address.lower()}

    while to_explore:
        address, parent_taint, hop = to_explore.pop(0)

        if hop >= max_hops:
            continue

        txs = await fetch_transactions(address, start_block)

        for tx in txs:
            dst = tx.get("to", "").lower()
            if not dst or dst == address.lower():
                continue

            amount_wei = int(tx.get("value", "0"))
            amount_eth = amount_wei / 1e18

            if amount_eth < 0.001:  # ignore les micro-txs dust
                continue

            edge = TxEdge(
                tx_hash=tx.get("hash", ""),
                amount_eth=amount_eth,
                timestamp=datetime.utcfromtimestamp(int(tx.get("timeStamp", 0))),
                block_number=int(tx.get("blockNumber", 0)),
            )

            child_taint = graph.add_transaction(address, dst, edge, parent_taint)

            if dst not in explored and child_taint >= TAINT_THRESHOLD:
                explored.add(dst)
                to_explore.append((dst, child_taint, hop + 1))

    # Scoring GAT sur le graphe complet
    graph.run_gat_scoring()

    return graph
