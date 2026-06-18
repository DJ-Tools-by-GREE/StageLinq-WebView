import { useEffect, useRef, useState, useCallback } from 'react';
import { ROLES, DECK_LAYOUTS, type DeckLayout, type Role, type UserName } from './userSettings.js';
import type { FreewheelSettings, ReloadConfigResult } from './globalSettings.js';

interface Props {
  activeUser: UserName;
  detailZoomSec: number;
  onChangeDetailZoomSec: (value: number) => void;
  showTrackNotes: boolean;
  onChangeShowTrackNotes: (value: boolean) => void;
  role: Role;
  onChangeRole: (value: Role) => void;
  deckLayout: DeckLayout;
  onChangeDeckLayout: (value: DeckLayout) => void;
  onResetRoleDefaults: () => void;
  // True iff at least one role-derived field has an explicit user override
  // right now. Drives the enabled state and label of the reset button.
  hasRoleOverrides: boolean;
  freewheel: FreewheelSettings | null;
  freewheelDurationLimits: { min: number; max: number };
  onChangeFreewheel: (patch: Partial<FreewheelSettings>) => void;
  onReloadConfig: () => Promise<ReloadConfigResult>;
  onOpenConfigEditor: () => void;
  onClose: () => void;
}

const ZOOM_MIN = 4;
const ZOOM_MAX = 30;
const ZOOM_STEP = 1;

