import fs from 'node:fs';
import path from 'node:path';
import type { DeckNumber, DeckState, RecordingStatus, StageLinqStatus } from './types.js';
import { logError, logLifecycle } from './logging.js';
import type { StageLinqBridge } from './stagelinqBridge.js';

// JSONL log format. Every line is one event with a `t` (ms since recording start) and a `type`.
// See plan: /Users/i590073/.claude/plans/glowing-fluttering-sloth.md (or README "Record & Replay").

type DeckDiff = Partial<Omit<DeckState, 'deck'>>;

type Event =
  | { v: 1; type: 'header'; startedAt: number; trackOffsets: Record<string, { offsetSec: number; offsetFrame: number }>; playlistRef: string }
  | { t: number; type: 'deck'; n: DeckNumber; state: DeckState }
  | { t: number; type: 'deck'; n: DeckNumber; diff: DeckDiff }
  | { t: number; type: 'selected'; deck: DeckNumber | null }
  | { t: number; type: 'status'; value: StageLinqStatus }
  | { t: number; type: 'sacn_execute'; deck: DeckNumber | null }
  | { t: number; type: 'footer'; stoppedAt: number; eventCount: number };

export interface RecorderOptions {
  bridge: StageLinqBridge;
  recordingsDir: string;
  // Snapshot of currently-resolved trackOffsets, used in the header for forensics + replay.
  getTrackOffsets: () => Record<string, { offsetSec: number; offsetFrame: number }>;
  getPlaylistRef: () => string;
  // Replay-active gate so we refuse to start a recording during replay.
  isReplayActive: () => boolean;
  // Live status, polled at start() to refuse if disconnected.
  getStatus: () => StageLinqStatus;
}

const DECKS: DeckNumber[] = [1, 2, 3, 4];

// Fields we diff on. updatedAt is volatile and recomputed by the replay engine.
const DIFFABLE_KEYS: Array<keyof DeckState> = [
  'trackLoaded', 'fileName', 'title', 'artist',
  'elapsedSec', 'totalSec', 'currentBpm', 'trackBpm', 'speedState',
  'keyIndex', 'keyCamelot', 'fader', 'play',
  'hotCues', 'loopActive', 'loopInSec', 'loopOutSec', 'savedLoops',
];

function buildDiff(prev: DeckState | null, next: DeckState): DeckDiff | null {
  if (!prev) return null; // caller emits a full keyframe instead
  const diff: DeckDiff = {};
  let any = false;
  for (const k of DIFFABLE_KEYS) {
    const a = (prev as any)[k];
    const b = (next as any)[k];
    // Arrays/objects: shallow JSON compare. Cheap; hotCues / savedLoops are tiny.
    const same = (typeof a === 'object' && a !== null) || (typeof b === 'object' && b !== null)
      ? JSON.stringify(a) === JSON.stringify(b)
      : a === b;
    if (!same) {
      (diff as any)[k] = b;
      any = true;
    }
  }
  return any ? diff : null;
}

// File-name-safe ISO: 2026-06-18T20-00-00Z
function isoStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-').replace(/-(\d{3})-Z$/, 'Z');
}

export class Recorder {
  private opts: RecorderOptions;
  private active = false;
  private startedAt: number | null = null;
  private filePath: string | null = null;
  private stream: fs.WriteStream | null = null;
  private eventCount = 0;
  private lastEmitted: Record<DeckNumber, DeckState | null> = { 1: null, 2: null, 3: null, 4: null };
  private unsubBridge: (() => void) | null = null;

  constructor(opts: RecorderOptions) {
    this.opts = opts;
  }

  getStatus(): RecordingStatus {
    return {
      active: this.active,
      file: this.filePath ? path.basename(this.filePath) : null,
      startedAt: this.startedAt,
      eventCount: this.eventCount,
    };
  }

  isActive(): boolean { return this.active; }

