import type { Worker } from 'node:worker_threads';
import { createModuleWorker } from './moduleWorker.js';
import fs from 'node:fs/promises';
import { logError, logLifecycle, logWarn } from './logging.js';
import { MediaMemoryCache } from './mediaMemoryCache.js';
import {
  MEDIA_CACHE_MAX_BYTES, MEDIA_CACHE_MAX_ENTRIES, MEDIA_MAX_AUDIO_BYTES,
  MEDIA_MAX_QUEUED_AUDIO_BYTES, MEDIA_MAX_PENDING_JOBS, MEDIA_EXTRACTION_CONCURRENCY,
  MEDIA_JOB_TIMEOUT_MS, MEDIA_CANCEL_TIMEOUT_MS, MEDIA_SHUTDOWN_TIMEOUT_MS,
} from './constants.js';
import type { MediaFrames, MainToWaveformWorker, WaveformWorkerToMain } from './waveformWorkerMessages.js';

const memory = new MediaMemoryCache(MEDIA_CACHE_MAX_BYTES, MEDIA_CACHE_MAX_ENTRIES);
export const peaksFrameCache = memory.peaksFrames;
export const artworkFrameCache = memory.artworkFrames;
export const artworkCache = memory.artwork;

type Progress = (stage: 'downloading' | 'generating', progress: number) => void;
interface Waiter {
  resolve: (result: MediaFrames) => void;
  reject: (error: Error) => void;
  onProgress?: Progress;
  signal?: AbortSignal;
  abort?: () => void;
}
interface Job {
  id: number; trackId: string; fileName: string; kind: 'load' | 'extract';
  artworkOnly: boolean; totalSec: number; audio?: Uint8Array; bytes: number;
  running: boolean; cancelling: boolean; waiters: Set<Waiter>;
  deadline?: ReturnType<typeof setTimeout>;
  cancelTimeout?: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let starting: Promise<void> | null = null;
let stopping: Promise<void> | null = null;
let cacheRoot: string | null = null;
let ready = false;
let accepting = true;
let nextJobId = 1;
let queuedBytes = 0;
let waiterCount = 0;
const jobs = new Map<number, Job>();
const resources = new WeakMap<Worker, { children: Set<number>; directories: Set<string>; cleanup?: Promise<void> }>();
const aborted = () => new DOMException('Media work cancelled', 'AbortError');

function killChildren(current: Worker): void {
  const owned = resources.get(current);
  for (const pid of owned?.children ?? []) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') logError('[WAVEFORM] Could not stop media child:', error);
    }
  }
  owned?.children.clear();
}

function cleanupWorker(current: Worker): Promise<void> {
  killChildren(current);
  const owned = resources.get(current);
  if (!owned) return Promise.resolve();
  owned.cleanup ??= Promise.all(Array.from(owned.directories, directory => fs.rm(directory, { recursive: true, force: true })
    .catch(error => logError('[WAVEFORM] Could not remove temporary media:', error)))).then(() => owned.directories.clear());
  return owned.cleanup;
}

export async function initWaveformCache(directory: string): Promise<void> {
  if (stopping) await stopping;
  if (starting) return starting;
  if (worker) return;
  cacheRoot = directory;
  accepting = true;
  memory.clear();
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const current = createModuleWorker(new URL(`./waveformWorker.${extension}`, import.meta.url));
  const owned = { children: new Set<number>(), directories: new Set<string>() };
  resources.set(current, owned);
  worker = current;
  ready = false;
  const initialization = new Promise<void>((resolve, reject) => {
    current.on('message', (message: WaveformWorkerToMain) => {
      if (worker !== current) return;
      if (message.type === 'child') {
        if (message.active) owned.children.add(message.pid); else owned.children.delete(message.pid);
      } else if (message.type === 'temporary') {
        if (message.active) owned.directories.add(message.directory); else owned.directories.delete(message.directory);
      } else if (message.type === 'ready') { ready = true; resolve(); pump(); }
      else if (message.type === 'initError') reject(new Error(message.msg));
      else handleWorkerMessage(message);
    });
    current.on('error', error => {
      logError('[WAVEFORM] Worker error:', error.message);
      reject(error);
    });
    current.once('exit', code => {
      void cleanupWorker(current);
      reject(new Error(`waveform worker exited during initialization (code ${code})`));
      if (worker === current) {
        worker = null;
        ready = false;
        failAll(new Error('waveform worker exited before completing media work'));
      }
    });
    try { current.postMessage({ type: 'init', cacheDir: directory } satisfies MainToWaveformWorker); }
    catch (error) { reject(error); }
  });
  starting = initialization;
  try { await initialization; }
  catch (error) { await current.terminate(); throw error; }
  finally { if (starting === initialization) starting = null; }
}

