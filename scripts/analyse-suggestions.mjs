#!/usr/bin/env node
/**
 * Replays a JSONL recording produced by backend/src/recorder.ts, recomputes
 * `suggestedDeck` at every event using the same logic as the live system, and
 * reports for each `selected` transition whether the suggestion already showed
 * the destination deck at the instant of the switch — the same value that
 * was on the lighting console's UI when the operator pressed CH1.
 *
 * No lookback window. Match the live-system semantics: the verdict for each
 * transition is the value of `currentSuggestedDeck` immediately before
 * `selectedDeck` changed.
 *
 * Usage: node scripts/analyse-suggestions.mjs <recording.jsonl> [config.json]
 *
 * The recording header captures `trackOffsets` but not the full playlist
 * content, so the script reads the playlist (mashup flags + ordering) from
 * config.json. If the playlist has been edited since the recording was made,
 * results may diverge — best to run this against the same config.json that
 * was active during recording.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LOG_PATH = process.argv[2];
const CONFIG_PATH = process.argv[3] ?? path.join(REPO_ROOT, 'config.json');

if (!LOG_PATH) {
  console.error('usage: node scripts/analyse-suggestions.mjs <recording.jsonl> [config.json]');
  process.exit(1);
}

const MIN_TRIGGER_B_ELAPSED_SEC = 30;        // mirrors backend/src/constants.ts

function stripJsonComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function normalizeTrackName(name) {
  return path.basename(String(name ?? '').trim());
}

function blankDeck(d) {
  return {
    deck: d, trackLoaded: false, fileName: '', title: '', artist: '',
    elapsedSec: 0, totalSec: 0, currentBpm: 0, trackBpm: 0, speedState: 0,
    keyIndex: null, keyCamelot: '', fader: 0, play: false,
    updatedAt: 0, hotCues: [], loopActive: false, loopInSec: null, loopOutSec: null, savedLoops: [],
  };
}

// === mirror of backend logic ===
function computeNextTrack(cfg, currentFileName) {
  const playlists = cfg?.playlists ?? [];
  const idx = Number(cfg?.current_playlist ?? -1);
  if (idx < 0 || idx >= playlists.length) return null;
  const playable = (playlists[idx].content ?? []).filter(item => item.mashup_only !== true);
  if (!currentFileName) return playable[0]?.song_index ?? null;
  const key = normalizeTrackName(currentFileName);
  const pos = playable.findIndex(item => normalizeTrackName(String(item.song_index ?? '')) === key);
  if (pos < 0) return null;
  return playable[pos + 1]?.song_index ?? null;
}

function findDeckForFile(decks, fileName) {
  if (!fileName) return null;
  const target = normalizeTrackName(fileName);
  const matches = [];
  for (const d of [1, 2, 3, 4]) {
    const ds = decks[d];
    if (!ds?.trackLoaded || !ds.fileName) continue;
    if (normalizeTrackName(ds.fileName) === target) matches.push(d);
  }
  if (matches.length === 0) return null;
  const playing = matches.find(d => decks[d].play);
  return playing ?? matches[0];
}

function computeSuggestedDeck(cfg, decks, selectedDeck) {
  if (!selectedDeck) return null;
  const selected = decks[selectedDeck];
  if (!selected) return null;
  const nextFile = computeNextTrack(cfg, selected.trackLoaded ? selected.fileName : null);
  if (!nextFile) return null;
  const candidate = findDeckForFile(decks, nextFile);
  if (!candidate) return null;
  if (candidate === selectedDeck) return null;
  const candDeck = decks[candidate];
  if (candDeck.loopActive) return null;
  const triggerA = candDeck.play === true;
  const triggerB =
    selected.play === false &&
    candDeck.trackLoaded === true &&
    Number.isFinite(selected.elapsedSec) &&
    selected.elapsedSec > MIN_TRIGGER_B_ELAPSED_SEC;
  if (!triggerA && !triggerB) return null;
  return candidate;
}
// === end mirror ===

const cfg = JSON.parse(stripJsonComments(fs.readFileSync(CONFIG_PATH, 'utf8')));

const decks = { 1: blankDeck(1), 2: blankDeck(2), 3: blankDeck(3), 4: blankDeck(4) };
let selectedDeck = null;
let currentSuggestedDeck = null;       // mirror of the live runtime's current suggestion
const transitions = [];                // { tMs, fromDeck, toDeck, fromFile, toFile, suggestedAtSwitch }
let firstStartedAt = null;

const rl = readline.createInterface({
  input: fs.createReadStream(LOG_PATH, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

let header = null;
let lineNo = 0;

for await (const rawLine of rl) {
  lineNo++;
  const line = rawLine.trim();
  if (!line) continue;
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (!ev || typeof ev !== 'object') continue;

  if (ev.type === 'header') {
    header = ev;
    firstStartedAt = ev.startedAt;
    continue;
  }
  if (ev.type === 'footer') continue;

  const t = Number(ev.t ?? 0);

  if (ev.type === 'deck' && ev.n != null) {
    const n = Number(ev.n);
    if (![1, 2, 3, 4].includes(n)) continue;
    if (ev.state) {
      decks[n] = { ...ev.state };
    } else if (ev.diff) {
      for (const [k, v] of Object.entries(ev.diff)) decks[n][k] = v;
    }
    // Recompute suggestion the same way the live snapshot loop does.
    currentSuggestedDeck = computeSuggestedDeck(cfg, decks, selectedDeck);
  } else if (ev.type === 'selected') {
    const newDeck = ev.deck === null || ev.deck === undefined ? null : Number(ev.deck);
    // Count any change to a non-null deck as a transition. The first non-null press
    // of the show counts too — the recording starts with selectedDeck === null until
    // the operator's first sACN edge arrives.
    if (newDeck !== null && newDeck !== selectedDeck) {
      // Sample the suggestion at the instant of the switch — this is the value
      // the lighting console would have seen on screen when the operator pressed CH1.
      transitions.push({
        tMs: t,
        fromDeck: selectedDeck,
        toDeck: newDeck,
        fromFile: decks[selectedDeck]?.fileName || '',
        toFile: decks[newDeck]?.fileName || '',
        suggestedAtSwitch: currentSuggestedDeck,
      });
    }
    selectedDeck = newDeck;
    // Live system also re-runs computeSuggestedDeck on the new selectedDeck the next tick.
    currentSuggestedDeck = computeSuggestedDeck(cfg, decks, selectedDeck);
  }
}

// === verdict per transition ===
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function trim(s, w = 38) {
  if (!s) return '—';
  return s.length <= w ? s : s.slice(0, w - 1) + '…';
}

console.log(`Recording: ${path.basename(LOG_PATH)}`);
console.log(`startedAt: ${new Date(firstStartedAt).toISOString()}`);
console.log(`Lines parsed: ${lineNo.toLocaleString()}`);
console.log(`Selected-deck transitions: ${transitions.length}`);
console.log(`Sampling: suggestion as of the moment of each CH1 press (no lookback).`);
console.log();

let okCount = 0;
let suggestedDifferentDeck = 0;
let noSuggestion = 0;
const verdicts = [];

for (const tr of transitions) {
  let verdict, mark;
  if (tr.suggestedAtSwitch === tr.toDeck) {
    verdict = 'OK'; mark = '✓'; okCount++;
  } else if (tr.suggestedAtSwitch !== null) {
    verdict = `WRONG-DECK(was=D${tr.suggestedAtSwitch})`; mark = '✗'; suggestedDifferentDeck++;
  } else {
    verdict = 'NO-SUGGEST'; mark = '·'; noSuggestion++;
  }
  verdicts.push({ ...tr, verdict, mark });
}

// Detailed table
console.log('TIME       D→D   FROM                                   → TO                                     RESULT');
console.log('────────── ───── ────────────────────────────────────── ────────────────────────────────────── ──────────');
for (const v of verdicts) {
  console.log(
    `${fmt(v.tMs)}   ${v.fromDeck}→${v.toDeck}   ${trim(v.fromFile, 38).padEnd(38)} → ${trim(v.toFile, 38).padEnd(38)} ${v.mark} ${v.verdict}`
  );
}

console.log();
console.log('────── Summary ──────');
console.log(`✓ OK (suggestion already showed destination):  ${okCount} / ${transitions.length}`);
console.log(`✗ WRONG-DECK (different deck was suggested):   ${suggestedDifferentDeck} / ${transitions.length}`);
console.log(`· NO-SUGGEST (no suggestion shown at switch):  ${noSuggestion} / ${transitions.length}`);

const pct = transitions.length > 0 ? (okCount / transitions.length * 100).toFixed(1) : '—';
console.log();
console.log(`Coverage: ${pct}% of operator transitions were already pre-suggested at the moment of the press.`);
