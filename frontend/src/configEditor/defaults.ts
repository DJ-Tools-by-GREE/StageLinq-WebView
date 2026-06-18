import type { AppConfig } from './editorTypes.js';

export const DEFAULT_CONFIG: AppConfig = {
  current_playlist: 0,
  waveform: { all_tracks: true },
  freewheel: { enable_freewheeling: true, max_duration_sec: 30 },
  sacn_sim: { enabled: true },
  display: { dashboard: true, artnet: true, info: true },
  logging: {
    lifecycle: true,
    playback: true,
    discover: true,
    discoverSpeed: false,
    bpmDebug: false,
    uiOut: false,
    errors: true,
    cues: false,
    artnetStats: true,
  },
  timecode: { fps: 30, target_ips: ['10.15.10.117'], target_port: 6454, stream_id: 0 },
  control_input: { mode: 'sacn', universe: 20, address: 1 },
  osc: { enabled: true, target_ips: ['10.15.10.117'], target_port: 8000, speedmaster: 15 },
  playlists: [],
};

export const DEFAULT_OFFSET_START = 10800;
export const DEFAULT_OFFSET_INCREMENT = 600;
