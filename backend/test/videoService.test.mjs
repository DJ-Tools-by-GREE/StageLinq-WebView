import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { VideoService, videoDeckCommand } from '../dist/videoService.js';
import { parseVideoConfig } from '../dist/videoConfig.js';
import { scanVideoLibrary } from '../dist/videoLibrary.js';
import { GlobalSettingsStore } from '../dist/globalSettings.js';
import { FREEWHEEL_STALE_THRESHOLD_MS } from '../dist/constants.js';

const deckNumbers = [1, 2, 3, 4];
const deck = (number = 1, patch = {}) => ({
  deck: number, trackLoaded: true, fileName: 'Song.mp3', mediaId: 'net://device/USB/Song.mp3',
  title: 'Song', artist: '', elapsedSec: 10, totalSec: 180, currentBpm: 120, trackBpm: 120,
  speedState: 0, keyIndex: null, keyCamelot: '', fader: 0, play: true, updatedAt: 1000,
  hotCues: [], loopActive: false, loopInSec: null, loopOutSec: null, savedLoops: [], ...patch,
});
const timing = (patch = {}) => ({
  positionAtMs: 1000, positionRevision: 1, transportRevision: 1, trackId: 'net://device/USB/Song.mp3',
  transportPlay: true, ...patch,
});
const allDecks = () => Object.fromEntries(deckNumbers.map(n => [n, deck(n, { elapsedSec: n * 10 })]));
const allTimings = () => Object.fromEntries(deckNumbers.map(n => [n, timing()]));

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'slwv-video-service-')));
  await fs.writeFile(path.join(directory, 'Song (Music Video).mp4'), 'fake video; no decoder is started');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = parseVideoConfig({ enabled: true, directory, multi_ndi_stream: true });
  const library = await scanVideoLibrary(config, directory);
  return { directory, config, library };
}

function renderers(options = {}) {
  const instances = [];
  const factory = callbacks => {
    const renderer = {
      callbacks, starts: [], stops: 0, sent: [],
      async start(config) { this.starts.push(structuredClone(config)); await options.start?.(config, this); },
      send(commands, nowMs) { this.sent.push({ commands: structuredClone(commands), nowMs }); },
      async stop() { this.stops++; await options.stop?.(this); },
    };
    instances.push(renderer);
    return renderer;
  };
  return { instances, factory };
}

test('video position follows genuine source time, pitch, content offset and output latency', async t => {
  const { config, library } = await fixture(t);
  config.offsets_sec['Song.mp3'] = 1.25;
  config.offsets_sec['Song.wav'] = 99;
  config.latency_comp_ms = 50;
  const state = deck(1, { speedState: 4, currentBpm: 150, trackBpm: 75 });
  const command = videoDeckCommand(state, timing(), config, library, 'live', 1100);
  assert.equal(command.playing, true);
  assert.equal(command.rate, 1.04);
  assert.ok(Math.abs(command.positionSec - 11.406) < 1e-9);
  assert.equal(state.elapsedSec, 10);
  assert.equal(command.path, library.files[0].path);
  const normalized = videoDeckCommand({ ...state, fileName: 'net://device/USB/Song.mp3' }, timing(), config, library, 'live', 1100);
  assert.equal(normalized.positionSec, command.positionSec);
});

test('pause, stale telemetry and missing positions produce black without treating metadata as a heartbeat', async t => {
  const { config, library } = await fixture(t);
  const state = deck();
  assert.equal(videoDeckCommand(state, timing({ transportPlay: false }), config, library, 'live', 1050).playing, false);
  assert.equal(videoDeckCommand({ ...state, play: false }, timing(), config, library, 'live', 1050).playing, true);
  const staleNow = 1000 + FREEWHEEL_STALE_THRESHOLD_MS + 1;
  const repeated = videoDeckCommand({ ...state, updatedAt: staleNow, title: 'new metadata' }, timing(), config, library, 'live', staleNow);
  assert.equal(repeated.playing, false);
  assert.equal(videoDeckCommand(state, timing({ positionAtMs: null }), config, library, 'live', 1050).playing, false);
  assert.equal(videoDeckCommand(state, timing({ positionAtMs: 1100 }), config, library, 'live', 1050).playing, false);
  assert.equal(videoDeckCommand(state, timing(), config, library, 'live', 1000 + FREEWHEEL_STALE_THRESHOLD_MS).playing, true);
});

