import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { StageLinqBridge, getRecentOverThresholdGaps } from './stagelinqBridge.js';
import type { DeckNumber, SnapshotPayload, StageLinqStatus, TrackNote, WaveformStatusPayload, WsPayload } from './types.js';
import { ArtNetTimecodeBroadcaster } from './artnetTimecode.js';
import { OscBpmSender } from './oscBpm.js';
import { RECONNECT_DELAY_MS, WS_FPS, DISCONNECT_DETECT_TIMEOUT_S, FREEWHEEL_STALE_THRESHOLD_MS, FREEWHEEL_FLAP_SHORT_CYCLE_MAX_MS, FREEWHEEL_FLAP_WINDOW_MS, FREEWHEEL_FLAP_MIN_CYCLES, FREEWHEEL_FLAP_LOG_COOLDOWN_MS, MAIN_EVENT_LOOP_LAG_WARN_MS, WS_BROADCAST_WARN_MS, MIN_TRIGGER_B_ELAPSED_SEC } from './constants.js';
import { States, StageLinqValue } from "@gree44/stagelinq";
import { logError, logLifecycle, logWarn, logWaveform, logUiOut, applyLoggingConfig, applyDisplayConfig, DISPLAY_ENABLED, logDashboard, deckColor, getStatusSlot, DIM, R, GRN, YEL, RED, RST, subscribeTerminalLines, getTerminalRing } from './logging.js';
import {
  initWaveformCache,
  requestExtraction,
  shutdownWaveformWorker,
  peaksFrameCache,
  artworkFrameCache,
  artworkCache,
} from './waveformService.js';
import { UserSettingsStore, FIXED_USERS, resolveUsersFilePath } from './userSettings.js';
import { GlobalSettingsStore, readFreewheelFromConfig, FREEWHEEL_MIN_DURATION_SEC, FREEWHEEL_MAX_DURATION_SEC } from './globalSettings.js';
import { Recorder, listRecordings } from './recorder.js';
import { Replay } from './replay.js';
import { makeStateProvider } from './stateProvider.js';

function isIgnorableStageLinqError(err: unknown): boolean {
  if (!err) return false;
  const msg =
    typeof err === 'string'
      ? err
      : ((err as any)?.message ?? String(err));

  const text = String(msg);
  return (
    text.includes('No broadcast targets have been found') ||
    text.includes("File Transfer Unhandled message id '6'")
  );
}

process.on('uncaughtException', (err: unknown) => {
  if (isIgnorableStageLinqError(err)) {
    logError('[StageLinq] Non-fatal library error. Continuing:', (err as any)?.message || err);
    return;
  }

  logError('Uncaught exception:', (err as any)?.message || err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  if (isIgnorableStageLinqError(reason)) {
    logError('[StageLinq] Non-fatal library error. Continuing:', (reason as any)?.message || reason);
    return;
  }

  logError('Unhandled rejection:', (reason as any)?.message || reason);
  process.exit(1);
});

function ensureState(state: StageLinqValue) {
  if (!States.includes(state)) States.push(state);
}

// Total time (TrackLength) + KeyIndex (CurrentKeyIndex) for all decks
[
  StageLinqValue.EngineDeck1TrackTrackLength,
  StageLinqValue.EngineDeck2TrackTrackLength,
  StageLinqValue.EngineDeck3TrackTrackLength,
  StageLinqValue.EngineDeck4TrackTrackLength,

  StageLinqValue.EngineDeck1TrackCurrentKeyIndex,
  StageLinqValue.EngineDeck2TrackCurrentKeyIndex,
  StageLinqValue.EngineDeck3TrackCurrentKeyIndex,
  StageLinqValue.EngineDeck4TrackCurrentKeyIndex,

  StageLinqValue.EngineDeck1TrackCurrentLoopInPosition,
  StageLinqValue.EngineDeck2TrackCurrentLoopInPosition,
  StageLinqValue.EngineDeck3TrackCurrentLoopInPosition,
  StageLinqValue.EngineDeck4TrackCurrentLoopInPosition,

  StageLinqValue.EngineDeck1TrackCurrentLoopOutPosition,
  StageLinqValue.EngineDeck2TrackCurrentLoopOutPosition,
  StageLinqValue.EngineDeck3TrackCurrentLoopOutPosition,
  StageLinqValue.EngineDeck4TrackCurrentLoopOutPosition,

  StageLinqValue.EngineDeck1TrackLoopEnableState,
  StageLinqValue.EngineDeck2TrackLoopEnableState,
  StageLinqValue.EngineDeck3TrackLoopEnableState,
  StageLinqValue.EngineDeck4TrackLoopEnableState,

  StageLinqValue.EngineDeck1TrackLoopQuickLoop1,
  StageLinqValue.EngineDeck1TrackLoopQuickLoop2,
  StageLinqValue.EngineDeck1TrackLoopQuickLoop3,
  StageLinqValue.EngineDeck1TrackLoopQuickLoop4,
  StageLinqValue.EngineDeck1TrackLoopQuickLoop5,
  StageLinqValue.EngineDeck1TrackLoopQuickLoop6,
  StageLinqValue.EngineDeck1TrackLoopQuickLoop7,
  StageLinqValue.EngineDeck1TrackLoopQuickLoop8,

  StageLinqValue.EngineDeck2TrackLoopQuickLoop1,
  StageLinqValue.EngineDeck2TrackLoopQuickLoop2,
  StageLinqValue.EngineDeck2TrackLoopQuickLoop3,
  StageLinqValue.EngineDeck2TrackLoopQuickLoop4,
  StageLinqValue.EngineDeck2TrackLoopQuickLoop5,
  StageLinqValue.EngineDeck2TrackLoopQuickLoop6,
  StageLinqValue.EngineDeck2TrackLoopQuickLoop7,
  StageLinqValue.EngineDeck2TrackLoopQuickLoop8,

  StageLinqValue.EngineDeck3TrackLoopQuickLoop1,
  StageLinqValue.EngineDeck3TrackLoopQuickLoop2,
  StageLinqValue.EngineDeck3TrackLoopQuickLoop3,
  StageLinqValue.EngineDeck3TrackLoopQuickLoop4,
  StageLinqValue.EngineDeck3TrackLoopQuickLoop5,
  StageLinqValue.EngineDeck3TrackLoopQuickLoop6,
  StageLinqValue.EngineDeck3TrackLoopQuickLoop7,
  StageLinqValue.EngineDeck3TrackLoopQuickLoop8,

  StageLinqValue.EngineDeck4TrackLoopQuickLoop1,
  StageLinqValue.EngineDeck4TrackLoopQuickLoop2,
  StageLinqValue.EngineDeck4TrackLoopQuickLoop3,
  StageLinqValue.EngineDeck4TrackLoopQuickLoop4,
  StageLinqValue.EngineDeck4TrackLoopQuickLoop5,
  StageLinqValue.EngineDeck4TrackLoopQuickLoop6,
  StageLinqValue.EngineDeck4TrackLoopQuickLoop7,
  StageLinqValue.EngineDeck4TrackLoopQuickLoop8,
].forEach(ensureState);


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 8090);

interface ConfigTrack {
  song_index?: string;
  offset_sec?: number;
  offset_frame?: number;
  mashup_only?: boolean;
  note?: {
    description?: string;
    show_secs_after_load?: number;
  };
}

