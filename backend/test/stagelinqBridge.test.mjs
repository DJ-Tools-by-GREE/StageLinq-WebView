import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Player } from '@gree44/stagelinq/dist/devices/Player.js';
import { keyNameToCamelot } from '../dist/camelot.js';
import { applyLoggingConfig } from '../dist/logging.js';
import { StageLinqBridge } from '../dist/stagelinqBridge.js';

applyLoggingConfig({ lifecycle: false, playback: false, discover: false, errors: false });

function setupBridge(t) {
  const bridge = new StageLinqBridge();
  t.after(() => {
    bridge.stageLinqDevices.disconnectAll();
  });

  const raw = (tail, value, deck = 1) => {
    const json = typeof value === 'string' ? { string: value } : { value };
    bridge.stageLinqDevices.emit('message', {}, {
      id: 0,
      message: { name: `/Engine/Deck${deck}/${tail}`, json: { type: 1, ...json } },
    });
  };
  const beat = () => bridge.stageLinqDevices.emit('beatMessage', {}, {
    clock: 1n, deckCount: 4,
    decks: [1, 2, 3, 4].map(() => ({ beat: 1, totalBeats: 100, bpm: 120, samples: 48000 })),
  });
  const key = (deck = 1) => bridge.getDeck(deck).keyCamelot;
  return { bridge, raw, beat, key };
}

test('converts the 24 musical keys and validates Camelot notation', () => {
  const keys = [
    ['G#m', '1A'], ['B', '1B'], ['Ebm', '2A'], ['F#', '2B'],
    ['Bbm', '3A'], ['Db', '3B'], ['Fm', '4A'], ['Ab', '4B'],
    ['Cm', '5A'], ['Eb', '5B'], ['Gm', '6A'], ['Bb', '6B'],
    ['Dm', '7A'], ['F', '7B'], ['Am', '8A'], ['C', '8B'],
    ['Em', '9A'], ['G', '9B'], ['Bm', '10A'], ['D', '10B'],
    ['F#m', '11A'], ['A', '11B'], ['C#m', '12A'], ['E', '12B'],
  ];
  for (const [name, expected] of keys) {
    assert.equal(keyNameToCamelot(name), expected, name);
    assert.equal(keyNameToCamelot(` ${expected.toLowerCase()} `), expected);
  }
});

test('accepts musical suffixes and enharmonic sharp/flat spellings', () => {
  for (const name of ['Am', 'Amin', 'A minor', 'a MINOR']) {
    assert.equal(keyNameToCamelot(name), '8A', name);
  }
  for (const name of ['A', 'AM', 'Amaj', 'A major', 'a MAJOR']) {
    assert.equal(keyNameToCamelot(name), '11B', name);
  }
  for (const name of ['A#m', 'Bbm', 'B♭ minor']) {
    assert.equal(keyNameToCamelot(name), '3A', name);
  }
  for (const name of ['F# minor', 'F♯m', 'Gbmin']) {
    assert.equal(keyNameToCamelot(name), '11A', name);
  }
  assert.equal(keyNameToCamelot('Cb'), '1B');
  assert.equal(keyNameToCamelot('E#'), '7B');
});

test('rejects empty and malformed key values', () => {
  for (const value of [null, undefined, 8, {}, '', ' ', '--', '0A', '13B', '8C', 'Amm', 'C##', '8A extra']) {
    assert.equal(keyNameToCamelot(value), null, String(value));
  }
});

test('CurrentKey wins over an earlier numeric index and stays stable across beats', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  raw('Track/CurrentKeyIndex', 0);
  assert.equal(key(), '1A');
  const changes = [];
  bridge.subscribeDeckState((_deck, state) => changes.push(state.keyCamelot));

  raw('Track/CurrentKey', 'Am');
  assert.equal(key(), '8A');
  beat();
  raw('CurrentBPM', 126);
  raw('SpeedState', 5);
  assert.equal(key(), '8A');
  assert.ok(changes.filter((value) => value !== '--').every((value) => value === '8A'));
});

test('a later numeric index keeps the named key and named updates apply on every deck', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  for (const deck of [1, 2, 3, 4]) {
    raw('Track/CurrentKey', 'Am', deck);
    raw('Track/CurrentKeyIndex', 23, deck);
    assert.equal(key(deck), '8A');
    raw('Track/CurrentKey', 'D minor', deck);
  }
  beat();
  for (const deck of [1, 2, 3, 4]) assert.equal(key(deck), '7A');
});

