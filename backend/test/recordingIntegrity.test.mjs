import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { Recorder } from '../dist/recorder.js';
import { Replay } from '../dist/replay.js';
import { parseRecording, blankRecordedDeck } from '../dist/recordingLog.js';
import { TimecodeTimeline } from '../dist/timecodeTimeline.js';
import { applyLoggingConfig } from '../dist/logging.js';

applyLoggingConfig({ lifecycle: false, errors: false });

async function setup(t, more = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'slwv-integrity-'));
  const decks = Object.fromEntries([1, 2, 3, 4].map(n => [n, { ...blankRecordedDeck(n),
    trackLoaded: true, fileName: 'track.mp3', mediaId: 'net://device/USB/a/track.mp3', elapsedSec: 1, totalSec: 100, play: true }]));
  const timings = Object.fromEntries([1, 2, 3, 4].map(n => [n, { positionAtMs: 1000, positionRevision: 1, transportRevision: 1, trackId: decks[n].mediaId }]));
  const listeners = new Set();
  const bridge = { getDecks: () => decks, getDeckTiming: n => timings[n],
    subscribeDeckState(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const options = { bridge, recordingsDir: dir, getTrackOffsets: () => ({}), getPlaylistRef: () => '',
    isReplayActive: () => false, getStatus: () => 'connected', monotonicNowMs: () => 1000, ...more };
  const recorder = new Recorder(options);
  t.after(async () => { await recorder.shutdown().catch(() => {}); await fs.promises.rm(dir, { recursive: true, force: true }); });
  return { dir, decks, timings, listeners, recorder, options };
}

const source = (t, revision, transport = 1) => ({ positionT: t, positionRevision: revision, transportRevision: transport, trackId: 'net://device/USB/a/track.mp3' });
const audio = (t, revision) => ({ positionAtMs: 10000 + t, positionRevision: revision, transportRevision: 1, trackId: 'backup.wav' });
async function logFile(dir, rows, name = 'show.jsonl') {
  const p = path.join(dir, name);
  await fs.promises.writeFile(p, rows.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n') + '\n');
  return p;
}
function header(extra = {}) { return { type: 'header', v: 2, startedAt: 1000, trackOffsets: {}, ...extra }; }
function keyframe(t = 0) { return { t, type: 'deck', n: 1, state: { ...blankRecordedDeck(1), trackLoaded: true, fileName: 'track.mp3', elapsedSec: 1, totalSec: 100, play: true }, timing: source(t, 1) }; }

test('v2 recording preserves equal-position heartbeat, synthetic stop provenance, monotonic time and changed offsets', async t => {
  let mono = 1000, wall = 5000, offsets = {};
  const { recorder, options, dir, decks, timings, listeners } = await setup(t, { monotonicNowMs: () => mono, wallNowMs: () => wall, getTrackOffsets: () => offsets });
  const started = await recorder.start();
  mono += 100; wall -= 4000;
  timings[1] = { ...timings[1], positionAtMs: mono, positionRevision: 2 };
  for (const listener of listeners) listener(1, decks[1], timings[1]);
  mono += 100;
  decks[1] = { ...decks[1], play: false };
  for (const listener of listeners) listener(1, decks[1], timings[1]);
  offsets = { 'track.mp3': { offsetSec: 10800, offsetFrame: 3 } };
  recorder.recordConfig(); recorder.recordConfig();
  mono += 100; wall += 900000;
  const stopped = await recorder.stop();
  const parsed = await parseRecording(path.join(dir, started.file));
  assert.equal(parsed.version, 2);
  assert.equal(parsed.durationMs, 300);
  assert.equal(stopped.durationMs, 300);
  const changed = parsed.deckEvents.filter(e => e.t > 0);
  assert.equal(changed.length, 2);
  assert.deepEqual(changed[0].diff, {});
  assert.equal(changed[0].timing.positionT, 100);
  assert.equal(changed[0].timing.positionRevision, 2);
  assert.equal(changed[1].diff.play, false);
  assert.equal(changed[1].timing.transportRevision, 1);
  assert.equal(parsed.configEvents.length, 1);
  assert.deepEqual(parsed.configEvents[0].trackOffsets, offsets);
  assert.match(parsed.timingSource, /^recorded/);
});

test('v2 replay follows historical offset changes and repeated heartbeat without turning watchdog stop into explicit pause', async t => {
  const { dir } = await setup(t);
  await logFile(dir, [header(), keyframe(),
    { t: 100, type: 'deck', n: 1, diff: {}, timing: source(100, 2) },
    { t: 200, type: 'deck', n: 1, diff: { play: false }, timing: source(100, 2) },
    { t: 300, type: 'config', trackOffsets: { 'track.mp3': { offsetSec: 100, offsetFrame: 5 } }, playlistRef: 'new' },
    { t: 700, type: 'deck', n: 1, diff: {}, timing: source(100, 2, 2) },
    { t: 1000, type: 'footer', stoppedAt: 2000 }]);
  const replay = new Replay({ recordingsDir: dir });
  assert.equal((await replay.arm([{ audio_file: 'backup.wav', log_file: 'show.jsonl' }])).ok, true);
  replay.onTrackChanged(1, 'backup.wav');
  const timeline = new TimecodeTimeline();
  const config = { fps: 30, staleThresholdMs: 250, reconnecting: false, enableFreewheeling: true, freewheelMaxDurationSec: 30 };
  let out = replay.tick(true, .05, audio(50, 1));
  timeline.tick(out.decks[1], replay.getDeckTimings()[1], 10050, config);
  const first = { ...replay.getDeckTimings()[1] };
  out = replay.tick(true, .15, audio(150, 2));
  const second = { ...replay.getDeckTimings()[1] };
  assert.ok(second.positionRevision > first.positionRevision);
  assert.equal(second.positionAtMs, 10100);
  timeline.tick(out.decks[1], second, 10150, config);
  out = replay.tick(true, .4, audio(400, 3));
  assert.equal(out.decks[1].play, false);
  assert.equal(replay.getDeckTimings()[1].transportRevision, second.transportRevision);
  assert.equal(timeline.tick(out.decks[1], replay.getDeckTimings()[1], 10400, config).freewheelActive, true);
  assert.equal(replay.getTrackOffsets()['track.mp3'].offsetSec, 100);
  out = replay.tick(true, .8, audio(800, 4));
  assert.ok(replay.getDeckTimings()[1].transportRevision > second.transportRevision);
  assert.equal(timeline.tick(out.decks[1], replay.getDeckTimings()[1], 10800, config).frames, null);
  replay.tick(true, .1, audio(900, 5));
  assert.deepEqual(replay.getTrackOffsets(), {});
});

test('parser rejects corrupt interior JSON, invalid typed diffs, backwards v2 times and mismatched counts with line numbers', async t => {
  const { dir } = await setup(t);
  for (const [rows, match] of [
    [[header(), keyframe(), '{bad}', { t: 10, type: 'selected', deck: 1 }], /line 3/i],
    [[header(), keyframe(), { t: 10, type: 'deck', n: 1, diff: { elapsedSec: 'NaN' } }], /line 3: invalid deck elapsedSec/i],
    [[header(), keyframe(), { t: 10, type: 'deck', n: 1, diff: { play: 1 } }], /line 3: invalid deck play/i],
    [[header(), keyframe(10), { t: 5, type: 'selected', deck: 1 }], /line 3:.*backwards/i],
    [[header(), keyframe(), { t: 10, type: 'footer', stoppedAt: 10, eventCount: 999 }], /line 3:.*count mismatch/i],
    [[header(), keyframe(), { t: 10, type: 'selected', deck: 9 }], /line 3: invalid selected/i],
  ]) await assert.rejects(parseRecording(await logFile(dir, rows)), match);
});

test('only a torn final JSON line is recoverable; optional future events are deliberately supported', async t => {
  const { dir } = await setup(t);
  const p = await logFile(dir, [header(), keyframe(), { t: 10, type: 'future', optional: true, extension: {} }]);
  const prefix = await fs.promises.readFile(p);
  await fs.promises.appendFile(p, '{"type":"deck"');
  const recovered = await parseRecording(p);
  assert.equal(recovered.truncateTo, prefix.length);
  assert.equal(recovered.eventCount, 3);
  await fs.promises.writeFile(p, prefix.toString() + JSON.stringify({ t: 20, type: 'deck', n: 1, diff: { play: 'false' } }));
  await assert.rejects(parseRecording(p), /line 4: invalid deck play/i);
});

test('duplicate mappings share one parsed log and backward seeks use bounded checkpoints', async t => {
  const { dir } = await setup(t);
  const rows = [header(), keyframe(), ...Array.from({ length: 6000 }, (_, i) => ({ t: i + 1, type: 'deck', n: 1, diff: { elapsedSec: (i + 1) / 1000 }, timing: source(i + 1, i + 2) })), { t: 10000, type: 'footer', stoppedAt: 11000 }];
  await logFile(dir, rows);
  const original = fs.createReadStream;
  let reads = 0;
  t.mock.method(fs, 'createReadStream', (...args) => { reads++; return original(...args); });
  const replay = new Replay({ recordingsDir: dir });
  await replay.arm([{ audio_file: 'a.wav', log_file: 'show.jsonl' }, { audio_file: 'b.wav', log_file: 'show.jsonl' }]);
  assert.equal(reads, 1);
  assert.equal(replay.mappings[0].parsed, replay.mappings[1].parsed);
  replay.onTrackChanged(1, 'a.wav');
  const events = replay.mappings[0].parsed.deckEvents;
  let indexedReads = 0;
  replay.mappings[0].parsed.deckEvents = new Proxy(events, { get(target, prop) { if (/^\d+$/.test(String(prop))) indexedReads++; return Reflect.get(target, prop); } });
  assert.equal(replay.tick(true, 6, audio(6000, 1)).decks[1].elapsedSec, 6);
  assert.ok(indexedReads < 2100, 'initial forward seek must not replay the full 6000-event prefix');
  indexedReads = 0;
  assert.equal(replay.tick(true, 5.5, audio(6100, 2)).decks[1].elapsedSec, 5.5);
  assert.ok(indexedReads < 2100, 'seek must not replay the full 5500-event prefix');
});

class SlowFile extends Writable {
  lines = [];
  callbacks = [];
  constructor() { super({ highWaterMark: 1 }); process.nextTick(() => this.emit('open')); }
  _write(chunk, _encoding, callback) { this.lines.push(chunk.toString()); this.callbacks.push(callback); }
  async releaseAll() {
    for (let i = 0; i < 300; i++) {
      this.callbacks.shift()?.();
      await nextTurn();
      if (!this.callbacks.length) return;
    }
    throw new Error('writer did not drain');
  }
}

test('slow storage preserves accepted event order and drains before writing completion metadata', async t => {
  const { recorder, dir } = await setup(t);
  let slow;
  const originalWriteStream = fs.createWriteStream;
  t.mock.method(fs, 'createWriteStream', (...args) => String(args[0]).endsWith('.jsonl') ? (slow = new SlowFile()) : originalWriteStream(...args));
  const started = await recorder.start();
  recorder.recordSelected(2); recorder.recordSelected(4);
  const stopping = recorder.stop();
  assert.equal(fs.existsSync(path.join(dir, started.file.replace('.jsonl', '.meta.json'))), false);
  await nextTurn(); await slow.releaseAll();
  assert.equal((await stopping).ok, true);
  const rows = slow.lines.join('').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.filter(r => r.type === 'selected').map(r => r.deck), [null, 2, 4]);
  assert.equal(rows.at(-1).type, 'footer');
  assert.equal(rows.at(-1).eventCount, rows.length);
  assert.equal(fs.existsSync(path.join(dir, started.file.replace('.jsonl', '.meta.json'))), true);
});

test('backpressure overflow stops visibly and retains the valid accepted prefix without a success sidecar', async t => {
  const { recorder, dir, decks, timings, listeners } = await setup(t);
  let slow;
  const originalWriteStream = fs.createWriteStream;
  t.mock.method(fs, 'createWriteStream', (...args) => String(args[0]).endsWith('.jsonl') ? (slow = new SlowFile()) : originalWriteStream(...args));
  const started = await recorder.start();
  for (let i = 0; i < 100 && recorder.isActive(); i++) {
    const state = { ...decks[1], title: String(i) + 'x'.repeat(100000) };
    for (const listener of listeners) listener(1, state, timings[1]);
  }
  assert.equal(recorder.isActive(), false);
  assert.match(recorder.getStatus().error, /storage backlog/);
  const accepted = recorder.getStatus().eventCount;
  const stopping = recorder.stop();
  const rejected = assert.rejects(stopping, /storage backlog/);
  await nextTurn(); await slow.releaseAll(); await rejected;
  assert.equal(slow.lines.length, accepted);
  assert.ok(Buffer.byteLength(slow.lines.join('')) <= 8 * 1024 * 1024);
  assert.equal(fs.existsSync(path.join(dir, started.file.replace('.jsonl', '.meta.json'))), false);
  assert.equal(fs.existsSync(path.join(dir, '.active-recording')), true);
});

test('v2 orphan resume clamps negative wall-clock gap and retains monotonic ordering', async t => {
  let mono = 1000;
  const { recorder, dir } = await setup(t, { monotonicNowMs: () => ++mono, wallNowMs: () => 1 });
  await logFile(dir, [header(), keyframe(), { t: 100, type: 'deck', n: 1, diff: {}, timing: source(100, 2) }], 'orphan.jsonl');
  await fs.promises.writeFile(path.join(dir, '.active-recording'), 'orphan.jsonl');
  assert.equal(await recorder.prepareResumeFromOrphan(), true);
  assert.equal((await recorder.finalizeResume()).gapMs, 0);
  await recorder.stop();
  const parsed = await parseRecording(path.join(dir, 'orphan.jsonl'));
  assert.ok(parsed.durationMs >= 100);
  assert.equal(parsed.gaps[0].gapMs, 0);
});

test('complete orphan footer recreates missing metadata before clearing its recovery lock', async t => {
  const { recorder, dir } = await setup(t);
  await logFile(dir, [header(), keyframe(), { t: 100, type: 'footer', stoppedAt: 9000, eventCount: 3 }], 'complete.jsonl');
  await fs.promises.writeFile(path.join(dir, '.active-recording'), 'complete.jsonl');
  assert.equal(await recorder.prepareResumeFromOrphan(), false);
  const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'complete.meta.json'), 'utf8'));
  assert.equal(meta.durationMs, 100);
  assert.equal(meta.eventCount, 3);
  assert.equal(meta.file, 'complete.jsonl');
  assert.equal(fs.existsSync(path.join(dir, '.active-recording')), false);
});

