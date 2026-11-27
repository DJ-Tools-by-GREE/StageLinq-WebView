import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseVideoConfig } from '../dist/videoConfig.js';
import { emptyVideoLibrary, findVideo, scanVideoLibrary } from '../dist/videoLibrary.js';
import { parseConfig, validateConfig } from '../dist/jsonFile.js';
import {
  VIDEO_LIBRARY_MAX_DEPTH, VIDEO_LIBRARY_MAX_ISSUES, VIDEO_MAX_NDI_PREFIX_BYTES, VIDEO_MAX_OFFSET_ENTRIES,
  VIDEO_MAPPINGS_MAX_BYTES, VIDEO_MAPPINGS_MAX_ENTRIES,
} from '../dist/constants.js';

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'slwv-video-library-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    async file(name, content = 'video fixture') {
      const destination = path.join(directory, name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
      return destination;
    },
  };
}

const config = (directory, extra = {}) => parseVideoConfig({ enabled: true, directory, ...extra });

test('optional video configuration defaults to disabled and preserves explicit input offsets', () => {
  const defaults = { enabled: false, multi_ndi_stream: false, directory: '', ndi_name_prefix: 'StageLinq', output_format: 'source', latency_comp_ms: 0, offsets_sec: {} };
  assert.deepEqual(parseVideoConfig(undefined), defaults);
  assert.deepEqual(parseVideoConfig({}), defaults);
  assert.deepEqual(parseConfig('{}'), {});
  const raw = { enabled: true, directory: '/Volumes/Show Videos', output_format: '1080p30', latency_comp_ms: -25, offsets_sec: { 'Song.mp3': 2.5, 'Song.wav': -1.25 } };
  const parsed = parseVideoConfig(raw);
  assert.deepEqual(parsed.offsets_sec, { 'Song.mp3': 2.5, 'Song.wav': -1.25 });
  assert.equal(parsed.latency_comp_ms, -25);
  parsed.offsets_sec['Song.mp3'] = 20;
  assert.equal(raw.offsets_sec['Song.mp3'], 2.5);
  assert.deepEqual(parseConfig(JSON.stringify({ video: raw })).video, raw);
});

test('video validation rejects invalid values at both direct and root-config boundaries', () => {
  const invalid = [null, false, [], 'video', 1,
    { enabled: 'true' }, { enabled: null }, { enabled: true }, { enabled: true, directory: '   ' },
    { multi_ndi_stream: 'false' }, { multi_ndi_stream: null },
    { directory: 3 }, { directory: 'bad\0path' }, { output_format: 'auto' }, { output_format: null },
    { latency_comp_ms: NaN }, { latency_comp_ms: Infinity }, { latency_comp_ms: null }, { latency_comp_ms: '25' },
    { offsets_sec: null }, { offsets_sec: [] }, { offsets_sec: { 'Song.mp3': '2' } },
    { offsets_sec: { 'Song.mp3': Infinity } }, { offsets_sec: { Song: 0 } },
    { offsets_sec: { 'folder/Song.mp3': 0 } }, { offsets_sec: { 'folder\\Song.mp3': 0 } },
    { offsets_sec: { 'Song.': 0 } }, { ndi_name_prefix: '' }, { ndi_name_prefix: 'A/B' },
    { ndi_name_prefix: 'A:B' }, { ndi_name_prefix: 'A\nB' },
  ];
  for (const value of invalid) {
    assert.throws(() => parseVideoConfig(value), /video/, `accepted ${JSON.stringify(value)}`);
    assert.throws(() => validateConfig({ video: value }), /video/);
  }
  assert.throws(() => parseVideoConfig({ ndi_name_prefix: 'é'.repeat(Math.floor(VIDEO_MAX_NDI_PREFIX_BYTES / 2) + 1) }), /UTF-8 bytes/);
  assert.equal(parseVideoConfig({ ndi_name_prefix: 'a'.repeat(VIDEO_MAX_NDI_PREFIX_BYTES) }).ndi_name_prefix.length, VIDEO_MAX_NDI_PREFIX_BYTES);
  const tooMany = Object.fromEntries(Array.from({ length: VIDEO_MAX_OFFSET_ENTRIES + 1 }, (_, i) => [`${i}.mp3`, 0]));
  assert.throws(() => parseVideoConfig({ offsets_sec: tooMany }), /exceeds/);
});

