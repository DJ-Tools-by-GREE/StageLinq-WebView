import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import type { DeckNumber, DeckState, RecordingStatus, StageLinqStatus, SourceTiming } from './types.js';
import { logError, logLifecycle } from './logging.js';
import { writeJsonFile } from './jsonFile.js';
import { monotonicNowMs } from './timecodeTimeline.js';
import { RECORDING_MAX_PENDING_BYTES, RECORDING_MAX_LINE_BYTES } from './constants.js';
import { parseRecording, type RecordedTiming, type TrackOffsets } from './recordingLog.js';
import type { StageLinqBridge } from './stagelinqBridge.js';

// JSONL log format. Every line is one event with a `t` (ms since recording start) and a `type`.
// See plan: /Users/i590073/.claude/plans/glowing-fluttering-sloth.md (or README "Record & Replay").

type DeckDiff = Partial<Omit<DeckState, 'deck'>>;

type Event =
  | { v: 1 | 2; type: 'header'; startedAt: number; trackOffsets: Record<string, { offsetSec: number; offsetFrame: number }>; playlistRef: string }
  | { t: number; type: 'deck'; n: DeckNumber; state: DeckState; timing?: RecordedTiming }
  | { t: number; type: 'deck'; n: DeckNumber; diff: DeckDiff; timing?: RecordedTiming }
  | { t: number; type: 'config'; trackOffsets: TrackOffsets; playlistRef: string }
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
  getSelectedDeck?: () => DeckNumber | null;
  monotonicNowMs?: () => number;
  wallNowMs?: () => number;
}

const DECKS: DeckNumber[] = [1, 2, 3, 4];

