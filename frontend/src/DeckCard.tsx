import React, { useMemo } from 'react';
import type { DeckNumber, DeckState } from './types';
import type { WaveformState } from './App';
import WaveformDisplay from './WaveformDisplay';

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

function formatMMSS(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${pad2(m)}:${pad2(r)}`;
}

function signedPercentFromSpeedState(speedState: number): string {
  if (!Number.isFinite(speedState)) return '0.00%';
  const sign = speedState >= 0 ? '+' : '';
  return `${sign}${speedState.toFixed(2)}%`;
}

export default function DeckCard(props: {
  deck: DeckNumber;
  state: DeckState;
  waveform: WaveformState;
  connected: boolean;
}) {
  const { deck, state, waveform, connected } = props;

  const themeClass = `theme-d${deck}`;
  const faderOnRight = deck === 1 || deck === 3;

  const elapsed = useMemo(() => state.trackLoaded ? formatMMSS(state.elapsedSec) : '00:00', [state.trackLoaded, state.elapsedSec]);
  const total = useMemo(() => state.trackLoaded ? formatMMSS(state.totalSec) : '00:00', [state.trackLoaded, state.totalSec]);
  const remaining = useMemo(() => state.trackLoaded ? formatMMSS(Math.max(0, state.totalSec - state.elapsedSec)) : '00:00', [state.trackLoaded, state.totalSec, state.elapsedSec]);
  const title = state.trackLoaded ? (state.title || '—') : '—';
  const artist = state.trackLoaded ? (state.artist || '—') : '—';

  const bpm = state.trackLoaded && Number.isFinite(state.currentBpm) ? state.currentBpm.toFixed(2) : '—';
  const trackBpm = state.trackLoaded && Number.isFinite(state.trackBpm) && state.trackBpm > 0 ? state.trackBpm.toFixed(2) : '—';
  const rel = state.trackLoaded ? signedPercentFromSpeedState(state.speedState) : '—';

  const faderPct = Math.round((state.fader ?? 0) * 100);

  return (
    <div className={`card ${themeClass}`}>
      <div className="deckBorder" />

      <div className="cardHeader">
        <div className="art" title="Artwork (placeholder)">
          D{deck}
        </div>

        <div className="titleBlock">
          <div className="title" title={title}>
            {state.trackLoaded && state.play ? <span className="playDot" /> : null}
            {title}
          </div>
          <div className="artist" title={artist}>{artist}</div>
        </div>

        <div className="stats">
          <div className="pills">
            <span className="pill">Key: <strong>{state.trackLoaded ? (state.keyCamelot || '--') : '--'}</strong></span>
            <span className="pill">{connected ? 'LIVE' : 'OFFLINE'}</span>
          </div>

          <div className="kv">
            <div><span className="label">Elapsed / Total</span></div>
            <div><strong>{elapsed}</strong> / <strong>{total}</strong></div>
            <div className="label">Remaining: {remaining}</div>
          </div>
        </div>
      </div>

      <div className="middle">
        {!faderOnRight ? (
          <div className="fader" aria-label={`Deck ${deck} channel fader`}>
            <div className="faderTrack">
              <div className="faderFill" style={{ height: `${faderPct}%` }} />
            </div>
            <div className="faderPct">{faderPct}%</div>
          </div>
        ) : null}

        <div className="content">
          <div className="row">
            <div className="label">BPM</div>
            <div className="value">{bpm}</div>
          </div>
          <div className="row">
            <div className="label">Track BPM</div>
            <div className="value">{trackBpm}</div>
          </div>
          <div className="row">
            <div className="label">Relative</div>
            <div className="value">{rel}</div>
          </div>
        </div>

        {faderOnRight ? (
          <div className="fader" aria-label={`Deck ${deck} channel fader`}>
            <div className="faderTrack">
              <div className="faderFill" style={{ height: `${faderPct}%` }} />
            </div>
            <div className="faderPct">{faderPct}%</div>
          </div>
        ) : null}
      </div>

      <WaveformDisplay
        deck={deck}
        peaks={waveform.peaks}
        peaksPerSec={waveform.peaksPerSec}
        elapsedSec={state.elapsedSec}
        totalSec={state.totalSec}
        stage={waveform.stage}
        progress={waveform.progress}
      />
    </div>
  );
}
