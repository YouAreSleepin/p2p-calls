"""
PEERLINK // FastAPI Backend
─────────────────────────────────────────────────
• Раздача собранного фронтенда из dist/
• Реестр активных пиров (in-memory)
• WebSocket для real-time уведомлений
• REST API для управления сессиями
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


# ─── APP SETUP ────────────────────────────────────

DIST_DIR = Path(__file__).parent / "dist"

app = FastAPI(
    title="PEERLINK",
    version="1.0.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── MODELS ───────────────────────────────────────

class PeerSession(BaseModel):
    peer_id: str
    nickname: str
    connected_at: str
    status: str = "online"


class RegisterRequest(BaseModel):
    peer_id: str
    nickname: Optional[str] = "ANON"


class CallRequest(BaseModel):
    from_peer_id: str
    to_peer_id: str
    nickname: str = "ANON"


# ─── STATE ────────────────────────────────────────

active_peers: dict[str, PeerSession] = {}


# ─── WEBSOCKET MANAGER ────────────────────────────

class ConnectionManager:
    """Управляет WebSocket-подключениями пиров."""

    def __init__(self):
        self._connections: dict[str, WebSocket] = {}

    async def connect(self, peer_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[peer_id] = websocket

    def disconnect(self, peer_id: str) -> None:
        self._connections.pop(peer_id, None)

    async def send_to(self, peer_id: str, payload: dict) -> bool:
        """Отправить сообщение конкретному пиру. Возвращает True если доставлено."""
        websocket = self._connections.get(peer_id)
        if websocket is None:
            return False
        try:
            await websocket.send_json(payload)
            return True
        except Exception:
            self.disconnect(peer_id)
            return False

    def is_online(self, peer_id: str) -> bool:
        return peer_id in self._connections

    @property
    def online_count(self) -> int:
        return len(self._connections)


ws_manager = ConnectionManager()


# ─── API ROUTES ───────────────────────────────────

@app.get("/api/health")
async def health_check():
    return {
        "status": "operational",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "active_peers": ws_manager.online_count,
    }


@app.post("/api/peers/register")
async def register_peer(request: RegisterRequest):
    session = PeerSession(
        peer_id=request.peer_id,
        nickname=request.nickname,
        connected_at=datetime.now(timezone.utc).isoformat(),
    )
    active_peers[request.peer_id] = session
    return {"status": "registered", "peer": session.model_dump()}


@app.delete("/api/peers/{peer_id}")
async def unregister_peer(peer_id: str):
    removed = active_peers.pop(peer_id, None)
    if removed:
        return {"status": "unregistered", "peer_id": peer_id}
    return JSONResponse(status_code=404, content={"status": "not_found"})


@app.get("/api/peers")
async def list_peers():
    peers = [p.model_dump() for p in active_peers.values()]
    return {"peers": peers, "count": len(peers)}


@app.get("/api/peers/{peer_id}")
async def get_peer(peer_id: str):
    peer = active_peers.get(peer_id)
    if peer:
        return peer.model_dump()
    return JSONResponse(status_code=404, content={"status": "not_found"})


@app.post("/api/call/request")
async def request_call(call: CallRequest):
    """
    Отправить уведомление о входящем звонке через WebSocket.
    PeerJS сам установит медиа-соединение, этот эндпоинт — для нотификаций.
    """
    delivered = await ws_manager.send_to(call.to_peer_id, {
        "type": "incoming_call",
        "from_peer_id": call.from_peer_id,
        "from_nickname": call.nickname,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    return {"delivered": delivered, "target_online": ws_manager.is_online(call.to_peer_id)}


# ─── WEBSOCKET ENDPOINT ───────────────────────────

@app.websocket("/ws/{peer_id}")
async def peer_websocket(websocket: WebSocket, peer_id: str):
    """
    WebSocket для real-time событий:
    - incoming_call — уведомление о входящем звонке
    - call_accepted / call_rejected — ответ на звонок
    - peer_online / peer_offline — статус пиров
    - ping / pong — heartbeat
    """
    await ws_manager.connect(peer_id, websocket)

    # Зарегистрировать пира
    active_peers[peer_id] = PeerSession(
        peer_id=peer_id,
        nickname="ANON",
        connected_at=datetime.now(timezone.utc).isoformat(),
    )

    try:
        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            event_type = message.get("type")

            if event_type == "ping":
                await ws_manager.send_to(peer_id, {
                    "type": "pong",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

            elif event_type == "update_nickname":
                new_name = message.get("nickname", "ANON")
                if peer_id in active_peers:
                    active_peers[peer_id].nickname = new_name

            elif event_type == "call_request":
                target = message.get("to_peer_id")
                if target:
                    await ws_manager.send_to(target, {
                        "type": "incoming_call",
                        "from_peer_id": peer_id,
                        "from_nickname": message.get("nickname", "ANON"),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })

            elif event_type == "call_accepted":
                target = message.get("to_peer_id")
                if target:
                    await ws_manager.send_to(target, {
                        "type": "call_accepted",
                        "from_peer_id": peer_id,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })

            elif event_type == "call_rejected":
                target = message.get("to_peer_id")
                if target:
                    await ws_manager.send_to(target, {
                        "type": "call_rejected",
                        "from_peer_id": peer_id,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })

            elif event_type == "call_ended":
                target = message.get("to_peer_id")
                if target:
                    await ws_manager.send_to(target, {
                        "type": "call_ended",
                        "from_peer_id": peer_id,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })

    except WebSocketDisconnect:
        ws_manager.disconnect(peer_id)
        active_peers.pop(peer_id, None)


# ─── STATIC FILES (FRONTEND) ─────────────────────

if DIST_DIR.exists():
    # Монтируем ассеты ДО catch-all роута
    assets_dir = DIST_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="static-assets")

    # Catch-all: отдаём index.html для всех не-API путей (SPA fallback)
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        # Попытаться отдать конкретный файл если он есть
        file_path = DIST_DIR / full_path
        if file_path.is_file():
            return FileResponse(str(file_path))
        # Иначе — index.html (SPA)
        index = DIST_DIR / "index.html"
        if index.exists():
            return FileResponse(str(index))
        return JSONResponse(
            status_code=404,
            content={"error": "Frontend not built. Run: npm run build"},
        )
else:
    @app.get("/")
    async def frontend_not_built():
        return JSONResponse(
            status_code=404,
            content={
                "error": "Frontend not built",
                "hint": "Run 'npm run build' first to generate dist/",
            },
        )


# ─── ENTRY POINT ──────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    print("""
    ╔══════════════════════════════════════════╗
    ║  PEERLINK // SIGNALING SERVER v1.0       ║
    ║  API:    http://localhost:8000/api/docs  ║
    ║  WS:     ws://localhost:8000/ws/{id}     ║
    ╚══════════════════════════════════════════╝
    """)

    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
