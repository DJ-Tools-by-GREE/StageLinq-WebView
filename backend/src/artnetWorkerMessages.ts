import type { DeckState } from './types.js';

export interface ArtNetWorkerInitOptions {
  enabled: boolean;
  targetIps: string[];
  port: number;
  fps: number;
  sendHz: number;
  fpsType: number;
  streamId: number;
  latencyCompMs: number;
  sendWhenStopped: boolean;
  /** When false, the worker stops emitting TC immediately on stale (no freewheel at all). */
  enableFreewheeling: boolean;
  /** Max seconds to freewheel after the source went stale; past this the worker goes silent. */
  freewheelMaxDurationSec: number;
}

export type MainToWorker =
  | { type: 'init'; opts: ArtNetWorkerInitOptions }
  /**
   * Deck-state poll from the main thread. `stale === true` means StageLinq is no longer
   * delivering beat updates (disconnected/reconnecting). The worker freezes the cached
   * deck snapshot and freewheels its timeline forward at the last-known speedState until
   * fresh beats resume — so the lighting console keeps seeing a smoothly advancing TC
   * across a brief drop instead of stalling and snapping back.
   */
  | { type: 'updateDeck'; deck: DeckState | null; stale: boolean }
  | { type: 'setSendWhenStopped'; enabled: boolean }
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
  | { type: 'tcDisplay'; text: string; hms: string };
