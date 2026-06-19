#!/usr/bin/env node
/**
 * Per-transition timing breakdown. For every `selected` deck change in the
 * recording, this script reports how early each potentially-useful signal
 * fired before the transition:
 *
 *   - Next track *loaded* on the candidate deck (fileName change).
 *   - Next track *played* on the candidate deck (play=true).
 *   - Outgoing-deck *fader pulled down* below thresholds.
 *   - Incoming-deck *fader brought up* above thresholds.
 *   - Outgoing-deck *play* went false.
 *   - The current trigger engine first showed the destination as `suggestedDeck`.
 *
 * Negative offsets mean "happened before the transition." Null means the signal
 * never reached the gate by the time the press happened.
 *
 * Usage:
 *   node scripts/analyse-transition-leadtimes.mjs <recording.jsonl> [config.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LOG_PATH = process.argv[2];
const CONFIG_PATH = process.argv[3] ?? path.join(REPO_ROOT, 'config.json');

if (!LOG_PATH) {
  console.error('usage: node scripts/analyse-transition-leadtimes.mjs <recording.jsonl> [config.json]');
  process.exit(1);
}

const MIN_TRIGGER_B_ELAPSED_SEC = 30;
const FADER_UP_THRESHOLD = 0.20;        // 20 % open == "operator bringing it in"
const FADER_DOWN_THRESHOLD = 0.80;      // dropped from full → below 80 % == "pulling it out"

function stripJsonComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}
function normalizeTrackName(name) { return path.basename(String(name ?? '').trim()); }
function blankDeck(d) {
  return {
    deck: d, trackLoaded: false, fileName: '', title: '', artist: '',
    elapsedSec: 0, totalSec: 0, currentBpm: 0, trackBpm: 0, speedState: 0,
    keyIndex: null, keyCamelot: '', fader: 0, play: false,
    updatedAt: 0, hotCues: [], loopActive: false, loopInSec: null, loopOutSec: null, savedLoops: [],
  };
}

// --- mirror of backend logic (same as analyse-suggestions.mjs) ---
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
  if (!candidate || candidate === selectedDeck) return null;
  if (decks[candidate].loopActive) return null;
  const triggerA = decks[candidate].play === true;
  const triggerB =
    selected.play === false &&
    decks[candidate].trackLoaded === true &&
    Number.isFinite(selected.elapsedSec) &&
    selected.elapsedSec > MIN_TRIGGER_B_ELAPSED_SEC;
  if (!triggerA && !triggerB) return null;
  return candidate;
}
// --- end mirror ---

const cfg = JSON.parse(stripJsonComments(fs.readFileSync(CONFIG_PATH, 'utf8')));
const decks = { 1: blankDeck(1), 2: blankDeck(2), 3: blankDeck(3), 4: blankDeck(4) };
const prevDecks = { 1: blankDeck(1), 2: blankDeck(2), 3: blankDeck(3), 4: blankDeck(4) };

let selectedDeck = null;
let currentSuggestedDeck = null;

// Per-deck history of timestamped events we care about.
// fileChanges: [{tMs, fileName}]   — every fileName transition
// playEdges:   [{tMs, value}]      — every play-state edge
// faderTrace:  [{tMs, fader}]      — every fader value change (cheap; bridge dedupes)
// firstSuggestedAt: number|null    — earliest tMs at which this deck was the active suggestion
//                                    AFTER the previous suggestion edge (i.e. for the run leading
//                                    into a transition). Reset on every selected change.
const history = {
  1: { fileChanges: [], playEdges: [], faderTrace: [] },
  2: { fileChanges: [], playEdges: [], faderTrace: [] },
  3: { fileChanges: [], playEdges: [], faderTrace: [] },
  4: { fileChanges: [], playEdges: [], faderTrace: [] },
};

// Active suggestion runs: when suggestion = deck N, store tStart. On change, archive the run
// per deck so we can answer "at what t did the suggestion engine first show deck N before the
// upcoming press?"
let suggestionRunStart = null;          // {tMs, deck}
const suggestionRuns = [];              // [{deck, startMs, endMs}]

const transitions = [];                 // populated below

let firstStartedAt = null;
let lineNo = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(LOG_PATH, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

for await (const rawLine of rl) {
  lineNo++;
  const line = rawLine.trim();
  if (!line) continue;
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (!ev || typeof ev !== 'object') continue;
  if (ev.type === 'header') { firstStartedAt = ev.startedAt; continue; }
  if (ev.type === 'footer') continue;

  const t = Number(ev.t ?? 0);

  if (ev.type === 'deck' && ev.n != null) {
    const n = Number(ev.n);
    if (![1, 2, 3, 4].includes(n)) continue;
    const before = decks[n];
    let after;
    if (ev.state) {
      after = { ...ev.state };
    } else if (ev.diff) {
      after = { ...before };
      for (const [k, v] of Object.entries(ev.diff)) after[k] = v;
    } else {
      continue;
    }
    decks[n] = after;

    // Track signal edges.
    if (before.fileName !== after.fileName && after.fileName) {
      history[n].fileChanges.push({ tMs: t, fileName: after.fileName });
    }
    if (before.play !== after.play) {
      history[n].playEdges.push({ tMs: t, value: after.play });
    }
    if (before.fader !== after.fader && Number.isFinite(after.fader)) {
      history[n].faderTrace.push({ tMs: t, fader: after.fader });
    }

    // Recompute suggestion same as the live snapshot loop.
    const sug = computeSuggestedDeck(cfg, decks, selectedDeck);
    if (sug !== currentSuggestedDeck) {
      if (suggestionRunStart) {
        suggestionRuns.push({ deck: suggestionRunStart.deck, startMs: suggestionRunStart.tMs, endMs: t });
      }
      suggestionRunStart = sug !== null ? { deck: sug, tMs: t } : null;
      currentSuggestedDeck = sug;
    }
  } else if (ev.type === 'selected') {
    const newDeck = ev.deck === null || ev.deck === undefined ? null : Number(ev.deck);
    // Count any change to a non-null deck as a transition. The first non-null press
    // of the show counts too — the recording starts with selectedDeck === null until
    // the operator's first sACN edge arrives.
    if (newDeck !== null && newDeck !== selectedDeck) {
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
    const sug = computeSuggestedDeck(cfg, decks, selectedDeck);
    if (sug !== currentSuggestedDeck) {
      if (suggestionRunStart) {
        suggestionRuns.push({ deck: suggestionRunStart.deck, startMs: suggestionRunStart.tMs, endMs: t });
      }
      suggestionRunStart = sug !== null ? { deck: sug, tMs: t } : null;
      currentSuggestedDeck = sug;
    }
  }
}

// Close out a final open suggestion run if any.
if (suggestionRunStart) suggestionRuns.push({ deck: suggestionRunStart.deck, startMs: suggestionRunStart.tMs, endMs: null });

// === per-transition lead-time extraction ===
// For each transition at tMs=T to deck `to`, find for the *to* deck:
//   - lastFileChangeBefore(T, fileName === toFile)        → "loaded at"
//   - lastPlayEdgeBefore(T, value === true)               → "played at"
//   - first time fader for `to` crossed FADER_UP_THRESHOLD upward, looking back from T
//   - first time fader for `from` crossed FADER_DOWN_THRESHOLD downward, looking back from T
//   - last play=false edge for `from` deck before T (if any)
//   - earliest tMs in the most-recent suggestion run for `to` (if any) that ended at or after T - epsilon

function findFirstUpwardCross(trace, threshold, untilT, lookbackMs = Infinity) {
  // Earliest tMs at which fader rose from <threshold to >=threshold within [untilT - lookback, untilT].
  // If the trace shows a sustained run above threshold ending at untilT, return the first sample
  // in that run (above-threshold streak with no dip). Returns null otherwise.
  if (!trace.length) return null;
  let result = null;
  let runStart = null;
  for (const sample of trace) {
    if (sample.tMs > untilT) break;
    if (sample.tMs < untilT - lookbackMs) continue;
    if (sample.fader >= threshold) {
      if (runStart === null) runStart = sample.tMs;
    } else {
      runStart = null;
    }
  }
  // If the trace ended above threshold at or before untilT, the most recent run is what counts.
  if (runStart !== null) result = runStart;
  return result;
}

function findFirstDownwardCross(trace, threshold, untilT, lookbackMs = Infinity) {
  // Earliest tMs at which fader fell from >=threshold to <threshold within window. Same shape:
  // returns the start of the most-recent below-threshold streak ending at or before untilT,
  // provided it follows an above-threshold sample within the window.
  if (!trace.length) return null;
  let runStart = null;
  let everAbove = false;
  for (const sample of trace) {
    if (sample.tMs > untilT) break;
    if (sample.tMs < untilT - lookbackMs) continue;
    if (sample.fader >= threshold) {
      everAbove = true;
      runStart = null;
    } else if (everAbove) {
      if (runStart === null) runStart = sample.tMs;
    }
  }
  return runStart;
}

function lastPlayEdge(edges, value, untilT) {
  let result = null;
  for (const e of edges) {
    if (e.tMs > untilT) break;
    if (e.value === value) result = e.tMs;
  }
  return result;
}

function lastFileLoad(changes, fileName, untilT) {
  if (!fileName) return null;
  const target = normalizeTrackName(fileName);
  let result = null;
  for (const c of changes) {
    if (c.tMs > untilT) break;
    if (normalizeTrackName(c.fileName) === target) result = c.tMs;
  }
  return result;
}

function suggestionLeadTimeForTransition(tr) {
  // Find the latest-ended suggestion run whose deck === tr.toDeck and that overlapped tr.tMs
  // (i.e. endMs is null or >= tr.tMs and startMs < tr.tMs). The lead time is tr.tMs - startMs.
  for (let i = suggestionRuns.length - 1; i >= 0; i--) {
    const r = suggestionRuns[i];
    if (r.deck !== tr.toDeck) continue;
    if (r.startMs >= tr.tMs) continue;
    if (r.endMs !== null && r.endMs < tr.tMs) continue;
    return tr.tMs - r.startMs;
  }
  return null;
}

const HOUR_LOOKBACK = 5 * 60_000; // bound the lookback to 5 min so a fader that's been at 0 since boot doesn't claim "moved 30 min ago"

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
function leadStr(leadMs) {
  if (leadMs === null || leadMs === undefined) return '   —    ';
  const s = leadMs / 1000;
  if (s < 1) return `${(s * 1000).toFixed(0).padStart(4, ' ')}ms `;
  if (s < 100) return `${s.toFixed(1).padStart(5, ' ')}s  `;
  return `${s.toFixed(0).padStart(5, ' ')}s  `;
}

const rows = [];
for (const tr of transitions) {
  const toLoadedAt = lastFileLoad(history[tr.toDeck].fileChanges, tr.toFile, tr.tMs);
  const toPlayedAt = lastPlayEdge(history[tr.toDeck].playEdges, true, tr.tMs);
  const toFaderUpAt = findFirstUpwardCross(history[tr.toDeck].faderTrace, FADER_UP_THRESHOLD, tr.tMs, HOUR_LOOKBACK);
  const fromFaderDownAt = tr.fromDeck !== null
    ? findFirstDownwardCross(history[tr.fromDeck].faderTrace, FADER_DOWN_THRESHOLD, tr.tMs, HOUR_LOOKBACK)
    : null;
  const fromStoppedAt = tr.fromDeck !== null
    ? lastPlayEdge(history[tr.fromDeck].playEdges, false, tr.tMs)
    : null;
  const sugLeadMs = suggestionLeadTimeForTransition(tr);

  rows.push({
    tr,
    leads: {
      sug:        sugLeadMs,
      loaded:     toLoadedAt    !== null ? tr.tMs - toLoadedAt    : null,
      played:     toPlayedAt    !== null ? tr.tMs - toPlayedAt    : null,
      faderUp:    toFaderUpAt   !== null ? tr.tMs - toFaderUpAt   : null,
      faderDown:  fromFaderDownAt !== null ? tr.tMs - fromFaderDownAt : null,
      fromStop:   fromStoppedAt !== null ? tr.tMs - fromStoppedAt : null,
    },
  });
}

// === report ===
console.log(`Recording: ${path.basename(LOG_PATH)}`);
console.log(`startedAt: ${new Date(firstStartedAt).toISOString()}`);
console.log(`Transitions: ${transitions.length}`);
console.log();
console.log(`Lead times = how long BEFORE the press each signal fired. — = signal never fired.`);
console.log(`FADER thresholds: up >= ${FADER_UP_THRESHOLD} (incoming), down < ${FADER_DOWN_THRESHOLD} (outgoing).`);
console.log();

console.log('TIME       D→D    SUG       NEXT-LOAD  NEXT-PLAY  IN-FADER↑  OUT-FADER↓ OUT-STOP   VERDICT');
console.log('────────── ────── ───────── ────────── ────────── ────────── ────────── ────────── ─────────');
for (const { tr, leads } of rows) {
  const verdict =
    leads.sug !== null ? '✓ OK' : '· NO-SUG';
  console.log(
    `${fmt(tr.tMs)}   ${tr.fromDeck ?? '·'}→${tr.toDeck}    ${leadStr(leads.sug)} ${leadStr(leads.loaded)} ${leadStr(leads.played)} ${leadStr(leads.faderUp)} ${leadStr(leads.faderDown)} ${leadStr(leads.fromStop)} ${verdict}`
  );
}

// Aggregate stats across the OK and NO-SUG cohorts.
function statsFor(rows, label) {
  const sigs = ['sug', 'loaded', 'played', 'faderUp', 'faderDown', 'fromStop'];
  const out = {};
  for (const s of sigs) {
    const vals = rows.map(r => r.leads[s]).filter(v => v !== null);
    out[s] = vals.length
      ? { count: vals.length, p50: Math.round(quantile(vals, 0.5)), p25: Math.round(quantile(vals, 0.25)), p75: Math.round(quantile(vals, 0.75)) }
      : { count: 0, p50: null, p25: null, p75: null };
  }
  console.log(`\n── ${label} (n=${rows.length}) — lead-times in ms (p25 / p50 / p75) ──`);
  for (const s of sigs) {
    const v = out[s];
    if (v.count === 0) { console.log(`  ${s.padEnd(10)} —`); continue; }
    console.log(`  ${s.padEnd(10)} fired ${v.count}/${rows.length}   p25=${v.p25/1000}s  p50=${v.p50/1000}s  p75=${v.p75/1000}s`);
  }
}
function quantile(arr, q) {
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

statsFor(rows.filter(r => r.leads.sug !== null), 'OK transitions');
statsFor(rows.filter(r => r.leads.sug === null), 'NO-SUG transitions');

// Look for "if we'd had trigger X, would NO-SUG cases be caught?"
// Trigger candidates:
//   T-FaderDown : outgoing fader pulled down before press
//   T-FaderUp   : incoming fader brought up before press
//   T-NextLoaded: next playlist track loaded on the candidate (existing requirement, stricter than B)
const noSug = rows.filter(r => r.leads.sug === null);
console.log(`\n── Hypothetical recovery for NO-SUG cases (n=${noSug.length}) ──`);
let countLoaded = 0, countFaderUp = 0, countFaderDown = 0, countAny = 0;
for (const r of noSug) {
  const hasLoaded = r.leads.loaded !== null && r.leads.loaded >= 0;
  const hasFaderUp = r.leads.faderUp !== null && r.leads.faderUp >= 0;
  const hasFaderDown = r.leads.faderDown !== null && r.leads.faderDown >= 0;
  if (hasLoaded) countLoaded++;
  if (hasFaderUp) countFaderUp++;
  if (hasFaderDown) countFaderDown++;
  if (hasLoaded || hasFaderUp || hasFaderDown) countAny++;
}
console.log(`  next track loaded on candidate at press:               ${countLoaded}/${noSug.length}`);
console.log(`  incoming fader >= ${FADER_UP_THRESHOLD} at press:                       ${countFaderUp}/${noSug.length}`);
console.log(`  outgoing fader < ${FADER_DOWN_THRESHOLD} at press:                       ${countFaderDown}/${noSug.length}`);
console.log(`  any of the three signals available:                    ${countAny}/${noSug.length}`);
