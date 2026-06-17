import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import type { DeckNumber, DeckState, StageLinqStatus, WsPayload } from './types.js';
import type { WaveformState } from './appTypes.js';
import DeckCard from './DeckCard.js';
import HeaderBar from './HeaderBar.js';
import SettingsModal from './SettingsModal.js';
import {
  FIXED_USERS,
  type UserName,
  type UsersMap,
  type UserSettings,
  effectiveZoom,
  fetchAllUsers,
  putUserSettings,
  loadActiveUser,
  saveActiveUser,
  clampZoom,
} from './userSettings.js';
import {
  fetchGlobalSettings,
  putFreewheelSettings,
  type FreewheelSettings,
  type GlobalSettingsMeta,
  FREEWHEEL_DURATION_FALLBACK,
} from './globalSettings.js';

const DECK_NUMBERS: DeckNumber[] = [1, 2, 3, 4];

const SETTINGS_PUT_DEBOUNCE_MS = 250;

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
    hotCues: [],
    loopActive: false,
    loopInSec: null,
    loopOutSec: null,
    savedLoops: [],
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
  const artworkObjectUrlsRef = useRef<Record<string, string>>({});
  const [artworkUrls, setArtworkUrls] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [stagelinqStatus, setStagelinqStatus] = useState<StageLinqStatus>('no-device');
  const [selectedDeck, setSelectedDeck] = useState<DeckNumber | null>(null);
  const [nextTrack, setNextTrack] = useState<string | null>(null);
  const [sendWhenStopped, setSendWhenStopped] = useState(false);
  const [settingBusy, setSettingBusy] = useState(false);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Users + active user. Users map starts as empty per name and is
  // hydrated from /api/users on mount. The active-user pick is per-browser.
  const [users, setUsers] = useState<UsersMap>(() => {
    const blank = {} as UsersMap;
    for (const n of FIXED_USERS) blank[n] = {};
    return blank;
  });
  const [activeUser, setActiveUserState] = useState<UserName>(() => loadActiveUser());

  // Global (backend-owned) settings. Hydrated once on mount; PUTs go straight to
  // the backend, which persists to config.json and live-pushes into the Art-Net worker.
  const [freewheel, setFreewheel] = useState<FreewheelSettings | null>(null);
  const [freewheelMeta, setFreewheelMeta] = useState<GlobalSettingsMeta>({
    freewheel_max_duration_sec: FREEWHEEL_DURATION_FALLBACK,
  });

  const detailZoomSec = effectiveZoom(users[activeUser]);

  const setActiveUser = useCallback((name: UserName) => {
    saveActiveUser(name);
    setActiveUserState(name);
  }, []);

  // Hydrate users on mount.
  useEffect(() => {
    const ac = new AbortController();
    fetchAllUsers(ac.signal)
      .then((map) => setUsers(map))
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // Hydrate global settings on mount.
  useEffect(() => {
    const ac = new AbortController();
    fetchGlobalSettings(ac.signal)
      .then((res) => {
        setFreewheel(res.freewheel);
        if (res.meta) setFreewheelMeta(res.meta);
      })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  const updateFreewheel = useCallback(async (patch: Partial<FreewheelSettings>) => {
    // Optimistic — flip the toggle/slider immediately so the UI is responsive even
    // if the network round-trip stalls; reconcile from the server's clamp on success.
    setFreewheel((prev) => (prev ? { ...prev, ...patch } : prev));
    try {
      const next = await putFreewheelSettings(patch);
      setFreewheel(next);
    } catch {
      // Best-effort refetch on failure to recover the on-disk truth.
      fetchGlobalSettings()
        .then((res) => setFreewheel(res.freewheel))
        .catch(() => {});
    }
  }, []);

  // Per-user debounced PUT. One timer per user so quickly editing user A then
  // user B does not drop A's pending write.
  const putTimersRef = useRef<Partial<Record<UserName, ReturnType<typeof setTimeout>>>>({});

  const updateUserSettings = useCallback((name: UserName, patch: Partial<UserSettings>) => {
    setUsers((prev) => {
      const merged: UserSettings = { ...prev[name], ...patch };
      const next: UsersMap = { ...prev, [name]: merged };
      const existing = putTimersRef.current[name];
      if (existing) clearTimeout(existing);
      putTimersRef.current[name] = setTimeout(() => {
        delete putTimersRef.current[name];
        putUserSettings(name, merged).catch(() => {});
      }, SETTINGS_PUT_DEBOUNCE_MS);
      return next;
    });
  }, []);

  useEffect(() => () => {
    for (const t of Object.values(putTimersRef.current)) {
      if (t) clearTimeout(t);
    }
  }, []);

  const lastSeq = useRef(-1);
  const unmounting = useRef(false);
  const retryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMsgAt = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const prevLoadedRef = useRef<Record<DeckNumber, boolean>>({ 1: false, 2: false, 3: false, 4: false });
  const prevFileNameRef = useRef<Record<DeckNumber, string>>({ 1: '', 2: '', 3: '', 4: '' });
  const elapsedRefs = useRef<Record<DeckNumber, { current: number }>>({
    1: { current: 0 },
    2: { current: 0 },
    3: { current: 0 },
    4: { current: 0 },
  });

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

    ws.onopen = () => {
      lastMsgAt.current = Date.now();
      setConnected(true);
      heartbeatTimer.current = setInterval(() => {
        if (Date.now() - lastMsgAt.current > 3000) {
          ws.close();
        }
      }, 1000);
    };

    ws.onmessage = (ev) => {
      let msg: WsPayload;
      try { msg = JSON.parse(ev.data as string); } catch { return; }

      if (msg.type === 'snapshot') {
        lastMsgAt.current = Date.now();
        if (msg.seq <= lastSeq.current) return;
        lastSeq.current = msg.seq;
        const nextDecks = msg.decks as DecksState;
        for (const d of DECK_NUMBERS) {
          elapsedRefs.current[d].current = nextDecks[d].elapsedSec;
        }
        setDecks(nextDecks);
        setSelectedDeck(msg.selectedDeck ?? null);
        setNextTrack(msg.nextTrack ?? null);
        setStagelinqStatus(msg.stagelinqStatus);
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
      if (heartbeatTimer.current) { clearInterval(heartbeatTimer.current); heartbeatTimer.current = null; }
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
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
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
          stagelinqStatus={stagelinqStatus}
          selectedDeck={selectedDeck}
          selectedDeckState={selectedDeck ? decks[selectedDeck] : null}
          nextTrack={nextTrack}
          sendWhenStopped={sendWhenStopped}
          settingBusy={settingBusy}
          onToggleSendWhenStopped={toggleSendWhenStopped}
          onOpenSettings={() => setSettingsOpen(true)}
          users={FIXED_USERS}
          activeUser={activeUser}
          onChangeUser={setActiveUser}
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
            elapsedSecRef={elapsedRefs.current[d]}
            detailZoomSec={detailZoomSec}
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
      {settingsOpen && (
        <SettingsModal
          activeUser={activeUser}
          detailZoomSec={detailZoomSec}
          onChangeDetailZoomSec={(v) =>
            updateUserSettings(activeUser, { detailZoomSec: clampZoom(v) })
          }
          freewheel={freewheel}
          freewheelDurationLimits={freewheelMeta.freewheel_max_duration_sec}
          onChangeFreewheel={updateFreewheel}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