export default function SettingsModal({
  activeUser,
  detailZoomSec,
  onChangeDetailZoomSec,
  showTrackNotes,
  onChangeShowTrackNotes,
  role,
  onChangeRole,
  deckLayout,
  onChangeDeckLayout,
  onResetRoleDefaults,
  hasRoleOverrides,
  freewheel,
  freewheelDurationLimits,
  onChangeFreewheel,
  onReloadConfig,
  onOpenConfigEditor,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Arm state for the Controls section. Both the arm slider and the persistent-arm
  // toggle reset on dialog mount / page reload — deliberately ephemeral so a
  // momentary mis-click on the toggle never leaves controls hot indefinitely.
  const [armed, setArmed] = useState(false);
  const [armPersistent, setArmPersistent] = useState(false);

  // Reload-config status, surfaced as an inline pill next to the button.
  // 'idle' is the resting state; success/error auto-clear back to idle so the
  // pill reflects the *current* outcome, not a stale one from minutes ago.
  type ReloadStatus =
    | { kind: 'idle' }
    | { kind: 'reloading' }
    | { kind: 'ok' }
    | { kind: 'error'; message: string };
  const [reloadStatus, setReloadStatus] = useState<ReloadStatus>({ kind: 'idle' });
  const reloadResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (reloadResetTimerRef.current) clearTimeout(reloadResetTimerRef.current);
    };
  }, []);

  // Single funnel for any "armed click" inside the Controls section. If persistent
  // arm is off, snaps the slider back to 0 immediately so the next click also
  // requires a fresh arm.
  const consumeArmedClick = useCallback(
    (action: () => void) => {
      if (!armed) return;
      action();
      if (!armPersistent) setArmed(false);
    },
    [armed, armPersistent],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fwEnabled = freewheel?.enable_freewheeling ?? true;
  const fwDuration = freewheel?.max_duration_sec ?? 30;

  const triggerReload = useCallback(async () => {
    if (reloadStatus.kind === 'reloading') return;
    if (reloadResetTimerRef.current) {
      clearTimeout(reloadResetTimerRef.current);
      reloadResetTimerRef.current = null;
    }
    setReloadStatus({ kind: 'reloading' });
    const result = await onReloadConfig();
    setReloadStatus(
      result.ok ? { kind: 'ok' } : { kind: 'error', message: result.error || 'failed' },
    );
    reloadResetTimerRef.current = setTimeout(() => {
      setReloadStatus({ kind: 'idle' });
      reloadResetTimerRef.current = null;
    }, 3000);
  }, [onReloadConfig, reloadStatus.kind]);

  const reloadStatusLabel =
    reloadStatus.kind === 'reloading'
      ? 'reloading…'
      : reloadStatus.kind === 'ok'
      ? 'ok ✓'
      : reloadStatus.kind === 'error'
      ? `error: ${reloadStatus.message}`
      : 'idle';

  return (
    <div className="modalBackdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modalDialog modalDialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settingsTitle"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modalHeader">
          <h2 id="settingsTitle" className="modalTitle">
            Settings <span className="modalTitleUser">· {activeUser}</span>
          </h2>
          <button className="modalClose" onClick={onClose} aria-label="Close settings">×</button>
        </div>

        <div className="modalBody modalBody--grid">
          {/* ── User-scoped settings ─────────────────────────────────────────── */}
          <section className="settingsSection">
            <h3 className="settingsSectionTitle">User Settings</h3>

            <div className="settingRow">
              <label className="settingLabel" htmlFor="roleSelect">
                Role
                <span className="settingValue">{role}</span>
              </label>
              <div className="userPicker">
                <span className="userPickerLabel">ROLE</span>
                <select
                  id="roleSelect"
                  className="userPickerSelect"
                  value={role}
                  onChange={(e) => onChangeRole(e.target.value as Role)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div className="settingHint">
                Pick from the fixed roles. Adding a new role still requires a
                code/JSON change. The DJ role enables track-note popups by
                default; an explicit toggle below always overrides this.
              </div>
            </div>

            <div className="settingRow">
              <label className="settingLabel" htmlFor="zoomRange">
                Detail waveform zoom
                <span className="settingValue">{detailZoomSec}s visible</span>
              </label>
              <input
                id="zoomRange"
                type="range"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={ZOOM_STEP}
                value={detailZoomSec}
                onChange={(e) => onChangeDetailZoomSec(Number(e.target.value))}
                className="settingRange"
              />
              <div className="settingHint">
                Smaller = more zoomed in. Default: 10s.
              </div>
            </div>

            <div className="settingRow">
              <div className="settingLabel">
                Track-note popups
                <span className="settingValue">
                  {showTrackNotes ? 'enabled' : 'disabled'}
                </span>
              </div>
              <button
                className={`toggleBtn ${showTrackNotes ? 'on' : 'off'}`}
                onClick={() => onChangeShowTrackNotes(!showTrackNotes)}
              >
                {showTrackNotes ? 'Disable popups' : 'Enable popups'}
              </button>
              <div className="settingHint">
                When enabled, tracks with a non-empty <code>note.description</code>
                {' '}in the active playlist surface a popup after they load. The
                delay is per-track via <code>show_secs_after_load</code>.
                Default follows your role: <strong>DJ</strong> on, others off.
                Toggling here pins your choice and overrides the role default.
              </div>
            </div>

            <div className="settingRow">
              <div className="settingLabel">
                Deck layout
                <span className="settingValue">
                  {deckLayout === 2 ? '2 decks (D1 & D2)' : '4 decks (2×2)'}
                </span>
              </div>
              <div className="userPicker">
                <span className="userPickerLabel">DECKS</span>
                <select
                  className="userPickerSelect"
                  value={deckLayout}
                  onChange={(e) => onChangeDeckLayout(Number(e.target.value) as DeckLayout)}
                >
                  {DECK_LAYOUTS.map((n) => (
                    <option key={n} value={n}>
                      {n === 2 ? '2 decks — D1 & D2 side by side' : '4 decks — 2×2 grid'}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settingHint">
                Switch between the full 4-deck 2×2 grid and a 2-deck side-by-side
                view that only renders D1 and D2. Default: 4 decks.
              </div>
            </div>

            <div className="settingRow">
              <div className="settingLabel">
                Role-derived defaults
                <span className="settingValue">
                  {hasRoleOverrides ? 'overridden' : 'in sync'}
                </span>
              </div>
              <button
                className="toggleBtn off"
                disabled={!hasRoleOverrides}
                onClick={onResetRoleDefaults}
              >
                Reset to {role} defaults
              </button>
              <div className="settingHint">
                Clears your explicit overrides on settings that have a role
                default (today: track-note popups). Settings without a role
                default — like the waveform zoom — are unaffected.
              </div>
            </div>
          </section>

          {/* ── Global (backend-owned) settings ───────────────────────────── */}
          <section className="settingsSection">
            <h3 className="settingsSectionTitle">Global Settings</h3>

            <div className="settingRow">
              <label className="settingLabel" htmlFor="freewheelDuration">
                Freewheel duration
                <span className="settingValue">{fwDuration}s max</span>
              </label>
              <input
                id="freewheelDuration"
                type="range"
                min={freewheelDurationLimits.min}
                max={freewheelDurationLimits.max}
                step={1}
                value={fwDuration}
                disabled={freewheel === null}
                onChange={(e) => onChangeFreewheel({ max_duration_sec: Number(e.target.value) })}
                className="settingRange"
              />
              <div className="settingHint">
                After this many seconds without StageLinq beats, the Art-Net
                worker stops sending TC entirely until beats resume. Persisted
                to config.json. Applies to all users.
              </div>
            </div>

            <div className="settingRow">
              <div className="settingLabel">
                Edit config.json
                <span className="settingValue">advanced</span>
              </div>
              <button className="toggleBtn off" onClick={onOpenConfigEditor}>
                Open config editor…
              </button>
              <div className="settingHint">
                Full-screen editor for the on-disk <code>config.json</code> —
                playlists, timecode targets, OSC, sACN input, logging
                channels, and more. Save is <strong>write-only</strong>:
                press <strong>Ctrl+R</strong> in the backend terminal (or
                restart the process) to apply changes to the running show.
              </div>
            </div>
          </section>

          {/* ── Live operator controls ───────────────────────────────────── */}
          <section className="settingsSection">
            <h3 className="settingsSectionTitle">Controls</h3>

            {/*
              Arm gate. Slide right (value 1) to unlock everything below; clicking
              any control disarms unless persistent-arm is on. Both states reset on
              page reload — never trust a "stays armed" the operator might forget.
            */}
            <div className="settingRow">
              <div className="settingLabel">
                Arm controls
                <span className={`settingValue ${armed ? 'settingValue--armed' : 'settingValue--locked'}`}>
                  {armed ? 'ARMED' : 'LOCKED'}
                </span>
              </div>
              <input
                aria-label="Arm controls"
                type="range"
                min={0}
                max={1}
                step={1}
                value={armed ? 1 : 0}
                onChange={(e) => setArmed(e.target.value === '1')}
                className={`settingRange armSlider ${armed ? 'armSlider--armed' : ''}`}
              />
              <div className="settingHint">
                Slide to arm before clicking any control below. Resets to LOCKED
                on every page reload.
              </div>
            </div>

            <div className={`controlsGate ${armed ? '' : 'controlsGate--locked'}`}>
              <div className="settingRow">
                <div className="settingLabel">
                  Persistent arm
                  <span className="settingValue">
                    {armPersistent ? 'on' : 'off'}
                  </span>
                </div>
                <button
                  className={`toggleBtn ${armPersistent ? 'on' : 'off'}`}
                  disabled={!armed}
                  onClick={() =>
                    consumeArmedClick(() => setArmPersistent((v) => !v))
                  }
                >
                  {armPersistent
                    ? 'Disable persistent arm'
                    : 'Enable persistent arm'}
                </button>
                <div className="settingHint">
                  When off (default), the arm slider snaps back to LOCKED after
                  each control click. When on, arming stays hot until you slide
                  back yourself or reload.
                </div>
              </div>

              <div className="settingRow">
                <div className="settingLabel">
                  Freewheeling
                  <span className="settingValue">
                    {fwEnabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
                <button
                  className={`toggleBtn ${fwEnabled ? 'on' : 'off'}`}
                  disabled={freewheel === null || !armed}
                  onClick={() =>
                    consumeArmedClick(() =>
                      onChangeFreewheel({ enable_freewheeling: !fwEnabled }),
                    )
                  }
                >
                  {fwEnabled ? 'Disable freewheeling' : 'Enable freewheeling'}
                </button>
                <div className="settingHint">
                  When disabled, Art-Net TC stops the instant StageLinq goes
                  stale instead of freewheeling at the last-known speed. Saved to
                  config.json (default: enabled) and applied immediately.
                </div>
              </div>

              <div className="settingRow">
                <div className="settingLabel">
                  Reload config
                  <span className="settingValue">{reloadStatusLabel}</span>
                </div>
                <button
                  className="toggleBtn off"
                  disabled={!armed || reloadStatus.kind === 'reloading'}
                  onClick={() => consumeArmedClick(() => { void triggerReload(); })}
                >
                  Reload config from disk
                </button>
                <div className="settingHint">
                  Re-reads <code>config.json</code> and re-applies playlist
                  offsets, track notes, freewheel, logging, and display
                  settings without restarting the show. Same effect as
                  pressing <strong>Ctrl+R</strong> on the backend terminal —
                  use this when running headless / under PM2.
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
