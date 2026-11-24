import { spawn } from 'node:child_process';
import { createBufferReader, extractMetadata } from 'metadata-connect';
import { validateArtwork, type Artwork } from './mediaDiskCache.js';
import {
  MEDIA_CHILD_KILL_GRACE_MS, MEDIA_MAX_ARTWORK_BYTES, MEDIA_MAX_PEAKS,
  MEDIA_PROCESS_STDERR_BYTES, MEDIA_MAX_PROBE_BYTES,
  WAVEFORM_FFMPEG_SAMPLE_RATE, WAVEFORM_SAMPLES_PER_PEAK,
} from './constants.js';

let processObserver: ((pid: number, active: boolean) => void) | undefined;
export function setMediaProcessObserver(observer: (pid: number, active: boolean) => void): void {
  processObserver = observer;
}

export function runMediaProcess(
  command: string, args: string[], signal: AbortSignal, onData: (chunk: Buffer) => void,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (proc.pid) processObserver?.(proc.pid, true);
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let stderr = Buffer.alloc(0);
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => proc.kill('SIGKILL'), MEDIA_CHILD_KILL_GRACE_MS);
    };
    const abort = () => stop(signal.reason instanceof Error ? signal.reason : new DOMException('Media extraction cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    proc.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      try { onData(chunk); } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      const remaining = MEDIA_PROCESS_STDERR_BYTES - stderr.length;
      if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
    });
    proc.on('error', error => { failure ??= new Error(`${command} spawn failed: ${error.message}`); });
    proc.once('close', code => {
      if (proc.pid) processObserver?.(proc.pid, false);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}: ${stderr.toString('utf8').trim()}`));
      else resolve();
    });
  });
}

async function collectProcess(command: string, args: string[], signal: AbortSignal, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  await runMediaProcess(command, args, signal, chunk => {
    size += chunk.length;
    if (size > limit) throw new Error(`${command} output exceeds size limit`);
    chunks.push(chunk);
  });
  return Buffer.concat(chunks, size);
}

export async function extractArtwork(
  inputPath: string, audio: Uint8Array, extension: string, signal: AbortSignal,
  readMetadata: typeof extractMetadata = extractMetadata,
): Promise<Artwork | null> {
  signal.throwIfAborted();
  const bytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  let metadata: Awaited<ReturnType<typeof extractMetadata>> = null;
  try {
    metadata = await readMetadata(createBufferReader(bytes, extension));
  } catch {
    // A parser failure does not establish absence; the independent container probe may still succeed.
    signal.throwIfAborted();
  }
  signal.throwIfAborted();
  if (metadata?.artwork) return validateArtwork(metadata.artwork);

  const raw = await collectProcess('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=index,codec_type:stream_disposition=attached_pic',
    '-of', 'json', inputPath,
  ], signal, MEDIA_MAX_PROBE_BYTES);
  const probe: unknown = JSON.parse(raw.toString('utf8'));
  if (!probe || typeof probe !== 'object' || !('streams' in probe) || !Array.isArray(probe.streams)) {
    throw new Error('ffprobe returned invalid stream metadata');
  }
  const validStream = (stream: unknown): stream is { index: number; codec_type: string; disposition?: { attached_pic?: number } } =>
    !!stream && typeof stream === 'object' && 'index' in stream && Number.isInteger(stream.index)
    && (stream.index as number) >= 0 && 'codec_type' in stream && typeof stream.codec_type === 'string';
  if (!probe.streams.every(validStream)) throw new Error('ffprobe returned invalid stream metadata');
  const streams = probe.streams.filter(validStream);
  if (!streams.some(stream => stream.codec_type === 'audio')) throw new Error('media does not contain a readable audio stream');
  const video = streams.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic === 1)
    ?? streams.find(stream => stream.codec_type === 'video');
  if (!video) {
    if (streams.some(stream => stream.codec_type === 'attachment')) throw new Error('artwork attachments are not supported by the fallback extractor');
    return null;
  }
  const image = await collectProcess('ffmpeg', [
    '-nostdin', '-v', 'error', '-i', inputPath, '-map', `0:${video.index}`,
    '-frames:v', '1', '-an', '-c:v', 'copy', '-f', 'image2pipe', 'pipe:1',
  ], signal, MEDIA_MAX_ARTWORK_BYTES);
  return validateArtwork(image);
}

export async function extractPeaks(
  inputPath: string, totalSec: number, signal: AbortSignal, onProgress: (percent: number) => void,
): Promise<number[]> {
  const peaks: number[] = [];
  let lowByte: number | null = null;
  let sampleCount = 0;
  let peak = 0;
  let lastProgress = -1;
  const appendPeak = () => {
    if (peaks.length >= MEDIA_MAX_PEAKS) throw new Error('waveform exceeds maximum supported duration');
    peaks.push(Math.min(1, peak / 32767));
    sampleCount = 0;
    peak = 0;
  };
  const addSample = (unsigned: number) => {
    const sample = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
    peak = Math.max(peak, Math.abs(sample));
    if (++sampleCount === WAVEFORM_SAMPLES_PER_PEAK) appendPeak();
  };
  const expectedBytes = totalSec > 0 ? Math.ceil(totalSec * WAVEFORM_FFMPEG_SAMPLE_RATE * 2) : 0;
  let receivedBytes = 0;
  await runMediaProcess('ffmpeg', [
    '-nostdin', '-v', 'error', '-i', inputPath, '-map', '0:a:0',
    '-ac', '1', '-ar', String(WAVEFORM_FFMPEG_SAMPLE_RATE), '-f', 's16le', 'pipe:1',
  ], signal, chunk => {
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
      const progress = Math.min(99, Math.round(receivedBytes / expectedBytes * 100));
      if (progress !== lastProgress) { lastProgress = progress; onProgress(progress); }
    }
  });
  if (lowByte !== null) throw new Error('ffmpeg returned truncated PCM');
  if (sampleCount) appendPeak();
  if (peaks.length === 0) throw new Error('media contains no decoded audio samples');
  onProgress(100);
  return peaks;
}
