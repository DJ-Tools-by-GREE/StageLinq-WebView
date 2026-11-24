import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { markAsUntransferable } from 'node:worker_threads';
import test from 'node:test';
import { initWaveformCache, requestExtraction, shutdownWaveformWorker, loadCachedMedia, setActiveMediaTracks, peaksFrameCache, artworkFrameCache, artworkCache } from '../dist/waveformService.js';
import { applyLoggingConfig } from '../dist/logging.js';

applyLoggingConfig({ lifecycle: false, errors: false });

async function cacheDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slwv-waveform-test-'));
  t.after(async () => {
    await shutdownWaveformWorker();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('legacy basename caches are ignored rather than trusted as track identity', async t => {
  const dir = await cacheDir(t);
  await fs.mkdir(path.join(dir, 'waveform-cache'));
  await fs.writeFile(path.join(dir, 'waveform-cache', 'fixture.json'), JSON.stringify({ key: 'peaks-only.mp3', peaks: [0.1] }));
  await initWaveformCache(dir);
  assert.deepEqual(await loadCachedMedia('net://device/a/peaks-only.mp3', 'peaks-only.mp3'), { peaksFrame: null, artworkFrame: null });
  assert.equal(peaksFrameCache.size, 0);
  assert.equal(artworkFrameCache.has('peaks-only.mp3'), false);
  assert.equal(artworkCache.has('peaks-only.mp3'), false);
});

test('worker initialization failure rejects and permits a later retry', { timeout: 3000 }, async t => {
  const dir = await cacheDir(t);
  await fs.writeFile(path.join(dir, 'not-a-directory'), 'x');
  await assert.rejects(initWaveformCache(path.join(dir, 'not-a-directory')), /ENOTDIR/);
  await initWaveformCache(dir);
});

test('untransferable audio rejects rather than leaking an unresolved job', { timeout: 3000 }, async t => {
  const dir = await cacheDir(t);
  await initWaveformCache(dir);
  const bytes = new Uint8Array(4);
  markAsUntransferable(bytes.buffer);
  await assert.rejects(requestExtraction('net://device/a/untransferable.mp3', 'untransferable.mp3', 1, bytes, false));
});

test('all callers observe a deduplicated extraction failure', { timeout: 3000 }, async t => {
  const dir = await cacheDir(t);
  const previousPath = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => { process.env.PATH = previousPath; });
  await initWaveformCache(dir);
  const results = await Promise.allSettled([1, 2].map(() => requestExtraction('net://device/a/invalid.mp3', 'invalid.mp3', 1, new Uint8Array(3), false)));
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
});

test('Chris Le metadata parser extracts embedded artwork without ffmpeg', { timeout: 3000 }, async t => {
  const dir = await cacheDir(t);
  const previousPath = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => { process.env.PATH = previousPath; });
  await initWaveformCache(dir);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=', 'base64');
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from('image/png'), Buffer.from([0, 3, 0]), png]);
  const frame = Buffer.alloc(10);
  frame.write('APIC');
  frame.writeUInt32BE(payload.length, 4);
  const tag = Buffer.alloc(10);
  tag.write('ID3');
  tag[3] = 3;
  const length = frame.length + payload.length;
  for (let i = 0; i < 4; i++) tag[6 + i] = (length >> (7 * (3 - i))) & 0x7f;
  const result = await requestExtraction('net://device/a/embedded.mp3', 'embedded.mp3', 0, Uint8Array.from(Buffer.concat([tag, frame, payload])), true);
  assert.equal(result.peaksFrame, null);
  const artwork = JSON.parse(result.artworkFrame);
  assert.equal(artwork.mime, 'image/png');
  assert.deepEqual(Buffer.from(artwork.data, 'base64'), png);
});

test('streamed PCM reduction retains partial final peaks and clamps full scale', { timeout: 5000 }, async t => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) { t.skip('ffmpeg not installed'); return; }
  const dir = await cacheDir(t);
  await initWaveformCache(dir);
  const pcm = Buffer.alloc(81 * 2);
  pcm.writeInt16LE(-32768, 0);
  pcm.writeInt16LE(16384, 80);
  pcm.writeInt16LE(-1, 160);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const result = await requestExtraction('net://device/a/pcm.wav', 'pcm.wav', 81 / 8000, Uint8Array.from(Buffer.concat([header, pcm])), false);
  const waveform = JSON.parse(result.peaksFrame);
  assert.equal(waveform.peaksPerSec, 200);
  assert.deepEqual(waveform.peaks, [1, 16384 / 32767, 1 / 32767]);
});
