import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeVideoHelper } from '../dist/videoHelper.js';
import { parseVideoConfig } from '../dist/videoConfig.js';
import { monotonicNowMs } from '../dist/timecodeTimeline.js';
import { VIDEO_HELPER_CLOCK_SAMPLES, VIDEO_HELPER_MAX_LINE_BYTES, VIDEO_HELPER_MAX_PENDING_BYTES } from '../dist/constants.js';

async function mockMain(options) {
  const { createInterface } = await import('node:readline');
  const { appendFileSync } = await import('node:fs');
  const hostNow = () => 50000 + performance.now() / 1000;
  const record = message => appendFileSync(options.log, JSON.stringify(message) + '\n');
  const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
  let pings = 0;
  if (options.mode === 'ignoreShutdown') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  }
  const lines = createInterface({ input: process.stdin });
  emit({ type: 'ready', protocol: 1, testMode: options.mode === 'testMode' });
  lines.on('line', line => {
    const message = JSON.parse(line);
    record({ ...message, observedHostTimeSec: hostNow() });
    if (message.type === 'configure') {
      if (options.mode === 'configurationError') return emit({ type: 'error', error: 'NDI runtime is unavailable' });
      if (options.mode === 'earlyExit') return process.exit(17);
      if (options.mode === 'fragmented') {
        const bytes = Buffer.from(JSON.stringify({ type: 'configured', protocol: 1 }) + '\n');
        process.stdout.write(bytes.subarray(0, 7));
        setImmediate(() => process.stdout.write(bytes.subarray(7)));
      } else emit({ type: 'configured', protocol: 1 });
    } else if (message.type === 'ping') {
      pings++;
      if (options.mode === 'missingPong') return;
      emit({ type: 'pong', id: message.id, hostTimeSec: hostNow() });
      if (options.mode === 'backpressure' && pings === options.clockSamples) {
        process.stdin.pause();
        setTimeout(() => process.stdin.resume(), 150);
      }
    } else if (message.type === 'state') {
      if (options.mode === 'crash') { process.stderr.write('simulated decoder crash'); return process.exit(17); }
      if (options.mode === 'oversizeOutput') return process.stdout.write('x'.repeat(options.maxLineBytes + 1));
      if (options.mode === 'malformedStatus') return emit({ type: 'status', deck: 1, state: 'playing', width: 'wrong type' });
      const state = message.decks[0];
      const response = { type: 'status', deck: state.deck, generation: state.generation, state: 'playing', width: 1920, height: 1080, fps: 30 };
      if (options.mode === 'fragmented') {
        response.error = '日本 🎵';
        const bytes = Buffer.from(JSON.stringify(response) + '\n');
        const cut = bytes.indexOf(Buffer.from('🎵')) + 2;
        process.stdout.write(bytes.subarray(0, cut));
        setImmediate(() => process.stdout.write(bytes.subarray(cut)));
      } else emit(response);
    } else if (message.type === 'shutdown' && options.mode !== 'ignoreShutdown') {
      process.exit(0);
    }
  });
}

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function fixture(t, mode = 'normal') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slwv-video-helper-'));
  const executable = path.join(directory, 'mock-helper.mjs');
  const log = path.join(directory, 'commands.jsonl');
  const options = { mode, log, clockSamples: VIDEO_HELPER_CLOCK_SAMPLES, maxLineBytes: VIDEO_HELPER_MAX_LINE_BYTES };
  await fs.writeFile(executable, '#!' + process.execPath + '\n(' + mockMain.toString() + ')(' + JSON.stringify(options) + ');\n', { mode: 0o755 });
  const statuses = [];
  const errors = [];
  const helper = new NativeVideoHelper({ status: status => statuses.push(status), error: error => errors.push(error) }, executable);
  t.after(async () => { await helper.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  const config = parseVideoConfig({ enabled: true, directory, ndi_name_prefix: 'Regression', output_format: 'source' });
  const records = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { helper, config, statuses, errors, records, directory };
}

const commands = generation => [1, 2, 3, 4].map(deck => ({ deck, generation: String(generation), path: '/videos/Song (Music Video).mp4', positionSec: deck * 10, rate: 1.04, playing: true }));

test('helper negotiates four sources and maps Node clock anchors to a distinct native host clock', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.helper.start(f.config);
  f.helper.send(commands('live-1'), monotonicNowMs());
  await waitFor(() => f.statuses.length === 1, 'native status not received');
  await f.helper.stop();
  const records = await f.records();
  const configure = records.find(record => record.type === 'configure');
  assert.equal(configure.protocol, 1);
  assert.deepEqual(configure.sourceNames, [1, 2, 3, 4].map(n => 'Regression Deck ' + n));
  assert.equal(configure.outputFormat, 'source');
  assert.equal(records.filter(record => record.type === 'ping').length, VIDEO_HELPER_CLOCK_SAMPLES);
  const state = records.find(record => record.type === 'state');
  assert.deepEqual(state.decks, commands('live-1'));
  assert.ok(Math.abs(state.observedHostTimeSec - state.hostTimeSec) < 0.25, 'native anchor must use negotiated clock offset');
  assert.equal(f.statuses[0].generation, 'live-1');
  assert.equal(records.at(-1).type, 'shutdown');
  assert.deepEqual(f.errors, []);
});

