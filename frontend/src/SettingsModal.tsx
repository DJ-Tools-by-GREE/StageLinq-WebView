import { useEffect, useRef } from 'react';
import type { UserName } from './userSettings.js';
import type { FreewheelSettings } from './globalSettings.js';

interface Props {
  activeUser: UserName;
  detailZoomSec: number;
  onChangeDetailZoomSec: (value: number) => void;
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
  freewheel,
  freewheelDurationLimits,
  onChangeFreewheel,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

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

            <div className="settingRow">
              <div className="settingLabel">
                Freewheeling
                <span className="settingValue">
                  {fwEnabled ? 'enabled' : 'disabled'}
                </span>
              </div>
              <button
                className={`toggleBtn ${fwEnabled ? 'on' : 'off'}`}
                disabled={freewheel === null}
                onClick={() => onChangeFreewheel({ enable_freewheeling: !fwEnabled })}
              >
                {fwEnabled ? 'Disable freewheeling' : 'Enable freewheeling'}
              </button>
              <div className="settingHint">
                When disabled, Art-Net TC stops the instant StageLinq goes
                stale instead of freewheeling at the last-known speed. Saved to
                config.json (default: enabled) and applied immediately.
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
