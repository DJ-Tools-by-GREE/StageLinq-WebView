import fs from 'node:fs';
import path from 'node:path';
import type { DeckNumber, DeckState, ReplayStatus, ReplayState, StageLinqStatus, SourceTiming } from './types.js';
import { logLifecycle } from './logging.js';
import { REPLAY_FREEWHEEL_DETECT_MS } from './constants.js';

// Recording filename normalization mirrors index.ts → normalizeTrackName(): basename only.
function normalizeName(name: string): string {
  return path.basename(String(name ?? '').trim());
}

interface DeckEvent {
  t: number;
  n: DeckNumber;
  state?: DeckState;          // keyframe (full state)
  diff?: Partial<Omit<DeckState, 'deck'>>;
}

interface SelectedEvent { t: number; deck: DeckNumber | null }
interface StatusEvent { t: number; value: StageLinqStatus }

interface ParsedLog {
  startedAt: number;
  durationMs: number;
  // All deck events sorted by t, in original file order for ties.
  deckEvents: DeckEvent[];
  selectedEvents: SelectedEvent[];
  statusEvents: StatusEvent[];
  trackOffsets: Record<string, { offsetSec: number; offsetFrame: number }>;
}

const DECKS: DeckNumber[] = [1, 2, 3, 4];

function blankDeck(d: DeckNumber): DeckState {
  return {
    deck: d,
    trackLoaded: false, fileName: '', title: '—', artist: '—',
    elapsedSec: 0, totalSec: 0, currentBpm: 0, trackBpm: 0, speedState: 0,
    keyIndex: null, keyCamelot: '--', fader: 0, play: false,
    updatedAt: Date.now(),
    hotCues: [], loopActive: false, loopInSec: null, loopOutSec: null, savedLoops: [],
  };
}

function applyDiff(target: DeckState, diff: Partial<DeckState>) {
  for (const k of Object.keys(diff)) (target as any)[k] = (diff as any)[k];
}

async function parseLog(filePath: string): Promise<ParsedLog> {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  const lines = raw.split('\n');

  let startedAt = 0;
  let stoppedAt = 0;
  const deckEvents: DeckEvent[] = [];
  const selectedEvents: SelectedEvent[] = [];
  const statusEvents: StatusEvent[] = [];
  let maxT = 0;
  let hasKeyframe = false;
  const trackOffsets: ParsedLog['trackOffsets'] = {};

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let ev: any;
    try { ev = JSON.parse(s); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;

    if (ev.type === 'header') {
      startedAt = Number(ev.startedAt ?? 0);
      if (ev.v !== undefined && ev.v !== 1) throw new Error('unsupported recording version');
      if (ev.trackOffsets && typeof ev.trackOffsets === 'object') {
        for (const [key, value] of Object.entries(ev.trackOffsets)) {
          const offset = value as { offsetSec?: unknown; offsetFrame?: unknown } | null;
          if (!offset || !Number.isFinite(offset.offsetSec) || !Number.isFinite(offset.offsetFrame)) {
            throw new Error('invalid recorded track offset');
          }
          trackOffsets[key] = { offsetSec: Number(offset.offsetSec), offsetFrame: Number(offset.offsetFrame) };
        }
      }
      continue;
    }
    if (ev.type === 'footer') {
      stoppedAt = Number(ev.stoppedAt ?? 0);
      continue;
    }
    const t = Number(ev.t ?? 0);
    if (!Number.isFinite(t) || t < 0) throw new Error('invalid recording event timestamp');
    if (t > maxT) maxT = t;
    if (ev.type === 'deck') {
      const n = Number(ev.n) as DeckNumber;
      if (![1, 2, 3, 4].includes(n)) continue;
      if (ev.state) {
        if (typeof ev.state !== 'object' || !Number.isFinite(ev.state.elapsedSec) || typeof ev.state.play !== 'boolean') {
          throw new Error('invalid recording deck keyframe');
        }
        deckEvents.push({ t, n, state: { ...blankDeck(n), ...ev.state, deck: n } });
        hasKeyframe = true;
      } else if (ev.diff) {
        deckEvents.push({ t, n, diff: ev.diff });
      }
    } else if (ev.type === 'selected') {
      const deck = ev.deck === null || ev.deck === undefined ? null : (Number(ev.deck) as DeckNumber);
      selectedEvents.push({ t, deck });
    } else if (ev.type === 'status') {
      statusEvents.push({ t, value: ev.value });
    }
    // Unknown event types from older recordings (e.g. sacn_execute, suggested) are silently ignored.
  }

  const durationMs = stoppedAt && startedAt ? Math.max(stoppedAt - startedAt, maxT) : maxT;
  if (!Number.isFinite(startedAt) || startedAt <= 0 || !Number.isFinite(durationMs) || !hasKeyframe) {
    throw new Error('recording requires a valid header and deck keyframe');
  }
  deckEvents.sort((a, b) => a.t - b.t);
  return { startedAt, durationMs, deckEvents, selectedEvents, statusEvents, trackOffsets };
}

