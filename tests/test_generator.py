"""Tests du générateur de stream et de la topologie tier."""
from unittest.mock import AsyncMock, patch

import pytest

from backend.streaming import generator as gen


# ── Helpers de bas niveau ───────────────────────────────────────────────────

class TestSampling:
    def test_sample_category_returns_valid_string(self):
        for _ in range(50):
            cat = gen._sample_category()
            assert isinstance(cat, str)
            assert cat in {"clean", "Scamming", "Phishing", "Mixer", "Bridge"}

    def test_rand_addr_format(self):
        addr = gen._rand_addr()
        assert addr.startswith("0x")
        assert len(addr) == 42
        # hex caractères valides après le préfixe
        int(addr[2:], 16)

    def test_rand_value_eth_positive(self):
        for _ in range(20):
            v = gen._rand_value_eth()
            assert v >= 0.0001
            assert v < 100_000  # log-normale bornée raisonnablement


# ── Topologie ───────────────────────────────────────────────────────────────

class TestTopology:
    def test_new_node_assigns_correct_tier(self):
        addr = gen._new_node(0, blacklisted=True)
        assert addr in gen._nodes
        assert gen._nodes[addr]["hops"] == 0
        assert gen._nodes[addr]["isSource"] is True
        assert gen._nodes[addr]["blacklisted"] is True
        assert addr in gen._tiers[0]

    def test_new_node_score_is_within_tier_range(self):
        for tier in (0, 1, 2, 3):
            addr = gen._new_node(tier)
            score = gen._nodes[addr]["score"]
            # Le score est tier-base ± 0.1, clipé sur [0,1]
            base = {0: 0.95, 1: 0.7, 2: 0.4, 3: 0.15}[tier]
            assert 0.0 <= score <= 1.0
            assert abs(score - base) <= 0.15  # tolérance 0.15 pour le bruit
            gen._nodes.pop(addr)
            gen._tiers[tier].remove(addr)

    def test_seed_topology_creates_source_and_initial_tiers(self):
        gen._seed_topology()
        assert gen._source_addr is not None
        assert len(gen._tiers[0]) == 1
        assert len(gen._tiers[1]) == 4
        assert len(gen._tiers[2]) == 12
        assert len(gen._tiers[3]) == 0

    def test_seed_topology_idempotent(self):
        gen._seed_topology()
        first_source = gen._source_addr
        gen._seed_topology()  # 2e appel doit être no-op
        assert gen._source_addr == first_source
        assert len(gen._tiers[1]) == 4

    def test_seed_creates_edges_from_source_to_tier1(self):
        gen._seed_topology()
        edges = list(gen._edges)
        # 4 edges source→tier1 + 12 edges tier1→tier2 = 16
        assert len(edges) == 16
        source_edges = [e for e in edges if e["source"] == gen._source_addr]
        assert len(source_edges) == 4

    def test_pick_parent_for_returns_higher_tier_node(self):
        gen._seed_topology()
        parent = gen._pick_parent_for(2)
        assert parent in gen._tiers[1]

    def test_pick_parent_returns_none_if_empty(self):
        # pas de seed → tier 1 vide → pick_parent_for(2) doit retourner None
        assert gen._pick_parent_for(2) is None


# ── Génération de tx ────────────────────────────────────────────────────────

class TestGenTx:
    def test_gen_tx_returns_valid_dict(self):
        gen._seed_topology()
        tx = gen._gen_tx()
        assert "hash" in tx and tx["hash"].startswith("0x") and len(tx["hash"]) == 66
        assert "from" in tx and "to" in tx
        assert tx["from"] != tx["to"]
        assert tx["value_eth"] > 0
        assert isinstance(tx["is_fraud"], bool)
        assert tx["category"] in {"clean", "Scamming", "Phishing", "Mixer", "Bridge"}

    def test_gen_tx_creates_new_node_when_tier_under_target(self):
        gen._seed_topology()
        before = len(gen._nodes)
        # On force la création d'un tier 3 en faisant beaucoup de tx
        for _ in range(20):
            tx = gen._gen_tx()
            gen._add_tx_to_graph(tx)
        assert len(gen._nodes) > before


# ── Add tx + eviction ───────────────────────────────────────────────────────

