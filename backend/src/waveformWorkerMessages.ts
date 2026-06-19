// IPC contract between the main thread and the waveform worker
// (parallel to artnetWorkerMessages.ts).
//
// The worker owns ffmpeg, peak compute, base64, JSON serialization for the
// per-track waveform/artwork WS frames, and waveform/artwork disk-cache I/O.
// The main thread does NOT do any of that work — it only forwards the
// downloaded audio bytes in and the pre-built WS frame strings out.

export interface CachedWaveformEntry {
  fileName: string;
  /** Pre-serialized `waveform_data` WS frame, ready to ws.send() verbatim. Null if no peaks for this track. */
  peaksFrame: string | null;
  /** Pre-serialized `artwork_data` WS frame, ready to ws.send() verbatim (with base64 already baked in). */
  artworkFrame: string;
  /** Raw artwork bytes for the HTTP /api/artwork/:deck route (Buffer-backed on main thread). */
  artworkBytes: ArrayBuffer | null;
  artworkMime: string | null;
}

export type MainToWaveformWorker =
  | { type: 'init'; cacheDir: string }
  /**
   * Extract peaks + artwork for one track. The ArrayBuffer is transferred
   * (zero-copy) — main thread MUST NOT touch the original Uint8Array after
   * posting this message.
   */
  | {
      type: 'extract';
      jobId: number;
      fileName: string;
      totalSec: number;
      audioBuf: ArrayBuffer;
      audioByteOffset: number;
      audioByteLength: number;
      /** When true, we already have peaks cached and only need the artwork extracted. */
      artworkOnly: boolean;
    }
  | { type: 'shutdown' };

export type WaveformWorkerToMain =
  | { type: 'ready' }
  | {
      type: 'cacheLoaded';
      entries: CachedWaveformEntry[];
      peaksLoadedCount: number;
      artworksLoadedCount: number;
    }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | {
      type: 'progress';
      jobId: number;
      stage: 'downloading' | 'generating';
      progress: number;
    }
  | {
      type: 'result';
      jobId: number;
      fileName: string;
      peaksFrame: string | null;
      artworkFrame: string;
      artworkBytes: ArrayBuffer | null;
      artworkMime: string | null;
      peaksLen: number;
    }
  | { type: 'error'; jobId: number; fileName: string; msg: string };
