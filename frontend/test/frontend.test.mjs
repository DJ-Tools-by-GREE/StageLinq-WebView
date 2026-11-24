import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadSource, hookHarness, elements } from './loadSource.mjs';

const waveformProps = {
  deck: 1, peaksPerSec: 200, elapsedSec: 0, totalSec: 3600, stage: 'ready', progress: 100,
  hotCues: [], loopActive: false, loopInSec: null, loopOutSec: null, savedLoops: [], elapsedSecRef: { current: 0 },
};

test('one-hour and silent waveforms render without argument overflow', () => {
  const Waveform = loadSource('WaveformDisplay.tsx').default;
  for (const amplitude of [0.4, 0]) {
    const html = renderToStaticMarkup(React.createElement(Waveform, { ...waveformProps, peaks: Array(720000).fill(amplitude) }));
    assert.match(html, /waveformOverview/);
  }
});

test('pixel bins retain transients, silence and out-of-track padding', () => {
  const { peakBins, peakMaximum } = loadSource('waveformPeaks.ts');
  assert.equal(peakMaximum([0, 0]), 1);
  assert.equal(peakMaximum([NaN, 0.4, 0.8, Infinity]), 0.8);
  assert.deepEqual([...peakBins([0, 1, 0, 0.5], 2)], [1, 0.5]);
  assert.deepEqual([...peakBins([1, 0.5], 4, -1, 3)], [0, 1, 0.5, 0]);
  assert.equal(peakBins(Array(720000).fill(0.5), 700).length, 700);
});

test('documented optional playlist fields can be edited and saved', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ config: { playlists: [{ name: 'Set', content: [{ song_index: 'a.mp3' }] }] }, sourcePath: 'test.json' }) }));
  const { loadConfig, serializeConfig } = loadSource('configEditor/restApi.ts');
  const { config } = await loadConfig();
  const { PlaylistEditor } = loadSource('configEditor/components/PlaylistEditor.tsx');
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(PlaylistEditor, { config, onChange() {} })));
  const saved = JSON.parse(serializeConfig(config));
  assert.deepEqual(saved.playlists[0].content[0].note, { description: '', show_secs_after_load: 0 });
  assert.equal(saved.osc.enabled, false);
  assert.equal(saved.sacn_sim.enabled, false);
  assert.equal(saved.current_playlist, -1);
});

function socketEnvironment(t) {
  const timeouts = new Map();
  const intervals = new Map();
  const sockets = [];
  let id = 0;
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { timeouts.set(++id, { fn, ms }); return id; });
  t.mock.method(globalThis, 'clearTimeout', key => timeouts.delete(key));
  t.mock.method(globalThis, 'setInterval', fn => { intervals.set(++id, fn); return id; });
  t.mock.method(globalThis, 'clearInterval', key => intervals.delete(key));
  const oldWindow = globalThis.window;
  const oldWebSocket = globalThis.WebSocket;
  t.after(() => { globalThis.window = oldWindow; globalThis.WebSocket = oldWebSocket; });
  globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { protocol: 'http:', host: 'test' }, localStorage: { getItem() { return null; }, setItem() {} } };
  globalThis.WebSocket = class {
    OPEN = 1;
    readyState = 0;
    constructor() { sockets.push(this); }
    send() {}
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    snapshot(seq, fileName, mediaId = "net://device/USB/" + fileName) {
      this.onmessage?.({ data: JSON.stringify({ type: 'snapshot', seq, selectedDeck: 1, stagelinqStatus: 'connected', decks: Object.fromEntries([1, 2, 3, 4].map(deck => [deck, { trackLoaded: true, fileName, mediaId, elapsedSec: seq }])) }) });
    }
  };
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => url === '/api/users' ? { users: [] } : { freewheel: { enable_freewheeling: true, max_duration_sec: 30 } } }));
  return { sockets, timeouts, intervals, reconnect() { for (const [key, timer] of timeouts) if (timer.ms === 800) { timeouts.delete(key); timer.fn(); } } };
}

test('a backend restart accepts its new snapshot sequence and ignores the old socket', t => {
  const env = socketEnvironment(t);
  const app = hookHarness('App.tsx');
  app.render(); app.effects();
  const first = env.sockets[0]; first.open(); first.snapshot(108000, 'before.mp3');
  const staleMessage = first.onmessage;
  first.close(); first.onclose(); env.reconnect();
  env.sockets[1].open(); env.sockets[1].snapshot(1, 'after.mp3');
  staleMessage({ data: JSON.stringify({ type: 'snapshot', seq: 108001 }) });
  const header = elements(app.render(), node => node.type?.name === 'HeaderBar')[0];
  assert.equal(header.props.selectedDeckState.fileName, 'after.mp3');
  app.cleanup();
  assert.equal(env.intervals.size, 0);
});