test('invalid named updates restore the numeric fallback and remain safe after a beat', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  raw('Track/CurrentKeyIndex', 23);
  for (const invalid of ['', ' ', 'unknown', '0A', '13B', null, 7, {}]) {
    raw('Track/CurrentKey', 'Am');
    raw('Track/CurrentKey', invalid);
    assert.equal(key(), '12B', String(invalid));
    beat();
    assert.equal(key(), '12B', String(invalid));
  }
});

test('invalid named values without a numeric index display the unknown marker', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  raw('Track/CurrentKey', 'Am');
  raw('Track/CurrentKey', 'unknown');
  beat();
  assert.equal(key(), '--');
});

test('legacy key paths, TrackData, nowPlaying and named stateChanged use the same conversion', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  for (const tail of ['CurrentKey', 'Track/Key', 'Key', 'Track/Camelot', 'Camelot']) {
    raw(tail, 'B♭ minor');
    beat();
    assert.equal(key(), '3A', tail);
  }

  raw('Track/TrackData', JSON.stringify({ keyIndex: 0, key: 'Am' }));
  beat();
  assert.equal(key(), '8A');
  raw('Track/TrackData', JSON.stringify({ currentKeyIndex: 23, camelot: ' 7a ' }));
  beat();
  assert.equal(key(), '7A');
  raw('Track/TrackData', JSON.stringify({ currentKey: 'G major' }));
  beat();
  assert.equal(key(), '9B');

  bridge.stageLinqDevices.emit('nowPlaying', { layer: 'A', keyIndex: 0, key: 'F♯m' });
  beat();
  assert.equal(key(), '11A');
  bridge.stageLinqDevices.emit('stateChanged', { name: '/Engine/Deck1/Track/CurrentKey', value: 'Cm' });
  beat();
  assert.equal(key(), '5A');
  bridge.stageLinqDevices.emit('stateChanged', { name: '/Engine/Deck1/Track/CurrentKeyIndex', value: 23 });
  assert.equal(key(), '5A');
});

test('track changes clear both key sources before publishing the replacement track', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  raw('Track/TrackNetworkPath', 'net://device/source/first.mp3');
  raw('Track/CurrentKeyIndex', 0);
  raw('Track/CurrentKey', 'Am');
  const changes = [];
  bridge.subscribeDeckState((_deck, state) => changes.push(state));

  raw('Track/TrackNetworkPath', 'net://device/source/second.mp3');
  assert.equal(key(), '--');
  assert.equal(bridge.getDeck(1).keyIndex, null);
  assert.ok(changes.filter((state) => state.fileName === 'second.mp3').every((state) => state.keyCamelot === '--'));
  beat();
  assert.equal(key(), '--');
  raw('Track/CurrentKeyIndex', 1);
  assert.equal(key(), '1B');
  raw('Track/CurrentKey', 'Em');
  beat();
  assert.equal(key(), '9A');
});

test('TrackData selects the first valid alias and clears the preference when all supplied aliases are invalid', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  for (const data of [
    { camelot: null, key: 'Am' },
    { currentKey: null, camelot: '8A' },
    { currentKey: 'unknown', camelot: '', key: 'Am' },
    { currentKey: {}, camelot: 8, key: 'Am' },
  ]) {
    raw('Track/TrackData', JSON.stringify({ keyIndex: 23, ...data }));
    beat();
    assert.equal(key(), '8A', JSON.stringify(data));
  }
  raw('Track/TrackData', JSON.stringify({ currentKey: 'Dm', camelot: '8A', key: 'Em' }));
  assert.equal(key(), '7A');
  raw('Track/TrackData', JSON.stringify({ title: 'Metadata without a key' }));
  assert.equal(key(), '7A');
  raw('Track/TrackData', JSON.stringify({ currentKey: null, camelot: 'unknown', key: '' }));
  beat();
  assert.equal(key(), '12B');
});

test('basename metadata preserves the full network identity before a same-name replacement', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  const firstPath = 'net://device/source/first/track.mp3';
  const secondPath = 'net://device/source/second/track.mp3';
  raw('Track/TrackNetworkPath', firstPath);
  raw('Track/CurrentKey', 'Am');
  bridge.stageLinqDevices.emit('nowPlaying', { layer: 'A', fileName: 'track.mp3' });
  assert.equal(bridge.getRawNetworkPath(1), firstPath);
  assert.equal(key(), '8A');
  raw('Track/TrackNetworkPath', secondPath);
  beat();
  assert.equal(bridge.getRawNetworkPath(1), secondPath);
  assert.equal(key(), '--');
});

