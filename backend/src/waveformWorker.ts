import { parentPort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createBufferReader, extractMetadata } from 'metadata-connect';
import { fileTypeFromBuffer } from 'file-type';
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
  private inFlight = new Map<string, Promise<{ peaks: number[] | null; art: { data: Buffer; mime: string } | null }>>();

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
      const artworkFrame = hasArtworkEntry ? buildArtworkFrame(fileName, art) : null;
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

  async runJob(jobId: number, fileName: string, totalSec: number, audio: Uint8Array, artworkOnly: boolean): Promise<void> {
    let promise = this.inFlight.get(fileName);
    if (!promise) {
      promise = this.extract(fileName, totalSec, audio, artworkOnly, jobId);
      this.inFlight.set(fileName, promise);
    }
    try {
      const result = await promise;
      if (!artworkOnly && result.peaks === null) {
        if (this.inFlight.get(fileName) === promise) this.inFlight.delete(fileName);
        await this.runJob(jobId, fileName, totalSec, audio, false);
        return;
      }
      const peaks = artworkOnly ? null : result.peaks;
      const { artworkBytes, artworkMime } = artToTransfer(result.art);
      send({
        type: 'result', jobId, fileName,
        peaksFrame: peaks ? buildPeaksFrame(fileName, peaks) : null,
        artworkFrame: buildArtworkFrame(fileName, result.art),
        artworkBytes, artworkMime, peaksLen: peaks?.length ?? 0,
      }, artworkBytes ? [artworkBytes] : undefined);
    } catch (e: any) {
      send({ type: 'error', jobId, fileName, msg: e?.message || String(e) });
    } finally {
      if (this.inFlight.get(fileName) === promise) this.inFlight.delete(fileName);
    }
  }

  private async extract(fileName: string, totalSec: number, audio: Uint8Array, artworkOnly: boolean, jobId: number) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slwv-'));
    const tempPath = path.join(tempDir, 'input' + (path.extname(fileName) || '.audio'));
    try {
      await fs.writeFile(tempPath, audio);
      const peaksPromise = artworkOnly ? Promise.resolve(null) : extractPeaksViaFfmpeg(tempPath, totalSec, (progress) => {
        send({ type: 'progress', jobId, stage: 'generating', progress });
      });
      const artworkPromise = extractArtwork(tempPath, audio, path.extname(fileName).slice(1));
      const [peaksResult, artResult] = await Promise.allSettled([peaksPromise, artworkPromise]);
      if (peaksResult.status === 'rejected') throw peaksResult.reason;
      if (artResult.status === 'rejected') throw artResult.reason;
      const peaks = peaksResult.value;
      const art = artResult.value;
      if (peaks) await this.writeWaveformFile(fileName, peaks);
      await this.writeArtworkFile(fileName, art);
      return { peaks, art };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
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

async function extractArtwork(inputPath: string, audio: Uint8Array, extension: string): Promise<{ data: Buffer; mime: string } | null> {
  const bytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  const metadata = await extractMetadata(createBufferReader(bytes, extension));
  if (metadata?.artwork && metadata.artworkMimeType) {
    return { data: metadata.artwork, mime: metadata.artworkMimeType };
  }
  // Preserve support for containers and tags the metadata parser does not cover.
  return new Promise((resolve, reject) => {
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
    proc.on('error', reject);
    proc.on('close', async () => {
      const data = Buffer.concat(chunks);
      if (data.length < 4) {
        resolve(null);
        return;
      }
      try {
        const type = await fileTypeFromBuffer(data);
        resolve(type && MIME_TO_EXT[type.mime] ? { data, mime: type.mime } : null);
      } catch (error) {
        reject(error);
      }
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

    const peaks: number[] = [];
    let lowByte: number | null = null;
    let sampleCount = 0;
    let peak = 0;
    let lastProgress = -1;
    const addSample = (unsigned: number) => {
      const sample = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
      peak = Math.max(peak, Math.abs(sample));
      if (++sampleCount === WAVEFORM_SAMPLES_PER_PEAK) {
        peaks.push(Math.min(1, peak / 32767));
        sampleCount = 0;
        peak = 0;
      }
    };
    const expectedBytes = totalSec > 0
      ? Math.ceil(totalSec * WAVEFORM_FFMPEG_SAMPLE_RATE * 2)
      : 0;
    let receivedBytes = 0;

    proc.stdout.on('data', (chunk: Buffer) => {
      let offset = 0;
      if (lowByte !== null && chunk.length) {
        addSample(lowByte | (chunk[0] << 8));
        offset = 1;
        lowByte = null;
      }
      for (; offset + 1 < chunk.length; offset += 2) addSample(chunk.readUInt16LE(offset));
      if (offset < chunk.length) lowByte = chunk[offset];
      receivedBytes += chunk.length;
      if (expectedBytes > 0) {
        const progress = Math.min(99, Math.round((receivedBytes / expectedBytes) * 100));
        if (progress !== lastProgress) { lastProgress = progress; onProgress(progress); }
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
      if (sampleCount) peaks.push(Math.min(1, peak / 32767));
      resolve(peaks);
    });
  });
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
          send({ type: 'initError', msg: e?.message || String(e) });
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
