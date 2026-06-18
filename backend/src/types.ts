export type DeckNumber = 1 | 2 | 3 | 4;

export interface HotCue {
  index: number; // 1–8
  sec: number;
}

export interface SavedLoop {
  index: number; // 1–8
  inSec: number;
  outSec: number;
  active: boolean;
}

export interface TrackNote {
  description: string;
  showSecsAfterLoad: number;
}

export interface DeckState {
  deck: DeckNumber;
  trackLoaded: boolean;
  fileName: string;
  title: string;
  artist: string;
  elapsedSec: number; // BeatInfo timeline (seconds)
  totalSec: number;   // TrackLength (seconds)
  currentBpm: number;
  trackBpm: number;   // derived base BPM from currentBpm and SpeedState when available
  speedState: number; // relative pitch percent (e.g. +1.52)
  keyIndex: number | null;
  keyCamelot: string; // derived display string
  fader: number;      // 0..1 (ExternalMixerVolume)
  play: boolean;
  updatedAt: number;  // ms
  hotCues: HotCue[];
  loopActive: boolean;
  loopInSec: number | null;
  loopOutSec: number | null;
  savedLoops: SavedLoop[];
}

// 'connected'    — beats arriving within threshold
// 'no-device'    — WS up, announce sent, but no beats (cable pulled, device off)
// 'reconnecting' — actively in reconnect loop (bridge.disconnect() was called)
export type StageLinqStatus = 'connected' | 'no-device' | 'reconnecting';

export interface RecordingStatus {
  active: boolean;
  file: string | null;       // basename of the active jsonl, or last-completed
  startedAt: number | null;  // ms epoch
  eventCount: number;
}

// Replay lifecycle:
//   idle      — engine off; outputs come from bridge.
//   armed     — log files loaded, watching for a mapped audio file to load.
//   attaching — mapped audio file loaded on a deck; waiting for play to start.
//   active    — audio playing; outputs come from the log, indexed by audio deck elapsedSec.
//   ended     — replay reached past log duration; all decks held at play=false.
export type ReplayState = 'idle' | 'armed' | 'attaching' | 'active' | 'ended';

export interface ReplayStatus {
  state: ReplayState;
  audioDeck: DeckNumber | null;
  audioFile: string | null;     // mapped basename
  logFile: string | null;       // basename of the loaded jsonl
  cursorMs: number;
  durationMs: number;
}

export interface SnapshotPayload {
  type: 'snapshot';
  seq: number;
  ts: number;
  decks: Record<DeckNumber, DeckState>;
  selectedDeck: DeckNumber | null;
  // Deck the operator is advised to switch to next (track in active playlist
  // is loaded there, no loop active, and either that deck is playing or the
  // selected deck has stopped). Null when nothing matches.
  suggestedDeck: DeckNumber | null;
  nextTrack: string | null;
  stagelinqStatus: StageLinqStatus;
  deckNotes: Record<DeckNumber, TrackNote | null>;
  recordingStatus?: RecordingStatus;
  replayStatus?: ReplayStatus;
}

export interface HelloPayload {
  type: 'hello';
  ts: number;
  version: string;
  fps: number;
}

export type WaveformStage = 'downloading' | 'generating' | 'ready' | 'error';

export interface WaveformStatusPayload {
  type: 'waveform_status';
  deck: DeckNumber;
  stage: WaveformStage;
  progress: number;
  fileName: string;
}

export interface ArtworkDataPayload {
  type: 'artwork_data';
  fileName: string;
  data: string | null; // base64-encoded image, null if no artwork
  mime: string | null;
}

export interface WaveformDataPayload {
  type: 'waveform_data';
  deck: DeckNumber;
  fileName: string;
  peaks: number[];
  peaksPerSec: number;
}

export type WsPayload = HelloPayload | SnapshotPayload | WaveformStatusPayload | WaveformDataPayload | ArtworkDataPayload;
