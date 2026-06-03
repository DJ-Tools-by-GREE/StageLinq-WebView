import type { DeckNumber, DeckState } from './types.js';

const DECK_LABEL: Record<DeckNumber, string> = { 1: 'D1', 2: 'D2', 3: 'D3', 4: 'D4' };

interface Props {
  connected: boolean;
  selectedDeck: DeckNumber | null;
  selectedDeckState: DeckState | null;
  nextTrack: string | null;
  sendWhenStopped: boolean;
  settingBusy: boolean;
  onToggleSendWhenStopped: () => void;
}

export default function HeaderBar({
  connected,
  selectedDeck,
  selectedDeckState,
  nextTrack,
  sendWhenStopped,
  settingBusy,
  onToggleSendWhenStopped,
}: Props) {
  const bpm = selectedDeckState?.trackLoaded && Number.isFinite(selectedDeckState.currentBpm)
    ? selectedDeckState.currentBpm.toFixed(1)
    : null;

  const nextTrackDisplay = nextTrack
    ? nextTrack.replace(/\.[^/.]+$/, '')
    : null;

  return (
    <div className="headerBar">
      <div className="headerLeft">
        <span className={`connDot ${connected ? 'connDot--live' : 'connDot--offline'}`} />
        <span className="headerLabel">{connected ? 'LIVE' : 'OFFLINE'}</span>
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
        <button
          className={`toggleBtn ${sendWhenStopped ? 'on' : 'off'}`}
          onClick={onToggleSendWhenStopped}
          disabled={settingBusy}
        >
          {sendWhenStopped ? 'TC while stopped: ON' : 'TC while stopped: OFF'}
        </button>
      </div>
    </div>
  );
}
