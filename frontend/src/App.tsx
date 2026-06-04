import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import type { DeckNumber, DeckState, WsPayload } from './types.js';
import type { WaveformState } from './appTypes.js';
import DeckCard from './DeckCard.js';
import HeaderBar from './HeaderBar.js';

const DECK_NUMBERS: DeckNumber[] = [1, 2, 3, 4];

function makeBlankDeck(deck: DeckNumber): DeckState {
  return {
    deck,
    trackLoaded: false,
    fileName: '',
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
  // fileName → object URL for artwork received over WebSocket
  const artworkObjectUrlsRef = useRef<Record<string, string>>({});
  const [artworkUrls, setArtworkUrls] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [selectedDeck, setSelectedDeck] = useState<DeckNumber | null>(null);
  const [nextTrack, setNextTrack] = useState<string | null>(null);
  const [sendWhenStopped, setSendWhenStopped] = useState(false);
  const [settingBusy, setSettingBusy] = useState(false);
  const [headerVisible, setHeaderVisible] = useState(true);

  const lastSeq = useRef(-1);
  const unmounting = useRef(false);
  const retryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const prevLoadedRef = useRef<Record<DeckNumber, boolean>>({ 1: false, 2: false, 3: false, 4: false });
  const prevFileNameRef = useRef<Record<DeckNumber, string>>({ 1: '', 2: '', 3: '', 4: '' });

  // Revoke all object URLs on unmount
  useEffect(() => {
    return () => {
      for (const url of Object.values(artworkObjectUrlsRef.current)) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

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
        const nextDecks = msg.decks as DecksState;
        setDecks(nextDecks);
        setSelectedDeck(msg.selectedDeck ?? null);
        setNextTrack(msg.nextTrack ?? null);
        const prev = prevLoadedRef.current;
        const prevFile = prevFileNameRef.current;
        for (const d of DECK_NUMBERS) {
          const unloaded = prev[d] && !nextDecks[d].trackLoaded;
          const fileChanged = prevFile[d] !== '' && nextDecks[d].fileName !== '' && nextDecks[d].fileName !== prevFile[d];
          if (unloaded || fileChanged) {
            const newFileName = nextDecks[d].fileName;
            setWaveforms((w) => {
              if (w[d].fileName === newFileName && newFileName !== '') return w;
              return { ...w, [d]: makeBlankWaveform() };
            });
          }
          prev[d] = nextDecks[d].trackLoaded;
          prevFile[d] = nextDecks[d].fileName;
        }
      } else if (msg.type === 'waveform_status') {
        const { deck, stage, progress, fileName } = msg;
        setWaveforms((prev) => {
          const changed = prev[deck].fileName !== fileName;
          return {
            ...prev,
            [deck]: {
              peaks: changed ? null : prev[deck].peaks,
              peaksPerSec: prev[deck].peaksPerSec,
              stage,
              progress,
              fileName,
            },
          };
        });
      } else if (msg.type === 'waveform_data') {
        const { deck, peaks, peaksPerSec, fileName } = msg;
        setWaveforms((prev) => ({
          ...prev,
          [deck]: { peaks, peaksPerSec, stage: 'ready', progress: 100, fileName },
        }));
      } else if (msg.type === 'artwork_data') {
        const { fileName, data, mime } = msg;
        if (!data || !mime) return;
        // Revoke previous object URL for this fileName if any
        const prev = artworkObjectUrlsRef.current[fileName];
        if (prev) URL.revokeObjectURL(prev);
        const blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mime });
        const url = URL.createObjectURL(blob);
        artworkObjectUrlsRef.current[fileName] = url;
        setArtworkUrls((m) => ({ ...m, [fileName]: url }));
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
    <div className="appShell">
      {headerVisible && (
        <HeaderBar
          connected={connected}
          selectedDeck={selectedDeck}
          selectedDeckState={selectedDeck ? decks[selectedDeck] : null}
          nextTrack={nextTrack}
          sendWhenStopped={sendWhenStopped}
          settingBusy={settingBusy}
          onToggleSendWhenStopped={toggleSendWhenStopped}
        />
      )}
      <div className="grid">
        {DECK_NUMBERS.map((d) => (
          <DeckCard
            key={d}
            state={decks[d]}
            waveform={waveforms[d]}
            selected={selectedDeck === d}
            artworkUrl={artworkUrls[decks[d].fileName] ?? null}
          />
        ))}
      </div>
      <button
        className="headerToggle"
        onClick={() => setHeaderVisible((v) => !v)}
        title={headerVisible ? 'Hide header' : 'Show header'}
      >
        {headerVisible ? '▲' : '▼'}
      </button>
    </div>
  );
}
