import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import type { DeckNumber, DeckState, StageLinqStatus, TrackNote, WsPayload } from './types.js';
import type { WaveformState } from './appTypes.js';
import DeckCard from './DeckCard.js';
import HeaderBar from './HeaderBar.js';
import SettingsModal from './SettingsModal.js';
import TrackNotePopup from './TrackNotePopup.js';
import {
  FIXED_USERS,
  type UserName,
  type UsersMap,
  type UserSettings,
  effectiveZoom,
  effectiveShowTrackNotes,
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
  const showTrackNotes = effectiveShowTrackNotes(users[activeUser]);

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

  // Track-note popup queue. One popup per (deck, fileName) is queued when that
  // track loads — the timer fires after showSecsAfterLoad and appends to the
  // queue; only the head is rendered. Unloading the deck or swapping the file
  // cancels the pending timer and removes any queued/shown popup for that deck.
  type PopupItem = { deck: DeckNumber; fileName: string; description: string; title: string; artist: string };
  const [popupQueue, setPopupQueue] = useState<PopupItem[]>([]);
  const pendingPopupTimers = useRef<Record<DeckNumber, ReturnType<typeof setTimeout> | null>>({
    1: null, 2: null, 3: null, 4: null,
  });
  const seenNoteForFile = useRef<Record<DeckNumber, string>>({ 1: '', 2: '', 3: '', 4: '' });
  // Latest decks snapshot — read at popup fire time so title/artist that
  // arrive after the initial load (common with StageLinq) make it into the popup.
  const latestDecksRef = useRef<DecksState>({
    1: makeBlankDeck(1), 2: makeBlankDeck(2), 3: makeBlankDeck(3), 4: makeBlankDeck(4),
  });
  // Latest user setting for popups — read inside the WS handler / fire-time
  // callback without rebuilding the closure on every settings change.
  const showTrackNotesRef = useRef(showTrackNotes);
  useEffect(() => { showTrackNotesRef.current = showTrackNotes; }, [showTrackNotes]);

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
        latestDecksRef.current = nextDecks;
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
            // Cancel any pending/shown note popup for this deck — the song changed.
            const t = pendingPopupTimers.current[d];
            if (t) { clearTimeout(t); pendingPopupTimers.current[d] = null; }
            seenNoteForFile.current[d] = '';
            setPopupQueue((q) => q.filter((p) => p.deck !== d));
          }

          // Schedule the note popup once per (deck, fileName). Re-evaluating on
          // every snapshot is cheap; the seenNoteForFile guard ensures the
          // timer is created exactly once for a given load.
          const note: TrackNote | null = msg.deckNotes?.[d] ?? null;
          const fn = nextDecks[d].fileName;
          if (
            showTrackNotesRef.current &&
            note &&
            note.description &&
            nextDecks[d].trackLoaded &&
            fn &&
            seenNoteForFile.current[d] !== fn
          ) {
            seenNoteForFile.current[d] = fn;
            const description = note.description;
            const delayMs = Math.max(0, Number(note.showSecsAfterLoad ?? 0)) * 1000;
            if (pendingPopupTimers.current[d]) clearTimeout(pendingPopupTimers.current[d]!);
            pendingPopupTimers.current[d] = setTimeout(() => {
              pendingPopupTimers.current[d] = null;
              if (!showTrackNotesRef.current) return;
              // Resolve title/artist at fire time — StageLinq often delivers
              // them in a later snapshot than the fileName.
              const live = latestDecksRef.current[d];
              if (!live.trackLoaded || live.fileName !== fn) return;
              const item: PopupItem = {
                deck: d,
                fileName: fn,
                description,
                title: live.title,
                artist: live.artist,
              };
              setPopupQueue((q) => (q.some((p) => p.deck === d && p.fileName === fn) ? q : [...q, item]));
            }, delayMs);
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
      for (const d of DECK_NUMBERS) {
        const t = pendingPopupTimers.current[d];
        if (t) { clearTimeout(t); pendingPopupTimers.current[d] = null; }
      }
    };
  }, [connect]);

  const dismissTopPopup = useCallback(() => {
    setPopupQueue((q) => q.slice(1));
  }, []);

  // When the operator turns popups off, drop everything pending or visible.
  // Mark every currently-loaded file as "seen" so flipping the setting back on
  // mid-track does not retroactively pop a note for a song already playing —
  // the note will surface naturally on the next load instead.
  useEffect(() => {
    if (showTrackNotes) {
      for (const d of DECK_NUMBERS) {
        const fn = latestDecksRef.current[d].fileName;
        if (fn) seenNoteForFile.current[d] = fn;
      }
      return;
    }
    for (const d of DECK_NUMBERS) {
      const t = pendingPopupTimers.current[d];
      if (t) { clearTimeout(t); pendingPopupTimers.current[d] = null; }
    }
    setPopupQueue([]);
  }, [showTrackNotes]);

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
          showTrackNotes={showTrackNotes}
          onChangeShowTrackNotes={(v) =>
            updateUserSettings(activeUser, { showTrackNotes: v })
          }
          freewheel={freewheel}
          freewheelDurationLimits={freewheelMeta.freewheel_max_duration_sec}
          onChangeFreewheel={updateFreewheel}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {popupQueue.length > 0 && (
        <TrackNotePopup
          key={`${popupQueue[0].deck}-${popupQueue[0].fileName}`}
          deck={popupQueue[0].deck}
          fileName={popupQueue[0].fileName}
          title={popupQueue[0].title}
          artist={popupQueue[0].artist}
          description={popupQueue[0].description}
          onDismiss={dismissTopPopup}
        />
      )}
    </div>
  );
}
