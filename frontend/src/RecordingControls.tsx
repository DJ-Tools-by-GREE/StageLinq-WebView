import { useState } from 'react';
import type { RecordingStatus, ReplayStatus } from './types.js';

interface Props {
  recordingStatus: RecordingStatus | null;
  replayStatus: ReplayStatus | null;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

async function postJson(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch (e: any) {
    return { ok: false, status: 0, data: { error: e?.message || String(e) } };
  }
}

export default function RecordingControls({ recordingStatus, replayStatus }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recording = recordingStatus?.active ?? false;
  const replay = replayStatus?.state ?? 'idle';
  const replayActive = replay !== 'idle';

  const elapsed = recording && recordingStatus?.startedAt
    ? fmtDuration(Date.now() - recordingStatus.startedAt)
    : '';

  const replayBadge = (() => {
    switch (replay) {
      case 'armed': return { label: 'ARMED', cls: 'replayBadge--armed' };
      case 'attaching': return { label: 'ATTACHING', cls: 'replayBadge--attaching' };
      case 'active': return { label: 'REPLAY', cls: 'replayBadge--active' };
      case 'ended': return { label: 'REPLAY END', cls: 'replayBadge--ended' };
      default: return null;
    }
  })();

  async function handleRecord() {
    setError(null);
    setBusy(true);
    try {
      const url = recording ? '/api/record/stop' : '/api/record/start';
      const r = await postJson(url);
      if (!r.ok) setError(r.data?.error || `HTTP ${r.status}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleReplay() {
    setError(null);
    setBusy(true);
    try {
      const url = replayActive ? '/api/replay/disarm' : '/api/replay/arm';
      const r = await postJson(url);
      if (!r.ok) {
        const detail = r.data?.errors?.[0]?.error || r.data?.error || `HTTP ${r.status}`;
        setError(detail);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="recCtrl">
      {replayBadge && (
        <span className={`replayBadge ${replayBadge.cls}`} title={replayStatus?.logFile ?? ''}>
          {replayBadge.label}
          {replay === 'active' && replayStatus?.cursorMs != null && (
            <span className="replayBadgeTime">
              {fmtDuration(replayStatus.cursorMs)} / {fmtDuration(replayStatus.durationMs)}
            </span>
          )}
        </span>
      )}
      <button
        className={`toggleBtn ${recording ? 'recBtn--on' : ''}`}
        onClick={handleRecord}
        disabled={busy || (replayActive && !recording)}
        title={replayActive && !recording ? 'Cannot record during replay' : ''}
      >
        {recording ? `● REC ${elapsed}` : 'REC'}
      </button>
      <button
        className={`toggleBtn ${replayActive ? 'on' : 'off'}`}
        onClick={handleReplay}
        disabled={busy || recording}
        title={recording ? 'Cannot arm replay while recording' : ''}
      >
        {replayActive ? 'DISARM REPLAY' : 'ARM REPLAY'}
      </button>
      {error && <span className="recCtrlError" title={error}>!</span>}
    </div>
  );
}
