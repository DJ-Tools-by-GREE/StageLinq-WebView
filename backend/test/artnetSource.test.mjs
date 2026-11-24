import test from 'node:test';
import assert from 'node:assert/strict';
import { makeArtNetSourceSync } from '../dist/artnetSource.js';

test('disarm atomically restores all live states, source timing and offsets without a later bridge event', () => {
  const replayOffsets = { 'recorded.mp3': { offsetSec: 100, offsetFrame: 0 } };
  const liveOffsets = { 'live.mp3': { offsetSec: 200, offsetFrame: 0 } };
  let offsets = replayOffsets;
  let decks = { 1: { play: true, fileName: 'recorded.mp3', elapsedSec: 10 } };
  let timings = { 1: { positionAtMs: 1, positionRevision: 1, transportRevision: 1, trackId: 'replay:1' } };
  const sent = [];
  const sync = makeArtNetSourceSync({ getReplayOffsets: () => offsets, getLiveOffsets: () => liveOffsets,
    getDecks: () => decks, getDeckTimings: () => timings,
    setSource: (states, sourceTimes, map) => sent.push({ states, sourceTimes, map }),
  });
  assert.equal(sync(), true);
  assert.equal(sync(), false);
  offsets = null;
  decks = { 1: { play: false, fileName: null, elapsedSec: 0 } };
  timings = { 1: { positionAtMs: null, positionRevision: 2, transportRevision: 2, trackId: '' } };
  assert.equal(sync(), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].states, decks);
  assert.equal(sent[1].sourceTimes, timings);
  assert.equal(sent[1].map, liveOffsets);
  assert.equal(sync(), false);
});

test('activation during provider sampling uses the resulting recording offsets in the same switch', () => {
  let offsets = null;
  const recorded = {};
  const calls = [];
  const sync = makeArtNetSourceSync({ getReplayOffsets: () => offsets,
    getLiveOffsets: () => ({live:{offsetSec:20,offsetFrame:0}}),
    getDecks: () => { offsets = recorded; return {}; }, getDeckTimings: () => ({}),
    setSource: (decks, timing, map) => calls.push(map),
  });
  sync();
  assert.equal(calls[0], recorded);
});