test('StrictMode cleanup and stale close callbacks leave exactly one socket', t => {
  const env = socketEnvironment(t);
  const app = hookHarness('App.tsx');
  app.render(); app.effects();
  const staleClose = env.sockets[0].onclose;
  app.cleanup(); app.remountEffects(); env.sockets[1].open();
  staleClose(); env.reconnect();
  assert.equal(env.sockets.length, 2);
  assert.equal(env.sockets.filter(socket => socket.readyState !== 3).length, 1);
  assert.equal(env.intervals.size, 1);
  app.cleanup();
});

test('an edit during a save remains dirty and duplicate saves are coalesced', async t => {
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = previousWindow; });
  const { DEFAULT_CONFIG } = loadSource('configEditor/defaults.ts');
  let resolveSave;
  const saved = [];
  const editor = hookHarness('configEditor/ConfigEditorOverlay.tsx', { './restApi.js': {
    loadConfig: async () => ({ config: DEFAULT_CONFIG, sourcePath: 'test.json', legacyNoteFieldFound: false }),
    saveConfig(config) { saved.push(config); return new Promise(resolve => { resolveSave = resolve; }); },
  } });
  const props = { onClose() {} };
  const settings = tree => elements(tree, node => node.type?.name === 'GlobalSettings')[0];
  const save = tree => elements(tree, node => node.type === 'button' && ['Save', 'Saving…'].includes(node.props.children))[0];
  editor.render(props); editor.effects(); await Promise.resolve();
  settings(editor.render(props)).props.onChange({ ...DEFAULT_CONFIG, current_playlist: 2 });
  const tree = editor.render(props);
  const inFlight = save(tree).props.onClick();
  await save(tree).props.onClick();
  settings(tree).props.onChange({ ...DEFAULT_CONFIG, current_playlist: 0 });
  resolveSave(); await inFlight;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].current_playlist, 2);
  assert.equal(settings(editor.render(props)).props.config.current_playlist, 0);
  assert.equal(save(editor.render(props)).props.disabled, false);
  editor.cleanup();
});

test('CSV file reads use the newest selection and clear stale import data', async () => {
  const csv = name => 'Index,Title,Artist,3,4,5,6,7,8,9,10,File\n1,Title,Artist,,,,,,,,,' + name;
  const modal = hookHarness('configEditor/components/CsvImportModal.tsx');
  const props = { lastOffsetSec: null, onImport() {}, onClose() {} };
  const input = tree => elements(tree, node => node.type === 'input' && node.props.type === 'file')[0];
  const importButton = tree => elements(tree, node => node.type === 'button' && node.props.className === 'btn btn-primary')[0];
  let resolveFirst;
  const first = input(modal.render(props)).props.onChange({ target: { files: [{ name: 'first.csv', text: () => new Promise(resolve => { resolveFirst = resolve; }) }] } });
  assert.equal(importButton(modal.render(props)).props.disabled, true);
  await input(modal.render(props)).props.onChange({ target: { files: [{ name: 'second.csv', text: async () => csv('second.mp3') }] } });
  resolveFirst(csv('first.mp3')); await first;
  const fileCells = elements(modal.render(props), node => node.type === 'td' && node.props.className === 'mono');
  assert.equal(fileCells[0].props.children, 'second.mp3');
  await input(modal.render(props)).props.onChange({ target: { files: [{ name: 'broken.csv', text: async () => { throw new Error('read failure'); } }] } });
  assert.equal(importButton(modal.render(props)).props.disabled, true);
});

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function preferenceEnvironment(t) {
  const timers = new Map();
  const listeners = new Map();
  let id = 0;
  t.mock.method(globalThis, 'setTimeout', fn => { timers.set(++id, fn); return id; });
  t.mock.method(globalThis, 'clearTimeout', key => timers.delete(key));
  const previousWindow = globalThis.window;
  globalThis.window = {
    addEventListener(type, listener) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  t.after(() => { globalThis.window = previousWindow; });
  return {
    flushTimers() { for (const [key, fn] of [...timers]) { timers.delete(key); fn(); } },
    event(type, event = {}) { for (const listener of listeners.get(type) ?? []) listener(event); },
  };
}

test('settings writer serializes requests and only acknowledges the latest intent', async () => {
  const { SettingsWriter } = loadSource('settingsWriter.ts');
  const requests = [], acknowledged = [], states = [];
  const writer = new SettingsWriter(value => { const request = deferred(); requests.push({ value, ...request }); return request.promise; }, value => acknowledged.push(value), state => states.push(state));
  writer.schedule(10, true); await settle();
  writer.schedule(20, true); writer.schedule(30, true); await settle();
  assert.equal(requests.length, 1);
  requests[0].resolve(10); await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].value, 30);
  assert.deepEqual(acknowledged, []);
  requests[1].resolve(30); await settle();
  assert.deepEqual(acknowledged, [30]);
  assert.equal(states.at(-1).phase, 'idle');
  writer.dispose();
});

