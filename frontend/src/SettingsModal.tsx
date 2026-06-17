import { useEffect, useRef } from 'react';
import type { UserName } from './userSettings.js';

interface Props {
  activeUser: UserName;
  detailZoomSec: number;
  onChangeDetailZoomSec: (value: number) => void;
  onClose: () => void;
}

const ZOOM_MIN = 4;
const ZOOM_MAX = 30;
const ZOOM_STEP = 1;

export default function SettingsModal({ activeUser, detailZoomSec, onChangeDetailZoomSec, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
        </div>
      </div>
    </div>
  );
}
