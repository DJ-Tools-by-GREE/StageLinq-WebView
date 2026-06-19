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
  // Crash/restart marker. `t` is when the resume happens (real wall clock since startedAt);
  // `lastEventT` is the relative timestamp of the last event before the crash, so a gap
  // duration can be computed without parsing the whole prefix.
  | { t: number; type: 'gap'; lastEventT: number; gapMs: number; crashedAtWall: number; resumedAtWall: number }
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

// Maximum age of an orphan file we'll auto-resume. Anything older is almost certainly
// a stale recording from a previous show — surfacing a gap of hours/days is noise.
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Lock file written next to recordings/. Contains the basename of the .jsonl that is
// currently being written to. Created on start(), deleted on clean stop(). Its presence
// at boot is the *only* signal that the previous run died with a recording active —
// stale orphans from older shows have no lock and are intentionally ignored.
const ACTIVE_LOCK_FILENAME = '.active-recording';

interface OrphanScan {
  filePath: string;
  startedAt: number;
  lastEventT: number;          // relative ms (largest `t` seen)
  lastEventWallMs: number;     // startedAt + lastEventT
  lastEmitted: Record<DeckNumber, DeckState | null>;
  eventCount: number;
}

/**
 * Find a resumable orphan via the lock file written by the prior run's start(). Returns
 * null if no lock exists (clean shutdown or no recording was active when the last run
 * died). Cleans up the lock on any rejection (sidecar exists, file missing, malformed,
 * too old) so we don't spin on a bad lock across reboots.
 */
