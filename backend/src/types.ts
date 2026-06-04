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

export interface SnapshotPayload {
  type: 'snapshot';
  seq: number;
  ts: number;
  decks: Record<DeckNumber, DeckState>;
  selectedDeck: DeckNumber | null;
  nextTrack: string | null;
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
