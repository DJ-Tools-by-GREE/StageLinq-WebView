import assert from 'node:assert/strict';
import test from 'node:test';
import { TimecodeTimeline, monotonicNowMs } from '../dist/timecodeTimeline.js';

const options = { fps: 30, staleThresholdMs: 250, reconnecting: false, enableFreewheeling: true, freewheelMaxDurationSec: 30 };
const deck = (elapsedSec = 10, changes = {}) => ({ deck: 1, fileName: 'track.mp3', elapsedSec, totalSec: 600, speedState: 0, play: true, ...changes });
const timing = (positionAtMs = 1000, positionRevision = 1, changes = {}) => ({ positionAtMs, positionRevision, transportRevision: 1, trackId: 'net://device/source/track.mp3', ...changes });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, actual + ' differs from ' + expected);

test('200ms BeatInfo cadence does not send backward frames between samples', () => {
  const engine = new TimecodeTimeline();
  let state = deck();
  let source = timing();
  let previous = null;
  for (let elapsed = 0; elapsed <= 2000; elapsed += 20) {
    if (elapsed % 200 === 0) {
      state = deck(10 + elapsed / 1000);
      source = timing(1000 + elapsed, elapsed / 200 + 1);
    }
    const result = engine.tick(state, source, 1000 + elapsed, options);
    assert.equal(result.stale, false);
    if (result.frames !== null) {
      close(result.frames, (10 + elapsed / 1000) * 30);
      if (previous !== null) assert.ok(result.frames >= previous);
      previous = result.frames;
    }
  }
});

test('metadata, synthetic play=false and old queued positions do not refresh the heartbeat', () => {
  const engine = new TimecodeTimeline();
  engine.tick(deck(), timing(), 1000, options);
  const result = engine.tick(deck(10, { play: false, artist: 'New metadata' }), timing(), 1400, options);
  assert.equal(result.stale, true);
  assert.equal(result.freewheelActive, true);
  close(result.frames, 312);
  const queued = engine.tick(deck(10.1), timing(1100, 2), 1600, options);
  assert.equal(queued.stale, true);
  close(queued.frames, 318);
});

test('fresh samples are extrapolated from capture time when delivered late', () => {
  const engine = new TimecodeTimeline();
  engine.tick(deck(), timing(), 1000, options);
  const result = engine.tick(deck(10.1), timing(1100, 2), 1200, options);
  close(result.frames, 306);
  assert.equal(result.corrected, false);
});

test('old queued samples cannot replace a newer position for the same track', () => {
  const engine = new TimecodeTimeline();
  engine.tick(deck(20), timing(2000, 20), 2000, options);
  const result = engine.tick(deck(10), timing(1000, 10), 2100, options);
  assert.equal(result.source.elapsedSec, 20);
  close(result.frames, 603);
});

test('freewheel holds a reliable source through reset metadata until a new position arrives', () => {
  const engine = new TimecodeTimeline();
  engine.tick(deck(), timing(), 1000, options);
  const reset = timing(null, 2, { trackId: '' });
  const reconnect = engine.tick(deck(0, { play: false, fileName: '', totalSec: 0 }), reset, 1400, { ...options, reconnecting: true });
  assert.equal(reconnect.freewheelActive, true);
  assert.equal(reconnect.source.fileName, 'track.mp3');
  close(reconnect.frames, 312);
  const waiting = engine.tick(deck(0, { play: false }), reset, 1500, options);
  assert.equal(waiting.freewheelActive, true);
  close(waiting.frames, 315);
  const resumed = engine.tick(deck(10.6), timing(1600, 3), 1600, options);
  assert.equal(resumed.freewheelActive, false);
  close(resumed.frames, 318);
});

test('explicit transport pause stops output during a dropout and resume follows a fresh position', () => {
  const engine = new TimecodeTimeline();
  engine.tick(deck(), timing(), 1000, options);
  const pause = timing(1000, 1, { transportRevision: 2 });
  const paused = engine.tick(deck(10, { play: false }), pause, 1400, options);
  assert.equal(paused.frames, null);
  assert.equal(paused.freewheelActive, false);
  const resume = timing(1600, 2, { transportRevision: 3 });
  assert.equal(engine.tick(deck(10.1), resume, 1600, options).frames, null);
  close(engine.tick(deck(10.1), resume, 1700, options).frames, 306);
});

