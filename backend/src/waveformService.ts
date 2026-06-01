import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { logError, logLifecycle } from './logging.js';
import { WAVEFORM_FFMPEG_SAMPLE_RATE, WAVEFORM_SAMPLES_PER_PEAK, WAVEFORM_PEAKS_PER_SEC } from './constants.js';

export const peaksCache = new Map<string, number[]>();

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
    const peaks = await extractPeaksViaFfmpeg(tempPath, totalSec, onGenerateProgress);
    peaksCache.set(fileName, peaks);
    return peaks;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
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
    // Expected total bytes if duration is known: totalSec * sampleRate * 2 bytes/sample
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
