import { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { MediaConnection } from 'peerjs';

type CallStatus = 'idle' | 'connecting' | 'ringing' | 'active' | 'ended';
type LogEntry = {
  timestamp: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'system';
};

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

// Бэкенд URL (можно менять на свой домен)
const API_BASE = window.location.origin;
const WS_BASE = API_BASE.replace(/^http/, 'ws');

function generateTimestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function generatePeerId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return `peerlink-${result}`;
}

export default function App() {
  const [peerId, setPeerId] = useState<string>('');
  const [nickname, setNickname] = useState<string>('');
  const [targetPeerId, setTargetPeerId] = useState<string>('');
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [clock, setClock] = useState<string>('');
  const [callDuration, setCallDuration] = useState<number>(0);
  const [connectedPeerNickname, setConnectedPeerNickname] = useState<string>('');
  const [copyVisible, setCopyVisible] = useState(false);
  const [backendOnline, setBackendOnline] = useState<boolean>(false);

  const peerRef = useRef<Peer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const activeCallRef = useRef<MediaConnection | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const nicknameRef = useRef<string>('');

  // Синхронизация nickname ref для WebSocket
  useEffect(() => {
    nicknameRef.current = nickname;
  }, [nickname]);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [...prev, { timestamp: generateTimestamp(), message, type }]);
  }, []);

  // ─── CLOCK ───
  useEffect(() => {
    const tick = () => setClock(generateTimestamp());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  // ─── AUTO-SCROLL LOGS ───
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  // ─── CALL DURATION ───
  useEffect(() => {
    if (callStatus === 'active') {
      setCallDuration(0);
      durationIntervalRef.current = setInterval(() => {
        setCallDuration(prev => prev + 1);
      }, 1000);
    } else {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
    }
    return () => {
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
    };
  }, [callStatus]);

  // ─── CHECK BACKEND ───
  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then(res => res.json())
      .then(() => {
        setBackendOnline(true);
        addLog('BACKEND SIGNALING SERVER: ONLINE', 'success');
      })
      .catch(() => {
        setBackendOnline(false);
        addLog('BACKEND UNREACHABLE — RUNNING IN STANDALONE MODE', 'info');
        addLog('P2P CALLS WILL WORK VIA PEERJS PUBLIC BROKER', 'system');
      });
  }, []);

  // ─── WEBSOCKET CONNECTION ───
  const connectWebSocket = useCallback((id: string) => {
    try {
      const ws = new WebSocket(`${WS_BASE}/ws/${id}`);

      ws.onopen = () => {
        addLog('WEBSOCKET CHANNEL ESTABLISHED', 'success');
        // Отправить никнейм если уже задан
        if (nicknameRef.current) {
          ws.send(JSON.stringify({
            type: 'update_nickname',
            nickname: nicknameRef.current,
          }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          switch (message.type) {
            case 'incoming_call':
              addLog(`INCOMING CALL FROM: ${message.from_nickname || message.from_peer_id}`, 'info');
              setConnectedPeerNickname(message.from_nickname || message.from_peer_id);
              break;

            case 'call_accepted':
              addLog(`CALL ACCEPTED BY: ${message.from_peer_id}`, 'success');
              break;

            case 'call_rejected':
              addLog(`CALL REJECTED BY: ${message.from_peer_id}`, 'error');
              setCallStatus('idle');
              break;

            case 'call_ended':
              addLog(`CALL ENDED BY: ${message.from_peer_id}`, 'info');
              endCall();
              break;

            case 'pong':
              // heartbeat response
              break;
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        addLog('WEBSOCKET DISCONNECTED', 'error');
        // Reconnect after delay
        setTimeout(() => {
          if (peerRef.current) {
            connectWebSocket(id);
          }
        }, 3000);
      };

      ws.onerror = () => {
        // Silent — onclose will handle reconnect
      };

      websocketRef.current = ws;
    } catch {
      addLog('WEBSOCKET INIT FAILED — RUNNING WITHOUT REALTIME NOTIFICATIONS', 'info');
    }
  }, [addLog]);

  // ─── REGISTER PEER ON BACKEND ───
  const registerOnBackend = useCallback(async (id: string, name: string) => {
    try {
      await fetch(`${API_BASE}/api/peers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peer_id: id, nickname: name || 'ANON' }),
      });
      addLog('REGISTERED ON SIGNALING SERVER', 'success');
    } catch {
      // Silent — backend might not be available
    }
  }, [addLog]);

  // ─── INITIALIZE PEERJS ───
  useEffect(() => {
    const id = generatePeerId();
    addLog('INITIALIZING PEER CONNECTION...', 'system');
    addLog('REQUESTING ICE CANDIDATES FROM STUN SERVERS', 'system');

    const peerConnection = new Peer(id, {
      config: { iceServers: STUN_SERVERS },
      debug: 0,
    });

    peerConnection.on('open', () => {
      setPeerId(id);
      addLog(`PEER ID ASSIGNED: ${id}`, 'success');
      addLog('STANDBY — AWAITING INCOMING OR OUTGOING CONNECTION', 'system');

      // Connect WebSocket & register
      connectWebSocket(id);
      registerOnBackend(id, nicknameRef.current);
    });

    peerConnection.on('call', (incomingCall) => {
      const callerName = incomingCall.metadata?.nickname || incomingCall.peer;
      addLog(`INCOMING CALL FROM: ${callerName}`, 'info');
      setCallStatus('ringing');
      setConnectedPeerNickname(callerName);
      setTargetPeerId(incomingCall.peer);

      navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then((audioStream) => {
          localStreamRef.current = audioStream;
          incomingCall.answer(audioStream);
          bindCallEvents(incomingCall);
          setCallStatus('active');
          addLog(`CONNECTED TO: ${callerName}`, 'success');

          // Notify via WebSocket
          sendWsMessage({
            type: 'call_accepted',
            to_peer_id: incomingCall.peer,
          });
        })
        .catch((err) => {
          addLog(`MICROPHONE ACCESS DENIED: ${err.message}`, 'error');
          incomingCall.close();
          setCallStatus('idle');
        });
    });

    peerConnection.on('error', (err) => {
      addLog(`PEER ERROR: ${err.type} — ${err.message}`, 'error');
      if (err.type === 'peer-unavailable') {
        addLog('TARGET PEER NOT FOUND OR OFFLINE', 'error');
        setCallStatus('idle');
      }
    });

    peerConnection.on('disconnected', () => {
      addLog('SIGNALING SERVER DISCONNECTED — RECONNECTING', 'error');
      peerConnection.reconnect();
    });

    peerRef.current = peerConnection;

    return () => {
      peerConnection.destroy();
      websocketRef.current?.close();
    };
  }, []);

  // ─── WEBSOCKET HELPER ───
  function sendWsMessage(payload: Record<string, unknown>) {
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      websocketRef.current.send(JSON.stringify(payload));
    }
  }

  // ─── BIND CALL EVENTS ───
  function bindCallEvents(mediaConnection: MediaConnection) {
    activeCallRef.current = mediaConnection;

    mediaConnection.on('stream', (remoteStream) => {
      const audioElement = document.getElementById('remote-audio') as HTMLAudioElement;
      if (audioElement) {
        audioElement.srcObject = remoteStream;
        audioElement.play().catch(() => {});
      }
    });

    mediaConnection.on('close', () => {
      addLog('REMOTE PEER DISCONNECTED', 'info');
      endCall();
    });

    mediaConnection.on('error', (err) => {
      addLog(`CALL ERROR: ${err.message}`, 'error');
      endCall();
    });
  }

  // ─── INITIATE CALL ───
  async function initiateCall() {
    if (!peerRef.current || !targetPeerId.trim()) return;

    const resolvedTarget = targetPeerId.trim();
    addLog(`INITIATING CALL TO: ${resolvedTarget}`, 'info');
    setCallStatus('connecting');

    // Notify via WebSocket (if backend is online)
    sendWsMessage({
      type: 'call_request',
      to_peer_id: resolvedTarget,
      nickname: nickname || peerId,
    });

    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = audioStream;

      const mediaConnection = peerRef.current.call(resolvedTarget, audioStream, {
        metadata: { nickname: nickname || peerId },
      });

      bindCallEvents(mediaConnection);
      setCallStatus('active');
      setConnectedPeerNickname(resolvedTarget);
      addLog(`CALL ACTIVE — CONNECTED TO ${resolvedTarget}`, 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      addLog(`CALL FAILED: ${message}`, 'error');
      setCallStatus('idle');
    }
  }

  // ─── END CALL ───
  function endCall() {
    if (activeCallRef.current) {
      const remotePeer = activeCallRef.current.peer;
      activeCallRef.current.close();
      activeCallRef.current = null;

      sendWsMessage({
        type: 'call_ended',
        to_peer_id: remotePeer,
      });
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    const audioElement = document.getElementById('remote-audio') as HTMLAudioElement;
    if (audioElement) {
      audioElement.srcObject = null;
    }

    setCallStatus('idle');
    setIsMuted(false);
    setCallDuration(0);
    setConnectedPeerNickname('');
    addLog('CALL TERMINATED', 'system');
  }

  // ─── TOGGLE MUTE ───
  function toggleMute() {
    if (!localStreamRef.current) return;

    const audioTracks = localStreamRef.current.getAudioTracks();
    const newMutedState = !isMuted;

    audioTracks.forEach(track => {
      track.enabled = !newMutedState;
    });

    setIsMuted(newMutedState);
    addLog(newMutedState ? 'MICROPHONE MUTED' : 'MICROPHONE UNMUTED', 'info');
  }

  // ─── COPY PEER ID ───
  function copyPeerId() {
    if (!peerId) return;
    navigator.clipboard.writeText(peerId).then(() => {
      setCopyVisible(true);
      addLog('PEER ID COPIED TO CLIPBOARD', 'system');
      setTimeout(() => setCopyVisible(false), 2000);
    });
  }

  // ─── UPDATE NICKNAME ON BACKEND ───
  function handleNicknameChange(value: string) {
    setNickname(value);
    sendWsMessage({ type: 'update_nickname', nickname: value });
  }

  // ─── FORMAT DURATION ───
  function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }

  return (
    <main className="terminal-frame">
      {/* Header */}
      <header className="terminal-header">
        <span className="terminal-header__title">
          <span>PEERLINK</span> // P2P VOICE TERMINAL v1.0
        </span>
        <time className="terminal-header__clock">{clock}</time>
      </header>

      {/* Status Bar */}
      <nav className="status-bar">
        <div className="status-indicator">
          <span className={`status-indicator__dot ${peerId ? 'status-indicator__dot--connected' : ''}`} />
          <span className="status-indicator__label">SIGNAL</span>
          <span className="status-indicator__value">{peerId ? 'ONLINE' : 'BOOTING'}</span>
        </div>

        <div className="status-indicator">
          <span className={`status-indicator__dot ${backendOnline ? 'status-indicator__dot--connected' : ''}`} />
          <span className="status-indicator__label">BACKEND</span>
          <span className="status-indicator__value">{backendOnline ? 'LINKED' : 'STANDALONE'}</span>
        </div>

        <div className="status-indicator">
          <span className="status-indicator__label">NICK</span>
          <span className="status-indicator__value">{nickname || 'UNNAMED'}</span>
        </div>

        <div className={`on-air ${callStatus === 'active' ? 'on-air--active' : ''}`}>
          <span className="on-air__dot" />
          <span className="on-air__text">ON AIR</span>
        </div>
      </nav>

      {/* Call Info */}
      <section className={`call-info ${callStatus === 'active' ? 'call-info--active' : ''}`}>
        <div className="call-info__peer">
          <span className="call-info__peer-name">{connectedPeerNickname}</span>
          <span className="call-info__peer-id">[{targetPeerId}]</span>
        </div>
        <time className="call-info__duration">{formatDuration(callDuration)}</time>
      </section>

      {/* Body */}
      <article className="terminal-body">
        {/* Identity Panel */}
        <section className="panel">
          <h2 className="panel__label">IDENTITY</h2>
          <div className="identity-panel">
            <div className="identity-field">
              <label className="identity-field__label">YOUR PEER ID</label>
              <span
                className="identity-field__value"
                onClick={copyPeerId}
                title="Click to copy"
              >
                {peerId || 'GENERATING...'}
              </span>
            </div>
            <div className="identity-field">
              <label className="identity-field__label">NICKNAME</label>
              <input
                className="identity-field__value identity-field__value--editable"
                type="text"
                value={nickname}
                onChange={(e) => handleNicknameChange(e.target.value)}
                placeholder="ENTER CALLSIGN..."
                maxLength={24}
              />
            </div>
          </div>
        </section>

        {/* Call Panel */}
        <section className="panel">
          <h2 className="panel__label">ESTABLISH CONNECTION</h2>
          <div className="call-panel">
            <div className="call-input-row">
              <input
                className="call-input"
                type="text"
                value={targetPeerId}
                onChange={(e) => setTargetPeerId(e.target.value)}
                placeholder="ENTER TARGET PEER ID..."
                disabled={callStatus === 'active'}
              />
            </div>
            <div className="call-actions">
              {callStatus !== 'active' ? (
                <button
                  className={`btn btn--call ${!targetPeerId.trim() ? 'btn--disabled' : ''}`}
                  onClick={initiateCall}
                  disabled={!targetPeerId.trim() || callStatus === 'connecting'}
                >
                  ▶ INITIATE CALL
                </button>
              ) : (
                <>
                  <button className="btn btn--hangup" onClick={endCall}>
                    ■ TERMINATE
                  </button>
                  <button
                    className={`btn btn--mute ${isMuted ? 'btn--mute--active' : ''}`}
                    onClick={toggleMute}
                  >
                    {isMuted ? '◉ MIC MUTED' : '◎ MIC LIVE'}
                  </button>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Event Log */}
        <section className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', borderBottom: 'none' }}>
          <h2 className="panel__label">EVENT LOG</h2>
          <div className="event-log" ref={logContainerRef}>
            {logs.map((entry, index) => (
              <div className="event-log__entry" key={index}>
                <span className="event-log__timestamp">[{entry.timestamp}]</span>
                <span className={`event-log__message event-log__message--${entry.type}`}>
                  {entry.message}
                </span>
              </div>
            ))}
            <div className="event-log__entry">
              <span className="event-log__timestamp cursor-blink">[{generateTimestamp()}]</span>
            </div>
          </div>
        </section>
      </article>

      {/* Footer */}
      <footer className="terminal-footer">
        <span>PEERJS // WEBRTC // STUN RELAY</span>
        <span>{backendOnline ? 'SIGNALING: ACTIVE' : 'MODE: STANDALONE'}</span>
      </footer>

      {/* Hidden audio element */}
      <audio id="remote-audio" className="remote-audio" autoPlay playsInline />

      {/* Copy feedback */}
      <aside className={`copy-feedback ${copyVisible ? 'copy-feedback--visible' : ''}`}>
        ID COPIED ✓
      </aside>
    </main>
  );
}