test('unload, no match, ambiguity, negative offset, track end and unsupported reverse cannot play', async t => {
  const { directory, config, library } = await fixture(t);
  assert.equal(videoDeckCommand(deck(1, { trackLoaded: false }), timing(), config, library, 'live', 1000).path, null);
  assert.equal(videoDeckCommand(deck(1, { fileName: 'Other.mp3' }), timing(), config, library, 'live', 1000).playing, false);
  assert.equal(videoDeckCommand(deck(1, { speedState: -200 }), timing(), config, library, 'live', 1000).playing, false);
  assert.equal(videoDeckCommand(deck(1, { elapsedSec: 180 }), timing(), config, library, 'live', 1000).playing, false);
  assert.equal(videoDeckCommand(deck(), timing(), { ...config, offsets_sec: { 'Song.mp3': -20 } }, library, 'live', 1000).playing, false);
  await fs.writeFile(path.join(directory, 'Song (Music Video).mov'), 'duplicate');
  const ambiguous = await scanVideoLibrary(config, directory);
  assert.equal(videoDeckCommand(deck(), timing(), config, ambiguous, 'live', 1000).path, null);
});

test('all four decks run independently, and replay switches reject old source status', async t => {
  const { directory, config } = await fixture(t);
  const mock = renderers();
  const service = new VideoService(mock.factory);
  t.after(() => service.shutdown());
  await service.configure(config, directory);
  const states = allDecks();
  const timings = allTimings();
  service.update(states, timings, false, 1050);
  const renderer = mock.instances[0];
  const first = renderer.sent.at(-1).commands;
  assert.deepEqual(first.map(command => command.deck), deckNumbers);
  assert.ok(first.every(command => command.playing));
  assert.deepEqual(first.map(command => command.positionSec), [10.05, 20.05, 30.05, 40.05]);
  renderer.callbacks.status({ deck: 1, generation: first[0].generation, state: 'playing', width: 1920, height: 1080, fps: 30 });
  service.update(states, timings, false, 1050);
  assert.equal(service.getStatus().decks[1].state, 'playing');
  service.update(states, timings, true, 1050);
  const replay = renderer.sent.at(-1).commands;
  assert.ok(replay.every((command, index) => command.generation !== first[index].generation));
  renderer.callbacks.status({ deck: 1, generation: first[0].generation, state: 'error', error: 'obsolete decoder' });
  service.update(states, timings, true, 1050);
  assert.equal(service.getStatus().decks[1].state, 'loading');
  renderer.callbacks.status({ deck: 1, generation: replay[0].generation, state: 'playing', width: 1280, height: 720, fps: 24 });
  service.update(states, timings, true, 1050);
  assert.equal(service.getStatus().decks[1].state, 'playing');
  assert.equal(service.getStatus().decks[1].width, 1280);
  service.update(states, timings, false, 1050);
  assert.notEqual(renderer.sent.at(-1).commands[0].generation, replay[0].generation);
});

