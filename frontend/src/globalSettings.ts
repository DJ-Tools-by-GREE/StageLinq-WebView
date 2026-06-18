// Backend-owned, non-per-user settings. Surfaced in the Settings modal under
// "Global settings" / "Controls". Writes go straight to the backend, which
// pushes the new values into the Art-Net worker and persists them to config.json.

export interface FreewheelSettings {
  enable_freewheeling: boolean;
  max_duration_sec: number;
}

export interface GlobalSettings {
  freewheel: FreewheelSettings;
}

export interface GlobalSettingsMeta {
  freewheel_max_duration_sec: { min: number; max: number };
}

export interface GlobalSettingsResponse extends GlobalSettings {
  meta: GlobalSettingsMeta;
}

export const FREEWHEEL_DURATION_FALLBACK = { min: 0, max: 3600 };

export async function fetchGlobalSettings(signal?: AbortSignal): Promise<GlobalSettingsResponse> {
  const r = await fetch('/api/global-settings', { signal });
  if (!r.ok) throw new Error(`GET /api/global-settings failed (${r.status})`);
  return r.json() as Promise<GlobalSettingsResponse>;
}

export async function putFreewheelSettings(
  patch: Partial<FreewheelSettings>,
): Promise<FreewheelSettings> {
  const r = await fetch('/api/global-settings/freewheel', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`PUT /api/global-settings/freewheel failed (${r.status})`);
  const j = (await r.json()) as { freewheel: FreewheelSettings };
  return j.freewheel;
}

export interface ReloadConfigResult {
  ok: boolean;
  sourcePath?: string | null;
  offsetEntries?: number;
  error?: string;
}

// Mid-show config reload. Mirrors Ctrl+R on the backend TTY. Never throws —
// non-2xx and network errors are surfaced as `{ ok: false, error }` so the
// caller can render the failure inline instead of a stack trace.
export async function postReloadConfig(): Promise<ReloadConfigResult> {
  try {
    const r = await fetch('/api/config/reload', { method: 'POST' });
    const j = (await r.json().catch(() => ({}))) as ReloadConfigResult;
    if (!r.ok) {
      return { ok: false, error: j?.error || `HTTP ${r.status}` };
    }
    return j;
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
