import path from 'node:path';
import type { DeckNumber, DeckState, ReplayStatus, ReplayState, StageLinqStatus, SourceTiming } from './types.js';
import { logLifecycle } from './logging.js';
import { REPLAY_FREEWHEEL_DETECT_MS, RECORDING_CHECKPOINT_EVENTS } from './constants.js';
import { parseRecording, blankRecordedDeck as blankDeck, blankRecordedTiming, applyRecordedEvent, latestAt, type ParsedLog, type RecordedTiming } from './recordingLog.js';

// Recording filename normalization mirrors index.ts → normalizeTrackName(): basename only.
function normalizeName(name: string): string {
  return path.basename(String(name ?? '').trim());
}

const DECKS: DeckNumber[] = [1, 2, 3, 4];

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
  private armAbort: AbortController | null = null;
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
    recordedTimings: Record<DeckNumber, RecordedTiming>;
    publishedTransportRevision: Record<DeckNumber, number>;
    lastAudioGate: boolean | null;
  } | null = null;

  constructor(opts: ReplayOptions) { this.opts = opts; }

  configureMappedAudioFiles(rawMappings: Array<{ audio_file?: string; log_file?: string }>): void {
    this.mappedAudioFiles = new Set((Array.isArray(rawMappings) ? rawMappings : [])
      .map(m => normalizeName(m?.audio_file ?? '')).filter(Boolean));
  }

  isArmedOrActive(): boolean { return this.arming || this.state !== 'idle'; }

  getTrackOffsets(): ParsedLog['trackOffsets'] | null {
    if (!this.isOverridingOutputs() || !this.active) return null;
    return latestAt(this.active.rec.parsed.configEvents, this.active.cursorMs)?.trackOffsets ?? this.active.rec.parsed.trackOffsets;
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
    this.armAbort?.abort();
    const abort = new AbortController();
    this.armAbort = abort;
    const generation = ++this.armGeneration;
    this.arming = true;
    this.configureMappedAudioFiles(rawMappings);

    const loaded: Array<{ audioFile: string; logFile: string; durationMs: number }> = [];
    const errors: Array<{ audioFile?: string; logFile?: string; error: string }> = [];
    const mappings: MappedRecording[] = [];
    const parsedFiles = new Map<string, Promise<ParsedLog>>();

    for (const m of Array.isArray(rawMappings) ? rawMappings : []) {
      const audio = normalizeName(m?.audio_file ?? '');
      const log = normalizeName(m?.log_file ?? '');
      if (!audio || !log) {
        errors.push({ audioFile: m?.audio_file, logFile: m?.log_file, error: 'audio_file and log_file are both required' });
        continue;
      }
      const fullPath = path.join(this.opts.recordingsDir, log);
      try {
        if (abort.signal.aborted) break;
        let promise = parsedFiles.get(fullPath);
        if (!promise) { promise = parseRecording(fullPath, { signal: abort.signal }); parsedFiles.set(fullPath, promise); }
        const parsed = await promise;
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
    this.armAbort?.abort();
    this.armAbort = null;
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
      recordedTimings: { 1: blankRecordedTiming(), 2: blankRecordedTiming(), 3: blankRecordedTiming(), 4: blankRecordedTiming() },
      publishedTransportRevision: { 1: -1, 2: -1, 3: -1, 4: -1 },
      lastAudioGate: null as boolean | null,
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
    const audioGate = !a.audioPlaying || (!audioTiming && stalled) || this.state === 'ended';
    for (const d of DECKS) {
      const timing = a.timings[d];
      timing.transportPlay = audioGate ? false : a.recordedTimings[d].transportPlay ?? out[d].play;
      const eventT = a.positionEventT[d];
      if (freshPosition && eventT !== null && a.positionEventId[d] !== a.publishedPositionEventId[d]) {
        timing.positionAtMs = (audioTiming?.positionAtMs ?? nowMs) - Math.max(0, clockMs - eventT);
        timing.positionRevision = ++this.positionRevision;
        a.publishedPositionEventId[d] = a.positionEventId[d];
        timing.trackId = 'replay:' + a.sessionId + ':' + d + ':' + a.recordedTimings[d].trackId;
      }
      if (transportChanged || a.lastAudioGate !== audioGate || a.publishedTransportRevision[d] !== a.recordedTimings[d].transportRevision) {
        timing.transportRevision = ++this.transportRevision;
        a.lastOutputPlay[d] = out[d].play;
        a.publishedTransportRevision[d] = a.recordedTimings[d].transportRevision;
      }
    }
    a.lastAudioGate = audioGate;

    return { decks: out };
  }

  private advanceTo(clockMs: number) {
    if (!this.active) return;
    const a = this.active;
    const evs = a.rec.parsed.deckEvents;
    const checkpoint = latestAt(a.rec.parsed.checkpoints, clockMs);
    if (checkpoint && checkpoint.cursor > a.cursor + RECORDING_CHECKPOINT_EVENTS) this.restoreCheckpoint(clockMs);
    while (a.cursor < evs.length && evs[a.cursor].t <= clockMs) {
      const e = evs[a.cursor++];
      applyRecordedEvent(e, a.decks, a.recordedTimings, a.positionEventId, a.cursor);
      a.positionEventT[e.n] = a.recordedTimings[e.n].positionT;
      a.cursorMs = e.t;
    }
    if (clockMs > a.cursorMs) a.cursorMs = clockMs;
  }

  private rewindTo(clockMs: number) {
    this.restoreCheckpoint(clockMs);
    this.advanceTo(clockMs);
  }

  private restoreCheckpoint(clockMs: number) {
    if (!this.active) return;
    const a = this.active;
    const checkpoint = latestAt(a.rec.parsed.checkpoints, clockMs);
    for (const d of DECKS) {
      a.decks[d] = checkpoint ? { ...checkpoint.decks[d] } : blankDeck(d);
      a.recordedTimings[d] = checkpoint ? { ...checkpoint.timings[d] } : blankRecordedTiming();
      a.positionEventT[d] = a.recordedTimings[d].positionT;
      a.positionEventId[d] = checkpoint?.positionEventIds[d] ?? -1;
      a.publishedPositionEventId[d] = -1;
      a.publishedTransportRevision[d] = -1;
    }
    a.cursor = checkpoint?.cursor ?? 0;
    a.cursorMs = checkpoint?.t ?? 0;
  }
}
