import type { DeckNumber, DeckState, StageLinqStatus } from './types.js';
import type { UserName } from './userSettings.js';

const DECK_LABEL: Record<DeckNumber, string> = { 1: 'D1', 2: 'D2', 3: 'D3', 4: 'D4' };

interface Props {
  connected: boolean;
  stagelinqStatus: StageLinqStatus;
  selectedDeck: DeckNumber | null;
  selectedDeckState: DeckState | null;
  nextTrack: string | null;
  sendWhenStopped: boolean;
  settingBusy: boolean;
  onToggleSendWhenStopped: () => void;
  onOpenSettings: () => void;
  users: readonly UserName[];
  activeUser: UserName;
  onChangeUser: (name: UserName) => void;
}

export default function HeaderBar({
  connected,
  stagelinqStatus,
  selectedDeck,
  selectedDeckState,
  nextTrack,
  sendWhenStopped,
  settingBusy,
  onToggleSendWhenStopped,
  onOpenSettings,
  users,
  activeUser,
  onChangeUser,
}: Props) {
  const bpm = selectedDeckState?.trackLoaded && Number.isFinite(selectedDeckState.currentBpm)
    ? selectedDeckState.currentBpm.toFixed(1)
    : null;

  const nextTrackDisplay = nextTrack
    ? nextTrack.replace(/\.[^/.]+$/, '')
    : null;

  let dotClass: string;
  let label: string;
  if (!connected) {
    dotClass = 'connDot--offline';
    label = 'Offline (no socket connection)';
  } else if (stagelinqStatus === 'reconnecting') {
    dotClass = 'connDot--reconnecting';
    label = 'Reconnecting to StageLinq';
  } else if (stagelinqStatus === 'no-device') {
    dotClass = 'connDot--nodevice';
    label = 'No StageLinq connection';
  } else {
    dotClass = 'connDot--live';
    label = 'Live';
  }

  return (
    <div className="headerBar">
      <div className="headerLeft">
        <span className={`connDot ${dotClass}`} />
        <span className="headerLabel">{label}</span>
      </div>

      <div className="headerCenter">
        {selectedDeck ? (
          <span className={`headerDeck theme-d${selectedDeck}`}>
            {DECK_LABEL[selectedDeck]}
            {bpm && <span className="headerBpm">{bpm} BPM</span>}
          </span>
        ) : (
          <span className="headerMuted">no deck selected</span>
        )}

        {nextTrackDisplay && (
          <span className="headerNext">
            <span className="headerNextLabel">NEXT</span>
            {nextTrackDisplay}
          </span>
        )}
      </div>

      <div className="headerRight">
        <label className="userPicker" title="Switch user">
          <span className="userPickerLabel">USER</span>
          <select
            className="userPickerSelect"
            value={activeUser}
            onChange={(e) => onChangeUser(e.target.value as UserName)}
          >
            {users.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </label>
        <button
          className={`toggleBtn ${sendWhenStopped ? 'on' : 'off'}`}
          onClick={onToggleSendWhenStopped}
          disabled={settingBusy}
        >
          {sendWhenStopped ? 'TC while stopped: ON' : 'TC while stopped: OFF'}
        </button>
        <button
          className="iconBtn"
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="Settings"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
