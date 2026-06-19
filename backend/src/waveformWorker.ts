import { parentPort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  WAVEFORM_FFMPEG_SAMPLE_RATE,
  WAVEFORM_SAMPLES_PER_PEAK,
  WAVEFORM_PEAKS_PER_SEC,
} from './constants.js';
import type {
  CachedWaveformEntry,
  MainToWaveformWorker,
  WaveformWorkerToMain,
} from './waveformWorkerMessages.js';

if (!parentPort) {
  throw new Error('waveformWorker must be spawned as a worker_thread');
}

const port = parentPort;

function send(msg: WaveformWorkerToMain, transfer?: Transferable[]) {
  // Node's worker_threads typing for transferList accepts ArrayBuffer; the cast
  // is to allow a single signature to cover both transfer and non-transfer sends.
  if (transfer && transfer.length > 0) port.postMessage(msg, transfer as any);
  else port.postMessage(msg);
}

function logInfo(msg: string)  { send({ type: 'log', level: 'info',  msg }); }
function logWarn(msg: string)  { send({ type: 'log', level: 'warn',  msg }); }
function logError(msg: string) { send({ type: 'log', level: 'error', msg }); }

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([m, e]) => [e, m]),
);

function waveformStem(fileName: string): string {
  return crypto.createHash('md5').update(fileName).digest('hex').slice(0, 16);
}

function artworkStem(fileName: string): string {
  return Buffer.from(fileName).toString('hex');
}

function buildPeaksFrame(fileName: string, peaks: number[]): string {
  return JSON.stringify({
    type: 'waveform_data',
    fileName,
    peaks,
    peaksPerSec: WAVEFORM_PEAKS_PER_SEC,
  });
}

function buildArtworkFrame(fileName: string, entry: { data: Buffer; mime: string } | null): string {
  return JSON.stringify({
    type: 'artwork_data',
    fileName,
    data: entry ? entry.data.toString('base64') : null,
    mime: entry ? entry.mime : null,
  });
}

class WaveformWorker {
  private waveformCacheDir = '';
  private artworkCacheDir = '';
  // Dedup concurrent same-fileName extraction jobs (the main thread can re-enter
  // onTrackChanged for the same file before the previous job finishes).
  private inFlight = new Map<string, Promise<void>>();

  async init(cacheDir: string): Promise<void> {
    this.waveformCacheDir = path.join(cacheDir, 'waveform-cache');
    this.artworkCacheDir = path.join(cacheDir, 'artwork-cache');
    await fs.mkdir(this.waveformCacheDir, { recursive: true });
    await fs.mkdir(this.artworkCacheDir, { recursive: true });

    // Pre-build WS frames at boot so the main thread never pays JSON.stringify
    // / base64 cost for cached entries.
    const peaksByFile = new Map<string, number[]>();
    const artworkByFile = new Map<string, { data: Buffer; mime: string } | null>();

    let peaksLoadedCount = 0;
    let artworksLoadedCount = 0;

    try {
      const files = await fs.readdir(this.waveformCacheDir);
      await Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map(async (f) => {
            try {
              const raw = await fs.readFile(path.join(this.waveformCacheDir, f), 'utf8');
              const { key, peaks } = JSON.parse(raw) as { key: string; peaks: number[] };
              if (Array.isArray(peaks)) {
                peaksByFile.set(key, peaks);
                peaksLoadedCount++;
              }
            } catch {
              // ignore corrupt cache file
            }
          }),
      );
    } catch {
      // empty dir or first run
    }

    try {
      const files = await fs.readdir(this.artworkCacheDir);
      await Promise.all(
        files.map(async (f) => {
          const filePath = path.join(this.artworkCacheDir, f);
          const ext = path.extname(f);
          const key = Buffer.from(path.basename(f, ext), 'hex').toString('utf8');
          if (ext === '.none') {
            artworkByFile.set(key, null);
            artworksLoadedCount++;
            return;
          }
          const mime = EXT_TO_MIME[ext];
          if (!mime) return;
          try {
            const data = await fs.readFile(filePath);
            artworkByFile.set(key, { data, mime });
            artworksLoadedCount++;
          } catch {
            // ignore unreadable artwork file
          }
        }),
      );
    } catch {
      // empty dir or first run
    }

    // Union of keys — emit one CachedWaveformEntry per file. A file may have
    // peaks but no artwork (or vice versa) depending on disk state.
    const allFiles = new Set<string>([...peaksByFile.keys(), ...artworkByFile.keys()]);
    const entries: CachedWaveformEntry[] = [];
    const transfers: Transferable[] = [];
    for (const fileName of allFiles) {
      const peaks = peaksByFile.get(fileName);
      const peaksFrame = peaks ? buildPeaksFrame(fileName, peaks) : null;
      const hasArtworkEntry = artworkByFile.has(fileName);
      const art = hasArtworkEntry ? artworkByFile.get(fileName)! : null;
      const artworkFrame = buildArtworkFrame(fileName, art);
      // Copy bytes into a fresh ArrayBuffer so we can transfer ownership without
      // touching the original Buffer.from-readFile allocation.
      let artworkBytes: ArrayBuffer | null = null;
      let artworkMime: string | null = null;
      if (art) {
        const ab = new ArrayBuffer(art.data.byteLength);
        new Uint8Array(ab).set(art.data);
        artworkBytes = ab;
        artworkMime = art.mime;
        transfers.push(ab);
      }
      entries.push({ fileName, peaksFrame, artworkFrame, artworkBytes, artworkMime });
    }