function detachWaiter(job: Job, waiter: Waiter): void {
  if (!job.waiters.delete(waiter)) return;
  waiterCount--;
  if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort);
}

function removeJob(job: Job): void {
  if (!jobs.delete(job.id)) return;
  queuedBytes -= job.bytes;
  job.audio = undefined;
  clearTimeout(job.deadline);
  clearTimeout(job.cancelTimeout);
}

function finish(job: Job, result?: MediaFrames, error?: Error): void {
  removeJob(job);
  for (const waiter of job.waiters) {
    detachWaiter(job, waiter);
    if (error) waiter.reject(error);
    else waiter.resolve(result!);
  }
  pump();
}

function failAll(error: Error): void {
  for (const job of jobs.values()) {
    removeJob(job);
    for (const waiter of job.waiters) { detachWaiter(job, waiter); waiter.reject(error); }
  }
}

function cancelJob(job: Job, error: Error): void {
  for (const waiter of job.waiters) { detachWaiter(job, waiter); waiter.reject(error); }
  if (!job.running) { removeJob(job); pump(); return; }
  if (job.cancelling) return;
  job.cancelling = true;
  try { worker?.postMessage({ type: 'cancel', jobId: job.id } satisfies MainToWaveformWorker); }
  catch { /* Worker exit settles the slot. */ }
  const current = worker;
  job.cancelTimeout = setTimeout(() => {
    if (current && worker === current && jobs.has(job.id)) {
      ready = false;
      killChildren(current);
      void current.terminate();
    }
  }, MEDIA_CANCEL_TIMEOUT_MS);
}

function handleWorkerMessage(message: WaveformWorkerToMain): void {
  if (message.type === 'log') {
    if (message.level === 'error') logError(message.msg);
    else if (message.level === 'warn') logWarn(message.msg);
    else logLifecycle(message.msg);
    return;
  }
  if (!('jobId' in message)) return;
  const job = jobs.get(message.jobId);
  if (!job) return;
  if (message.type === 'progress') {
    for (const waiter of job.waiters) {
      try { waiter.onProgress?.(message.stage, message.progress); }
      catch (error) { logError('[WAVEFORM] Progress callback failed:', error); }
    }
  } else if (message.type === 'result') {
    if (job.waiters.size) memory.put(message);
    finish(job, { peaksFrame: message.peaksFrame, artworkFrame: message.artworkFrame });
  } else if (message.type === 'error') {
    const error = new Error(message.msg);
    if (message.aborted) error.name = 'AbortError';
    finish(job, undefined, error);
  }
}

function pump(): void {
  if (!accepting || !ready || !worker) return;
  let running = Array.from(jobs.values()).filter(job => job.running).length;
  for (const job of jobs.values()) {
    if (running >= MEDIA_EXTRACTION_CONCURRENCY) break;
    if (job.running) continue;
    job.running = true;
    running++;
    job.deadline = setTimeout(() => cancelJob(job, new Error('Media job deadline exceeded')), MEDIA_JOB_TIMEOUT_MS);
    try {
      if (job.kind === 'load') {
        worker.postMessage({ type: 'load', jobId: job.id, trackId: job.trackId, fileName: job.fileName } satisfies MainToWaveformWorker);
      } else {
        const audio = job.audio!;
        worker.postMessage({
          type: 'extract', jobId: job.id, trackId: job.trackId, fileName: job.fileName, totalSec: job.totalSec,
          artworkOnly: job.artworkOnly, audioBuf: audio.buffer as ArrayBuffer, audioByteOffset: audio.byteOffset, audioByteLength: audio.byteLength,
        } satisfies MainToWaveformWorker, [audio.buffer as ArrayBuffer]);
        job.audio = undefined;
      }
    } catch (error) {
      finish(job, undefined, error instanceof Error ? error : new Error(String(error)));
      return;
    }
  }
}

