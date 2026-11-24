import type { DeckNumber } from './types.js';

export interface VideoDeckStatus {
  deck: DeckNumber;
  track: string;
  video: string | null;
  sourceName: string;
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
  outputFormat: 'source' | '1080p30';
  sourcePrefix: string;
  indexedVideos: number;
  ambiguousMatches: string[];
  error: string | null;
  decks: Record<DeckNumber, VideoDeckStatus>;
}
