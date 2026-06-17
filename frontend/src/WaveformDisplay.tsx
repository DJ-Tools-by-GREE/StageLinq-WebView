import { useEffect, useRef } from 'react';
import type { WaveformStage, HotCue, SavedLoop } from './types';

const DEFAULT_DETAIL_ZOOM_SEC = 10;

const DECK_COLORS: Record<number, string> = {
  1: '#b100ff',
  2: '#2f7bff',
  3: '#00c853',
  4: '#ff2d2d',
};

// Hot cue colors 1–8: Yellow, Orange, Purple, Red, Light Green, Green, Teal, Blue
const HOT_CUE_COLORS: Record<number, string> = {
  1: '#ffe600',
  2: '#ff8c00',
  3: '#cc44ff',
  4: '#ff2222',
  5: '#88ff44',
  6: '#00cc44',
  7: '#00ccbb',
  8: '#2277ff',
};

interface DetailState {
  peaks: number[] | null;
  peaksPerSec: number;
  totalSec: number;
  color: string;
  maxPeak: number;
  hotCues: HotCue[];
  loopActive: boolean;
  loopInSec: number | null;
  loopOutSec: number | null;
  savedLoops: SavedLoop[];
  detailZoomSec: number;
}

interface Props {
  deck: number;
  peaks: number[] | null;
  peaksPerSec: number;
  elapsedSec: number;
  totalSec: number;
  stage: WaveformStage | null;
  progress: number;
  hotCues: HotCue[];
  loopActive: boolean;
  loopInSec: number | null;
  loopOutSec: number | null;
  savedLoops: SavedLoop[];
  elapsedSecRef: { current: number };
  detailZoomSec?: number;
}