test('recursive matching removes only the audio extension and keeps stems case-sensitive', async t => {
  const { directory, file } = await fixture(t);
  await file('videos/Artist - Song (Music Video).mp4');
  await file('videos/.hidden/subfolder/Artist - Song (Remix) (Music Video).MOV');
  await file('videos/subfolder/Track.v2 (Music Video).m4v');
  await file('videos/subfolder/曲🎵 (Music Video).mp4');
  await file('videos/subfolder/song (Music Video).mp4');
  await file('videos/Artist - Song.mp4');
  await file('videos/No match (music video).mp4');
  await file('videos/Unsupported (Music Video).mkv');
  await file('videos/readme.txt');
  const library = await scanVideoLibrary(config('videos'), directory);
  assert.equal(library.directory, await fs.realpath(path.join(directory, 'videos')));
  assert.equal(library.files.length, 7);
  assert.deepEqual(library.files.map(v => v.relativePath), [...library.files.map(v => v.relativePath)].sort());
  assert.equal(findVideo(library, 'Artist - Song.mp3').kind, 'matched');
  assert.equal(findVideo(library, 'net://device/USB/Music/Track.v2.flac').file.stem, 'Track.v2');
  assert.equal(findVideo(library, '曲🎵.wav').kind, 'matched');
  assert.equal(findVideo(library, 'Artist - Song (Remix).mp3').file.fileName, 'Artist - Song (Remix) (Music Video).MOV');
  assert.equal(findVideo(library, 'song.mp3').kind, 'matched');
  assert.equal(findVideo(library, 'Song.mp3').kind, 'missing');
  assert.equal(findVideo(library, 'Unsupported.mp3').kind, 'missing');
  assert.equal(findVideo(library, 'No match (music video).mp3').kind, 'missing');
  assert.equal(findVideo(library, '').kind, 'missing');
  assert.deepEqual(library.issues.map(issue => issue.code), ['unsupported']);
  assert.equal(library.issueCount, 1);
});

test('same-stem video files in different folders or formats stay explicitly ambiguous', async t => {
  const { directory, file } = await fixture(t);
  await file('z/Song (Music Video).mp4');
  await file('a/Song (Music Video).mov');
  await file('a/Song (Music Video).m4v');
  const library = await scanVideoLibrary(config(directory), directory);
  assert.equal(library.byStem.has('Song'), false);
  const result = findVideo(library, 'Song.mp3');
  assert.equal(result.kind, 'ambiguous');
  assert.deepEqual(result.files.map(f => f.relativePath), [path.join('a', 'Song (Music Video).m4v'), path.join('a', 'Song (Music Video).mov'), path.join('z', 'Song (Music Video).mp4')]);
  assert.equal(library.issues[0].code, 'ambiguous');
  assert.equal(library.issues[0].paths.length, 3);
});

test('symbolic links are not traversed, including cycles and files outside the configured root', async t => {
  const { directory, file } = await fixture(t);
  await file('videos/Inside (Music Video).mp4');
  await file('outside/Outside (Music Video).mp4');
  await fs.symlink('../outside', path.join(directory, 'videos', 'linked-folder'));
  await fs.symlink('.', path.join(directory, 'videos', 'cycle'));
  await fs.symlink('../outside/Outside (Music Video).mp4', path.join(directory, 'videos', 'Outside (Music Video).mp4'));
  const library = await scanVideoLibrary(config('videos'), directory);
  assert.deepEqual(library.files.map(f => f.stem), ['Inside']);
  assert.equal(library.issueCount, 3);
  assert.ok(library.issues.every(issue => issue.code === 'symlink'));
  await fs.symlink('videos', path.join(directory, 'explicit-root-link'));
  const linked = await scanVideoLibrary(config('explicit-root-link'), directory);
  assert.equal(linked.directory, library.directory);
  assert.equal(linked.files.length, 1);
});

