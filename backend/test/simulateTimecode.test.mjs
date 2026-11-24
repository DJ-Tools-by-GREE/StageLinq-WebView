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

test('v2 simulator uses equal-position heartbeats, recorded transport and historical offset changes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slwv-v2-simulation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { blankRecordedDeck } = await import('../dist/recordingLog.js');
  const state = { ...blankRecordedDeck(1), trackLoaded: true, fileName: 'track.mp3', elapsedSec: 1, totalSec: 100, play: true };
  const timing = (positionT, positionRevision, transportPlay = true, transportRevision = 1) => ({ positionT, positionRevision, transportPlay, transportRevision, trackId: 'net://device/USB/track.mp3' });
  const events = [{ type: 'header', v: 2, startedAt: 1000, trackOffsets: {} },
    { t: 0, type: 'deck', n: 1, state, timing: timing(0, 1) },
    ...[100, 200, 300, 400].map((t, i) => ({ t, type: 'deck', n: 1, diff: {}, timing: timing(t, i + 2) })),
    { t: 500, type: 'config', trackOffsets: { 'track.mp3': { offsetSec: 100, offsetFrame: 0 } }, playlistRef: 'second' },
    ...[500, 600, 700, 800, 900].map((t, i) => ({ t, type: 'deck', n: 1, diff: {}, timing: timing(t, i + 6) })),
    { t: 1000, type: 'footer', stoppedAt: 999999 }];
  const input = path.join(dir, 'show.jsonl');
  const json = path.join(dir, 'result.json');
  const html = path.join(dir, 'result.html');
  await fs.writeFile(input, events.map(JSON.stringify).join('\n') + '\n');
  execFileSync(process.execPath, [script, input, '--out', html, '--json', json]);
  let result = JSON.parse(await fs.readFile(json, 'utf8'));
  assert.equal(result.durationMs, 1000);
  assert.equal(result.configChanges, 1);
  assert.match(result.timingSource, /^recorded/);
  assert.equal(result.perDeckStats[0].freewheelSpans, 0);
  assert.match(await fs.readFile(html, 'utf8'), /recorded source position and explicit transport revisions/);

  const watchdog = [events[0], events[1], events[2],
    { t: 200, type: 'deck', n: 1, diff: { play: false }, timing: timing(100, 2) },
    { t: 700, type: 'deck', n: 1, diff: {}, timing: timing(100, 2, false, 2) }, events.at(-1)];
  await fs.writeFile(input, watchdog.map(JSON.stringify).join('\n') + '\n');
  execFileSync(process.execPath, [script, input, '--out', html, '--json', json]);
  result = JSON.parse(await fs.readFile(json, 'utf8'));
  assert.equal(result.perDeckStats[0].freewheelSpans, 1);
  assert.ok(result.perDeckStats[0].freewheelTotalMs > 250);
  assert.ok(result.perDeckStats[0].lastEmitMs < 750);
});
