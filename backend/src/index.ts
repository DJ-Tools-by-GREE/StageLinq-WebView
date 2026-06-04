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
import { StageLinqBridge } from './stagelinqBridge.js';
import type { DeckNumber, SnapshotPayload, WaveformStatusPayload, WsPayload } from './types.js';
import { ArtNetTimecodeBroadcaster } from './artnetTimecode.js';
import { OscBpmSender } from './oscBpm.js';
import { RECONNECT_DELAY_MS, WS_FPS, WAVEFORM_PEAKS_PER_SEC, DISCONNECT_DETECT_TIMEOUT_S } from './constants.js';
import { States, StageLinqValue } from "@gree44/stagelinq";
import { logError, logLifecycle, logWaveform, logUiOut, applyLoggingConfig, applyDisplayConfig, DISPLAY_ENABLED, logDashboard, deckColor, getStatusSlot, DIM, R, GRN, YEL, RED, RST } from './logging.js';
import { generateWaveformPeaks, peaksCache, artworkCache, initWaveformCache } from './waveformService.js';

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
}

interface RootConfig {
  current_playlist?: number;
  timecode?: {
    fps?: number;
    target_ip?: string;
    target_port?: number;
    stream_id?: number;
  };
  control_input?: {
    mode?: string;
    universe?: number;
    address?: number;
  };
  osc?: {
    enabled?: boolean;
    target_ip?: string;
    target_port?: number;
    speedmaster?: number;
  };
  sacn_sim?: { enabled?: boolean };
  waveform?: { all_tracks?: boolean };
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
  };
  display?: {
    dashboard?: boolean;
    artnet?: boolean;
    info?: boolean;
  };
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

async function loadRootConfig(): Promise<RootConfig | null> {
  const candidates = [
    path.resolve(process.cwd(), 'config.json'),
    path.resolve(__dirname, '../../config.json'),
  ];

  for (const filePath of candidates) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(stripJsonComments(raw)) as RootConfig;
      logLifecycle(`${GRN}[CONFIG] Loaded ${filePath}${RST}`);
      return parsed;
    } catch {
      // try next candidate
    }
  }

  logLifecycle(`${RED}[CONFIG] No config.json found, using env/default values.${RST}`);
  return null;
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
    const key = normalizeTrackName(String(item.song_index ?? ''));
    if (key) set.add(key);
  }
  return set;
}

function computeNextTrack(cfg: RootConfig | null, currentFileName: string | null): string | null {
  const playlists = cfg?.playlists ?? [];
  const idx = Number(cfg?.current_playlist ?? -1);
  if (idx < 0 || idx >= playlists.length) return null;
  const content = playlists[idx].content ?? [];
  if (!currentFileName) return content[0]?.song_index ?? null;
  const key = normalizeTrackName(currentFileName);
  const pos = content.findIndex((item) => normalizeTrackName(String(item.song_index ?? '')) === key);
  if (pos < 0 || pos + 1 >= content.length) return null;
  return content[pos + 1].song_index ?? null;
}