interface MappedRecording {
  audioFile: string; // normalized basename
  logFile: string;   // basename inside recordingsDir
  parsed: ParsedLog;
}

export interface ReplayOptions {
  recordingsDir: string;
}

export class Replay {
  private opts: ReplayOptions;
  private state: ReplayState = 'idle';
  private mappings: MappedRecording[] = [];
  private mappedAudioFiles = new Set<string>(); // normalized basenames, for waveform suppression
  private armGeneration = 0;
  private arming = false;
  private positionRevision = 0;
  private transportRevision = 0;
  private sessionRevision = 0;

  // Active replay session
  private active: {
    audioDeck: DeckNumber;
    audioFile: string;
    rec: MappedRecording;
    decks: Record<DeckNumber, DeckState>;
    cursor: number;            // index into rec.parsed.deckEvents (next event to apply)
    selectedCursor: number;
    statusCursor: number;
    cursorMs: number;          // last-applied event time
    lastClockMs: number;       // last-seen audio-deck elapsedSec * 1000
    lastClockAtWallMs: number; // wall clock when lastClockMs was sampled
    frozen: boolean;           // dropout/pause freeze
    timings: Record<DeckNumber, SourceTiming>;
    lastAudioPositionRevision: number | null;
    lastAudioTransportRevision: number | null;
    audioPlaying: boolean;
    lastOutputPlay: Record<DeckNumber, boolean | null>;
    sessionId: number;
    positionEventT: Record<DeckNumber, number | null>;
    positionEventId: Record<DeckNumber, number>;
    publishedPositionEventId: Record<DeckNumber, number>;
  } | null = null;

  constructor(opts: ReplayOptions) { this.opts = opts; }

  configureMappedAudioFiles(rawMappings: Array<{ audio_file?: string; log_file?: string }>): void {
    this.mappedAudioFiles = new Set((Array.isArray(rawMappings) ? rawMappings : [])
      .map(m => normalizeName(m?.audio_file ?? '')).filter(Boolean));
  }

  isArmedOrActive(): boolean { return this.arming || this.state !== 'idle'; }

  getTrackOffsets(): ParsedLog['trackOffsets'] | null {
    return this.isOverridingOutputs() && this.active ? this.active.rec.parsed.trackOffsets : null;
  }

  getDeckTimings(): Record<DeckNumber, SourceTiming> | null {
    return this.active ? this.active.timings : null;
  }

  /** Suppress waveform/artwork extraction for any mapped audio file regardless of state. */
  shouldSuppressWaveformExtraction(fileName: string): boolean {
    return this.mappedAudioFiles.has(normalizeName(fileName));
  }

  getStatus(): ReplayStatus {
    if (!this.active) {
      return { state: this.state, audioDeck: null, audioFile: null, logFile: null, cursorMs: 0, durationMs: 0 };
    }
    return {
      state: this.state,
      audioDeck: this.active.audioDeck,
      audioFile: this.active.audioFile,
      logFile: this.active.rec.logFile,
      cursorMs: this.active.cursorMs,
      durationMs: this.active.rec.parsed.durationMs,
    };
  }

  isActive(): boolean { return this.state === 'active' || this.state === 'attaching' || this.state === 'ended'; }

  /** Returns true if outputs should come from replay rather than the bridge. */
  isOverridingOutputs(): boolean { return this.state === 'active' || this.state === 'ended'; }

