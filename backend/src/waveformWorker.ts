import { parentPort } from 'node:worker_threads';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaDiskCache, type CachedMedia } from './mediaDiskCache.js';
import { extractArtwork, extractPeaks, setMediaProcessObserver } from './mediaExtraction.js';
import { MEDIA_EXTRACTION_CONCURRENCY, MEDIA_JOB_TIMEOUT_MS, WAVEFORM_PEAKS_PER_SEC } from './constants.js';
import type { CachedWaveformEntry, MainToWaveformWorker, WaveformWorkerToMain } from './waveformWorkerMessages.js';

if (!parentPort) throw new Error('waveformWorker must be spawned as a worker_thread');
const port = parentPort;
const send = (message: WaveformWorkerToMain, transfer: ArrayBuffer[] = []) => port.postMessage(message, transfer);
setMediaProcessObserver((pid, active) => send({ type: 'child', pid, active }));
const warn = (msg: string) => send({ type: 'log', level: 'warn', msg });
let cache: MediaDiskCache | undefined;
let closing = false;
const jobs = new Map<number, { controller: AbortController; done: Promise<void> }>();
type JobMessage = Extract<MainToWaveformWorker, { type: 'load' | 'extract' }>;

function buildEntry(trackId: string, fileName: string, media: CachedMedia): CachedWaveformEntry {
  let artworkBytes: ArrayBuffer | null = null;
  if (media.artwork) {
    artworkBytes = new ArrayBuffer(media.artwork.data.length);
    new Uint8Array(artworkBytes).set(media.artwork.data);
  }
  return {
    trackId, fileName,
    peaksFrame: media.peaks ? JSON.stringify({ type: 'waveform_data', trackId, fileName, peaks: media.peaks, peaksPerSec: WAVEFORM_PEAKS_PER_SEC }) : null,
    artworkFrame: media.artwork === undefined ? null : JSON.stringify({
      type: 'artwork_data', trackId, fileName, data: media.artwork?.data.toString('base64') ?? null, mime: media.artwork?.mime ?? null,
    }),
    artworkBytes, artworkMime: media.artwork?.mime ?? null,
  };
}

async function extract(message: Extract<JobMessage, { type: 'extract' }>, media: CachedMedia, signal: AbortSignal): Promise<CachedMedia> {
  if ((message.artworkOnly || media.peaks) && media.artwork !== undefined) return media;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slwv-'));
  send({ type: 'temporary', directory: tempDir, active: true });
  const extension = path.extname(message.fileName).slice(1).toLowerCase();
  // A fixed local name avoids carrying an untrusted or very long filename into the filesystem.
  const inputPath = path.join(tempDir, 'input');
  try {
    const audio = new Uint8Array(message.audioBuf, message.audioByteOffset, message.audioByteLength);
    await fs.writeFile(inputPath, audio, { signal });
    signal.throwIfAborted();
    const peaksPromise = message.artworkOnly || media.peaks ? Promise.resolve(media.peaks)
      : extractPeaks(inputPath, message.totalSec, signal, progress => send({ type: 'progress', jobId: message.jobId, stage: 'generating', progress }));
    const artworkPromise = media.artwork !== undefined ? Promise.resolve(media.artwork) : extractArtwork(inputPath, audio, extension, signal);
    const [peaks, artwork] = await Promise.allSettled([peaksPromise, artworkPromise]);
    signal.throwIfAborted();
    if (peaks.status === 'rejected') throw peaks.reason;
    if (artwork.status === 'rejected' && message.artworkOnly) throw artwork.reason;
    if (artwork.status === 'rejected') warn(`[WAVEFORM] Artwork extraction failed; it remains retryable: ${artwork.reason instanceof Error ? artwork.reason.message : String(artwork.reason)}`);
    const result: CachedMedia = { peaks: peaks.value, artwork: artwork.status === 'fulfilled' ? artwork.value : media.artwork };
    try { await cache!.write(message.trackId, result, signal); }
    catch (error) {
      signal.throwIfAborted();
      warn(`[WAVEFORM] Could not persist media cache: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    send({ type: 'temporary', directory: tempDir, active: false });
  }
}

async function run(message: JobMessage, controller: AbortController): Promise<void> {
  const timeout = setTimeout(() => controller.abort(new Error('Media extraction deadline exceeded')), MEDIA_JOB_TIMEOUT_MS);
  try {
    let media = await cache!.read(message.trackId);
    controller.signal.throwIfAborted();
    if (message.type === 'extract') media = await extract(message, media, controller.signal);
    controller.signal.throwIfAborted();
    const entry = buildEntry(message.trackId, message.fileName, media);
    controller.signal.throwIfAborted();
    send({ type: 'result', jobId: message.jobId, ...entry }, entry.artworkBytes ? [entry.artworkBytes] : []);
  } catch (error) {
    send({ type: 'error', jobId: message.jobId, aborted: controller.signal.aborted && controller.signal.reason?.name === 'AbortError', msg: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timeout);
    jobs.delete(message.jobId);
  }
}

port.on('message', (message: MainToWaveformWorker) => {
  if (message.type === 'init') {
    cache = new MediaDiskCache(message.cacheDir, warn);
    void cache.init().then(() => send({ type: 'ready' }), error => send({ type: 'initError', msg: error instanceof Error ? error.message : String(error) }));
  } else if (message.type === 'load' || message.type === 'extract') {
    if (!cache || closing || jobs.size >= MEDIA_EXTRACTION_CONCURRENCY) {
      send({ type: 'error', jobId: message.jobId, aborted: false, msg: 'media worker is not accepting additional work' });
      return;
    }
    const controller = new AbortController();
    const done = run(message, controller);
    jobs.set(message.jobId, { controller, done });
  } else if (message.type === 'cancel') {
    jobs.get(message.jobId)?.controller.abort(new DOMException('Media extraction cancelled', 'AbortError'));
  } else if (message.type === 'shutdown') {
    closing = true;
    for (const job of jobs.values()) job.controller.abort(new DOMException('Media worker is shutting down', 'AbortError'));
    void Promise.allSettled(Array.from(jobs.values(), job => job.done)).then(() => port.close());
  }
});
