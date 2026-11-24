import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { MediaDiskCache } from '../dist/mediaDiskCache.js';
import { MediaMemoryCache } from '../dist/mediaMemoryCache.js';
import { WAVEFORM_PEAKS_PER_SEC, MEDIA_MAX_MANIFEST_BYTES } from '../dist/constants.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=', 'base64');
const artwork = { data: png, mime: 'image/png' };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slwv-media-cache-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const warnings = [];
  const cache = new MediaDiskCache(dir, message => warnings.push(message));
  await cache.init();
  return { dir, cache, warnings };
}

test('full path identity separates same-basename media, including very long Unicode paths', async t => {
  const { cache } = await fixture(t);
  const first = 'net://deviceA/library/same.mp3';
  const second = 'net://deviceB/library/same.mp3';
  const long = 'net://deviceA/' + '目录🎵'.repeat(150) + '/same.mp3';
  await cache.write(first, { peaks: [0.1], artwork: null });
  await cache.write(second, { peaks: [0.9], artwork });
  await cache.write(long, { peaks: [0.3] });
  assert.deepEqual(await cache.read(first), { peaks: [0.1], artwork: null });
  assert.deepEqual(await cache.read(second), { peaks: [0.9], artwork });
  assert.deepEqual(await cache.read(long), { peaks: [0.3] });
  assert.equal(path.basename(cache.filePath(long)).length, 69);
  assert.equal((await fs.readdir(cache.directory)).length, 3);
});

test('one atomic manifest replaces artwork presence and absence without sibling sentinels', async t => {
  const { cache } = await fixture(t);
  const id = 'net://device/library/a.mp3';
  await cache.write(id, { peaks: [0.2], artwork: null });
  await cache.write(id, { peaks: [0.2], artwork });
  assert.deepEqual((await cache.read(id)).artwork, artwork);
  await cache.write(id, { peaks: [0.2], artwork: null });
  assert.equal((await cache.read(id)).artwork, null);
  assert.equal((await fs.readdir(cache.directory)).length, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cache.write(id, { artwork }, controller.signal), { name: 'AbortError' });
  assert.equal((await cache.read(id)).artwork, null);
});

test('waveform-only records keep unknown artwork distinct from confirmed absence', async t => {
  const { cache } = await fixture(t);
  const id = 'net://device/library/a.mp3';
  await cache.write(id, { peaks: [0.5] });
  assert.deepEqual(await cache.read(id), { peaks: [0.5] });
});

test('corrupt manifests fail closed at identity, schema, sampling, and peak boundaries', async t => {
  const { cache, warnings } = await fixture(t);
  const id = 'net://device/library/a.mp3';
  const valid = { version: 1, trackId: id, peaksPerSec: WAVEFORM_PEAKS_PER_SEC, peaks: [0.5] };
  const invalid = [
    { ...valid, version: 0 }, { ...valid, trackId: 'net://other/library/a.mp3' },
    { ...valid, peaksPerSec: WAVEFORM_PEAKS_PER_SEC + 1 },
    ...[[], [null], [-0.1], [1.1], ['0.5'], [Infinity]].map(peaks => ({ ...valid, peaks })),
    { ...valid, artwork: { status: 'unknown' } },
  ];
  for (const record of invalid) {
    await fs.writeFile(cache.filePath(id), JSON.stringify(record));
    assert.deepEqual(await cache.read(id), {});
  }
  await fs.writeFile(cache.filePath(id), '{');
  assert.deepEqual(await cache.read(id), {});
  const handle = await fs.open(cache.filePath(id), 'w');
  await handle.truncate(MEDIA_MAX_MANIFEST_BYTES + 1);
  await handle.close();
  assert.deepEqual(await cache.read(id), {});
  assert.equal(warnings.length, invalid.length + 2);
});

test('artwork manifests verify content digest, canonical encoding, and detected MIME', async t => {
  const { cache } = await fixture(t);
  const id = 'net://device/library/a.mp3';
  await cache.write(id, { artwork });
  const valid = JSON.parse(await fs.readFile(cache.filePath(id), 'utf8'));
  for (const changes of [{ sha256: '0'.repeat(64) }, { mime: 'image/jpeg' }, { base64: valid.artwork.base64 + '\n' }]) {
    await fs.writeFile(cache.filePath(id), JSON.stringify({ ...valid, artwork: { ...valid.artwork, ...changes } }));
    assert.deepEqual(await cache.read(id), {});
  }
});

const entry = (trackId, n = 10) => ({
  trackId, fileName: 'same.mp3', peaksFrame: 'p'.repeat(n), artworkFrame: 'a'.repeat(n),
  artworkBytes: new ArrayBuffer(n), artworkMime: 'image/png',
});

test('memory LRU evicts waveform, artwork frame, and raw artwork together and protects active tracks', () => {
  const cache = new MediaMemoryCache(2000, 2);
  cache.put(entry('a'));
  cache.put(entry('b'));
  cache.setActive(['a']);
  cache.put(entry('c'));
  assert.deepEqual([...cache.peaksFrames.keys()], ['a', 'c']);
  assert.equal(cache.artworkFrames.has('b'), false);
  assert.equal(cache.artwork.has('b'), false);
  cache.setActive([]);
  cache.get('a');
  cache.put(entry('d'));
  assert.equal(cache.peaksFrames.has('a'), true);
  assert.equal(cache.peaksFrames.has('c'), false);
});

test('memory accounting includes UTF-16 strings and raw bytes, enforcing a hard bound even for active entries', () => {
  const cache = new MediaMemoryCache(110, 8);
  cache.setActive(['a', 'b', 'c']);
  cache.put(entry('a'));
  cache.put(entry('b'));
  assert.equal(cache.sizeBytes, 104);
  cache.put(entry('c'));
  assert.equal(cache.sizeBytes, 104);
  assert.equal(cache.get('a'), undefined);
  cache.put(entry('huge', 1000));
  assert.ok(cache.sizeBytes <= 110);
  assert.equal(cache.get('huge'), undefined);
});