test('the real Player status restores key-before-path updates and rejects status for the previous track', (t) => {
  const { bridge, beat, key } = setupBridge(t);
  const stateMap = new EventEmitter();
  stateMap.on('message', (data) => bridge.stageLinqDevices.emit('message', {}, data));
  const player = new Player({ stateMap, address: '192.0.2.1', port: 0, deviceId: 'device' });
  const statuses = [];
  player.on('stateChanged', (status) => {
    statuses.push(status);
    bridge.stageLinqDevices.emit('stateChanged', status);
  });
  t.after(() => clearTimeout(player.queue.A.timeout));
  const emit = (tail, json) => stateMap.emit('message', {
    id: 0, message: { name: '/Engine/Deck1/Track/' + tail, json: { type: 1, ...json } },
  });
  const firstPath = 'net://device/source/Engine Library/Music/first.mp3';
  const secondPath = 'net://device/source/Engine Library/Music/second.mp3';

  emit('TrackNetworkPath', { string: firstPath });
  emit('SongLoaded', { state: true });
  emit('CurrentKey', { string: 'Am' });
  player.queue.A.emptyCue();
  assert.equal(key(), '8A');

  emit('CurrentKey', { string: 'Dm' });
  emit('TrackNetworkPath', { string: secondPath });
  emit('SongLoaded', { state: true });
  assert.equal(key(), '--');
  player.queue.A.emptyCue();
  assert.equal(statuses.at(-1).trackNetworkPath, secondPath);
  assert.equal(statuses.at(-1).key, 'Dm');
  assert.equal(key(), '7A');
  beat();
  assert.equal(key(), '7A');

  bridge.stageLinqDevices.emit('stateChanged', statuses[0]);
  bridge.stageLinqDevices.emit('nowPlaying', statuses[0]);
  beat();
  assert.equal(key(), '7A');
});

test('a new network track with the same basename clears the previous key', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  raw('Track/TrackNetworkPath', 'net://device/source/first/track.mp3');
  raw('Track/CurrentKey', 'Am');
  raw('Track/TrackNetworkPath', 'net://device/source/second/track.mp3');
  beat();
  assert.equal(key(), '--');
});

test('repeat paths and basename metadata retain the key for the same track', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  raw('Track/TrackNetworkPath', 'net://device/source/track.mp3');
  raw('Track/CurrentKey', 'Am');
  raw('Track/TrackNetworkPath', 'net://device/source/track.mp3');
  bridge.stageLinqDevices.emit('nowPlaying', { layer: 'A', fileName: 'track.mp3' });
  beat();
  assert.equal(key(), '8A');
});

test('an initial path arriving after key metadata preserves that key', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  raw('Track/CurrentKey', 'Am');
  raw('Track/TrackNetworkPath', 'net://device/source/track.mp3');
  beat();
  assert.equal(key(), '8A');
});

test('SongLoaded=false clears keys before reloading the same path', (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  raw('Track/TrackNetworkPath', 'net://device/source/track.mp3');
  raw('Track/CurrentKeyIndex', 0);
  raw('Track/CurrentKey', 'Am');
  raw('Track/SongLoaded', false);
  assert.equal(bridge.getDeck(1).trackLoaded, false);
  beat();
  assert.equal(key(), '--');
  raw('Track/SongLoaded', true);
  raw('Track/TrackNetworkPath', 'net://device/source/track.mp3');
  beat();
  assert.equal(key(), '--');
});

test('disconnect clears cached named keys before creating a fresh instance', async (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  raw('Track/CurrentKeyIndex', 0);
  raw('Track/CurrentKey', 'Am');
  bridge.stageLinqDevices.disconnectAll();
  await bridge.disconnect();
  beat();
  assert.equal(key(), '--');
  raw('Track/CurrentKeyIndex', 23);
  assert.equal(key(), '12B');
});

