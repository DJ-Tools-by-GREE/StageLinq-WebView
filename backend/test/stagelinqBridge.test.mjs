import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { StageLinq } from '@gree44/stagelinq';
import { Player } from '@gree44/stagelinq/dist/devices/Player.js';
import { keyNameToCamelot } from '../dist/camelot.js';
import { applyLoggingConfig } from '../dist/logging.js';
import { StageLinqBridge } from '../dist/stagelinqBridge.js';

applyLoggingConfig({ lifecycle: false, playback: false, discover: false });

function setupBridge(t) {
  const bridge = new StageLinqBridge();
  t.after(() => {
    StageLinq.devices.disconnectAll();
    StageLinq.reset();
  });

  const raw = (tail, value, deck = 1) => {
    const json = typeof value === 'string' ? { string: value } : { value };
    StageLinq.devices.emit('message', {}, {
      id: 0,
      message: { name: `/Engine/Deck${deck}/${tail}`, json: { type: 1, ...json } },
    });
  };
  const beat = () => StageLinq.devices.emit('beatMessage', {}, {
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
  const { raw, beat, key } = setupBridge(t);
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
  const { raw, beat, key } = setupBridge(t);
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
  const { raw, beat, key } = setupBridge(t);
  raw('Track/CurrentKey', 'Am');
  raw('Track/CurrentKey', 'unknown');
  beat();
  assert.equal(key(), '--');
});

test('legacy key paths, TrackData, nowPlaying and named stateChanged use the same conversion', (t) => {
  const { raw, beat, key } = setupBridge(t);
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

  StageLinq.devices.emit('nowPlaying', { layer: 'A', keyIndex: 0, key: 'F♯m' });
  beat();
  assert.equal(key(), '11A');
  StageLinq.devices.emit('stateChanged', { name: '/Engine/Deck1/Track/CurrentKey', value: 'Cm' });
  beat();
  assert.equal(key(), '5A');
  StageLinq.devices.emit('stateChanged', { name: '/Engine/Deck1/Track/CurrentKeyIndex', value: 23 });
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
  const { raw, beat, key } = setupBridge(t);
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
  StageLinq.devices.emit('nowPlaying', { layer: 'A', fileName: 'track.mp3' });
  assert.equal(bridge.getRawNetworkPath(1), firstPath);
  assert.equal(key(), '8A');
  raw('Track/TrackNetworkPath', secondPath);
  beat();
  assert.equal(bridge.getRawNetworkPath(1), secondPath);
  assert.equal(key(), '--');
});

test('the real Player status restores key-before-path updates and rejects status for the previous track', (t) => {
  const { beat, key } = setupBridge(t);
  const stateMap = new EventEmitter();
  stateMap.on('message', (data) => StageLinq.devices.emit('message', {}, data));
  const player = new Player({ stateMap, address: '192.0.2.1', port: 0, deviceId: 'device' });
  const statuses = [];
  player.on('stateChanged', (status) => {
    statuses.push(status);
    StageLinq.devices.emit('stateChanged', status);
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

  StageLinq.devices.emit('stateChanged', statuses[0]);
  StageLinq.devices.emit('nowPlaying', statuses[0]);
  beat();
  assert.equal(key(), '7A');
});

test('a new network track with the same basename clears the previous key', (t) => {
  const { raw, beat, key } = setupBridge(t);
  raw('Track/TrackNetworkPath', 'net://device/source/first/track.mp3');
  raw('Track/CurrentKey', 'Am');
  raw('Track/TrackNetworkPath', 'net://device/source/second/track.mp3');
  beat();
  assert.equal(key(), '--');
});

test('repeat paths and basename metadata retain the key for the same track', (t) => {
  const { raw, beat, key } = setupBridge(t);
  raw('Track/TrackNetworkPath', 'net://device/source/track.mp3');
  raw('Track/CurrentKey', 'Am');
  raw('Track/TrackNetworkPath', 'net://device/source/track.mp3');
  StageLinq.devices.emit('nowPlaying', { layer: 'A', fileName: 'track.mp3' });
  beat();
  assert.equal(key(), '8A');
});

test('an initial path arriving after key metadata preserves that key', (t) => {
  const { raw, beat, key } = setupBridge(t);
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

test('disconnect clears cached named keys before rewiring the singleton', async (t) => {
  const { bridge, raw, beat, key } = setupBridge(t);
  raw('Track/CurrentKeyIndex', 0);
  raw('Track/CurrentKey', 'Am');
  StageLinq.devices.disconnectAll();
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
    import { StageLinq } from '@gree44/stagelinq';
    import { StageLinqBridge } from './backend/dist/stagelinqBridge.js';
    import { applyLoggingConfig } from './backend/dist/logging.js';
    applyLoggingConfig({ lifecycle: false, playback: false, discover: false });
    const bridge = new StageLinqBridge();
    const emit = (name, json) => StageLinq.devices.emit('message', {}, {
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
      StageLinq.devices.disconnectAll();
      StageLinq.reset();
    }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    env: { ...process.env, KEY_MAP: Array(24).fill('12B').join(',') },
  });
});
