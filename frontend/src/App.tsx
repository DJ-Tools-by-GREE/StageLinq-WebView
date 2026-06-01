import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import type { DeckNumber, DeckState, WsPayload } from './types.js';
import type { WaveformState } from './appTypes.js';
import DeckCard from './DeckCard.js';

const DECK_NUMBERS: DeckNumber[] = [1, 2, 3, 4];

function makeBlankDeck(deck: DeckNumber): DeckState {
  return {
    deck,
    trackLoaded: false,
    title: '',
    artist: '',
    elapsedSec: 0,
    totalSec: 0,
    currentBpm: 0,
    trackBpm: 0,
    speedState: 0,
    keyIndex: null,
    keyCamelot: '',
    fader: 0,
    play: false,
    updatedAt: 0,
  };
}

function makeBlankWaveform(): WaveformState {
  return { peaks: null, peaksPerSec: 200, stage: null, progress: 0, fileName: '' };
}

type DecksState = Record<DeckNumber, DeckState>;
type WaveformsState = Record<DeckNumber, WaveformState>;

export default function App() {
  const [decks, setDecks] = useState<DecksState>({
    1: makeBlankDeck(1),
    2: makeBlankDeck(2),
    3: makeBlankDeck(3),
    4: makeBlankDeck(4),
  });
  const [waveforms, setWaveforms] = useState<WaveformsState>({
    1: makeBlankWaveform(),
    2: makeBlankWaveform(),
    3: makeBlankWaveform(),
    4: makeBlankWaveform(),
  });
  const [connected, setConnected] = useState(false);
  const [sendWhenStopped, setSendWhenStopped] = useState(false);
  const [settingBusy, setSettingBusy] = useState(false);

  const lastSeq = useRef(-1);
  const unmounting = useRef(false);
  const retryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws`;
  }, []);

  const connect = useCallback(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (ev) => {
      let msg: WsPayload;
      try { msg = JSON.parse(ev.data as string); } catch { return; }

      if (msg.type === 'snapshot') {
        if (msg.seq <= lastSeq.current) return;
        lastSeq.current = msg.seq;
        setDecks(msg.decks as DecksState);
      } else if (msg.type === 'waveform_status') {
        const { deck, stage, progress, fileName } = msg;
        setWaveforms((prev) => ({
          ...prev,
          [deck]: { ...prev[deck], stage, progress, fileName },
        }));
      } else if (msg.type === 'waveform_data') {
        const { deck, peaks, peaksPerSec, fileName } = msg;
        setWaveforms((prev) => ({
          ...prev,
          [deck]: { peaks, peaksPerSec, stage: 'ready', progress: 100, fileName },
        }));
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (!unmounting.current) {
        retryTimeout.current = setTimeout(connect, 800);
      }
    };

    ws.onerror = () => ws.close();
  }, [wsUrl]);

  useEffect(() => {
    unmounting.current = false;
    connect();
    return () => {
      unmounting.current = true;
      if (retryTimeout.current) clearTimeout(retryTimeout.current);
      wsRef.current?.close();
    };
  }, [connect]);

  useEffect(() => {
    const ac = new AbortController();
    fetch('/api/timecode/send-when-stopped', { signal: ac.signal })
      .then((r) => r.json())
      .then((data: { enabled: boolean }) => { setSendWhenStopped(data.enabled === true); })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  const toggleSendWhenStopped = useCallback(async () => {
    if (settingBusy) return;
    setSettingBusy(true);
    try {
      const res = await fetch('/api/timecode/send-when-stopped', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !sendWhenStopped }),
      });
      const data: { enabled: boolean } = await res.json();
      setSendWhenStopped(data.enabled === true);
    } catch {
    } finally {
      setSettingBusy(false);
    }
  }, [settingBusy, sendWhenStopped]);

  return (
    <>
      <div className="grid">
        {DECK_NUMBERS.map((d) => (
          <DeckCard
            key={d}
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