test('KEY_MAP remains the numeric fallback and a named key takes precedence', () => {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  const script = `
    import assert from 'node:assert/strict';
        import { StageLinqBridge } from './backend/dist/stagelinqBridge.js';
    import { applyLoggingConfig } from './backend/dist/logging.js';
    applyLoggingConfig({ lifecycle: false, playback: false, discover: false, errors: false });
    const bridge = new StageLinqBridge();
    const emit = (name, json) => bridge.stageLinqDevices.emit('message', {}, {
      message: { name: '/Engine/Deck1/Track/' + name, json },
    });
    try {
      emit('CurrentKeyIndex', { value: 0 });
      assert.equal(bridge.getDeck(1).keyCamelot, '12B');
      emit('CurrentKey', { string: 'Am' });
      assert.equal(bridge.getDeck(1).keyCamelot, '8A');
      emit('CurrentKey', { string: '' });
      assert.equal(bridge.getDeck(1).keyCamelot, '12B');
    } finally {
      bridge.stageLinqDevices.disconnectAll();
      }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    env: { ...process.env, KEY_MAP: Array(24).fill('12B').join(',') },
  });
});

test('a same-basename replacement notifies listeners and clears loops before publishing', (t) => {
  const { bridge, raw } = setupBridge(t);
  const tracks = [];
  bridge.opts.onTrackChanged = (...args) => tracks.push(args);
  raw('Track/TrackNetworkPath', 'net://device/source/a/track.mp3');
  raw('Track/LoopEnableState', true);
  const published = [];
  bridge.subscribeDeckState((_deck, state) => published.push(state));
  raw('Track/TrackNetworkPath', 'net://device/source/b/track.mp3');
  assert.equal(tracks.length, 2);
  assert.equal(tracks[1][2], 'net://device/source/b/track.mp3');
  assert.ok(published.every((state) => state.loopActive === false));
  raw('Track/TrackNetworkPath', 'net://device/source/b/track.mp3');
  bridge.stageLinqDevices.emit('nowPlaying', { layer: 'A', fileName: 'track.mp3' });
  assert.equal(tracks.length, 2);
});

test('artist metadata does not change loaded state or erase a named key', (t) => {
  const { bridge, raw, key } = setupBridge(t);
  raw('Track/SongLoaded', true);
  raw('Track/SongName', 'Track without artist tags');
  raw('Track/CurrentKey', 'Am');
  raw('Track/ArtistName', '');
  assert.equal(bridge.getDeck(1).trackLoaded, true);
  assert.equal(key(), '8A');
  bridge.stageLinqDevices.emit('nowPlaying', { layer: 'A', artist: '' });
  bridge.stageLinqDevices.emit('stateChanged', { name: '/Engine/Deck1/Track/ArtistName', value: '' });
  assert.equal(bridge.getDeck(1).trackLoaded, true);
  assert.equal(key(), '8A');
  raw('Track/SongLoaded', false);
  raw('Track/ArtistName', 'Late artist');
  assert.equal(bridge.getDeck(1).trackLoaded, false);
});

test('sample-derived duration and loops are recalculated when a new sample rate arrives', (t) => {
  const { bridge, raw } = setupBridge(t);
  raw('Track/SampleRate', 44100);
  raw('Track/TrackNetworkPath', 'net://device/source/new.mp3');
  raw('Track/TrackLength', 480000);
  raw('Track/CurrentLoopInPosition', 48000);
  raw('Track/CurrentLoopOutPosition', 96000);
  raw('Track/SampleRate', 48000);
  assert.equal(bridge.getDeck(1).totalSec, 10);
  assert.equal(bridge.getDeck(1).loopInSec, 1);
  assert.equal(bridge.getDeck(1).loopOutSec, 2);
  raw('Track/TrackLength', 120);
  raw('Track/SampleRate', 44100);
  assert.equal(bridge.getDeck(1).totalSec, 120);
});

test('disconnect resets transport caches and isolates events from the previous public instance', async (t) => {
  const { bridge, raw, beat } = setupBridge(t);
  raw('Track/SampleRate', 48000);
  raw('CurrentBPM', 120);
  raw('SpeedState', 10);
  raw('Track/TrackLength', 480000);
  const oldInstance = bridge.stageLinq;
  const oldDevices = bridge.stageLinqDevices;
  await bridge.disconnect();
  assert.notEqual(bridge.stageLinq, oldInstance);
  assert.equal(oldDevices.listenerCount('message'), 0);
  assert.equal(oldDevices.deviceWatchTimeout, null);
  beat();
  assert.equal(bridge.getDeck(1).elapsedSec, 0);
  assert.equal(bridge.getDeck(1).speedState, 0);
  assert.equal(bridge.getDeck(1).trackBpm, 0);
  raw('Track/SampleRate', 44100);
  assert.equal(bridge.getDeck(1).totalSec, 0);
  raw('SpeedState', 0);
  assert.equal(bridge.getDeck(1).trackBpm, 120);
});

test('disconnect creates a usable public instance even when logout rejects', async (t) => {
  const { bridge, raw, key } = setupBridge(t);
  const oldInstance = bridge.stageLinq;
  oldInstance.disconnect = async () => { throw new Error('Synthetic logout failure'); };
  await bridge.disconnect();
  assert.notEqual(bridge.stageLinq, oldInstance);
  raw('Track/CurrentKey', 'Am');
  assert.equal(key(), '8A');
});

test('a BeatInfo event publishes one complete snapshot per deck', (t) => {
  const { bridge, raw, beat } = setupBridge(t);
  for (const deck of [1, 2, 3, 4]) raw('Track/SampleRate', 48000, deck);
  const changes = [];
  bridge.subscribeDeckState((deck, state) => changes.push([deck, state]));
  beat();
  assert.equal(changes.length, 4);
  assert.ok(changes.every(([, state]) => state.elapsedSec === 1 && state.currentBpm === 120));
});

test('downloads use the upstream path parser and retain per-device serialization', async (t) => {
  const { bridge } = setupBridge(t);
  const ft = new EventEmitter();
  let active = 0;
  const paths = [];
  ft.getFile = async (file) => {
    assert.equal(active++, 0);
    paths.push(file);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return Uint8Array.of(paths.length);
  };
  bridge.stageLinqDevices.getFileTransferService = () => ft;
  const prefix = 'net://12345678-1234-1234-1234-123456789abc/USB 1/Engine Library/Music/';
  const results = await Promise.all([
    bridge.downloadFile(prefix + 'a.mp3', () => {}),
    bridge.downloadFile(prefix + 'b.mp3', () => {}),
  ]);
  assert.deepEqual(paths, ['/USB 1/Engine Library/Music/a.mp3', '/USB 1/Engine Library/Music/b.mp3']);
  assert.deepEqual(results.map((r) => [...r]), [[1], [2]]);
  assert.equal(ft.listenerCount('fileTransferProgress'), 0);
  await assert.rejects(bridge.downloadFile('net:invalid/path/file.mp3', () => {}), /Invalid net path/);
});

test('source timing advances only for BeatInfo positions and explicit transport updates', async (t) => {
  const { bridge, raw, beat } = setupBridge(t);
  assert.equal(bridge.getDeckTiming(1).positionAtMs, null);
  beat();
  assert.equal(bridge.getDeckTiming(1).positionAtMs, null);
  raw('Track/TrackNetworkPath', 'net://device/source/first.mp3');
  raw('Track/SampleRate', 48000);
  beat();
  const first = bridge.getDeckTiming(1);
  assert.ok(first.positionAtMs > 0);
  assert.equal(first.trackId, 'net://device/source/first.mp3');
  raw('Track/ArtistName', 'Metadata');
  raw('SpeedState', 5);
  assert.deepEqual(bridge.getDeckTiming(1), first);
  raw('Track/TrackNetworkPath', 'net://device/source/second.mp3');
  assert.equal(bridge.getDeckTiming(1).trackId, first.trackId);
  raw('Play', false);
  assert.equal(bridge.getDeckTiming(1).transportRevision, first.transportRevision + 1);
  assert.equal(bridge.getDeckTiming(1).positionRevision, first.positionRevision);
  beat();
  const second = bridge.getDeckTiming(1);
  assert.equal(second.trackId, 'net://device/source/second.mp3');
  assert.ok(second.positionRevision > first.positionRevision);
  assert.equal(bridge.getDeckTiming(2).positionAtMs, null);
  await bridge.disconnect();
  assert.equal(bridge.getDeckTiming(1).positionAtMs, null);
  assert.ok(bridge.getDeckTiming(1).positionRevision > second.positionRevision);
});

test('explicit unload stops transport, but empty or delayed title tags cannot override SongLoaded', (t) => {
  const { bridge, raw, key } = setupBridge(t);
  raw('Track/SongLoaded', true);
  raw('Play', true);
  raw('Track/CurrentKey', 'Am');
  raw('Track/SongName', '');
  assert.equal(bridge.getDeck(1).play, true);
  assert.equal(bridge.getDeck(1).trackLoaded, true);
  assert.equal(key(), '8A');
  const previousRevision = bridge.getDeckTiming(1).transportRevision;
  raw('Track/SongLoaded', false);
  assert.equal(bridge.getDeck(1).play, false);
  assert.ok(bridge.getDeckTiming(1).transportRevision > previousRevision);
  raw('Track/SongName', 'Delayed old title');
  assert.equal(bridge.getDeck(1).trackLoaded, false);
});
