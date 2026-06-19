import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import type { DeckNumber, DeckState, RecordingStatus, ReplayStatus, StageLinqStatus, TerminalLogLine, TrackNote, WsPayload } from './types.js';
import type { WaveformState } from './appTypes.js';
import DeckCard from './DeckCard.js';
import HeaderBar from './HeaderBar.js';
import SettingsModal from './SettingsModal.js';
import TerminalPanel from './TerminalPanel.js';
import TrackNotePopup from './TrackNotePopup.js';
import ConfigEditorOverlay from './configEditor/ConfigEditorOverlay.js';
import {
  FIXED_USERS,
  type UserName,
  type UsersMap,
  type UserSettings,
  type Role,
  type DeckLayout,
  effectiveZoom,
  effectiveShowTrackNotes,
  effectiveRole,
  effectiveDeckLayout,
  fetchAllUsers,
  putUserSettings,
  loadActiveUser,
  saveActiveUser,
  clampZoom,
  ROLE_DERIVED_KEYS,
} from './userSettings.js';
import {
  fetchGlobalSettings,
  putFreewheelSettings,
  postReloadConfig,
  type FreewheelSettings,
  type GlobalSettingsMeta,
  type ReloadConfigResult,
  FREEWHEEL_DURATION_FALLBACK,
} from './globalSettings.js';

const DECK_NUMBERS: DeckNumber[] = [1, 2, 3, 4];

const SETTINGS_PUT_DEBOUNCE_MS = 250;

