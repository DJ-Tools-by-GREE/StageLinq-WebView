import { MediaCache } from './mediaCache.js';
import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import type { DeckNumber, DeckState, RecordingStatus, ReplayStatus, StageLinqStatus, TerminalLogLine, TrackNote, WaveformStatusPayload, WsPayload } from './types.js';
import type { WaveformState } from './appTypes.js';
import DeckCard from './DeckCard.js';
import HeaderBar from './HeaderBar.js';
import SettingsModal from './SettingsModal.js';
import TerminalPanel from './TerminalPanel.js';
import TrackNotePopup from './TrackNotePopup.js';
import ConfigEditorOverlay from './configEditor/ConfigEditorOverlay.js';
import { useUserPreferences, useFreewheelPreferences } from './useSettingsPersistence.js';
import {
  FIXED_USERS,
  type UserName,
  type UserSettings,
  type Role,
  type DeckLayout,
  effectiveZoom,
  effectiveShowTrackNotes,
  effectiveRole,
  effectiveDeckLayout,
  loadActiveUser,
  saveActiveUser,
  clampZoom,
  ROLE_DERIVED_KEYS,
} from './userSettings.js';
import { postReloadConfig, type ReloadConfigResult } from './globalSettings.js';

const DECK_NUMBERS: DeckNumber[] = [1, 2, 3, 4];

const TERMINAL_MAX_LINES = 1000;

