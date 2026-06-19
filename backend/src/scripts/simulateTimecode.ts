/**
 * simulateTimecode — standalone Record & Replay timecode analyzer.
 *
 * Reads a `.jsonl` recording, reconstructs the four deck states across the
 * timeline, then runs one Art-Net-worker-equivalent timeline state machine
 * per deck *as if that deck were continuously sACN-selected*. Result is a
 * self-contained HTML page with an inline SVG graph overlaying every deck's
 * hypothetical timecode output, plus a JSON analysis blob at the bottom.
 *
 * Standalone: no UDP, no worker thread, no main app. Pure file in → file out.
 *
 * Usage:
 *   npm run -w backend simulate-tc -- <recording.jsonl>
 *   npm run -w backend simulate-tc -- recordings/foo.jsonl --out foo.html
 *   npm run -w backend simulate-tc -- recordings/foo.jsonl --fps 30 --latency 80
 *
 * The TC algorithm here is a faithful port of artnetWorker.ts → doSend():
 * timelineFrames, drift-snap (15% of one frame), latency comp, freewheel-on-
 * stall, speedState, clamp to track length. The only thing it doesn't do is
 * actually emit packets.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types (kept local so this script is movable/standalone) ────────────────
type DeckNumber = 1 | 2 | 3 | 4;
const DECKS: DeckNumber[] = [1, 2, 3, 4];

interface HotCue { index: number; sec: number }
interface SavedLoop { index: number; inSec: number; outSec: number; active: boolean }
interface DeckState {
  deck: DeckNumber;
  trackLoaded: boolean;
  fileName: string;
  title: string;
  artist: string;
  elapsedSec: number;
  totalSec: number;
  currentBpm: number;
  trackBpm: number;
  speedState: number;
  keyIndex: number | null;
  keyCamelot: string;
  fader: number;
  play: boolean;
  updatedAt: number;
  hotCues: HotCue[];
  loopActive: boolean;
  loopInSec: number | null;
  loopOutSec: number | null;
  savedLoops: SavedLoop[];
}

interface TrackOffset { offsetSec: number; offsetFrame: number }
type TrackOffsetMap = Record<string, TrackOffset>;

// ── CLI ────────────────────────────────────────────────────────────────────
interface Args {
  input: string;
  outHtml: string;
  outJson: string | null;
  configPath: string | null;
  fps: number;
  latencyMs: number;
  tickHz: number;
  freewheelMaxSec: number;
  enableFreewheel: boolean;
  staleMs: number;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key === 'no-freewheel') { opts['no-freewheel'] = '1'; continue; }
      if (next === undefined || next.startsWith('--')) opts[key] = '1';
      else { opts[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  if (positional.length === 0) {
    console.error('Usage: simulate-tc <recording.jsonl> [--out file.html] [--json file.json] [--config config.json] [--fps 30] [--latency 80] [--tickHz 30] [--freewheel-max 30] [--no-freewheel] [--stale-ms 250]');
    process.exit(2);
  }
  const input = path.resolve(positional[0]);
  const outHtml = opts.out ? path.resolve(opts.out) : input.replace(/\.jsonl$/i, '') + '.tc-analysis.html';
  const outJson = opts.json ? path.resolve(opts.json) : null;
  return {
    input,
    outHtml,
    outJson,
    configPath: opts.config ? path.resolve(opts.config) : null,
    fps: Number(opts.fps ?? 30),
    latencyMs: Number(opts.latency ?? 80),
    tickHz: Number(opts.tickHz ?? 30),
    freewheelMaxSec: Number(opts['freewheel-max'] ?? 30),
    enableFreewheel: !opts['no-freewheel'],
    staleMs: Number(opts['stale-ms'] ?? 250),
  };
}

// ── Log parser ─────────────────────────────────────────────────────────────
interface DeckEvent {
  t: number;
  n: DeckNumber;
  state?: DeckState;
  diff?: Partial<Omit<DeckState, 'deck'>>;
}
interface SelectedEvent { t: number; deck: DeckNumber | null }
interface GapEvent { t: number; lastEventT: number; gapMs: number }

interface ParsedLog {
  startedAt: number;
  durationMs: number;
  trackOffsetsFromHeader: TrackOffsetMap | null;
  deckEvents: DeckEvent[];
  selectedEvents: SelectedEvent[];
  gaps: GapEvent[];
}

function blankDeck(d: DeckNumber): DeckState {
  return {
    deck: d, trackLoaded: false, fileName: '', title: '—', artist: '—',
    elapsedSec: 0, totalSec: 0, currentBpm: 0, trackBpm: 0, speedState: 0,
    keyIndex: null, keyCamelot: '--', fader: 0, play: false, updatedAt: 0,
    hotCues: [], loopActive: false, loopInSec: null, loopOutSec: null, savedLoops: [],
  };
}

function parseLog(filePath: string): ParsedLog {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  let startedAt = 0;
  let stoppedAt = 0;
  let trackOffsetsFromHeader: TrackOffsetMap | null = null;
  const deckEvents: DeckEvent[] = [];
  const selectedEvents: SelectedEvent[] = [];
  const gaps: GapEvent[] = [];
  let maxT = 0;

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let ev: any;
    try { ev = JSON.parse(s); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'header') {
      startedAt = Number(ev.startedAt ?? 0);
      if (ev.trackOffsets && typeof ev.trackOffsets === 'object') {
        trackOffsetsFromHeader = ev.trackOffsets as TrackOffsetMap;
      }
      continue;
    }
    if (ev.type === 'footer') { stoppedAt = Number(ev.stoppedAt ?? 0); continue; }
    const t = Number(ev.t ?? 0);
    if (t > maxT) maxT = t;
    if (ev.type === 'deck') {
      const n = Number(ev.n) as DeckNumber;
      if (![1, 2, 3, 4].includes(n)) continue;
      if (ev.state) deckEvents.push({ t, n, state: ev.state });
      else if (ev.diff) deckEvents.push({ t, n, diff: ev.diff });
    } else if (ev.type === 'selected') {
      const deck = ev.deck === null || ev.deck === undefined ? null : (Number(ev.deck) as DeckNumber);
      selectedEvents.push({ t, deck });
    } else if (ev.type === 'gap') {
      gaps.push({ t, lastEventT: Number(ev.lastEventT ?? t), gapMs: Number(ev.gapMs ?? 0) });
    }
  }
  const durationMs = stoppedAt && startedAt ? Math.max(stoppedAt - startedAt, maxT) : maxT;
  return { startedAt, durationMs, trackOffsetsFromHeader, deckEvents, selectedEvents, gaps };
}

// ── Track-offset resolution (mirrors index.ts → buildTrackOffsetMap) ──────
function normalizeTrackName(name: string): string {
  return path.basename(String(name ?? '').trim());
}

function loadTrackOffsetsFromConfig(configPath: string): TrackOffsetMap {
  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw);
  const playlists: any[] = Array.isArray(cfg.playlists) ? cfg.playlists : [];
  const idx = Math.max(0, Math.min(playlists.length - 1, Number(cfg.current_playlist ?? 0)));
  const out: TrackOffsetMap = {};
  // Walk current playlist first (priority), then fall back to others.
  const ordered = [playlists[idx], ...playlists.filter((_, i) => i !== idx)].filter(Boolean);
  for (const pl of ordered) {
    const content: any[] = Array.isArray(pl.content) ? pl.content : [];
    for (const entry of content) {
      if (entry?.mashup_only) continue;
      const key = normalizeTrackName(String(entry?.song_index ?? ''));
      if (!key) continue;
      if (out[key]) continue;
      out[key] = {
        offsetSec: Number(entry.offset_sec ?? 0),
        offsetFrame: Number(entry.offset_frame ?? 0),
      };
    }
  }
  return out;
}

// ── Reconstruct per-deck state at any simulated wall-clock t ──────────────
// Pre-build, for each deck, the array of events in chronological order so we
// can sweep through with a single cursor.
class DeckTimeline {
  private events: DeckEvent[];
  private cursor = 0;
  private state: DeckState;
  constructor(deck: DeckNumber, events: DeckEvent[]) {
    this.events = events;
    this.state = blankDeck(deck);
  }
  /** Advance to the latest event with t <= tMs. Returns the deck state. */
  advanceTo(tMs: number): DeckState {
    while (this.cursor < this.events.length && this.events[this.cursor].t <= tMs) {
      const ev = this.events[this.cursor++];
      if (ev.state) {
        // Keyframe — replace the whole state but preserve deck #.
        this.state = { ...ev.state, deck: this.state.deck };
      } else if (ev.diff) {
        for (const k of Object.keys(ev.diff)) (this.state as any)[k] = (ev.diff as any)[k];
      }
    }
    return this.state;
  }
  /** Most recent event's t (for global staleness derivation). */
  lastEventT(): number {
    return this.cursor > 0 ? this.events[this.cursor - 1].t : -Infinity;
  }
}

