import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { logError, logLifecycle } from './logging.js';
import { WAVEFORM_FFMPEG_SAMPLE_RATE, WAVEFORM_SAMPLES_PER_PEAK } from './constants.js';

export const peaksCache = new Map<string, number[]>();
export const artworkCache = new Map<string, { data: Buffer; mime: string } | null>();
const inFlight = new Map<string, Promise<number[]>>();

let waveformCacheDir = '';
let artworkCacheDir = '';

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


export async function initWaveformCache(cacheDir: string): Promise<void> {
  waveformCacheDir = path.join(cacheDir, 'waveform-cache');
  artworkCacheDir = path.join(cacheDir, 'artwork-cache');
  await fs.mkdir(waveformCacheDir, { recursive: true });
  await fs.mkdir(artworkCacheDir, { recursive: true });

  try {
    const files = await fs.readdir(waveformCacheDir);
    await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(f =>
          fs.readFile(path.join(waveformCacheDir, f), 'utf8')
            .then(raw => {
              const { key, peaks } = JSON.parse(raw) as { key: string; peaks: number[] };
              if (Array.isArray(peaks)) peaksCache.set(key, peaks);
            })
            .catch(() => {}),
        ),
    );
    logLifecycle(`[WAVEFORM] Loaded ${peaksCache.size} cached waveforms from disk`);
  } catch {
    // empty dir or first run
  }

  try {
    const files = await fs.readdir(artworkCacheDir);
    await Promise.all(
      files.map(f => {
        const filePath = path.join(artworkCacheDir, f);
        const ext = path.extname(f);
        const key = Buffer.from(path.basename(f, ext), 'hex').toString('utf8');
        if (ext === '.none') {
          artworkCache.set(key, null);
          return Promise.resolve();
        }
        const mime = EXT_TO_MIME[ext];
        if (!mime) return Promise.resolve();
        return fs.readFile(filePath)
          .then(data => { artworkCache.set(key, { data, mime }); })
          .catch(() => {});
      }),
    );
    logLifecycle(`[WAVEFORM] Loaded ${artworkCache.size} cached artworks from disk`);
  } catch {
    // empty dir or first run
  }
}

async function writeWaveformFile(fileName: string, peaks: number[]): Promise<void> {
  if (!waveformCacheDir) return;
  try {
    await fs.writeFile(
      path.join(waveformCacheDir, `${waveformStem(fileName)}.json`),
      JSON.stringify({ key: fileName, peaks }),
    );
  } catch (e: any) {
    logError('[WAVEFORM] Failed to write waveform file:', e?.message || e);
  }
}

async function writeArtworkFile(fileName: string, entry: { data: Buffer; mime: string } | null): Promise<void> {
  if (!artworkCacheDir) return;
  const stem = artworkStem(fileName);
  try {
    if (entry === null) {
      await fs.writeFile(path.join(artworkCacheDir, `${stem}.none`), '');
    } else {
      const ext = MIME_TO_EXT[entry.mime] ?? '.jpg';
      await fs.writeFile(path.join(artworkCacheDir, `${stem}${ext}`), entry.data);
    }
  } catch (e: any) {
    logError('[WAVEFORM] Failed to write artwork file:', e?.message || e);
  }
}

export async function generateWaveformPeaks(
  audioBytes: Uint8Array,
  fileName: string,
  totalSec: number,
  onDownloadDone: () => void,
  onGenerateProgress: (pct: number) => void,
): Promise<number[]> {
  const cached = peaksCache.get(fileName);
  if (cached) return cached;

  const existing = inFlight.get(fileName);
  if (existing) return existing;

  const hash = crypto.createHash('md5')
    .update(Buffer.from(audioBytes.buffer, audioBytes.byteOffset, audioBytes.byteLength))
    .digest('hex')
    .slice(0, 8);
  const ext = path.extname(fileName) || '.audio';
  const tempPath = path.join(os.tmpdir(), `slwv-${hash}${ext}`);

  const promise = (async () => {
    await fs.writeFile(tempPath, Buffer.from(audioBytes.buffer, audioBytes.byteOffset, audioBytes.byteLength));
    onDownloadDone();

    try {
      const [peaks] = await Promise.all([
        extractPeaksViaFfmpeg(tempPath, totalSec, onGenerateProgress),
        extractArtwork(tempPath, fileName),
      ]);
      peaksCache.set(fileName, peaks);
      void writeWaveformFile(fileName, peaks);
      void writeArtworkFile(fileName, artworkCache.get(fileName) ?? null);
      return peaks;
    } finally {
      inFlight.delete(fileName);
      await fs.unlink(tempPath).catch(() => {});
    }
  })();

  inFlight.set(fileName, promise);
  return promise;
}

async function extractArtwork(inputPath: string, fileName: string): Promise<void> {
  if (artworkCache.has(fileName)) return;

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

    proc.on('error', () => {
      artworkCache.set(fileName, null);
      resolve();
    });

    proc.on('close', () => {
      const data = Buffer.concat(chunks);
      if (data.length < 4) {
        artworkCache.set(fileName, null);
        resolve();
        return;
      }
      let mime = 'image/jpeg';
      if (data[0] === 0x89 && data[1] === 0x50) mime = 'image/png';
      else if (data[0] === 0x47 && data[1] === 0x49) mime = 'image/gif';
      else if (data[0] === 0x57 && data[1] === 0x45) mime = 'image/webp';
      artworkCache.set(fileName, { data, mime });
      logLifecycle(`[WAVEFORM] Artwork extracted for "${fileName}" (${data.length} bytes, ${mime})`);
      resolve();
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
    const expectedBytes = totalSec > 0 ? Math.ceil(totalSec * WAVEFORM_FFMPEG_SAMPLE_RATE * 2) : 0;
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
