import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { StageLinqBridge } from '../dist/stagelinqBridge.js';
import { applyLoggingConfig } from '../dist/logging.js';
applyLoggingConfig({ errors: false, lifecycle: false, waveform: false });
const path = name => 'net://12345678-1234-1234-1234-123456789abc/USB/' + name;
const settle = () => new Promise(resolve => setImmediate(resolve));

test('queued abort settles promptly without allowing another transfer ahead of active cleanup', async t => {
  const bridge = new StageLinqBridge();
  t.after(() => bridge.stageLinqDevices.disconnectAll());
  const service = new EventEmitter(); let release; const started = [];
  service.getFile = async (file, signal, maxBytes) => {
    started.push(file); assert.equal(maxBytes, 256 * 1024 * 1024);
    if (started.length === 1) await new Promise(resolve => { release = resolve; });
    signal.throwIfAborted(); return new Uint8Array([42]);
  };
  bridge.stageLinqDevices.getFileTransferService = () => service;
  const firstAbort = new AbortController(), queuedAbort = new AbortController();
  const first = bridge.downloadFile(path('A'), () => {}, firstAbort.signal);
  const queued = bridge.downloadFile(path('B'), () => {}, queuedAbort.signal);
  const firstRejected = assert.rejects(first, /aborted/), queuedRejected = assert.rejects(queued, /aborted/);
  await settle(); firstAbort.abort(); queuedAbort.abort();
  await firstRejected; await queuedRejected;
  const last = bridge.downloadFile(path('C'), () => {});
  await settle(); assert.equal(started.length, 1);
  release(); assert.deepEqual(await last, new Uint8Array([42])); await settle();
  assert.deepEqual(started, ['/USB/A', '/USB/C']);
  assert.equal(service.listenerCount('fileTransferProgress'), 0);
  assert.equal(bridge.downloadQueues.size, 0);
});

test('reset aborts service polling and prevents obsolete queued work from reaching the next session', async t => {
  const bridge = new StageLinqBridge();
  t.after(() => bridge.stageLinqDevices.disconnectAll());
  bridge.stageLinqDevices.getFileTransferService = () => null;
  const old = bridge.downloadFile(path('old'), () => {});
  const rejected = assert.rejects(old, /session ended/);
  await settle(); bridge.resetState(); await rejected;
  const service = new EventEmitter();
  service.getFile = async () => new Uint8Array([9]);
  bridge.stageLinqDevices.getFileTransferService = () => service;
  assert.deepEqual(await bridge.downloadFile(path('new'), () => {}), new Uint8Array([9]));
  await settle(); assert.equal(bridge.downloadQueues.size, 0);
});
