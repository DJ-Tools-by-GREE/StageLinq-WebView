import type { DeckState, SourceTiming } from './types.js';
import { ARTNET_DRIFT_THRESHOLD_RATIO } from './constants.js';

/** Comparable across Node worker threads and unaffected by wall-clock adjustments. */
export function monotonicNowMs(): number {
  return performance.timeOrigin + performance.now();
}

export interface TimelineOptions {
  fps: number;
  staleThresholdMs: number;
  reconnecting: boolean;
  enableFreewheeling: boolean;
  freewheelMaxDurationSec: number;
}

export interface TimelineTick {
  frames: number | null;
  corrected: boolean;
  freewheelActive: boolean;
  stale: boolean;
  expired: boolean;
  source: DeckState | null;
}

function playRate(state: DeckState): number {
  const rate = 1 + state.speedState / 100;
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

export class TimecodeTimeline {
  private source: DeckState | null = null;
  private timing: SourceTiming | null = null;
  private frames: number | null = null;
  private lastTickMs: number | null = null;
  private lastRate = 1;
  private staleSinceMs: number | null = null;
  private explicitlyPaused = false;
  private awaitingResumePosition = false;

  reset(): void {
    this.source = null;
    this.timing = null;
    this.frames = null;
    this.lastTickMs = null;
    this.lastRate = 1;
    this.staleSinceMs = null;
    this.explicitlyPaused = false;
    this.awaitingResumePosition = false;
  }

  tick(state: DeckState | null, timing: SourceTiming | null, nowMs: number, opts: TimelineOptions): TimelineTick {
    let newPosition = false;
    let discontinuity = false;
    // An explicit stop is authoritative even during reconnect before a new
    // sample. Reset/watchdog blanks keep the transport revision unchanged.
    if (state && timing && this.source && this.timing && !state.play &&
      timing.transportRevision > this.timing.transportRevision) {
      this.source.play = false;
      this.explicitlyPaused = true;
      this.timing.transportRevision = timing.transportRevision;
    }
    const validPosition = state && timing && timing.positionAtMs !== null &&
      Number.isFinite(timing.positionAtMs) && timing.positionAtMs <= nowMs &&
      Number.isFinite(state.elapsedSec) && state.elapsedSec >= 0;

    if (validPosition && state && timing) {
      const trackChanged = !!this.timing && timing.trackId !== this.timing.trackId;
      const changed = !this.timing || timing.positionRevision !== this.timing.positionRevision || trackChanged;
      const newer = !this.timing || trackChanged || timing.positionAtMs! >= this.timing.positionAtMs!;
      if (changed && newer) {
        discontinuity = !!this.source && (timing.trackId !== this.timing?.trackId || state.elapsedSec < this.source.elapsedSec);
        const transportChanged = !this.timing || trackChanged || timing.transportRevision !== this.timing.transportRevision;
        if (transportChanged) this.explicitlyPaused = !state.play;
        const playing = transportChanged || !this.source ? state.play : this.source.play;
        this.source = { ...state, play: playing };
        this.awaitingResumePosition = false;
        this.timing = { ...timing };
        newPosition = true;
      } else if (this.source && this.timing && !changed && timing.trackId === this.timing.trackId) {
        // Metadata never refreshes the position clock. Only a real transport event
        // can stop freewheel; a watchdog's synthetic play=false must not stop it.
        if (timing.transportRevision !== this.timing.transportRevision) {
          if (state.play && !this.source.play) this.awaitingResumePosition = true;
          this.source.play = state.play;
          this.explicitlyPaused = !state.play;
          this.timing.transportRevision = timing.transportRevision;
        }
        if (!opts.reconnecting && state.fileName === this.source.fileName) {
          this.source.speedState = state.speedState;
          this.source.totalSec = state.totalSec;
        }
      }
    }

    const source = this.source;
    const sourceAtMs = this.timing?.positionAtMs;
    const stale = opts.reconnecting || sourceAtMs == null || nowMs - sourceAtMs > opts.staleThresholdMs;
    if (stale) this.staleSinceMs ??= nowMs;
    else this.staleSinceMs = null;
    const expired = !!source && sourceAtMs != null && stale && this.staleSinceMs !== null &&
      (opts.freewheelMaxDurationSec <= 0 || nowMs - this.staleSinceMs > opts.freewheelMaxDurationSec * 1000);
    const result: TimelineTick = { frames: null, corrected: false, freewheelActive: false, stale, expired, source };
    if (!source || sourceAtMs == null || this.awaitingResumePosition) return result;

    if (this.explicitlyPaused || (!stale && !source.play)) {
      this.frames = source.elapsedSec * opts.fps;
      this.lastTickMs = null;
      return result;
    }
    if (stale && (!opts.enableFreewheeling || expired)) {
      this.lastTickMs = null;
      return result;
    }

    const rate = playRate(source);
    const projectedFrames = source.elapsedSec * opts.fps +
      Math.max(0, nowMs - sourceAtMs) / 1000 * opts.fps * rate;
    if (this.lastTickMs === null) {
      // A stale source may continue an established timeline, but cannot start one.
      if (stale || !source.play) return result;
      this.frames = projectedFrames;
      this.lastTickMs = nowMs;
      this.lastRate = rate;
      return result;
    }

    this.frames = (this.frames ?? projectedFrames) + Math.max(0, nowMs - this.lastTickMs) / 1000 * opts.fps * this.lastRate;
    this.lastTickMs = nowMs;
    this.lastRate = rate;

    // Reconcile only on a new position, extrapolated from its capture timestamp.
    // Unchanged samples between BeatInfo packets cannot pull the timeline backward.
    if (newPosition && !stale) {
      if (discontinuity || Math.abs(projectedFrames - this.frames) > opts.fps * ARTNET_DRIFT_THRESHOLD_RATIO) {
        this.frames = projectedFrames;
        result.corrected = true;
      } else if (this.frames < projectedFrames) {
        this.frames = projectedFrames;
      }
    }

    result.frames = this.frames;
    result.freewheelActive = stale;
    return result;
  }
}
