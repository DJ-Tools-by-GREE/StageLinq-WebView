import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseConfig, validateConfig, writeJsonFile, updateConfigFile } from '../dist/jsonFile.js';
import { GlobalSettingsStore } from '../dist/globalSettings.js';
import { UserSettingsStore } from '../dist/userSettings.js';
import { asyncRoute, sendWsFrame } from '../dist/httpUtils.js';
import { readDmxChannel, mapDmxToDeck, DECK_DMX } from '../dist/sacnControl.js';
import { WS_MAX_BUFFERED_BYTES, WS_MAX_QUEUED_BYTES, WS_MAX_QUEUED_FRAMES, WS_SEND_TIMEOUT_MS } from '../dist/constants.js';
const require = createRequire(import.meta.url);
const { Packet } = require('sacn');
const initial = { freewheel: { enable_freewheeling: true, max_duration_sec: 30 } };
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webview-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('JSONC preserves comment-like text inside string values', () => {
  const config = parseConfig('{/* comment */ "playlists": [{"name":"//keep /*me*/", "content": []}]}');
  assert.equal(config.playlists[0].name, '//keep /*me*/');
});

test('config shape rejection prevents reload-time crashes', () => {
  for (const value of [{ playlists: {} }, { playlists: [{content: [null]}] }, { current_playlist: 0.5 }, { timecode: { fps: '30' } }]) {
    assert.throws(() => validateConfig(value));
  }
});

test('freewheel update preserves commented config and unrelated settings', async t => {
  const file = path.join(await temp(t), 'config.json');
  await fs.writeFile(file, '{/*comment*/"playlists":[{"name":"//keep"}],"osc":{"enabled":true}}');
  const store = new GlobalSettingsStore(file, initial);
  await store.setFreewheel({ max_duration_sec: 90 });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.playlists[0].name, '//keep');
  assert.equal(saved.osc.enabled, true);
  assert.equal(saved.freewheel.max_duration_sec, 90);
});

test('invalid config is never overwritten and failed settings stay out of runtime cache', async t => {
  const file = path.join(await temp(t), 'config.json');
  await fs.writeFile(file, '{ broken');
  const store = new GlobalSettingsStore(file, initial);
  await assert.rejects(store.setFreewheel({ enable_freewheeling: false }));
  assert.equal(await fs.readFile(file, 'utf8'), '{ broken');
  assert.deepEqual(store.get(), initial);
  await fs.writeFile(file, '{}');
  await store.setFreewheel({ max_duration_sec: 45 });
  assert.equal(store.get().freewheel.max_duration_sec, 45);
});

test('simultaneous config writers are ordered and keep each other’s sections', async t => {
  const file = path.join(await temp(t), 'config.json');
  await Promise.all([
    writeJsonFile(file, { playlists: [{ name: 'new list' }] }),
    updateConfigFile(file, cfg => ({ ...cfg, freewheel: initial.freewheel })),
  ]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { playlists: [{ name: 'new list' }], ...initial });
});

test('concurrent partial settings edits merge in request order', async t => {
  const file = path.join(await temp(t), 'config.json');
  const store = new GlobalSettingsStore(file, initial);
  await Promise.all([store.setFreewheel({ enable_freewheeling: false }), store.setFreewheel({ max_duration_sec: 90 })]);
  assert.deepEqual(store.get().freewheel, { enable_freewheeling: false, max_duration_sec: 90 });
});

test('user settings read/write failures preserve disk and cached data', async t => {
  const dir = await temp(t);
  const file = path.join(dir, 'users.json');
  await fs.writeFile(file, '{ broken');
  const store = new UserSettingsStore(file);
  await assert.rejects(store.load());
  assert.equal(await fs.readFile(file, 'utf8'), '{ broken');
  await fs.writeFile(file, '{"users":{"Jan":{"detailZoomSec":8}}}');
  await store.load();
  await fs.rename(dir, dir + '-moved');
  t.after(() => fs.rm(dir + '-moved', { recursive: true, force: true }));
  await assert.rejects(store.setSettings('Jan', { detailZoomSec: 30 }));
  assert.deepEqual(store.get('Jan'), { detailZoomSec: 8 });
});

