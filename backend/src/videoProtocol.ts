import type { DeckNumber } from './types.js';

export interface VideoDeckCommand {
  deck: DeckNumber;
  generation: string;
  path: string | null;
  positionSec: number;
  rate: number;
  playing: boolean;
}

export interface NativeVideoStatus {
  deck: DeckNumber;
  generation?: string;
  state: 'idle' | 'loading' | 'playing' | 'error';
  error?: string;
  width?: number;
  height?: number;
  fps?: number;
}
