// Editor-only schema. Mirrors the backend's RootConfig but with required
// fields (the editor never holds a partial config — it migrates incoming
// JSON to a fully-populated AppConfig before letting the UI touch it).

export interface NoteField {
  description: string;
  /** Delay (in seconds) measured from track-load before the note is shown. Default 0. */
  show_secs_after_load: number;
}

export interface PlaylistEntry {
  song_index: string;
  offset_sec: number;
  offset_frame: number;
  note: NoteField;
  /** When true, treat as overlay/vocals-only — backend skips offset/timecode/next-track logic for this row. Omitted from saved JSON when false/undefined. */
  mashup_only?: boolean;
}

export interface Playlist {
  name: string;
  content: PlaylistEntry[];
}

export interface TimecodeConfig {
  fps: number;
  target_ips: string[];
  /** Legacy single-target field. Read for migration on load; not written on save once target_ips is non-empty. */
  target_ip?: string;
  target_port: number;
  stream_id: number;
}

export interface ControlInputConfig {
  mode: string;
  universe: number;
  address: number;
}

export interface OscConfig {
  enabled: boolean;
  target_ips: string[];
  /** Legacy single-target field. Read for migration on load; not written on save once target_ips is non-empty. */
  target_ip?: string;
  target_port: number;
  speedmaster: number;
}

export interface WaveformConfig {
  all_tracks: boolean;
}

export interface FreewheelConfig {
  enable_freewheeling: boolean;
  /** Backend clamps to 0–3600. */
  max_duration_sec: number;
}

export interface SacnSimConfig {
  enabled: boolean;
}

export interface DisplayConfig {
  dashboard: boolean;
  artnet: boolean;
  info: boolean;
}

export interface LoggingConfig {
  lifecycle: boolean;
  playback: boolean;
  discover: boolean;
  discoverSpeed: boolean;
  bpmDebug: boolean;
  uiOut: boolean;
  errors: boolean;
  cues: boolean;
  artnetStats: boolean;
}

export interface AppConfig {
  current_playlist: number;
  waveform: WaveformConfig;
  freewheel: FreewheelConfig;
  sacn_sim: SacnSimConfig;
  display: DisplayConfig;
  logging: LoggingConfig;
  timecode: TimecodeConfig;
  control_input: ControlInputConfig;
  osc: OscConfig;
  playlists: Playlist[];
}

export interface CsvSong {
  title: string;
  artist: string;
  fileName: string;
}