test('the default stream follows the highest playing fader and keeps its source through handoffs', async t => {
  const { directory } = await fixture(t);
  const mock = renderers();
  const service = new VideoService(mock.factory);
  t.after(() => service.shutdown());
  await service.initialize({ enabled: true, directory }, directory);
  const states = allDecks(), timings = allTimings();
  states[1].fader = 0.6;
  states[2].fader = 0.8;
  states[3].fader = 1;
  timings[3].transportPlay = false;
  const renderer = mock.instances[0];
  const send = (replay = false) => {
    service.update(states, timings, replay, 1000);
    const { commands } = renderer.sent.at(-1);
    assert.equal(commands.length, 1);
    return commands[0];
  };
  const first = send();
  assert.equal(first.deck, 2);
  assert.equal(first.playing, true);
  assert.equal(first.positionSec, 20);
  assert.equal(service.getStatus().activeDeck, 2);
  assert.equal(service.getStatus().decks[2].sourceName, 'StageLinq');
  assert.equal(service.getStatus().decks[1].sourceName, null);
  states[1].fader = 0.8;
  assert.deepEqual(send(), first);
  states[1].fader = 0.9;
  const second = send();
  assert.equal(second.deck, 1);
  assert.notEqual(second.generation, first.generation);
  states[1].fader = 0.6;
  const returned = send();
  assert.equal(returned.deck, 2);
  assert.notEqual(returned.generation, first.generation);
  renderer.callbacks.status({ deck: 2, generation: first.generation, state: 'error', error: 'obsolete handoff' });
  send();
  assert.equal(service.getStatus().decks[2].state, 'loading');
  renderer.callbacks.status({ deck: 2, generation: returned.generation, state: 'playing' });
  send();
  assert.equal(service.getStatus().decks[2].state, 'playing');
  const replay = send(true);
  assert.equal(replay.deck, 2);
  assert.notEqual(replay.generation, returned.generation);
  states[2].fileName = 'Unmatched.mp3';
  assert.equal(send(true).path, null);
  assert.equal(service.getStatus().decks[2].state, 'unmatched');
  for (const deck of deckNumbers) timings[deck].transportPlay = false;
  assert.equal(send(true).playing, false);
  assert.equal(service.getStatus().activeDeck, null);
  assert.equal(mock.instances.length, 1);
  assert.equal(renderer.stops, 0);
});

test('reloading the stream mode replaces the renderer and rolls back a failed mode change', async t => {
  const { directory, config } = await fixture(t);
  let failMulti = false;
  const mock = renderers({ start(next) { if (failMulti && next.multi_ndi_stream) throw new Error('cannot start four sources'); } });
  const service = new VideoService(mock.factory);
  t.after(() => service.shutdown());
  await service.configure(config, directory);
  await service.configure({ ...config, multi_ndi_stream: false }, directory);
  assert.equal(mock.instances[0].stops, 1);
  assert.equal(service.getStatus().multiNdiStream, false);
  failMulti = true;
  await assert.rejects(service.configure(config, directory), /cannot start four sources/);
  assert.equal(mock.instances[1].stops, 1);
  assert.equal(mock.instances[2].stops, 1);
  assert.equal(mock.instances[3].starts[0].multi_ndi_stream, false);
  assert.equal(service.getStatus().multiNdiStream, false);
  service.update(allDecks(), allTimings(), false, 1000);
  assert.equal(mock.instances[3].sent.at(-1).commands.length, 1);
});

test('a mode reload waits for a failed renderer to exit before announcing new sources', async t => {
  const { directory, config } = await fixture(t);
  let release;
  const stopped = new Promise(resolve => { release = resolve; });
  const mock = renderers({ stop(renderer) { if (renderer === mock.instances[0]) return stopped; } });
  const service = new VideoService(mock.factory);
  t.after(() => { release(); return service.shutdown(); });
  await service.configure(config, directory);
  mock.instances[0].callbacks.error('renderer failed');
  const reloading = service.configure({ ...config, multi_ndi_stream: false }, directory);
  try {
    await Promise.race([reloading, delay(100)]);
    assert.equal(mock.instances.length, 1);
  } finally {
    release();
  }
  await reloading;
  assert.equal(mock.instances.length, 2);
  assert.equal(service.getStatus().multiNdiStream, false);
});

