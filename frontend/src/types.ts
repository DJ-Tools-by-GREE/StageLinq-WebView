export type DeckNumber = 1 | 2 | 3 | 4;

export interface DeckState {
  deck: DeckNumber;
  trackLoaded: boolean;
  title: string;
  artist: string;
  elapsedSec: number;
  totalSec: number;
  currentBpm: number;
  trackBpm: number;
  speedState: number;
  keyIndex: number | null;
  keyCamelot: string;
  fader: number;
  play: boolean;
  updatedAt: number;
}

export interface HelloPayload {
  type: 'hello';
  ts: number;
  version: string;
  fps: number;
}

export interface SnapshotPayload {
  type: 'snapshot';
  seq: number;
  ts: number;
  decks: Record<DeckNumber, DeckState>;
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
