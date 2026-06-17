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
}

export type MainToWorker =
  | { type: 'init'; opts: ArtNetWorkerInitOptions }
  | { type: 'updateDeck'; deck: DeckState | null }
  | { type: 'setSendWhenStopped'; enabled: boolean }
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
