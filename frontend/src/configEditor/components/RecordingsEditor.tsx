import { useEffect, useState } from 'react';
import type { AppConfig, RecordingMapping } from '../editorTypes.js';

interface Props {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
}

interface RecordingMeta {
  file: string;
  startedAt: number;
  stoppedAt: number;
  durationMs: number;
  eventCount: number;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function fmtDate(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString();
}

/**
 * Recordings tab: maps audio-file basenames (the long backup-set audio you'll load on a
 * deck during a fallback show) to log-file basenames inside `<repo>/recordings/`.
 *
 * When the operator presses "Arm Replay" in the header and then loads a mapped audio file
 * on a deck, the backend takes over the simulated decks from that log.
 */
export function RecordingsEditor({ config, onChange }: Props) {
  const [open, setOpen] = useState(true);
  const [available, setAvailable] = useState<RecordingMeta[]>([]);
  const [recordingsDir, setRecordingsDir] = useState<string>('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/recordings')
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ recordings: RecordingMeta[]; dir: string }>;
      })
      .then(body => {
        if (cancelled) return;
        setAvailable(body.recordings ?? []);
        setRecordingsDir(body.dir ?? '');
      })
      .catch(e => { if (!cancelled) setLoadError((e as Error).message); });
    return () => { cancelled = true; };
  }, []);

  const update = (i: number, patch: Partial<RecordingMapping>) => {
    const next = config.recordings.map((m, j) => j === i ? { ...m, ...patch } : m);
    onChange({ ...config, recordings: next });
  };
  const remove = (i: number) => {
    onChange({ ...config, recordings: config.recordings.filter((_, j) => j !== i) });
  };
  const add = () => {
    onChange({ ...config, recordings: [...config.recordings, { audio_file: '', log_file: '' }] });
  };

  return (
    <section className="global-settings">
      <div className="section-header" onClick={() => setOpen(o => !o)}>
        <span className="section-toggle">{open ? '▾' : '▸'}</span>
        <h2>Recordings (Replay)</h2>
      </div>

      {open && (
        <div className="settings-grid">
          <div className="settings-card" style={{ gridColumn: '1 / -1' }}>
            <p className="hint">
              Map an audio-file name (loaded on a DJ deck) to a recorded log inside{' '}
              <code>{recordingsDir || 'recordings/'}</code>. After saving, press the
              backend Ctrl+R or call <code>POST /api/config/reload</code>, then click
              <strong> ARM REPLAY</strong> in the header to activate the watchers.
            </p>
            {loadError && <p className="hint warn">⚠ Could not list recordings: {loadError}</p>}
            {available.length > 0 && (
              <p className="hint">
                Available logs: {available.map(m => `${m.file} (${fmtDuration(m.durationMs)})`).join(', ')}
              </p>
            )}

            {config.recordings.length === 0 && (
              <p className="hint">No mappings yet. Click "+ Add mapping" below.</p>
            )}

            {config.recordings.map((m, i) => (
              <div key={i} className="ip-row" style={{ marginTop: 8 }}>
                <input
                  type="text"
                  placeholder="audio file basename (e.g. backup-set.wav)"
                  value={m.audio_file}
                  onChange={e => update(i, { audio_file: e.target.value })}
                  style={{ flex: 1 }}
                />
                <span style={{ opacity: 0.6, padding: '0 4px' }}>→</span>
                <select
                  value={m.log_file}
                  onChange={e => update(i, { log_file: e.target.value })}
                  style={{ flex: 1 }}
                >
                  <option value="">— pick a log —</option>
                  {/* If the saved value isn't in the list (file moved/renamed), still show it. */}
                  {m.log_file && !available.some(a => a.file === m.log_file) && (
                    <option value={m.log_file}>{m.log_file} (missing)</option>
                  )}
                  {available.map(a => (
                    <option key={a.file} value={a.file}>
                      {a.file} ({fmtDuration(a.durationMs)}, {fmtDate(a.startedAt)})
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => remove(i)} title="Remove mapping">✕</button>
              </div>
            ))}

            <button type="button" onClick={add} style={{ marginTop: 12 }}>+ Add mapping</button>
          </div>
        </div>
      )}
    </section>
  );
}