test('fresh backwards seek, short loop, and same-basename track replacement follow the source', () => {
  const engine = new TimecodeTimeline();
  engine.tick(deck(20), timing(), 1000, options);
  const seek = engine.tick(deck(5), timing(1100, 2), 1100, options);
  close(seek.frames, 150);
  assert.equal(seek.corrected, true);
  const loop = engine.tick(deck(4.95), timing(1200, 3), 1200, options);
  close(loop.frames, 148.5);
  assert.equal(loop.corrected, true);
  const replacement = engine.tick(deck(30), timing(1300, 3, { trackId: 'net://device/other/track.mp3' }), 1300, options);
  close(replacement.frames, 900);
  assert.equal(replacement.corrected, true);
});

test('freewheel controls retain silence when disabled or expired and recover on a fresh source', () => {
  const engine = new TimecodeTimeline();
  const opts = { ...options, freewheelMaxDurationSec: 0.5 };
  engine.tick(deck(), timing(), 1000, opts);
  assert.equal(engine.tick(deck(), timing(), 1300, opts).freewheelActive, true);
  const expired = engine.tick(deck(), timing(), 1810, opts);
  assert.equal(expired.frames, null);
  assert.equal(expired.expired, true);
  assert.equal(expired.freewheelActive, false);
  assert.equal(engine.tick(deck(11), timing(2000, 2), 2000, opts).frames, null);
  close(engine.tick(deck(11), timing(2000, 2), 2100, opts).frames, 333);
  const disabled = engine.tick(deck(11), timing(2000, 2), 2300, { ...opts, enableFreewheeling: false });
  assert.equal(disabled.frames, null);
  assert.equal(disabled.freewheelActive, false);
});

test('resetting selection cannot start output from an already stale cached deck', () => {
  const engine = new TimecodeTimeline();
  engine.tick(deck(), timing(), 1000, options);
  engine.reset();
  const result = engine.tick(deck(), timing(), 1400, options);
  assert.equal(result.frames, null);
  assert.equal(result.freewheelActive, false);
});

test('pitch affects extrapolation and wall-clock jumps do not affect the source clock', () => {
  const engine = new TimecodeTimeline();
  const state = deck(10, { speedState: 10 });
  engine.tick(state, timing(), 1000, options);
  close(engine.tick(state, timing(), 1200, options).frames, 306.6);
  const original = Date.now;
  const before = monotonicNowMs();
  Date.now = () => original() + 60_000;
  try { assert.ok(Math.abs(monotonicNowMs() - before) < 1000); }
  finally { Date.now = original; }
});

test('explicit unload during incomplete reconnect stops the retained timeline', () => {
  const engine = new TimecodeTimeline();
  engine.tick(deck(), timing(), 1000, options);
  const unloaded = engine.tick(deck(0, { play: false, trackLoaded: false }), timing(null, 2, { transportRevision: 2, trackId: '' }), 1400, { ...options, reconnecting: true });
  assert.equal(unloaded.frames, null);
  assert.equal(unloaded.freewheelActive, false);
});

test('path metadata before its first sample keeps the old source identity and offset key', () => {
  const engine = new TimecodeTimeline();
  engine.tick(deck(), timing(), 1000, options);
  const metadata = engine.tick(deck(0, { fileName: 'new.mp3', totalSec: 0 }), timing(), 1100, options);
  assert.equal(metadata.source.fileName, 'track.mp3');
  assert.equal(metadata.source.elapsedSec, 10);
  close(metadata.frames, 303);
});

test('zero freewheel duration emits no synthetic frame at stale onset', () => {
  const engine = new TimecodeTimeline();
  engine.tick(deck(), timing(), 1000, options);
  const result = engine.tick(deck(), timing(), 1300, { ...options, freewheelMaxDurationSec: 0 });
  assert.equal(result.frames, null);
  assert.equal(result.expired, true);
  assert.equal(result.freewheelActive, false);
});

test('a fresh position recovers from watchdog stop without requiring another transport event', () => {
  const engine = new TimecodeTimeline();
  engine.tick(deck(), timing(), 1000, options);
  engine.tick(deck(10, { play: false }), timing(), 1400, options);
  const resumed = engine.tick(deck(10.6, { play: false }), timing(1600, 2), 1600, options);
  close(resumed.frames, 318);
  assert.equal(resumed.freewheelActive, false);
});
