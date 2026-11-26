import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
assert.ok(mode === 'src' || mode === 'dist');
const extension = mode === 'src' ? 'ts' : 'js';
const moduleUrl = name => new URL(`../../${mode}/${name}.${extension}`, import.meta.url);
const { applyLoggingConfig } = await import(moduleUrl('logging'));
applyLoggingConfig({ lifecycle: false, errors: false });
const { ArtNetTimecodeBroadcaster } = await import(moduleUrl('artnetTimecode'));
const { initWaveformCache, loadCachedMedia, shutdownWaveformWorker } = await import(moduleUrl('waveformService'));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slwv worker startup '));
const broadcaster = new ArtNetTimecodeBroadcaster({
  enabled: true, targetIps: [], port: 6454, fps: 30, fpsType: 3, deck: 1,
  freewheelStaleThresholdMs: 250,
});

try {
  await broadcaster.start();
  await initWaveformCache(directory);
  assert.deepEqual(await loadCachedMedia('net://device/USB/missing.mp3', 'missing.mp3'), {
    peaksFrame: null, artworkFrame: null,
  });
} finally {
  await broadcaster.stop();
  await shutdownWaveformWorker();
  await fs.rm(directory, { recursive: true, force: true });
}