test('missing and invalid directories fail visibly; disabled output needs no readable folder', async t => {
  const { directory, file } = await fixture(t);
  await file('not-a-directory');
  await assert.rejects(scanVideoLibrary(config('missing'), directory), /Cannot scan video directory.*ENOENT/);
  await assert.rejects(scanVideoLibrary(config('not-a-directory'), directory), /not a directory/);
  const disabled = await scanVideoLibrary(parseVideoConfig({ directory: '/does/not/exist' }), directory);
  assert.equal(disabled.directory, null);
  assert.equal(disabled.scannedEntries, 0);
  assert.equal(findVideo(emptyVideoLibrary(), 'Song.mp3').kind, 'missing');
});

test('rescan reports replacement files without changing an earlier catalog snapshot', async t => {
  const { directory, file } = await fixture(t);
  await file('Song (Music Video).mp4', 'first');
  const first = await scanVideoLibrary(config(directory), directory);
  await file('Song (Music Video).mp4', 'replacement with a different length');
  const second = await scanVideoLibrary(config(directory), directory);
  assert.notEqual(findVideo(first, 'Song.mp3').file.version, findVideo(second, 'Song.mp3').file.version);
  assert.equal(findVideo(first, 'Song.mp3').file.sizeBytes, 5);
  await fs.rename(path.join(directory, 'Song (Music Video).mp4'), path.join(directory, 'Other (Music Video).mp4'));
  const third = await scanVideoLibrary(config(directory), directory);
  assert.equal(findVideo(third, 'Song.mp3').kind, 'missing');
  assert.equal(findVideo(third, 'Other.mp3').kind, 'matched');
});

test('scan depth and retained diagnostics are bounded', async t => {
  const { directory, file } = await fixture(t);
  const deep = path.join(directory, 'deep', ...Array.from({ length: VIDEO_LIBRARY_MAX_DEPTH + 1 }, () => 'd'));
  await fs.mkdir(deep, { recursive: true });
  await assert.rejects(scanVideoLibrary(config('deep'), directory), /nested directories/);
  for (let i = VIDEO_LIBRARY_MAX_ISSUES + 2; i >= 0; i--) await file(`issues/${String(i).padStart(4, '0')} (Music Video).mkv`);
  const library = await scanVideoLibrary(config('issues'), directory);
  assert.equal(library.issueCount, VIDEO_LIBRARY_MAX_ISSUES + 3);
  assert.equal(library.issues.length, VIDEO_LIBRARY_MAX_ISSUES);
  assert.equal(library.issues[0].paths[0], '0000 (Music Video).mkv');
  assert.equal(library.issues.at(-1).paths[0], `${String(VIDEO_LIBRARY_MAX_ISSUES - 1).padStart(4, '0')} (Music Video).mkv`);
});

test('scan cancellation rejects before returning a partial catalog', async t => {
  const { directory, file } = await fixture(t);
  await file('Song (Music Video).mp4');
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(scanVideoLibrary(config(directory), directory, stopped.signal), { name: 'AbortError' });
  const controller = new AbortController();
  const scanning = scanVideoLibrary(config(directory), directory, controller.signal);
  controller.abort();
  await assert.rejects(scanning, { name: 'AbortError' });
});