function mapDmxToDeck(value: number): DeckNumber | null {
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

async function main() {
  let config = await loadRootConfig();
  if (config?.logging) applyLoggingConfig(config.logging);
  if (config?.display) applyDisplayConfig(config.display);
  let sendTimecodeWhenStopped = false;

  await initWaveformCache(process.cwd());

  // Art-Net settings from root config.json (env vars override).
  const artnetEnabled = (process.env.ARTNET_ENABLED ?? 'true').toLowerCase() !== 'false';
  const artnetTargetIp = process.env.ARTNET_TARGET_IP ?? config?.timecode?.target_ip ?? '255.255.255.255';
  const artnetPort = Number(process.env.ARTNET_PORT ?? config?.timecode?.target_port ?? 6454);
  const artnetDeck = (Number(process.env.ARTNET_DECK ?? 1) as 1 | 2 | 3 | 4);
  const artnetFps = Number(process.env.ARTNET_FPS ?? config?.timecode?.fps ?? 30);
  const artnetSendHz = Number(process.env.ARTNET_SEND_HZ ?? artnetFps);
  const artnetFpsType = 0x03;
  const artnetLatencyCompMs = Number(process.env.ARTNET_LATENCY_COMP_MS ?? 80);
  const artnetStreamId = Number(process.env.ARTNET_STREAM_ID ?? config?.timecode?.stream_id ?? 0x00);

  const oscEnabled = (process.env.OSC_ENABLED ?? String(config?.osc?.enabled ?? false)).toLowerCase() === 'true';
  const oscTargetIp = process.env.OSC_TARGET_IP ?? config?.osc?.target_ip ?? '127.0.0.1';
  const oscTargetPort = Number(process.env.OSC_TARGET_PORT ?? config?.osc?.target_port ?? 8000);
  const oscSpeedMaster = Number(process.env.OSC_SPEEDMASTER ?? config?.osc?.speedmaster ?? 15);

  // Control-input settings from root config.json (env vars override).
  const controlMode = String(process.env.CONTROL_INPUT_MODE ?? config?.control_input?.mode ?? 'sacn').toLowerCase();
  const sacnUniverse = Number(process.env.SACN_UNIVERSE ?? config?.control_input?.universe ?? 20);
  const controlAddress = Number(process.env.SACN_ADDRESS ?? config?.control_input?.address ?? 1);
  const sacnSimEnabled = (process.env.SACN_SIM === '1') || (config?.sacn_sim?.enabled === true);
  const controlChannelIndex = Math.max(0, controlAddress - 1);

  let trackOffsets = buildTrackOffsetMap(config);
  let activePlaylistFiles = buildActivePlaylistFileSet(config);
  let waveformAllTracks = config?.waveform?.all_tracks ?? true;

  let reloadInProgress = false;
  const reloadConfig = async () => {
    if (reloadInProgress) return;
    reloadInProgress = true;
    try {
      const next = await loadRootConfig();
      config = next;
      if (config?.logging) applyLoggingConfig(config.logging);
      if (config?.display) applyDisplayConfig(config.display);
      trackOffsets = buildTrackOffsetMap(config);
      activePlaylistFiles = buildActivePlaylistFileSet(config);
      waveformAllTracks = config?.waveform?.all_tracks ?? true;
      logLifecycle(`${GRN}[CONFIG] Reloaded. Offset entries: ${trackOffsets.size}${RST}`);
    } catch (e: any) {
      logError('[CONFIG] Reload failed:', e?.message || e);
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

  // API health
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  app.get('/api/timecode/send-when-stopped', (_req, res) => {
    res.json({ enabled: sendTimecodeWhenStopped });
  });

  app.post('/api/timecode/send-when-stopped', (req, res) => {
    const enabled = req?.body?.enabled === true;
    sendTimecodeWhenStopped = enabled;
    artnet.setSendWhenStopped(enabled);
    res.json({ ok: true, enabled: sendTimecodeWhenStopped });
  });

  app.get('/api/artwork/:deck', (req, res) => {
    const deck = Number(req.params.deck) as DeckNumber;
    const fileName = bridge.getDeck(deck)?.fileName;
    if (!fileName) { res.status(404).end(); return; }
    const entry = artworkCache.get(fileName);
    if (!entry) { res.status(404).end(); return; }
    res.setHeader('Content-Type', entry.mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(entry.data);
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

  let seq = 0;
  let uiUrls: string[] = [];
  let spinnerFrame = 0;
  const SPINNER = ['⡿', '⣟', '⣯', '⣷', '⣾', '⣽', '⣻', '⢿'];
  const clients = new Set<any>();
  const waveformTaskIds: Record<DeckNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };

  function broadcastMsg(msg: WsPayload) {
    const raw = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(raw); } catch {}
      }
    }
  }

  function broadcastWaveformStatus(deck: DeckNumber, stage: WaveformStatusPayload['stage'], progress: number, fileName: string) {
    broadcastMsg({ type: 'waveform_status', deck, stage, progress, fileName });
  }

  function broadcastWaveformData(deck: DeckNumber, fileName: string, peaks: number[]) {
    broadcastMsg({ type: 'waveform_data', deck, fileName, peaks, peaksPerSec: WAVEFORM_PEAKS_PER_SEC });
  }

  function broadcastArtwork(fileName: string) {
    const entry = artworkCache.get(fileName);
    if (entry === undefined) return;
    broadcastMsg({
      type: 'artwork_data',
      fileName,
      data: entry ? entry.data.toString('base64') : null,
      mime: entry ? entry.mime : null,
    });
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
      logLifecycle(`[WAVEFORM] onTrackChanged deck=${deck} file="${fileName}" inPlaylist=${activePlaylistFiles.has(fileName)}`);
      if (!waveformAllTracks && !activePlaylistFiles.has(fileName)) return;
      if (peaksCache.has(fileName)) {
        broadcastWaveformData(deck, fileName, peaksCache.get(fileName)!);
        if (artworkCache.has(fileName)) {
          broadcastArtwork(fileName);
          return;
        }
        // Peaks are cached but artwork was never persisted — re-download to extract artwork only.
        const taskId = ++waveformTaskIds[deck];
        (async () => {
          try {
            const audioBytes = await bridge.downloadFile(rawNetworkPath, () => {});
            if (waveformTaskIds[deck] !== taskId) return;
            await generateWaveformPeaks(audioBytes, fileName, bridge.getDeck(deck).totalSec, () => {}, () => {});
            if (waveformTaskIds[deck] !== taskId) return;
            broadcastArtwork(fileName);
          } catch {}
        })();
        return;
      }

      const taskId = ++waveformTaskIds[deck];
      logWaveform(`[WAVEFORM] Deck ${deck}: queuing "${fileName}"`);

      (async () => {
        try {
          broadcastWaveformStatus(deck, 'downloading', 0, fileName);
          const audioBytes = await bridge.downloadFile(rawNetworkPath, (pct) => {
            if (waveformTaskIds[deck] !== taskId) return;
            broadcastWaveformStatus(deck, 'downloading', pct, fileName);
          });

          if (waveformTaskIds[deck] !== taskId) return;
          broadcastWaveformStatus(deck, 'generating', 0, fileName);

          const peaks = await generateWaveformPeaks(
            audioBytes,
            fileName,
            bridge.getDeck(deck).totalSec,
            () => {},
            (pct) => {
              if (waveformTaskIds[deck] !== taskId) return;
              broadcastWaveformStatus(deck, 'generating', pct, fileName);
            },
          );

          if (waveformTaskIds[deck] !== taskId) return;
          logWaveform(`[WAVEFORM] Deck ${deck}: ready, ${peaks.length} peaks`);
          broadcastWaveformData(deck, fileName, peaks);
          broadcastArtwork(fileName);
        } catch (e: any) {
          if (waveformTaskIds[deck] !== taskId) return;
          logError(`[WAVEFORM] Deck ${deck} failed:`, e?.message || e);
          broadcastWaveformStatus(deck, 'error', 0, fileName);
        }
      })();
    },
  });
  const require = createRequire(import.meta.url);

  const artnet = new ArtNetTimecodeBroadcaster({
    enabled: artnetEnabled,
    targetIp: artnetTargetIp,
    port: artnetPort,
    fps: artnetFps,
    sendHz: artnetSendHz,
    fpsType: artnetFpsType,
    streamId: artnetStreamId,
    deck: artnetDeck,
    latencyCompMs: artnetLatencyCompMs,
    sendWhenStopped: sendTimecodeWhenStopped,
  });

  let oscBpm: OscBpmSender | null = null;

  let selectedDeck: DeckNumber | null = null;
  const setSelectedDeck = (nextDeck: DeckNumber | null, reason: string) => {
    if (nextDeck === selectedDeck) return;
    selectedDeck = nextDeck;
    logLifecycle(`[DECK SELECT] ${selectedDeck ? `Deck ${selectedDeck}` : 'No deck selected'} (${reason})`);
  };

  // Control input from config (currently sACN mode supported).
  if (controlMode === 'sacn') {
    try {
      const sacn: any = require('sacn');
      const Receiver = sacn?.Receiver ?? sacn?.default?.Receiver;
      if (Receiver) {
        const sACN = new Receiver({ universes: [sacnUniverse] });

        sACN.on('packet', (packet: any) => {
          const payload = coerceDmxPayload(packet);
          // logLifecycle(`[sACN] Payload U${sacnUniverse} slots=${Math.max(0, payload.length - 1)}:`, payload);

          // sacn payload is usually 1-based (channel 1 at index 1). We also tolerate 0-based arrays.
          const dmxValue = Number(
            payload[controlAddress] ?? payload[controlChannelIndex]
          );
          if (!Number.isFinite(dmxValue)) return;

          const absoluteDmxValue = toAbsoluteDmxValue(dmxValue);

          const nextDeck = mapDmxToDeck(absoluteDmxValue);
          setSelectedDeck(nextDeck, `sACN U${sacnUniverse} CH${controlAddress}=${dmxValue} (abs ${absoluteDmxValue})`);
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
          process.exit(0);
        });
        process.once('SIGTERM', () => {
          oscBpm?.stop();
          try { sACN.close(); } catch {}
          try { sacnSender?.close(); } catch {}
          process.exit(0);
        });

        logLifecycle(`[sACN] Listening Universe ${sacnUniverse}, Address ${controlAddress}`);
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
      targetIp: oscTargetIp,
      targetPort: oscTargetPort,
      speedMaster: oscSpeedMaster,
    });
    logLifecycle(`[OSC] BPM -> ${oscTargetIp}:${oscTargetPort} (SpeedMaster ${oscSpeedMaster})`);
  }

  await artnet.start(() => {
    if (!selectedDeck) return undefined;

    const deck = bridge.getDeck(selectedDeck);
    if (Number(deck.elapsedSec) <= 0) return undefined;

    const fileKey = normalizeTrackName(deck.fileName || '');
    const offset = trackOffsets.get(fileKey);
    if (!offset) return deck;

    const offsetSec = offset.offsetSec + offset.offsetFrame / artnetFps;
    return {
      ...deck,
      elapsedSec: Math.max(0, deck.elapsedSec + offsetSec),
      totalSec: Math.max(0, deck.totalSec + offsetSec),
    };
  });


  wss.on('connection', (ws) => {
    clients.add(ws);

    ws.on('error', () => { clients.delete(ws); });

    const hello: WsPayload = { type: 'hello', ts: Date.now(), version: '0.1.0', fps: WS_FPS };
    try { ws.send(JSON.stringify(hello)); } catch {}

    // Replay any cached waveforms and artwork for currently loaded decks
    const currentDecks = bridge.getDecks();
    for (const [dStr, deckState] of Object.entries(currentDecks)) {
      const deck = Number(dStr) as DeckNumber;
      const fn = deckState.fileName;
      if (!fn) continue;
      if (peaksCache.has(fn)) {
        const msg: WsPayload = { type: 'waveform_data', deck, fileName: fn, peaks: peaksCache.get(fn)!, peaksPerSec: WAVEFORM_PEAKS_PER_SEC };
        try { ws.send(JSON.stringify(msg)); } catch {}
      }
      if (artworkCache.has(fn)) {
        const entry = artworkCache.get(fn)!;
        const msg: WsPayload = {
          type: 'artwork_data',
          fileName: fn,
          data: entry ? entry.data.toString('base64') : null,
          mime: entry ? entry.mime : null,
        };
        try { ws.send(JSON.stringify(msg)); } catch {}
      }
    }

    ws.on('close', () => {
      clients.delete(ws);
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
  setInterval(() => {
    const decks = bridge.getDecks();

    if (selectedDeck && oscBpm) {
      oscBpm.sendDeckBpm(decks[selectedDeck]);
    }

    const payload: SnapshotPayload = {
      type: 'snapshot',
      seq: ++seq,
      ts: Date.now(),
      decks,
      selectedDeck,
      nextTrack: computeNextTrack(config, selectedDeck ? decks[selectedDeck].fileName : null),
      stagelinqStatus: reconnecting ? 'reconnecting'
        : bridge.getLastBeatAgeMs() <= DISCONNECT_DETECT_TIMEOUT_S * 1000 ? 'connected'
        : 'no-device',
    };

    // Log only when meaningful values changed
    const comparableStr = JSON.stringify(makeComparableSnapshot(payload));
    if (comparableStr !== lastComparable) {
      lastComparable = comparableStr;
      logUiOut('[UI OUT]', JSON.stringify(payload));
    }

    broadcastMsg(payload);

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
        ? `ArtNet ${artnetTargetIp}:${artnetPort} ${artnetFps}fps`
        : `${DIM}ArtNet disabled${R}`;
      const oscInfo = oscEnabled
        ? `OSC ${oscTargetIp}:${oscTargetPort} SM${oscSpeedMaster}`
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