const TERMINAL_MAX_LINES = 1000;

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
  // Frontend-side peaks cache, keyed by fileName. The backend `waveform_data`
  // frame arrives keyed only by fileName (no `deck` field) — and frequently
  // arrives BEFORE the snapshot that announces the new fileName on a deck
  // (on initial WS connect the backend sends cached frames, then snapshots
  // start; on a track-change `setImmediate` lands the frame ahead of the next
  // 30 Hz tick). We cache the peaks here and apply them to whichever deck
  // currently holds — or later loads — that file.
  const peaksByFileRef = useRef<Record<string, { peaks: number[]; peaksPerSec: number }>>({});
  const [connected, setConnected] = useState(false);
  const [stagelinqStatus, setStagelinqStatus] = useState<StageLinqStatus>('no-device');
  const [freewheelActive, setFreewheelActive] = useState(false);
  const [selectedDeck, setSelectedDeck] = useState<DeckNumber | null>(null);
  const [nextTrack, setNextTrack] = useState<string | null>(null);
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus | null>(null);
  const [replayStatus, setReplayStatus] = useState<ReplayStatus | null>(null);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configEditorOpen, setConfigEditorOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalLines, setTerminalLines] = useState<TerminalLogLine[]>([]);

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
  const role = effectiveRole(users[activeUser]);
  const deckLayout = effectiveDeckLayout(users[activeUser]);
  const visibleDecks: DeckNumber[] = deckLayout === 2 ? [1, 2] : DECK_NUMBERS;
  // True iff at least one role-derived field is currently overridden by an
  // explicit user value. Drives the reset-button enabled state in Settings.
  const hasRoleOverrides = ROLE_DERIVED_KEYS.some(
    (k) => users[activeUser]?.[k] !== undefined,
  );

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

  // Mid-show config reload. Refetches global settings on success so the
  // freewheel knob reflects whatever the file now says (in case the operator
  // hand-edited config.json before clicking).
  const reloadBackendConfig = useCallback(async (): Promise<ReloadConfigResult> => {
    const result = await postReloadConfig();
    if (result.ok) {
      fetchGlobalSettings()
        .then((res) => setFreewheel(res.freewheel))
        .catch(() => {});
    }
    return result;
  }, []);

  // Per-user debounced PUT. One timer per user so quickly editing user A then
  // user B does not drop A's pending write.
  const putTimersRef = useRef<Partial<Record<UserName, ReturnType<typeof setTimeout>>>>({});

  // Patch semantics: any key whose value is `undefined` is REMOVED from the
  // persisted settings (so the field falls back to role/global defaults).
  // Any other value overwrites. Used by the "Reset to role defaults" button
  // in SettingsModal — see ROLE_DERIVED_KEYS in userSettings.ts.
  const updateUserSettings = useCallback((name: UserName, patch: Partial<UserSettings>) => {
    setUsers((prev) => {
      const merged: UserSettings = { ...prev[name] };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (merged as Record<string, unknown>)[k];
        else (merged as Record<string, unknown>)[k] = v;
      }
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
  // Read inside ws.onopen so a reconnect mid-session re-subscribes without
  // having to rebuild the `connect` closure (which would tear down the socket).
  const terminalOpenRef = useRef(false);
  useEffect(() => { terminalOpenRef.current = terminalOpen; }, [terminalOpen]);
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
      // Re-subscribe to terminal stream if the panel is open across a reconnect.
      if (terminalOpenRef.current) {
        try { ws.send(JSON.stringify({ type: 'terminal_subscribe', enabled: true })); } catch {}
      }
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
        setFreewheelActive(msg.freewheelActive === true);
        setRecordingStatus(msg.recordingStatus ?? null);
        setReplayStatus(msg.replayStatus ?? null);
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

          // If we already have peaks cached for this deck's current file (e.g.
          // the waveform_data frame arrived before this snapshot announced the
          // fileName), bind them now. Cheap no-op when the deck already shows
          // the same fileName as last tick.
          const fnNow = nextDecks[d].fileName;
          if (fnNow && prevFile[d] !== fnNow) {
            const cached = peaksByFileRef.current[fnNow];
            if (cached) {
              setWaveforms((w) => (
                w[d].fileName === fnNow && w[d].peaks
                  ? w
                  : { ...w, [d]: { peaks: cached.peaks, peaksPerSec: cached.peaksPerSec, stage: 'ready', progress: 100, fileName: fnNow } }
              ));
            }
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
        const { peaks, peaksPerSec, fileName } = msg;
        // Cache by fileName so a frame that lands before the matching snapshot
        // (initial connect + setImmediate-deferred track-change broadcasts both
        // race the next 30 Hz snapshot) still gets bound when the deck reports
        // the file. Then apply to every deck currently holding it.
        peaksByFileRef.current[fileName] = { peaks, peaksPerSec };
        setWaveforms((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const d of DECK_NUMBERS) {
            if (latestDecksRef.current[d].fileName === fileName) {
              next[d] = { peaks, peaksPerSec, stage: 'ready', progress: 100, fileName };
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      } else if (msg.type === 'artwork_data') {
        const { fileName, data, mime } = msg;
        if (!data || !mime) return;
        const prev = artworkObjectUrlsRef.current[fileName];
        if (prev) URL.revokeObjectURL(prev);
        const blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mime });
        const url = URL.createObjectURL(blob);
        artworkObjectUrlsRef.current[fileName] = url;
        setArtworkUrls((m) => ({ ...m, [fileName]: url }));
      } else if (msg.type === 'terminal_lines') {
        const incoming = msg.lines;
        if (msg.mode === 'replace') {
          setTerminalLines(incoming.slice(-TERMINAL_MAX_LINES));
        } else {
          setTerminalLines((prev) => {
            const next = prev.concat(incoming);
            return next.length > TERMINAL_MAX_LINES
              ? next.slice(next.length - TERMINAL_MAX_LINES)
              : next;
          });
        }
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

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((open) => {
      const next = !open;
      const ws = wsRef.current;
      if (ws && ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify({ type: 'terminal_subscribe', enabled: next })); } catch {}
      }
      // Wipe the buffer when closing so the next open starts from a fresh
      // server-seeded ring rather than a stale snapshot.
      if (!next) setTerminalLines([]);
      return next;
    });
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

  return (
    <div className="appShell">
      {headerVisible && (
        <HeaderBar
          connected={connected}
          stagelinqStatus={stagelinqStatus}
          freewheelActive={freewheelActive}
          selectedDeck={selectedDeck}
          selectedDeckState={selectedDeck ? decks[selectedDeck] : null}
          nextTrack={nextTrack}
          onOpenSettings={() => setSettingsOpen(true)}
          users={FIXED_USERS}
          activeUser={activeUser}
          onChangeUser={setActiveUser}
          recordingStatus={recordingStatus}
          replayStatus={replayStatus}
          terminalOpen={terminalOpen}
          onToggleTerminal={toggleTerminal}
        />
      )}
      {terminalOpen && (
        <TerminalPanel lines={terminalLines} onClose={toggleTerminal} />
      )}
      <div className={`grid grid--${deckLayout}`}>
        {visibleDecks.map((d) => (
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
          role={role}
          onChangeRole={(v: Role) =>
            updateUserSettings(activeUser, { role: v })
          }
          deckLayout={deckLayout}
          onChangeDeckLayout={(v: DeckLayout) =>
            updateUserSettings(activeUser, { deckLayout: v })
          }
          onResetRoleDefaults={() => {
            const patch: Partial<UserSettings> = {};
            for (const k of ROLE_DERIVED_KEYS) (patch as Record<string, undefined>)[k] = undefined;
            updateUserSettings(activeUser, patch);
          }}
          hasRoleOverrides={hasRoleOverrides}
          freewheel={freewheel}
          freewheelDurationLimits={freewheelMeta.freewheel_max_duration_sec}
          onChangeFreewheel={updateFreewheel}
          onReloadConfig={reloadBackendConfig}
          onOpenConfigEditor={() => {
            setSettingsOpen(false);
            setConfigEditorOpen(true);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {configEditorOpen && (
        <ConfigEditorOverlay onClose={() => setConfigEditorOpen(false)} />
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
