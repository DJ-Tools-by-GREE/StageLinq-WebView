import { useRef, useState, useLayoutEffect } from 'react';
import type { DeckState } from './types.js';
import type { WaveformState } from './appTypes.js';
import WaveformDisplay from './WaveformDisplay.js';

function MarqueeText({ text, className = '' }: { text: string; className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [dist, setDist] = useState(0);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setDist(Math.max(0, textRef.current!.scrollWidth - el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const dur = dist > 0 ? Math.max(7, 4 + dist / 50) : 0;

  return (
    <div ref={wrapRef} className={`marqueeWrap${className ? ' ' + className : ''}`}>
      <span
        ref={textRef}
        className={dist > 0 ? 'marqueeText marqueeText--active' : 'marqueeText'}
        style={dist > 0
          ? { '--md': `-${dist}px`, '--dur': `${dur}s` } as React.CSSProperties
          : undefined}
      >
        {text}
      </span>
    </div>
  );
}

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
  selected: boolean;
  suggested: boolean;
  artworkUrl: string | null;
  elapsedSecRef: { current: number };
  detailZoomSec: number;
}

export default function DeckCard({ state, waveform, selected, suggested, artworkUrl, elapsedSecRef, detailZoomSec }: Props) {
  const { deck, trackLoaded, title, artist, elapsedSec, totalSec, currentBpm,
          trackBpm, speedState, keyCamelot, fader, play } = state;

  const faderOnRight = deck === 1 || deck === 3;
  const faderPct = Math.round(fader * 100);
  const isPlaying = play && trackLoaded;

  const elapsed   = trackLoaded ? formatMMSS(elapsedSec) : '00:00';
  const totalStr  = trackLoaded ? formatMMSS(totalSec) : '00:00';
  const remainStr = trackLoaded ? formatMMSS(Math.max(0, totalSec - elapsedSec)) : '00:00';

  const bpm    = trackLoaded && Number.isFinite(currentBpm) ? currentBpm.toFixed(2) : '—';
  const tBpm   = trackLoaded && Number.isFinite(trackBpm) && trackBpm > 0 ? trackBpm.toFixed(2) : '—';
  const rel    = trackLoaded ? signedPercent(speedState) : '—';

  const dispTitle  = trackLoaded ? (title  || '—') : '—';
  const dispArtist = trackLoaded ? (artist || '—') : '—';
  const dispKey    = trackLoaded ? (keyCamelot || '--') : '--';

  function artistFallbackUrl(): string | null {
    if (!trackLoaded) return null;
    const haystack = `${title ?? ''} ${artist ?? ''}`.toLowerCase();
    if (haystack.includes('don diablo')) return '/fallbacks/dondiablo_hex_logo.jpg';
    if (haystack.includes('martin garrix')) return '/fallbacks/martin_garrix_logo.jpg';
    return null;
  }

  const displayArtwork = trackLoaded ? (artworkUrl ?? artistFallbackUrl()) : null;

  return (
    <div className={`card theme-d${deck}`}>
      <div className="deckBorder" />

      <div className="cardHeader">
        <div className="trackInfo">
          <div className={`art${selected ? ' art--selected' : ''}${suggested ? ' art--suggested' : ''}`}>
            {displayArtwork
              ? <img src={displayArtwork} alt="" className="artImg" />
              : <span>D{deck}</span>
            }
            {suggested && (
              <div className="artChangeOverlay" aria-live="polite">
                <span className="artChangeText">Change Deck</span>
              </div>
            )}
          </div>

          <div className="titleBlock">
            <div className={`title${isPlaying ? ' title--playing' : ''}`}>
              {isPlaying && <span className="playDot" />}
              <MarqueeText text={dispTitle} />
            </div>
            <MarqueeText text={dispArtist} className="artist" />
          </div>
        </div>

        <div className="stats">
          <div className="pills">
            <span className="pill">Key: <strong>{dispKey}</strong></span>
            <span className={`pill loopPill${state.loopActive ? ' loopPill--active' : ' loopPill--inactive'}`}>
              {state.loopActive ? 'Loop Active' : 'No Loop Active'}
            </span>
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
        peaks={trackLoaded ? waveform.peaks : null}
        peaksPerSec={waveform.peaksPerSec}
        elapsedSec={elapsedSec}
        totalSec={totalSec}
        stage={waveform.stage}
        progress={waveform.progress}
        hotCues={state.hotCues ?? []}
        loopActive={state.loopActive ?? false}
        loopInSec={state.loopInSec ?? null}
        loopOutSec={state.loopOutSec ?? null}
        savedLoops={state.savedLoops ?? []}
        elapsedSecRef={elapsedSecRef}
        detailZoomSec={detailZoomSec}
      />
    </div>
  );
}