function makeBlankDeck(deck: DeckNumber): DeckState {
  return {
    deck,
    trackLoaded: false,
    fileName: '',
    mediaId: '',
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
  return { peaks: null, peaksPerSec: 200, stage: null, progress: 0, fileName: '', trackId: '' };
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
  const waveformStatusesRef = useRef<Partial<Record<DeckNumber, WaveformStatusPayload>>>({});
  const mediaCacheRef = useRef(new MediaCache());
  const [artworkUrls, setArtworkUrls] = useState<Record<string, string>>({});
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

  const { users, ready: usersReady, loadError: usersLoadError, saveStates: userSaveStates,
    update: updateUserSettings, retry: retryUserSave, reload: reloadUsers } = useUserPreferences();
  const [activeUser, setActiveUserState] = useState<UserName>(() => loadActiveUser());
  const { freewheel, meta: freewheelMeta, loadError: freewheelLoadError, saveState: freewheelSaveState,
    update: updateFreewheel, retry: retryFreewheelSave, refresh: refreshFreewheel } = useFreewheelPreferences();

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

  const reloadBackendConfig = useCallback(async (): Promise<ReloadConfigResult> => {
    const result = await postReloadConfig();
    if (result.ok) await refreshFreewheel();
    return result;
  }, [refreshFreewheel]);

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
      mediaCacheRef.current.clear();
    };
  }, []);

  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws`;
  }, []);

  const connect = useCallback(() => {
    if (unmounting.current) return;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    let lastSeq = -1;
    waveformStatusesRef.current = {};

    ws.onopen = () => {
      if (unmounting.current || wsRef.current !== ws) return;
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
      if (unmounting.current || wsRef.current !== ws) return;
      let msg: WsPayload;
      try { msg = JSON.parse(ev.data as string); } catch { return; }

      if (msg.type === 'snapshot') {
        lastMsgAt.current = Date.now();
        if (msg.seq <= lastSeq) return;
        lastSeq = msg.seq;
        const nextDecks = msg.decks as DecksState;
        latestDecksRef.current = nextDecks;
        mediaCacheRef.current.setActive(Object.values(nextDecks).filter(d => d.trackLoaded).map(d => d.mediaId));
        setArtworkUrls(mediaCacheRef.current.artworkUrls());
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
          const fileChanged = prevFile[d] !== (nextDecks[d].mediaId || '');
          if (unloaded || fileChanged) {
            const newTrackId = nextDecks[d].mediaId;
            setWaveforms((w) => {
              if (!unloaded && w[d].trackId === newTrackId && newTrackId) return w;
              return { ...w, [d]: makeBlankWaveform() };
            });
            // Cancel any pending/shown note popup for this deck — the song changed.
            const t = pendingPopupTimers.current[d];
            if (t) { clearTimeout(t); pendingPopupTimers.current[d] = null; }
            seenNoteForFile.current[d] = '';
            setPopupQueue((q) => q.filter((p) => p.deck !== d));
          }

          const trackId = nextDecks[d].trackLoaded ? nextDecks[d].mediaId : '';
          const cached = mediaCacheRef.current.get(trackId);
          const pendingStatus = waveformStatusesRef.current[d];
          setWaveforms(w => {
            if (cached?.peaks) {
              if (w[d].trackId === trackId && w[d].peaks === cached.peaks) return w;
              return { ...w, [d]: { peaks: cached.peaks, peaksPerSec: cached.peaksPerSec!,
                stage: 'ready', progress: 100, fileName: nextDecks[d].fileName, trackId } };
            }
            if (pendingStatus?.trackId === trackId && trackId) {
              if (!w[d].peaks && w[d].trackId === trackId && w[d].stage === pendingStatus.stage && w[d].progress === pendingStatus.progress) return w;
              return { ...w, [d]: { ...makeBlankWaveform(), stage: pendingStatus.stage,
                progress: pendingStatus.progress, fileName: nextDecks[d].fileName, trackId } };
            }
            return w[d].trackId || w[d].peaks ? { ...w, [d]: makeBlankWaveform() } : w;
          });

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
          prevFile[d] = nextDecks[d].mediaId || '';
        }
      } else if (msg.type === 'waveform_status') {
        const { deck, stage, progress, fileName, trackId } = msg;
        if (!trackId || !DECK_NUMBERS.includes(deck)) return;
        waveformStatusesRef.current[deck] = msg;
        if (latestDecksRef.current[deck].mediaId !== trackId || !latestDecksRef.current[deck].trackLoaded) return;
        setWaveforms(prev => ({ ...prev, [deck]: {
          peaks: prev[deck].trackId === trackId ? prev[deck].peaks : null,
          peaksPerSec: prev[deck].peaksPerSec, stage, progress, fileName, trackId,
        } }));
      } else if (msg.type === 'waveform_data') {
        const { peaks, peaksPerSec, trackId, fileName } = msg;
        if (!trackId || !Array.isArray(peaks)) return;
        const cache = mediaCacheRef.current;
        cache.setPeaks(trackId, peaks, peaksPerSec);
        setArtworkUrls(cache.artworkUrls());
        setWaveforms(prev => {
          const next = { ...prev };
          for (const d of DECK_NUMBERS) {
            const live = latestDecksRef.current[d];
            const entry = live.trackLoaded ? cache.get(live.mediaId) : undefined;
            if (entry?.peaks) next[d] = { peaks: entry.peaks, peaksPerSec: entry.peaksPerSec!,
              stage: 'ready', progress: 100, fileName: live.fileName, trackId: live.mediaId };
            else if (prev[d].peaks) next[d] = makeBlankWaveform();
          }
          return next;
        });
      } else if (msg.type === 'artwork_data') {
        const { trackId, data, mime } = msg;
        if (!trackId) return;
        try {
          const blob = data && mime ? new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: mime }) : null;
          mediaCacheRef.current.setArtwork(trackId, blob);
          setArtworkUrls(mediaCacheRef.current.artworkUrls());
        } catch { return; }
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
      if (unmounting.current || wsRef.current !== ws) return;
      wsRef.current = null;
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
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
      }
      for (const d of DECK_NUMBERS) {
        const t = pendingPopupTimers.current[d];
        if (t) { clearTimeout(t); pendingPopupTimers.current[d] = null; }
      }
    };
  }, [connect]);

  const closeConfigEditor = useCallback(() => setConfigEditorOpen(false), []);

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
            artworkUrl={artworkUrls[decks[d].mediaId] ?? null}
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
          usersReady={usersReady}
          usersLoadError={usersLoadError}
          userSaveState={userSaveStates[activeUser] ?? { phase: 'idle' }}
          onReloadUsers={reloadUsers}
          onRetryUserSave={() => retryUserSave(activeUser)}
          freewheelLoadError={freewheelLoadError}
          freewheelSaveState={freewheelSaveState}
          onRefreshFreewheel={refreshFreewheel}
          onRetryFreewheelSave={retryFreewheelSave}
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
        <ConfigEditorOverlay onClose={closeConfigEditor} />
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
