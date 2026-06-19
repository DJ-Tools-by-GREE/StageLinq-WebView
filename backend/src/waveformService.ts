import { Worker } from 'node:worker_threads';
import { logError, logLifecycle, logWarn } from './logging.js';
import type {
  CachedWaveformEntry,
  MainToWaveformWorker,
  WaveformWorkerToMain,
} from './waveformWorkerMessages.js';

/**
 * Pre-serialized WS frame caches owned by the main thread. The waveform worker
 * builds these strings (peaks → JSON, artwork → base64+JSON) so the broadcast
 * paths and the on-connect replay path do zero CPU work — they look up a
 * string and call ws.send().
 *
 * artworkCache exists alongside artworkFrameCache for the HTTP /api/artwork/:deck
 * route which serves the raw image bytes (Content-Type via mime).
 */
export const peaksFrameCache = new Map<string, string>();
export const artworkFrameCache = new Map<string, string>();
export const artworkCache = new Map<string, { data: Buffer; mime: string } | null>();

interface PendingJob {
  resolve: (entry: { peaksFrame: string | null; artworkFrame: string }) => void;
  reject: (err: Error) => void;
  onProgress?: (stage: 'downloading' | 'generating', progress: number) => void;
}

let worker: Worker | null = null;
let nextJobId = 1;
const pending = new Map<number, PendingJob>();

export async function initWaveformCache(cacheDir: string): Promise<void> {
  if (worker) return;

  // tsx propagates its loader to worker_threads automatically (tsx 4.x), so we
  // can resolve both .ts (dev under tsx watch) and .js (compiled dist) source
  // from the same path by switching extensions at runtime.
  const isTs = import.meta.url.endsWith('.ts');
  const workerUrl = new URL(`./waveformWorker.${isTs ? 'ts' : 'js'}`, import.meta.url);

  const w = new Worker(workerUrl);
  worker = w;

  w.on('error', (err) => {
    logError('[WAVEFORM] Worker error:', err?.message || err);
  });
  w.on('exit', (code) => {
    if (code !== 0) {
      logError(`[WAVEFORM] Worker exited with code ${code}`);
    }
    worker = null;
  });

  await new Promise<void>((resolve, reject) => {
    const onMessage = (m: WaveformWorkerToMain) => {
      switch (m.type) {
        case 'cacheLoaded':
          ingestCacheLoaded(m.entries);
          break;
        case 'ready':
          w.off('message', onMessage);
          w.off('error', onError);
          // After ready: install the steady-state message router. Any 'log' or
          // 'cacheLoaded' messages that arrived before ready are already handled.
          w.on('message', handleWorkerMessage);
          resolve();
          break;
        case 'log':
          routeLog(m.level, m.msg);
          break;
        // 'progress', 'result', 'error' are not expected before ready, ignore.
      }
    };
    const onError = (err: Error) => {
      w.off('message', onMessage);
      w.off('error', onError);
      reject(err);
    };
    w.on('message', onMessage);
    w.on('error', onError);
    post({ type: 'init', cacheDir });
  });
}

function ingestCacheLoaded(entries: CachedWaveformEntry[]): void {
  for (const e of entries) {
    if (e.peaksFrame) peaksFrameCache.set(e.fileName, e.peaksFrame);
    artworkFrameCache.set(e.fileName, e.artworkFrame);
    if (e.artworkBytes && e.artworkMime) {
      artworkCache.set(e.fileName, {
        data: Buffer.from(e.artworkBytes),
        mime: e.artworkMime,
      });
    } else {
      // entry exists on disk as ".none" sentinel — represented by `null`.
      artworkCache.set(e.fileName, null);
    }
  }
}

function handleWorkerMessage(m: WaveformWorkerToMain): void {
  switch (m.type) {
    case 'log':
      routeLog(m.level, m.msg);
      break;
    case 'progress': {
      const job = pending.get(m.jobId);
      job?.onProgress?.(m.stage, m.progress);
      break;
    }
    case 'result': {
      const job = pending.get(m.jobId);
      pending.delete(m.jobId);
      if (m.peaksFrame) peaksFrameCache.set(m.fileName, m.peaksFrame);
      artworkFrameCache.set(m.fileName, m.artworkFrame);
      if (m.artworkBytes && m.artworkMime) {
        artworkCache.set(m.fileName, {
          data: Buffer.from(m.artworkBytes),
          mime: m.artworkMime,
        });
      } else {
        artworkCache.set(m.fileName, null);
      }
      job?.resolve({ peaksFrame: m.peaksFrame, artworkFrame: m.artworkFrame });
      break;
    }
    case 'error': {
      const job = pending.get(m.jobId);
      pending.delete(m.jobId);
      job?.reject(new Error(m.msg));
      break;
    }
    case 'ready':
    case 'cacheLoaded':
      // Only valid before steady-state; ignored here.
      break;
  }
}

function routeLog(level: 'info' | 'warn' | 'error', msg: string): void {
  if (level === 'error') logError(msg);
  else if (level === 'warn') logWarn(msg);
  else logLifecycle(msg);
}

function post(msg: MainToWaveformWorker, transfer?: Transferable[]): void {
  if (!worker) return;
  try {
    if (transfer && transfer.length > 0) worker.postMessage(msg, transfer as any);
    else worker.postMessage(msg);
  } catch (e: any) {
    logError('[WAVEFORM] postMessage failed:', e?.message || e);
  }
}

/**
 * Hand audio bytes to the worker for ffmpeg / peak / base64 / JSON work.
 * `audioBytes.buffer` is TRANSFERRED — the caller MUST NOT use the Uint8Array
 * after this call returns. Returns once peaks + artwork are extracted, the
 * disk caches are updated, and the in-memory frame caches are populated.
 *
 * `artworkOnly` skips peak extraction (peaks already cached); the worker still
 * runs ffmpeg once for artwork.
 */
export function requestExtraction(
  fileName: string,
  totalSec: number,
  audioBytes: Uint8Array,
  artworkOnly: boolean,
  onProgress?: (stage: 'downloading' | 'generating', progress: number) => void,
): Promise<{ peaksFrame: string | null; artworkFrame: string }> {
  if (!worker) {
    return Promise.reject(new Error('waveform worker not initialized'));
  }
  const jobId = nextJobId++;
  return new Promise((resolve, reject) => {
    pending.set(jobId, { resolve, reject, onProgress });
    post(
      {
        type: 'extract',
        jobId,
        fileName,
        totalSec,
        audioBuf: audioBytes.buffer as ArrayBuffer,
        audioByteOffset: audioBytes.byteOffset,
        audioByteLength: audioBytes.byteLength,
        artworkOnly,
      },
      // Zero-copy transfer of the underlying ArrayBuffer.
      [audioBytes.buffer as ArrayBuffer],
    );
  });
}

export async function shutdownWaveformWorker(): Promise<void> {
  if (!worker) return;
  post({ type: 'shutdown' });
  const w = worker;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { w.terminate(); } catch {}
      resolve();
    }, 1000);
    w.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  worker = null;
}