test('failed folder reload preserves the running renderer and successful rescan replaces the catalog', async t => {
  const { directory, config } = await fixture(t);
  const mock = renderers();
  const service = new VideoService(mock.factory);
  t.after(() => service.shutdown());
  await service.configure(config, directory);
  const states = allDecks();
  const timings = allTimings();
  service.update(states, timings, false, 1000);
  const first = mock.instances[0].sent.at(-1).commands[0];
  await assert.rejects(service.configure({ ...config, directory: path.join(directory, 'missing') }, directory), /Cannot scan video directory/);
  assert.equal(service.getStatus().running, true);
  assert.equal(mock.instances[0].stops, 0);
  assert.equal(mock.instances.length, 1);
  service.update(states, timings, false, 1000);
  assert.equal(mock.instances[0].sent.at(-1).commands[0].generation, first.generation);
  await fs.writeFile(path.join(directory, 'Song (Music Video).mp4'), 'replaced with different data length');
  await service.rescan();
  service.update(states, timings, false, 1000);
  assert.notEqual(mock.instances[0].sent.at(-1).commands[0].generation, first.generation);
  assert.equal(mock.instances.length, 1);
  await fs.rename(path.join(directory, 'Song (Music Video).mp4'), path.join(directory, 'Other (Music Video).mp4'));
  await service.rescan();
  service.update(states, timings, false, 1000);
  assert.equal(mock.instances[0].sent.at(-1).commands[0].path, null);
  assert.equal(service.getStatus().decks[1].state, 'unmatched');
});

test('mapping rescans preserve active playback on errors and switch only affected deck generations', async t => {
  const { directory, config } = await fixture(t);
  const alternate = path.join(directory, 'alternate.mp4');
  const mappingPath = path.join(directory, 'mappings.json');
  await fs.writeFile(alternate, 'alternate edit');
  const mock = renderers();
  const service = new VideoService(mock.factory);
  t.after(() => service.shutdown());
  config.offsets_sec['Song.mp3'] = 2;
  await service.configure(config, directory);
  const states = allDecks(), timings = allTimings();
  states[2] = deck(2, { fileName: 'Song.wav', mediaId: 'net://device/USB/Song.wav' });
  timings[2] = timing({ trackId: states[2].mediaId });
  const renderer = mock.instances[0];
  service.update(states, timings, false, 1000);
  const original = renderer.sent.at(-1).commands;
  await fs.writeFile(mappingPath, JSON.stringify({ 'Song.mp3': 'alternate.mp4' }));
  await service.rescan();
  service.update(states, timings, false, 1000);
  const mapped = renderer.sent.at(-1).commands;
  assert.equal(mapped[0].path, alternate);
  assert.notEqual(mapped[0].generation, original[0].generation);
  assert.equal(mapped[0].positionSec, 12);
  assert.deepEqual(mapped[1], original[1]);
  assert.equal(service.getStatus().decks[1].video, 'alternate.mp4');
  assert.equal(mock.instances.length, 1);
  renderer.callbacks.status({ deck: 1, generation: original[0].generation, state: 'error', error: 'obsolete decoder' });
  service.update(states, timings, false, 1000);
  assert.equal(service.getStatus().decks[1].state, 'loading');
  renderer.callbacks.status({ deck: 1, generation: mapped[0].generation, state: 'playing' });
  for (const content of ['{', JSON.stringify({ 'Song.mp3': 'missing.mp4' })]) {
    await fs.writeFile(mappingPath, content);
    await assert.rejects(service.rescan(), /mappings\.json/);
    await assert.rejects(service.configure(config, directory), /mappings\.json/);
    service.update(states, timings, false, 1000);
    assert.deepEqual(renderer.sent.at(-1).commands, mapped);
    assert.equal(service.getStatus().decks[1].state, 'playing');
    assert.equal(renderer.stops, 0);
  }
  await fs.writeFile(mappingPath, JSON.stringify({ 'Song.mp3': 'alternate.mp4' }));
  await service.rescan();
  service.update(states, timings, false, 1000);
  assert.deepEqual(renderer.sent.at(-1).commands, mapped);
  service.update(states, timings, true, 1000);
  const replay = renderer.sent.at(-1).commands;
  assert.equal(replay[0].path, alternate);
  assert.notEqual(replay[0].generation, mapped[0].generation);
  await fs.unlink(mappingPath);
  await service.rescan();
  service.update(states, timings, false, 1000);
  assert.deepEqual(renderer.sent.at(-1).commands, original);
});