// ── Per-deck TC state machine (faithful port of artnetWorker doSend) ──────
// One instance per deck, treated as if that deck is permanently sACN-selected.
const DRIFT_THRESHOLD_RATIO = 0.15;

interface PerDeckSim {
  deck: DeckNumber;
  timelineFrames: number | null;
  lastTickMs: number | null;
  staleSinceMs: number | null;
  // counters / flags surfaced in analysis
  driftSnapCount: number;
  freewheelSpans: { startMs: number; endMs: number | null }[];
  emittedSamples: number;
  firstEmitMs: number | null;
  lastEmitMs: number | null;
}

interface TickSample {
  /** Wall-clock ms since recording start. */
  tMs: number;
  /** TC totalFrames (post latency-comp, post clamp), or null if no packet. */
  tcFrames: number | null;
  /** Whether the per-deck sim is freewheeling this tick. */
  freewheel: boolean;
  /** True if the tick produced an emit (not stalled, deck playing, etc.). */
  emitted: boolean;
  /** Source deck's offsetted elapsedSec (for the analysis dump). */
  sourceSec: number;
  /** play state at this tick. */
  play: boolean;
  /** Filename loaded at this tick (post-normalization). */
  fileKey: string;
}

function makeSim(deck: DeckNumber): PerDeckSim {
  return {
    deck,
    timelineFrames: null,
    lastTickMs: null,
    staleSinceMs: null,
    driftSnapCount: 0,
    freewheelSpans: [],
    emittedSamples: 0,
    firstEmitMs: null,
    lastEmitMs: null,
  };
}

interface TickEnv {
  fps: number;
  latencyMs: number;
  freewheelMaxSec: number;
  enableFreewheel: boolean;
  staleMs: number;
  trackOffsets: TrackOffsetMap;
}