export default function WaveformDisplay({
  deck, peaks, peaksPerSec, elapsedSec, totalSec,
  stage, progress, hotCues, loopActive, loopInSec, loopOutSec, savedLoops,
  elapsedSecRef, detailZoomSec = DEFAULT_DETAIL_ZOOM_SEC,
}: Props) {
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const detailRef = useRef<HTMLCanvasElement>(null);

  const color = DECK_COLORS[deck] ?? '#ffffff';
  const maxPeak = peaks && peaks.length > 0 ? Math.max(...peaks) : 1;

  const detailStateRef = useRef<DetailState>({
    peaks, peaksPerSec, totalSec, color, maxPeak,
    hotCues, loopActive, loopInSec, loopOutSec, savedLoops,
    detailZoomSec,
  });

  useEffect(() => {
    detailStateRef.current = {
      peaks, peaksPerSec, totalSec, color, maxPeak,
      hotCues, loopActive, loopInSec, loopOutSec, savedLoops,
      detailZoomSec,
    };
  });

  // Overview: redraws on each React render (driven by elapsedSec prop from state).
  useEffect(() => {
    const canvas = overviewRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvas.offsetWidth || canvas.width;
    canvas.height = canvas.offsetHeight || canvas.height;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    if (!peaks || peaks.length === 0) return;

    const frac = totalSec > 0 ? Math.min(1, elapsedSec / totalSec) : 0;
    const playedIdx = Math.round(frac * peaks.length);

    const barW = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const played = i < playedIdx;
      ctx.fillStyle = played ? color + 'cc' : color + '44';
      const amp = (peaks[i] / maxPeak) * h * 0.88;
      ctx.fillRect(i * barW, h - amp, Math.max(1, barW), amp);
    }

    const topPx = Math.round(frac * w);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(topPx - 1, 0, 2, h);

    if (loopInSec !== null && loopOutSec !== null && totalSec > 0) {
      const x1 = (loopInSec / totalSec) * w;
      const x2 = (loopOutSec / totalSec) * w;
      ctx.fillStyle = loopActive ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)';
      ctx.fillRect(Math.min(x1, x2), 0, Math.max(1, Math.abs(x2 - x1)), h);
      ctx.fillStyle = loopActive ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)';
      ctx.fillRect(Math.min(x1, x2), 0, 1, h);
      ctx.fillRect(Math.max(x1, x2), 0, 1, h);
    }

    for (const sl of savedLoops) {
      const slColor = HOT_CUE_COLORS[sl.index] ?? '#ffffff';
      if (totalSec > 0) {
        const x1 = (sl.inSec / totalSec) * w;
        const x2 = (sl.outSec / totalSec) * w;
        ctx.fillStyle = slColor + (sl.active ? '55' : '22');
        ctx.fillRect(Math.min(x1, x2), 0, Math.max(1, Math.abs(x2 - x1)), h);
        ctx.fillStyle = slColor + (sl.active ? 'cc' : '55');
        ctx.fillRect(Math.min(x1, x2), 0, 1, h);
      }
    }

    for (const cue of hotCues) {
      if (totalSec <= 0) continue;
      const cueColor = HOT_CUE_COLORS[cue.index] ?? '#ffffff';
      const x = (cue.sec / totalSec) * w;
      ctx.fillStyle = cueColor;
      ctx.fillRect(x - 1, 0, 2, h);
    }
  }, [peaks, elapsedSec, totalSec, color, maxPeak, hotCues, loopActive, loopInSec, loopOutSec, savedLoops]);

  // Detail: rAF loop reads elapsedSec directly from ref — bypasses React render cycle.
  useEffect(() => {
    const canvas = detailRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId: number;
    let canvasWidth = 0;
    let canvasHeight = 0;

    const draw = () => {
      rafId = requestAnimationFrame(draw);

      const s = detailStateRef.current;
      if (!s.peaks || s.peaks.length === 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      const newWidth = canvas.offsetWidth;
      if (newWidth !== canvasWidth) {
        canvas.width = newWidth;
        canvasWidth = newWidth;
      }
      const newHeight = canvas.offsetHeight;
      if (newHeight !== canvasHeight) {
        canvas.height = newHeight;
        canvasHeight = newHeight;
      }

      const w = canvas.width;
      const h = canvas.height;
      const mid = h / 2;
      const elapsed = elapsedSecRef.current;

      ctx.clearRect(0, 0, w, h);

      const windowPeaks = s.detailZoomSec * s.peaksPerSec;
      const pxPerPeak = w / windowPeaks;
      const centerIdx = Math.floor(elapsed * s.peaksPerSec);
      const leftPeaks = Math.floor(windowPeaks / 4);
      const rightPeaks = windowPeaks - leftPeaks;
      const startIdx = centerIdx - leftPeaks;
      const endIdx = centerIdx + rightPeaks;

      const secToX = (sec: number) => (sec * s.peaksPerSec - startIdx) * pxPerPeak;

      if (s.loopInSec !== null && s.loopOutSec !== null) {
        const x1 = secToX(s.loopInSec);
        const x2 = secToX(s.loopOutSec);
        const lx = Math.min(x1, x2);
        const lw = Math.max(1, Math.abs(x2 - x1));
        if (lx < w && lx + lw > 0) {
          ctx.fillStyle = s.loopActive ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)';
          ctx.fillRect(lx, 0, lw, h);
          ctx.fillStyle = s.loopActive ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)';
          ctx.fillRect(lx, 0, 1, h);
          ctx.fillRect(lx + lw - 1, 0, 1, h);
        }
      }

      for (const sl of s.savedLoops) {
        const slColor = HOT_CUE_COLORS[sl.index] ?? '#ffffff';
        const x1 = secToX(sl.inSec);
        const x2 = secToX(sl.outSec);
        const lx = Math.min(x1, x2);
        const lw = Math.max(1, Math.abs(x2 - x1));
        if (lx < w && lx + lw > 0) {
          ctx.fillStyle = slColor + (sl.active ? '44' : '18');
          ctx.fillRect(lx, 0, lw, h);
          ctx.fillStyle = slColor + (sl.active ? 'cc' : '55');
          ctx.fillRect(lx, 0, 1, h);
        }
      }

      for (let i = startIdx; i <= endIdx; i++) {
        const peak = i >= 0 && i < s.peaks.length ? s.peaks[i] : 0;
        const amp = (peak / s.maxPeak) * mid * 0.92;
        const x = (i - startIdx) * pxPerPeak;
        ctx.fillStyle = (i < 0 || i >= s.peaks.length) ? s.color + '22' : s.color + 'cc';
        ctx.fillRect(x, mid - amp, Math.max(1, pxPerPeak), amp * 2);
      }

      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      const lookBackSec = Math.ceil(leftPeaks / s.peaksPerSec);
      const lookAheadSec = Math.ceil(rightPeaks / s.peaksPerSec);
      for (let offsetSec = -lookBackSec; offsetSec <= lookAheadSec; offsetSec++) {
        const x = (Math.round((elapsed + offsetSec) * s.peaksPerSec) - startIdx) * pxPerPeak;
        ctx.fillRect(x, 0, 1, h);
      }

      for (const cue of s.hotCues) {
        const cueColor = HOT_CUE_COLORS[cue.index] ?? '#ffffff';
        const x = secToX(cue.sec);
        if (x >= -2 && x <= w + 2) {
          ctx.fillStyle = cueColor;
          ctx.fillRect(x - 1, 0, 2, h);
        }
      }

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(w / 4 - 1, 0, 2, h);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [elapsedSecRef]);

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
      <canvas ref={overviewRef} className="waveformOverview" />
      <canvas ref={detailRef} className="waveformDetail" />
    </div>
  );
}
