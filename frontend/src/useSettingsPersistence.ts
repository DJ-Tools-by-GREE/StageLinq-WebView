import { useCallback, useEffect, useRef, useState } from 'react';
import { FIXED_USERS, fetchAllUsers, putUserSettings, type UserName, type UsersMap, type UserSettings } from './userSettings.js';
import { fetchGlobalSettings, putFreewheelSettings, FREEWHEEL_DURATION_FALLBACK, type FreewheelSettings, type GlobalSettingsMeta } from './globalSettings.js';
import { SettingsWriter, type SaveState } from './settingsWriter.js';

const IDLE: SaveState = { phase: 'idle' };
function blankUsers(): UsersMap { return Object.fromEntries(FIXED_USERS.map(name => [name, {}])) as UsersMap; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function protectPendingWrites(getWriters: () => Array<{ hasUnsaved: boolean; flush(): Promise<void> }>) {
  const flush = () => { for (const writer of getWriters()) void writer.flush(); };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!getWriters().some(writer => writer.hasUnsaved)) return;
    flush();
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', beforeUnload);
  return () => {
    window.removeEventListener('pagehide', flush);
    window.removeEventListener('beforeunload', beforeUnload);
  };
}

export function useUserPreferences() {
  const [users, setUsers] = useState<UsersMap>(blankUsers);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStates, setSaveStates] = useState<Partial<Record<UserName, SaveState>>>({});
  const usersRef = useRef(users);
  const readyRef = useRef(false);
  const loadAbort = useRef<AbortController | null>(null);
  const writers = useRef<Partial<Record<UserName, SettingsWriter<UserSettings>>>>({});

  const reload = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    readyRef.current = false;
    setReady(false);
    setLoadError(null);
    try {
      const next = await fetchAllUsers(controller.signal);
      if (controller.signal.aborted) return;
      usersRef.current = next;
      setUsers(next);
      readyRef.current = true;
      setReady(true);
    } catch (error: unknown) {
      if (!controller.signal.aborted) setLoadError(errorText(error));
    }
  }, []);

  useEffect(() => {
    for (const name of FIXED_USERS) {
      writers.current[name] = new SettingsWriter(
        settings => putUserSettings(name, settings),
        settings => {
          usersRef.current = { ...usersRef.current, [name]: settings };
          setUsers(usersRef.current);
        },
        state => setSaveStates(previous => ({ ...previous, [name]: state })),
      );
    }
    void reload();
    const removeListeners = protectPendingWrites(() => Object.values(writers.current));
    return () => {
      loadAbort.current?.abort();
      readyRef.current = false;
      removeListeners();
      for (const writer of Object.values(writers.current)) writer.dispose();
      writers.current = {};
    };
  }, [reload]);

  const update = useCallback((name: UserName, patch: Partial<UserSettings>) => {
    if (!readyRef.current) return;
    const settings: UserSettings = { ...usersRef.current[name] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (settings as Record<string, unknown>)[key];
      else (settings as Record<string, unknown>)[key] = value;
    }
    usersRef.current = { ...usersRef.current, [name]: settings };
    setUsers(usersRef.current);
    writers.current[name]?.schedule(settings);
  }, []);
  const retry = useCallback((name: UserName) => writers.current[name]?.retry(), []);
  return { users, ready, loadError, saveStates, update, retry, reload };
}

export function useFreewheelPreferences() {
  const [freewheel, setFreewheel] = useState<FreewheelSettings | null>(null);
  const [meta, setMeta] = useState<GlobalSettingsMeta>({ freewheel_max_duration_sec: FREEWHEEL_DURATION_FALLBACK });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(IDLE);
  const freewheelRef = useRef(freewheel);
  const loadAbort = useRef<AbortController | null>(null);
  const writer = useRef<SettingsWriter<Partial<FreewheelSettings>, FreewheelSettings> | null>(null);

  const refresh = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    const revision = writer.current?.revision;
    setLoadError(null);
    try {
      const result = await fetchGlobalSettings(controller.signal);
      if (controller.signal.aborted) return;
      if (result.meta) setMeta(result.meta);
      if (revision === writer.current?.revision && !writer.current?.hasUnsaved) {
        freewheelRef.current = result.freewheel;
        setFreewheel(result.freewheel);
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) setLoadError(errorText(error));
    }
  }, []);

  useEffect(() => {
    writer.current = new SettingsWriter(
      putFreewheelSettings,
      settings => { freewheelRef.current = settings; setFreewheel(settings); },
      setSaveState,
      (previous, next) => ({ ...previous, ...next }),
    );
    void refresh();
    const removeListeners = protectPendingWrites(() => writer.current ? [writer.current] : []);
    return () => {
      loadAbort.current?.abort();
      removeListeners();
      writer.current?.dispose();
      writer.current = null;
    };
  }, [refresh]);

  const update = useCallback((patch: Partial<FreewheelSettings>) => {
    if (!freewheelRef.current) return;
    freewheelRef.current = { ...freewheelRef.current, ...patch };
    setFreewheel(freewheelRef.current);
    writer.current?.schedule(patch, patch.enable_freewheeling !== undefined);
  }, []);
  const retry = useCallback(() => writer.current?.retry(), []);
  return { freewheel, meta, loadError, saveState, update, retry, refresh };
}