  async start(name?: string): Promise<{ ok: true; file: string; startedAt: number } | { ok: false; error: string; code: number }> {
    if (this.active) return { ok: false, error: 'recording already in progress', code: 409 };
    if (this.opts.isReplayActive()) return { ok: false, error: 'cannot record during replay', code: 409 };
    const status = this.opts.getStatus();
    if (status !== 'connected') return { ok: false, error: `StageLinq not connected (status=${status})`, code: 409 };

    await fs.promises.mkdir(this.opts.recordingsDir, { recursive: true });

    const startedAt = Date.now();
    const stamp = isoStamp(startedAt);
    const safeName = (name ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64);
    const fileName = safeName ? `${stamp}--${safeName}.jsonl` : `${stamp}.jsonl`;
    const filePath = path.join(this.opts.recordingsDir, fileName);

    const stream = fs.createWriteStream(filePath, { flags: 'wx' });
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', reject);
    });

    this.active = true;
    this.startedAt = startedAt;
    this.filePath = filePath;
    this.stream = stream;
    this.eventCount = 0;
    this.lastEmitted = { 1: null, 2: null, 3: null, 4: null };

    // Header.
    this.write({
      v: 1,
      type: 'header',
      startedAt,
      trackOffsets: this.opts.getTrackOffsets(),
      playlistRef: this.opts.getPlaylistRef(),
    });

    // Initial keyframe for all four decks.
    const decks = this.opts.bridge.getDecks();
    for (const d of DECKS) {
      this.write({ t: 0, type: 'deck', n: d, state: decks[d] });
      this.lastEmitted[d] = { ...decks[d] };
    }
    // Initial status snapshot.
    this.write({ t: 0, type: 'status', value: status });

    // Subscribe to per-deck mutations at full bridge cadence.
    this.unsubBridge = this.opts.bridge.subscribeDeckState((deck, state) => {
      if (!this.active) return;
      const prev = this.lastEmitted[deck];
      // On track change, emit a fresh keyframe instead of a diff so replay can resync.
      const fileChanged = !prev || prev.fileName !== state.fileName;
      if (fileChanged) {
        this.write({ t: this.tNow(), type: 'deck', n: deck, state });
        this.lastEmitted[deck] = { ...state };
        return;
      }
      const diff = buildDiff(prev, state);
      if (diff) {
        this.write({ t: this.tNow(), type: 'deck', n: deck, diff });
        // Update lastEmitted by patching only the diff fields so we don't churn references.
        for (const k of Object.keys(diff)) (this.lastEmitted[deck] as any)[k] = (state as any)[k];
      }
    });

    logLifecycle(`[REC] started ${path.basename(filePath)}`);
    return { ok: true, file: path.basename(filePath), startedAt };
  }

  recordSelected(deck: DeckNumber | null) {
    if (!this.active) return;
    this.write({ t: this.tNow(), type: 'selected', deck });
  }

  recordStatus(status: StageLinqStatus) {
    if (!this.active) return;
    this.write({ t: this.tNow(), type: 'status', value: status });
  }

  recordSacnExecute(deck: DeckNumber | null) {
    if (!this.active) return;
    this.write({ t: this.tNow(), type: 'sacn_execute', deck });
  }

  async stop(): Promise<{ ok: true; file: string; durationMs: number; eventCount: number } | { ok: false; error: string; code: number }> {
    if (!this.active) return { ok: false, error: 'not recording', code: 409 };

    const stoppedAt = Date.now();
    const t = this.tNow();

    // Footer + flush + close.
    this.write({ t, type: 'footer', stoppedAt, eventCount: this.eventCount + 1 });

    this.unsubBridge?.();
    this.unsubBridge = null;

    const stream = this.stream!;
    const filePath = this.filePath!;
    const startedAt = this.startedAt!;
    const eventCount = this.eventCount;
    this.active = false;
    this.stream = null;

    await new Promise<void>((resolve) => stream.end(resolve));

    // Sidecar metadata for UI listing.
    const meta = {
      file: path.basename(filePath),
      startedAt,
      stoppedAt,
      durationMs: stoppedAt - startedAt,
      eventCount,
    };
    const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
    try {
      await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
    } catch (e) {
      logError('[REC] failed to write meta sidecar:', e);
    }

    logLifecycle(`[REC] stopped ${meta.file} dur=${(meta.durationMs / 1000).toFixed(1)}s events=${eventCount}`);
    return { ok: true, file: meta.file, durationMs: meta.durationMs, eventCount };
  }

  private tNow(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  private write(ev: Event) {
    if (!this.stream) return;
    try {
      this.stream.write(JSON.stringify(ev) + '\n');
      this.eventCount++;
    } catch (e) {
      logError('[REC] write failed:', e);
    }
  }
}

export interface RecordingMeta {
  file: string;
  startedAt: number;
  stoppedAt: number;
  durationMs: number;
  eventCount: number;
}

/** Lists *.meta.json sidecars in the recordings directory, newest first. */
export async function listRecordings(recordingsDir: string): Promise<RecordingMeta[]> {
  try {
    const names = await fs.promises.readdir(recordingsDir);
    const metas: RecordingMeta[] = [];
    for (const n of names) {
      if (!n.endsWith('.meta.json')) continue;
      try {
        const raw = await fs.promises.readFile(path.join(recordingsDir, n), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.file) metas.push(parsed as RecordingMeta);
      } catch {
        // skip malformed sidecar
      }
    }
    metas.sort((a, b) => b.startedAt - a.startedAt);
    return metas;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
}