    logInfo(`[WAVEFORM] Loaded ${peaksLoadedCount} cached waveforms from disk`);
    logInfo(`[WAVEFORM] Loaded ${artworksLoadedCount} cached artworks from disk`);

    send(
      { type: 'cacheLoaded', entries, peaksLoadedCount, artworksLoadedCount },
      transfers,
    );
  }

  async runJob(
    jobId: number,
    fileName: string,
    totalSec: number,
    audio: Uint8Array,
    artworkOnly: boolean,
  ): Promise<void> {
    // Same-file dedup: a second extract for the same fileName waits on the first
    // and then immediately returns — the original job will have populated the
    // disk caches and replied to the main thread.
    const existing = this.inFlight.get(fileName);
    if (existing) {
      try { await existing; } catch {}
      // Disk caches are now populated by the prior job. Re-emit a result for
      // this jobId by reading from disk (cheap; the main thread will not have
      // dispatched a broadcast yet because it was waiting on this jobId).
      try {
        const peaks = artworkOnly ? null : await this.readPeaksFromDisk(fileName);
        const art = await this.readArtworkFromDisk(fileName);
        const peaksFrame = peaks ? buildPeaksFrame(fileName, peaks) : null;
        const artworkFrame = buildArtworkFrame(fileName, art);
        const { artworkBytes, artworkMime } = artToTransfer(art);
        send(
          {
            type: 'result',
            jobId,
            fileName,
            peaksFrame,
            artworkFrame,
            artworkBytes,
            artworkMime,
            peaksLen: peaks?.length ?? 0,
          },
          artworkBytes ? [artworkBytes] : undefined,
        );
      } catch (e: any) {
        send({ type: 'error', jobId, fileName, msg: e?.message || String(e) });
      }
      return;
    }

    const promise = (async () => {
      const hash = crypto.createHash('md5')
        .update(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength))
        .digest('hex')
        .slice(0, 8);
      const ext = path.extname(fileName) || '.audio';
      const tempPath = path.join(os.tmpdir(), `slwv-${hash}${ext}`);

      try {
        await fs.writeFile(tempPath, Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));

        // Run peaks extraction (skipped on artwork-only) and artwork extraction in
        // parallel — same intent as the original Promise.all in waveformService.ts.
        const peaksPromise: Promise<number[] | null> = artworkOnly
          ? Promise.resolve(null)
          : extractPeaksViaFfmpeg(tempPath, totalSec, (pct) => {
              send({ type: 'progress', jobId, stage: 'generating', progress: pct });
            });
        const artworkPromise = extractArtwork(tempPath);

        const [peaks, art] = await Promise.all([peaksPromise, artworkPromise]);

        // Persist to disk caches before replying so a crash mid-result still
        // leaves the cache populated for next boot.
        if (peaks) await this.writeWaveformFile(fileName, peaks);
        await this.writeArtworkFile(fileName, art);

        const peaksFrame = peaks ? buildPeaksFrame(fileName, peaks) : null;
        const artworkFrame = buildArtworkFrame(fileName, art);
        const { artworkBytes, artworkMime } = artToTransfer(art);

        send(
          {
            type: 'result',
            jobId,
            fileName,
            peaksFrame,
            artworkFrame,
            artworkBytes,
            artworkMime,
            peaksLen: peaks?.length ?? 0,
          },
          artworkBytes ? [artworkBytes] : undefined,
        );
      } finally {
        await fs.unlink(tempPath).catch(() => {});
      }
    })();

    this.inFlight.set(fileName, promise);
    try {
      await promise;
    } catch (e: any) {
      send({ type: 'error', jobId, fileName, msg: e?.message || String(e) });
    } finally {
      this.inFlight.delete(fileName);
    }
  }

  private async writeWaveformFile(fileName: string, peaks: number[]): Promise<void> {
    if (!this.waveformCacheDir) return;
    try {
      await fs.writeFile(
        path.join(this.waveformCacheDir, `${waveformStem(fileName)}.json`),
        JSON.stringify({ key: fileName, peaks }),
      );
    } catch (e: any) {
      logError(`[WAVEFORM] Failed to write waveform file: ${e?.message || e}`);
    }
  }

  private async writeArtworkFile(
    fileName: string,
    entry: { data: Buffer; mime: string } | null,
  ): Promise<void> {
    if (!this.artworkCacheDir) return;
    const stem = artworkStem(fileName);
    try {
      if (entry === null) {
        await fs.writeFile(path.join(this.artworkCacheDir, `${stem}.none`), '');
      } else {
        const ext = MIME_TO_EXT[entry.mime] ?? '.jpg';
        await fs.writeFile(path.join(this.artworkCacheDir, `${stem}${ext}`), entry.data);
      }
    } catch (e: any) {
      logError(`[WAVEFORM] Failed to write artwork file: ${e?.message || e}`);
    }
  }

  private async readPeaksFromDisk(fileName: string): Promise<number[] | null> {
    if (!this.waveformCacheDir) return null;
    try {
      const raw = await fs.readFile(
        path.join(this.waveformCacheDir, `${waveformStem(fileName)}.json`),
        'utf8',
      );
      const { peaks } = JSON.parse(raw) as { key: string; peaks: number[] };
      return Array.isArray(peaks) ? peaks : null;
    } catch {
      return null;
    }
  }

  private async readArtworkFromDisk(
    fileName: string,
  ): Promise<{ data: Buffer; mime: string } | null> {
    if (!this.artworkCacheDir) return null;
    const stem = artworkStem(fileName);
    for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
      try {
        const data = await fs.readFile(path.join(this.artworkCacheDir, `${stem}${ext}`));
        return { data, mime };
      } catch {
        // try next ext
      }
    }
    try {
      await fs.access(path.join(this.artworkCacheDir, `${stem}.none`));
      return null;
    } catch {
      return null;
    }
  }
}

