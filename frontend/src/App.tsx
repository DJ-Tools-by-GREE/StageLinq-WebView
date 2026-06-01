import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DeckNumber, DeckState, WaveformDataPayload, WaveformStatusPayload, WaveformStage, WsPayload } from './types';
import DeckCard from './DeckCard';

const DECKS: DeckNumber[] = [1, 2, 3, 4];

const blankDeck = (deck: DeckNumber): DeckState => ({
  deck,
  trackLoaded: false,
  title: '—',
  artist: '—',
  elapsedSec: 0,
  totalSec: 0,
  currentBpm: 0,
  trackBpm: 0,
  speedState: 0,
  keyIndex: null,
  keyCamelot: '--',
  fader: 0,
  play: false,
  updatedAt: Date.now(),
});

export interface WaveformState {
  peaks: number[] | null;
  peaksPerSec: number;
  stage: WaveformStage | null;
  progress: number;
  fileName: string;
}

const blankWaveform = (): WaveformState => ({
  peaks: null,
  peaksPerSec: 200,
  stage: null,
  progress: 0,
  fileName: '',
});

export default function App() {
  const [decks, setDecks] = useState<Record<DeckNumber, DeckState>>({
    1: blankDeck(1),
    2: blankDeck(2),
    3: blankDeck(3),
    4: blankDeck(4),
  });
  const [waveforms, setWaveforms] = useState<Record<DeckNumber, WaveformState>>({
    1: blankWaveform(),
    2: blankWaveform(),
    3: blankWaveform(),
    4: blankWaveform(),
  });
  const [connected, setConnected] = useState(false);
  const [sendWhenStopped, setSendWhenStopped] = useState(false);
  const [settingBusy, setSettingBusy] = useState(false);
  const lastSeq = useRef(0);

  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws`;
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByUs = false;
    let retryT: number | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closedByUs) retryT = window.setTimeout(connect, 800);
      };

      ws.onerror = () => {
        // onclose will follow
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsPayload;
          if (msg.type === 'snapshot') {
            if (msg.seq <= lastSeq.current) return;
            lastSeq.current = msg.seq;
            setDecks(msg.decks);
          } else if (msg.type === 'waveform_status') {
            const s = msg as WaveformStatusPayload;
            setWaveforms((prev) => ({
              ...prev,
              [s.deck]: {
                ...prev[s.deck],
                stage: s.stage,
                progress: s.progress,
                fileName: s.fileName,
              },
            }));
          } else if (msg.type === 'waveform_data') {
            const d = msg as WaveformDataPayload;
            setWaveforms((prev) => ({
              ...prev,
              [d.deck]: {
                peaks: d.peaks,
                peaksPerSec: d.peaksPerSec,
                stage: 'ready',
                progress: 100,
                fileName: d.fileName,
              },
            }));
          }
        } catch {
          // ignore
        }
      };
    };

    connect();

    return () => {
      closedByUs = true;
      if (retryT) window.clearTimeout(retryT);
      try { ws?.close(); } catch { }
    };
  }, [wsUrl]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/timecode/send-when-stopped')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setSendWhenStopped(data?.enabled === true);
      })
      .catch(() => {
        // ignore
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSendWhenStopped = async () => {
    if (settingBusy) return;
    setSettingBusy(true);
    const next = !sendWhenStopped;
    try {
      const res = await fetch('/api/timecode/send-when-stopped', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json();
      setSendWhenStopped(data?.enabled === true);
    } catch {
      // ignore
    } finally {
      setSettingBusy(false);
    }
  };

  return (
    <>
      <div className="grid">
        {DECKS.map((d) => (
          <DeckCard
            key={d}
            deck={d}
            state={decks[d]}
            waveform={waveforms[d]}
            connected={connected}
          />
        ))}
      </div>

      <div className="overlayToggle">
        <button
          className={`toggleBtn ${sendWhenStopped ? 'on' : 'off'}`}
          onClick={toggleSendWhenStopped}
          disabled={settingBusy}
        >
          {sendWhenStopped ? 'TC while stopped: ON' : 'TC while stopped: OFF'}
        </button>
      </div>
    </>
  );
}
