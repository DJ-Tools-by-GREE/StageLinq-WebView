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

  // Overview: full-song waveform with moving playhead.
  useEffect(() => {
    const canvas = overviewRef.current;
    if (!canvas || !peaks || peaks.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvas.offsetWidth || canvas.width;
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;
    const barW = w / peaks.length;

    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = color + '99';
    for (let i = 0; i < peaks.length; i++) {
      const amp = peaks[i] * mid * 0.9;
      ctx.fillRect(i * barW, mid - amp, Math.max(1, barW), amp * 2);
    }

    // Playhead
    const frac = totalSec > 0 ? elapsedSec / totalSec : 0;
    const px = Math.round(frac * w);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px - 1, 0, 2, h);
  }, [peaks, elapsedSec, totalSec, color]);

  // Detail: 10-second scrolling window, playhead always centred.
  useEffect(() => {
    const canvas = detailRef.current;
    if (!canvas || !peaks || peaks.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvas.offsetWidth || canvas.width;
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;

    ctx.clearRect(0, 0, w, h);

    const windowPeaks = DETAIL_HALF_SEC * 2 * peaksPerSec;
    const pxPerPeak = w / windowPeaks;
    const centerIdx = Math.floor(elapsedSec * peaksPerSec);
    const halfWin = Math.floor(windowPeaks / 2);
    const startIdx = centerIdx - halfWin;
    const endIdx = centerIdx + halfWin;

    for (let i = startIdx; i <= endIdx; i++) {
      const peak = i >= 0 && i < peaks.length ? peaks[i] : 0;
      const amp = peak * mid * 0.92;
      const x = (i - startIdx) * pxPerPeak;
      ctx.fillStyle = (i < 0 || i >= peaks.length) ? color + '22' : color + 'cc';
      ctx.fillRect(x, mid - amp, Math.max(1, pxPerPeak), amp * 2);
    }

    // 1-second tick marks
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    for (let offsetSec = -DETAIL_HALF_SEC; offsetSec <= DETAIL_HALF_SEC; offsetSec++) {
      const x = (Math.round((elapsedSec + offsetSec) * peaksPerSec) - startIdx) * pxPerPeak;
      ctx.fillRect(x, 0, 1, h);
    }

    // Centred playhead
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(w / 2 - 1, 0, 2, h);
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

