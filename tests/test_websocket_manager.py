"""Tests du ConnectionManager WebSocket."""
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.websocket.manager import ConnectionManager


@pytest.fixture
def fresh_manager():
    return ConnectionManager()


class TestConnect:
    @pytest.mark.asyncio
    async def test_connect_accepts_and_tracks(self, fresh_manager):
        ws = MagicMock()
        ws.accept = AsyncMock()
        await fresh_manager.connect(ws)
        ws.accept.assert_awaited_once()
        assert ws in fresh_manager.active

    @pytest.mark.asyncio
    async def test_multiple_connections_tracked_independently(self, fresh_manager):
        ws1, ws2, ws3 = (MagicMock(accept=AsyncMock()) for _ in range(3))
        for w in (ws1, ws2, ws3):
            await fresh_manager.connect(w)
        assert len(fresh_manager.active) == 3


class TestDisconnect:
    def test_disconnect_removes_from_active(self, fresh_manager):
        ws = MagicMock()
        fresh_manager.active.append(ws)
        fresh_manager.disconnect(ws)
        assert ws not in fresh_manager.active

    def test_disconnect_unknown_ws_is_safe(self, fresh_manager):
        # Disconnect d'une ws jamais connectée ne doit pas planter
        ws = MagicMock()
        fresh_manager.disconnect(ws)
        assert fresh_manager.active == []

    def test_disconnect_only_removes_target(self, fresh_manager):
        ws1, ws2, ws3 = MagicMock(), MagicMock(), MagicMock()
        fresh_manager.active.extend([ws1, ws2, ws3])
        fresh_manager.disconnect(ws2)
        assert ws1 in fresh_manager.active
        assert ws2 not in fresh_manager.active
        assert ws3 in fresh_manager.active


class TestBroadcast:
    @pytest.mark.asyncio
    async def test_broadcast_sends_json_envelope(self, fresh_manager):
        ws = MagicMock()
        ws.send_text = AsyncMock()
        fresh_manager.active.append(ws)
        await fresh_manager.broadcast("ping", {"x": 1})
        ws.send_text.assert_awaited_once()
        sent = ws.send_text.call_args.args[0]
        decoded = json.loads(sent)
        assert decoded == {"event": "ping", "data": {"x": 1}}

    @pytest.mark.asyncio
    async def test_broadcast_to_all_clients(self, fresh_manager):
        clients = [MagicMock(send_text=AsyncMock()) for _ in range(5)]
        fresh_manager.active.extend(clients)
        await fresh_manager.broadcast("ev", {"v": 42})
        for c in clients:
            c.send_text.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_broadcast_drops_dead_connections(self, fresh_manager):
        good = MagicMock(send_text=AsyncMock())
        dead = MagicMock(send_text=AsyncMock(side_effect=ConnectionError("closed")))
        fresh_manager.active.extend([good, dead])
        await fresh_manager.broadcast("ev", {})
        # La ws morte doit être évincée
        assert good in fresh_manager.active
        assert dead not in fresh_manager.active

    @pytest.mark.asyncio
    async def test_broadcast_handles_no_clients(self, fresh_manager):
        # Broadcast sans clients ne plante pas
        await fresh_manager.broadcast("ev", {"data": "anything"})
        assert fresh_manager.active == []

    @pytest.mark.asyncio
    async def test_broadcast_complex_payload_serializable(self, fresh_manager):
        ws = MagicMock(send_text=AsyncMock())
        fresh_manager.active.append(ws)
        payload = {
            "nodes": [{"id": "0xa", "score": 0.9}, {"id": "0xb", "score": 0.5}],
            "edges": [{"source": "0xa", "target": "0xb", "amount": 1.5}],
            "nested": {"deep": {"value": [1, 2, 3]}},
        }
        await fresh_manager.broadcast("graph_state", payload)
        sent = ws.send_text.call_args.args[0]
        decoded = json.loads(sent)
        assert decoded["data"] == payload

    @pytest.mark.asyncio
    async def test_broadcast_isolates_one_failure_from_others(self, fresh_manager):
        # Si une ws plante, les autres doivent quand même recevoir
        good1 = MagicMock(send_text=AsyncMock())
        bad = MagicMock(send_text=AsyncMock(side_effect=RuntimeError("oops")))
        good2 = MagicMock(send_text=AsyncMock())
        fresh_manager.active.extend([good1, bad, good2])
        await fresh_manager.broadcast("ev", {})
        good1.send_text.assert_awaited_once()
        good2.send_text.assert_awaited_once()
        assert bad not in fresh_manager.active


class TestSingletonModule:
    def test_module_exposes_singleton_instance(self):
        from backend.websocket import manager as mod
        assert isinstance(mod.manager, ConnectionManager)
