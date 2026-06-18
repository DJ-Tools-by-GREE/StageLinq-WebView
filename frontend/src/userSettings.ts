// Frontend-side user UI settings model. Open-ended: backend stores arbitrary
// JSON keyed per user, frontend applies typed defaults when fields are missing.

export const FIXED_USERS = ['Default User', 'Jan', 'Dennis'] as const;
export type UserName = typeof FIXED_USERS[number];

export const ROLES = ['Viewer', 'DJ', 'Lighting & Tech'] as const;
export type Role = typeof ROLES[number];
export const DEFAULT_ROLE: Role = 'Viewer';

export const DEFAULT_DETAIL_ZOOM_SEC = 10;
export const DETAIL_ZOOM_MIN = 4;
export const DETAIL_ZOOM_MAX = 30;

// Track-note popup default: off everywhere EXCEPT users whose role is "DJ",
// where it defaults on. An explicit user choice (showTrackNotes set on the
// settings object) always wins over the role-derived default.
export const DEFAULT_SHOW_TRACK_NOTES = false;

export interface UserSettings {
  detailZoomSec?: number;
  showTrackNotes?: boolean;
  role?: Role;
  // Add more fields freely — server stores whatever shape we send.
}

export type UsersMap = Record<UserName, UserSettings>;

export const ACTIVE_USER_STORAGE_KEY = 'stagelinq.activeUser';

export function clampZoom(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_DETAIL_ZOOM_SEC;
  return Math.min(DETAIL_ZOOM_MAX, Math.max(DETAIL_ZOOM_MIN, Math.round(n)));
}

export function isUserName(s: string | null | undefined): s is UserName {
  return s != null && (FIXED_USERS as readonly string[]).includes(s);
}

export function isRole(s: string | null | undefined): s is Role {
  return s != null && (ROLES as readonly string[]).includes(s);
}

export function loadActiveUser(): UserName {
  try {
    const raw = window.localStorage.getItem(ACTIVE_USER_STORAGE_KEY);
    if (isUserName(raw)) return raw;
  } catch {}
  return 'Default User';
}

export function saveActiveUser(name: UserName): void {
  try {
    window.localStorage.setItem(ACTIVE_USER_STORAGE_KEY, name);
  } catch {}
}

export function effectiveZoom(settings: UserSettings | undefined): number {
  if (!settings) return DEFAULT_DETAIL_ZOOM_SEC;
  return clampZoom(settings.detailZoomSec ?? DEFAULT_DETAIL_ZOOM_SEC);
}

export function effectiveRole(settings: UserSettings | undefined): Role {
  if (!settings) return DEFAULT_ROLE;
  return isRole(settings.role) ? settings.role : DEFAULT_ROLE;
}

// Explicit user choice wins. Otherwise: DJ → on, everyone else → off.
export function effectiveShowTrackNotes(settings: UserSettings | undefined): boolean {
  if (settings && typeof settings.showTrackNotes === 'boolean') {
    return settings.showTrackNotes;
  }
  return effectiveRole(settings) === 'DJ';
}

export async function fetchAllUsers(signal?: AbortSignal): Promise<UsersMap> {
  const res = await fetch('/api/users', { signal });
  if (!res.ok) throw new Error(`GET /api/users → ${res.status}`);
  const body = await res.json() as { users: Array<{ name: string; settings: UserSettings }> };
  const out = {} as UsersMap;
  for (const name of FIXED_USERS) out[name] = {};
  for (const u of body.users ?? []) {
    if (isUserName(u.name)) out[u.name] = { ...u.settings };
  }
  return out;
}

export async function putUserSettings(name: UserName, settings: UserSettings): Promise<UserSettings> {
  const res = await fetch(`/api/users/${encodeURIComponent(name)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`PUT /api/users/${name}/settings → ${res.status}`);
  const body = await res.json() as { name: string; settings: UserSettings };
  return body.settings;
}