test('failed settings patches remain retryable and retain edits from an earlier failed request', async () => {
  const { SettingsWriter } = loadSource('settingsWriter.ts');
  const requests = [], states = [];
  const writer = new SettingsWriter(value => { const request = deferred(); requests.push({ value, ...request }); return request.promise; }, () => {}, state => states.push(state), (a, b) => ({ ...a, ...b }));
  writer.schedule({ max_duration_sec: 60 }, true); await settle();
  writer.schedule({ enable_freewheeling: false }, true);
  requests[0].reject(new Error('first failed')); await settle();
  assert.deepEqual(requests[1].value, { max_duration_sec: 60, enable_freewheeling: false });
  requests[1].reject(new Error('offline')); await settle();
  assert.equal(states.at(-1).phase, 'error');
  assert.equal(writer.hasUnsaved, true);
  writer.retry(); await settle();
  assert.deepEqual(requests[2].value, requests[1].value);
  requests[2].resolve(requests[2].value); await settle();
  assert.equal(writer.hasUnsaved, false);
  writer.dispose();
});

test('user preferences reject pre-hydration writes, preserve unknown keys and flush pagehide', async t => {
  const env = preferenceEnvironment(t);
  const hydration = deferred(); const requests = [];
  const real = loadSource('userSettings.ts');
  const harness = hookHarness('useSettingsPersistence.ts', { './userSettings.js': {
    ...real, fetchAllUsers: () => hydration.promise,
    putUserSettings(name, value) { const request = deferred(); requests.push({ name, value, ...request }); return request.promise; },
  } }, 'useUserPreferences');
  harness.render(); harness.effects();
  harness.render().update('Jan', { detailZoomSec: 30 }); env.flushTimers(); await settle();
  assert.equal(requests.length, 0);
  hydration.resolve({ 'Default User': {}, Jan: { role: 'DJ', deckLayout: 2, futureSetting: { retained: true } }, Dennis: {} }); await settle();
  assert.equal(harness.render().ready, true);
  harness.render().update('Jan', { detailZoomSec: 20 });
  env.event('pagehide'); await settle();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].value.futureSetting, { retained: true });
  harness.render().update('Jan', { deckLayout: 4 }); env.flushTimers(); await settle();
  assert.equal(requests.length, 1);
  requests[0].resolve(requests[0].value); await settle();
  assert.equal(harness.render().users.Jan.deckLayout, 4);
  assert.equal(requests[1].value.deckLayout, 4);
  assert.equal(requests[1].value.detailZoomSec, 20);
  requests[1].resolve(requests[1].value); await settle();
  assert.equal(harness.render().saveStates.Jan.phase, 'idle');
  harness.cleanup();
});

test('failed preference hydration is visible and can be retried without writing defaults', async t => {
  preferenceEnvironment(t);
  let attempts = 0;
  const real = loadSource('userSettings.ts');
  const harness = hookHarness('useSettingsPersistence.ts', { './userSettings.js': {
    ...real, async fetchAllUsers() { if (++attempts === 1) throw new Error('offline'); return { 'Default User': { role: 'DJ' }, Jan: {}, Dennis: {} }; },
    putUserSettings() { assert.fail('must not write during hydration'); },
  } }, 'useUserPreferences');
  harness.render(); harness.effects(); await settle();
  assert.equal(harness.render().ready, false);
  assert.match(harness.render().loadError, /offline/);
  await harness.render().reload();
  assert.equal(harness.render().ready, true);
  assert.equal(harness.render().users['Default User'].role, 'DJ');
  harness.cleanup();
});