function applyOffset(raw: DeckState, offsets: TrackOffsetMap, fps: number): DeckState | null {
  if (!raw.fileName || raw.elapsedSec <= 0) return null;
  const fileKey = normalizeTrackName(raw.fileName);
  const offset = offsets[fileKey];
  if (!offset) return raw;
  const offsetSec = offset.offsetSec + offset.offsetFrame / fps;
  return {
    ...raw,
    elapsedSec: Math.max(0, raw.elapsedSec + offsetSec),
    totalSec: Math.max(0, raw.totalSec + offsetSec),
  };
}

function tickPerDeck(
  sim: PerDeckSim,
  raw: DeckState,
  tMs: number,
  globalLastEventT: number,
  env: TickEnv,
): TickSample {
  const fileKey = normalizeTrackName(raw.fileName || '');
  const source = applyOffset(raw, env.trackOffsets, env.fps);

  // No source ⇒ silent, reset timeline, no packet.
  if (!source) {
    sim.timelineFrames = null;
    sim.lastTickMs = null;
    return { tMs, tcFrames: null, freewheel: false, emitted: false, sourceSec: 0, play: raw.play, fileKey };
  }

  // Stale = no fresh deck event globally for > staleMs.
  const stale = globalLastEventT > -Infinity && (tMs - globalLastEventT) > env.staleMs;

  if (stale) {
    if (sim.staleSinceMs == null) sim.staleSinceMs = tMs;
  } else {
    sim.staleSinceMs = null;
  }

  if (stale) {
    if (!env.enableFreewheel) { sim.lastTickMs = null; closeFreewheelSpan(sim, tMs); return tcSample(tMs, null, false, false, source, raw.play, fileKey); }
    const stalledForSec = sim.staleSinceMs ? (tMs - sim.staleSinceMs) / 1000 : 0;
    if (stalledForSec > env.freewheelMaxSec) {
      sim.lastTickMs = null;
      closeFreewheelSpan(sim, tMs);
      return tcSample(tMs, null, false, false, source, raw.play, fileKey);
    }
  }

  const sourceSec = Number(source.elapsedSec) || 0;
  const sourceFrames = Math.max(0, sourceSec * env.fps);
  const treatAsPlaying = stale ? sim.lastTickMs !== null : raw.play === true;

  if (!treatAsPlaying) {
    sim.timelineFrames = sourceFrames;
    sim.lastTickMs = null;
    closeFreewheelSpan(sim, tMs);
    return tcSample(tMs, null, false, false, source, raw.play, fileKey);
  }

  const isFreewheelingNow = stale && env.enableFreewheel && sim.lastTickMs !== null;
  if (isFreewheelingNow) openFreewheelSpan(sim, tMs);
  else closeFreewheelSpan(sim, tMs);

  if (sim.timelineFrames == null) sim.timelineFrames = sourceFrames;
  if (sim.lastTickMs == null) {
    sim.lastTickMs = tMs;
    sim.timelineFrames = sourceFrames;
    // Worker returns here too — no packet on first sample.
    return tcSample(tMs, null, isFreewheelingNow, false, source, raw.play, fileKey);
  }

  const dtSec = Math.max(0, (tMs - sim.lastTickMs) / 1000);
  const playRate = 1 + (raw.speedState ?? 0) / 100;
  sim.timelineFrames += dtSec * env.fps * playRate;

  if (!stale) {
    const drift = Math.abs(sourceFrames - sim.timelineFrames);
    if (drift > env.fps * DRIFT_THRESHOLD_RATIO) {
      sim.driftSnapCount++;
      sim.timelineFrames = sourceFrames;
    }
    if (sim.timelineFrames < sourceFrames) sim.timelineFrames = sourceFrames;
  }

  if (sim.timelineFrames <= 0) return tcSample(tMs, null, isFreewheelingNow, false, source, raw.play, fileKey);

  sim.lastTickMs = tMs;

  const latencyCompFrames = (env.fps * env.latencyMs) / 1000;
  const rawFramePos = sim.timelineFrames + latencyCompFrames;
  if (rawFramePos < 0) return tcSample(tMs, null, isFreewheelingNow, false, source, raw.play, fileKey);

  let totalFrames = Math.floor(rawFramePos);
  const totalSec = Number(source.totalSec) || 0;
  if (totalSec > 0) {
    const maxFrame = Math.max(0, Math.floor(totalSec * env.fps) - 1);
    totalFrames = Math.min(totalFrames, maxFrame);
  }

  sim.emittedSamples++;
  if (sim.firstEmitMs == null) sim.firstEmitMs = tMs;
  sim.lastEmitMs = tMs;

  return { tMs, tcFrames: totalFrames, freewheel: isFreewheelingNow, emitted: true, sourceSec: source.elapsedSec, play: raw.play, fileKey };
}

function tcSample(
  tMs: number, tcFrames: number | null, freewheel: boolean, emitted: boolean,
  source: DeckState | null, play: boolean, fileKey: string,
): TickSample {
  return { tMs, tcFrames, freewheel, emitted, sourceSec: source?.elapsedSec ?? 0, play, fileKey };
}

function openFreewheelSpan(sim: PerDeckSim, tMs: number) {
  const last = sim.freewheelSpans[sim.freewheelSpans.length - 1];
  if (last && last.endMs == null) return;
  sim.freewheelSpans.push({ startMs: tMs, endMs: null });
}

