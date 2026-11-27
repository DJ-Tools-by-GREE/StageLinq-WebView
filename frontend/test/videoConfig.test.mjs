import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSource } from './loadSource.mjs';

test('older configs gain disabled video defaults without sharing mutable offset maps', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ config: { current_playlist: -1 }, sourcePath: 'config.json' }),
  }));
  const { loadConfig, serializeConfig } = loadSource('configEditor/restApi.ts');
  const first = (await loadConfig()).config;
  first.video.offsets_sec['Song.mp3'] = 2;
  const second = (await loadConfig()).config;
  assert.deepEqual(second.video, {
    enabled: false, multi_ndi_stream: false, directory: '', ndi_name_prefix: 'StageLinq',
    output_format: 'source', latency_comp_ms: 0, offsets_sec: {},
  });
  assert.deepEqual(JSON.parse(serializeConfig(second)).video, second.video);
});

test('editing other settings preserves configured NDI output and exact audio offset keys', async t => {
  const video = {
    enabled: true, multi_ndi_stream: true, directory: '/Volumes/Show Videos/2026', ndi_name_prefix: 'Main Stage',
    output_format: 'source', latency_comp_ms: 125,
    offsets_sec: { 'Artist - Song.mp3': 2.125, 'Artist - Song.wav': -1.5, 'Ö - Remix (v2).aiff': 0, '__proto__.mp3': 3 },
  };
  let saved;
  t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
    if (options.method === 'PUT') { saved = JSON.parse(options.body); return { ok: true }; }
    return { ok: true, json: async () => ({ config: { video }, sourcePath: 'config.json' }) };
  });
  const { loadConfig, saveConfig } = loadSource('configEditor/restApi.ts');
  const { config } = await loadConfig();
  config.waveform.all_tracks = false;
  await saveConfig(config);
  assert.deepEqual(saved.video, video);
  assert.equal(saved.waveform.all_tracks, false);
  assert.notEqual(config.video.offsets_sec, video.offsets_sec);
  config.video.output_format = '1080p30';
  config.video.latency_comp_ms = -50;
  await saveConfig(config);
  assert.deepEqual(saved.video, { ...video, output_format: '1080p30', latency_comp_ms: -50 });
});

test('partial video configs retain specified values and fill the remaining fields', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ config: { video: { directory: './videos', output_format: '1080p30' } }, sourcePath: 'config.json' }),
  }));
  const { loadConfig, serializeConfig } = loadSource('configEditor/restApi.ts');
  const saved = JSON.parse(serializeConfig((await loadConfig()).config));
  assert.deepEqual(saved.video, {
    enabled: false, multi_ndi_stream: false, directory: './videos', ndi_name_prefix: 'StageLinq',
    output_format: '1080p30', latency_comp_ms: 0, offsets_sec: {},
  });
});
