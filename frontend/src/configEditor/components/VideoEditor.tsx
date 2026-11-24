import { useState } from 'react';
import type { AppConfig, VideoConfig } from '../editorTypes.js';

interface Props {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
}

export function VideoEditor({ config, onChange }: Props) {
  const [open, setOpen] = useState(true);
  const [track, setTrack] = useState('');
  const [offset, setOffset] = useState('0');
  const [error, setError] = useState('');
  const video = config.video;
  const update = (patch: Partial<VideoConfig>) => onChange({ ...config, video: { ...video, ...patch } });

  const addOffset = () => {
    const key = track.trim();
    const seconds = Number(offset);
    const extensionAt = key.lastIndexOf('.');
    if (!key || key.includes('/') || key.includes('\\') || extensionAt <= 0 || extensionAt === key.length - 1) {
      setError('Enter the audio filename including its extension, without a folder path.');
      return;
    }
    if (Object.hasOwn(video.offsets_sec, key)) {
      setError('This track already has an offset. Edit its value below.');
      return;
    }
    if (!offset.trim() || !Number.isFinite(seconds)) {
      setError('Enter a finite offset in seconds.');
      return;
    }
    update({ offsets_sec: { ...video.offsets_sec, [key]: seconds } });
    setTrack('');
    setOffset('0');
    setError('');
  };

  return (
    <section className="global-settings">
      <div className="section-header">
        <h2>
          <button type="button" className="video-section-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
            <span className="section-toggle">{open ? '▾' : '▸'}</span>
            Video / NDI®
          </button>
        </h2>
      </div>
      {open && (
        <div className="settings-grid">
          <div className="settings-card">
            <h3>Video library</h3>
            <label className="label-inline">
              <span>Enable video output</span>
              <input type="checkbox" checked={video.enabled} onChange={event => update({ enabled: event.target.checked })} />
            </label>
            <label>
              Video folder on the MacBook
              <input type="text" value={video.directory} placeholder="/Volumes/Show/Videos" onChange={event => update({ directory: event.target.value })} />
            </label>
            <p className="hint">
              Includes every subfolder. <code>Artist - Song.mp3</code> matches <code>Artist - Song (Music Video).mp4</code>,
              or another supported video extension. Duplicate matches are reported for review.
            </p>
          </div>
          <div className="settings-card">
            <h3>Four NDI outputs</h3>
            <label>
              Source name prefix
              <input type="text" value={video.ndi_name_prefix} placeholder="StageLinq" onChange={event => update({ ndi_name_prefix: event.target.value })} />
            </label>
            <p className="hint">{video.ndi_name_prefix || 'StageLinq'} Deck 1 through Deck 4. Video only; idle outputs are black.</p>
            <label>
              Output format
              <select value={video.output_format} onChange={event => update({ output_format: event.target.value as VideoConfig['output_format'] })}>
                <option value="source">Source resolution and pitch-adjusted frame rate</option>
                <option value="1080p30">1920 × 1080 at 30 fps</option>
              </select>
            </label>
            <p className="hint">Both modes follow deck position and pitch. Use 1080p30 for a fixed output format.</p>
            <label>
              Output latency compensation (ms)
              <input type="number" step="1" value={video.latency_comp_ms} onChange={event => {
                const value = event.target.valueAsNumber;
                if (Number.isFinite(value)) update({ latency_comp_ms: value });
              }} />
            </label>
            <p className="hint">Positive values advance video playback to compensate for receiver and display delay.</p>
          </div>
          <div className="settings-card video-offsets-card">
            <h3>Per-track video offsets</h3>
            <p className="hint">
              Use the audio filename including its extension. Video position = deck position + offset.
              For example, +2 seconds skips a two-second video intro; −2 seconds starts the video two seconds into the track.
              These offsets are separate from lighting timecode offsets.
            </p>
            <div className="video-offset-add">
              <label>
                Audio filename
                <input type="text" value={track} placeholder="Artist - Song.mp3" onChange={event => { setTrack(event.target.value); setError(''); }} />
              </label>
              <label>
                Offset (seconds)
                <input type="number" step="any" value={offset} onChange={event => { setOffset(event.target.value); setError(''); }} />
              </label>
              <button type="button" className="btn btn-secondary" onClick={addOffset}>Add offset</button>
            </div>
            {error && <p className="hint warn" role="alert">{error}</p>}
            {Object.keys(video.offsets_sec).length === 0 ? (
              <p className="hint">All matched videos start at the same position as their tracks.</p>
            ) : (
              <div className="video-offset-list">
                {Object.entries(video.offsets_sec).map(([key, seconds]) => (
                  <div className="video-offset-row" key={key}>
                    <span className="video-offset-track" title={key}>{key}</span>
                    <input type="number" step="any" aria-label={`Video offset in seconds for ${key}`} value={seconds} onChange={event => {
                      const value = event.target.valueAsNumber;
                      if (Number.isFinite(value)) update({ offsets_sec: { ...video.offsets_sec, [key]: value } });
                    }} />
                    <button type="button" className="btn btn-icon" aria-label={`Remove video offset for ${key}`} onClick={() => {
                      update({ offsets_sec: Object.fromEntries(Object.entries(video.offsets_sec).filter(([name]) => name !== key)) });
                    }}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <p className="hint">
              Save, then use Settings → Controls → Reload config or press Ctrl+R in the backend terminal.
              Settings → Video / NDI shows the active library, output status, and Rescan videos action.
            </p>
            <p className="hint"><a href="https://ndi.video/" target="_blank" rel="noreferrer">NDI®</a> is a registered trademark of Vizrt NDI AB.</p>
          </div>
        </div>
      )}
    </section>
  );
}