interface RootConfig {
  current_playlist?: number;
  timecode?: {
    fps?: number;
    target_ip?: string;
    target_ips?: string[];
    target_port?: number;
    stream_id?: number;
  };
  control_input?: {
    mode?: string;
    universe?: number;
    address?: number;
    execute_address?: number;
  };
  osc?: {
    enabled?: boolean;
    target_ip?: string;
    target_ips?: string[];
    target_port?: number;
    speedmaster?: number;
  };
  sacn_sim?: { enabled?: boolean };
  waveform?: { all_tracks?: boolean };
  freewheel?: {
    enable_freewheeling?: boolean;
    max_duration_sec?: number;
  };
  playlists?: Array<{
    name?: string;
    content?: ConfigTrack[];
  }>;
  logging?: {
    lifecycle?: boolean;
    playback?: boolean;
    discover?: boolean;
    discoverSpeed?: boolean;
    bpmDebug?: boolean;
    uiOut?: boolean;
    errors?: boolean;
    cues?: boolean;
    artnetStats?: boolean;
  };
  display?: {
    dashboard?: boolean;
    artnet?: boolean;
    info?: boolean;
  };
  recordings?: Array<{
    audio_file?: string;
    log_file?: string;
  }>;
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

async function loadRootConfig(): Promise<{ config: RootConfig | null; sourcePath: string | null }> {
  const candidates = [
    path.resolve(process.cwd(), 'config.json'),
    path.resolve(__dirname, '../../config.json'),
  ];

  for (const filePath of candidates) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(stripJsonComments(raw)) as RootConfig;
      logLifecycle(`${GRN}[CONFIG] Loaded ${filePath}${RST}`);
      return { config: parsed, sourcePath: filePath };
    } catch {
      // try next candidate
    }
  }

  logLifecycle(`${RED}[CONFIG] No config.json found, using env/default values.${RST}`);
  return { config: null, sourcePath: candidates[0] };
}

function normalizeTrackName(name: string): string {
  return path.basename(name.trim());
}

function buildTrackOffsetMap(cfg: RootConfig | null): Map<string, { offsetSec: number; offsetFrame: number }> {
  const map = new Map<string, { offsetSec: number; offsetFrame: number }>();
  const playlists = cfg?.playlists ?? [];

  // Priority: current playlist first, then all others as fallback.
  const currentIdx = Number(cfg?.current_playlist ?? -1);
  const ordered = playlists
    .map((pl, idx) => ({ pl, idx }))
    .sort((a, b) => (a.idx === currentIdx ? -1 : b.idx === currentIdx ? 1 : a.idx - b.idx));

  for (const { pl } of ordered) {
    for (const item of pl.content ?? []) {
      if (item.mashup_only === true) continue;
      const key = normalizeTrackName(String(item.song_index ?? ''));
      if (!key || map.has(key)) continue;
      map.set(key, {
        offsetSec: Number(item.offset_sec ?? 0),
        offsetFrame: Number(item.offset_frame ?? 0),
      });
    }
  }

  return map;
}

function buildTrackNoteMap(cfg: RootConfig | null): Map<string, { description: string; showSecsAfterLoad: number }> {
  const map = new Map<string, { description: string; showSecsAfterLoad: number }>();
  const playlists = cfg?.playlists ?? [];

  const currentIdx = Number(cfg?.current_playlist ?? -1);
  const ordered = playlists
    .map((pl, idx) => ({ pl, idx }))
    .sort((a, b) => (a.idx === currentIdx ? -1 : b.idx === currentIdx ? 1 : a.idx - b.idx));

  for (const { pl } of ordered) {
    for (const item of pl.content ?? []) {
      if (item.mashup_only === true) continue;
      const key = normalizeTrackName(String(item.song_index ?? ''));
      if (!key || map.has(key)) continue;
      const desc = String(item.note?.description ?? '').trim();
      if (!desc) continue;
      const delayRaw = Number(item.note?.show_secs_after_load ?? 0);
      const delay = Number.isFinite(delayRaw) && delayRaw >= 0 ? delayRaw : 0;
      map.set(key, { description: desc, showSecsAfterLoad: delay });
    }
  }

  return map;
}

function deviceIdFromNetPath(netPath: string): string | null {
  const parts = netPath.split('/');
  // net://uuid/source/... → parts: ['net:', '', 'uuid', 'source', ...]
  if (parts.length < 4 || parts[0] !== 'net:') return null;
  return `net://${parts[2]}`;
}

function filePathFromNetPath(netPath: string): string | null {
  const parts = netPath.split('/');
  if (parts.length < 4 || parts[0] !== 'net:') return null;
  return '/' + parts.slice(3).join('/');
}

function buildActivePlaylistFileSet(cfg: RootConfig | null): Set<string> {
  const set = new Set<string>();
  const playlists = cfg?.playlists ?? [];
  const idx = Number(cfg?.current_playlist ?? -1);
  if (idx < 0 || idx >= playlists.length) return set;
  for (const item of playlists[idx].content ?? []) {
    if (item.mashup_only === true) continue;
    const key = normalizeTrackName(String(item.song_index ?? ''));
    if (key) set.add(key);
  }
  return set;
}

function computeNextTrack(cfg: RootConfig | null, currentFileName: string | null): string | null {
  const playlists = cfg?.playlists ?? [];
  const idx = Number(cfg?.current_playlist ?? -1);
  if (idx < 0 || idx >= playlists.length) return null;
  // Mashups are UI-only — they must be invisible to ordering logic, both as
  // cursor positions (matching the currently-loaded file) and as candidates
  // for the next track. Filter them out once and run cursor logic on the
  // resulting "playable" list.
  const playable = (playlists[idx].content ?? []).filter((item) => item.mashup_only !== true);
  if (!currentFileName) return playable[0]?.song_index ?? null;
  const key = normalizeTrackName(currentFileName);
  const pos = playable.findIndex((item) => normalizeTrackName(String(item.song_index ?? '')) === key);
  if (pos < 0) return null;
  return playable[pos + 1]?.song_index ?? null;
}

// Locate which deck (if any) currently holds the given playlist filename.
// Tiebreak: prefer a playing deck, then the lowest deck number.
function findDeckForFile(
  decks: Record<DeckNumber, import('./types.js').DeckState>,
  fileName: string | null,
): DeckNumber | null {
  if (!fileName) return null;
  const target = normalizeTrackName(fileName);
  const matches: DeckNumber[] = [];
  for (const d of [1, 2, 3, 4] as DeckNumber[]) {
    const ds = decks[d];
    if (!ds?.trackLoaded || !ds.fileName) continue;
    if (normalizeTrackName(ds.fileName) === target) matches.push(d);
  }
  if (matches.length === 0) return null;
  const playing = matches.find((d) => decks[d].play);
  return playing ?? matches[0];
}

// Decide which deck the operator should switch to next.
// Triggers (either fires a suggestion; both require: next-track deck has no loop
// active, the candidate deck is not already selected, and the candidate deck is
// loaded with the playlist's next track):
//   A) Next-track deck is currently playing.
//   B) The currently selected deck has stopped (play=false), has been
//      meaningfully played (elapsedSec > MIN_TRIGGER_B_ELAPSED_SEC) so a
//      tap-play-stop at the very beginning is not treated as a hand-off,
//      AND the next-track deck has that track loaded.
function computeSuggestedDeck(
  cfg: RootConfig | null,
  decks: Record<DeckNumber, import('./types.js').DeckState>,
  selectedDeck: DeckNumber | null,
): DeckNumber | null {
  if (!selectedDeck) return null;
  const selected = decks[selectedDeck];
  if (!selected) return null;

  const nextFile = computeNextTrack(cfg, selected.trackLoaded ? selected.fileName : null);
  if (!nextFile) return null;

  const candidate = findDeckForFile(decks, nextFile);
  if (!candidate) return null;
  if (candidate === selectedDeck) return null;

  const candDeck = decks[candidate];
  if (candDeck.loopActive) return null;

  const triggerA = candDeck.play === true;
  const triggerB =
    selected.play === false &&
    candDeck.trackLoaded === true &&
    Number.isFinite(selected.elapsedSec) &&
    selected.elapsedSec > MIN_TRIGGER_B_ELAPSED_SEC;
  if (!triggerA && !triggerB) return null;

  return candidate;
}

function mapDmxToDeck(value: number): DeckNumber | null {
  // 0–50 is the documented "off" band — explicit deselection from the lighting
  // console. The Art-Net poll lambda turns a null selection into a no-packet
  // tick, so timecode stops cleanly on the receiver side.
  if (value <= 50) return null;
  if (value <= 101) return 1;
  if (value <= 152) return 2;
  if (value <= 203) return 3;
  return 4;
}

function toAbsoluteDmxValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const v = Math.max(0, value);
  // sacn package payload is commonly 0..100 (relative). Convert to 0..255.
  if (v <= 100) return Math.round((v / 100) * 255);
  // already absolute scale
  return Math.min(255, Math.round(v));
}

function coerceDmxPayload(packet: any): number[] {
  const candidates = [
    packet?.payload,
    packet?.propertyValues,
    packet?.values,
    packet?.dmxData,
    packet?.data?.payload,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c.map((v) => Number(v) || 0);
    if (Buffer.isBuffer(c)) return Array.from(c);
    if (ArrayBuffer.isView(c)) {
      const view = c as ArrayBufferView;
      return Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
    if (c && typeof c === 'object') {
      const numericKeys = Object.keys(c).filter((k) => /^\d+$/.test(k));
      if (numericKeys.length > 0) {
        const out: number[] = [];
        for (const k of numericKeys) {
          const idx = Number(k);
          out[idx] = Number((c as any)[k]) || 0;
        }
        return out;
      }
    }
    if (c && typeof c === 'object' && Array.isArray((c as any).values)) {
      return (c as any).values.map((v: any) => Number(v) || 0);
    }
  }

  return [];
}

function getLocalIpv4Addresses(): string[] {
  const ifaces = os.networkInterfaces();
  const ips = new Set<string>();

  for (const entries of Object.values(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        ips.add(entry.address);
      }
    }
  }

  return [...ips];
}

function resolveTargetIps(
  envValue: string | undefined,
  configList: string[] | undefined,
  configSingle: string | undefined,
  fallback: string,
): string[] {
  const fromEnv = envValue
    ? envValue.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  if (fromEnv.length > 0) return fromEnv;

  const fromList = Array.isArray(configList)
    ? configList.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (fromList.length > 0) return fromList;

  if (configSingle && configSingle.trim()) return [configSingle.trim()];
  return [fallback];
}