test('Express async route forwards persistence rejection', async () => {
  const error = new Error('disk unavailable');
  let forwarded;
  asyncRoute(async () => { throw error; })({}, {}, e => { forwarded = e; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(forwarded, error);
});

test('sACN raw channel buffer preserves off=0 and documented deck boundaries', () => {
  for (const [value, deck] of [[0,null], [50,null], [51,1], [101,1], [102,2], [152,2], [153,3], [203,3], [204,4], [255,4]]) {
    const received = new Packet(new Packet({universe:20,sequence:0,payload:{1:255,2:value},useRawDmxValues:true}).buffer);
    assert.equal(mapDmxToDeck(readDmxChannel(received, 2)), deck);
  }
  for (const [deck, value] of Object.entries(DECK_DMX)) assert.equal(mapDmxToDeck(value), Number(deck));
});

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  bufferedAmount = 0;
  frames = [];
  completions = [];
  terminated = 0;
  send(frame, callback) {
    this.frames.push(frame);
    this.bufferedAmount = Buffer.byteLength(frame);
    this.completions.push(callback);
  }
  complete(error) {
    this.bufferedAmount = 0;
    this.completions.shift()?.(error);
  }
  terminate() { this.terminated++; this.readyState = 3; this.emit('close'); }
}

test('large waveform and initial cached media drain serially without reconnecting', () => {
  const peaks = Array.from({ length: 60 * 60 * 200 }, (_, i) => (i % 32767) / 32767);
  const first = JSON.stringify({ type: 'waveform_data', fileName: 'hour-1.wav', peaks, peaksPerSec: 200 });
  const second = JSON.stringify({ type: 'waveform_data', fileName: 'hour-2.wav', peaks, peaksPerSec: 200 });
  assert.ok(Buffer.byteLength(first) > WS_MAX_BUFFERED_BYTES);
  const ws = new FakeWebSocket();
  sendWsFrame(ws, first);
  sendWsFrame(ws, second);
  sendWsFrame(ws, first);
  sendWsFrame(ws, second);
  for (let seq = 1; seq <= 100; seq++) sendWsFrame(ws, JSON.stringify({ type: 'snapshot', seq }));
  assert.equal(ws.terminated, 0);
  assert.deepEqual(ws.frames, [first]);
  ws.complete(); ws.complete(); ws.complete(); ws.complete();
  assert.deepEqual(ws.frames, [first, second, first, second, '{"type":"snapshot","seq":100}']);
  assert.equal(ws.terminated, 0);
  ws.complete();
});

test('pending frame count and byte budgets disconnect overloaded consumers', t => {
  const many = new FakeWebSocket();
  sendWsFrame(many, 'in flight');
  for (let i = 0; i <= WS_MAX_QUEUED_FRAMES; i++) sendWsFrame(many, 'terminal line');
  assert.equal(many.terminated, 1);
  many.complete();
  assert.deepEqual(many.frames, ['in flight']);

  const bytes = new FakeWebSocket();
  sendWsFrame(bytes, 'in flight');
  t.mock.method(Buffer, 'byteLength', () => Math.floor(WS_MAX_QUEUED_BYTES / 2) + 1);
  sendWsFrame(bytes, 'queued media A');
  sendWsFrame(bytes, 'queued media B');
  assert.equal(bytes.terminated, 1);
  bytes.complete();
  assert.deepEqual(bytes.frames, ['in flight']);
});

test('an idle socket with unrelated buffered data is rejected before adding more', () => {
  const ws = new FakeWebSocket();
  ws.bufferedAmount = WS_MAX_BUFFERED_BYTES;
  sendWsFrame(ws, 'new frame');
  assert.equal(ws.frames.length, 0);
  assert.equal(ws.terminated, 1);
});

test('send callback errors and socket close release queued frames', () => {
  const failed = new FakeWebSocket();
  sendWsFrame(failed, 'active'); sendWsFrame(failed, 'queued');
  failed.complete(new Error('write failed'));
  assert.equal(failed.terminated, 1);
  assert.deepEqual(failed.frames, ['active']);

  const closed = new FakeWebSocket();
  sendWsFrame(closed, 'active'); sendWsFrame(closed, 'queued');
  closed.readyState = 3; closed.emit('close'); closed.complete();
  assert.deepEqual(closed.frames, ['active']);
});

test('stalled media send expires without accumulating snapshots indefinitely', t => {
  let expire;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, WS_SEND_TIMEOUT_MS);
    expire = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const ws = new FakeWebSocket();
  sendWsFrame(ws, 'media');
  for (let seq = 1; seq <= 1000; seq++) sendWsFrame(ws, JSON.stringify({ type: 'snapshot', seq }));
  assert.equal(ws.terminated, 0);
  expire();
  assert.equal(ws.terminated, 1);
  ws.complete();
  assert.deepEqual(ws.frames, ['media']);
});

test('unwritable log destination does not cause an uncaught stream error', async t => {
  const dir = await temp(t);
  await fs.writeFile(path.join(dir, 'logs'), 'not a directory');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const {logError} = await import(' + JSON.stringify(new URL('../dist/logging.js', import.meta.url).href) + '); logError("test"); setTimeout(() => logError("still running"), 30);'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /still running/);
  assert.match(result.stderr, /File logging disabled/);
});


test('reload waits for a pending freewheel write before reading and applying config', async t => {
  const file = path.join(await temp(t), 'config.json');
  await fs.writeFile(file, '{}');
  const store = new GlobalSettingsStore(file, initial);
  const originalWrite = fs.writeFile;
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { started = resolve; });
  fs.writeFile = async (...args) => {
    if (String(args[0]).startsWith(file + '.')) { started(); await blocked; }
    return originalWrite(...args);
  };
  t.after(() => { fs.writeFile = originalWrite; });
  const save = store.setFreewheel({ max_duration_sec: 90 });
  await writing;
  let applied;
  const reload = store.reload(config => { applied = config.freewheel.max_duration_sec; });
  release();
  await Promise.all([save, reload]);
  assert.equal(applied, 90);
  assert.equal(store.get().freewheel.max_duration_sec, 90);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).freewheel.max_duration_sec, 90);
});
