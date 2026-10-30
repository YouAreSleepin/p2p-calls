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

function generateTimestamp(): string {
  const now = new Date();
  return now.toLocaleTimeString('en-US', { hour12: false });
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

  const peerRef = useRef<Peer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const activeCallRef = useRef<MediaConnection | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [...prev, { timestamp: generateTimestamp(), message, type }]);
  }, []);

  // Clock ticker
  useEffect(() => {
    const tick = () => setClock(generateTimestamp());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  // Call duration timer
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

  // Initialize PeerJS
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
    });

    peerConnection.on('call', (incomingCall) => {
      addLog(`INCOMING CALL FROM: ${incomingCall.peer}`, 'info');
      setCallStatus('ringing');
      setConnectedPeerNickname(incomingCall.metadata?.nickname || incomingCall.peer);

      navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then((audioStream) => {
          localStreamRef.current = audioStream;
          incomingCall.answer(audioStream);
          bindCallEvents(incomingCall);
          setCallStatus('active');
          addLog(`CONNECTED TO: ${incomingCall.metadata?.nickname || incomingCall.peer}`, 'success');
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
      addLog('SIGNALING SERVER DISCONNECTED — ATTEMPTING RECONNECT', 'error');
      peerConnection.reconnect();
    });

    peerRef.current = peerConnection;

    return () => {
      peerConnection.destroy();
    };
  }, []);

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

  async function initiateCall() {
    if (!peerRef.current || !targetPeerId.trim()) return;

    const targetId = targetPeerId.trim();
    addLog(`INITIATING CALL TO: ${targetId}`, 'info');
    setCallStatus('connecting');

    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = audioStream;

      const mediaConnection = peerRef.current.call(targetId, audioStream, {
        metadata: { nickname: nickname || peerId },
      });

      bindCallEvents(mediaConnection);
      setCallStatus('active');
      setConnectedPeerNickname(targetId);
      addLog(`CALL ACTIVE — CONNECTED TO ${targetId}`, 'success');
    } catch (err: any) {
      addLog(`CALL FAILED: ${err.message}`, 'error');
      setCallStatus('idle');
    }
  }

  function endCall() {
    if (activeCallRef.current) {
      activeCallRef.current.close();
      activeCallRef.current = null;
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

  function copyPeerId() {
    if (!peerId) return;
    navigator.clipboard.writeText(peerId).then(() => {
      setCopyVisible(true);
      addLog('PEER ID COPIED TO CLIPBOARD', 'system');
      setTimeout(() => setCopyVisible(false), 2000);
    });
  }

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
          <span className="call-info__peer-id">[{targetPeerId || activeCallRef.current?.peer}]</span>
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
                onChange={(e) => setNickname(e.target.value)}
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
        <span>ENCRYPTED P2P CHANNEL</span>
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
