import fs from 'node:fs/promises';
import { logError, logLifecycle, GRN, RED, RST, YEL } from './logging.js';
import { DEFAULT_ENABLE_FREEWHEELING, DEFAULT_FREEWHEEL_MAX_DURATION_SEC } from './constants.js';

/**
 * Global, non-per-user settings persisted into the project's `config.json`.
 *
 * Today this only covers the `freewheel` block (Art-Net behaviour while StageLinq
 * is stale). Designed to grow: add another well-known top-level section to
 * `GlobalSettings`, the loader, and the persist hook below.
 *
 * The store re-uses the on-disk `config.json` rather than a separate file so the
 * already-running config reload (Ctrl+R / next backend boot) sees the same
 * source of truth and operators editing the JSON by hand are not surprised.
 */

export interface FreewheelConfig {
  enable_freewheeling: boolean;
  max_duration_sec: number;
}

export interface GlobalSettings {
  freewheel: FreewheelConfig;
}

export const FREEWHEEL_MIN_DURATION_SEC = 0;
export const FREEWHEEL_MAX_DURATION_SEC = 3600;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clampDuration(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_FREEWHEEL_MAX_DURATION_SEC;
  return Math.max(FREEWHEEL_MIN_DURATION_SEC, Math.min(FREEWHEEL_MAX_DURATION_SEC, n));
}

export function readFreewheelFromConfig(cfg: unknown): FreewheelConfig {
  const fw = isPlainObject(cfg) && isPlainObject((cfg as any).freewheel)
    ? ((cfg as any).freewheel as Record<string, unknown>)
    : {};
  return {
    enable_freewheeling:
      typeof fw.enable_freewheeling === 'boolean' ? fw.enable_freewheeling : DEFAULT_ENABLE_FREEWHEELING,
    max_duration_sec: clampDuration(fw.max_duration_sec),
  };
}

export function applyFreewheelToConfig<T extends Record<string, unknown>>(cfg: T, fw: FreewheelConfig): T {
  (cfg as any).freewheel = { ...fw };
  return cfg;
}

/**
 * Atomically rewrite `config.json` with a mutated copy. Reads the current file
 * as raw JSON (NOT through stripJsonComments — we want to round-trip cleanly).
 * If the on-disk file contains JS-style comments, they will be lost on write
 * — config.json today does not, and the in-app editor is the deliberate way to
 * turn this knob, so that's an acceptable trade for keeping the writer trivial.
 */
export class GlobalSettingsStore {
  private filePath: string;
  private cached: GlobalSettings;
  private writing: Promise<void> = Promise.resolve();

  constructor(filePath: string, initial: GlobalSettings) {
    this.filePath = filePath;
    this.cached = initial;
  }

  get(): GlobalSettings {
    return { freewheel: { ...this.cached.freewheel } };
  }

  /** Re-point the store at a (possibly different) config file and seed the cache from it. */
  reset(filePath: string, settings: GlobalSettings): void {
    this.filePath = filePath;
    this.cached = { freewheel: { ...settings.freewheel } };
  }

  async setFreewheel(next: Partial<FreewheelConfig>): Promise<FreewheelConfig> {
    const merged: FreewheelConfig = {
      enable_freewheeling:
        typeof next.enable_freewheeling === 'boolean'
          ? next.enable_freewheeling
          : this.cached.freewheel.enable_freewheeling,
      max_duration_sec:
        next.max_duration_sec !== undefined
          ? clampDuration(next.max_duration_sec)
          : this.cached.freewheel.max_duration_sec,
    };
    this.cached = { freewheel: merged };
    await this.persist();
    return { ...merged };
  }

  private async persist(): Promise<void> {
    const next = this.writing.then(async () => {
      let parsed: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(this.filePath, 'utf8');
        const obj = JSON.parse(raw);
        if (isPlainObject(obj)) parsed = obj as Record<string, unknown>;
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          logLifecycle(`${YEL}[CONFIG] Could not re-read ${this.filePath} before write (${err?.message ?? err}); rewriting from cache.${RST}`);
        }
      }
      applyFreewheelToConfig(parsed, this.cached.freewheel);
      const tmp = `${this.filePath}.tmp`;
      const text = JSON.stringify(parsed, null, 4) + '\n';
      await fs.writeFile(tmp, text, 'utf8');
      await fs.rename(tmp, this.filePath);
      logLifecycle(`${GRN}[CONFIG] Persisted freewheel settings to ${this.filePath}${RST}`);
    });
    this.writing = next.catch((err) => {
      logError(`${RED}[CONFIG] Failed to persist freewheel settings to ${this.filePath}:${RST}`, err?.message || err);
    });
    return this.writing;
  }
}
