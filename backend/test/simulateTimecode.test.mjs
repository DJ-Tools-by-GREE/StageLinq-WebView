import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const script = fileURLToPath(new URL('../dist/scripts/simulateTimecode.js', import.meta.url));

test('offline simulator uses position freshness and preserves an empty recorded offset map', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slwv-simulation-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const state = { deck: 1, trackLoaded: true, fileName: 'track.mp3', title: 'Track', artist: '',
    elapsedSec: 1, totalSec: 120, currentBpm: 120, trackBpm: 120, speedState: 0, keyIndex: null,
    keyCamelot: '--', fader: 1, play: true, updatedAt: 0, hotCues: [], loopActive: false,
    loopInSec: null, loopOutSec: null, savedLoops: [] };
  const events = [{ type: 'header', v: 1, startedAt: 1000, trackOffsets: {} },
    { t: 0, type: 'deck', n: 1, state },
    ...[100, 200, 300, 400, 500, 600, 700, 800, 900].map(t => ({ t, type: 'deck', n: 1, diff: { title: String(t) } })),
    { t: 1000, type: 'footer', stoppedAt: 2000 }];
  const input = path.join(dir, 'show.jsonl');
  const config = path.join(dir, 'config.json');
  const json = path.join(dir, 'result.json');
  await fs.writeFile(input, events.map(JSON.stringify).join('\n') + '\n');
  await fs.writeFile(config, JSON.stringify({ playlists: [{ content: [{ song_index: 'track.mp3', offset_sec: 10800 }] }] }));
  execFileSync(process.execPath, [script, input, '--out', path.join(dir, 'result.html'), '--json', json, '--config', config]);
  const result = JSON.parse(await fs.readFile(json, 'utf8'));
  assert.equal(result.offsetsSource, 'recording-header');
  assert.equal(result.trackOffsetsCount, 0);
  assert.equal(result.perDeckStats[0].freewheelSpans, 1);
  assert.ok(result.perDeckStats[0].freewheelTotalMs > 700);
  assert.match(result.timingSource, /inferred/);
  const invalid = spawnSync(process.execPath, [script, input, '--tickHz', 'Infinity'], { encoding: 'utf8', timeout: 2000 });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /finite and positive/);
});
