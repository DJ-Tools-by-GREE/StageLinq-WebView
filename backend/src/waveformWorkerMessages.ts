export interface MediaFrames {
  peaksFrame: string | null;
  artworkFrame: string | null;
}

export interface CachedWaveformEntry extends MediaFrames {
  trackId: string;
  fileName: string;
  artworkBytes: ArrayBuffer | null;
  artworkMime: string | null;
}

export type MainToWaveformWorker =
  | { type: 'init'; cacheDir: string }
  | { type: 'load'; jobId: number; trackId: string; fileName: string }
  | {
      type: 'extract'; jobId: number; trackId: string; fileName: string;
      totalSec: number; audioBuf: ArrayBuffer; audioByteOffset: number;
      audioByteLength: number; artworkOnly: boolean;
    }
  | { type: 'cancel'; jobId: number }
  | { type: 'shutdown' };

export type WaveformWorkerToMain =
  | { type: 'ready' }
  | { type: 'initError'; msg: string }
  | { type: 'child'; pid: number; active: boolean }
  | { type: 'temporary'; directory: string; active: boolean }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'progress'; jobId: number; stage: 'downloading' | 'generating'; progress: number }
  | ({ type: 'result'; jobId: number } & CachedWaveformEntry)
  | { type: 'error'; jobId: number; msg: string; aborted: boolean };
