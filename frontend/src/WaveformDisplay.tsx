import React, { useEffect, useRef } from 'react';
import type { WaveformStage } from './types';

const DETAIL_HALF_SEC = 5;

const DECK_COLORS: Record<number, string> = {
  1: '#b100ff',
  2: '#2f7bff',
  3: '#00c853',
  4: '#ff2d2d',
};

interface Props {
  deck: number;
  peaks: number[] | null;
  peaksPerSec: number;
  elapsedSec: number;
  totalSec: number;
  stage: WaveformStage | null;
  progress: number;
}

export default function WaveformDisplay({ deck, peaks, peaksPerSec, elapsedSec, totalSec, stage, progress }: Props) {
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const detailRef = useRef<HTMLCanvasElement>(null);

  const color = DECK_COLORS[deck] ?? '#ffffff';

  // Overview: full-song split into two horizontal strips (first half / second half).
  useEffect(() => {
    const canvas = overviewRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvas.offsetWidth || canvas.width;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (!peaks || peaks.length === 0) return;

    const half = Math.ceil(peaks.length / 2);
    const frac = totalSec > 0 ? Math.min(1, elapsedSec / totalSec) : 0;
    const playedIdx = Math.round(frac * peaks.length);

    const barW = w / half;
    for (let i = 0; i < half; i++) {
      const played = i < playedIdx;
      ctx.fillStyle = played ? color + 'cc' : color + '44';
      const amp = peaks[i] * h * 0.88;
      ctx.fillRect(i * barW, h - amp, Math.max(1, barW), amp);
    }

    const topPx = Math.min(Math.round(frac * 2 * w), w);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(topPx - 1, 0, 2, h);
  }, [peaks, elapsedSec, totalSec, color]);

  // Detail: 10-second scrolling window, playhead at 1/4 from the left.
  useEffect(() => {
    const canvas = detailRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvas.offsetWidth || canvas.width;
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;

    ctx.clearRect(0, 0, w, h);

    if (!peaks || peaks.length === 0) return;

    const windowPeaks = DETAIL_HALF_SEC * 2 * peaksPerSec;
    const pxPerPeak = w / windowPeaks;
    const centerIdx = Math.floor(elapsedSec * peaksPerSec);
    const leftPeaks = Math.floor(windowPeaks / 4);
    const rightPeaks = windowPeaks - leftPeaks;
    const startIdx = centerIdx - leftPeaks;
    const endIdx = centerIdx + rightPeaks;

    for (let i = startIdx; i <= endIdx; i++) {
      const peak = i >= 0 && i < peaks.length ? peaks[i] : 0;
      const amp = peak * mid * 0.92;
      const x = (i - startIdx) * pxPerPeak;
      ctx.fillStyle = (i < 0 || i >= peaks.length) ? color + '22' : color + 'cc';
      ctx.fillRect(x, mid - amp, Math.max(1, pxPerPeak), amp * 2);
    }

    // 1-second tick marks
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    const lookBackSec = Math.ceil(leftPeaks / peaksPerSec);
    const lookAheadSec = Math.ceil(rightPeaks / peaksPerSec);
    for (let offsetSec = -lookBackSec; offsetSec <= lookAheadSec; offsetSec++) {
      const x = (Math.round((elapsedSec + offsetSec) * peaksPerSec) - startIdx) * pxPerPeak;
      ctx.fillRect(x, 0, 1, h);
    }

    // Playhead at 1/4 from left
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(w / 4 - 1, 0, 2, h);
  }, [peaks, elapsedSec, peaksPerSec, color]);

  const showLoading = stage === 'downloading' || stage === 'generating';

  return (
    <div className="waveformWrap">
      {showLoading && (
        <div className="waveformLoading">
          <span className="waveformLoadLabel">
            {stage === 'downloading' ? 'Downloading' : 'Generating waveform'}
          </span>
          <div className="waveformBar">
            <div className="waveformBarFill" style={{ width: `${progress}%`, background: color }} />
          </div>
        </div>
      )}
      {stage === 'error' && (
        <div className="waveformError">Waveform unavailable</div>
      )}
      <canvas ref={overviewRef} className="waveformOverview" height={32} />
      <canvas ref={detailRef} className="waveformDetail" height={72} />
    </div>
  );
}