test('explicit mappings select arbitrary video paths by exact audio basename and extension', async t => {
  const { directory, file } = await fixture(t);
  const chosen = await file('videos/nested/曲🎵 Live.MP4');
  const alternate = await file('videos/other edit.mov');
  await file('videos/Fallback (Music Video).mp4');
  await file('videos/Song (Music Video).mp4');
  await file('videos/Song (Music Video).mov');
  await file('videos/nested/mappings.json', 'ignored: only the root mapping file is used');
  await file('videos/mappings.json', '\uFEFF' + JSON.stringify({
    'Song.mp3': 'nested/曲🎵 Live.MP4',
    'Song.wav': 'other edit.mov',
    'Only.flac': 'nested/曲🎵 Live.MP4',
    'Fallback.mp3': 'other edit.mov',
    '__proto__.mp3': 'other edit.mov',
  }));
  const library = await scanVideoLibrary(config('videos'), directory);
  assert.equal(library.files.length, 5);
  assert.equal(findVideo(library, 'net://device/USB/Song.mp3').file.path, chosen);
  assert.equal(findVideo(library, 'Song.wav').file.path, alternate);
  assert.equal(findVideo(library, 'Song.flac').kind, 'ambiguous');
  assert.equal(findVideo(library, 'Only.flac').file, findVideo(library, 'Song.mp3').file);
  assert.equal(findVideo(library, 'Only.FLAC').kind, 'missing');
  assert.equal(findVideo(library, 'only.flac').kind, 'missing');
  assert.equal(findVideo(library, 'Fallback.mp3').file.path, alternate);
  assert.equal(findVideo(library, 'Fallback.flac').file.stem, 'Fallback');
  assert.equal(findVideo(library, '__proto__.mp3').file.path, alternate);
});

test('malformed mappings and duplicate audio keys fail with an actionable mapping error', async t => {
  const { directory, file } = await fixture(t);
  await file('clip.mp4');
  const invalid = ['', '{', 'null', '[]', 'true', '"mapping"',
    '{"Song.mp3":"clip.mp4",}',
    '{/* comment */ "Song.mp3":"clip.mp4"}',
    '{"Song.mp3":"clip.mp4","Song.mp3":"clip.mp4"}',
    '{"Song.mp3":"clip.mp4","Song\\u002emp3":"clip.mp4"}',
    ...[null, false, 2, [], {}].map(value => JSON.stringify({ 'Song.mp3': value })),
  ];
  for (const content of invalid) {
    await file('mappings.json', content);
    await assert.rejects(scanVideoLibrary(config(directory), directory), /mappings\.json/, `accepted ${content}`);
  }
  await file('mappings.json', '{"Song.mp3":"clip.mp4","Song.mp3":"clip.mp4"}');
  await assert.rejects(scanVideoLibrary(config(directory), directory), /Duplicate audio filename/);
  await file('mappings.json', '{}');
  const empty = await scanVideoLibrary(config(directory), directory);
  assert.equal(empty.byAudioFile.size, 0);
});

test('mapping keys and target paths cannot escape their basename and video-folder contracts', async t => {
  const { directory, file } = await fixture(t);
  await file('clip.mp4');
  const keys = ['', 'Song', 'Song.', '.mp3', ' Song.mp3', 'Song.mp3 ',
    'folder/Song.mp3', 'folder\\Song.mp3', 'C:Song.mp3', 'Song\0.mp3'];
  for (const key of keys) {
    await file('mappings.json', JSON.stringify({ [key]: 'clip.mp4' }));
    await assert.rejects(scanVideoLibrary(config(directory), directory), /keys must be audio basenames/);
  }
  const targets = ['', ' ', '../clip.mp4', '/clip.mp4', 'nested/../../clip.mp4', './clip.mp4',
    'nested/../clip.mp4', 'nested//clip.mp4', 'nested/clip.mp4/', 'C:/clip.mp4', 'C:clip.mp4',
    '\\\\server\\share\\clip.mp4', 'nested\\clip.mp4', 'net://host/clip.mp4', 'clip\0.mp4'];
  for (const target of targets) {
    await file('mappings.json', JSON.stringify({ 'Song.mp3': target }));
    await assert.rejects(scanVideoLibrary(config(directory), directory), /relative video path inside the video folder/);
  }
});