  /**
   * Load all configured recordings into memory. Returns a per-mapping result list.
   * On any individual failure the mapping is dropped from the engine.
   */
  async arm(rawMappings: Array<{ audio_file?: string; log_file?: string }>): Promise<{
    ok: boolean;
    loaded: Array<{ audioFile: string; logFile: string; durationMs: number }>;
    errors: Array<{ audioFile?: string; logFile?: string; error: string }>;
  }> {
    if (this.isActive()) {
      return { ok: false, loaded: [], errors: [{ error: 'cannot arm while replay is active; disarm first' }] };
    }
    const generation = ++this.armGeneration;
    this.arming = true;
    this.configureMappedAudioFiles(rawMappings);

    const loaded: Array<{ audioFile: string; logFile: string; durationMs: number }> = [];
    const errors: Array<{ audioFile?: string; logFile?: string; error: string }> = [];
    const mappings: MappedRecording[] = [];

    for (const m of Array.isArray(rawMappings) ? rawMappings : []) {
      const audio = normalizeName(m?.audio_file ?? '');
      const log = normalizeName(m?.log_file ?? '');
      if (!audio || !log) {
        errors.push({ audioFile: m?.audio_file, logFile: m?.log_file, error: 'audio_file and log_file are both required' });
        continue;
      }
      const fullPath = path.join(this.opts.recordingsDir, log);
      try {
        const parsed = await parseLog(fullPath);
        mappings.push({ audioFile: audio, logFile: log, parsed });
        loaded.push({ audioFile: audio, logFile: log, durationMs: parsed.durationMs });
      } catch (e: any) {
        errors.push({ audioFile: audio, logFile: log, error: e?.message || String(e) });
      }
    }

    if (generation !== this.armGeneration) {
      return { ok: false, loaded: [], errors: [{ error: 'replay arm cancelled' }] };
    }
    this.arming = false;
    if (this.isActive()) {
      return { ok: false, loaded: [], errors: [{ error: 'replay became active while loading; disarm first' }] };
    }

    this.mappings = mappings;
    this.state = mappings.length > 0 ? 'armed' : 'idle';
    logLifecycle(`[REPLAY] armed (${mappings.length} mapping${mappings.length === 1 ? '' : 's'}, ${errors.length} error${errors.length === 1 ? '' : 's'})`);
    return { ok: mappings.length > 0, loaded, errors };
  }

  disarm() {
    this.armGeneration++;
    this.arming = false;
    this.mappings = [];
    this.active = null;
    this.state = 'idle';
    logLifecycle('[REPLAY] disarmed');
  }

  /**
   * Called from the bridge's onTrackChanged hook. Begins attaching when a mapped audio
   * file lands on a deck.
   */
  onTrackChanged(deck: DeckNumber, fileName: string) {
    const norm = normalizeName(fileName);
    if (this.state === 'idle') return;

    if (this.active && this.active.audioDeck === deck && norm !== normalizeName(this.active.audioFile)) {
      // Audio deck swapped to a different track → tear down.
      logLifecycle(`[REPLAY] deck ${deck} changed track to ${norm}; detaching`);
      this.active = null;
      this.state = this.mappings.length > 0 ? 'armed' : 'idle';
    }

    if (!this.active && (this.state === 'armed' || this.state === 'attaching' || this.state === 'ended')) {
      const rec = this.mappings.find(m => m.audioFile === norm);
      if (rec) {
        this.active = this.startSession(deck, norm, rec);
        this.state = 'attaching';
        logLifecycle(`[REPLAY] attaching: deck ${deck} ← ${rec.logFile}`);
      }
    }
  }

  private startSession(deck: DeckNumber, audioFile: string, rec: MappedRecording) {
    const decks: Record<DeckNumber, DeckState> = {
      1: blankDeck(1), 2: blankDeck(2), 3: blankDeck(3), 4: blankDeck(4),
    };
    const blankTiming = (): SourceTiming => ({ positionAtMs: null, positionRevision: 0, transportRevision: 0, trackId: '' });
    return {
      audioDeck: deck,
      audioFile,
      rec,
      decks,
      cursor: 0,
      selectedCursor: 0,
      statusCursor: 0,
      cursorMs: 0,
      lastClockMs: 0,
      lastClockAtWallMs: Date.now(),
      frozen: false,
      timings: { 1: blankTiming(), 2: blankTiming(), 3: blankTiming(), 4: blankTiming() },
      lastAudioPositionRevision: null as number | null,
      lastAudioTransportRevision: null as number | null,
      audioPlaying: false,
      lastOutputPlay: { 1: null, 2: null, 3: null, 4: null } as Record<DeckNumber, boolean | null>,
      sessionId: ++this.sessionRevision,
      positionEventT: { 1: null, 2: null, 3: null, 4: null } as Record<DeckNumber, number | null>,
      positionEventId: { 1: -1, 2: -1, 3: -1, 4: -1 },
      publishedPositionEventId: { 1: -1, 2: -1, 3: -1, 4: -1 },
    };
  }