function artToTransfer(art: { data: Buffer; mime: string } | null): {
  artworkBytes: ArrayBuffer | null;
  artworkMime: string | null;
} {
  if (!art) return { artworkBytes: null, artworkMime: null };
  // Copy into a fresh ArrayBuffer so postMessage can transfer ownership
  // without disturbing the worker's cached Buffer (if any).
  const ab = new ArrayBuffer(art.data.byteLength);
  new Uint8Array(ab).set(art.data);
  return { artworkBytes: ab, artworkMime: art.mime };
}

function extractArtwork(inputPath: string): Promise<{ data: Buffer; mime: string } | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-i', inputPath,
      '-an',
      '-vcodec', 'copy',
      '-f', 'image2pipe',
      '-v', 'quiet',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const data = Buffer.concat(chunks);
      if (data.length < 4) {
        resolve(null);
        return;
      }
      let mime = 'image/jpeg';
      if (data[0] === 0x89 && data[1] === 0x50) mime = 'image/png';
      else if (data[0] === 0x47 && data[1] === 0x49) mime = 'image/gif';
      else if (data[0] === 0x57 && data[1] === 0x45) mime = 'image/webp';
      resolve({ data, mime });
    });
  });
}

function extractPeaksViaFfmpeg(
  inputPath: string,
  totalSec: number,
  onProgress: (pct: number) => void,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', inputPath,
      '-ac', '1',
      '-ar', String(WAVEFORM_FFMPEG_SAMPLE_RATE),
      '-f', 's16le',
      '-v', 'quiet',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    const expectedBytes = totalSec > 0
      ? Math.ceil(totalSec * WAVEFORM_FFMPEG_SAMPLE_RATE * 2)
      : 0;
    let receivedBytes = 0;

    proc.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      receivedBytes += chunk.length;
      if (expectedBytes > 0) {
        onProgress(Math.min(99, Math.round((receivedBytes / expectedBytes) * 100)));
      }
    });

    proc.stderr.on('data', () => {});

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
        return;
      }
      onProgress(100);
      const pcm = Buffer.concat(chunks);
      resolve(computePeaks(pcm));
    });
  });
}

function computePeaks(pcm: Buffer): number[] {
  const peaks: number[] = [];
  const step = WAVEFORM_SAMPLES_PER_PEAK * 2;

  for (let i = 0; i + 1 < pcm.length; i += step) {
    let max = 0;
    for (let j = i; j < i + step && j + 1 < pcm.length; j += 2) {
      const sample = Math.abs(pcm.readInt16LE(j));
      if (sample > max) max = sample;
    }
    peaks.push(max / 32767);
  }

  return peaks;
}

const worker = new WaveformWorker();
let initialized = false;

port.on('message', (raw: MainToWaveformWorker) => {
  switch (raw.type) {
    case 'init':
      worker
        .init(raw.cacheDir)
        .then(() => {
          initialized = true;
          send({ type: 'ready' });
        })
        .catch((e) => {
          logError(`[WAVEFORM] init failed: ${e?.message || e}`);
        });
      break;
    case 'extract': {
      if (!initialized) {
        send({
          type: 'error',
          jobId: raw.jobId,
          fileName: raw.fileName,
          msg: 'worker not initialized',
        });
        return;
      }
      const audio = new Uint8Array(raw.audioBuf, raw.audioByteOffset, raw.audioByteLength);
      // No await — concurrency is handled by the inFlight Map per fileName.
      void worker.runJob(raw.jobId, raw.fileName, raw.totalSec, audio, raw.artworkOnly);
      break;
    }
    case 'shutdown':
      // Allow any pending writes to flush before exit.
      setTimeout(() => process.exit(0), 50);
      break;
  }
});