async function findOrphan(recordingsDir: string): Promise<OrphanScan | null> {
  const lockPath = path.join(recordingsDir, ACTIVE_LOCK_FILENAME);
  let lockBody: string;
  try {
    lockBody = await fs.promises.readFile(lockPath, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;          // no active-recording lock — nothing to resume
    throw e;
  }
  const targetName = lockBody.trim();
  // Defensive: lock contents should be a bare basename of a .jsonl. Reject anything else.
  if (!targetName || targetName.includes('/') || !targetName.endsWith('.jsonl')) {
    logError(`[REC] active-recording lock is malformed (${JSON.stringify(targetName)}) — clearing.`);
    await fs.promises.rm(lockPath, { force: true });
    return null;
  }

  const filePath = path.join(recordingsDir, targetName);
  const sidecarPath = filePath.replace(/\.jsonl$/, '.meta.json');

  // Sidecar present means the prior run actually stopped cleanly and just failed to
  // remove the lock — no resume needed; clear the lock and move on.
  try {
    await fs.promises.access(sidecarPath);
    logLifecycle(`[REC] active-recording lock found but sidecar exists for ${targetName} — clearing lock, no resume needed.`);
    await fs.promises.rm(lockPath, { force: true });
    return null;
  } catch { /* sidecar missing — good, this is the resume path */ }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      logError(`[REC] active-recording lock points at missing file ${targetName} — clearing lock.`);
      await fs.promises.rm(lockPath, { force: true });
      return null;
    }
    throw e;
  }
  if (stat.size === 0) {
    logError(`[REC] active-recording lock points at empty file ${targetName} — clearing lock.`);
    await fs.promises.rm(lockPath, { force: true });
    return null;
  }
  if (Date.now() - stat.mtimeMs > ORPHAN_MAX_AGE_MS) {
    logLifecycle(`[REC] orphan ${targetName} is older than 24h — clearing lock, no resume.`);
    await fs.promises.rm(lockPath, { force: true });
    return null;
  }

  // Replay every line into a working state to rebuild `lastEmitted` for diff continuity.
  const raw = await fs.promises.readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  let startedAt = 0;
  let lastEventT = 0;
  let eventCount = 0;
  const lastEmitted: Record<DeckNumber, DeckState | null> = { 1: null, 2: null, 3: null, 4: null };

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let ev: any;
    try { ev = JSON.parse(s); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    eventCount++;
    if (ev.type === 'header') { startedAt = Number(ev.startedAt ?? 0); continue; }
    const t = Number(ev.t ?? 0);
    if (t > lastEventT) lastEventT = t;
    if (ev.type === 'deck' && ev.n != null) {
      const n = Number(ev.n) as DeckNumber;
      if (![1, 2, 3, 4].includes(n)) continue;
      if (ev.state) {
        lastEmitted[n] = { ...ev.state };
      } else if (ev.diff && lastEmitted[n]) {
        for (const k of Object.keys(ev.diff)) (lastEmitted[n] as any)[k] = ev.diff[k];
      } else if (ev.diff) {
        // Diff arrived before any keyframe — defensive; shouldn't happen with our writer.
        lastEmitted[n] = { deck: n, ...(ev.diff as any) } as DeckState;
      }
    }
  }
  if (!startedAt) {
    logError(`[REC] orphan ${targetName} has no header — clearing lock, no resume.`);
    await fs.promises.rm(lockPath, { force: true });
    return null;
  }
  return { filePath, startedAt, lastEventT, lastEventWallMs: startedAt + lastEventT, lastEmitted, eventCount };
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

  // Resume staging: set by prepareResumeFromOrphan(), consumed by finalizeResume() once
  // StageLinq is back. Until finalized, `active` stays false so no diffs are written
  // and no consumer thinks recording is live yet.
  private pendingResume: {
    filePath: string;
    startedAt: number;
    lastEventT: number;
    lastEventWallMs: number;
    lastEmitted: Record<DeckNumber, DeckState | null>;
    eventCount: number;
    crashedAtWall: number;
  } | null = null;

  constructor(opts: RecorderOptions) {
    this.opts = opts;
  }

  getStatus(): RecordingStatus {
    return {
      active: this.active,
      file: this.filePath ? path.basename(this.filePath) : (this.pendingResume ? path.basename(this.pendingResume.filePath) : null),
      startedAt: this.startedAt ?? this.pendingResume?.startedAt ?? null,
      eventCount: this.eventCount,
    };
  }

  isActive(): boolean { return this.active; }

  hasPendingResume(): boolean { return this.pendingResume !== null; }

  /**
   * Look for a single unfinished recording from a prior session. Returns true if a resume
   * was staged — caller should then poll status and call finalizeResume() once StageLinq
   * is connected. Idempotent: repeated calls without finalize are no-ops.
   */
  async prepareResumeFromOrphan(): Promise<boolean> {
    if (this.active || this.pendingResume) return false;
    let scan: OrphanScan | null;
    try {
      scan = await findOrphan(this.opts.recordingsDir);
    } catch (e) {
      logError('[REC] orphan scan failed:', e);
      return false;
    }
    if (!scan) return false;

    // Best-effort estimate of when we crashed: the wall-clock timestamp of the last
    // event written before death. Not exact (could be up to one buffer-flush behind),
    // but tight enough — usually within a few hundred ms.
    const crashedAtWall = scan.lastEventWallMs;
    this.pendingResume = {
      filePath: scan.filePath,
      startedAt: scan.startedAt,
      lastEventT: scan.lastEventT,
      lastEventWallMs: scan.lastEventWallMs,
      lastEmitted: scan.lastEmitted,
      eventCount: scan.eventCount,
      crashedAtWall,
    };
    logLifecycle(`[REC] orphan detected: ${path.basename(scan.filePath)} (${scan.eventCount} events, ` +
      `last @ +${(scan.lastEventT / 1000).toFixed(1)}s). Resume pending StageLinq reconnection.`);
    return true;
  }

  /**
   * Drop a pending resume without writing anything. Used by /api/record/start to clear
   * a stale resume so the operator can begin a fresh recording instead.
   */
  abortPendingResume() {
    if (!this.pendingResume) return;
    logLifecycle(`[REC] pending resume aborted: ${path.basename(this.pendingResume.filePath)}`);
    this.pendingResume = null;
    // Discard the lock too — otherwise the same orphan would reappear on every restart.
    void this.clearLock();
  }

  /**
   * Complete a resume: open the file in append mode, write a gap marker, fresh keyframes,
   * and hook up the bridge subscriber. Caller should invoke this when status flips to
   * 'connected' (or after a short grace period if it stays connected on boot).
   */
  async finalizeResume(): Promise<{ ok: true; gapMs: number } | { ok: false; error: string }> {
    if (this.active) return { ok: false, error: 'already recording' };
    if (this.opts.isReplayActive()) return { ok: false, error: 'replay is active' };
    const pending = this.pendingResume;
    if (!pending) return { ok: false, error: 'no pending resume' };

    const status = this.opts.getStatus();
    if (status !== 'connected') return { ok: false, error: `StageLinq not connected (status=${status})` };

    const stream = fs.createWriteStream(pending.filePath, { flags: 'a' });
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', reject);
    });

    const resumedAtWall = Date.now();
    const tNow = resumedAtWall - pending.startedAt;
    const gapMs = resumedAtWall - pending.crashedAtWall;

    this.active = true;
    this.startedAt = pending.startedAt;
    this.filePath = pending.filePath;
    this.stream = stream;
    this.eventCount = pending.eventCount;
    this.lastEmitted = pending.lastEmitted;
    this.pendingResume = null;

    // Marker so analysis tools can detect the discontinuity in the timeline.
    this.write({
      t: tNow,
      type: 'gap',
      lastEventT: pending.lastEventT,
      gapMs,
      crashedAtWall: pending.crashedAtWall,
      resumedAtWall,
    });

    // Fresh keyframes for all four decks at resume time. The bridge has no history of
    // what happened during the gap, so the recovered state is whatever the deck reports
    // *now* — it's the operator's job to know the gap exists when analyzing the log.
    const decks = this.opts.bridge.getDecks();
    for (const d of DECKS) {
      this.write({ t: tNow, type: 'deck', n: d, state: decks[d] });
      this.lastEmitted[d] = { ...decks[d] };
    }
    this.write({ t: tNow, type: 'status', value: status });

    this.unsubBridge = this.opts.bridge.subscribeDeckState((deck, state) => this.onDeckChange(deck, state));

    logLifecycle(`[REC] resumed ${path.basename(pending.filePath)} after ${(gapMs / 1000).toFixed(1)}s gap`);
    return { ok: true, gapMs };
  }

  async start(name?: string): Promise<{ ok: true; file: string; startedAt: number } | { ok: false; error: string; code: number }> {
    if (this.active) return { ok: false, error: 'recording already in progress', code: 409 };
    if (this.opts.isReplayActive()) return { ok: false, error: 'cannot record during replay', code: 409 };
    if (this.pendingResume) return { ok: false, error: 'a previous recording is pending resume; call /api/record/resume-abort to discard it first', code: 409 };
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

    // Lock file: marks this recording as the one to resume if the process dies before
    // stop() runs. Cleared in stop(); presence at next-boot is what gates resume.
    await this.writeLock(fileName);

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
    this.unsubBridge = this.opts.bridge.subscribeDeckState((deck, state) => this.onDeckChange(deck, state));

    logLifecycle(`[REC] started ${path.basename(filePath)}`);
    return { ok: true, file: path.basename(filePath), startedAt };
  }

  private onDeckChange(deck: DeckNumber, state: DeckState) {
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
  }

  recordSelected(deck: DeckNumber | null) {
    if (!this.active) return;
    this.write({ t: this.tNow(), type: 'selected', deck });
  }

  recordStatus(status: StageLinqStatus) {
    if (!this.active) return;
    this.write({ t: this.tNow(), type: 'status', value: status });
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
    // Clear the lock AFTER the sidecar exists, so a crash between the two doesn't leave
    // a sidecar-less .jsonl looking like an orphan. (The opposite ordering would still
    // self-heal next boot — findOrphan() rejects locks pointing at files with sidecars
    // — but doing it in this order keeps the on-disk state consistent at all times.)
    await this.clearLock();
    return { ok: true, file: meta.file, durationMs: meta.durationMs, eventCount };
  }

  private tNow(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  private async writeLock(jsonlBasename: string): Promise<void> {
    const lockPath = path.join(this.opts.recordingsDir, ACTIVE_LOCK_FILENAME);
    try {
      await fs.promises.writeFile(lockPath, jsonlBasename + '\n');
    } catch (e) {
      logError('[REC] failed to write active-recording lock:', e);
    }
  }

  private async clearLock(): Promise<void> {
    const lockPath = path.join(this.opts.recordingsDir, ACTIVE_LOCK_FILENAME);
    try {
      await fs.promises.rm(lockPath, { force: true });
    } catch (e) {
      logError('[REC] failed to clear active-recording lock:', e);
    }
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