test('resume waits for a new source position, while a fresh position can follow a hot cue or loop jump', async t => {
  const { directory, config } = await fixture(t);
  const mock = renderers();
  const service = new VideoService(mock.factory);
  t.after(() => service.shutdown());
  await service.configure(config, directory);
  const states = allDecks();
  const timings = allTimings();
  service.update(states, timings, false, 1000);
  timings[1] = timing({ transportPlay: false, transportRevision: 2 });
  service.update(states, timings, false, 1020);
  assert.equal(mock.instances[0].sent.at(-1).commands[0].playing, false);
  timings[1] = timing({ transportPlay: true, transportRevision: 3 });
  service.update(states, timings, false, 1030);
  assert.equal(mock.instances[0].sent.at(-1).commands[0].playing, false);
  states[1].updatedAt = 1040;
  service.update(states, timings, false, 1040);
  assert.equal(mock.instances[0].sent.at(-1).commands[0].playing, false);
  states[1].elapsedSec = 3;
  timings[1] = timing({ transportPlay: true, transportRevision: 3, positionRevision: 2, positionAtMs: 1050 });
  service.update(states, timings, false, 1050);
  const resumed = mock.instances[0].sent.at(-1).commands[0];
  assert.equal(resumed.playing, true);
  assert.equal(resumed.positionSec, 3);
  assert.equal(mock.instances[0].sent.at(-1).commands[1].playing, true);
});

test('failed renderer replacement restores the previous config and discards failed-instance callbacks', async t => {
  const { directory, config } = await fixture(t);
  const mock = renderers({ start(next) { if (next.output_format === '1080p30') throw new Error('simulated initialization failure'); } });
  const service = new VideoService(mock.factory);
  t.after(() => service.shutdown());
  await service.configure(config, directory);
  await assert.rejects(service.configure({ ...config, output_format: '1080p30' }, directory), /simulated initialization failure/);
  assert.equal(mock.instances.length, 3);
  assert.equal(mock.instances[0].stops, 1);
  assert.equal(mock.instances[1].stops, 1);
  assert.equal(service.getStatus().outputFormat, 'source');
  assert.equal(service.getStatus().running, true);
  mock.instances[1].callbacks.error('late failed-process error');
  assert.equal(service.getStatus().error, null);
  service.update(allDecks(), allTimings(), false, 1000);
  assert.equal(mock.instances[2].sent.length, 1);
});

test('disabled output never starts a helper, and enabling errors remain visible without crashing the service', async t => {
  const { directory, config } = await fixture(t);
  const mock = renderers({ start() { throw new Error('NDI runtime missing'); } });
  const service = new VideoService(mock.factory);
  t.after(() => service.shutdown());
  await service.initialize(undefined, directory);
  assert.equal(service.getStatus().enabled, false);
  assert.equal(mock.instances.length, 0);
  await service.initialize(config, directory);
  assert.equal(service.getStatus().enabled, true);
  assert.equal(service.getStatus().running, false);
  assert.equal(service.getStatus().indexedVideos, 1);
  assert.match(service.getStatus().error, /NDI runtime missing/);
  service.update(allDecks(), allTimings(), false, 1000);
  assert.equal(service.getStatus().decks[1].state, 'error');
});

