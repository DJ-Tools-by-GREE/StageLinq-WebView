import type { AppConfig } from './editorTypes.js';

export const DEFAULT_CONFIG: AppConfig = {
  current_playlist: -1,
  waveform: { all_tracks: true },
  freewheel: { enable_freewheeling: true, max_duration_sec: 30 },
  sacn_sim: { enabled: false },
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
  osc: { enabled: false, target_ips: ['10.15.10.117'], target_port: 8000, speedmaster: 15 },
  playlists: [],
  recordings: [],
  video: {
    enabled: false,
    multi_ndi_stream: false,
    directory: '',
    ndi_name_prefix: 'StageLinq',
    output_format: 'source',
    latency_comp_ms: 0,
    offsets_sec: {},
  },
};

export const DEFAULT_OFFSET_START = 10800;
export const DEFAULT_OFFSET_INCREMENT = 600;