async function main() {
  let { config, sourcePath: configPath } = await loadRootConfig();
  if (config?.logging) applyLoggingConfig(config.logging);
  if (config?.display) applyDisplayConfig(config.display);

  await initWaveformCache(process.cwd());

  // Event-loop lag probe — surfaces main-thread stalls (ffmpeg-done callbacks, JSON.stringify of
  // big peak arrays, base64 artwork, etc). The Art-Net worker is immune to these stalls; this
  // log just tells us where to look when the WS UI feels janky during a track change.
  {
    const PROBE_INTERVAL_MS = 250;
    let lastProbeAt = Date.now();
    let lastWarnAt = 0;
    setInterval(() => {
      const now = Date.now();
      const lag = now - lastProbeAt - PROBE_INTERVAL_MS;
      lastProbeAt = now;
      if (lag > MAIN_EVENT_LOOP_LAG_WARN_MS && now - lastWarnAt > 1000) {
        lastWarnAt = now;
        logError(`[main] event-loop lag ${lag.toFixed(0)}ms (probe ${PROBE_INTERVAL_MS}ms)`);
      }
    }, PROBE_INTERVAL_MS);
  }

  // Art-Net settings from root config.json (env vars override).
  const artnetEnabled = (process.env.ARTNET_ENABLED ?? 'true').toLowerCase() !== 'false';
  const artnetTargetIps = resolveTargetIps(
    process.env.ARTNET_TARGET_IP,
    config?.timecode?.target_ips,
    config?.timecode?.target_ip,
    '255.255.255.255',
  );
  const artnetPort = Number(process.env.ARTNET_PORT ?? config?.timecode?.target_port ?? 6454);
  const artnetDeck = (Number(process.env.ARTNET_DECK ?? 1) as 1 | 2 | 3 | 4);
  const artnetFps = Number(process.env.ARTNET_FPS ?? config?.timecode?.fps ?? 30);
  const artnetSendHz = Number(process.env.ARTNET_SEND_HZ ?? artnetFps);
  const artnetFpsType = 0x03;
  const artnetLatencyCompMs = Number(process.env.ARTNET_LATENCY_COMP_MS ?? 80);
  const artnetStreamId = Number(process.env.ARTNET_STREAM_ID ?? config?.timecode?.stream_id ?? 0x00);

  const oscEnabled = (process.env.OSC_ENABLED ?? String(config?.osc?.enabled ?? false)).toLowerCase() === 'true';
  const oscTargetIps = resolveTargetIps(
    process.env.OSC_TARGET_IP,
    config?.osc?.target_ips,
    config?.osc?.target_ip,
    '127.0.0.1',
  );
  const oscTargetPort = Number(process.env.OSC_TARGET_PORT ?? config?.osc?.target_port ?? 8000);
  const oscSpeedMaster = Number(process.env.OSC_SPEEDMASTER ?? config?.osc?.speedmaster ?? 15);

  // Control-input settings from root config.json (env vars override).
  const controlMode = String(process.env.CONTROL_INPUT_MODE ?? config?.control_input?.mode ?? 'sacn').toLowerCase();
  const sacnUniverse = Number(process.env.SACN_UNIVERSE ?? config?.control_input?.universe ?? 20);
  const controlAddress = Number(process.env.SACN_ADDRESS ?? config?.control_input?.address ?? 1);
  // Execute-suggestion channel: rising-edge >127 fires the OSC `sugDeck_<n>`
  // for the currently displayed suggestion. The lighting console drives this
  // when it confirms the suggestion. Defaults to channel 3, same universe.
  const executeAddress = Number(process.env.SACN_EXECUTE_ADDRESS ?? config?.control_input?.execute_address ?? 3);
  const sacnSimEnabled = (process.env.SACN_SIM === '1') || (config?.sacn_sim?.enabled === true);
  const controlChannelIndex = Math.max(0, controlAddress - 1);
  const executeChannelIndex = Math.max(0, executeAddress - 1);

  let trackOffsets = buildTrackOffsetMap(config);
  let trackNotes = buildTrackNoteMap(config);
  let activePlaylistFiles = buildActivePlaylistFileSet(config);
  let waveformAllTracks = config?.waveform?.all_tracks ?? true;

  let reloadInProgress = false;
  type ReloadResult =
    | { ok: true; offsetEntries: number; sourcePath: string | null }
    | { ok: false; reason: 'in-progress' }
    | { ok: false; reason: 'error'; error: string };
  const reloadConfig = async (): Promise<ReloadResult> => {
    if (reloadInProgress) return { ok: false, reason: 'in-progress' };
    reloadInProgress = true;
    try {
      const next = await loadRootConfig();
      config = next.config;
      configPath = next.sourcePath;
      if (config?.logging) applyLoggingConfig(config.logging);
      if (config?.display) applyDisplayConfig(config.display);
      trackOffsets = buildTrackOffsetMap(config);
      trackNotes = buildTrackNoteMap(config);
      activePlaylistFiles = buildActivePlaylistFileSet(config);
      waveformAllTracks = config?.waveform?.all_tracks ?? true;
      // Re-apply freewheel from the reloaded file. Operator-edited (via UI) values are
      // already on disk, so the round-trip is the same as a fresh boot.
      const fw = readFreewheelFromConfig(config);
      if (configPath) globalSettings.reset(configPath, { freewheel: fw });
      artnet.setFreewheel(fw.enable_freewheeling, fw.max_duration_sec);
      logLifecycle(`${GRN}[CONFIG] Reloaded. Offset entries: ${trackOffsets.size}${RST}`);
      return { ok: true, offsetEntries: trackOffsets.size, sourcePath: configPath };
    } catch (e: any) {
      const msg = e?.message || String(e);
      logError('[CONFIG] Reload failed:', msg);
      return { ok: false, reason: 'error', error: msg };
    } finally {
      reloadInProgress = false;
    }
  };

  // Hot reload via Ctrl+R (TTY only)
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdin.on('keypress', (_str, key) => {
      if (key?.ctrl && key?.name === 'r') {
        logLifecycle(`${YEL}[CONFIG] Ctrl+R detected. Reloading config...${RST}`);
        void reloadConfig();
      }
      if (key?.ctrl && key?.name === 'c') {
        process.emit('SIGINT');
      }
    });

    const restoreTty = () => {
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      } catch {
        // noop
      }
    };
    process.once('exit', restoreTty);
    process.once('SIGINT', restoreTty);
    process.once('SIGTERM', restoreTty);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  // User UI-settings store (users.json at repo root).
  const usersFilePath = await (async () => {
    const candidates = [
      path.resolve(process.cwd(), 'users.json'),
      path.resolve(__dirname, '../../users.json'),
    ];
    for (const p of candidates) {
      try { await fs.access(p); return p; } catch {}
    }
    return resolveUsersFilePath(path.resolve(__dirname, '../..'));
  })();
  const usersStore = new UserSettingsStore(usersFilePath);
  await usersStore.load();

  // Global (non-per-user) settings live alongside the existing config.json. The
  // store seeds from whatever the loader picked at boot, and `reloadConfig()` /
  // PUT handlers route changes both into memory and to disk.
  const initialFw = readFreewheelFromConfig(config);
  let globalSettings = new GlobalSettingsStore(
    configPath ?? path.resolve(process.cwd(), 'config.json'),
    { freewheel: initialFw },
  );

  // API health
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  app.get('/api/users', (_req, res) => {
    res.json({ users: usersStore.list() });
  });

  app.get('/api/users/:name/settings', (req, res) => {
    const settings = usersStore.get(req.params.name);
    if (settings === null) { res.status(404).json({ error: 'unknown user' }); return; }
    res.json({ name: req.params.name, settings });
  });

  app.put('/api/users/:name/settings', async (req, res) => {
    if (!FIXED_USERS.includes(req.params.name as any)) {
      res.status(404).json({ error: 'unknown user' });
      return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object of settings' });
      return;
    }
    const next = await usersStore.setSettings(req.params.name, body);
    if (next === null) {
      res.status(400).json({ error: 'invalid settings' });
      return;
    }
    res.json({ name: req.params.name, settings: next });
  });

  // Global (non-per-user) settings.
  app.get('/api/global-settings', (_req, res) => {
    res.json({
      ...globalSettings.get(),
      meta: {
        freewheel_max_duration_sec: {
          min: FREEWHEEL_MIN_DURATION_SEC,
          max: FREEWHEEL_MAX_DURATION_SEC,
        },
      },
    });
  });

  app.put('/api/global-settings/freewheel', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const patch: { enable_freewheeling?: boolean; max_duration_sec?: number } = {};
    if ('enable_freewheeling' in body) {
      if (typeof body.enable_freewheeling !== 'boolean') {
        res.status(400).json({ error: 'enable_freewheeling must be boolean' });
        return;
      }
      patch.enable_freewheeling = body.enable_freewheeling;
    }
    if ('max_duration_sec' in body) {
      const n = Number(body.max_duration_sec);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: 'max_duration_sec must be a number' });
        return;
      }
      patch.max_duration_sec = n;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'no fields supplied' });
      return;
    }
    const next = await globalSettings.setFreewheel(patch);
    // Push live to the Art-Net worker so the new behaviour applies immediately,
    // without waiting for a Ctrl+R reload or process restart.
    artnet.setFreewheel(next.enable_freewheeling, next.max_duration_sec);
    logLifecycle(
      `${GRN}[FREEWHEEL] enable=${next.enable_freewheeling} max=${next.max_duration_sec}s${RST}`,
    );
    res.json({ freewheel: next });
  });

  // Bulk read/write of the on-disk config.json. Backs the in-app config editor.
  // Write-only: the operator must Ctrl+R (or restart) to apply — keeps a Save
  // mid-show from re-initialising the StageLinq bridge / Art-Net worker by
  // surprise. The freewheel knob in the runtime settings modal is its own
  // live-knob path (`PUT /api/global-settings/freewheel`) and stays unaffected.
  app.get('/api/config', async (_req, res) => {
    try {
      if (!configPath) {
        res.status(404).json({ error: 'no config.json found on disk' });
        return;
      }
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(stripJsonComments(raw));
      res.json({ config: parsed, sourcePath: configPath });
    } catch (e: any) {
      logError('[CONFIG] GET /api/config failed:', e?.message || e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.put('/api/config', async (req, res) => {
    if (!configPath) {
      res.status(500).json({ error: 'no config.json path resolved at boot' });
      return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    try {
      const text = JSON.stringify(body, null, 4) + '\n';
      const tmp = `${configPath}.tmp`;
      await fs.writeFile(tmp, text, 'utf8');
      await fs.rename(tmp, configPath);
      logLifecycle(`${GRN}[CONFIG] Wrote ${configPath} via PUT /api/config (operator must Ctrl+R or restart to apply).${RST}`);
      res.json({ ok: true, sourcePath: configPath, applied: false });
    } catch (e: any) {
      logError('[CONFIG] PUT /api/config failed:', e?.message || e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Mid-show hot reload — same code path as Ctrl+R on the backend TTY, exposed
  // for headless / PM2 deployments and arm-gated in the UI.
  app.post('/api/config/reload', async (_req, res) => {
    logLifecycle(`${YEL}[CONFIG] HTTP reload requested. Reloading config...${RST}`);
    const result = await reloadConfig();
    if (result.ok) {
      res.json({
        ok: true,
        sourcePath: result.sourcePath,
        offsetEntries: result.offsetEntries,
      });
      return;
    }
    if (result.reason === 'in-progress') {
      res.status(409).json({ ok: false, error: 'reload already in progress' });
      return;
    }
    res.status(500).json({ ok: false, error: result.error });
  });

  app.get('/api/artwork/:deck', (req, res) => {
    const deck = Number(req.params.deck) as DeckNumber;
    const fileName = stateProvider.getDeck(deck)?.fileName;
    if (!fileName) { res.status(404).end(); return; }
    const entry = artworkCache.get(fileName);
    if (!entry) { res.status(404).end(); return; }
    res.setHeader('Content-Type', entry.mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(entry.data);
  });

  // -- Record & Replay --

  app.post('/api/record/start', async (req, res) => {
    const name = typeof req?.body?.name === 'string' ? req.body.name : undefined;
    const result = await recorder.start(name);
    if (result.ok) { res.json(result); return; }
    res.status(result.code).json({ ok: false, error: result.error });
  });

  app.post('/api/record/stop', async (_req, res) => {
    const result = await recorder.stop();
    if (result.ok) { res.json(result); return; }
    res.status(result.code).json({ ok: false, error: result.error });
  });

  app.get('/api/record/status', (_req, res) => {
    res.json(recorder.getStatus());
  });

  app.get('/api/recordings', async (_req, res) => {
    try {
      const list = await listRecordings(recordingsDir);
      res.json({ recordings: list, dir: recordingsDir });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post('/api/replay/arm', async (_req, res) => {
    if (recorder.isActive()) {
      res.status(409).json({ ok: false, error: 'cannot arm replay while recording' });
      return;
    }
    const mappings = config?.recordings ?? [];
    const result = await replay.arm(mappings);
    res.json(result);
  });

  app.post('/api/replay/disarm', (_req, res) => {
    replay.disarm();
    res.json({ ok: true });
  });

  app.get('/api/replay/status', (_req, res) => {
    res.json(replay.getStatus());
  });

  // sACN deck simulator — sends a real sACN packet to the configured universe/address
  let sacnSender: any = null;
  const DECK_DMX: Record<number, number> = { 1: 50, 2: 127, 3: 178, 4: 230 };
  if (sacnSimEnabled) app.post('/api/sacn/deck', async (req, res) => {
    const deck = Number(req?.body?.deck);
    if (![1, 2, 3, 4].includes(deck)) { res.status(400).json({ error: 'deck must be 1–4' }); return; }
    try {
      if (!sacnSender) {
        const sacnPkg: any = require('sacn');
        const SenderClass = sacnPkg?.Sender ?? sacnPkg?.default?.Sender;
        sacnSender = new SenderClass({ universe: sacnUniverse, minRefreshRate: 0, defaultPacketOptions: { useRawDmxValues: true } });
      }
      const payload: Record<number, number> = {};
      payload[controlAddress] = DECK_DMX[deck];
      await sacnSender.send({ payload });
      res.json({ ok: true, deck, universe: sacnUniverse, address: controlAddress, dmx: DECK_DMX[deck] });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  if (sacnSimEnabled) app.get('/sacn-sim', (_req, res) => {
    const u = sacnUniverse;
    const ch = controlAddress;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>sACN Deck Simulator</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111; color: #eee; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; gap: 24px; }
  h1 { font-size: 1.1rem; opacity: 0.5; letter-spacing: 0.05em; text-transform: uppercase; }
  .meta { font-size: 0.75rem; opacity: 0.4; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  button {
    width: 160px; height: 120px; border: none; border-radius: 12px; cursor: pointer;
    font-size: 2rem; font-weight: bold; color: #fff; transition: transform 0.1s, filter 0.1s;
    text-shadow: 0 1px 4px rgba(0,0,0,0.5);
  }
  button:hover { filter: brightness(1.25); }
  button:active { transform: scale(0.94); }
  button.active { outline: 3px solid #fff; outline-offset: 3px; }
  button[data-deck="1"] { background: #9333ea; }
  button[data-deck="2"] { background: #2563eb; }
  button[data-deck="3"] { background: #16a34a; }
  button[data-deck="4"] { background: #dc2626; }
  #status { font-size: 0.8rem; opacity: 0.5; min-height: 1.2em; }
</style>
</head>
<body>
<h1>sACN Deck Simulator</h1>
<div class="meta">Universe ${u} &nbsp;·&nbsp; CH ${ch}</div>
<div class="grid">
  <button data-deck="1">D1</button>
  <button data-deck="2">D2</button>
  <button data-deck="3">D3</button>
  <button data-deck="4">D4</button>
</div>
<div id="status">—</div>
<script>
  const status = document.getElementById('status');
  let active = null;
  document.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const deck = btn.dataset.deck;
      try {
        const r = await fetch('/api/sacn/deck', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ deck: Number(deck) })
        });
        const j = await r.json();
        if (j.ok) {
          document.querySelectorAll('button').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          active = deck;
          status.textContent = 'Sent → U${u} CH${ch} = ' + j.dmx + ' (Deck ' + deck + ')';
        } else {
          status.textContent = 'Error: ' + (j.error || 'unknown');
        }
      } catch (e) {
        status.textContent = 'Fetch error: ' + e.message;
      }
    });
  });
</script>
</body>
</html>`);
  });

  // Serve frontend build if present
  const frontendDist = path.resolve(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  let reconnecting = false;
  let bridge!: StageLinqBridge;

  // Recordings live in <repo-root>/recordings. The repo root is the directory containing
  // config.json; falls back to process.cwd() if no config was found at boot.
  const recordingsDir = path.resolve(configPath ? path.dirname(configPath) : process.cwd(), 'recordings');
  const replay = new Replay({ recordingsDir });
  let recorder!: Recorder;

  // Live status — recomputed on demand; recorder pushes a status event whenever it changes.
  let lastReportedStatus: StageLinqStatus = 'no-device';
  function stagelinqStatusForApi(): StageLinqStatus {
    if (reconnecting) return 'reconnecting';
    if (!bridge) return 'no-device';
    return bridge.getLastBeatAgeMs() <= DISCONNECT_DETECT_TIMEOUT_S * 1000 ? 'connected' : 'no-device';
  }

  let seq = 0;
  let uiUrls: string[] = [];
  let spinnerFrame = 0;
  const SPINNER = ['⡿', '⣟', '⣯', '⣷', '⣾', '⣽', '⣻', '⢿'];
  const clients = new Set<any>();
  const waveformTaskIds: Record<DeckNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };

  // Live terminal stream: clients opt in by sending {type:'terminal_subscribe', enabled:true}.
  // We keep one global tap on the logger and fan out only to the opted-in WS set,
  // so closed-panel clients pay zero cost beyond a single Set membership check.
  const terminalSubscribers = new Set<any>();
  let terminalTapDispose: (() => void) | null = null;
  const ensureTerminalTap = () => {
    if (terminalTapDispose) return;
    terminalTapDispose = subscribeTerminalLines((line) => {
      if (terminalSubscribers.size === 0) return;
      const raw = JSON.stringify({ type: 'terminal_lines', mode: 'append', lines: [line] });
      for (const ws of terminalSubscribers) {
        if (ws.readyState === ws.OPEN) {
          try { ws.send(raw); } catch {}
        }
      }
    });
  };
  const releaseTerminalTap = () => {
    if (terminalSubscribers.size > 0) return;
    terminalTapDispose?.();
    terminalTapDispose = null;
  };

  function broadcastMsg(msg: WsPayload) {
    const raw = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(raw); } catch {}
      }
    }
  }

  // Fan out a pre-serialized WS frame string. The waveform worker builds these
  // (peaks → JSON, artwork → base64+JSON) so the broadcast paths do zero CPU
  // work — keeps the Art-Net poll pump on schedule across track changes.
  function broadcastFrame(raw: string) {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(raw); } catch {}
      }
    }
  }

  function broadcastWaveformStatus(deck: DeckNumber, stage: WaveformStatusPayload['stage'], progress: number, fileName: string) {
    broadcastMsg({ type: 'waveform_status', deck, stage, progress, fileName });
  }

  function broadcastWaveformFrame(fileName: string) {
    const raw = peaksFrameCache.get(fileName);
    if (raw) broadcastFrame(raw);
  }

  function broadcastArtworkFrame(fileName: string) {
    const raw = artworkFrameCache.get(fileName);
    if (raw) broadcastFrame(raw);
  }

  const connectWithRetry = async () => {
    while (true) {
      try {
        logLifecycle('StageLinq: joining network, waiting for devices...');
        await bridge.connect();
        logLifecycle(`${GRN}StageLinq: listening for devices.${RST}`);
        return;
      } catch (e: any) {
        const msg = e?.message || String(e);
        logError('StageLinq connect failed:', msg);
        await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      }
    }
  };

  bridge = new StageLinqBridge({
    downloadDbSources: false,
    onDeviceIp: (ip) => {
      logLifecycle(`[StageLinq] Device IP detected: ${ip}`);
    },
    onCommunicationLost: async () => {
      if (reconnecting) return;
      reconnecting = true;
      logLifecycle(`${RED}[StageLinq] Communication lost — reconnecting...${RST}`);
      try { await bridge.disconnect(); } catch {}
      await connectWithRetry();
      reconnecting = false;
    },
    onTrackChanged: (deck, fileName, rawNetworkPath) => {
      const t0 = Date.now();
      // Notify the replay engine first so it can attach/detach before any heavy I/O.
      replay.onTrackChanged(deck, fileName);
      // Mapped backup-audio files are large and useless to scan — skip waveform/artwork.
      if (replay.shouldSuppressWaveformExtraction(fileName)) {
        logLifecycle(`[REPLAY] suppressing waveform extraction for mapped file "${fileName}"`);
        return;
      }
      logLifecycle(`[WAVEFORM] onTrackChanged deck=${deck} file="${fileName}" inPlaylist=${activePlaylistFiles.has(fileName)}`);
      if (!waveformAllTracks && !activePlaylistFiles.has(fileName)) return;

      const havePeaksFrame = peaksFrameCache.has(fileName);
      const haveArtworkFrame = artworkFrameCache.has(fileName);

      if (havePeaksFrame && haveArtworkFrame) {
        // Pure cache hit — frames are pre-serialized in the worker, broadcast is
        // just a string lookup + ws.send fanout. Defer past the current microtask
        // so the Art-Net poll pump can fire in between.
        setImmediate(() => broadcastWaveformFrame(fileName));
        setImmediate(() => broadcastArtworkFrame(fileName));
        logLifecycle(`[WAVEFORM] track-change deck=${deck} cache-hit (peaks+artwork) total=${Date.now() - t0}ms`);
        return;
      }

      // Cache miss for at least one of the two. Download once and ask the
      // worker to extract whatever's missing — the audio bytes are transferred
      // (zero-copy) into the worker; main thread does no ffmpeg / JSON work.
      const taskId = ++waveformTaskIds[deck];
      logWaveform(`[WAVEFORM] Deck ${deck}: queuing "${fileName}" peaksOnly=${havePeaksFrame ? false : true} (artworkOnly=${havePeaksFrame})`);

      (async () => {
        try {
          if (!havePeaksFrame) broadcastWaveformStatus(deck, 'downloading', 0, fileName);
          const tDlStart = Date.now();
          const audioBytes = await bridge.downloadFile(rawNetworkPath, (pct) => {
            if (waveformTaskIds[deck] !== taskId) return;
            if (!havePeaksFrame) broadcastWaveformStatus(deck, 'downloading', pct, fileName);
          });
          const tDlDone = Date.now();

          if (waveformTaskIds[deck] !== taskId) {
            // Stale — but the worker will still finish and populate the cache for
            // a future load of the same file. Nothing to clean up here.
            return;
          }
          if (!havePeaksFrame) broadcastWaveformStatus(deck, 'generating', 0, fileName);

          await requestExtraction(
            fileName,
            bridge.getDeck(deck).totalSec,
            audioBytes,
            havePeaksFrame, // artworkOnly
            (stage, progress) => {
              if (waveformTaskIds[deck] !== taskId) return;
              if (stage === 'generating' && !havePeaksFrame) {
                broadcastWaveformStatus(deck, 'generating', progress, fileName);
              }
            },
          );
          const tFfDone = Date.now();

          if (waveformTaskIds[deck] !== taskId) return;
          // setImmediate keeps consistency with the cache-hit path — broadcast lands
          // in the next I/O phase, not this microtask tail.
          if (!havePeaksFrame) setImmediate(() => broadcastWaveformFrame(fileName));
          setImmediate(() => broadcastArtworkFrame(fileName));
          logLifecycle(
            `[WAVEFORM] track-change deck=${deck} download=${tDlDone - tDlStart}ms ` +
            `extract=${tFfDone - tDlDone}ms total=${tFfDone - t0}ms`
          );
        } catch (e: any) {
          if (waveformTaskIds[deck] !== taskId) return;
          logError(`[WAVEFORM] Deck ${deck} failed:`, e?.message || e);
          if (!havePeaksFrame) broadcastWaveformStatus(deck, 'error', 0, fileName);
        }
      })();
    },
  });
  const require = createRequire(import.meta.url);

  recorder = new Recorder({
    bridge,
    recordingsDir,
    getTrackOffsets: () => {
      const obj: Record<string, { offsetSec: number; offsetFrame: number }> = {};
      for (const [k, v] of trackOffsets) obj[k] = v;
      return obj;
    },
    getPlaylistRef: () => `current_playlist=${config?.current_playlist ?? -1}`,
    isReplayActive: () => replay.isActive(),
    getStatus: () => stagelinqStatusForApi(),
  });

  const stateProvider = makeStateProvider({
    bridge,
    replay,
    disconnectTimeoutSec: DISCONNECT_DETECT_TIMEOUT_S,
  });

  const artnet = new ArtNetTimecodeBroadcaster({
    enabled: artnetEnabled,
    targetIps: artnetTargetIps,
    port: artnetPort,
    fps: artnetFps,
    sendHz: artnetSendHz,
    fpsType: artnetFpsType,
    streamId: artnetStreamId,
    deck: artnetDeck,
    latencyCompMs: artnetLatencyCompMs,
    enableFreewheeling: initialFw.enable_freewheeling,
    freewheelMaxDurationSec: initialFw.max_duration_sec,
  });

  let oscBpm: OscBpmSender | null = null;

  let selectedDeck: DeckNumber | null = null;
  const setSelectedDeck = (nextDeck: DeckNumber | null, reason: string) => {
    if (nextDeck === selectedDeck) return;
    selectedDeck = nextDeck;
    logLifecycle(`[DECK SELECT] ${selectedDeck ? `Deck ${selectedDeck}` : 'No deck selected'} (${reason})`);
    recorder?.recordSelected(selectedDeck);
  };

  // Latest auto-suggested deck. Updated each snapshot tick by the broadcast
  // loop. Read by the sACN execute-channel rising-edge handler to decide
  // which `sugDeck_<n>` OSC command to fire on operator confirmation.
  let currentSuggestedDeck: DeckNumber | null = null;

  // Control input from config (currently sACN mode supported).
  if (controlMode === 'sacn') {
    try {
      const sacn: any = require('sacn');
      const Receiver = sacn?.Receiver ?? sacn?.default?.Receiver;
      if (Receiver) {
        const sACN = new Receiver({ universes: [sacnUniverse] });
        // Rising-edge tracker for the execute channel. Initialized true so a
        // packet that arrives already-high (re-subscribe mid-show, console
        // sitting on >127) does NOT count as a fresh edge.
        let lastExecuteHigh = true;

        sACN.on('packet', (packet: any) => {
          const payload = coerceDmxPayload(packet);
          // logLifecycle(`[sACN] Payload U${sacnUniverse} slots=${Math.max(0, payload.length - 1)}:`, payload);

          // sacn payload is usually 1-based (channel 1 at index 1). We also tolerate 0-based arrays.
          const dmxValue = Number(
            payload[controlAddress] ?? payload[controlChannelIndex]
          );
          if (Number.isFinite(dmxValue)) {
            const absoluteDmxValue = toAbsoluteDmxValue(dmxValue);
            const nextDeck = mapDmxToDeck(absoluteDmxValue);
            setSelectedDeck(nextDeck, `sACN U${sacnUniverse} CH${controlAddress}=${dmxValue} (abs ${absoluteDmxValue})`);
          }

          // Execute-suggestion channel: rising edge >127 fires the OSC
          // `sugDeck_<n>` for the currently displayed suggestion. Held-high
          // does nothing until the value drops back under 127 and rises
          // again, so a stuck fader cannot spam the lighting console.
          const execRaw = Number(payload[executeAddress] ?? payload[executeChannelIndex]);
          if (Number.isFinite(execRaw)) {
            const execAbs = toAbsoluteDmxValue(execRaw);
            const isHigh = execAbs > 127;
            if (isHigh && !lastExecuteHigh) {
              if (currentSuggestedDeck !== null) {
                logLifecycle(`[DECK SUGGEST] Execute CH${executeAddress}=${execRaw} (abs ${execAbs}) -> sugDeck_${currentSuggestedDeck}`);
                oscBpm?.sendCustomCommand(`sugDeck_${currentSuggestedDeck}`);
                recorder?.recordSacnExecute(currentSuggestedDeck);
              } else {
                logLifecycle(`[DECK SUGGEST] Execute CH${executeAddress} rising edge ignored — no active suggestion`);
              }
            }
            lastExecuteHigh = isHigh;
          }
        });

        sACN.on('PacketCorruption', (err: any) => {
          logError('[sACN] PacketCorruption:', err?.message || err);
        });

        sACN.on('PacketOutOfOrder', (err: any) => {
          logError('[sACN] PacketOutOfOrder:', err?.message || err);
        });

        sACN.on('error', (err: any) => {
          logError('[sACN] Receiver error:', err?.message || err);
        });

        process.once('SIGINT', () => {
          oscBpm?.stop();
          try { sACN.close(); } catch {}
          try { sacnSender?.close(); } catch {}
          // Fire-and-forget — worker_threads are killed with the parent anyway,
          // but the explicit shutdown lets the worker flush its 50 ms drain.
          void shutdownWaveformWorker();
          process.exit(0);
        });
        process.once('SIGTERM', () => {
          oscBpm?.stop();
          try { sACN.close(); } catch {}
          try { sacnSender?.close(); } catch {}
          void shutdownWaveformWorker();
          process.exit(0);
        });

        logLifecycle(`[sACN] Listening Universe ${sacnUniverse}, Address ${controlAddress} (select), Address ${executeAddress} (execute suggestion)`);
      } else {
        logError('[sACN] Receiver export not found. Deck select via sACN is disabled.');
      }
    } catch (e: any) {
      logError('[sACN] Failed to initialize receiver:', e?.message || e);
    }
  } else {
    setSelectedDeck(artnetDeck, `mode=${controlMode}`);
    logLifecycle(`[CONTROL] mode=${controlMode} not implemented, using fixed deck ${selectedDeck}.`);
  }

  await new Promise<void>((resolve) => {
    server.listen(PORT, '0.0.0.0', () => {
      const ips = getLocalIpv4Addresses();
      if (ips.length === 0) {
        uiUrls = [`http://localhost:${PORT}/`];
        logLifecycle(`Web UI: http://localhost:${PORT}/`);
        logLifecycle(`WS: ws://localhost:${PORT}/ws`);
      } else {
        for (const ip of ips) {
          uiUrls.push(`http://${ip}:${PORT}/`);
          logLifecycle(`Web UI: http://${ip}:${PORT}/`);
          logLifecycle(`WS: ws://${ip}:${PORT}/ws`);
          if (sacnSimEnabled) logLifecycle(`sACN Sim: http://${ip}:${PORT}/sacn-sim`);
        }
      }
      resolve();
    });
  });

  // Initial connect (retries indefinitely with RECONNECT_DELAY_MS between attempts)
  void connectWithRetry();

  if (oscEnabled && !oscBpm) {
    oscBpm = new OscBpmSender({
      enabled: oscEnabled,
      targetIps: oscTargetIps,
      targetPort: oscTargetPort,
      speedMaster: oscSpeedMaster,
    });
    logLifecycle(`[OSC] BPM -> ${oscTargetIps.join(', ')}:${oscTargetPort} (SpeedMaster ${oscSpeedMaster})`);
  }

  // ── Freewheel-flap detector ────────────────────────────────────────────────
  // Tracks short on→off cycles. If freewheel toggled on and back off in
  // ≤ FREEWHEEL_FLAP_SHORT_CYCLE_MAX_MS, that cycle is "short". When we see
  // ≥ FREEWHEEL_FLAP_MIN_CYCLES short cycles inside a rolling
  // FREEWHEEL_FLAP_WINDOW_MS span, the threshold is almost certainly too low —
  // healthy networks shouldn't engage freewheel multiple times per 10 s. We
  // emit one warn (rate-limited by FREEWHEEL_FLAP_LOG_COOLDOWN_MS) and append
  // every recent beat-gap that crossed the configured threshold so the operator
  // can see exactly which gaps tripped it.
  let freewheelOnAtMs: number | null = null;
  const shortCycleEndsMs: number[] = [];
  let lastFlapWarnMs = 0;
  artnet.onFreewheelChange((active) => {
    const now = Date.now();
    if (active) {
      freewheelOnAtMs = now;
      return;
    }
    if (freewheelOnAtMs == null) return; // off→off, nothing to record
    const onDurationMs = now - freewheelOnAtMs;
    freewheelOnAtMs = null;
    if (onDurationMs > FREEWHEEL_FLAP_SHORT_CYCLE_MAX_MS) return;
    shortCycleEndsMs.push(now);
    // Drop entries that fell out of the rolling window.
    const windowStart = now - FREEWHEEL_FLAP_WINDOW_MS;
    while (shortCycleEndsMs.length > 0 && shortCycleEndsMs[0] < windowStart) {
      shortCycleEndsMs.shift();
    }
    if (shortCycleEndsMs.length < FREEWHEEL_FLAP_MIN_CYCLES) return;
    if (now - lastFlapWarnMs < FREEWHEEL_FLAP_LOG_COOLDOWN_MS) return;
    lastFlapWarnMs = now;
    const gaps = getRecentOverThresholdGaps(FREEWHEEL_STALE_THRESHOLD_MS, windowStart);
    const gapsStr = gaps.length > 0
      ? gaps.map((g) => `${g.toFixed(0)}ms`).join(', ')
      : '<none captured>';
    logWarn(
      `[ArtNet] Freewheel flap: ${shortCycleEndsMs.length} short on/off cycles ` +
      `in ${(FREEWHEEL_FLAP_WINDOW_MS / 1000).toFixed(0)}s ` +
      `(threshold ${FREEWHEEL_STALE_THRESHOLD_MS}ms may be too low). ` +
      `Triggering beat-gaps: [${gapsStr}]`,
    );
  });

  await artnet.start(() => {
    // Freewheel uses its own short threshold (FREEWHEEL_STALE_THRESHOLD_MS, ~250 ms),
    // independent of the longer DISCONNECT_DETECT_TIMEOUT_S that gates the UI badge and
    // bridge reconnect. The lighting console can't tolerate even a one-second TC stall
    // before catching up — typical beat gaps are 50–200 ms, so anything past one missed
    // beat is already audible drift on the receiver. The 2-second threshold is still
    // correct for "is the device gone, time to reconnect"; this is "is the next beat
    // overdue, freewheel now". Both `reconnecting` and the per-stall window also force it.
    // During replay, stateProvider returns 0 for getLastBeatAgeMs() so freewheel disengages.
    const stale = reconnecting || stateProvider.getLastBeatAgeMs() > FREEWHEEL_STALE_THRESHOLD_MS;

    if (!selectedDeck) return { deck: undefined, stale };

    const deck = stateProvider.getDeck(selectedDeck);
    if (Number(deck.elapsedSec) <= 0) return { deck: undefined, stale };

    const fileKey = normalizeTrackName(deck.fileName || '');
    const offset = trackOffsets.get(fileKey);
    if (!offset) return { deck, stale };

    const offsetSec = offset.offsetSec + offset.offsetFrame / artnetFps;
    return {
      deck: {
        ...deck,
        elapsedSec: Math.max(0, deck.elapsedSec + offsetSec),
        totalSec: Math.max(0, deck.totalSec + offsetSec),
      },
      stale,
    };
  });


  wss.on('connection', (ws) => {
    clients.add(ws);

    ws.on('error', () => {
      clients.delete(ws);
      if (terminalSubscribers.delete(ws)) releaseTerminalTap();
    });

    ws.on('message', (raw) => {
      let parsed: any;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.type === 'terminal_subscribe') {
        if (parsed.enabled === true) {
          ensureTerminalTap();
          terminalSubscribers.add(ws);
          // Seed the panel with the recent ring so the user sees context, not
          // just whatever happens to land after they open the panel.
          const seed = getTerminalRing().slice();
          try {
            ws.send(JSON.stringify({ type: 'terminal_lines', mode: 'replace', lines: seed }));
          } catch {}
        } else {
          if (terminalSubscribers.delete(ws)) releaseTerminalTap();
        }
      }
    });

    const hello: WsPayload = { type: 'hello', ts: Date.now(), version: '0.1.0', fps: WS_FPS };
    try { ws.send(JSON.stringify(hello)); } catch {}

    // Replay any cached waveforms and artwork for currently loaded decks. Both
    // frames are pre-serialized in the worker, so this loop does no JSON or
    // base64 work — pure string lookup + ws.send.
    const currentDecks = stateProvider.getDecks();
    const sentFiles = new Set<string>();
    for (const [, deckState] of Object.entries(currentDecks)) {
      const fn = deckState.fileName;
      if (!fn || sentFiles.has(fn)) continue;
      sentFiles.add(fn);
      const peaksFrame = peaksFrameCache.get(fn);
      if (peaksFrame) {
        try { ws.send(peaksFrame); } catch {}
      }
      const artworkFrame = artworkFrameCache.get(fn);
      if (artworkFrame) {
        try { ws.send(artworkFrame); } catch {}
      }
    }

    ws.on('close', () => {
      clients.delete(ws);
      if (terminalSubscribers.delete(ws)) releaseTerminalTap();
    });
  });

  // --- UI snapshot logging (only when meaningful fields change) ---
  let lastComparable = '';

  function makeComparableSnapshot(p: SnapshotPayload) {
    // strip volatile fields so we don't log at 30Hz for timestamps, seq, etc.
    const decks: any = {};
    for (const [k, v] of Object.entries(p.decks)) {
      const d: any = { ...(v as any) };
      delete d.updatedAt;

      // elapsedSec changes continuously -> uncomment to include it in change detection
      delete d.elapsedSec;

      decks[k] = d;
    }

    return {
      type: p.type,
      decks,
    };
  }


  // Broadcast snapshots at 30Hz
  const intervalMs = Math.round(1000 / WS_FPS);
  let lastBroadcastWarnAt = 0;
  // Tracks the last suggestion we logged so we surface only edges in the
  // log (the actual OSC dispatch is gated by the sACN execute channel).
  let lastSuggestedDeck: DeckNumber | null = null;
  setInterval(() => {
    const decks = stateProvider.getDecks();

    if (selectedDeck && oscBpm) {
      oscBpm.sendDeckBpm(decks[selectedDeck]);
    }

    const deckNotes: Record<DeckNumber, TrackNote | null> = { 1: null, 2: null, 3: null, 4: null };
    for (const d of [1, 2, 3, 4] as DeckNumber[]) {
      const fn = decks[d]?.fileName;
      if (!decks[d]?.trackLoaded || !fn) continue;
      const found = trackNotes.get(normalizeTrackName(fn));
      if (found) deckNotes[d] = found;
    }

    const suggestedDeck = computeSuggestedDeck(config, decks, selectedDeck);
    // Publish to the closure so the sACN execute-channel handler can read
    // the latest suggestion when the lighting console fires the rising edge.
    currentSuggestedDeck = suggestedDeck;

    // Log suggestion edges only — OSC dispatch is no longer automatic; the
    // operator confirms via sACN CH3 (see sACN packet handler).
    if (suggestedDeck !== lastSuggestedDeck) {
      let reason: string | null = null;
      if (suggestedDeck !== null) {
        reason =
          decks[suggestedDeck].play
            ? 'next-track deck playing'
            : 'selected deck stopped, next track pre-loaded';
        logLifecycle(`[DECK SUGGEST] Deck ${suggestedDeck} (${reason})`);
      } else {
        logLifecycle(`[DECK SUGGEST] cleared`);
      }
      recorder?.recordSuggested(suggestedDeck, reason);
      lastSuggestedDeck = suggestedDeck;
    }

    const status = stateProvider.getStatus(reconnecting);
    if (status !== lastReportedStatus) {
      lastReportedStatus = status;
      recorder.recordStatus(status);
    }

    const payload: SnapshotPayload = {
      type: 'snapshot',
      seq: ++seq,
      ts: Date.now(),
      decks,
      selectedDeck,
      suggestedDeck,
      nextTrack: computeNextTrack(config, selectedDeck ? decks[selectedDeck].fileName : null),
      stagelinqStatus: status,
      freewheelActive: artnet.isFreewheelActive(),
      deckNotes,
      recordingStatus: recorder.getStatus(),
      replayStatus: replay.getStatus(),
    };

    // Log only when meaningful values changed
    const comparableStr = JSON.stringify(makeComparableSnapshot(payload));
    if (comparableStr !== lastComparable) {
      lastComparable = comparableStr;
      logUiOut('[UI OUT]', JSON.stringify(payload));
    }

    broadcastMsg(payload);
    const broadcastCostMs = Date.now() - payload.ts;
    if (broadcastCostMs > WS_BROADCAST_WARN_MS && Date.now() - lastBroadcastWarnAt > 1000) {
      lastBroadcastWarnAt = Date.now();
      logError(`[main] WS broadcast slow: ${broadcastCostMs}ms (clients=${clients.size})`);
    }

    // Build multi-line dashboard
    const deckNums: DeckNumber[] = [1, 2, 3, 4];
    const col = (n: number, s: string) => deckColor(n, s);
    const pad = (s: string, w: number) => s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);

    const header = deckNums.map(n =>
      col(n, pad(`── Deck ${n} ──────────────────────`, 34))
    ).join('');

    const titleRow = deckNums.map(n => {
      const d = decks[n];
      if (!d.trackLoaded) return col(n, pad('(empty)', 34));
      const icon = d.play ? '▶' : '⏸';
      const title = pad(d.title || d.fileName || '?', 31);
      return col(n, `${icon} ${title} `);
    }).join('');

    const artistRow = deckNums.map(n => {
      const d = decks[n];
      return col(n, pad(d.trackLoaded ? (d.artist || '') : '', 34));
    }).join('');

    const bpmRow = deckNums.map(n => {
      const d = decks[n];
      const bpm  = d.currentBpm  > 0 ? d.currentBpm.toFixed(2)  : '--';
      const tbpm = d.trackBpm    > 0 ? d.trackBpm.toFixed(2)    : '--';
      const spd  = d.speedState !== 0 ? `${d.speedState > 0 ? '+' : ''}${d.speedState.toFixed(2)}%` : '±0%';
      return pad(`BPM ${bpm}  track ${tbpm}  ${spd}`, 34);
    }).join('');

    const keyRow = deckNums.map(n => {
      const d = decks[n];
      const key = d.keyCamelot || (d.keyIndex != null ? `#${d.keyIndex}` : '--');
      const fader = `fader ${(d.fader * 100).toFixed(0)}%`;
      const elapsed = d.elapsedSec > 0
        ? `${Math.floor(d.elapsedSec / 60)}:${String(Math.floor(d.elapsedSec % 60)).padStart(2, '0')}`
        : '--:--';
      const total = d.totalSec > 0
        ? `${Math.floor(d.totalSec / 60)}:${String(Math.floor(d.totalSec % 60)).padStart(2, '0')}`
        : '--:--';
      return pad(`key ${key}  ${fader}  ${elapsed}/${total}`, 34);
    }).join('');

    const deckSel = selectedDeck ? col(selectedDeck, `Deck ${selectedDeck} selected`) : `${DIM}no deck selected${R}`;
    const oscSlot = getStatusSlot('osc');
    const artnetSlot = DISPLAY_ENABLED.artnet ? getStatusSlot('artnet') : '';
    const spinner = SPINNER[Math.floor(spinnerFrame++ / 4) % SPINNER.length];
    const oscStatus = selectedDeck
      ? (oscSlot || `${DIM}OSC idle${R}`)
      : `${spinner} waiting for sACN deck select`;
    const statusRow = [deckSel, artnetSlot, oscStatus].filter(Boolean).join('  |  ');

    const lines: string[] = [header, titleRow, artistRow, bpmRow, keyRow, statusRow];

    if (DISPLAY_ENABLED.info) {
      const tcInfo = artnetEnabled
        ? `ArtNet ${artnetTargetIps.join(',')}:${artnetPort} ${artnetFps}fps`
        : `${DIM}ArtNet disabled${R}`;
      const oscInfo = oscEnabled
        ? `OSC ${oscTargetIps.join(',')}:${oscTargetPort} SM${oscSpeedMaster}`
        : `${DIM}OSC disabled${R}`;
      const urlParts = uiUrls.length > 0 ? uiUrls.map(u => `UI ${u}`) : ['starting...'];
      if (sacnSimEnabled && uiUrls.length > 0) urlParts.push(`sACN-sim ${uiUrls[0].replace(/\/$/, '')}/sacn-sim`);
      lines.push(`${DIM}${tcInfo}  ${oscInfo}  ${urlParts.join('  ')}${R}`);
    }

    logDashboard(lines);
  }, intervalMs);



}

main().catch((e) => {
  logError('Fatal:', e?.message || e);
  process.exit(1);
});