function closeFreewheelSpan(sim: PerDeckSim, tMs: number) {
  const last = sim.freewheelSpans[sim.freewheelSpans.length - 1];
  if (last && last.endMs == null) last.endMs = tMs;
}

// ── Main: simulate, then render ────────────────────────────────────────────
function framesToHMSF(totalFrames: number, fps: number) {
  const frames = ((totalFrames % fps) + fps) % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = ((totalSeconds % 60) + 60) % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = ((totalMinutes % 60) + 60) % 60;
  const hours = ((Math.floor(totalMinutes / 60) % 24) + 24) % 24;
  return { hours, minutes, seconds, frames };
}

function fmtHMSF(totalFrames: number | null, fps: number): string {
  if (totalFrames == null) return '—';
  const t = framesToHMSF(totalFrames, fps);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(t.hours)}:${p2(t.minutes)}:${p2(t.seconds)}:${p2(t.frames)}`;
}

const DECK_COLORS: Record<DeckNumber, string> = {
  1: '#c084fc', // purple/magenta
  2: '#60a5fa', // blue
  3: '#4ade80', // green
  4: '#f87171', // red
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) {
    console.error(`Recording not found: ${args.input}`);
    process.exit(1);
  }
  console.log(`[simulate-tc] reading ${path.basename(args.input)}`);
  const log = parseLog(args.input);
  console.log(`[simulate-tc] events: ${log.deckEvents.length} deck, ${log.selectedEvents.length} selected, ${log.gaps.length} gaps`);
  console.log(`[simulate-tc] duration: ${(log.durationMs / 1000).toFixed(1)}s`);

  // Resolve track offsets: header takes priority (it's a snapshot of what was
  // active when the recording started); fall back to config.json beside the
  // repo root if requested or if the header didn't carry them.
  let trackOffsets: TrackOffsetMap = {};
  let offsetsSource = 'none';
  if (log.trackOffsetsFromHeader && Object.keys(log.trackOffsetsFromHeader).length > 0) {
    trackOffsets = log.trackOffsetsFromHeader;
    offsetsSource = 'recording-header';
  } else if (args.configPath) {
    trackOffsets = loadTrackOffsetsFromConfig(args.configPath);
    offsetsSource = `config (${args.configPath})`;
  } else {
    // Best-effort: try config.json at repo root.
    const guess = path.resolve(process.cwd(), 'config.json');
    if (fs.existsSync(guess)) {
      trackOffsets = loadTrackOffsetsFromConfig(guess);
      offsetsSource = `config (${guess})`;
    }
  }
  console.log(`[simulate-tc] track offsets: ${Object.keys(trackOffsets).length} entries (${offsetsSource})`);

  // Per-deck event partitions for fast cursor-walking.
  const eventsByDeck: Record<DeckNumber, DeckEvent[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const ev of log.deckEvents) eventsByDeck[ev.n].push(ev);
  const timelines: Record<DeckNumber, DeckTimeline> = {
    1: new DeckTimeline(1, eventsByDeck[1]),
    2: new DeckTimeline(2, eventsByDeck[2]),
    3: new DeckTimeline(3, eventsByDeck[3]),
    4: new DeckTimeline(4, eventsByDeck[4]),
  };

  // Sims, one per deck.
  const sims: Record<DeckNumber, PerDeckSim> = {
    1: makeSim(1), 2: makeSim(2), 3: makeSim(3), 4: makeSim(4),
  };

  const env: TickEnv = {
    fps: args.fps,
    latencyMs: args.latencyMs,
    freewheelMaxSec: args.freewheelMaxSec,
    enableFreewheel: args.enableFreewheel,
    staleMs: args.staleMs,
    trackOffsets,
  };

  // Sweep at tickHz over the full duration. Keep all samples for the JSON dump
  // but decimate for the SVG so the chart isn't 500k-point polylines.
  const tickStepMs = 1000 / args.tickHz;
  const totalTicks = Math.floor(log.durationMs / tickStepMs) + 1;

  // Decimation factor: aim for ~3000 chart points per deck.
  const CHART_POINTS_TARGET = 3000;
  const decimateEvery = Math.max(1, Math.floor(totalTicks / CHART_POINTS_TARGET));

  console.log(`[simulate-tc] simulating ${totalTicks} ticks @ ${args.tickHz} Hz (chart decim 1/${decimateEvery})…`);

  // Chart point arrays (one per deck): [{ tMs, tcFrames | null }]
  type ChartPt = { t: number; v: number | null };
  const chart: Record<DeckNumber, ChartPt[]> = { 1: [], 2: [], 3: [], 4: [] };

  // Per-deck stats accumulators (filename change list, etc.)
  const fileTimelinePerDeck: Record<DeckNumber, { tMs: number; fileKey: string }[]> = { 1: [], 2: [], 3: [], 4: [] };

  // Walk all deck events to drive `globalLastEventT` per tick. Cheaper to
  // recompute from a single sorted array of all events than to query each
  // timeline.
  const allEventTs = log.deckEvents.map(e => e.t).sort((a, b) => a - b);
  let allEvCursor = 0;
  let globalLastEventT = -Infinity;

  for (let tick = 0; tick < totalTicks; tick++) {
    const tMs = Math.min(log.durationMs, tick * tickStepMs);
    while (allEvCursor < allEventTs.length && allEventTs[allEvCursor] <= tMs) {
      globalLastEventT = allEventTs[allEvCursor];
      allEvCursor++;
    }
    const emitChart = (tick % decimateEvery) === 0 || tick === totalTicks - 1;
    for (const d of DECKS) {
      const raw = timelines[d].advanceTo(tMs);
      const sample = tickPerDeck(sims[d], raw, tMs, globalLastEventT, env);

      // Record file-change events.
      const filehist = fileTimelinePerDeck[d];
      const lastFile = filehist[filehist.length - 1];
      if (sample.fileKey && (!lastFile || lastFile.fileKey !== sample.fileKey)) {
        filehist.push({ tMs, fileKey: sample.fileKey });
      }

      if (emitChart) chart[d].push({ t: tMs, v: sample.tcFrames });
    }
  }

  // Close any still-open freewheel spans.
  for (const d of DECKS) closeFreewheelSpan(sims[d], log.durationMs);

  // ── Stats ────────────────────────────────────────────────────────────────
  const perDeckStats = DECKS.map(d => {
    const sim = sims[d];
    const emitMs = (sim.firstEmitMs != null && sim.lastEmitMs != null)
      ? (sim.lastEmitMs - sim.firstEmitMs) : 0;
    const fwTotalMs = sim.freewheelSpans.reduce(
      (sum, sp) => sum + ((sp.endMs ?? log.durationMs) - sp.startMs), 0,
    );
    return {
      deck: d,
      emittedSamples: sim.emittedSamples,
      tcSpanMs: emitMs,
      firstEmitMs: sim.firstEmitMs,
      lastEmitMs: sim.lastEmitMs,
      driftSnaps: sim.driftSnapCount,
      freewheelSpans: sim.freewheelSpans.length,
      freewheelTotalMs: fwTotalMs,
      filesPlayed: fileTimelinePerDeck[d].filter(e => e.fileKey).length,
    };
  });

  console.log('[simulate-tc] per-deck:');
  for (const s of perDeckStats) {
    console.log(
      `  deck ${s.deck}: emitted ${s.emittedSamples} samples, ` +
      `tc span ${(s.tcSpanMs / 1000).toFixed(1)}s, ` +
      `drift snaps ${s.driftSnaps}, ` +
      `freewheel ${s.freewheelSpans}× (${(s.freewheelTotalMs / 1000).toFixed(1)}s), ` +
      `files ${s.filesPlayed}`,
    );
  }

  // ── Render HTML ──────────────────────────────────────────────────────────
  const html = renderHtml({
    args,
    log,
    chart,
    perDeckStats,
    sims,
    fileTimelinePerDeck,
    trackOffsetsCount: Object.keys(trackOffsets).length,
    offsetsSource,
  });
  fs.writeFileSync(args.outHtml, html, 'utf8');
  console.log(`[simulate-tc] wrote ${args.outHtml}`);

  if (args.outJson) {
    const dump = {
      input: args.input,
      args,
      durationMs: log.durationMs,
      offsetsSource,
      trackOffsetsCount: Object.keys(trackOffsets).length,
      gaps: log.gaps,
      perDeckStats,
      filesPerDeck: fileTimelinePerDeck,
      freewheelSpansPerDeck: DECKS.reduce<Record<number, any[]>>((acc, d) => {
        acc[d] = sims[d].freewheelSpans;
        return acc;
      }, {}),
    };
    fs.writeFileSync(args.outJson, JSON.stringify(dump, null, 2), 'utf8');
    console.log(`[simulate-tc] wrote ${args.outJson}`);
  }
}

interface RenderInput {
  args: Args;
  log: ParsedLog;
  chart: Record<DeckNumber, { t: number; v: number | null }[]>;
  perDeckStats: any[];
  sims: Record<DeckNumber, PerDeckSim>;
  fileTimelinePerDeck: Record<DeckNumber, { tMs: number; fileKey: string }[]>;
  trackOffsetsCount: number;
  offsetsSource: string;
}

function renderHtml(r: RenderInput): string {
  const { args, log, chart, perDeckStats, sims, fileTimelinePerDeck } = r;
  const fps = args.fps;

  // Determine y-range across all chart series. y is TC seconds (totalFrames/fps).
  let yMin = Infinity, yMax = -Infinity;
  for (const d of DECKS) {
    for (const p of chart[d]) {
      if (p.v == null) continue;
      const sec = p.v / fps;
      if (sec < yMin) yMin = sec;
      if (sec > yMax) yMax = sec;
    }
  }
  if (!isFinite(yMin) || !isFinite(yMax)) { yMin = 0; yMax = 1; }
  if (yMin === yMax) yMax = yMin + 1;
  // Round bounds to whole seconds for cleanliness.
  yMin = Math.floor(yMin);
  yMax = Math.ceil(yMax);

  const xMin = 0, xMax = log.durationMs;

  // SVG dimensions
  const W = 1400, H = 600;
  const margin = { top: 30, right: 200, bottom: 50, left: 90 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  const xScale = (t: number) => margin.left + ((t - xMin) / (xMax - xMin)) * plotW;
  const yScale = (sec: number) => margin.top + plotH - ((sec - yMin) / (yMax - yMin)) * plotH;

  // Build polylines per deck. Break into segments where v == null so we don't
  // draw straight lines through silent gaps.
  function buildPath(deck: DeckNumber): string {
    const pts = chart[deck];
    let d = '';
    let inSegment = false;
    for (const p of pts) {
      if (p.v == null) { inSegment = false; continue; }
      const sec = p.v / fps;
      const x = xScale(p.t);
      const y = yScale(sec);
      if (!inSegment) {
        d += `M ${x.toFixed(1)} ${y.toFixed(1)} `;
        inSegment = true;
      } else {
        d += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
      }
    }
    return d.trim();
  }

  // X-axis ticks (whole minutes).
  const xTicks: { t: number; label: string }[] = [];
  const totalMin = Math.ceil(xMax / 60000);
  const stepMin = totalMin <= 10 ? 1 : totalMin <= 30 ? 2 : totalMin <= 90 ? 5 : 10;
  for (let m = 0; m <= totalMin; m += stepMin) {
    const t = m * 60000;
    if (t > xMax) break;
    xTicks.push({ t, label: `${m}m` });
  }
  // Y-axis ticks.
  const ySpan = yMax - yMin;
  const yStep = ySpan <= 60 ? 5 : ySpan <= 600 ? 60 : ySpan <= 3600 ? 300 : 600;
  const yTicks: { sec: number; label: string }[] = [];
  for (let s = Math.ceil(yMin / yStep) * yStep; s <= yMax; s += yStep) {
    yTicks.push({ sec: s, label: fmtHMSFsec(s) });
  }

  // Freewheel spans → shaded bands.
  const freewheelBands: string[] = [];
  for (const d of DECKS) {
    const color = DECK_COLORS[d];
    for (const sp of sims[d].freewheelSpans) {
      const x1 = xScale(sp.startMs);
      const x2 = xScale(sp.endMs ?? log.durationMs);
      if (x2 - x1 < 0.5) continue;
      freewheelBands.push(
        `<rect x="${x1.toFixed(1)}" y="${margin.top}" width="${(x2 - x1).toFixed(1)}" height="${plotH}" fill="${color}" opacity="0.06"/>`,
      );
    }
  }

  // Gap markers.
  const gapMarkers = log.gaps.map(g => {
    const x = xScale(g.t);
    return `<line x1="${x.toFixed(1)}" y1="${margin.top}" x2="${x.toFixed(1)}" y2="${margin.top + plotH}" stroke="#fbbf24" stroke-width="1" stroke-dasharray="3,3"/>` +
      `<text x="${x.toFixed(1)}" y="${margin.top - 6}" fill="#fbbf24" font-size="10" text-anchor="middle">gap ${(g.gapMs / 1000).toFixed(1)}s</text>`;
  }).join('\n');

  // Selected-deck timeline at the bottom (under the plot).
  const selectedColors = log.selectedEvents.map((e, i) => {
    const next = log.selectedEvents[i + 1];
    const x1 = xScale(e.t);
    const x2 = xScale(next ? next.t : xMax);
    const color = e.deck ? DECK_COLORS[e.deck] : '#475569';
    return `<rect x="${x1.toFixed(1)}" y="${margin.top + plotH + 10}" width="${(x2 - x1).toFixed(1)}" height="8" fill="${color}" opacity="0.6"><title>selected: deck ${e.deck ?? 'none'}</title></rect>`;
  }).join('\n');

  // Per-deck path elements.
  const paths = DECKS.map(d => {
    const path = buildPath(d);
    return `<path d="${path}" fill="none" stroke="${DECK_COLORS[d]}" stroke-width="1.4" stroke-linejoin="round" data-deck="${d}"/>`;
  }).join('\n');

  // Legend (top-right inside SVG area).
  const legend = DECKS.map((d, i) => {
    const y = margin.top + 14 + i * 22;
    const stats = perDeckStats[d - 1];
    const tcSpan = (stats.tcSpanMs / 1000).toFixed(0);
    return `<g transform="translate(${margin.left + plotW + 12}, ${y})">
      <line x1="0" y1="0" x2="20" y2="0" stroke="${DECK_COLORS[d]}" stroke-width="2.5"/>
      <text x="28" y="4" fill="#e5e7eb" font-size="13">Deck ${d}</text>
      <text x="28" y="18" fill="#94a3b8" font-size="10">${stats.emittedSamples} pkts · ${tcSpan}s span</text>
    </g>`;
  }).join('\n');

  // X axis ticks + grid
  const xAxis = xTicks.map(tk => {
    const x = xScale(tk.t);
    return `<line x1="${x.toFixed(1)}" y1="${margin.top}" x2="${x.toFixed(1)}" y2="${margin.top + plotH}" stroke="#1f2937" stroke-width="1"/>` +
      `<text x="${x.toFixed(1)}" y="${margin.top + plotH + 32}" fill="#94a3b8" font-size="11" text-anchor="middle">${tk.label}</text>`;
  }).join('\n');
  const yAxis = yTicks.map(tk => {
    const y = yScale(tk.sec);
    return `<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${margin.left + plotW}" y2="${y.toFixed(1)}" stroke="#1f2937" stroke-width="1"/>` +
      `<text x="${margin.left - 8}" y="${(y + 4).toFixed(1)}" fill="#94a3b8" font-size="11" text-anchor="end">${tk.label}</text>`;
  }).join('\n');

  // Per-deck filename change list as a small section under the chart.
  const filesHtml = DECKS.map(d => {
    const list = fileTimelinePerDeck[d];
    if (list.length === 0) return `<div class="files-deck"><h4 style="color:${DECK_COLORS[d]}">Deck ${d}</h4><div class="muted">no track</div></div>`;
    const items = list.map(item =>
      `<li><code>${(item.tMs / 1000).toFixed(1)}s</code> — ${escapeHtml(item.fileKey || '(none)')}</li>`,
    ).join('');
    return `<div class="files-deck"><h4 style="color:${DECK_COLORS[d]}">Deck ${d}</h4><ul>${items}</ul></div>`;
  }).join('\n');

  // Compact JSON analysis dump.
  const analysisJson = {
    input: path.basename(args.input),
    durationMs: log.durationMs,
    durationSec: log.durationMs / 1000,
    fps: args.fps,
    latencyMs: args.latencyMs,
    tickHz: args.tickHz,
    enableFreewheel: args.enableFreewheel,
    freewheelMaxSec: args.freewheelMaxSec,
    staleMs: args.staleMs,
    trackOffsets: { count: r.trackOffsetsCount, source: r.offsetsSource },
    gaps: log.gaps,
    perDeck: perDeckStats,
    freewheelSpans: DECKS.reduce<Record<number, any[]>>((acc, d) => {
      acc[d] = sims[d].freewheelSpans.map(sp => ({
        startSec: sp.startMs / 1000,
        endSec: (sp.endMs ?? log.durationMs) / 1000,
        durSec: ((sp.endMs ?? log.durationMs) - sp.startMs) / 1000,
      }));
      return acc;
    }, {}),
  };

  // Cursor + interactive overlay data: emit the chart series as JSON for the
  // tiny vanilla-JS hover handler.
  const seriesJson = JSON.stringify(DECKS.map(d => ({
    deck: d,
    color: DECK_COLORS[d],
    points: chart[d].map(p => [p.t, p.v]),
  })));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>TC Analysis — ${escapeHtml(path.basename(args.input))}</title>
