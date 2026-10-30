# PEERLINK // P2P Voice Terminal

Технический брутализм. Монохром. Кислотно-зелёный акцент. P2P звонки через WebRTC.

---

## Быстрый старт (только фронтенд)

PeerJS использует публичный signaling-сервер по умолчанию, поэтому бэкенд не обязателен для базовой работы.

```bash
npm install
npm run dev
# → http://localhost:3000
```

---

## Полный стек (FastAPI + Frontend)

### 1. Установка зависимостей

```bash
# Frontend
npm install

# Backend
pip install -r requirements.txt
```

### 2. Сборка фронтенда

```bash
npm run build
```

### 3. Запуск сервера

```bash
python server.py
# → http://localhost:8000
# → API docs: http://localhost:8000/api/docs
```

---

## Разработка (два терминала)

**Терминал 1 — Backend:**
```bash
pip install -r requirements.txt
uvicorn server:app --reload --port 8000
```

**Терминал 2 — Frontend:**
```bash
npm run dev
# → http://localhost:3000 (с HMR)
```

---

## Как использовать

1. Открой приложение в **двух вкладках** или на двух устройствах
2. Скопируй **Peer ID** (клик по ID)
3. Введи **никнейм** (отображается собеседнику)
4. В одной вкладке вставь Peer ID из другой → **INITIATE CALL**
5. Разрешить доступ к микрофону
6. Для звонков через интернет — STUN-серверы Google уже настроены

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Статус сервера |
| POST | `/api/peers/register` | Регистрация пира |
| DELETE | `/api/peers/{peer_id}` | Удаление пира |
| GET | `/api/peers` | Список активных пиров |
| GET | `/api/peers/{peer_id}` | Инфо о пире |
| POST | `/api/call/request` | Запрос звонка |
| WS | `/ws/{peer_id}` | WebSocket для real-time |

---

## WebSocket Events

**Client → Server:**
```json
{ "type": "ping" }
{ "type": "update_nickname", "nickname": "HACKER" }
{ "type": "call_request", "to_peer_id": "peerlink-abc123", "nickname": "HACKER" }
{ "type": "call_accepted", "to_peer_id": "peerlink-abc123" }
{ "type": "call_rejected", "to_peer_id": "peerlink-abc123" }
{ "type": "call_ended", "to_peer_id": "peerlink-abc123" }
```

**Server → Client:**
```json
{ "type": "pong", "timestamp": "..." }
{ "type": "incoming_call", "from_peer_id": "...", "from_nickname": "..." }
{ "type": "call_accepted", "from_peer_id": "..." }
{ "type": "call_rejected", "from_peer_id": "..." }
{ "type": "call_ended", "from_peer_id": "..." }
```

---

## Свой PeerJS сервер (опционально)

Публичный сервер может быть нестабильным. Запусти свой:

```bash
npm install -g peer
peerjs --port 9000
```

В `src/App.tsx` измени инициализацию Peer:

```typescript
const peerConnection = new Peer(id, {
  host: 'localhost',
  port: 9000,
  config: { iceServers: STUN_SERVERS },
});
```

---

## Структура

```
├── src/
│   ├── App.tsx        # UI + PeerJS + WebSocket
│   ├── index.css      # Technical Brutalism стили
│   └── main.tsx       # Точка входа
├── server.py          # FastAPI backend
├── requirements.txt   # Python зависимости
├── dist/              # Собранный фронтенд
└── index.html         # HTML-шаблон
```

---

## Дизайн-концепция

- **Цвета:** `#0a0a0a` (фон), `#ffffff` (текст), `#ccff00` (акцент)
- **Типографика:** Fira Code, моноширинный
- **Стиль:** Острые углы, тонкие границы, без градиентов и теней
- **Анимации:** Только мигающий курсор и пульсация статуса

---

## Лицензия

MIT
