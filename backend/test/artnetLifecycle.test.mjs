import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function harness(outcome) {
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor() { super(); workers.push(this); this.terminated = false; }
    postMessage(message) {
      queueMicrotask(() => {
        if (message.type === 'shutdown') this.emit('exit', 0);
        else if (message.type === 'init') {
          if (outcome === 'ready') this.emit('message', { type: 'ready' });
          if (outcome === 'failure') this.emit('message', { type: 'initError', message: 'bind failed' });
          if (outcome === 'exit') this.emit('exit', 0);
          if (outcome === 'error') this.emit('error', new Error('worker crashed'));
        }
      });
    }
    async terminate() { this.terminated = true; this.emit('exit', 0); return 0; }
  }
  let source = fs.readFileSync(new URL('../dist/artnetTimecode.js', import.meta.url), 'utf8');
  source = source.replace(/^import[\s\S]*?;$/gm, '').replaceAll('import.meta.url', "'file:///test/artnetTimecode.js'").replace('export class ', 'class ');
  source += '\nglobalThis.Broadcaster = ArtNetTimecodeBroadcaster;';
  const noop = () => {};
  const context = vm.createContext({ Worker: FakeWorker, URL, setTimeout, clearTimeout, ARTNET_WORKER_READY_TIMEOUT_MS: 15, logError: noop, logWarn: noop, logLifecycle: noop, logStatus: noop, setArtnetTcHms: noop, LOG_ENABLED: {}, GRN: '', RST: '' });
  vm.runInContext(source, context);
  return { broadcaster: new context.Broadcaster({ enabled: true, targetIps: [], port: 6454, fps: 30, fpsType: 3, deck: 1, freewheelStaleThresholdMs: 250 }), workers };
}

for (const [outcome, error] of [['failure', /bind failed/], ['exit', /before ready/], ['error', /worker crashed/], ['timeout', /readiness timed out/]]) {
  test('Art-Net startup rejects and cleans up on ' + outcome, async () => {
    const { broadcaster, workers } = harness(outcome);
    await assert.rejects(broadcaster.start(), error);
    assert.equal(workers[0].terminated, true);
    assert.equal(broadcaster.worker, null);
    assert.equal(workers[0].listenerCount('message'), 1);
  });
}

test('Art-Net ready starts normally and stop clears the freewheel indicator', async () => {
  const { broadcaster } = harness('ready');
  await broadcaster.start();
  broadcaster.handleWorkerMessage({ type: 'freewheelState', active: true });
  assert.equal(broadcaster.isFreewheelActive(), true);
  await broadcaster.stop();
  assert.equal(broadcaster.worker, null);
  assert.equal(broadcaster.isFreewheelActive(), false);
});

test('worker freshness follows the selected deck even while another deck or metadata updates', async () => {
  const { TimecodeTimeline } = await import('../dist/timecodeTimeline.js');
  const constants = await import('../dist/constants.js');
  const path = await import('node:path');
  let now = 1000;
  const messages = [];
  const port = new EventEmitter();
  port.postMessage = (message) => messages.push(message);
  const socket = new EventEmitter();
  socket.close = () => {};
  socket.send = (_packet, _offset, _length, _port, _ip, callback) => callback(null);
  let source = fs.readFileSync(new URL('../dist/artnetWorker.js', import.meta.url), 'utf8');
  source = source.replace(/^import.*$/gm, '');
  source += '\nglobalThis.auditedWorker = worker;';
  const noop = () => {};
  const context = vm.createContext({ parentPort: port, dgram: { createSocket: () => socket }, path: path.default, Buffer, TimecodeTimeline, monotonicNowMs: () => now, ...constants, setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop });
  vm.runInContext(source, context);
  const worker = context.auditedWorker;
  worker.opts = { enabled: true, fps: 30, sendHz: 30, fpsType: 3, latencyCompMs: 0, targetIps: [], port: 6454, streamId: 0 };
  worker.targetIntervalMs = 1000 / 30;
  worker.nextDeadlineMs = now;
  worker.setSelectedDeck(1);
  const state = { deck: 1, fileName: 'selected.mp3', elapsedSec: 10, totalSec: 100, play: true, speedState: 0 };
  const timing = { positionAtMs: now, positionRevision: 1, transportRevision: 1, trackId: 'selected' };
  worker.pushDeckState(1, state, timing);
  worker.tick();
  now = 1400;
  worker.pushDeckState(2, { ...state, deck: 2 }, { ...timing, positionAtMs: now, trackId: 'other' });
  worker.pushDeckState(1, { ...state, artist: 'metadata' }, timing);
  worker.tick();
  assert.ok(messages.some((m) => m.type === 'freewheelState' && m.active));
  now = 1600;
  worker.pushDeckState(1, { ...state, elapsedSec: 10.05 }, { ...timing, positionAtMs: 1050, positionRevision: 2 });
  worker.tick();
  assert.equal(messages.filter((m) => m.type === 'freewheelState').at(-1).active, true);
  now = 1700;
  worker.pushDeckState(1, { ...state, elapsedSec: 10.7 }, { ...timing, positionAtMs: now, positionRevision: 3 });
  worker.tick();
  assert.equal(messages.filter((m) => m.type === 'freewheelState').at(-1).active, false);
  // Disarm into an unloaded live source; no later bridge event is needed to clear replay.
  const blankDecks = Object.fromEntries([1, 2, 3, 4].map((n) => [n, { ...state, deck: n, elapsedSec: 0, play: false, fileName: '' }]));
  const blankTiming = Object.fromEntries([1, 2, 3, 4].map((n) => [n, { ...timing, positionAtMs: null, trackId: '' }]));
  worker.setSource(blankDecks, blankTiming, { 'live.mp3': { offsetSec: 20, offsetFrame: 0 } });
  now = 2100;
  worker.tick();
  assert.equal(worker.timeline.source, null);
  assert.equal(worker.freewheelActiveEmitted, false);
  assert.equal(worker.trackOffsets['live.mp3'].offsetSec, 20);
  assert.equal(worker.decks[1].play, false);
  worker.shutdown();
});
