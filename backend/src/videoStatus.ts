import type { DeckNumber } from './types.js';
import type { VideoOutputFormat } from './videoTypes.js';

export interface VideoDeckStatus {
  deck: DeckNumber;
  track: string;
  video: string | null;
  sourceName: string | null;
  state: 'idle' | 'unmatched' | 'ambiguous' | 'loading' | 'playing' | 'black' | 'error';
  message: string | null;
  positionSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
}

export interface VideoStatus {
  enabled: boolean;
  running: boolean;
  directory: string;
  outputFormat: VideoOutputFormat;
  sourcePrefix: string;
  multiNdiStream: boolean;
  activeDeck: DeckNumber | null;
  indexedVideos: number;
  ambiguousMatches: string[];
  error: string | null;
  decks: Record<DeckNumber, VideoDeckStatus>;
}