test('async config reload preserves cached settings until preparation succeeds and rejects failed preparation', async t => {
  const { directory } = await fixture(t);
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ freewheel: { enable_freewheeling: false, max_duration_sec: 99 } }));
  const store = new GlobalSettingsStore(configPath, { freewheel: { enable_freewheeling: true, max_duration_sec: 30 } });
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const loading = store.reload(async () => { enter(); await gate; });
  await entered;
  assert.equal(store.get().freewheel.max_duration_sec, 30);
  release();
  await loading;
  assert.equal(store.get().freewheel.max_duration_sec, 99);
  await fs.writeFile(configPath, JSON.stringify({ freewheel: { enable_freewheeling: true, max_duration_sec: 12 } }));
  await assert.rejects(store.reload(async () => { await nextTurn(); throw new Error('video preparation failed'); }), /video preparation failed/);
  assert.equal(store.get().freewheel.max_duration_sec, 99);
});

test('shutdown cancels a renderer that is still starting', async t => {
  const { directory, config } = await fixture(t);
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const mock = renderers({ start: async () => { enter(); await gate; }, stop() { release(); } });
  const service = new VideoService(mock.factory);
  const configuring = service.configure(config, directory);
  const rejected = assert.rejects(configuring, /shutting down|stopping/);
  await entered;
  const closing = service.shutdown();
  await nextTurn();
  const wasStopped = mock.instances[0].stops > 0;
  release();
  await Promise.all([closing, rejected]);
  assert.equal(wasStopped, true, 'shutdown must stop the in-flight helper without waiting for startup to finish');
});

test('new track metadata cannot play its video using the previous track position', async t => {
  const { config, library } = await fixture(t);
  const replacement = deck(1, { mediaId: 'net://other-device/USB/Song.mp3' });
  assert.equal(videoDeckCommand(replacement, timing(), config, library, 'live', 1050).playing, false);
  assert.equal(videoDeckCommand(replacement, timing({ trackId: replacement.mediaId, positionRevision: 2 }), config, library, 'live', 1050).playing, true);
  assert.equal(videoDeckCommand(deck(), timing({ trackId: 'replay:3:1:net://device/USB/Song.mp3' }), config, library, 'replay', 1050).playing, true);
  assert.equal(videoDeckCommand(deck(), timing({ trackId: 'replay:3:1:net://old-device/USB/Song.mp3' }), config, library, 'replay', 1050).playing, false);
  assert.equal(videoDeckCommand(deck(1, { mediaId: '' }), timing({ trackId: 'replay:3:1:' }), config, library, 'replay', 1050).playing, true);
});

test('a rescan queued during reload uses the new active configuration', async t => {
  const { directory, config } = await fixture(t);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const mock = renderers({ async start(next) { if (next.ndi_name_prefix === 'New') { enter(); await gate; } } });
  const service = new VideoService(mock.factory);
  t.after(() => service.shutdown());
  await service.configure(config, directory);
  const changing = service.configure({ ...config, ndi_name_prefix: 'New' }, directory);
  await entered;
  const scanning = service.rescan();
  release();
  await Promise.all([changing, scanning]);
  assert.equal(service.getStatus().sourcePrefix, 'New');
  assert.equal(mock.instances.length, 2);
});

test('unchanged reload and rescan preserve playing generations; rescan retries only failed decoders', async t => {
  const { directory, config } = await fixture(t);
  const mock = renderers();
  const service = new VideoService(mock.factory);
  t.after(() => service.shutdown());
  await service.configure(config, directory);
  const states = allDecks(), timings = allTimings();
  service.update(states, timings, false, 1000);
  const first = mock.instances[0].sent.at(-1).commands;
  mock.instances[0].callbacks.status({ deck: 1, generation: first[0].generation, state: 'playing' });
  await service.configure(config, directory);
  await service.rescan();
  service.update(states, timings, false, 1000);
  assert.deepEqual(mock.instances[0].sent.at(-1).commands, first);
  assert.equal(service.getStatus().decks[1].state, 'playing');
  mock.instances[0].callbacks.status({ deck: 1, generation: first[0].generation, state: 'error', error: 'decoder failed' });
  await service.rescan();
  service.update(states, timings, false, 1000);
  const retried = mock.instances[0].sent.at(-1).commands;
  assert.notEqual(retried[0].generation, first[0].generation);
  assert.deepEqual(retried.slice(1), first.slice(1));
});
