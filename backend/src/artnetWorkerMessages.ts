import type { DeckNumber, DeckState, SourceTiming } from './types.js';

export interface ArtNetWorkerInitOptions {
  enabled: boolean;
  targetIps: string[];
  port: number;
  fps: number;
  sendHz: number;
  fpsType: number;
  streamId: number;
  latencyCompMs: number;
  /** When false, the worker stops emitting TC immediately on stale (no freewheel at all). */
  enableFreewheeling: boolean;
  /** Max seconds to freewheel after the source went stale; past this the worker goes silent. */
  freewheelMaxDurationSec: number;
  /**
   * Milliseconds of beat silence past which the worker considers the source stale and
   * engages freewheel. Mirrors `FREEWHEEL_STALE_THRESHOLD_MS` in constants.ts but is
   * passed via init so the worker doesn't need a separate import path for tunables.
   */
  freewheelStaleThresholdMs: number;
}

export type TrackOffsetMap = Record<string, { offsetSec: number; offsetFrame: number }>;

/** Metadata updates carry the last position timestamp unchanged; only BeatInfo advances it. */
export type MainToWorker =
  | { type: 'init'; opts: ArtNetWorkerInitOptions }
  | { type: 'setSource'; decks: Record<DeckNumber, DeckState>; timings: Record<DeckNumber, SourceTiming>; offsets: TrackOffsetMap }
  /** sACN selected this deck (or null = no deck selected → TC silent). */
  | { type: 'setSelectedDeck'; deck: DeckNumber | null }
  /** Replace the per-track offset map (boot, config reload). */
  | { type: 'setTrackOffsets'; offsets: TrackOffsetMap }
  /** Push one deck's full state. Sent on every bridge state mutation when not replaying. */
  | { type: 'pushDeckState'; deck: DeckNumber; state: DeckState; timing: SourceTiming }
  /** Replay snapshots preserve the audio source's timestamp when its clock has not advanced. */
  | { type: 'pushAllDeckStates'; decks: Record<DeckNumber, DeckState>; timings: Record<DeckNumber, SourceTiming> }
  /** Bridge is in the middle of a reconnect cycle — force stale on the worker. */
  | { type: 'setReconnecting'; reconnecting: boolean }
  | { type: 'setFreewheel'; enableFreewheeling: boolean; freewheelMaxDurationSec: number }
  | { type: 'shutdown' };

export interface TickStats {
  windowMs: number;
  count: number;
  avgIntervalMs: number;
  p50: number;
  p95: number;
  maxMs: number;
  maxBehindMs: number;
  targetMs: number;
  hardStalls: number;
  socketRecoveries: number;
}

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'initError'; message: string }
  | { type: 'log'; level: 'info' | 'success' | 'warn' | 'error'; msg: string }
  /**
   * Periodic, healthy tick-stats heartbeat (every ARTNET_TICK_STATS_LOG_INTERVAL_MS).
   * Emitted as its own type — separate from `log` — so the main-thread harness can gate
   * it on a dedicated `logging.artnetStats` config flag without affecting warns.
   * The degraded variant (avg below target / hard stalls / max behind too high) is sent as
   * a `log` with level `'warn'` instead, and is NOT gated by the stats flag.
   */
  | { type: 'statsHeartbeat'; msg: string; stats: TickStats }
  | { type: 'stats'; stats: TickStats }
  | { type: 'tcDisplay'; text: string; hms: string }
  /**
   * Edge-triggered freewheel state. The worker emits this exactly when the
   * boolean flips, so the main thread doesn't have to mirror the gate logic
   * (stale ∧ enabled ∧ within max-duration ∧ was-running). The UI uses it to
   * show a tag that appears the same tick freewheel engages and disappears
   * the same tick it stops — including when freewheel times out and the
   * worker goes silent past max_duration_sec.
   */
  | { type: 'freewheelState'; active: boolean };
