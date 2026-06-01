import type { DeckState } from './types.js';
import type { WaveformState } from './appTypes.js';
import WaveformDisplay from './WaveformDisplay.js';

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

  const faderOnRight = deck === 1 || deck === 3;
  const faderPct = Math.round(fader * 100);
  const isPlaying = play && trackLoaded;

  const elapsed   = trackLoaded ? formatMMSS(elapsedSec) : '00:00';
  const totalStr  = trackLoaded ? formatMMSS(totalSec) : '00:00';
  const remainStr = trackLoaded ? formatMMSS(Math.max(0, totalSec - elapsedSec)) : '00:00';

  const bpm       = trackLoaded && Number.isFinite(currentBpm) ? currentBpm.toFixed(2) : '—';
  const tBpm      = trackLoaded && Number.isFinite(trackBpm) && trackBpm > 0 ? trackBpm.toFixed(2) : '—';
  const rel       = trackLoaded ? signedPercent(speedState) : '—';

  const dispTitle  = trackLoaded ? (title  || '—') : '—';
  const dispArtist = trackLoaded ? (artist || '—') : '—';
  const dispKey    = trackLoaded ? (keyCamelot || '--') : '--';

  return (
    <div className={`card theme-d${deck}`}>
      <div className="deckBorder" />

      <div className="cardHeader">
        <div className="art">D{deck}</div>

        <div className="titleBlock">
          <div className="title" title={dispTitle}>
            {isPlaying && <span className="playDot" />}
            {dispTitle}
          </div>
          <div className="artist" title={dispArtist}>{dispArtist}</div>
        </div>

        <div className="stats">
          <div className="pills">
            <span className="pill">Key: <strong>{dispKey}</strong></span>
            <span className="pill">{connected ? 'LIVE' : 'OFFLINE'}</span>
          </div>
          <div className="kv">
            <div><span className="label">Elapsed / Total</span></div>
            <div><strong>{elapsed}</strong> / <strong>{totalStr}</strong></div>
            <div className="label">Remaining: {remainStr}</div>
          </div>
        </div>
      </div>

      <div className="middle">
        {!faderOnRight && (
          <div className="fader" aria-label={`Deck ${deck} channel fader`}>
            <div className="faderTrack">
              <div className="faderFill" style={{ height: `${faderPct}%` }} />
            </div>
            <div className="faderPct">{faderPct}%</div>
          </div>
        )}

        <div className="content">
          <div className="row">
            <div className="label">BPM</div>
            <div className="value">{bpm}</div>
          </div>
          <div className="row">
            <div className="label">Track BPM</div>
            <div className="value">{tBpm}</div>
          </div>
          <div className="row">
            <div className="label">Relative</div>
            <div className="value">{rel}</div>
          </div>
        </div>

        {faderOnRight && (
          <div className="fader" aria-label={`Deck ${deck} channel fader`}>
            <div className="faderTrack">
              <div className="faderFill" style={{ height: `${faderPct}%` }} />
            </div>
            <div className="faderPct">{faderPct}%</div>
          </div>
        )}
      </div>

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
  );
}
