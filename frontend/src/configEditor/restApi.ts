import type { AppConfig, PlaylistEntry } from './editorTypes.js';
import { DEFAULT_CONFIG } from './defaults.js';

/**
 * REST adapter that talks to the StageLinq-WebView backend.
 *
 * GET  /api/config  →  { config: <raw parsed JSON>, sourcePath: string }
 * PUT  /api/config  →  body is the full canonical-shape config (string),
 *                      backend writes atomically. Reload (Ctrl+R or restart)
 *                      is the operator's job — this endpoint is intentionally
 *                      write-only so a Save mid-show doesn't surprise the
 *                      runtime.
 *
 * The migration / serialization helpers below are the original
 * stagelinq-config-editor logic, lifted verbatim. The only change is that
 * `openConfigFile` / `saveAsNewFile` are replaced by `loadConfig` /
 * `saveConfig` that use fetch instead of the File System Access API.
 */

/**
 * Normalize a freshly-parsed config:
 *   - apply defaults for any missing top-level section
 *   - migrate legacy `target_ip` → `target_ips: [target_ip]` for timecode and osc
 *   - drop the legacy singular field once the array is populated
 *   - migrate legacy note field `show_secs_before_transition_starts` →
 *     `show_secs_after_load: 0` (semantics changed: now timed off track-load
 *     rather than transition-start, so the old number is discarded). Returns
 *     `legacyNoteFieldFound` so the caller can warn the operator.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateConfig(raw: any): { config: AppConfig; legacyNoteFieldFound: boolean } {
  const src = (raw && typeof raw === 'object') ? raw : {};

  const tc = { ...(src.timecode ?? {}) };
  if (!Array.isArray(tc.target_ips) || tc.target_ips.length === 0) {
    if (typeof tc.target_ip === 'string' && tc.target_ip.length > 0) {
      tc.target_ips = [tc.target_ip];
    } else {
      tc.target_ips = [];
    }
  }
  delete tc.target_ip;

  const osc = { ...(src.osc ?? {}) };
  if (!Array.isArray(osc.target_ips) || osc.target_ips.length === 0) {
    if (typeof osc.target_ip === 'string' && osc.target_ip.length > 0) {
      osc.target_ips = [osc.target_ip];
    } else {
      osc.target_ips = [];
    }
  }
  delete osc.target_ip;

  let legacyNoteFieldFound = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playlists = (Array.isArray(src.playlists) ? src.playlists : []).map((pl: any) => ({
    ...pl,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: Array.isArray(pl?.content)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? pl.content.map((entry: any) => {
          if (!entry?.note) return entry;
          const note = { ...entry.note };
          if ('show_secs_before_transition_starts' in note) {
            legacyNoteFieldFound = true;
            delete note.show_secs_before_transition_starts;
          }
          if (typeof note.show_secs_after_load !== 'number') {
            note.show_secs_after_load = 0;
          }
          return { ...entry, note };
        })
      : pl?.content,
  }));

  const recordings = Array.isArray(src.recordings)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? src.recordings.map((r: any) => ({
        audio_file: typeof r?.audio_file === 'string' ? r.audio_file : '',
        log_file: typeof r?.log_file === 'string' ? r.log_file : '',
      }))
    : [];

  const config: AppConfig = {
    current_playlist: src.current_playlist ?? DEFAULT_CONFIG.current_playlist,
    waveform: { ...DEFAULT_CONFIG.waveform, ...(src.waveform ?? {}) },
    freewheel: { ...DEFAULT_CONFIG.freewheel, ...(src.freewheel ?? {}) },
    sacn_sim: { ...DEFAULT_CONFIG.sacn_sim, ...(src.sacn_sim ?? {}) },
    display: { ...DEFAULT_CONFIG.display, ...(src.display ?? {}) },
    logging: { ...DEFAULT_CONFIG.logging, ...(src.logging ?? {}) },
    timecode: {
      fps: tc.fps ?? DEFAULT_CONFIG.timecode.fps,
      target_ips: tc.target_ips,
      target_port: tc.target_port ?? DEFAULT_CONFIG.timecode.target_port,
      stream_id: tc.stream_id ?? DEFAULT_CONFIG.timecode.stream_id,
    },
    control_input: { ...DEFAULT_CONFIG.control_input, ...(src.control_input ?? {}) },
    osc: {
      enabled: osc.enabled ?? DEFAULT_CONFIG.osc.enabled,
      target_ips: osc.target_ips,
      target_port: osc.target_port ?? DEFAULT_CONFIG.osc.target_port,
      speedmaster: osc.speedmaster ?? DEFAULT_CONFIG.osc.speedmaster,
    },
    playlists,
    recordings,
  };
  return { config, legacyNoteFieldFound };
}

/**
 * Serialize a single playlist entry. `mashup_only` is only emitted when
 * truthy, so existing configs that never set the flag stay diff-clean.
 */
