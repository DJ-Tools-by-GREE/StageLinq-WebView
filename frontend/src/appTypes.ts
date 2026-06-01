import type { WaveformStage } from './types.js';

export interface WaveformState {
  peaks: number[] | null;
  peaksPerSec: number;
  stage: WaveformStage | null;
  progress: number;
  fileName: string;
}
