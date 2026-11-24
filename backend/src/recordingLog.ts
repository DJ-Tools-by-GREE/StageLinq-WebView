import fs from 'node:fs';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { RECORDING_CHECKPOINT_EVENTS, RECORDING_MAX_LINE_BYTES } from './constants.js';
import type { DeckNumber, DeckState, StageLinqStatus } from './types.js';

export type TrackOffsets = Record<string, { offsetSec: number; offsetFrame: number }>;
export interface RecordedTiming {
  positionT: number | null;
  positionRevision: number;
  transportRevision: number;
  transportPlay?: boolean;
  trackId: string;
}
export interface DeckEvent {
  t: number;
  n: DeckNumber;
  state?: DeckState;
  diff?: Partial<Omit<DeckState, 'deck'>>;
  timing?: RecordedTiming;
}
export interface RecordingCheckpoint {
  t: number;
  cursor: number;
  decks: Record<DeckNumber, DeckState>;
  timings: Record<DeckNumber, RecordedTiming>;
  positionEventIds: Record<DeckNumber, number>;
}
export interface ParsedLog {
  version: 1 | 2;
  startedAt: number;
  stoppedAt: number | null;
  durationMs: number;
  eventCount: number;
  deckEvents: DeckEvent[];
  selectedEvents: Array<{ t: number; deck: DeckNumber | null }>;
  statusEvents: Array<{ t: number; value: StageLinqStatus }>;
  configEvents: Array<{ t: number; trackOffsets: TrackOffsets; playlistRef: string }>;
  gaps: Array<{ t: number; lastEventT: number; gapMs: number }>;
  trackOffsets: TrackOffsets;
  trackOffsetsFromHeader: TrackOffsets | null;
  playlistRef: string;
  checkpoints: RecordingCheckpoint[];
  lastEmitted: Record<DeckNumber, DeckState | null>;
  truncateTo: number | null;
  needsNewline: boolean;
  timingSource: string;
}

