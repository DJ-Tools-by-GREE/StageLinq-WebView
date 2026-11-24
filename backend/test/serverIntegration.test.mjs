import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('real HTTP settings failures, reload safety, and orderly recording shutdown', { timeout: 15_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webview-http-'));
  const configFile = path.join(dir, 'config.json');
  const config = { current_playlist: -1, playlists: [], freewheel: { enable_freewheeling: true, max_duration_sec: 30 }, display: { dashboard: false }, logging: { lifecycle: false, playback: false, discover: false } };
  await fs.writeFile(configFile, JSON.stringify(config));
  await fs.writeFile(path.join(dir, 'users.json'), '{"users":{"Default User":{},"Jan":{},"Dennis":{}}}');
  const child = fork(new URL('./helpers/serverFixture.mjs', import.meta.url), [], {
    cwd: dir, silent: true,
    env: { ...process.env, PORT: '0', CONTROL_INPUT_MODE: 'fixed', ARTNET_ENABLED: 'false', OSC_ENABLED: 'false' },
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const [{ port }] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => { throw new Error('Server exited before listening: ' + output); }),
  ]);
  const request = async (url, method='GET', body) => {
    const response = await fetch('http://127.0.0.1:' + port + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/api/health')).status, 200);
  const video = await request('/api/video/status');
  assert.equal(video.status, 200);
  assert.equal(video.body.enabled, false);
  assert.equal(video.body.running, false);
  assert.deepEqual(Object.keys(video.body.decks), ['1', '2', '3', '4']);
  const scan = await request('/api/video/rescan', 'POST');
  assert.equal(scan.status, 200);
  assert.equal(scan.body.ok, true);
  assert.equal(scan.body.status.indexedVideos, 0);
  assert.equal((await request('/api/config', 'PUT', { ...config, video: { enabled: true, directory: '' } })).status, 400);
  await fs.writeFile(configFile, '{ broken');
  assert.equal((await request('/api/global-settings/freewheel', 'PUT', { max_duration_sec: 90 })).status, 500);
  assert.equal((await request('/api/global-settings')).body.freewheel.max_duration_sec, 30);
  assert.equal((await request('/api/config/reload', 'POST')).status, 500);
  assert.equal(await fs.readFile(configFile, 'utf8'), '{ broken');
  assert.equal((await request('/api/config', 'PUT', { playlists: {} })).status, 400);
  assert.equal((await request('/api/config', 'PUT', config)).status, 200);
  assert.equal((await request('/api/config/reload', 'POST')).status, 200);
  assert.equal((await request('/api/record/start', 'POST', { name: 'shutdown-regression' })).status, 200);
  assert.equal((await request('/api/replay/arm', 'POST')).status, 409);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0, output);
  const files = await fs.readdir(path.join(dir, 'recordings'));
  assert.equal(files.some(name => name.endsWith('.meta.json')), true);
  assert.equal(files.some(name => name.startsWith('.active')), false);
  const recording = files.find(name => name.endsWith('.jsonl'));
  const events = (await fs.readFile(path.join(dir, 'recordings', recording), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'footer');
  assert.equal(events.some(event => event.type === 'selected' && event.deck === 1), true);
});