function orderedEntry(entry: PlaylistEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    song_index: entry.song_index,
    offset_sec: entry.offset_sec,
    offset_frame: entry.offset_frame,
    note: {
      description: entry.note.description,
      show_secs_after_load: entry.note.show_secs_after_load,
    },
  };
  if (entry.mashup_only === true) {
    out.mashup_only = true;
  }
  return out;
}

/**
 * Serialize config in the canonical key order so diffs against the reference
 * config.json stay small. Top-level order:
 *   current_playlist, waveform, freewheel, sacn_sim, display, logging,
 *   timecode, control_input, osc, playlists
 *
 * Nested sections also use a fixed order. The legacy `target_ip` field is
 * omitted whenever `target_ips` is non-empty.
 */
function orderedConfig(config: AppConfig): Record<string, unknown> {
  const tc: Record<string, unknown> = {
    fps: config.timecode.fps,
    target_ips: config.timecode.target_ips,
    target_port: config.timecode.target_port,
    stream_id: config.timecode.stream_id,
  };
  if (config.timecode.target_ips.length === 0 && config.timecode.target_ip) {
    tc.target_ip = config.timecode.target_ip;
  }

  const osc: Record<string, unknown> = {
    enabled: config.osc.enabled,
    target_ips: config.osc.target_ips,
    target_port: config.osc.target_port,
    speedmaster: config.osc.speedmaster,
  };
  if (config.osc.target_ips.length === 0 && config.osc.target_ip) {
    osc.target_ip = config.osc.target_ip;
  }

  return {
    current_playlist: config.current_playlist,
    waveform: { all_tracks: config.waveform.all_tracks },
    freewheel: {
      enable_freewheeling: config.freewheel.enable_freewheeling,
      max_duration_sec: config.freewheel.max_duration_sec,
    },
    sacn_sim: { enabled: config.sacn_sim.enabled },
    display: {
      dashboard: config.display.dashboard,
      artnet: config.display.artnet,
      info: config.display.info,
    },
    logging: {
      lifecycle: config.logging.lifecycle,
      playback: config.logging.playback,
      discover: config.logging.discover,
      discoverSpeed: config.logging.discoverSpeed,
      bpmDebug: config.logging.bpmDebug,
      uiOut: config.logging.uiOut,
      errors: config.logging.errors,
      cues: config.logging.cues,
      artnetStats: config.logging.artnetStats,
    },
    timecode: tc,
    control_input: {
      mode: config.control_input.mode,
      universe: config.control_input.universe,
      address: config.control_input.address,
    },
    osc,
    playlists: config.playlists.map(pl => ({
      name: pl.name,
      content: pl.content.map(orderedEntry),
    })),
    recordings: config.recordings.map(r => ({
      audio_file: r.audio_file,
      log_file: r.log_file,
    })),
  };
}

export function serializeConfig(config: AppConfig): string {
  return JSON.stringify(orderedConfig(config), null, 4);
}

export interface LoadConfigResult {
  config: AppConfig;
  sourcePath: string;
  legacyNoteFieldFound: boolean;
}

/** GET /api/config and migrate the parsed JSON. Throws on HTTP error. */
export async function loadConfig(signal?: AbortSignal): Promise<LoadConfigResult> {
  const res = await fetch('/api/config', { signal });
  if (!res.ok) {
    throw new Error(`GET /api/config failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as { config: unknown; sourcePath: string };
  const { config, legacyNoteFieldFound } = migrateConfig(body.config);
  return { config, sourcePath: body.sourcePath, legacyNoteFieldFound };
}

/** PUT /api/config — backend writes atomically. Throws on HTTP error. */
export async function saveConfig(config: AppConfig): Promise<void> {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: serializeConfig(config),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error ? ` — ${j.error}` : '';
    } catch {
      // ignore body parse failure; fall back to status line
    }
    throw new Error(`PUT /api/config failed: ${res.status} ${res.statusText}${detail}`);
  }
}
