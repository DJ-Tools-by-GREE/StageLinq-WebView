import type { CSSProperties } from 'react';
import type { DeckState } from './types.js';
import type { WaveformState } from './appTypes.js';
import WaveformDisplay from './WaveformDisplay.js';

const DECK_COLORS: Record<number, string> = {
  1: '#b100ff',
  2: '#2f7bff',
  3: '#00c853',
  4: '#ff2d2d',
};

function formatMMSS(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function signedPercent(speedState: number): string {
  if (!Number.isFinite(speedState)) return '0.00%';
  return `${speedState >= 0 ? '+' : ''}${speedState.toFixed(2)}%`;
}

interface Props {
  state: DeckState;
  waveform: WaveformState;
  connected: boolean;
}

export default function DeckCard({ state, waveform, connected }: Props) {
  const { deck, trackLoaded, title, artist, elapsedSec, totalSec, currentBpm,
          trackBpm, speedState, keyCamelot, fader, play } = state;

  const color = DECK_COLORS[deck] ?? '#ffffff';
  const remaining = Math.max(0, totalSec - elapsedSec);
  const faderPct = Math.round(fader * 100);
  const isPlaying = play && trackLoaded;

  return (
    <div className="deckCard" style={{ '--deck-color': color } as CSSProperties}>
      {/* Header row */}
      <div className="deckHeader">
        <div className="deckId">
          <span className="deckLabel">D{deck}</span>
          {isPlaying && <span className="nowPlaying" aria-label="Now playing" />}
        </div>
        <div className="deckHeaderRight">
          <span className={`connBadge${connected ? ' connBadge--live' : ''}`}>
            {connected ? 'LIVE' : 'OFFLINE'}
          </span>
          <span className="keyBadge">
            {trackLoaded && keyCamelot ? keyCamelot : '--'}
          </span>
        </div>
      </div>

      {/* Track info */}
      <div className="trackInfo">
        <div className="trackTitle">{trackLoaded && title ? title : '—'}</div>
        <div className="trackArtist">{trackLoaded && artist ? artist : '—'}</div>
      </div>

      {/* Main data row: timing + bpm/pitch + fader */}
      <div className="deckBody">
        <div className="timingBlock">
          <div className="timeRow">
            <span className="timeLabel">ELAPSED</span>
            <span className="timeValue elapsed">{trackLoaded ? formatMMSS(elapsedSec) : '00:00'}</span>
          </div>
          <div className="timeRow">
            <span className="timeLabel">REMAIN</span>
            <span className="timeValue remain">{trackLoaded ? formatMMSS(remaining) : '00:00'}</span>
          </div>
          <div className="timeRow">
            <span className="timeLabel">TOTAL</span>
            <span className="timeValue total">{trackLoaded ? formatMMSS(totalSec) : '00:00'}</span>
          </div>
        </div>

        <div className="bpmBlock">
          <div className="bpmRow">
            <span className="bpmLabel">BPM</span>
            <span className="bpmValue live">
              {trackLoaded ? currentBpm.toFixed(2) : '—'}
            </span>
          </div>
          <div className="bpmRow">
            <span className="bpmLabel">TRACK</span>
            <span className="bpmValue">
              {trackLoaded && trackBpm > 0 ? trackBpm.toFixed(2) : '—'}
            </span>
          </div>
          <div className="bpmRow">
            <span className="bpmLabel">PITCH</span>
            <span className={`bpmValue pitch${!trackLoaded ? '' : speedState > 0 ? ' pitch--up' : speedState < 0 ? ' pitch--down' : ''}`}>
              {trackLoaded ? signedPercent(speedState) : '—'}
            </span>
          </div>
        </div>

        <div className="faderBlock">
          <div className="faderTrack">
            <div className="faderFill" style={{ height: `${faderPct}%` }} />
            <div className="faderThumb" style={{ bottom: `${faderPct}%` }} />
          </div>
          <span className="faderLabel">{faderPct}%</span>
        </div>
      </div>

      {/* Waveform */}
      <div className="waveformSection">
        <WaveformDisplay
          deck={deck}
          peaks={waveform.peaks}
          peaksPerSec={waveform.peaksPerSec}
          elapsedSec={elapsedSec}
          totalSec={totalSec}
          stage={waveform.stage}
          progress={waveform.progress}
        />
      </div>
    </div>
  );
}