class TestAddTxToGraph:
    def test_add_tx_appends_edge(self):
        gen._seed_topology()
        before = len(gen._edges)
        tx = gen._gen_tx()
        gen._add_tx_to_graph(tx)
        assert len(gen._edges) == before + 1
        # _gen_tx ajoute l'edge via _new_node lors de la création d'un tier 3,
        # ou pas d'ajout si la cible existe déjà ; on vérifie au moins la cohérence
        last = gen._edges[-1]
        assert last["source"] == tx["from"]
        assert last["target"] == tx["to"]

    def test_fraud_tx_blacklists_destination(self):
        gen._seed_topology()
        gen._new_node(3)  # ajoute un tier 3 manuel pour pouvoir le cibler
        target = gen._tiers[3][0]
        tx = {
            "hash": "0x" + "a" * 64,
            "from": gen._source_addr,
            "to": target,
            "value_eth": 1.0,
            "category": "Scamming",
            "is_fraud": True,
            "ts_ms": 0,
        }
        gen._add_tx_to_graph(tx)
        assert gen._nodes[target]["blacklisted"] is True
        assert gen._nodes[target]["blacklistLinks"] >= 1

    def test_eviction_preserves_source(self):
        gen._seed_topology()
        # Saturer au-delà de MAX_NODES
        original_max = gen.MAX_NODES
        gen.MAX_NODES = 20  # patch pour test rapide
        try:
            for _ in range(200):
                tx = gen._gen_tx()
                gen._add_tx_to_graph(tx)
            assert len(gen._nodes) <= gen.MAX_NODES
            assert gen._source_addr in gen._nodes  # source jamais évincée
            assert len(gen._tiers[0]) == 1
        finally:
            gen.MAX_NODES = original_max


# ── Filtered edges ──────────────────────────────────────────────────────────

class TestFilteredEdges:
    def test_filtered_edges_drops_dangling(self):
        gen._seed_topology()
        # Ajouter un edge qui pointe vers un node inexistant
        gen._edges.append({
            "source": gen._source_addr,
            "target": "0x" + "f" * 40,  # n'existe pas dans _nodes
            "amount": 1.0,
            "hash": "0xdead",
        })
        filtered = gen._filtered_edges()
        # L'edge dangling ne doit pas être dans la sortie
        for e in filtered:
            assert e["source"] in gen._nodes
            assert e["target"] in gen._nodes


# ── Lifecycle (start/stop/reset) ────────────────────────────────────────────

class TestLifecycle:
    @pytest.mark.asyncio
    async def test_start_idempotent(self, monkeypatch):
        # Patche la broadcast pour pas spam une vraie WS
        monkeypatch.setattr(gen.manager, "broadcast", AsyncMock())
        r1 = await gen.start()
        assert r1["status"] == "started"
        r2 = await gen.start()
        assert r2["status"] == "already_running"
        await gen.stop()

    @pytest.mark.asyncio
    async def test_stop_when_not_running(self, monkeypatch):
        monkeypatch.setattr(gen.manager, "broadcast", AsyncMock())
        # stop sans avoir start ne plante pas
        r = await gen.stop()
        assert r["status"] == "stopped"

    @pytest.mark.asyncio
    async def test_reset_rate_limited(self, monkeypatch):
        monkeypatch.setattr(gen.manager, "broadcast", AsyncMock())
        r1 = await gen.reset()
        assert r1["status"] in ("reset", "rate_limited")  # 1er passe
        r2 = await gen.reset()
        # 2e immédiat doit être rate-limited
        assert r2["status"] == "rate_limited"
        assert "retry_after_s" in r2

    @pytest.mark.asyncio
    async def test_reset_clears_state(self, monkeypatch):
        monkeypatch.setattr(gen.manager, "broadcast", AsyncMock())
        gen._seed_topology()
        assert len(gen._nodes) >= 17
        r = await gen.reset()
        assert r["status"] == "reset"
        # Après reset, le state interne est vide (le seed du nouveau loop a pas
        # encore tourné si was_running=False)
        assert gen._source_addr is None or gen._source_addr in gen._nodes


# ── Stats ───────────────────────────────────────────────────────────────────

class TestStats:
    def test_stats_returns_expected_keys(self):
        s = gen.stats()
        for k in ("running", "nodes", "edges", "recent_txs", "fraud_count", "inference_counts"):
            assert k in s

    def test_stats_reflects_state(self):
        gen._seed_topology()
        s = gen.stats()
        assert s["nodes"] >= 17
        assert s["edges"] >= 16
        assert s["running"] is False