export const RECORDING_DECKS: DeckNumber[] = [1, 2, 3, 4];
export function blankRecordedDeck(deck: DeckNumber): DeckState {
  return { deck, trackLoaded: false, fileName: '', mediaId: '', title: '—', artist: '—',
    elapsedSec: 0, totalSec: 0, currentBpm: 0, trackBpm: 0, speedState: 0,
    keyIndex: null, keyCamelot: '--', fader: 0, play: false, updatedAt: 0,
    hotCues: [], loopActive: false, loopInSec: null, loopOutSec: null, savedLoops: [] };
}
export function blankRecordedTiming(): RecordedTiming {
  return { positionT: null, positionRevision: 0, transportRevision: 0, trackId: '' };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function deckNumber(value: unknown): value is DeckNumber { return value === 1 || value === 2 || value === 3 || value === 4; }
function requireValue(test: boolean, message: string): asserts test { if (!test) throw new Error(message); }
function validOffsets(value: unknown): TrackOffsets {
  requireValue(object(value), 'invalid recorded track offsets');
  const entries: Array<[string, { offsetSec: number; offsetFrame: number }]> = [];
  for (const [key, offset] of Object.entries(value)) {
    requireValue(object(offset) && finite(offset.offsetSec) && finite(offset.offsetFrame), 'invalid recorded track offset');
    entries.push([key, { offsetSec: offset.offsetSec, offsetFrame: offset.offsetFrame }]);
  }
  return Object.fromEntries(entries);
}
function validTiming(value: unknown): RecordedTiming {
  requireValue(object(value), 'invalid source timing');
  requireValue(value.positionT === null || finite(value.positionT), 'invalid source position timestamp');
  requireValue(Number.isSafeInteger(value.positionRevision) && Number(value.positionRevision) >= 0 &&
    Number.isSafeInteger(value.transportRevision) && Number(value.transportRevision) >= 0 && typeof value.trackId === 'string', 'invalid source revisions/identity');
  requireValue(value.transportPlay === undefined || typeof value.transportPlay === 'boolean', 'invalid source transport play');
  return { positionT: value.positionT as number | null, positionRevision: Number(value.positionRevision),
    transportRevision: Number(value.transportRevision), trackId: value.trackId, ...(value.transportPlay === undefined ? {} : { transportPlay: value.transportPlay }) };
}
function validState(value: unknown, n: DeckNumber, full: boolean): DeckState | Partial<DeckState> {
  requireValue(object(value), 'invalid deck state/diff');
  if (full) requireValue(finite(value.elapsedSec) && typeof value.play === 'boolean', 'invalid recording deck keyframe');
  const out: Record<string, unknown> = {};
  const strings = new Set(['fileName', 'mediaId', 'title', 'artist', 'keyCamelot']);
  const bools = new Set(['trackLoaded', 'play', 'loopActive']);
  const numbers = new Set(['elapsedSec', 'totalSec', 'currentBpm', 'trackBpm', 'speedState', 'fader', 'updatedAt']);
  for (const [key, val] of Object.entries(value)) {
    if (key === 'deck') { requireValue(val === n, 'deck number differs from event'); continue; }
    if (strings.has(key)) requireValue(typeof val === 'string', 'invalid deck ' + key);
    else if (bools.has(key)) requireValue(typeof val === 'boolean', 'invalid deck ' + key);
    else if (numbers.has(key)) requireValue(finite(val), 'invalid deck ' + key);
    else if (key === 'keyIndex') requireValue(val === null || (Number.isInteger(val) && Number(val) >= 0 && Number(val) <= 23), 'invalid deck keyIndex');
    else if (key === 'loopInSec' || key === 'loopOutSec') requireValue(val === null || finite(val), 'invalid deck ' + key);
    else if (key === 'hotCues' || key === 'savedLoops') {
      requireValue(Array.isArray(val) && val.length <= 8, 'invalid deck ' + key);
      for (const cue of val) {
        requireValue(object(cue) && Number.isInteger(cue.index) && Number(cue.index) >= 1 && Number(cue.index) <= 8, 'invalid cue index');
        if (key === 'hotCues') requireValue(finite(cue.sec), 'invalid hot cue');
        else requireValue(finite(cue.inSec) && finite(cue.outSec) && typeof cue.active === 'boolean', 'invalid saved loop');
      }
    } else continue; // Forward-compatible fields cannot overwrite core state.
    out[key] = val;
  }
  return full ? { ...blankRecordedDeck(n), ...out, deck: n } : out;
}

export function applyRecordedEvent(
  e: DeckEvent, decks: Record<DeckNumber, DeckState>, timings: Record<DeckNumber, RecordedTiming>,
  positionIds: Record<DeckNumber, number>, eventId: number,
): void {
  const prior = timings[e.n];
  const update = e.state ?? e.diff ?? {};
  if (e.timing) {
    if (e.timing.positionT !== null && (e.timing.positionRevision !== prior.positionRevision || e.timing.trackId !== prior.trackId || e.timing.positionT !== prior.positionT)) {
      positionIds[e.n] = eventId;
    }
    const transportPlay = e.timing.transportPlay ?? ((e.timing.transportRevision !== prior.transportRevision || prior.transportPlay === undefined) ? update.play ?? decks[e.n].play : prior.transportPlay);
    timings[e.n] = { ...e.timing, transportPlay };
  } else {
    if (Object.hasOwn(update, 'elapsedSec')) {
      prior.positionT = e.t;
      prior.positionRevision++;
      positionIds[e.n] = eventId;
    }
    if (Object.hasOwn(update, 'play')) { prior.transportRevision++; prior.transportPlay = update.play; }
    prior.trackId = String(update.mediaId ?? update.fileName ?? decks[e.n].mediaId ?? decks[e.n].fileName);
  }
  decks[e.n] = e.state ? { ...e.state } : { ...decks[e.n], ...e.diff };
}

export async function parseRecording(filePath: string, options: { collectEvents?: boolean; signal?: AbortSignal } = {}): Promise<ParsedLog> {
  const collect = options.collectEvents !== false;
  const result: ParsedLog = { version: 1, startedAt: 0, stoppedAt: null, durationMs: 0, eventCount: 0,
    deckEvents: [], selectedEvents: [], statusEvents: [], configEvents: [], gaps: [], trackOffsets: {},
    trackOffsetsFromHeader: null, playlistRef: '', checkpoints: [], lastEmitted: { 1: null, 2: null, 3: null, 4: null },
    truncateTo: null, needsNewline: false, timingSource: 'inferred from recorded positions and play events; raw BeatInfo provenance unavailable' };
  let seenHeader = false, seenKeyframe = false, seenFooter = false, sawLegacyTiming = false;
  let lastT = 0, unsorted = false, byteOffset = 0, lineNumber = 0;
  const parseLine = (bytes: Buffer, hasNewline: boolean) => {
    lineNumber++;
    requireValue(bytes.length <= RECORDING_MAX_LINE_BYTES, 'recording line exceeds limit at line ' + lineNumber);
    const line = bytes.toString('utf8').trim();
    if (!line) return;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch {
      if (!hasNewline && seenHeader && seenKeyframe) { result.truncateTo = byteOffset; return; }
      throw new Error('recording requires a valid header and deck keyframe; malformed JSON at line ' + lineNumber);
    }
    try {
      requireValue(object(ev) && typeof ev.type === 'string', 'invalid recording event');
      if (ev.type === 'header') {
        requireValue(!seenHeader && result.eventCount === 0, 'duplicate/misplaced recording header');
        requireValue(ev.v === undefined || ev.v === 1 || ev.v === 2, 'unsupported recording version');
        requireValue(finite(ev.startedAt) && ev.startedAt > 0, 'invalid header startedAt');
        result.version = ev.v === 2 ? 2 : 1;
        result.startedAt = ev.startedAt;
        if (ev.trackOffsets !== undefined) result.trackOffsetsFromHeader = result.trackOffsets = validOffsets(ev.trackOffsets);
        else requireValue(result.version === 1, 'version 2 header requires trackOffsets');
        requireValue(ev.playlistRef === undefined || typeof ev.playlistRef === 'string', 'invalid playlist reference');
        result.playlistRef = String(ev.playlistRef ?? '');
        seenHeader = true;
      } else {
        requireValue(seenHeader, 'recording requires a valid header and deck keyframe');
        requireValue(!seenFooter, 'event after recording footer');
        requireValue(finite(ev.t) && ev.t >= 0, 'invalid recording event timestamp');
        if (ev.t < lastT) { requireValue(result.version === 1, 'version 2 timestamps moved backwards'); unsorted = true; }
        lastT = ev.t;
        result.durationMs = Math.max(result.durationMs, ev.t);
        switch (ev.type) {
          case 'deck': {
            requireValue(deckNumber(ev.n), 'invalid recording deck number');
            requireValue((ev.state !== undefined) !== (ev.diff !== undefined), 'deck event needs exactly one state or diff');
            const event: DeckEvent = { t: ev.t, n: ev.n };
            if (ev.state !== undefined) {
              event.state = validState(ev.state, ev.n, true) as DeckState;
              result.lastEmitted[ev.n] = { ...event.state };
              seenKeyframe = true;
            } else {
              requireValue(result.lastEmitted[ev.n] !== null, 'deck diff precedes its keyframe');
              event.diff = validState(ev.diff, ev.n, false);
              result.lastEmitted[ev.n] = { ...result.lastEmitted[ev.n]!, ...event.diff };
            }
            if (ev.timing !== undefined) event.timing = validTiming(ev.timing);
            else sawLegacyTiming = true;
            if (collect) result.deckEvents.push(event);
            break;
          }
          case 'selected':
            requireValue(ev.deck === null || deckNumber(ev.deck), 'invalid selected deck');
            if (collect) result.selectedEvents.push({ t: ev.t, deck: ev.deck });
            break;
          case 'status':
            requireValue(ev.value === 'connected' || ev.value === 'no-device' || ev.value === 'reconnecting', 'invalid StageLinq status');
            if (collect) result.statusEvents.push({ t: ev.t, value: ev.value });
            break;
          case 'config': {
            const offsets = validOffsets(ev.trackOffsets);
            requireValue(typeof ev.playlistRef === 'string', 'invalid playlist reference');
            if (collect) result.configEvents.push({ t: ev.t, trackOffsets: offsets, playlistRef: ev.playlistRef });
            break;
          }
          case 'gap':
            requireValue(finite(ev.lastEventT) && ev.lastEventT >= 0 && ev.lastEventT <= ev.t && finite(ev.gapMs) && ev.gapMs >= 0, 'invalid recording gap');
            if (collect) result.gaps.push({ t: ev.t, lastEventT: ev.lastEventT, gapMs: ev.gapMs });
            break;
          case 'footer':
            requireValue(finite(ev.stoppedAt), 'invalid recording footer');
            if (ev.eventCount !== undefined) requireValue(Number.isSafeInteger(ev.eventCount) && ev.eventCount === result.eventCount + 1, 'recording footer event count mismatch');
            result.stoppedAt = ev.stoppedAt;
            seenFooter = true;
            break;
          default:
            requireValue(ev.optional === true || (result.version === 1 && ['sacn_execute', 'suggested'].includes(ev.type)), 'unknown required recording event ' + ev.type);
        }
      }
      result.eventCount++;
      if (!hasNewline) result.needsNewline = true;
    } catch (error) { throw new Error('Recording line ' + lineNumber + ': ' + (error as Error).message); }
  };
  let pending = Buffer.alloc(0);
  const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024, signal: options.signal });
  for await (const chunk of stream) {
    options.signal?.throwIfAborted();
    const data = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer;
    let start = 0, newline: number;
    while ((newline = data.indexOf(10, start)) !== -1) {
      parseLine(data.subarray(start, newline), true);
      byteOffset += newline - start + 1;
      start = newline + 1;
    }
    pending = Buffer.from(data.subarray(start));
    requireValue(pending.length <= RECORDING_MAX_LINE_BYTES, 'recording line exceeds limit at line ' + (lineNumber + 1));
    await yieldIO();
  }
  if (pending.length) parseLine(pending, false);
  requireValue(seenHeader && seenKeyframe, 'recording requires a valid header and deck keyframe');
  if (result.version === 1 && result.stoppedAt !== null) result.durationMs = Math.max(result.durationMs, result.stoppedAt - result.startedAt);
  if (!sawLegacyTiming) result.timingSource = 'recorded source position and explicit transport revisions';
  else if (result.version === 2) result.timingSource = 'mixed recorded source timing and legacy inferred events';
  if (collect) {
    if (unsorted) {
      result.deckEvents.sort((a, b) => a.t - b.t);
      result.selectedEvents.sort((a, b) => a.t - b.t);
      result.statusEvents.sort((a, b) => a.t - b.t);
      result.configEvents.sort((a, b) => a.t - b.t);
    }
    const decks = Object.fromEntries(RECORDING_DECKS.map(d => [d, blankRecordedDeck(d)])) as Record<DeckNumber, DeckState>;
    const timings = Object.fromEntries(RECORDING_DECKS.map(d => [d, blankRecordedTiming()])) as Record<DeckNumber, RecordedTiming>;
    const ids: Record<DeckNumber, number> = { 1: -1, 2: -1, 3: -1, 4: -1 };
    for (let i = 0; i < result.deckEvents.length; i++) {
      const e = result.deckEvents[i];
      applyRecordedEvent(e, decks, timings, ids, i + 1);
      if ((i + 1) % RECORDING_CHECKPOINT_EVENTS === 0) {
        result.checkpoints.push({ t: e.t, cursor: i + 1, decks: structuredClone(decks), timings: structuredClone(timings), positionEventIds: { ...ids } });
        options.signal?.throwIfAborted();
        await yieldIO();
      }
    }
  }
  return result;
}

export function latestAt<T extends { t: number }>(events: T[], t: number): T | undefined {
  let lo = 0, hi = events.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (events[mid].t <= t) lo = mid + 1; else hi = mid; }
  return events[lo - 1];
}