// Fields we diff on. updatedAt is volatile and recomputed by the replay engine.
const DIFFABLE_KEYS: Array<keyof DeckState> = [
  'trackLoaded', 'fileName', 'mediaId', 'title', 'artist',
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
  truncateTo: number | null;
  needsNewline: boolean;
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

  const parsed = await parseRecording(filePath, { collectEvents: false });
  if (parsed.stoppedAt !== null) {
    await writeJsonFile(sidecarPath, { file: targetName, startedAt: parsed.startedAt, stoppedAt: parsed.stoppedAt, durationMs: parsed.durationMs, eventCount: parsed.eventCount });
    await fs.promises.rm(lockPath, { force: true });
    return null;
  }
  return { filePath, startedAt: parsed.startedAt, lastEventT: parsed.durationMs,
    lastEventWallMs: stat.mtimeMs, lastEmitted: parsed.lastEmitted,
    eventCount: parsed.eventCount, truncateTo: parsed.truncateTo, needsNewline: parsed.needsNewline };

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
  private operation: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;
  private streamError: Error | null = null;
  private recoveryBlocked = false;
  private monotonicStart = 0;
  private elapsedOffset = 0;
  private lastConfig = '';
  private lastTiming: Record<DeckNumber, RecordedTiming | null> = { 1: null, 2: null, 3: null, 4: null };
  private pendingWrites: string[] = [];
  private pendingHead = 0;
  private pendingBytes = 0;
  private writeBlocked = false;
  private queueWaiters: Array<{ resolve(): void; reject(error: Error): void }> = [];


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
    truncateTo: number | null;
    needsNewline: boolean;
  } | null = null;

  constructor(opts: RecorderOptions) {
    this.opts = opts;
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    this.pendingOperations++;
    const result = this.operation.then(action).finally(() => { this.pendingOperations--; });
    this.operation = result.catch(() => {});
    return result;
  }

  isBusy(): boolean {
    return this.active || this.stream !== null || this.pendingResume !== null || this.recoveryBlocked || this.pendingOperations > 0;
  }

  shutdown(): Promise<void> {
    return this.serialize(async () => {
      if (this.active || this.stream) await this.stopNow();
    });
  }

  getStatus(): RecordingStatus {
    return {
      active: this.active,
      file: this.filePath ? path.basename(this.filePath) : (this.pendingResume ? path.basename(this.pendingResume.filePath) : null),
      startedAt: this.startedAt ?? this.pendingResume?.startedAt ?? null,
      eventCount: this.eventCount,
      error: this.streamError?.message ?? null,
    };
  }

  isActive(): boolean { return this.active; }

  hasPendingResume(): boolean { return this.pendingResume !== null || this.recoveryBlocked; }

  /**
   * Look for a single unfinished recording from a prior session. Returns true if a resume
   * was staged — caller should then poll status and call finalizeResume() once StageLinq
   * is connected. Idempotent: repeated calls without finalize are no-ops.
   */
  prepareResumeFromOrphan(): Promise<boolean> {
    return this.serialize(() => this.prepareResumeNow());
  }

  private async prepareResumeNow(): Promise<boolean> {
    if (this.active || this.pendingResume || this.recoveryBlocked) return false;
    let scan: OrphanScan | null;
    try {
      scan = await findOrphan(this.opts.recordingsDir);
    } catch (e) {
      this.streamError = e instanceof Error ? e : new Error(String(e));
      this.recoveryBlocked = true;
      logError('[REC] recovery blocked; recording and lock retained:', e);
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
      truncateTo: scan.truncateTo,
      needsNewline: scan.needsNewline,
    };
    logLifecycle(`[REC] orphan detected: ${path.basename(scan.filePath)} (${scan.eventCount} events, ` +
      `last @ +${(scan.lastEventT / 1000).toFixed(1)}s). Resume pending StageLinq reconnection.`);
    return true;
  }

  /**
   * Drop a pending resume without writing anything. Used by /api/record/start to clear
   * a stale resume so the operator can begin a fresh recording instead.
   */
  abortPendingResume(): Promise<void> {
    return this.serialize(() => this.abortPendingResumeNow());
  }

  private async abortPendingResumeNow(): Promise<void> {
    if (!this.pendingResume && !this.recoveryBlocked) return;
    logLifecycle('[REC] pending/blocked recovery explicitly discarded');
    // Discard the lock too — otherwise the same orphan would reappear on every restart.
    await this.clearLock();
    this.pendingResume = null;
    this.recoveryBlocked = false;
    this.streamError = null;
  }

  /**
   * Complete a resume: open the file in append mode, write a gap marker, fresh keyframes,
   * and hook up the bridge subscriber. Caller should invoke this when status flips to
   * 'connected' (or after a short grace period if it stays connected on boot).
   */
  finalizeResume(): Promise<{ ok: true; gapMs: number } | { ok: false; error: string }> {
    return this.serialize(() => this.finalizeResumeNow());
  }

  private async finalizeResumeNow(): Promise<{ ok: true; gapMs: number } | { ok: false; error: string }> {
    if (this.active) return { ok: false, error: 'already recording' };
    if (this.opts.isReplayActive()) return { ok: false, error: 'replay is active' };
    const pending = this.pendingResume;
    if (!pending) return { ok: false, error: 'no pending resume' };

    const status = this.opts.getStatus();
    if (status !== 'connected') return { ok: false, error: `StageLinq not connected (status=${status})` };

    if (pending.truncateTo !== null) await fs.promises.truncate(pending.filePath, pending.truncateTo);
    if (pending.needsNewline) await fs.promises.appendFile(pending.filePath, '\n');
    const stream = await this.openStream(pending.filePath, 'a');

    const resumedAtWall = this.wallNow();
    const gapMs = Math.max(0, resumedAtWall - pending.crashedAtWall);
    const tNow = pending.lastEventT + gapMs;
    this.elapsedOffset = tNow;
    this.monotonicStart = this.monoNow();

    this.active = true;
    this.startedAt = pending.startedAt;
    this.filePath = pending.filePath;
    this.stream = stream;
    this.eventCount = pending.eventCount;
    this.lastEmitted = pending.lastEmitted;
    this.pendingResume = null;
    this.lastTiming = { 1: null, 2: null, 3: null, 4: null };
    this.lastConfig = '';

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
      this.writeDeck(tNow, d, decks[d]);
      this.lastEmitted[d] = { ...decks[d] };
    }
    this.write({ t: tNow, type: 'status', value: status });
    this.write({ t: tNow, type: 'selected', deck: this.opts.getSelectedDeck?.() ?? null });
    this.recordConfig();

    this.unsubBridge = this.opts.bridge.subscribeDeckState((deck, state, timing) => this.onDeckChange(deck, state, timing));

    logLifecycle(`[REC] resumed ${path.basename(pending.filePath)} after ${(gapMs / 1000).toFixed(1)}s gap`);
    return { ok: true, gapMs };
  }

  start(name?: string): Promise<{ ok: true; file: string; startedAt: number } | { ok: false; error: string; code: number }> {
    return this.serialize(() => this.startNow(name));
  }

  private async startNow(name?: string): Promise<{ ok: true; file: string; startedAt: number } | { ok: false; error: string; code: number }> {
    if (this.active) return { ok: false, error: 'recording already in progress', code: 409 };
    if (this.stream) throw this.streamError ?? new Error('previous recording has not finished closing');
    if (this.opts.isReplayActive()) return { ok: false, error: 'cannot record during replay', code: 409 };
    if (this.recoveryBlocked) return { ok: false, error: 'recording recovery is blocked: ' + this.streamError?.message + '; explicitly discard pending recovery before starting', code: 409 };
    if (this.pendingResume) return { ok: false, error: 'a previous recording is pending resume; call /api/record/resume-abort to discard it first', code: 409 };
    const status = this.opts.getStatus();
    if (status !== 'connected') return { ok: false, error: `StageLinq not connected (status=${status})`, code: 409 };

    await fs.promises.mkdir(this.opts.recordingsDir, { recursive: true });

    const startedAt = this.wallNow();
    const stamp = isoStamp(startedAt);
    const safeName = (name ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64);
    const fileName = safeName ? `${stamp}--${safeName}.jsonl` : `${stamp}.jsonl`;
    const filePath = path.join(this.opts.recordingsDir, fileName);

    const stream = await this.openStream(filePath, 'wx');

    // Lock file: marks this recording as the one to resume if the process dies before
    // stop() runs. Cleared in stop(); presence at next-boot is what gates resume.
    try {
      await this.writeLock(fileName);
    } catch (error) {
      stream.destroy();
      throw error;
    }

    this.active = true;
    this.startedAt = startedAt;
    this.filePath = filePath;
    this.stream = stream;
    this.eventCount = 0;
    this.monotonicStart = this.monoNow();
    this.elapsedOffset = 0;
    this.lastTiming = { 1: null, 2: null, 3: null, 4: null };
    this.lastConfig = JSON.stringify({ trackOffsets: this.opts.getTrackOffsets(), playlistRef: this.opts.getPlaylistRef() });
    this.lastEmitted = { 1: null, 2: null, 3: null, 4: null };

    // Header.
    this.write({
      v: 2,
      type: 'header',
      startedAt,
      trackOffsets: this.opts.getTrackOffsets(),
      playlistRef: this.opts.getPlaylistRef(),
    });

    // Initial keyframe for all four decks.
    const decks = this.opts.bridge.getDecks();
    for (const d of DECKS) {
      this.writeDeck(0, d, decks[d]);
      this.lastEmitted[d] = { ...decks[d] };
    }
    // Initial status snapshot.
    this.write({ t: 0, type: 'status', value: status });
    this.write({ t: 0, type: 'selected', deck: this.opts.getSelectedDeck?.() ?? null });

    // Subscribe to per-deck mutations at full bridge cadence.
    this.unsubBridge = this.opts.bridge.subscribeDeckState((deck, state, timing) => this.onDeckChange(deck, state, timing));

    logLifecycle(`[REC] started ${path.basename(filePath)}`);
    return { ok: true, file: path.basename(filePath), startedAt };
  }

  private sourceTiming(timing: SourceTiming | undefined): RecordedTiming | undefined {
    if (!timing) return undefined;
    return { positionT: timing.positionAtMs === null ? null : this.elapsedOffset + timing.positionAtMs - this.monotonicStart,
      positionRevision: timing.positionRevision, transportRevision: timing.transportRevision, trackId: timing.trackId, ...(timing.transportPlay === undefined ? {} : { transportPlay: timing.transportPlay }) };
  }

  private writeDeck(t: number, deck: DeckNumber, state: DeckState): void {
    const timing = this.sourceTiming(this.opts.bridge.getDeckTiming?.(deck));
    this.write({ t, type: 'deck', n: deck, state, ...(timing ? { timing } : {}) });
    this.lastTiming[deck] = timing ?? null;
  }

  private onDeckChange(deck: DeckNumber, state: DeckState, source?: SourceTiming) {
    if (!this.active) return;
    const prev = this.lastEmitted[deck];
    const timing = this.sourceTiming(source);
    const timingChanged = JSON.stringify(timing ?? null) !== JSON.stringify(this.lastTiming[deck]);
    const fileChanged = !prev || prev.fileName !== state.fileName || prev.mediaId !== state.mediaId;
    const diff = fileChanged ? null : buildDiff(prev, state);
    if (fileChanged || diff || timingChanged) {
      this.write({ t: this.tNow(), type: 'deck', n: deck,
        ...(fileChanged ? { state } : { diff: diff ?? {} }), ...(timing ? { timing } : {}) });
      this.lastEmitted[deck] = { ...state };
      this.lastTiming[deck] = timing ?? null;
    }
  }

  recordConfig(): void {
    if (!this.active) return;
    const config = { trackOffsets: this.opts.getTrackOffsets(), playlistRef: this.opts.getPlaylistRef() };
    const signature = JSON.stringify(config);
    if (signature === this.lastConfig) return;
    this.write({ t: this.tNow(), type: 'config', ...config });
    this.lastConfig = signature;
  }

  recordSelected(deck: DeckNumber | null) {
    if (!this.active) return;
    this.write({ t: this.tNow(), type: 'selected', deck });
  }

  recordStatus(status: StageLinqStatus) {
    if (!this.active) return;
    this.write({ t: this.tNow(), type: 'status', value: status });
  }

  stop(): Promise<{ ok: true; file: string; durationMs: number; eventCount: number } | { ok: false; error: string; code: number }> {
    return this.serialize(() => this.stopNow());
  }

  private async stopNow(): Promise<{ ok: true; file: string; durationMs: number; eventCount: number } | { ok: false; error: string; code: number }> {
    if (!this.active && !this.stream) return { ok: false, error: 'not recording', code: 409 };

    const stoppedAt = this.wallNow();
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
    try {
      const flushed = finished(stream, { cleanup: true });
      void flushed.catch(() => {});
      await this.drainPending();
      stream.end();
      await flushed;
      if (this.streamError) throw this.streamError;
    } finally {
      this.stream = null;
      this.pendingWrites = [];
      this.pendingHead = 0;
      this.pendingBytes = 0;
    }

    // Sidecar metadata for UI listing.
    const meta = {
      file: path.basename(filePath),
      startedAt,
      stoppedAt,
      durationMs: t,
      eventCount,
    };
    const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
    await writeJsonFile(metaPath, meta);

    logLifecycle(`[REC] stopped ${meta.file} dur=${(meta.durationMs / 1000).toFixed(1)}s events=${eventCount}`);
    // Clear the lock AFTER the sidecar exists, so a crash between the two doesn't leave
    // a sidecar-less .jsonl looking like an orphan. (The opposite ordering would still
    // self-heal next boot — findOrphan() rejects locks pointing at files with sidecars
    // — but doing it in this order keeps the on-disk state consistent at all times.)
    await this.clearLock();
    return { ok: true, file: meta.file, durationMs: meta.durationMs, eventCount };
  }

  private tNow(): number {
    return this.startedAt === null ? 0 : this.elapsedOffset + Math.max(0, this.monoNow() - this.monotonicStart);
  }

  private monoNow(): number { return this.opts.monotonicNowMs?.() ?? monotonicNowMs(); }
  private wallNow(): number { return this.opts.wallNowMs?.() ?? Date.now(); }

  private async writeLock(jsonlBasename: string): Promise<void> {
    const lockPath = path.join(this.opts.recordingsDir, ACTIVE_LOCK_FILENAME);
    await fs.promises.writeFile(lockPath, jsonlBasename + '\n');
  }

  private async clearLock(): Promise<void> {
    const lockPath = path.join(this.opts.recordingsDir, ACTIVE_LOCK_FILENAME);
    await fs.promises.rm(lockPath, { force: true });
  }

  private async openStream(filePath: string, flags: 'wx' | 'a'): Promise<fs.WriteStream> {
    this.streamError = null;
    this.pendingWrites = [];
    this.pendingHead = 0;
    this.pendingBytes = 0;
    this.writeBlocked = false;
    const stream = fs.createWriteStream(filePath, { flags });
    stream.on('error', (error) => {
      if (this.stream === stream) this.failRecording(error);
      for (const waiter of this.queueWaiters.splice(0)) waiter.reject(error);
    });
    stream.on('drain', () => { this.writeBlocked = false; this.flushPending(); });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { stream.off('error', onError); resolve(); };
      const onError = (error: Error) => { stream.off('open', onOpen); reject(error); };
      stream.once('open', onOpen);
      stream.once('error', onError);
    });
    return stream;
  }

  private failRecording(error: unknown): void {
    this.streamError = error instanceof Error ? error : new Error(String(error));
    this.active = false;
    this.unsubBridge?.();
    this.unsubBridge = null;
    logError('[REC] recording failed; incomplete log retained for recovery:', this.streamError);
  }

  private flushPending(): void {
    const stream = this.stream;
    if (!stream || stream.destroyed) return;
    try {
      while (!this.writeBlocked && this.pendingHead < this.pendingWrites.length) {
        const line = this.pendingWrites[this.pendingHead];
        this.pendingWrites[this.pendingHead++] = '';
        this.pendingBytes -= Buffer.byteLength(line);
        this.writeBlocked = !stream.write(line);
      }
      if (this.pendingHead === this.pendingWrites.length) {
        this.pendingWrites = [];
        this.pendingHead = 0;
        for (const waiter of this.queueWaiters.splice(0)) waiter.resolve();
      }
    } catch (error) {
      this.failRecording(error);
      for (const waiter of this.queueWaiters.splice(0)) waiter.reject(this.streamError!);
    }
  }

  private drainPending(): Promise<void> {
    if (this.stream?.destroyed) return Promise.reject(this.streamError ?? new Error('recording stream closed'));
    if (this.pendingHead === this.pendingWrites.length) return Promise.resolve();
    return new Promise((resolve, reject) => { this.queueWaiters.push({ resolve, reject }); this.flushPending(); });
  }

  private write(ev: Event) {
    if (!this.stream || this.streamError) return;
    try {
      const line = JSON.stringify(ev) + '\n';
      const bytes = Buffer.byteLength(line);
      if (bytes > RECORDING_MAX_LINE_BYTES) {
        this.failRecording(new Error('Recording stopped: event exceeds maximum line size; incomplete log retained'));
        return;
      }
      if (this.pendingBytes + this.stream.writableLength + bytes > RECORDING_MAX_PENDING_BYTES) {
        this.failRecording(new Error('Recording stopped: storage backlog exceeded ' + RECORDING_MAX_PENDING_BYTES + ' bytes; incomplete log retained'));
        return;
      }
      this.pendingWrites.push(line);
      this.pendingBytes += bytes;
      this.eventCount++;
      this.flushPending();
    } catch (error) {
      this.failRecording(error);
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
