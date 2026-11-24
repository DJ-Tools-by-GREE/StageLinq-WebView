import { updateConfigFile, readConfigFile } from './jsonFile.js';
import { logError, logLifecycle } from './logging.js';
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

export class GlobalSettingsStore {
  private cached: GlobalSettings;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private filePath: string, initial: GlobalSettings) {
    this.cached = structuredClone(initial);
  }

  get(): GlobalSettings {
    return structuredClone(this.cached);
  }

  reload(apply: (config: Record<string, unknown>) => void | Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      const config = await readConfigFile(this.filePath);
      const settings = { freewheel: readFreewheelFromConfig(config) };
      await apply(config);
      this.cached = settings;
    });
  }

  setFreewheel(patch: Partial<FreewheelConfig>): Promise<FreewheelConfig> {
    return this.enqueue(async () => {
      const merged: FreewheelConfig = {
        enable_freewheeling: typeof patch.enable_freewheeling === 'boolean'
          ? patch.enable_freewheeling : this.cached.freewheel.enable_freewheeling,
        max_duration_sec: patch.max_duration_sec !== undefined
          ? clampDuration(patch.max_duration_sec) : this.cached.freewheel.max_duration_sec,
      };
      await updateConfigFile(this.filePath, config => applyFreewheelToConfig(config, merged));
      this.cached = { freewheel: merged };
      logLifecycle('[CONFIG] Persisted freewheel settings to', this.filePath);
      return { ...merged };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writing.then(operation);
    this.writing = next.catch(err => {
      logError('[CONFIG] Settings operation failed:', err?.message || err);
    });
    return next;
  }
}