test('helper parses split JSON lines and split multibyte UTF-8 status text', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'fragmented');
  await f.helper.start(f.config);
  f.helper.send(commands('unicode'), monotonicNowMs());
  await waitFor(() => f.statuses.length === 1, 'fragmented status not received');
  assert.equal(f.statuses[0].error, '日本 🎵');
  assert.deepEqual(f.errors, []);
});

test('helper coalesces congested state updates and eventually delivers the latest deck positions', { timeout: 7000 }, async t => {
  const f = await fixture(t, 'backpressure');
  await f.helper.start(f.config);
  const count = 1000;
  for (let i = 0; i < count; i++) {
    const next = commands(i).map(command => ({ ...command, path: '/video/' + 'a'.repeat(4096) + '.mp4', positionSec: i }));
    f.helper.send(next, monotonicNowMs());
  }
  await waitFor(() => f.statuses.some(status => status.generation === String(count - 1)), 'latest coalesced state was not delivered');
  const states = (await f.records()).filter(record => record.type === 'state');
  assert.ok(states.length < count / 2, 'congestion must not retain every outdated state');
  assert.equal(states.at(-1).decks[0].positionSec, count - 1);
  assert.ok(states.every((state, i) => i === 0 || state.seq > states[i - 1].seq));
  assert.deepEqual(f.errors, []);
});

test('helper rejects startup errors, early exits and missing clock replies', { timeout: 7000 }, async t => {
  for (const [mode, error] of [['configurationError', /NDI runtime is unavailable/], ['earlyExit', /exited unexpectedly|closed/], ['missingPong', /clock synchronization timed out/], ['testMode', /test mode/]]) {
    await t.test(mode, async t => {
      const f = await fixture(t, mode);
      await assert.rejects(f.helper.start(f.config), error);
      await f.helper.stop();
    });
  }
});

test('helper turns malformed or oversized output and process crashes into one visible failure', { timeout: 7000 }, async t => {
  for (const [mode, pattern] of [['malformedStatus', /Invalid video helper format/], ['oversizeOutput', /line limit/], ['crash', /simulated decoder crash|exited unexpectedly/]]) {
    await t.test(mode, async t => {
      const f = await fixture(t, mode);
      await f.helper.start(f.config);
      f.helper.send(commands(mode), monotonicNowMs());
      await waitFor(() => f.errors.length > 0, 'helper failure was not surfaced');
      await f.helper.stop();
      assert.equal(f.errors.length, 1);
      assert.match(f.errors[0], pattern);
    });
  }
});

test('helper rejects an excessive IPC backlog without retaining an oversized state', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.helper.start(f.config);
  const next = commands('oversize');
  next[0].path = 'a'.repeat(VIDEO_HELPER_MAX_PENDING_BYTES + 1);
  f.helper.send(next, monotonicNowMs());
  await waitFor(() => f.errors.length === 1, 'IPC size failure was not surfaced');
  assert.match(f.errors[0], /backlog exceeded/);
  await f.helper.stop();
});

test('helper shutdown kills an unresponsive child within its bounded stop deadline', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'ignoreShutdown');
  await f.helper.start(f.config);
  const before = performance.now();
  await f.helper.stop();
  assert.ok(performance.now() - before < 4000);
  assert.equal((await f.records()).at(-1).type, 'shutdown');
  assert.deepEqual(f.errors, []);
});
