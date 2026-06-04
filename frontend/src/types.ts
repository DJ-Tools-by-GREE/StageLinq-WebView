export type DeckNumber = 1 | 2 | 3 | 4;

export interface HotCue {
  index: number;
  sec: number;
}

export interface SavedLoop {
  index: number;
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
  hotCues: HotCue[];
  loopActive: boolean;
  loopInSec: number | null;
  loopOutSec: number | null;
  savedLoops: SavedLoop[];
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
  selectedDeck: DeckNumber | null;
  nextTrack: string | null;
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
  data: string | null;
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
