export type DeckNumber = 1 | 2 | 3 | 4;

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
}

export interface SnapshotPayload {
  type: 'snapshot';
  seq: number;
  ts: number;
  decks: Record<DeckNumber, DeckState>;
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

export interface WaveformDataPayload {
  type: 'waveform_data';
  deck: DeckNumber;
  fileName: string;
  peaks: number[];
  peaksPerSec: number;
}

export type WsPayload = HelloPayload | SnapshotPayload | WaveformStatusPayload | WaveformDataPayload;
