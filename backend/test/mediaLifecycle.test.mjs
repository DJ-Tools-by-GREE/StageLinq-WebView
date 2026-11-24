import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  initWaveformCache, requestExtraction, loadCachedMedia, shutdownWaveformWorker,
  setActiveMediaTracks, peaksFrameCache, artworkFrameCache, artworkCache,
} from '../dist/waveformService.js';
import { MediaDiskCache } from '../dist/mediaDiskCache.js';
import { runMediaProcess, extractArtwork } from '../dist/mediaExtraction.js';
import { MEDIA_MAX_AUDIO_BYTES, MEDIA_MAX_QUEUED_AUDIO_BYTES, MEDIA_MAX_PENDING_JOBS } from '../dist/constants.js';
import { applyLoggingConfig } from '../dist/logging.js';

applyLoggingConfig({ lifecycle: false, errors: false });

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slwv-media-lifecycle-'));
  const bin = path.join(dir, 'bin');
  const marker = path.join(dir, 'running.json');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'ffprobe'), `#!${process.execPath}
const fs = require('node:fs');
const input = process.argv.at(-1);
const data = fs.readFileSync(input);
if (data.toString() === 'BLOCK') {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,input}));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (data.toString() === 'INVALID') {
  process.stderr.write('Invalid fixture container');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({streams:[{index:0,codec_type:'audio'}]}));
}
`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'ffmpeg'), `#!${process.execPath}
process.stdout.write(Buffer.from([0, 0, 255, 127]));
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(async () => {
    await shutdownWaveformWorker();
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  });
  await initWaveformCache(dir);
  return { dir, marker };
}

async function waitForFile(file) {
  for (let i = 0; i < 200; i++) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10);
  }
  throw new Error('fixture process did not start');
}
const bytes = value => Uint8Array.from(Buffer.from(value));
const extract = (id, value, signal, onlyArtwork = true) => requestExtraction(id, 'same.bin', 1, bytes(value), onlyArtwork, undefined, signal);

test('startup is lazy; a requested path loads only its own verified media', async t => {
  const { dir } = await fixture(t);
  const disk = new MediaDiskCache(dir);
  await disk.write('net://a/same.bin', { peaks: [0.2] });
  await disk.write('net://b/same.bin', { peaks: [0.8], artwork: null });
  await shutdownWaveformWorker();
  await initWaveformCache(dir);
  assert.equal(peaksFrameCache.size, 0);
  const first = await loadCachedMedia('net://a/same.bin', 'same.bin');
  assert.equal(first.artworkFrame, null);
  assert.equal(artworkCache.has('net://a/same.bin'), false);
  assert.deepEqual(JSON.parse(first.peaksFrame).peaks, [0.2]);
  assert.equal(peaksFrameCache.size, 1);
  const second = await loadCachedMedia('net://b/same.bin', 'same.bin');
  assert.equal(JSON.parse(second.peaksFrame).trackId, 'net://b/same.bin');
  assert.deepEqual(JSON.parse(second.peaksFrame).peaks, [0.8]);
  assert.equal(JSON.parse(second.artworkFrame).data, null);
});

test('failed artwork-only extraction never persists false absence, while validated no-cover does', async t => {
  const { dir } = await fixture(t);
  const id = 'net://a/failure.bin';
  await assert.rejects(extract(id, 'INVALID'), /Invalid fixture container/);
  assert.equal(artworkFrameCache.has(id), false);
  assert.equal(artworkCache.has(id), false);
  assert.deepEqual(await new MediaDiskCache(dir).read(id), {});
  const result = await extract(id, 'VALID');
  assert.equal(JSON.parse(result.artworkFrame).data, null);
  assert.equal((await new MediaDiskCache(dir).read(id)).artwork, null);
});

test('usable peaks survive an artwork failure without inventing a negative artwork cache', async t => {
  const { dir } = await fixture(t);
  const id = 'net://a/partial.bin';
  const result = await extract(id, 'INVALID', undefined, false);
  assert.deepEqual(JSON.parse(result.peaksFrame).peaks, [1]);
  assert.equal(result.artworkFrame, null);
  assert.equal(artworkCache.has(id), false);
  assert.deepEqual(await new MediaDiskCache(dir).read(id), { peaks: [1] });
});

test('rejected or unsupported metadata parsers fall back to a validated container probe, while abort stays cancelled', async t => {
  const { dir } = await fixture(t);
  const input = path.join(dir, 'input');
  await fs.writeFile(input, 'VALID');
  for (const parser of [async () => { throw new Error('parser failure'); }, async () => null]) {
    assert.equal(await extractArtwork(input, bytes('VALID'), 'mp3', new AbortController().signal, parser), null);
  }
  const controller = new AbortController();
  await assert.rejects(extractArtwork(input, bytes('VALID'), 'mp3', controller.signal, async () => {
    controller.abort();
    throw new Error('parser stopped');
  }), { name: 'AbortError' });
  await assert.rejects(extractArtwork(input, bytes('VALID'), 'mp3', new AbortController().signal, async () => ({ artwork: Buffer.from('corrupt') })), /unsupported or corrupt artwork/);
});

test('cancelling a running job kills resistant children, removes its temporary input, and releases the next slot', { timeout: 5000 }, async t => {
  const { marker } = await fixture(t);
  const controller = new AbortController();
  const blocked = extract('net://a/block.bin', 'BLOCK', controller.signal);
  const rejected = assert.rejects(blocked, { name: 'AbortError' });
  const running = await waitForFile(marker);
  controller.abort();
  await rejected;
  const next = await extract('net://a/next.bin', 'VALID');
  assert.equal(JSON.parse(next.artworkFrame).data, null);
  await assert.rejects(fs.stat(path.dirname(running.input)), { code: 'ENOENT' });
  assert.throws(() => process.kill(running.pid, 0), { code: 'ESRCH' });
});

test('one cancelled deduplicated caller does not cancel the remaining consumer', { timeout: 5000 }, async t => {
  const { marker } = await fixture(t);
  const first = new AbortController();
  const second = new AbortController();
  const id = 'net://a/shared.bin';
  const a = assert.rejects(extract(id, 'BLOCK', first.signal), { name: 'AbortError' });
  const b = assert.rejects(extract(id, 'BLOCK', second.signal), { name: 'AbortError' });
  const running = await waitForFile(marker);
  first.abort();
  await a;
  await delay(50);
  assert.doesNotThrow(() => process.kill(running.pid, 0));
  second.abort();
  await b;
  await extract('net://a/after.bin', 'VALID');
  assert.throws(() => process.kill(running.pid, 0), { code: 'ESRCH' });
});

test('pending callers and queued audio have explicit admission limits without detaching rejected input', { timeout: 5000 }, async t => {
  const { marker } = await fixture(t);
  const controllers = Array.from({ length: MEDIA_MAX_PENDING_JOBS }, () => new AbortController());
  const running = extract('net://a/block.bin', 'BLOCK', controllers[0].signal);
  const failures = [assert.rejects(running, { name: 'AbortError' })];
  await waitForFile(marker);
  const tooBig = new Uint8Array(MEDIA_MAX_AUDIO_BYTES + 1);
  await assert.rejects(requestExtraction('net://a/large.bin', 'large.bin', 1, tooBig, true), /input size limit/);
  assert.equal(tooBig.byteLength, MEDIA_MAX_AUDIO_BYTES + 1);
  const queued = new Uint8Array(MEDIA_MAX_QUEUED_AUDIO_BYTES - 5);
  const queuedController = new AbortController();
  const queuedFailure = assert.rejects(requestExtraction('net://a/queued.bin', 'queued.bin', 1, queued, true, undefined, queuedController.signal), { name: 'AbortError' });
  await assert.rejects(extract('net://a/overflow.bin', 'VALID'), /audio byte limit/);
  queuedController.abort();
  await queuedFailure;
  assert.equal(queued.byteLength, MEDIA_MAX_QUEUED_AUDIO_BYTES - 5);
  for (let i = 1; i < controllers.length; i++) failures.push(assert.rejects(extract('net://a/block.bin', 'BLOCK', controllers[i].signal), { name: 'AbortError' }));
  await assert.rejects(extract('net://a/excess.bin', 'VALID'), /queue is full/);
  controllers.forEach(controller => controller.abort());
  await Promise.all(failures);
  await extract('net://a/after.bin', 'VALID');
});

test('active track changes cancel obsolete running and queued work', { timeout: 5000 }, async t => {
  const { marker } = await fixture(t);
  const blocked = assert.rejects(extract('net://a/old.bin', 'BLOCK'), { name: 'AbortError' });
  await waitForFile(marker);
  const queued = assert.rejects(extract('net://a/queued.bin', 'VALID'), { name: 'AbortError' });
  setActiveMediaTracks(['net://a/new.bin']);
  await Promise.all([blocked, queued]);
  await extract('net://a/new.bin', 'VALID');
  assert.equal(artworkFrameCache.has('net://a/old.bin'), false);
  assert.equal(artworkFrameCache.has('net://a/queued.bin'), false);
});

test('shutdown cancels and drains child processes and temporary files, then supports clean restart', { timeout: 5000 }, async t => {
  const { dir, marker } = await fixture(t);
  await extract('net://a/warm.bin', 'VALID');
  const blocked = assert.rejects(extract('net://a/block.bin', 'BLOCK'), { name: 'AbortError' });
  const running = await waitForFile(marker);
  const shutdown = shutdownWaveformWorker();
  await assert.rejects(loadCachedMedia('net://a/warm.bin', 'same.bin'), /shutting down/);
  await shutdown;
  await blocked;
  assert.throws(() => process.kill(running.pid, 0), { code: 'ESRCH' });
  await assert.rejects(fs.stat(path.dirname(running.input)), { code: 'ENOENT' });
  await initWaveformCache(dir);
  await extract('net://a/restarted.bin', 'VALID');
});

test('media subprocess deadlines settle only after the child has exited', { timeout: 3000 }, async () => {
  let pid = null;
  const controller = new AbortController();
  const completion = runMediaProcess(process.execPath, ['-e', "process.stdout.write(String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], controller.signal, chunk => {
    pid = Number(chunk.toString());
    controller.abort(new Error('fixture deadline exceeded'));
  });
  await assert.rejects(completion, /fixture deadline exceeded/);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
