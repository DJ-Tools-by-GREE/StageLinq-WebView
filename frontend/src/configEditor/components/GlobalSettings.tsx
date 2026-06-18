import { useState } from 'react';
import type { AppConfig } from '../editorTypes.js';

interface Props {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function isValidIpv4(s: string): boolean {
  return IPV4_RE.test(s.trim());
}

interface IpListEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
}

function IpListEditor({ value, onChange }: IpListEditorProps) {
  const update = (i: number, v: string) => {
    const next = [...value];
    next[i] = v;
    onChange(next);
  };
  const remove = (i: number) => {
    const next = value.filter((_, j) => j !== i);
    onChange(next);
  };
  const add = () => onChange([...value, '']);

  return (
    <div className="ip-list">
      {value.length === 0 && (
        <p className="hint warn">⚠ No targets — backend will fall back to env / default.</p>
      )}
      {value.map((ip, i) => {
        const trimmed = ip.trim();
        const invalid = trimmed.length > 0 && !isValidIpv4(trimmed);
        return (
          <div key={i} className="ip-row">
            <input
              type="text"
              value={ip}
              placeholder="0.0.0.0"
              className={invalid ? 'invalid' : ''}
              onChange={e => update(i, e.target.value)}
            />
            <button
              type="button"
              className="btn btn-icon"
              title="Remove"
              onClick={() => remove(i)}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button type="button" className="btn btn-secondary btn-small" onClick={add}>
        + Add IP
      </button>
    </div>
  );
}

export function GlobalSettings({ config, onChange }: Props) {
  const [open, setOpen] = useState(true);

  const setTimecode = (patch: Partial<AppConfig['timecode']>) =>
    onChange({ ...config, timecode: { ...config.timecode, ...patch } });

  const setControlInput = (patch: Partial<AppConfig['control_input']>) =>
    onChange({ ...config, control_input: { ...config.control_input, ...patch } });

  const setOsc = (patch: Partial<AppConfig['osc']>) =>
    onChange({ ...config, osc: { ...config.osc, ...patch } });

  const setWaveform = (patch: Partial<AppConfig['waveform']>) =>
    onChange({ ...config, waveform: { ...config.waveform, ...patch } });

  const setFreewheel = (patch: Partial<AppConfig['freewheel']>) =>
    onChange({ ...config, freewheel: { ...config.freewheel, ...patch } });

  const setSacnSim = (patch: Partial<AppConfig['sacn_sim']>) =>
    onChange({ ...config, sacn_sim: { ...config.sacn_sim, ...patch } });

  const setDisplay = (patch: Partial<AppConfig['display']>) =>
    onChange({ ...config, display: { ...config.display, ...patch } });

  const setLogging = (patch: Partial<AppConfig['logging']>) =>
    onChange({ ...config, logging: { ...config.logging, ...patch } });

  return (
    <section className="global-settings">
      <div className="section-header" onClick={() => setOpen(o => !o)}>
        <span className="section-toggle">{open ? '▾' : '▸'}</span>
        <h2>Global Settings</h2>
      </div>

      {open && (
        <div className="settings-grid">
          <div className="settings-card">
            <h3>Timecode</h3>
            <label>
              Target IPs
              <IpListEditor
                value={config.timecode.target_ips}
                onChange={target_ips => setTimecode({ target_ips })}
              />
            </label>
            <label>
              Target Port
              <input
                type="number"
                value={config.timecode.target_port}
                onChange={e => setTimecode({ target_port: Number(e.target.value) })}
              />
            </label>
            <label>
              FPS
              <input
                type="number"
                step="0.01"
                value={config.timecode.fps}
                onChange={e => setTimecode({ fps: Number(e.target.value) })}
              />
            </label>
            <label>
              Stream ID
              <input
                type="number"
                value={config.timecode.stream_id}
                onChange={e => setTimecode({ stream_id: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="settings-card">
            <h3>Control Input</h3>
            <label>
              Mode
              <select
                value={config.control_input.mode}
                onChange={e => setControlInput({ mode: e.target.value })}
              >
                <option value="sacn">sACN</option>
                <option value="artnet">Art-Net</option>
              </select>
            </label>
            <label>
              Universe
              <input
                type="number"
                value={config.control_input.universe}
                onChange={e => setControlInput({ universe: Number(e.target.value) })}
              />
            </label>
            <label>
              DMX Address
              <input
                type="number"
                value={config.control_input.address}
                onChange={e => setControlInput({ address: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="settings-card">
            <h3>sACN Sim</h3>
            <label className="label-inline">
              <span>Enabled</span>
              <input
                type="checkbox"
                checked={config.sacn_sim.enabled}
                onChange={e => setSacnSim({ enabled: e.target.checked })}
              />
            </label>
            <p className="hint">Simulated sACN feed for development.</p>
          </div>

          <div className="settings-card">
            <h3>OSC</h3>
            <label className="label-inline">
              <span>Enabled</span>
              <input
                type="checkbox"
                checked={config.osc.enabled}
                onChange={e => setOsc({ enabled: e.target.checked })}
              />
            </label>
            <label>
              Target IPs
              <IpListEditor
                value={config.osc.target_ips}
                onChange={target_ips => setOsc({ target_ips })}
              />
            </label>
            <label>
              Target Port
              <input
                type="number"
                value={config.osc.target_port}
                onChange={e => setOsc({ target_port: Number(e.target.value) })}
              />
            </label>
            <label>
              SpeedMaster Ch
              <input
                type="number"
                value={config.osc.speedmaster}
                onChange={e => setOsc({ speedmaster: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="settings-card">
            <h3>Waveform</h3>
            <label className="label-inline">
              <span>All Tracks</span>
              <input
                type="checkbox"
                checked={config.waveform.all_tracks}
                onChange={e => setWaveform({ all_tracks: e.target.checked })}
              />
            </label>
            <p className="hint">
              When off, peaks are only extracted for tracks in the active playlist.
            </p>
          </div>

          <div className="settings-card">
            <h3>Freewheel</h3>
            <label className="label-inline">
              <span>Enable Freewheeling</span>
              <input
                type="checkbox"
                checked={config.freewheel.enable_freewheeling}
                onChange={e => setFreewheel({ enable_freewheeling: e.target.checked })}
              />
            </label>
            <label>
              Max Duration (sec)
              <input
                type="number"
                min={0}
                max={3600}
                value={config.freewheel.max_duration_sec}
                onChange={e => setFreewheel({
                  max_duration_sec: Math.max(0, Math.min(3600, Number(e.target.value))),
                })}
              />
            </label>
            <p className="hint">
              During a StageLinq stall, the Art-Net worker keeps emitting timecode at the last-known speed. After this many seconds it goes silent until beats resume. Disable to skip freewheel entirely.
            </p>
          </div>

          <div className="settings-card">
            <h3>Console Display</h3>
            <label className="label-inline">
              <span>Dashboard</span>
              <input
                type="checkbox"
                checked={config.display.dashboard}
                onChange={e => setDisplay({ dashboard: e.target.checked })}
              />
            </label>
            <label className="label-inline">
              <span>Art-Net</span>
              <input
                type="checkbox"
                checked={config.display.artnet}
                onChange={e => setDisplay({ artnet: e.target.checked })}
              />
            </label>
            <label className="label-inline">
              <span>Info</span>
              <input
                type="checkbox"
                checked={config.display.info}
                onChange={e => setDisplay({ info: e.target.checked })}
              />
            </label>
          </div>

          <div className="settings-card">
            <h3>Logging Channels</h3>
            <label className="label-inline">
              <span>Lifecycle</span>
              <input
                type="checkbox"
                checked={config.logging.lifecycle}
                onChange={e => setLogging({ lifecycle: e.target.checked })}
              />
            </label>
            <label className="label-inline">
              <span>Playback</span>
              <input
                type="checkbox"
                checked={config.logging.playback}
                onChange={e => setLogging({ playback: e.target.checked })}
              />
            </label>
            <label className="label-inline">
              <span>Discover</span>
              <input
                type="checkbox"
                checked={config.logging.discover}
                onChange={e => setLogging({ discover: e.target.checked })}
              />
            </label>
            <label
              className={`label-inline indent${config.logging.discover ? '' : ' disabled'}`}
            >
              <span>Discover Speed</span>
              <input
                type="checkbox"
                checked={config.logging.discoverSpeed}
                onChange={e => setLogging({ discoverSpeed: e.target.checked })}
              />
            </label>
            <label className="label-inline">
              <span>BPM Debug</span>
              <input
                type="checkbox"
                checked={config.logging.bpmDebug}
                onChange={e => setLogging({ bpmDebug: e.target.checked })}
              />
            </label>
            <label className="label-inline">
              <span>UI Out</span>
              <input
                type="checkbox"
                checked={config.logging.uiOut}
                onChange={e => setLogging({ uiOut: e.target.checked })}
              />
            </label>
            <label className="label-inline">
              <span>Errors</span>
              <input
                type="checkbox"
                checked={config.logging.errors}
                onChange={e => setLogging({ errors: e.target.checked })}
              />
            </label>
            <label className="label-inline">
              <span>Cues</span>
              <input
                type="checkbox"
                checked={config.logging.cues}
                onChange={e => setLogging({ cues: e.target.checked })}
              />
            </label>
            <label className="label-inline">
              <span>Art-Net Stats</span>
              <input
                type="checkbox"
                checked={config.logging.artnetStats}
                onChange={e => setLogging({ artnetStats: e.target.checked })}
              />
            </label>
            <p className="hint">
              Art-Net Stats only silences periodic heartbeat logs — warnings are emitted regardless.
            </p>
          </div>

          <div className="settings-card">
            <h3>Active Playlist</h3>
            <label>
              Index
              <select
                value={config.current_playlist}
                onChange={e => onChange({ ...config, current_playlist: Number(e.target.value) })}
              >
                {config.playlists.length === 0 && <option value={0}>— none —</option>}
                {config.playlists.map((pl, i) => (
                  <option key={i} value={i}>{i}: {pl.name}</option>
                ))}
              </select>
            </label>
            <p className="hint">
              This index is written to config.json and controls which playlist the backend uses at runtime.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