test('freewheel slider coalesces, toggle stays immediate and stale refresh cannot undo it', async t => {
  const env = preferenceEnvironment(t);
  const loads = [], writes = [];
  const real = loadSource('globalSettings.ts');
  const harness = hookHarness('useSettingsPersistence.ts', { './globalSettings.js': {
    ...real,
    fetchGlobalSettings() { const request = deferred(); loads.push(request); return request.promise; },
    putFreewheelSettings(value) { const request = deferred(); writes.push({ value, ...request }); return request.promise; },
  } }, 'useFreewheelPreferences');
  harness.render(); harness.effects();
  loads[0].resolve({ freewheel: { enable_freewheeling: true, max_duration_sec: 30 } }); await settle();
  const refresh = harness.render().refresh();
  harness.render().update({ max_duration_sec: 60 }); harness.render().update({ max_duration_sec: 120 });
  env.flushTimers(); await settle();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].value, { max_duration_sec: 120 });
  harness.render().update({ enable_freewheeling: false });
  loads[1].resolve({ freewheel: { enable_freewheeling: true, max_duration_sec: 30 } }); await refresh;
  assert.equal(harness.render().freewheel.enable_freewheeling, false);
  writes[0].resolve({ enable_freewheeling: true, max_duration_sec: 120 }); await settle();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].value, { enable_freewheeling: false });
  assert.equal(harness.render().freewheel.enable_freewheeling, false);
  writes[1].resolve({ enable_freewheeling: false, max_duration_sec: 120 }); await settle();
  assert.equal(harness.render().saveState.phase, 'idle');
  harness.cleanup();
});

test('waveform status belongs to its file and valid early status survives until the snapshot', t => {
  const env = socketEnvironment(t);
  const app = hookHarness('App.tsx'); app.render(); app.effects();
  const socket = env.sockets[0]; socket.open();
  const frame = message => socket.onmessage({ data: JSON.stringify(message) });
  frame({ type: 'waveform_data', fileName: 'B.mp3', trackId: 'net://device/USB/B.mp3', peaks: [0.5], peaksPerSec: 200 });
  socket.snapshot(1, 'B.mp3');
  frame({ type: 'waveform_status', deck: 1, fileName: 'A.mp3', trackId: 'net://device/USB/A.mp3', stage: 'error', progress: 0 });
  const waveform = () => elements(app.render(), node => node.type?.name === 'DeckCard')[0].props.waveform;
  assert.equal(waveform().fileName, 'B.mp3'); assert.equal(waveform().stage, 'ready');
  frame({ type: 'waveform_status', deck: 1, fileName: 'C.mp3', trackId: 'net://device/USB/C.mp3', stage: 'generating', progress: 40 });
  socket.snapshot(2, 'C.mp3');
  assert.equal(waveform().fileName, 'C.mp3'); assert.equal(waveform().progress, 40);
  app.cleanup();
});

test('Papa Parse accepts multiline/quotes/BOM/CRLF and mapped Engine headers', () => {
  const { parseCSV } = loadSource('configEditor/utils/csv.ts');
  const rows = parseCSV('\ufeffArtist,File name,Title\r\nDJ,"C:\\Music\\track.mp3","First line\nSecond ""quoted"" line"\r\n');
  assert.deepEqual(rows, [{ artist: 'DJ', fileName: 'track.mp3', title: 'First line\nSecond "quoted" line' }]);
  assert.throws(() => parseCSV('Title,Artist\nSong,DJ'), /File name column/);
  assert.throws(() => parseCSV('Title,Artist,File name\nSong,DJ'), /record 2.*columns/);
  assert.throws(() => parseCSV('Title,Artist,File name\n"Unclosed,DJ,a.mp3'), /CSV record/);
  assert.throws(() => parseCSV('Title,Artist,File name\nSong,DJ,'), /no file name/);
});


test('deleting any track or mashup preserves retained offsets and frames', () => {
  const { DEFAULT_CONFIG } = loadSource('configEditor/defaults.ts');
  const entries = [
    { song_index: 'A.mp3', offset_sec: 10800, offset_frame: 7, note: { description: '', show_secs_after_load: 0 } },
    { song_index: 'mashup.mp3', offset_sec: 0, offset_frame: 12, mashup_only: true, note: { description: '', show_secs_after_load: 0 } },
    { song_index: 'B.mp3', offset_sec: 11400, offset_frame: 29, note: { description: '', show_secs_after_load: 0 } },
  ];
  for (const index of [0, 1, 2]) {
    const editor = hookHarness('configEditor/components/PlaylistEditor.tsx', {}, 'PlaylistEditor');
    let changed;
    const tree = editor.render({ config: { ...DEFAULT_CONFIG, playlists: [{ name: 'Set', content: entries }] }, onChange(value) { changed = value; } });
    elements(tree, node => node.props?.title === 'Delete')[index].props.onClick();
    assert.deepEqual(changed.playlists[0].content, entries.filter((_, i) => i !== index));
  }
});

