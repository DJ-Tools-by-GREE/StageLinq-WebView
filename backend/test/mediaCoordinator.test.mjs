import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaCoordinator } from '../dist/mediaCoordinator.js';
import { applyLoggingConfig } from '../dist/logging.js';
applyLoggingConfig({ errors: false });
const settle = () => new Promise(resolve => setImmediate(resolve));
const decks = ids => Object.fromEntries([1, 2, 3, 4].map((deck, i) => [deck, {
  deck, mediaId: ids[i] ?? '', fileName: 'same.mp3', totalSec: 1, trackLoaded: !!ids[i],
}]));

test('media pipeline bounds downloads, deduplicates identities and removes obsolete queued tracks', async () => {
  const downloads = [], frames = [], statuses = [];
  const service = {
    setActiveMediaTracks() {},
    loadCachedMedia: async () => ({ peaksFrame: null, artworkFrame: null }),
    requestExtraction: async id => ({ peaksFrame: 'peaks:' + id, artworkFrame: 'art:' + id }),
  };
  const coordinator = new MediaCoordinator({
    eligible: () => true, frame: value => frames.push(value), status: (...args) => statuses.push(args),
    download(id, progress, signal) {
      return new Promise((resolve, reject) => {
        downloads.push({ id, resolve });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  }, service);
  coordinator.update(decks(['A', 'A', 'B', 'C'])); await settle();
  assert.deepEqual(downloads.map(d => d.id), ['A', 'B']);
  assert.deepEqual(statuses.filter(s => s[1] === 'A').map(s => s[0]), [1, 2]);
  coordinator.update(decks(['A', 'A', 'D'])); await settle();
  assert.deepEqual(downloads.map(d => d.id), ['A', 'B', 'D']);
  downloads[0].resolve(new Uint8Array(1)); downloads[2].resolve(new Uint8Array(1)); await settle();
  assert.deepEqual(frames.sort(), ['art:A', 'art:D', 'peaks:A', 'peaks:D']);
  assert.equal(downloads.some(d => d.id === 'C'), false);
  await coordinator.shutdown();
});

test('obsolete cache reads and shutdown cannot publish stale media or launch more downloads', async () => {
  let resolveCache; const frames = []; let downloads = 0;
  const service = {
    setActiveMediaTracks() {},
    loadCachedMedia: () => new Promise(resolve => { resolveCache = resolve; }),
    requestExtraction: async () => { throw new Error('unexpected extraction'); },
  };
  const coordinator = new MediaCoordinator({ eligible: () => true, frame: frame => frames.push(frame),
    status() {}, download: async () => { downloads++; return new Uint8Array(); },
  }, service);
  coordinator.update(decks(['A'])); await settle();
  const stopped = coordinator.shutdown();
  resolveCache({ peaksFrame: 'wrong track', artworkFrame: 'wrong art' });
  await stopped;
  coordinator.update(decks(['B']));
  assert.deepEqual(frames, []); assert.equal(downloads, 0);
});

test('replay lazily loads historical cache identities without downloading historical tracks', async () => {
  const frames = [], loaded = []; let downloads = 0;
  const service = {
    setActiveMediaTracks() {},
    loadCachedMedia: async id => { loaded.push(id); return { peaksFrame: id === 'saved' ? 'saved peaks' : null, artworkFrame: null }; },
    requestExtraction: async () => { throw new Error('unexpected extraction'); },
  };
  const coordinator = new MediaCoordinator({ eligible: () => true, frame: frame => frames.push(frame), status() {},
    download: async () => { downloads++; return new Uint8Array(); },
  }, service);
  coordinator.update(decks([]), decks(['saved', 'missing'])); await settle();
  assert.deepEqual(loaded, ['saved', 'missing']); assert.deepEqual(frames, ['saved peaks']); assert.equal(downloads, 0);
  await coordinator.shutdown();
});
