"""
PEERLINK // FastAPI Signaling Server
Serves the frontend and provides session management for peer discovery.
PeerJS handles the actual WebRTC signaling via its own broker.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
import uuid
import json

app = FastAPI(title="PEERLINK Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class PeerSession(BaseModel):
    peer_id: str
    nickname: str
    connected_at: str
    status: str = "online"


# In-memory peer registry (use Redis/DB in production)
active_peers: dict[str, PeerSession] = {}


@app.get("/")
async def serve_frontend():
    return FileResponse("dist/index.html")


@app.get("/health")
async def health_check():
    return {
        "status": "operational",
        "timestamp": datetime.utcnow().isoformat(),
        "active_peers": len(active_peers),
    }


@app.post("/peer/register")
async def register_peer(peer_id: str, nickname: str = "ANON"):
    """Register a new peer session."""
    session = PeerSession(
        peer_id=peer_id,
        nickname=nickname,
        connected_at=datetime.utcnow().isoformat(),
    )
    active_peers[peer_id] = session
    return {"status": "registered", "peer_id": peer_id}


@app.delete("/peer/{peer_id}")
async def unregister_peer(peer_id: str):
    """Remove a peer from the registry."""
    if peer_id in active_peers:
        del active_peers[peer_id]
        return {"status": "unregistered", "peer_id": peer_id}
    return {"status": "not_found"}


@app.get("/peers")
async def list_peers():
    """List all active peers (for directory/discovery features)."""
    return {
        "peers": list(active_peers.values()),
        "count": len(active_peers),
    }


@app.get("/peer/{peer_id}")
async def get_peer(peer_id: str):
    """Get info about a specific peer."""
    peer = active_peers.get(peer_id)
    if peer:
        return peer
    return {"status": "not_found"}


class WebSocketConnectionManager:
    """Manages WebSocket connections for real-time peer notifications."""

    def __init__(self):
        self.connections: dict[str, WebSocket] = {}

    async def connect(self, peer_id: str, websocket: WebSocket):
        await websocket.accept()
        self.connections[peer_id] = websocket

    def disconnect(self, peer_id: str):
        self.connections.pop(peer_id, None)

    async def notify_peer(self, peer_id: str, message: dict):
        ws = self.connections.get(peer_id)
        if ws:
            await ws.send_json(message)

    async def broadcast(self, message: dict, exclude: str | None = None):
        for pid, ws in self.connections.items():
            if pid != exclude:
                try:
                    await ws.send_json(message)
                except Exception:
                    self.disconnect(pid)


ws_manager = WebSocketConnectionManager()


@app.websocket("/ws/{peer_id}")
async def peer_websocket(websocket: WebSocket, peer_id: str):
    """
    WebSocket endpoint for real-time peer events.
    Used for incoming call notifications, peer status updates, etc.
    """
    await ws_manager.connect(peer_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)

            event_type = message.get("type")

            if event_type == "call_request":
                target_id = message.get("target_peer_id")
                await ws_manager.notify_peer(target_id, {
                    "type": "incoming_call",
                    "from_peer_id": peer_id,
                    "from_nickname": message.get("nickname", "ANON"),
                    "timestamp": datetime.utcnow().isoformat(),
                })

            elif event_type == "call_accepted":
                target_id = message.get("target_peer_id")
                await ws_manager.notify_peer(target_id, {
                    "type": "call_accepted",
                    "from_peer_id": peer_id,
                    "timestamp": datetime.utcnow().isoformat(),
                })

            elif event_type == "call_rejected":
                target_id = message.get("target_peer_id")
                await ws_manager.notify_peer(target_id, {
                    "type": "call_rejected",
                    "from_peer_id": peer_id,
                    "timestamp": datetime.utcnow().isoformat(),
                })

            elif event_type == "ping":
                await ws_manager.notify_peer(peer_id, {
                    "type": "pong",
                    "timestamp": datetime.utcnow().isoformat(),
                })

    except WebSocketDisconnect:
        ws_manager.disconnect(peer_id)
        if peer_id in active_peers:
            del active_peers[peer_id]
        await ws_manager.broadcast({
            "type": "peer_offline",
            "peer_id": peer_id,
        })


# Serve static frontend files
app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
