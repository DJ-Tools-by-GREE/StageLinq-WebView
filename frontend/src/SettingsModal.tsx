import { useEffect, useRef, useState, useCallback } from 'react';
import { ROLES, type Role, type UserName } from './userSettings.js';
import type { FreewheelSettings } from './globalSettings.js';

interface Props {
  activeUser: UserName;
  detailZoomSec: number;
  onChangeDetailZoomSec: (value: number) => void;
  showTrackNotes: boolean;
  onChangeShowTrackNotes: (value: boolean) => void;
  role: Role;
  onChangeRole: (value: Role) => void;
  freewheel: FreewheelSettings | null;
  freewheelDurationLimits: { min: number; max: number };
  onChangeFreewheel: (patch: Partial<FreewheelSettings>) => void;
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
  freewheel,
  freewheelDurationLimits,
  onChangeFreewheel,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Arm state for the Controls section. Both the arm slider and the persistent-arm
  // toggle reset on dialog mount / page reload — deliberately ephemeral so a
  // momentary mis-click on the toggle never leaves controls hot indefinitely.
  const [armed, setArmed] = useState(false);
  const [armPersistent, setArmPersistent] = useState(false);

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

  return (
    <div className="modalBackdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modalDialog"
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

        <div className="modalBody">
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
                delay is per-track via <code>show_secs_after_load</code>. Default:
                enabled.
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
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