test('playlist deletion clears active selection or preserves the surviving active identity', () => {
  const { DEFAULT_CONFIG } = loadSource('configEditor/defaults.ts');
  const playlists = ['A', 'B', 'C'].map(name => ({ name, content: [] }));
  for (const [active, deleted, expected] of [[1, 1, -1], [1, 0, 0], [1, 2, 1], [2, 0, 1], [-1, 0, -1], [0, 0, -1]]) {
    const editor = hookHarness('configEditor/components/PlaylistEditor.tsx', {}, 'PlaylistEditor');
    let changed;
    const tree = editor.render({ config: { ...DEFAULT_CONFIG, current_playlist: active, playlists }, onChange(value) { changed = value; } });
    elements(tree, node => node.props?.title === 'Delete playlist')[deleted].props.onClick({ stopPropagation() {} });
    assert.equal(changed.current_playlist, expected);
    if (expected >= 0) assert.equal(changed.playlists[expected].name, playlists[active].name);
  }
});

test('same-basename media frames never cross source paths, including before snapshots', t => {
  const env = socketEnvironment(t);
  const app = hookHarness('App.tsx'); app.render(); app.effects();
  const socket = env.sockets[0]; socket.open();
  const frame = message => socket.onmessage({ data: JSON.stringify(message) });
  const first = 'net://device/USB/one/same.mp3', second = 'net://device/USB/two/same.mp3';
  frame({ type: 'waveform_data', fileName: 'same.mp3', trackId: first, peaks: [0.25], peaksPerSec: 200 });
  socket.snapshot(1, 'same.mp3', first);
  const waveform = () => elements(app.render(), node => node.type?.name === 'DeckCard')[0].props.waveform;
  assert.deepEqual(waveform().peaks, [0.25]);
  socket.snapshot(2, 'same.mp3', second);
  assert.equal(waveform().peaks, null);
  frame({ type: 'waveform_status', deck: 1, fileName: 'same.mp3', trackId: first, stage: 'error', progress: 0 });
  assert.equal(waveform().stage, null);
  frame({ type: 'waveform_data', fileName: 'same.mp3', trackId: second, peaks: [0.75], peaksPerSec: 200 });
  assert.deepEqual(waveform().peaks, [0.75]);
  app.cleanup();
});

test('browser media LRU bounds peaks and blobs, protects active tracks and revokes URLs', t => {
  const { MediaCache } = loadSource('mediaCache.ts');
  const revoked = []; let sequence = 0; let now = 0;
  t.mock.method(URL, 'createObjectURL', () => 'blob:' + ++sequence);
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  t.mock.method(Date, 'now', () => now);
  const cache = new MediaCache(1024, 2);
  cache.setPeaks('active', [0.2], 200); cache.setActive(['active']);
  cache.setArtwork('old', new Blob(['abc']));
  now = 4000;
  cache.setPeaks('next', [0.4], 200);
  assert.ok(cache.get('active')); assert.ok(cache.get('next')); assert.equal(cache.get('old'), undefined);
  assert.deepEqual(revoked, ['blob:1']);
  cache.setArtwork('next', new Blob(['def'])); cache.setArtwork('next', null);
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
  cache.setPeaks('oversize', Array(200).fill(0.2), 200);
  assert.equal(cache.get('oversize'), undefined); assert.ok(cache.byteLength <= 1024);
  cache.setPeaks('invalid', [NaN], 200); assert.equal(cache.get('invalid'), undefined);
  cache.setArtwork('active', new Blob(['ghi'])); cache.clear();
  assert.equal(cache.size, 0); assert.deepEqual(revoked, ['blob:1', 'blob:2', 'blob:3']);
});

test('persistent recorder failures are visible without an operator request', () => {
  const Controls = loadSource('RecordingControls.tsx').default;
  const html = renderToStaticMarkup(React.createElement(Controls, { recordingStatus: { active: false, error: 'Recording stopped: storage queue exceeded limit' }, replayStatus: null }));
  assert.match(html, /role="alert"/); assert.match(html, /storage queue exceeded limit/);
});

test('rapid pending media never evicts active media while an inactive entry can be dropped', () => {
  const { MediaCache } = loadSource('mediaCache.ts');
  const cache = new MediaCache(1024, 2);
  cache.setPeaks('active', [0.2], 200); cache.setActive(['active']);
  cache.setPeaks('pending1', [0.4], 200); cache.setPeaks('pending2', [0.6], 200);
  assert.ok(cache.get('active')); assert.ok(cache.get('pending2'));
  assert.equal(cache.get('pending1'), undefined); assert.equal(cache.size, 2);
});
