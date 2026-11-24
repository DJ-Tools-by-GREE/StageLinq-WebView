import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const directory = path.dirname(fileURLToPath(import.meta.url));
const binary = path.join(directory, 'dist/video-ndi-helper');
const settings = {
  stateTimeoutMs: 400,
  loadTimeoutMs: 3000,
  seekThresholdSec: 0.25,
  maxFramePixels: 33177600,
  maxOutputFps: 240,
  maxDecodeFramesPerTick: 32,
  timerLeewayMs: 1,
};
let temporary;
let video;
let longerAudio;

before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'slwv-native-video-'));
  video = path.join(temporary, 'test.mp4');
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30:d=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  longerAudio = path.join(temporary, 'short-video-long-audio.mp4');
  const muxed = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '3',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', longerAudio], { encoding: 'utf8' });
  assert.equal(muxed.status, 0, muxed.stderr || muxed.error?.message);
});
after(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

class Helper {
  constructor() {
    this.process = spawn(binary, ['--test-mode']);
    this.messages = [];
    this.events = new EventEmitter();
    this.sequence = 0;
    this.inspection = 0;
    this.offset = 0;
    this.stderr = '';
    let buffer = '';
    this.process.stdout.on('data', data => {
      buffer += data;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        this.messages.push(message);
        this.events.emit('message', message);
      }
    });
    this.process.stderr.on('data', data => { this.stderr += data; });
    this.exited = new Promise(resolve => this.process.once('exit', (code, signal) => resolve({ code, signal })));
  }
  send(message) { if (!this.closed) this.process.stdin.write(JSON.stringify(message) + '\n'); }
  wait(predicate, from = 0, timeout = 5000) {
    const previous = this.messages.slice(from).find(predicate);
    if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      const listener = message => { if (predicate(message)) { cleanup(); resolve(message); } };
      const cleanup = () => { clearTimeout(timer); this.events.removeListener('message', listener); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Native helper timeout: ' + this.stderr + '\n' + JSON.stringify(this.messages))); }, timeout);
      this.events.on('message', listener);
    });
  }
  async start(format = 'source') {
    await this.wait(message => message.type === 'ready');
    const sentAt = performance.now() / 1000;
    this.send({ type: 'ping', id: 1 });
    const pong = await this.wait(message => message.type === 'pong' && message.id === 1);
    this.offset = pong.hostTimeSec - (sentAt + performance.now() / 1000) / 2;
    this.send({ type: 'configure', protocol: 1, sourceNames: ['Test 1', 'Test 2', 'Test 3', 'Test 4'], outputFormat: format, settings });
    await this.wait(message => message.type === 'configured');
  }
  state(overrides = {}) {
    this.send({ type: 'state', seq: ++this.sequence, hostTimeSec: performance.now() / 1000 + this.offset,
      decks: [1, 2, 3, 4].map(deck => ({ deck, generation: 'track-' + deck, path: null, positionSec: 0, rate: 1, playing: false, ...(deck === 1 ? overrides : {}) })) });
  }
  async inspect(deck = 1) {
    const id = ++this.inspection;
    this.send({ type: 'inspect', id });
    return (await this.wait(message => message.type === 'inspection' && message.id === id && message.deck === deck)).frame;
  }
  async close(expectedCode = 0) {
    this.closed = true;
    this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill('SIGKILL'), 3000);
    const result = await this.exited;
    clearTimeout(timer);
    assert.equal(result.code, expectedCode, this.stderr + JSON.stringify(result));
  }
}