test('mapping targets must exist in the catalog with exact case and supported containers', async t => {
  const { directory, file } = await fixture(t);
  await file('clip.mp4');
  await file('Unsupported.mkv');
  await file('Song (Music Video).mp4');
  for (const missing of ['missing.mp4', 'Clip.mp4', 'nested/clip.mp4']) {
    await file('mappings.json', JSON.stringify({ 'Song.mp3': missing }));
    await assert.rejects(scanVideoLibrary(config(directory), directory), /mappings\.json.*video was not found/);
  }
  await file('mappings.json', JSON.stringify({ 'Song.mp3': 'Unsupported.mkv' }));
  await assert.rejects(scanVideoLibrary(config(directory), directory), /mappings\.json.*unsupported video container/);
});

test('mappings cannot select files through a linked directory', async t => {
  const { directory, file } = await fixture(t);
  await file('outside/clip.mp4');
  await file('videos/mappings.json', JSON.stringify({ 'Song.mp3': 'linked-folder/clip.mp4' }));
  await fs.symlink(path.join(directory, 'outside'), path.join(directory, 'videos', 'linked-folder'), 'junction');
  await assert.rejects(scanVideoLibrary(config('videos'), directory), /video was not found/);
});

test('mappings cannot select symlinked files or load a symlinked mapping file', async t => {
  const { directory, file } = await fixture(t);
  await file('outside/clip.mp4');
  await file('videos/inside.mp4');
  await fs.symlink('../outside/clip.mp4', path.join(directory, 'videos', 'linked.mp4'));
  await file('videos/mappings.json', JSON.stringify({ 'Song.mp3': 'linked.mp4' }));
  await assert.rejects(scanVideoLibrary(config('videos'), directory), /video was not found/);
  await fs.unlink(path.join(directory, 'videos', 'mappings.json'));
  await file('outside/mappings.json', JSON.stringify({ 'Song.mp3': 'inside.mp4' }));
  await fs.symlink('../outside/mappings.json', path.join(directory, 'videos', 'mappings.json'));
  await assert.rejects(scanVideoLibrary(config('videos'), directory), /mappings\.json must be a regular file/);
});

test('mapping file size and entry count are bounded', async t => {
  const { directory, file } = await fixture(t);
  await file('clip.mp4');
  await file('mappings.json', Buffer.alloc(VIDEO_MAPPINGS_MAX_BYTES + 1, ' '));
  await assert.rejects(scanVideoLibrary(config(directory), directory), /mappings\.json exceeds .* bytes/);
  const entries = Object.fromEntries(Array.from({ length: VIDEO_MAPPINGS_MAX_ENTRIES + 1 }, (_, i) => [`${i}.mp3`, 'clip.mp4']));
  await file('mappings.json', JSON.stringify(entries));
  await assert.rejects(scanVideoLibrary(config(directory), directory), /mappings\.json exceeds .* entries/);
});

test('mapping rescans are independent snapshots and removing the file restores automatic matching', async t => {
  const { directory, file } = await fixture(t);
  await file('Song (Music Video).mp4');
  const alternate = await file('alternate.mp4');
  const first = await scanVideoLibrary(config(directory), directory);
  await file('mappings.json', JSON.stringify({ 'Song.mp3': 'alternate.mp4' }));
  const second = await scanVideoLibrary(config(directory), directory);
  assert.equal(findVideo(first, 'Song.mp3').file.stem, 'Song');
  assert.equal(findVideo(second, 'Song.mp3').file.path, alternate);
  await fs.unlink(path.join(directory, 'mappings.json'));
  const third = await scanVideoLibrary(config(directory), directory);
  assert.equal(findVideo(third, 'Song.mp3').file.stem, 'Song');
  assert.equal(findVideo(second, 'Song.mp3').file.path, alternate);
});