function request(
  kind: 'load' | 'extract', trackId: string, fileName: string,
  totalSec: number, audio: Uint8Array | undefined, artworkOnly: boolean, onProgress?: Progress, signal?: AbortSignal,
): Promise<MediaFrames> {
  if (!accepting || stopping) return Promise.reject(new Error('waveform worker is shutting down'));
  if (!cacheRoot) return Promise.reject(new Error('waveform worker not initialized'));
  if (!trackId) return Promise.reject(new Error('media requires a full track identity'));
  if (signal?.aborted) return Promise.reject(aborted());
  if (waiterCount >= MEDIA_MAX_PENDING_JOBS) return Promise.reject(new Error('media queue is full'));
  let job = Array.from(jobs.values()).find(candidate => !candidate.cancelling && candidate.trackId === trackId
    && candidate.kind === kind && (kind === 'load' || !candidate.artworkOnly || artworkOnly));
  if (!job) {
    const bytes = audio?.buffer.byteLength ?? 0;
    if (bytes > MEDIA_MAX_AUDIO_BYTES) return Promise.reject(new Error('audio exceeds media input size limit'));
    if (queuedBytes + bytes > MEDIA_MAX_QUEUED_AUDIO_BYTES) return Promise.reject(new Error('media queue audio byte limit exceeded'));
    if (jobs.size >= MEDIA_MAX_PENDING_JOBS) return Promise.reject(new Error('media queue is full'));
    job = { id: nextJobId++, kind, trackId, fileName, totalSec, audio, artworkOnly, bytes, running: false, cancelling: false, waiters: new Set() };
    jobs.set(job.id, job);
    queuedBytes += bytes;
  }
  const selected = job;
  const result = new Promise<MediaFrames>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, onProgress, signal };
    selected.waiters.add(waiter);
    waiterCount++;
    if (signal) {
      waiter.abort = () => {
        detachWaiter(selected, waiter);
        reject(aborted());
        if (selected.waiters.size === 0) cancelJob(selected, aborted());
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
    }
  });
  if (!worker) void initWaveformCache(cacheRoot).then(pump, error => failAll(error instanceof Error ? error : new Error(String(error))));
  else pump();
  return result;
}

export function loadCachedMedia(trackId: string, fileName: string, signal?: AbortSignal): Promise<MediaFrames> {
  if (!accepting || stopping) return Promise.reject(new Error('waveform worker is shutting down'));
  if (signal?.aborted) return Promise.reject(aborted());
  const cached = memory.get(trackId);
  if (cached) return Promise.resolve(cached);
  return request('load', trackId, fileName, 0, undefined, true, undefined, signal);
}

/** The caller gives up access to audioBytes; its entire backing buffer may be transferred. */
export function requestExtraction(
  trackId: string, fileName: string, totalSec: number, audioBytes: Uint8Array, artworkOnly: boolean,
  onProgress?: Progress, signal?: AbortSignal,
): Promise<MediaFrames> {
  return request('extract', trackId, fileName, totalSec, audioBytes, artworkOnly, onProgress, signal);
}

export function setActiveMediaTracks(ids: Iterable<string>): void {
  const active = new Set(Array.from(ids).filter(Boolean));
  memory.setActive(active);
  for (const job of jobs.values()) if (!active.has(job.trackId)) cancelJob(job, aborted());
}

export async function shutdownWaveformWorker(): Promise<void> {
  if (stopping) return stopping;
  accepting = false;
  for (const job of jobs.values()) cancelJob(job, aborted());
  const current = worker;
  if (!current) { memory.clear(); return; }
  ready = false;
  const shutdown = new Promise<void>(resolve => {
    const timeout = setTimeout(() => { killChildren(current); void current.terminate(); }, MEDIA_SHUTDOWN_TIMEOUT_MS);
    current.once('exit', () => { clearTimeout(timeout); void cleanupWorker(current).then(resolve); });
    try { current.postMessage({ type: 'shutdown' } satisfies MainToWaveformWorker); }
    catch { void current.terminate(); }
  });
  stopping = shutdown;
  try { await shutdown; }
  finally { if (stopping === shutdown) stopping = null; memory.clear(); }
}