test('corrupt interior recovery stays visibly blocked until explicitly discarded, preserving its log and lock', async t => {
  const { recorder, dir } = await setup(t);
  const p = await logFile(dir, [header(), keyframe(), '{broken}', { t: 50, type: 'selected', deck: 1 }], 'corrupt.jsonl');
  const before = await fs.promises.readFile(p, 'utf8');
  await fs.promises.writeFile(path.join(dir, '.active-recording'), 'corrupt.jsonl');
  assert.equal(await recorder.prepareResumeFromOrphan(), false);
  assert.equal(recorder.isBusy(), true);
  assert.equal(recorder.hasPendingResume(), true);
  assert.match(recorder.getStatus().error, /line 3/);
  assert.equal((await recorder.start()).ok, false);
  assert.equal(await fs.promises.readFile(path.join(dir, '.active-recording'), 'utf8'), 'corrupt.jsonl');
  await recorder.abortPendingResume();
  assert.equal(recorder.isBusy(), false);
  assert.equal(await fs.promises.readFile(p, 'utf8'), before);
  assert.equal((await recorder.start()).ok, true);
});

test('explicit play state is retained when a replay starts within a recorded watchdog interval', async t => {
  const { dir } = await setup(t);
  const first = keyframe();
  first.state.play = false;
  first.timing.transportPlay = true;
  await logFile(dir, [header(), first, { t: 1000, type: 'footer', stoppedAt: 2000 }]);
  const replay = new Replay({ recordingsDir: dir });
  await replay.arm([{ audio_file: 'backup.wav', log_file: 'show.jsonl' }]);
  replay.onTrackChanged(1, 'backup.wav');
  const out = replay.tick(true, .1, audio(100, 1));
  assert.equal(out.decks[1].play, false);
  assert.equal(replay.getDeckTimings()[1].transportPlay, true);
  const options = { fps: 30, staleThresholdMs: 250, reconnecting: false, enableFreewheeling: true, freewheelMaxDurationSec: 30 };
  const timeline = new TimecodeTimeline();
  timeline.tick(out.decks[1], replay.getDeckTimings()[1], 10100, options);
  assert.notEqual(timeline.tick(out.decks[1], replay.getDeckTimings()[1], 10133, options).frames, null);
});