<style>
  body { background: #0b1220; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  h2 { font-size: 14px; margin: 28px 0 8px; color: #cbd5e1; font-weight: 600; }
  h3 { font-size: 13px; margin: 18px 0 6px; color: #cbd5e1; }
  h4 { font-size: 12px; margin: 0 0 6px; }
  .meta { color: #94a3b8; font-size: 12px; margin-bottom: 16px; }
  .meta code { background: #111827; padding: 1px 5px; border-radius: 3px; }
  .chart-wrap { background: #0f172a; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; }
  svg { display: block; max-width: 100%; height: auto; }
  .muted { color: #64748b; font-size: 11px; }
  .files { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-top: 8px; }
  .files-deck { background: #0f172a; border: 1px solid #1e293b; border-radius: 6px; padding: 10px 14px; max-height: 200px; overflow: auto; font-size: 11px; }
  .files-deck ul { margin: 4px 0 0; padding-left: 18px; }
  .files-deck li { margin: 2px 0; color: #cbd5e1; }
  .files-deck code { color: #94a3b8; font-size: 10px; }
  pre.json { background: #0f172a; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; font-size: 11px; max-height: 400px; overflow: auto; color: #cbd5e1; }
  .tooltip { position: fixed; pointer-events: none; background: rgba(15,23,42,0.96); border: 1px solid #334155; padding: 8px 10px; border-radius: 4px; font-size: 11px; color: #e5e7eb; display: none; z-index: 10; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
  .tooltip .tt-row { display: flex; gap: 8px; align-items: center; }
  .tooltip .tt-dot { width: 8px; height: 8px; border-radius: 50%; }
  .legend-bar { display: flex; gap: 14px; margin-top: 8px; font-size: 11px; color: #94a3b8; }
  .legend-bar .item { display: flex; align-items: center; gap: 5px; }
  .legend-bar .swatch { width: 11px; height: 11px; border-radius: 2px; opacity: 0.6; }
  details { background: #0f172a; border: 1px solid #1e293b; border-radius: 6px; padding: 8px 12px; }
  summary { cursor: pointer; font-size: 12px; color: #cbd5e1; }
</style>
</head>
<body>

<h1>Timecode Analysis · ${escapeHtml(path.basename(args.input))}</h1>
<div class="meta">
  Duration <code>${(log.durationMs / 1000).toFixed(1)}s</code> ·
  fps <code>${args.fps}</code> ·
  latency-comp <code>${args.latencyMs}ms</code> ·
  tick <code>${args.tickHz}Hz</code> ·
  freewheel <code>${args.enableFreewheel ? `enabled (max ${args.freewheelMaxSec}s)` : 'disabled'}</code> ·
  stale <code>${args.staleMs}ms</code> ·
  offsets <code>${r.trackOffsetsCount} tracks (${escapeHtml(r.offsetsSource)})</code>
</div>

<div class="chart-wrap">
  <svg id="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#0f172a"/>
    <rect x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}" fill="#0b1220" stroke="#1e293b" stroke-width="1"/>
    ${freewheelBands.join('\n')}
    ${xAxis}
    ${yAxis}
    ${gapMarkers}
    ${paths}
    ${legend}
    <text x="${margin.left}" y="${margin.top - 10}" fill="#94a3b8" font-size="11">Hypothetical timecode per deck (HH:MM:SS)</text>
    <text x="${margin.left + plotW / 2}" y="${H - 8}" fill="#94a3b8" font-size="11" text-anchor="middle">wall-clock time into recording</text>
    <g id="cursor" style="display:none">
      <line id="cursorLine" x1="0" y1="${margin.top}" x2="0" y2="${margin.top + plotH}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2,3"/>
    </g>
    ${selectedColors}
    <text x="${margin.left}" y="${margin.top + plotH + 28}" fill="#64748b" font-size="10">selected-deck (sACN) timeline:</text>
  </svg>
  <div class="legend-bar">
    <div class="item"><span class="swatch" style="background:#fbbf24"></span>recording gap</div>
    ${DECKS.map(d => `<div class="item"><span class="swatch" style="background:${DECK_COLORS[d]}"></span>deck ${d} freewheel</div>`).join('')}
  </div>
</div>

<div class="tooltip" id="tooltip"></div>

<h2>Per-deck files</h2>
<div class="files">${filesHtml}</div>

<h2>Analysis (JSON)</h2>
<pre class="json">${escapeHtml(JSON.stringify(analysisJson, null, 2))}</pre>

<details>
<summary>Algorithm — TC mirror of the live Art-Net worker</summary>
<pre class="json">For each simulated tick t:
  globalLastEventT = max(t' for any deck event with t' ≤ t)
  stale = (t − globalLastEventT) > ${args.staleMs}ms

  For each deck d ∈ {1..4}:
    raw = reconstructed DeckState[d] at t
    source = applyOffset(raw, trackOffsets, fps)   # by basename
    if source is null OR elapsedSec ≤ 0:
      timeline_d ← null; lastTick_d ← null; emit silent
    elif stale and freewheel disabled OR stalledFor > ${args.freewheelMaxSec}s:
      emit silent
    elif !raw.play (and not freewheeling through stall):
      timeline_d ← sourceFrames; emit silent
    else:
      dt = t − lastTick_d
      timeline_d += dt · fps · (1 + speedState/100)
      if !stale: drift-snap if |source − timeline| > 15% of one frame
      framePos = timeline_d + (fps · ${args.latencyMs}/1000)
      clamp to track length, convert → HH:MM:SS:FF
</pre>
</details>

<script>
(function() {
  const series = ${seriesJson};
  const fps = ${fps};
  const xMin = ${xMin}, xMax = ${xMax};
  const yMin = ${yMin}, yMax = ${yMax};
  const margin = ${JSON.stringify(margin)};
  const plotW = ${plotW}, plotH = ${plotH};
  const W = ${W}, H = ${H};

  const svg = document.getElementById('chart');
  const tooltip = document.getElementById('tooltip');
  const cursor = document.getElementById('cursor');
  const cursorLine = document.getElementById('cursorLine');

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtHMSF(totalFrames) {
    if (totalFrames == null) return '—';
    const f = ((totalFrames % fps) + fps) % fps;
    const totalSec = Math.floor(totalFrames / fps);
    const s = ((totalSec % 60) + 60) % 60;
    const totalMin = Math.floor(totalSec / 60);
    const m = ((totalMin % 60) + 60) % 60;
    const h = ((Math.floor(totalMin / 60) % 24) + 24) % 24;
    return pad2(h)+':'+pad2(m)+':'+pad2(s)+':'+pad2(f);
  }
  function fmtWall(ms) {
    const totalSec = Math.floor(ms / 1000);
    const s = totalSec % 60;
    const m = Math.floor(totalSec / 60) % 60;
    const h = Math.floor(totalSec / 3600);
    return pad2(h)+':'+pad2(m)+':'+pad2(s);
  }

  function nearestPoint(points, t) {
    // Binary search by t.
    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid][0] < t) lo = mid + 1; else hi = mid;
    }
    return points[lo];
  }

  function svgPointFromEvent(evt) {
    const rect = svg.getBoundingClientRect();
    const x = ((evt.clientX - rect.left) / rect.width) * W;
    return x;
  }

  svg.addEventListener('mousemove', (evt) => {
    const x = svgPointFromEvent(evt);
    if (x < margin.left || x > margin.left + plotW) {
      tooltip.style.display = 'none';
      cursor.style.display = 'none';
      return;
    }
    const t = ((x - margin.left) / plotW) * (xMax - xMin) + xMin;
    cursorLine.setAttribute('x1', x);
    cursorLine.setAttribute('x2', x);
    cursor.style.display = '';

    let html = '<div style="color:#94a3b8;margin-bottom:4px">t = ' + fmtWall(t) + ' (' + (t/1000).toFixed(1) + 's)</div>';
    for (const s of series) {
      const p = nearestPoint(s.points, t);
      const tc = p ? p[1] : null;
      html += '<div class="tt-row">'
        + '<span class="tt-dot" style="background:' + s.color + '"></span>'
        + '<span style="color:' + s.color + '">D' + s.deck + '</span> '
        + '<span style="color:#cbd5e1;font-family:ui-monospace,monospace">' + fmtHMSF(tc) + '</span>'
        + '</div>';
    }
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    tooltip.style.left = (evt.clientX + 14) + 'px';
    tooltip.style.top = (evt.clientY + 14) + 'px';
  });
  svg.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
    cursor.style.display = 'none';
  });
})();
</script>

</body>
</html>
`;
}

function fmtHMSFsec(sec: number): string {
  const totalSec = Math.max(0, Math.floor(sec));
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

main();
