import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { logError, logLifecycle } from './logging.js';
import { WAVEFORM_FFMPEG_SAMPLE_RATE, WAVEFORM_SAMPLES_PER_PEAK } from './constants.js';

export const peaksCache = new Map<string, number[]>();

// artwork is stored as { data: Buffer, mime: string }
export const artworkCache = new Map<string, { data: Buffer; mime: string } | null>();

export async function generateWaveformPeaks(
  audioBytes: Uint8Array,
  fileName: string,
  totalSec: number,
  onDownloadDone: () => void,
  onGenerateProgress: (pct: number) => void,
): Promise<number[]> {
  const cached = peaksCache.get(fileName);
  if (cached) return cached;

  const hash = crypto.createHash('md5')
    .update(Buffer.from(audioBytes.buffer, audioBytes.byteOffset, audioBytes.byteLength))
    .digest('hex')
    .slice(0, 8);
  const ext = path.extname(fileName) || '.audio';
  const tempPath = path.join(os.tmpdir(), `slwv-${hash}${ext}`);

  await fs.writeFile(tempPath, Buffer.from(audioBytes.buffer, audioBytes.byteOffset, audioBytes.byteLength));
  onDownloadDone();

  try {
    const [peaks] = await Promise.all([
      extractPeaksViaFfmpeg(tempPath, totalSec, onGenerateProgress),
      extractArtwork(tempPath, fileName),
    ]);
    peaksCache.set(fileName, peaks);
    return peaks;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
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
      // Detect image format from magic bytes
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