test('local native self-test creates opaque black without initializing NDI', () => {
  const result = spawnSync(binary, ['--self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'self_test', ok: true, ndiInitialized: false });
});

test('AVFoundation decodes seeked frames and letterboxes to opaque 1080p', () => {
  for (const [position, channel] of [[0.75, 2], [2.75, 0]]) {
    const result = spawnSync(binary, ['--probe', video, String(position)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const decoded = JSON.parse(result.stdout);
    assert.equal(decoded.ndiInitialized, false);
    assert.equal(decoded.width, 320);
    assert.equal(decoded.height, 240);
    assert.equal(decoded.fps, 30);
    assert.ok(Math.abs(decoded.framePositionSec - position) <= 1 / 30);
    assert.ok(decoded.centerBgra[channel] > 200);
    assert.deepEqual(decoded.cornerBgra, [0, 0, 0, 255]);
  }
});

test('native source mode follows pitch, seeks on jumps, blacks on pause, EOF and command expiry', async t => {
  const helper = new Helper();
  t.after(() => helper.close());
  await helper.start();
  let position = 0.25;
  let rate = 1.04;
  let playing = true;
  const send = () => helper.state({ path: video, positionSec: position, rate, playing });
  send();
  let heartbeat = setInterval(send, 50);
  t.after(() => clearInterval(heartbeat));
  await helper.wait(message => message.type === 'status' && message.deck === 1 && message.state === 'playing');
  const initial = await helper.inspect();
  assert.equal(initial.width, 320);
  assert.equal(initial.height, 240);
  assert.ok(Math.abs(initial.fps - 31.2) < 1e-6);
  assert.equal(initial.black, false);
  assert.equal(initial.seeks, 1);
  assert.ok(initial.centerBgra[2] > 200);
  position = 2.5;
  send();
  await new Promise(resolve => setTimeout(resolve, 150));
  const jumped = await helper.inspect();
  assert.ok(jumped.framePositionSec >= 2.45 && jumped.framePositionSec < 2.7);
  assert.equal(jumped.seeks, 2);
  assert.ok(jumped.centerBgra[0] > 200);
  position = 0.5;
  send();
  await new Promise(resolve => setTimeout(resolve, 150));
  const looped = await helper.inspect();
  assert.equal(looped.seeks, 3);
  assert.ok(looped.centerBgra[2] > 200);
  const pauseMark = helper.messages.length;
  playing = false; send();
  await helper.wait(message => message.type === 'status' && message.deck === 1 && message.state === 'idle', pauseMark);
  assert.equal((await helper.inspect()).black, true);
  const resumeMark = helper.messages.length;
  playing = true; send();
  await helper.wait(message => message.type === 'status' && message.deck === 1 && message.state === 'playing', resumeMark);
  const leaseMark = helper.messages.length;
  clearInterval(heartbeat);
  await helper.wait(message => message.type === 'status' && message.deck === 1 && message.state === 'idle', leaseMark);
  assert.equal((await helper.inspect()).black, true);
  helper.state({ path: video, positionSec: 100, rate, playing: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await helper.inspect()).black, true);
});

test('bad files recover on a new generation and fixed format stays 1080p30', async t => {
  const helper = new Helper();
  t.after(() => helper.close());
  await helper.start('1080p30');
  helper.state({ generation: 'bad', path: path.join(temporary, 'missing.mp4'), playing: true });
  await helper.wait(message => message.type === 'status' && message.deck === 1 && message.generation === 'bad' && message.state === 'error');
  let send = () => helper.state({ generation: 'recovered', path: video, positionSec: 0.25, rate: 1.5, playing: true });
  send();
  const heartbeat = setInterval(send, 50);
  t.after(() => clearInterval(heartbeat));
  await helper.wait(message => message.type === 'status' && message.deck === 1 && message.generation === 'recovered' && message.state === 'playing');
  const frame = await helper.inspect();
  assert.equal(frame.width, 1920);
  assert.equal(frame.height, 1080);
  assert.equal(frame.fps, 30);
  assert.equal(frame.black, false);
});

test('malformed and oversized IPC messages fail visibly without NDI initialization', () => {
  for (const input of ['{broken}\n', 'x'.repeat(65537) + '\n']) {
    const result = spawnSync(binary, ['--test-mode'], { input, encoding: 'utf8' });
    assert.equal(result.status, 1);
    const messages = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(messages.at(-1).type, 'error');
  }
});

test('fatal IPC errors join deck workers during metadata loading and active playback', async t => {
  for (const phase of ['loading', 'playing']) {
    const helper = new Helper();
    t.after(() => helper.close(1));
    await helper.start();
    helper.state({ path: video, positionSec: 0.25, playing: true });
    if (phase === 'playing') {
      await helper.wait(message => message.type === 'status' && message.deck === 1 && message.state === 'playing');
    }
    helper.process.stdin.write('{broken}\n');
    const fatal = await helper.wait(message => message.type === 'error');
    assert.match(fatal.error, /Invalid JSON/);
    const outcome = await Promise.race([helper.exited, new Promise(resolve => {
      const deadline = setTimeout(() => resolve('timeout'), 3000);
      deadline.unref();
    })]);
    assert.deepEqual(outcome, { code: 1, signal: null }, phase);
  }
});

test('very low source cadence cannot delay pause, pitch changes, or stale-input blackout', async t => {
  const helper = new Helper();
  t.after(() => helper.close());
  await helper.start();
  let rate = 0.001, playing = true;
  const send = () => helper.state({ path: video, positionSec: 0.25, rate, playing });
  send();
  const heartbeat = setInterval(send, 50);
  t.after(() => clearInterval(heartbeat));
  await helper.wait(m => m.type === 'status' && m.deck === 1 && m.state === 'playing' && m.fps < 1);
  let mark = helper.messages.length;
  playing = false; send();
  await helper.wait(m => m.type === 'status' && m.deck === 1 && m.state === 'idle', mark, 1500);
  assert.equal((await helper.inspect()).black, true);
  mark = helper.messages.length;
  playing = true; send();
  await helper.wait(m => m.type === 'status' && m.deck === 1 && m.state === 'playing', mark, 1500);
  mark = helper.messages.length;
  rate = 1; send();
  await helper.wait(m => m.type === 'status' && m.deck === 1 && m.state === 'playing' && m.fps === 30, mark, 1500);
  mark = helper.messages.length;
  rate = 0.001; send();
  await helper.wait(m => m.type === 'status' && m.deck === 1 && m.state === 'playing' && m.fps < 1, mark, 1500);
  mark = helper.messages.length;
  clearInterval(heartbeat);
  await helper.wait(m => m.type === 'status' && m.deck === 1 && m.state === 'idle', mark, 1500);
  assert.equal((await helper.inspect()).black, true);
});

test('video ends in black even when the file audio track lasts longer', async t => {
  const helper = new Helper();
  t.after(() => helper.close());
  await helper.start();
  const send = () => helper.state({ path: longerAudio, positionSec: 1.5, rate: 1, playing: true });
  send();
  const heartbeat = setInterval(send, 50);
  t.after(() => clearInterval(heartbeat));
  await helper.wait(m => m.type === 'status' && m.deck === 1 && m.generation === 'track-1' && m.state === 'idle');
  assert.equal((await helper.inspect()).black, true);
});

test('all four native decks decode independent positions and playback rates concurrently', async t => {
  const helper = new Helper();
  t.after(() => helper.close());
  await helper.start();
  const rates = [1, 1.02, 0.98, 1.04];
  const send = () => helper.send({ type: 'state', seq: ++helper.sequence, hostTimeSec: performance.now() / 1000 + helper.offset,
    decks: [1, 2, 3, 4].map(deck => ({ deck, generation: 'four-' + deck, path: video,
      positionSec: deck % 2 ? 0.25 : 2.5, rate: rates[deck - 1], playing: true })) });
  send();
  const heartbeat = setInterval(send, 50);
  t.after(() => clearInterval(heartbeat));
  await Promise.all([1, 2, 3, 4].map(deck => helper.wait(m => m.type === 'status' && m.deck === deck && m.state === 'playing')));
  for (const deck of [1, 2, 3, 4]) {
    const frame = await helper.inspect(deck);
    assert.equal(frame.black, false);
    assert.ok(Math.abs(frame.fps - rates[deck - 1] * 30) < 1e-6);
    assert.ok(frame.centerBgra[deck % 2 ? 2 : 0] > 200);
  }
});
