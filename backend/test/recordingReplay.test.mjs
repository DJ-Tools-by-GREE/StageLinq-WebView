import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Recorder } from '../dist/recorder.js';
import { Replay } from '../dist/replay.js';
import { makeStateProvider } from '../dist/stateProvider.js';
import { applyLoggingConfig } from '../dist/logging.js';
import { TimecodeTimeline } from '../dist/timecodeTimeline.js';

applyLoggingConfig({ lifecycle: false, errors: false });

function deck(n, fileName = 'recorded.mp3') {
  return { deck: n, trackLoaded: true, fileName, title: 'Track', artist: 'Artist',
    elapsedSec: 1, totalSec: 120, currentBpm: 120, trackBpm: 120, speedState: 0,
    keyIndex: null, keyCamelot: '--', fader: 1, play: true, updatedAt: 0,
    hotCues: [], loopActive: false, loopInSec: null, loopOutSec: null, savedLoops: [] };
}

async function setup(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'slwv-recording-test-'));
  const decks = Object.fromEntries([1, 2, 3, 4].map(n => [n, deck(n)]));
  const listeners = new Set();
  const bridge = {
    getDecks: () => decks, getDeck: n => decks[n], getLastBeatAgeMs: () => 0,
    subscribeDeckState(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const recorder = new Recorder({ bridge, recordingsDir: dir, getTrackOffsets: () => ({}),
    getPlaylistRef: () => '', isReplayActive: () => false, getStatus: () => 'connected',
    getSelectedDeck: () => 3 });
  t.after(async () => {
    await recorder.shutdown().catch(() => {});
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  return { dir, decks, bridge, recorder, listeners };
}

async function writeLog(dir, extraHeader = {}) {
  const events = [
    { type: 'header', v: 1, startedAt: 1000, trackOffsets: {}, ...extraHeader },
    ...[1, 2, 3, 4].map(n => ({ t: 0, type: 'deck', n, state: deck(n) })),
    { t: 2000, type: 'deck', n: 1, diff: { elapsedSec: 2 } },
    { t: 3000, type: 'deck', n: 1, diff: { elapsedSec: 3 } },
    { t: 10000, type: 'deck', n: 1, diff: { elapsedSec: 10 } },
    { t: 100000, type: 'footer', stoppedAt: 101000 },
  ];
  await fs.promises.writeFile(path.join(dir, 'show.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
}

test('record start reserves synchronously and concurrent starts open only one recording', async t => {
  const { recorder, listeners } = await setup(t);
  const first = recorder.start('first');
  assert.equal(recorder.isBusy(), true);
  const results = await Promise.all([first, recorder.start('second')]);
  assert.deepEqual(results.map(r => r.ok), [true, false]);
  assert.equal(listeners.size, 1);
});

test('shutdown waits for an in-flight start and persists selection and footer', async t => {
  const { recorder, dir, listeners } = await setup(t);
  const starting = recorder.start('shutdown');
  await recorder.shutdown();
  const result = await starting;
  assert.equal(recorder.isBusy(), false);
  assert.equal(listeners.size, 0);
  const events = (await fs.promises.readFile(path.join(dir, result.file), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.find(e => e.type === 'selected'), { t: 0, type: 'selected', deck: 3 });
  assert.equal(events.at(-1).type, 'footer');
  assert.equal(fs.existsSync(path.join(dir, '.active-recording')), false);
});

test('a following start retains its recovery lock after the previous stop completes', async t => {
  const { recorder, dir } = await setup(t);
  await recorder.start('first');
  const stopping = recorder.stop();
  const second = recorder.start('second');
  await stopping;
  const result = await second;
  assert.equal((await fs.promises.readFile(path.join(dir, '.active-recording'), 'utf8')).trim(), result.file);
});

test('write errors end recording, reject stop, and retain the recovery lock without a sidecar', async t => {
  const { recorder, dir } = await setup(t);
  const started = await recorder.start();
  recorder.stream.destroy(new Error('injected disk failure'));
  await new Promise(resolve => recorder.stream.once('close', resolve));
  assert.equal(recorder.isActive(), false);
  const count = recorder.getStatus().eventCount;
  recorder.recordSelected(4);
  assert.equal(recorder.getStatus().eventCount, count);
  await assert.rejects(recorder.stop(), /injected disk failure/);
  assert.equal(fs.existsSync(path.join(dir, '.active-recording')), true);
  assert.equal(fs.existsSync(path.join(dir, started.file.replace('.jsonl', '.meta.json'))), false);
});

test('recovery repairs a torn final line before writing the gap and fresh selection', async t => {
  const { recorder, dir } = await setup(t);
  const prefix = [{ type: 'header', v: 1, startedAt: Date.now() - 1000 },
    { t: 0, type: 'deck', n: 1, state: deck(1) }].map(JSON.stringify).join('\n') + '\n';
  await fs.promises.writeFile(path.join(dir, 'torn.jsonl'), prefix + '{"t":50,"type":"deck"');
  await fs.promises.writeFile(path.join(dir, '.active-recording'), 'torn.jsonl');
  assert.equal(await recorder.prepareResumeFromOrphan(), true);
  assert.equal((await recorder.finalizeResume()).ok, true);
  await recorder.stop();
  const events = (await fs.promises.readFile(path.join(dir, 'torn.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.type === 'gap').length, 1);
  assert.equal(events.find(e => e.type === 'selected').deck, 3);
});

test('state provider advances an attaching replay before testing whether it owns outputs', async t => {
  const { dir, bridge, decks } = await setup(t);
  await writeLog(dir, { trackOffsets: { 'recorded.mp3': { offsetSec: 10800, offsetFrame: 5 } } });
  const replay = new Replay({ recordingsDir: dir });
  await replay.arm([{ audio_file: 'backup.wav', log_file: 'show.jsonl' }]);
  decks[1] = deck(1, 'backup.wav');
  decks[1].play = false;
  replay.onTrackChanged(1, 'backup.wav');
  const provider = makeStateProvider({ bridge, replay, disconnectTimeoutSec: 5 });
  assert.equal(provider.getDeck(1).fileName, 'backup.wav');
  assert.equal(replay.getTrackOffsets(), null);
  decks[1].play = true;
  assert.equal(provider.getDeck(1).fileName, 'recorded.mp3');
  assert.equal(replay.getStatus().state, 'active');
  assert.deepEqual(replay.getTrackOffsets(), { 'recorded.mp3': { offsetSec: 10800, offsetFrame: 5 } });
  replay.disarm();
  assert.equal(replay.getTrackOffsets(), null);
});

test('backward seeks reset clock freshness and seeking before the end resumes playback', async t => {
  const { dir } = await setup(t);
  await writeLog(dir);
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const replay = new Replay({ recordingsDir: dir });
  await replay.arm([{ audio_file: 'backup.wav', log_file: 'show.jsonl' }]);
  replay.onTrackChanged(1, 'backup.wav');
  replay.tick(true, 10);
  now += 300;
  assert.equal(replay.tick(true, 2).decks[1].play, true);
  now += 50;
  assert.equal(replay.tick(true, 2.05).decks[1].play, true);
  assert.equal(replay.tick(true, 110).decks[1].play, false);
  assert.equal(replay.getStatus().state, 'ended');
  assert.equal(replay.tick(true, 3).decks[1].play, true);
  assert.equal(replay.getStatus().state, 'active');
});

test('disarm cancels pending loading and configured audio remains suppressed', async t => {
  const { dir } = await setup(t);
  await writeLog(dir);
  const originalRead = fs.promises.readFile;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(fs.promises, 'readFile', async (...args) => { await gate; return originalRead(...args); });
  const replay = new Replay({ recordingsDir: dir });
  const arming = replay.arm([{ audio_file: 'backup.wav', log_file: 'show.jsonl' }]);
  assert.equal(replay.isArmedOrActive(), true);
  replay.disarm();
  release();
  assert.equal((await arming).ok, false);
  assert.equal(replay.getStatus().state, 'idle');
  assert.equal(replay.shouldSuppressWaveformExtraction('backup.wav'), true);
  replay.configureMappedAudioFiles([]);
  assert.equal(replay.shouldSuppressWaveformExtraction('backup.wav'), false);
});

test('invalid or empty logs cannot arm a silent replacement show', async t => {
  const { dir } = await setup(t);
  await fs.promises.writeFile(path.join(dir, 'bad.jsonl'), 'not a recording');
  const replay = new Replay({ recordingsDir: dir });
  const result = await replay.arm([{ audio_file: 'backup.wav', log_file: 'bad.jsonl' }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].error, /header and deck keyframe/);
  assert.equal(replay.isArmedOrActive(), false);
});

test('replay preserves the last audio position through dropout and follows explicit pause and fresh recovery', async t => {
  const { dir } = await setup(t);
  await writeLog(dir);
  const replay = new Replay({ recordingsDir: dir });
  await replay.arm([{ audio_file: 'backup.wav', log_file: 'show.jsonl' }]);
  replay.onTrackChanged(1, 'backup.wav');
  const audioTiming = { positionAtMs: 1000, positionRevision: 1, transportRevision: 1, trackId: 'backup.wav' };
  const options = { fps: 30, staleThresholdMs: 250, reconnecting: false, enableFreewheeling: true, freewheelMaxDurationSec: 30 };
  const timeline = new TimecodeTimeline();
  let out = replay.tick(true, 2, audioTiming);
  const initialTiming = { ...replay.getDeckTimings()[1] };
  timeline.tick(out.decks[1], initialTiming, 1000, options);
  const beforeDropout = timeline.tick(out.decks[1], initialTiming, 1100, options).frames;
  out = replay.tick(false, 0, { ...audioTiming, positionAtMs: null });
  assert.equal(replay.getStatus().cursorMs, 2000);
  assert.equal(out.decks[1].play, true);
  assert.deepEqual(replay.getDeckTimings()[1], initialTiming);
  const duringDropout = timeline.tick(out.decks[1], replay.getDeckTimings()[1], 1400, options);
  assert.equal(duringDropout.freewheelActive, true);
  assert.ok(duringDropout.frames > beforeDropout);

  out = replay.tick(false, 2, { ...audioTiming, transportRevision: 2 });
  assert.equal(out.decks[1].play, false);
  assert.ok(replay.getDeckTimings()[1].transportRevision > initialTiming.transportRevision);
  assert.equal(timeline.tick(out.decks[1], replay.getDeckTimings()[1], 1500, options).frames, null);
  out = replay.tick(true, 3, { ...audioTiming, positionAtMs: 1700, positionRevision: 2, transportRevision: 3 });
  assert.equal(replay.getStatus().cursorMs, 3000);
  assert.equal(out.decks[1].play, true);
  assert.equal(replay.getDeckTimings()[1].positionAtMs, 1700);
});

test('advancing backup audio cannot make a missing recorded position look fresh', async t => {
  const { dir } = await setup(t);
  await writeLog(dir);
  const replay = new Replay({ recordingsDir: dir });
  await replay.arm([{ audio_file: 'backup.wav', log_file: 'show.jsonl' }]);
  replay.onTrackChanged(1, 'backup.wav');
  const timing = { positionAtMs: 1000, positionRevision: 1, transportRevision: 1, trackId: 'backup.wav' };
  replay.tick(true, 2, timing);
  const before = { ...replay.getDeckTimings()[1] };
  replay.tick(true, 2.5, { ...timing, positionAtMs: 1500, positionRevision: 2 });
  assert.deepEqual(replay.getDeckTimings()[1], before);
});