  /**
   * Compute simulated decks for the current moment. Called from the snapshot loop and the
   * Art-Net poll. Pass the audio deck's current play+elapsedSec so the engine can drive its
   * cursor and detect freezes.
   */
  tick(audioDeckPlay: boolean, audioDeckElapsedSec: number, audioTiming?: SourceTiming): { decks: Record<DeckNumber, DeckState> } | null {
    if (!this.active) return null;

    const a = this.active;
    const freshPosition = audioTiming
      ? audioTiming.positionAtMs !== null && audioTiming.positionRevision !== a.lastAudioPositionRevision
      : Number.isFinite(audioDeckElapsedSec) && Math.abs(audioDeckElapsedSec * 1000 - a.lastClockMs) > 1;
    const clockMs = freshPosition ? Math.max(0, audioDeckElapsedSec * 1000) : a.lastClockMs;
    const nowMs = Date.now();
    const transportChanged = audioTiming !== undefined && audioTiming.transportRevision !== a.lastAudioTransportRevision;
    if (!audioTiming || transportChanged) {
      a.audioPlaying = audioDeckPlay;
      a.lastAudioTransportRevision = audioTiming?.transportRevision ?? null;
    }

    // Detect freeze: audio deck not playing, or clock has not advanced for the dropout window.
    const moved = Math.abs(clockMs - a.lastClockMs) > 1; // 1ms hysteresis
    if (moved) {
      a.lastClockMs = clockMs;
      a.lastClockAtWallMs = nowMs;
      a.frozen = false;
    }
    const stalled = !a.audioPlaying || (nowMs - a.lastClockAtWallMs > REPLAY_FREEWHEEL_DETECT_MS);

    if (this.state === 'attaching' && a.audioPlaying && clockMs > 0 && audioTiming?.positionAtMs !== null) {
      this.state = 'active';
      logLifecycle(`[REPLAY] active: deck ${a.audioDeck} @ ${a.audioFile}`);
    }

    // End-of-log latch.
    if (this.state === 'active' && clockMs > a.rec.parsed.durationMs) {
      this.state = 'ended';
      logLifecycle('[REPLAY] reached end of log');
    }
    if (this.state === 'ended' && clockMs <= a.rec.parsed.durationMs) this.state = 'active';

    // Apply events up to clockMs. On backward jump, rewind to the latest keyframe per deck ≤ clockMs.
    if (clockMs < a.cursorMs) {
      this.rewindTo(clockMs);
    }
    this.advanceTo(clockMs);

    // Build output deck snapshot.
    const out: Record<DeckNumber, DeckState> = {
      1: { ...a.decks[1] }, 2: { ...a.decks[2] }, 3: { ...a.decks[3] }, 4: { ...a.decks[4] },
    };

    if (!a.audioPlaying || (!audioTiming && stalled) || this.state === 'ended') {
      a.frozen = true;
      for (const d of DECKS) out[d].play = false;
    }

    // Stamp updatedAt fresh so any consumer that watches it sees liveness.
    for (const d of DECKS) out[d].updatedAt = nowMs;

    if (freshPosition) a.lastAudioPositionRevision = audioTiming?.positionRevision ?? null;
    for (const d of DECKS) {
      const timing = a.timings[d];
      const eventT = a.positionEventT[d];
      if (freshPosition && eventT !== null && a.positionEventId[d] !== a.publishedPositionEventId[d]) {
        timing.positionAtMs = (audioTiming?.positionAtMs ?? nowMs) - Math.max(0, clockMs - eventT);
        timing.positionRevision = ++this.positionRevision;
        a.publishedPositionEventId[d] = a.positionEventId[d];
      }
      if (transportChanged || a.lastOutputPlay[d] !== out[d].play) {
        timing.transportRevision = ++this.transportRevision;
        a.lastOutputPlay[d] = out[d].play;
      }
      timing.trackId = 'replay:' + a.sessionId + ':' + d + ':' + out[d].fileName;
    }

    return { decks: out };
  }

  private advanceTo(clockMs: number) {
    if (!this.active) return;
    const a = this.active;
    const evs = a.rec.parsed.deckEvents;
    while (a.cursor < evs.length && evs[a.cursor].t <= clockMs) {
      const e = evs[a.cursor++];
      const update = e.state ?? e.diff;
      if (update && Object.hasOwn(update, 'elapsedSec') && Number.isFinite(update.elapsedSec)) {
        a.positionEventT[e.n] = e.t;
        a.positionEventId[e.n] = a.cursor;
      }
      if (e.state) {
        a.decks[e.n] = { ...e.state };
      } else if (e.diff) {
        applyDiff(a.decks[e.n], e.diff as any);
      }
      a.cursorMs = e.t;
    }
    if (clockMs > a.cursorMs) a.cursorMs = clockMs;
  }

  private rewindTo(clockMs: number) {
    if (!this.active) return;
    const a = this.active;
    // Reset all decks and the cursor; advanceTo() will replay forward to clockMs.
    // Logs are small enough (typically <500k events for a multi-hour show) that the linear
    // re-apply takes tens of ms. Per-deck keyframe seeding adds complexity for no real win.
    for (const d of DECKS) {
      a.decks[d] = blankDeck(d);
      a.positionEventT[d] = null;
      a.positionEventId[d] = -1;
      a.publishedPositionEventId[d] = -1;
    }
    a.cursor = 0;
    a.cursorMs = 0;
    this.advanceTo(clockMs);
  }
}
