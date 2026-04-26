"""Configuration pytest commune : reset l'état global du générateur entre tests."""
import asyncio

import pytest

from backend.streaming import generator as gen
from backend.streaming import proof


@pytest.fixture(autouse=True)
def _reset_generator_state():
    """Avant chaque test : vide tout le state in-memory du générateur."""
    gen._nodes.clear()
    gen._edges.clear()
    gen._recent_txs.clear()
    for t in gen._tiers:
        gen._tiers[t].clear()
    gen._source_addr = None
    gen._running = False
    gen._task = None
    gen._last_reset_ts = 0.0
    proof._inference_log.clear()
    yield
    # cleanup post-test
    gen._nodes.clear()
    gen._edges.clear()


@pytest.fixture
def event_loop():
    """Boucle dédiée par test pour éviter les fuites de tasks."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()
