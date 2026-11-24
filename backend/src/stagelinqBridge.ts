import type { DeckNumber, DeckState, SourceTiming } from "./types.js";
import path from "node:path";
import { monotonicNowMs } from "./timecodeTimeline.js";
import { keyIndexToCamelot, keyNameToCamelot } from "./camelot.js";
import { logBpmDebug, logDiscover, logDiscoverSpeed, logError, logLifecycle, logPlayback, logWaveform, logCues, GRN, YEL, RST } from "./logging.js";
import { BEAT_WATCHDOG_TIMEOUT_S, DISCONNECT_DETECT_TIMEOUT_S, CONNECT_BEAT_GRACE_S, ELAPSED_THROTTLE_S } from "./constants.js";

// Ring buffer of recent gaps that are wide enough to be worth correlating with a
// freewheel-flap log. We keep them keyed by wall-clock so the flap detector can
// pull just the gaps that happened during its rolling window. Cap is generous so
// a couple of bursty disconnects don't evict legitimate evidence.
interface BeatGapEntry { atMs: number; gapMs: number }
const RECENT_GAP_RING_CAP = 64;
const RECENT_GAP_MAX_AGE_MS = 30_000;
// Capture-floor — gaps below this are uninteresting (steady state is 50–200 ms).
// Anything ≥ this is a candidate "near miss" or "actual stall" and gets stored
// for the flap detector to correlate with on demand.
const RECENT_GAP_CAPTURE_FLOOR_MS = 200;
const recentGaps: BeatGapEntry[] = [];

export function getRecentOverThresholdGaps(thresholdMs: number, sinceMs: number): number[] {
  const out: number[] = [];
  for (const g of recentGaps) {
    if (g.atMs >= sinceMs && g.gapMs > thresholdMs) out.push(g.gapMs);
  }
  return out;
}

function recordBeatGap(gapMs: number) {
  if (gapMs >= RECENT_GAP_CAPTURE_FLOOR_MS) {
    const now = Date.now();
    recentGaps.push({ atMs: now, gapMs });
    // Evict by capacity AND by age — both bounds matter so a quiet hour can't
    // leave a stale entry that pollutes the next flap correlation.
    while (recentGaps.length > RECENT_GAP_RING_CAP) recentGaps.shift();
    while (recentGaps.length > 0 && now - recentGaps[0].atMs > RECENT_GAP_MAX_AGE_MS) {
      recentGaps.shift();
    }
  }
}

import { StageLinqInstance, parseNetworkPath } from "@gree44/stagelinq";

const DECKS: DeckNumber[] = [1, 2, 3, 4];
const DECK_BY_LAYER: Record<string, DeckNumber> = { A: 1, B: 2, C: 3, D: 4 };

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function roundToDigits(x: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

function toFileName(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return path.basename(s);
}

export interface BridgeOptions {
  downloadDbSources?: boolean; // kept for compatibility; unused by this library
  onDeviceIp?: (ip: string) => void;
  onCommunicationLost?: () => void;
  onTrackChanged?: (deck: DeckNumber, fileName: string, rawNetworkPath: string) => void;
}

// Listener invoked synchronously from inside touch() on every state mutation. Listeners
// MUST NOT throw and MUST NOT block — writes go through buffered streams downstream.
export type DeckStateListener = (deck: DeckNumber, state: DeckState, timing: SourceTiming) => void;

export class StageLinqBridge {
  private opts: BridgeOptions;
  private decks: Record<DeckNumber, DeckState>;

  // Track last known playback state per deck to print only changes (optional logging)
  private lastPlay: Record<DeckNumber, boolean | undefined> = {
    1: undefined,
    2: undefined,
    3: undefined,
    4: undefined,
  };

  // One-time discovery logs (so we can confirm which paths your device emits)
  private seen = {
    elapsed: false,
    total: false,
    key: false,
    speed: false,
    loops: false,
  };

  // Sample rate comes from StateMap: /Engine/DeckX/Track/SampleRate
  private sampleRateHz: Record<DeckNumber, number | null> = {
    1: null,
    2: null,
    3: null,
    4: null,
  };

  // Normalized speed controls from StageLinq.
  // SpeedState is effective pitch offset in percent.
  // Raw CurrentBPM sourced strictly from /Engine/DeckX/CurrentBPM updates.
  private currentBpmRaw: Record<DeckNumber, number | null> = { 1: null, 2: null, 3: null, 4: null };
  private speedStateRaw: Record<DeckNumber, number | string | boolean | null> = { 1: null, 2: null, 3: null, 4: null };
  private explicitTrackLoaded: Record<DeckNumber, boolean | null> = { 1: null, 2: null, 3: null, 4: null };
  private currentKeyCamelot: Record<DeckNumber, string | null> = { 1: null, 2: null, 3: null, 4: null };

  // Avoid repeated [DISCOVER] speed logs when values haven't changed.
  private lastSpeedDiscoverSig: Record<DeckNumber, string | null> = {
    1: null,
    2: null,
    3: null,
    4: null,
  };

  // Retain raw sample values so later SampleRate changes can correct early conversions.
  private trackLengthSamples: Record<DeckNumber, number | null> = { 1: null, 2: null, 3: null, 4: null };

  // Loop positions arrive in samples before SampleRate is known — defer conversion.
  private loopInSamples: Record<DeckNumber, number | null> = { 1: null, 2: null, 3: null, 4: null };
  private loopOutSamples: Record<DeckNumber, number | null> = { 1: null, 2: null, 3: null, 4: null };

  // Throttle elapsedSec updates (we don't need frame-accurate like timecode)
  private lastElapsedEmitSec: Record<DeckNumber, number> = { 1: -1, 2: -1, 3: -1, 4: -1 };

  // Watchdog: timestamps of last beatMessage received per deck and across all decks
  private lastBeatAtMs: Record<DeckNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  private lastAnyBeatAtMs = 0;
  private realBeatReceivedSinceConnect = false;
  private positionAtMs: Record<DeckNumber, number | null> = { 1: null, 2: null, 3: null, 4: null };
  private positionTrackId: Record<DeckNumber, string> = { 1: '', 2: '', 3: '', 4: '' };
  private positionRevision: Record<DeckNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  private transportRevision: Record<DeckNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  private watchdogInterval: NodeJS.Timeout | null = null;

  // Captured full net:// paths (before basename stripping) and change-tracking for onTrackChanged.
  private rawNetworkPaths: Record<DeckNumber, string> = { 1: '', 2: '', 3: '', 4: '' };
  private lastTriggeredTrackPaths: Record<DeckNumber, string> = { 1: '', 2: '', 3: '', 4: '' };

  private stageLinq!: StageLinqInstance;
  private stageLinqDevices: any = null;
  // Serialize downloads per device: FileTransfer has a single shared buffer and cannot handle concurrent getFile() calls.
  private downloadQueues = new Map<string, Promise<void>>();

  // Subscribers fired synchronously from inside touch(). Used by the Recorder to capture
  // every state mutation at full bridge cadence.
  private deckListeners = new Set<DeckStateListener>();

  constructor(_opts: BridgeOptions = {}) {
    this.opts = _opts;
    this.decks = Object.fromEntries(
      DECKS.map((d) => [d, this.blankDeck(d)])
    ) as Record<DeckNumber, DeckState>;

    this.wire();
  }

  private blankDeck(deck: DeckNumber): DeckState {
    return {
      deck,
      trackLoaded: false,
      fileName: "",
      title: "—",
      artist: "—",
      elapsedSec: 0,
      totalSec: 0,
      currentBpm: 0,
      trackBpm: 0,
      speedState: 0,
      keyIndex: null,
      keyCamelot: "--",
      fader: 0,
      play: false,
      updatedAt: Date.now(),
      hotCues: [],
      loopActive: false,
      loopInSec: null,
      loopOutSec: null,
      savedLoops: [],
    };
  }

  private touch(deck: DeckNumber) {
    this.decks[deck].updatedAt = Date.now();
    if (this.deckListeners.size > 0) {
      const snapshot = { ...this.decks[deck] };
      for (const fn of this.deckListeners) {
        try { fn(deck, snapshot, this.getDeckTiming(deck)); } catch (e) { logError('[Bridge] deck listener threw:', e); }
      }
    }
  }

  private captureNetPath(deck: DeckNumber, rawValue: unknown) {
    if (typeof rawValue === 'string') {
      const s = rawValue.trim();
      if (!s) return;
      const previousPath = this.rawNetworkPaths[deck];
      if (previousPath.startsWith('net://') && s === toFileName(previousPath)) return;
      if (previousPath && previousPath !== s && (
        toFileName(previousPath) !== toFileName(s) ||
        (previousPath.startsWith('net://') && s.startsWith('net://'))
      )) {
        this.clearKey(deck);
      }
      this.rawNetworkPaths[deck] = s;
    }
  }

  private clearKey(deck: DeckNumber) {
    this.currentKeyCamelot[deck] = null;
    this.decks[deck].keyIndex = null;
    this.decks[deck].keyCamelot = '--';
  }

  private maybeFireTrackChanged(deck: DeckNumber) {
    const fn = this.decks[deck].fileName;
    const netPath = this.rawNetworkPaths[deck];
    if (!fn || !netPath) return;
    if (netPath !== this.lastTriggeredTrackPaths[deck]) {
      this.lastTriggeredTrackPaths[deck] = netPath;
      this.decks[deck].hotCues = [];
      this.decks[deck].loopActive = false;
      this.decks[deck].loopInSec = null;
      this.decks[deck].loopOutSec = null;
      this.decks[deck].savedLoops = [];
      this.loopInSamples[deck] = null;
      this.loopOutSamples[deck] = null;
      this.opts.onTrackChanged?.(deck, fn, netPath);
    }
  }
  private unloadDeck(deck: DeckNumber) {
    this.explicitTrackLoaded[deck] = false;
    this.decks[deck].trackLoaded = false;
    this.decks[deck].play = false;
    this.transportRevision[deck]++;
    this.clearKey(deck);
  }

  private emitBpmDebug(deck: DeckNumber, source: string) {
    const ds = this.decks[deck];
    const speedStateRaw = this.speedStateRaw[deck];
    const speedState =
      typeof speedStateRaw === "number" && Number.isFinite(speedStateRaw)
        ? roundToDigits(speedStateRaw, 5)
        : speedStateRaw;

    logBpmDebug(
      deck,
      `[BPM DEBUG] Deck ${deck} source=${source} currentBpm=${ds.currentBpm} baseBpm=${ds.trackBpm} speedState=${speedState ?? "n/a"}`
    );
  }

  private recomputeDerived(deck: DeckNumber) {
    const ds = this.decks[deck];
    const bpmRaw = this.currentBpmRaw[deck];
    const bpmForCalc = Number.isFinite(bpmRaw) ? (bpmRaw as number) : ds.currentBpm;
    ds.keyCamelot = this.currentKeyCamelot[deck] ?? keyIndexToCamelot(ds.keyIndex);

    if (!this.seen.key && ds.keyIndex != null) {
      this.seen.key = true;
      logDiscover(deck, "[DISCOVER] KeyIndex value:", ds.keyIndex, "->", ds.keyCamelot);
    }

    const speedState = this.speedStateRaw[deck];

    let ratio: number | null = null;
    let relativePercent: number | null = null;
    let source: "speedState" | "none" = "none";

    // Preferred: SpeedState is effective pitch offset in percent.
    if (typeof speedState === "number" && Number.isFinite(speedState)) {
      ds.speedState = speedState;
      const candidateRatio = 1 + speedState / 100;
      if (Number.isFinite(candidateRatio) && candidateRatio > 0.000001) {
        ratio = candidateRatio;
        relativePercent = speedState;
        source = "speedState";
      }
    } else {
      ds.speedState = 0;
    }

    if (ratio != null) {
      const neutralTrackBpm =
        Number.isFinite(bpmForCalc) && ratio > 0.0001
          ? bpmForCalc / ratio
          : null;

      const sig = `${source}|${relativePercent ?? "na"}|${ratio}|${bpmForCalc}|${neutralTrackBpm ?? "na"}`;
      if (this.lastSpeedDiscoverSig[deck] !== sig) {
        this.lastSpeedDiscoverSig[deck] = sig;
        logDiscoverSpeed(
          deck,
          `[DISCOVER] Speed values deck ${deck}: source=${source}, relativePercent=${relativePercent != null ? relativePercent.toFixed(3) : "n/a"}%, ratio=${ratio.toFixed(6)}, currentBpm=${Number.isFinite(bpmForCalc) ? bpmForCalc : "n/a"}, baseBpm=${neutralTrackBpm != null ? neutralTrackBpm : "n/a"}`
        );
      }
    }

    // Track BPM (base BPM) derived only from SpeedState ratio.
    if (ratio != null && Number.isFinite(bpmForCalc) && ratio > 0.0001) {
      ds.trackBpm = bpmForCalc / ratio;
    } else {
      ds.trackBpm = 0;
    }
  }
  private coerceBool(v: any): boolean | undefined {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "playing" || s === "play") return true;
      if (s === "false" || s === "0" || s === "stopped" || s === "stop" || s === "pause") return false;
    }
    return undefined;
  }

  private tryParseTrackData(deck: DeckNumber, raw: any) {
    // raw is usually msg.json or msg.json.string, depending on device/build
    let obj: any = raw;

    // Some builds wrap it as { string: "..." }
    if (obj && typeof obj === "object" && typeof obj.string === "string") obj = obj.string;

    // If it's a JSON string, parse it
    if (typeof obj === "string") {
      const s = obj.trim();
      try {
        obj = JSON.parse(s);
      } catch {
        return;
      }
    }

    if (!obj || typeof obj !== "object") return;

    const ds = this.decks[deck];

    const fileNameFromTrackData =
      toFileName(obj.fileName) ||
      toFileName(obj.filename) ||
      toFileName(obj.filePath) ||
      toFileName(obj.filepath) ||
      toFileName(obj.fullPath) ||
      toFileName(obj.path) ||
      toFileName(obj.uri) ||
      toFileName(obj.songIndex) ||
      toFileName(obj.song_index);

    if (fileNameFromTrackData) {
      this.captureNetPath(deck,
        obj.fileName || obj.filename || obj.filePath || obj.filepath ||
        obj.fullPath || obj.path || obj.uri || obj.songIndex || obj.song_index || '');
      ds.fileName = fileNameFromTrackData;
      this.maybeFireTrackChanged(deck);
      this.touch(deck);
    }

    // --- duration ---
    // try common shapes/units
    const durSec =
      (typeof obj.durationSec === "number" ? obj.durationSec : undefined) ??
      (typeof obj.duration === "number" ? obj.duration : undefined) ??
      (typeof obj.lengthSec === "number" ? obj.lengthSec : undefined) ??
      (typeof obj.trackLength === "number" ? obj.trackLength : undefined);

    const durMs =
      (typeof obj.durationMs === "number" ? obj.durationMs : undefined) ??
      (typeof obj.lengthMs === "number" ? obj.lengthMs : undefined);

    if (typeof durMs === "number" && durMs > 0) {
      this.trackLengthSamples[deck] = null;
      ds.totalSec = durMs / 1000;
      this.touch(deck);
      if (!this.seen.total) {
        this.seen.total = true;
        logDiscover(deck, "[DISCOVER] totalSec from TrackData (ms):", deck, ds.totalSec);
      }
    } else if (typeof durSec === "number" && durSec > 0) {
      this.trackLengthSamples[deck] = null;
      ds.totalSec = durSec;
      this.touch(deck);
      if (!this.seen.total) {
        this.seen.total = true;
        logDiscover(deck, "[DISCOVER] totalSec from TrackData (s):", deck, ds.totalSec);
      }
    }

    // --- key ---
    // numeric index
    const keyIdx =
      (typeof obj.currentKeyIndex === "number" ? obj.currentKeyIndex : undefined) ??
      (typeof obj.keyIndex === "number" ? obj.keyIndex : undefined);

    const keyNames = [obj.currentKey, obj.camelot, obj.key];
    const hasKeyName = keyNames.some((value) => value !== undefined);
    const namedKey = keyNames.map(keyNameToCamelot).find((value) => value !== null) ?? null;
    if (typeof keyIdx === "number") ds.keyIndex = keyIdx;
    if (hasKeyName) this.currentKeyCamelot[deck] = namedKey;

    if (typeof keyIdx === "number" || hasKeyName) {
      this.recomputeDerived(deck);
      this.touch(deck);
      if (!this.seen.key) {
        this.seen.key = true;
        logDiscover(deck, "[DISCOVER] Key from TrackData:", deck, ds.keyCamelot);
      }
    }
  }


  private maybeLogPlayChange(deck: DeckNumber, isPlaying: boolean | undefined) {
    if (typeof isPlaying !== "boolean") return;

    const prev = this.lastPlay[deck];
    if (prev === undefined) {
      // initialize without logging
      this.lastPlay[deck] = isPlaying;
      return;
    }

    if (prev !== isPlaying) {
      this.lastPlay[deck] = isPlaying;
      logPlayback(deck, `[Playback] Deck ${deck}: ${isPlaying ? "START" : "STOP"}`);
    }
  }

  private wire() {
    const instance = new StageLinqInstance({
      maxRetries: 999,
      downloadDbSources: false,
      enableFileTranfer: true,
      logger: {
        trace: () => {},
        debug: () => {},
        info:  (msg: string, ...args: unknown[]) => logLifecycle('[StageLinq]', msg, ...args),
        warn:  (msg: string, ...args: unknown[]) => logLifecycle('[StageLinq]', msg, ...args),
        error: (msg: string, ...args: unknown[]) => logError('[StageLinq]', msg, ...args),
      },
    });
    instance.on('error', (error: unknown) => logError('[StageLinq] Instance error:', error));
    this.stageLinq = instance;
    const devices: any = instance.devices;
    this.stageLinqDevices = devices;

    // Different versions use different lifecycle event names; listen to both.
    devices.on?.("ready", (info: any) => {
      const name = info?.software?.name || "";
      logLifecycle(`${GRN}[StageLinq] Device ready${name ? `: ${name}` : ""}${RST}`);
    });

    devices.on?.("connected", (info: any) => {
      if (typeof info?.address === "string" && info.address) {
        this.opts.onDeviceIp?.(info.address);
      }
      logLifecycle(
        `${GRN}[StageLinq] Device connected: ${info?.address || ""} ${info?.software?.name || ""}${RST}`.trimEnd()
      );
    });

    devices.on?.("deviceConnected", (info: any) => {
      if (typeof info?.address === "string" && info.address) {
        this.opts.onDeviceIp?.(info.address);
      }
      logLifecycle(
        `${GRN}[StageLinq] Device connected: ${info?.address || ""} ${info?.software?.name || ""}${RST}`.trimEnd()
      );
    });

    devices.on?.("error", (e: any) => {
      logError("StageLinq error:", e?.message || e);
    });

    /**
     * Low-level StateMap messages (raw). This is where /Engine/DeckX/Play and /PlayState appear.
     * Your observed payload is typically:
     *   { name: "/Engine/Deck1/Play", json: { state: true, type: 1 } }
     * i.e. boolean is in json.state (NOT json.value).
     */
    devices.on?.("message", (_info: any, data: any) => {
      try {
      const msg = data?.message ?? data;

      const name = msg?.name ?? msg?.path ?? msg?.key;
      if (!name) return;

      // normalize once
      const json = msg?.json ?? msg?.value ?? msg;

      const rawValue =
        json?.value ??
        json?.state ??
        json?.bool ??
        json?.number ??
        json?.string ??
        json?.text ??
        json;

      // ---- Mixer channel faders (/Mixer/CH{n}faderPosition — raw position, 0..1) ----
      const mixerMatch = String(name).match(/^\/Mixer\/CH([1-4])faderPosition$/);
      if (mixerMatch) {
        const ch = Number(mixerMatch[1]) as DeckNumber;
        if (typeof rawValue === "number") {
          this.decks[ch].fader = clamp01(rawValue);
          this.touch(ch);
        }
        return;
      }


      // ---- Deck-related paths ----
      const m = String(name).match(/^\/Engine\/Deck([1-4])\/(.+)$/);
      if (!m) return;

      const deck = Number(m[1]) as DeckNumber;
      if (!DECKS.includes(deck)) return;

      const tail = m[2];
      const ds = this.decks[deck];

      if (/(?:Track\/)?(?:FileName|Filename|FilePath|Path)$/i.test(tail) && typeof rawValue === "string" && rawValue.trim()) {
        this.captureNetPath(deck, rawValue);
        ds.fileName = toFileName(rawValue);
        this.maybeFireTrackChanged(deck);
        this.touch(deck);
      }

      // ---- Explicit track-loaded flag (if emitted by device) ----
      if (/TrackIsLoaded$/i.test(tail) || /IsLoaded$/i.test(tail) || /SongLoaded$/i.test(tail)) {
        const loaded = this.coerceBool(rawValue);
        if (typeof loaded === "boolean") {
          if (!loaded) {
            this.unloadDeck(deck);
          } else {
            this.explicitTrackLoaded[deck] = true;
            ds.trackLoaded = true;
          }
          this.touch(deck);
        }
      }

      // TrackData often contains duration + key info on Prime/Denon
      if (/(Track\/)?TrackData$/i.test(tail)) {
        this.tryParseTrackData(deck, json); // pass the whole json wrapper
        return;
      }


      // --- discovery: print first *usable* key/length messages we ever see ---
      if (!this.seen.key && /key/i.test(tail)) {
        logDiscover(deck, "[DISCOVER] KEY candidate:", name, "=", rawValue);
        // only lock once we actually got something usable
        if (typeof rawValue === "number" || (typeof rawValue === "string" && rawValue.trim())) {
          this.seen.key = true;
        }
      }

      if (!this.seen.total && /(tracklength|length|duration)/i.test(tail)) {
        logDiscover(deck, "[DISCOVER] LENGTH candidate:", name, "=", rawValue);
        if (typeof rawValue === "number") {
          this.seen.total = true;
        }
      }



      // ---- SampleRate (needed for BeatInfo samples -> seconds) ----
      if ((/Track\/SampleRate$/i.test(tail) || /SampleRate$/i.test(tail)) && typeof rawValue === "number") {
        if (Number.isFinite(rawValue) && rawValue > 0) {
          this.sampleRateHz[deck] = rawValue;

          // If TrackLength arrived earlier in samples, convert now.
          const pendingSamples = this.trackLengthSamples[deck];
          if (Number.isFinite(pendingSamples) && (pendingSamples as number) > 0) {
            ds.totalSec = (pendingSamples as number) / rawValue;
            this.touch(deck);
            if (!this.seen.total) {
              this.seen.total = true;
              logDiscover(
                deck,
                "[DISCOVER] TotalSec from TrackLength(samples)/SampleRate:",
                name,
                "samples=",
                pendingSamples,
                "sr=",
                rawValue,
                "->",
                ds.totalSec
              );
            }
          }

          // If loop positions arrived before SampleRate, convert now.
          const pendingIn = this.loopInSamples[deck];
          if (typeof pendingIn === "number") {
            ds.loopInSec = pendingIn / rawValue;
            this.touch(deck);
            logDiscover(deck, "[DISCOVER] LoopIn resolved from pending samples:", pendingIn, "sr=", rawValue, "->", ds.loopInSec.toFixed(3) + "s");
          }
          const pendingOut = this.loopOutSamples[deck];
          if (typeof pendingOut === "number") {
            ds.loopOutSec = pendingOut / rawValue;
            this.touch(deck);
            logDiscover(deck, "[DISCOVER] LoopOut resolved from pending samples:", pendingOut, "sr=", rawValue, "->", ds.loopOutSec.toFixed(3) + "s");
          }

          if (!this.seen.elapsed) {
            logDiscover(deck, "[DISCOVER] SampleRate path:", name, "=", rawValue);
          }
        }
      }


      // ---- Total seconds ----
      if (/(Track\/)?(TrackLength|Duration|Length)(Ms)?$/i.test(tail) && typeof rawValue === "number") {
        const isMs = /Ms$/i.test(tail);
        // TrackLength sometimes comes in samples, not seconds.
        // Heuristic: anything > 100k is almost certainly samples (100k seconds is ~27h).
        const looksLikeSamples = !isMs && rawValue > 100000;

        if (looksLikeSamples) {
          this.trackLengthSamples[deck] = rawValue;
          const sr = this.sampleRateHz[deck];
          if (typeof sr === "number" && Number.isFinite(sr) && sr > 0) {
            ds.totalSec = Math.max(0, rawValue / sr);
          }
        } else {
          this.trackLengthSamples[deck] = null;
          ds.totalSec = Math.max(0, isMs ? rawValue / 1000 : rawValue);
        }
        this.touch(deck);

        if (!this.seen.total) {
          this.seen.total = true;
          logDiscover(deck, "[DISCOVER] TotalSec path:", name, "=", rawValue, isMs ? "(ms)" : "(s)");
        }
      }

      if (/(Track\/)?(CurrentKeyIndex|KeyIndex)$/i.test(tail) && typeof rawValue === "number") {
        ds.keyIndex = rawValue;
        this.recomputeDerived(deck);
        this.touch(deck);

        if (!this.seen.key) {
          this.seen.key = true;
          logDiscover(deck, "[DISCOVER] KeyIndex path:", name, "=", rawValue);
        }
      }

      if (/^(?:Track\/)?(?:CurrentKey|Camelot|Key)$/i.test(tail)) {
        this.currentKeyCamelot[deck] = keyNameToCamelot(rawValue);
        this.recomputeDerived(deck);
        this.touch(deck);

        if (!this.seen.key) {
          this.seen.key = true;
          logDiscover(deck, "[DISCOVER] Key (string) path:", name, "=", rawValue);
        }
      }



      // ---- Core BPM/speed controls from /Engine/DeckX/... ----
      if (tail === "CurrentBPM" && typeof rawValue === "number") {
        ds.currentBpm = rawValue;
        this.currentBpmRaw[deck] = rawValue;
      }

      if (tail === "SpeedState") {
        if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
          this.speedStateRaw[deck] = roundToDigits(rawValue, 5);
        } else {
          this.speedStateRaw[deck] = rawValue as number | string | boolean;
        }
      }

      if (
        tail === "CurrentBPM" ||
        tail === "SpeedState"
      ) {
        this.recomputeDerived(deck);
        this.touch(deck);
        this.emitBpmDebug(deck, `message.${tail}`);
        if (!this.seen.speed) {
          this.seen.speed = true;
          logDiscoverSpeed(deck, "[DISCOVER] BPM/Speed control path:", name, "=", rawValue);
        }
      }

      // ExternalMixerVolume is post-gain and not used — fader is sourced exclusively from /Mixer/CH{n}faderPosition.

      // ---- Track title / artist (keep your exact matches, plus fallback patterns) ----
      if ((/SongName$/i.test(tail) || /Title$/i.test(tail)) && typeof rawValue === "string" && rawValue.trim()) {
        ds.title = rawValue;
        ds.trackLoaded = this.explicitTrackLoaded[deck] ?? true;
        this.touch(deck);
      } else if ((/SongName$/i.test(tail) || /Title$/i.test(tail)) && typeof rawValue === "string" && !rawValue.trim()) {
        ds.title = "—";
        ds.trackLoaded = this.explicitTrackLoaded[deck] ?? false;
        this.touch(deck);
      }
      if ((/ArtistName$/i.test(tail) || /Artist$/i.test(tail)) && typeof rawValue === "string") {
        ds.artist = rawValue.trim() ? rawValue : "—";
        this.touch(deck);
      }

      // ---- Play state (edge-detected) ----
      const isPlayish =
        /(^|\/)(Play|Playing|PlayState|IsPlaying)$/.test(tail) || tail.includes("Play");

      if (isPlayish) {
        const playing = this.coerceBool(rawValue);
        const playing2 =
          typeof playing === "boolean"
            ? playing
            : (typeof rawValue === "number" ? rawValue > 0 : undefined);

        if (typeof playing2 === "boolean") {
          ds.play = playing2;
          this.transportRevision[deck]++;
          this.touch(deck);
          this.maybeLogPlayChange(deck, playing2);
        }
      }

      // ---- Discover unmatched loop paths ----
      if (/loop/i.test(tail)) {
        if (!this.seen.loops && /loop/i.test(tail)) {
          this.seen.loops = true;
          logDiscover(deck, "[DISCOVER] First loop path (message):", name, "=", JSON.stringify(rawValue));
        }
      }

      // ---- HotCues are not exposed by Engine OS over StageLinq StateMap.
      // Hot-cue positions are populated offline from the SD-card m.db via
      // backend/src/scripts/extractCues.ts; see backend/hotcue-cache/. ----

      // ---- Active loop ----
      if (/^(?:Track\/)?LoopEnableState$/i.test(tail)) {
        const active = this.coerceBool(rawValue);
        if (typeof active === "boolean") {
          ds.loopActive = active;
          this.touch(deck);
          logCues(deck, `[CUE] Deck ${deck} loop ${active ? 'ENABLED' : 'DISABLED'}`);
        }
      }

      if (/^(?:Track\/)?CurrentLoopInPosition$/i.test(tail) && typeof rawValue === "number") {
        this.loopInSamples[deck] = rawValue;
        const sr = this.sampleRateHz[deck];
        if (typeof sr === "number" && sr > 0) {
          ds.loopInSec = rawValue / sr;
          this.touch(deck);
          logDiscover(deck, "[DISCOVER] LoopIn set:", rawValue, "samples / sr=", sr, "->", ds.loopInSec.toFixed(3) + "s");
          logCues(deck, `[CUE] Deck ${deck} loop in @ ${ds.loopInSec.toFixed(3)}s`);
        } else {
          logDiscover(deck, "[DISCOVER] LoopIn deferred (no SampleRate yet):", rawValue, "samples");
        }
      }

      if (/^(?:Track\/)?CurrentLoopOutPosition$/i.test(tail) && typeof rawValue === "number") {
        this.loopOutSamples[deck] = rawValue;
        const sr = this.sampleRateHz[deck];
        if (typeof sr === "number" && sr > 0) {
          ds.loopOutSec = rawValue / sr;
          this.touch(deck);
          logDiscover(deck, "[DISCOVER] LoopOut set:", rawValue, "samples / sr=", sr, "->", ds.loopOutSec.toFixed(3) + "s");
          logCues(deck, `[CUE] Deck ${deck} loop out @ ${ds.loopOutSec.toFixed(3)}s`);
        } else {
          logDiscover(deck, "[DISCOVER] LoopOut deferred (no SampleRate yet):", rawValue, "samples");
        }
      }

      // ---- Saved loops (QuickLoop1–8, samples → seconds) ----
      const quickLoopMatch = tail.match(/^(?:Track\/)?Loop\/QuickLoop([1-8])$/i);
      if (quickLoopMatch) {
        const idx = Number(quickLoopMatch[1]);
        let inSamples: number | undefined;
        let outSamples: number | undefined;
        let active: boolean | undefined;
        if (typeof rawValue === "object" && rawValue !== null) {
          const obj = rawValue as any;
          inSamples = obj.startPosition ?? obj.inPosition ?? obj.in;
          outSamples = obj.endPosition ?? obj.outPosition ?? obj.out;
          active = typeof obj.isActive === "boolean" ? obj.isActive : (obj.active === true);
        } else if (typeof rawValue === "number") {
          inSamples = rawValue;
        }
        const sr = this.sampleRateHz[deck];
        const toSec = (s: number) => (typeof sr === "number" && sr > 0) ? s / sr : s;
        if (typeof inSamples === "number" && inSamples >= 0) {
          const entry = {
            index: idx,
            inSec: toSec(inSamples),
            outSec: typeof outSamples === "number" && outSamples >= 0 ? toSec(outSamples) : toSec(inSamples),
            active: active ?? false,
          };
          ds.savedLoops = [
            ...ds.savedLoops.filter((l) => l.index !== idx),
            entry,
          ].sort((a, b) => a.index - b.index);
          this.touch(deck);
          logCues(deck, `[CUE] Deck ${deck} QuickLoop${idx} ${entry.inSec.toFixed(3)}s–${entry.outSec.toFixed(3)}s active=${entry.active}`);
        }
      }

      } catch (e: any) {
        logError('[StageLinq] message handler error:', e?.message || e);
      }
    });



    // nowPlaying provides high-level track + some realtime values.
    devices.on?.("nowPlaying", (status: any) => {
      try {
      // status.player is the physical player number (0 for Prime 4+, varies for SC6000s).
      // status.layer is the deck letter: 'A'=deck1, 'B'=deck2, 'C'=deck3, 'D'=deck4.
      // Using player+1 always resolves to deck 1 on a single-unit setup — wrong.
      const deck: DeckNumber | undefined = DECK_BY_LAYER[String(status?.layer).toUpperCase()];
      if (!deck || !DECKS.includes(deck)) return;
      const statusPath = typeof status?.trackNetworkPath === 'string' ? status.trackNetworkPath.trim() : '';
      if (statusPath && this.rawNetworkPaths[deck] && statusPath !== this.rawNetworkPaths[deck]) return;

      const ds = this.decks[deck];
      const nowPlayingFileName =
        toFileName(status?.fileName) ||
        toFileName(status?.filename) ||
        toFileName(status?.filePath) ||
        toFileName(status?.path) ||
        toFileName(status?.songIndex) ||
        toFileName(status?.song_index);
      if (nowPlayingFileName) {
        this.captureNetPath(deck,
          status?.fileName || status?.filename || status?.filePath ||
          status?.path || status?.songIndex || status?.song_index || '');
        ds.fileName = nowPlayingFileName;
        this.maybeFireTrackChanged(deck);
      }
      if (typeof status?.title === "string") {
        if (status.title.trim()) {
          ds.title = status.title;
          ds.trackLoaded = this.explicitTrackLoaded[deck] ?? true;
        } else {
          ds.title = "—";
          ds.trackLoaded = this.explicitTrackLoaded[deck] ?? false;
        }
      }
      if (typeof status?.artist === "string") {
        ds.artist = status.artist.trim() ? status.artist : "—";
      }

      // Some builds include key info in nowPlaying
      if (typeof status?.currentKeyIndex === "number") ds.keyIndex = status.currentKeyIndex;
      if (typeof status?.keyIndex === "number") ds.keyIndex = status.keyIndex;
      if (status?.key !== undefined) this.currentKeyCamelot[deck] = keyNameToCamelot(status.key);


      if (typeof status?.currentBpm === "number") {
        ds.currentBpm = status.currentBpm;
      }
      // Do NOT set ds.play here — nowPlaying fires on metadata events and its play field
      // does not reliably reflect the current transport state. Play state is owned exclusively
      // by the message/stateChanged handlers which also call maybeLogPlayChange.

      this.recomputeDerived(deck);
      this.touch(deck);
      } catch (e: any) {
        logError('[StageLinq] nowPlaying handler error:', e?.message || e);
      }
    });

    /**
     * BeatInfo
     * Depending on your @gree44/stagelinq build, beatMessage can be either:
     *  A) flattened per-deck: { deck: 0..3, bpm, timeline, samples, ... }
     *  B) aggregated: { decks: [{ bpm, samples, ... }, ...] }
     *
     * Support both.
     */
    devices.on?.("beatMessage", (a: any, b?: any) => {
      try {
      // Some emitters provide (info, payload), others (payload) only.
      const payload = b ?? a;
      const now = monotonicNowMs();
      if (this.realBeatReceivedSinceConnect && this.lastAnyBeatAtMs > 0) {
        recordBeatGap(now - this.lastAnyBeatAtMs);
      }
      this.lastAnyBeatAtMs = now;
      this.realBeatReceivedSinceConnect = true;

      // A) flattened payload: has deck index
      if (payload && (typeof payload.deck === "number" || typeof payload.deck === "string")) {
        const deck = (Number(payload.deck) + 1) as DeckNumber; // 0..3 -> 1..4
        if (!DECKS.includes(deck)) return;
        this.lastBeatAtMs[deck] = now;

        const ds = this.decks[deck];
        if (typeof payload.samples === "number" && Number.isFinite(payload.samples)) {
          const sr = this.sampleRateHz[deck];
          if (typeof sr === "number" && sr > 0) {
            const elapsed = payload.samples / sr;
            this.positionAtMs[deck] = now;
            this.positionTrackId[deck] = this.rawNetworkPaths[deck] || ds.fileName;
            this.positionRevision[deck]++;

            // Throttle: only update if elapsed changed by >= 0.1s
            if (Math.abs(elapsed - this.lastElapsedEmitSec[deck]) >= ELAPSED_THROTTLE_S) {
              ds.elapsedSec = elapsed;
              this.lastElapsedEmitSec[deck] = elapsed;

              if (!this.seen.elapsed) {
                this.seen.elapsed = true;
                logDiscover(
                  deck,
                  "[DISCOVER] ElapsedSec from BeatInfo samples:",
                  deck,
                  "samples=",
                  payload.samples,
                  "sr=",
                  sr
                );
              }
            }
          }
        }

        if (typeof payload.bpm === "number") {
          ds.currentBpm = payload.bpm;
        }

        this.recomputeDerived(deck);
        this.touch(deck);
        return;
      }

      // B) aggregated payload: { decks: [...] }
      const decksArr: any[] | undefined = payload?.decks;
      if (Array.isArray(decksArr)) {
        decksArr.forEach((d, idx) => {
          const deck = (idx + 1) as DeckNumber;
          if (!DECKS.includes(deck)) return;
          this.lastBeatAtMs[deck] = now;

          const ds = this.decks[deck];
          if (typeof d?.bpm === "number") {
            ds.currentBpm = d.bpm;
          }

          // Prefer samples + sampleRate (ArtNet-style) if available
          if (typeof d?.samples === "number" && Number.isFinite(d.samples)) {
            const sr = this.sampleRateHz[deck];
            if (typeof sr === "number" && sr > 0) {
              const elapsed = d.samples / sr;
              this.positionAtMs[deck] = now;
              this.positionTrackId[deck] = this.rawNetworkPaths[deck] || ds.fileName;
              this.positionRevision[deck]++;

              // Throttle: only update if elapsed changed by >= 0.1s
              if (Math.abs(elapsed - this.lastElapsedEmitSec[deck]) >= ELAPSED_THROTTLE_S) {
                ds.elapsedSec = elapsed;
                this.lastElapsedEmitSec[deck] = elapsed;

                if (!this.seen.elapsed) {
                  this.seen.elapsed = true;
                  logDiscover(
                    deck,
                    "[DISCOVER] ElapsedSec from BeatInfo decks[].samples:",
                    deck,
                    "samples=",
                    d.samples,
                    "sr=",
                    sr
                  );
                }
              }
            }
          }

          this.recomputeDerived(deck);
          this.touch(deck);
        });
      }
      } catch (e: any) {
        logError('[StageLinq] beatMessage handler error:', e?.message || e);
      }
    });

    // State map updates include TrackLength, current BPM/speed controls, key, fader, etc.
    devices.on?.("stateChanged", (state: any) => {
      try {
      const name = String(state?.name || "");
      if (!name) {
        const deck = DECK_BY_LAYER[String(state?.layer).toUpperCase()];
        const trackPath = typeof state?.trackNetworkPath === 'string' ? state.trackNetworkPath.trim() : '';
        if (!deck || !trackPath || trackPath !== this.rawNetworkPaths[deck] ||
          state.key === undefined || state.songLoaded === false) return;
        // The accumulated status recovers a key received before its replacement track path.
        const namedKey = keyNameToCamelot(state.key);
        if (namedKey === this.currentKeyCamelot[deck]) return;
        this.currentKeyCamelot[deck] = namedKey;
        this.recomputeDerived(deck);
        this.touch(deck);
        return;
      }
      const m = name.match(/^\/Engine\/Deck([1-4])\/(.*)$/);
      if (!m) return;

      const deck = Number(m[1]) as DeckNumber;
      if (!DECKS.includes(deck)) return;

      const tail = m[2];
      const value = state?.value;
      const ds = this.decks[deck];
      let bpmSpeedSourceUpdated = false;

      if (tail === "TrackLength" || tail === "Track/TrackLength") {
        if (typeof value === "number") ds.totalSec = Math.max(0, value);
      } else if (tail === "CurrentBPM") {
        if (typeof value === "number") {
          ds.currentBpm = value;
          this.currentBpmRaw[deck] = value;
          bpmSpeedSourceUpdated = true;
        }
      } else if (tail === "SpeedState") {
        if (typeof value === "number" && Number.isFinite(value)) {
          this.speedStateRaw[deck] = roundToDigits(value, 5);
        } else {
          this.speedStateRaw[deck] = value as number | string | boolean;
        }
        bpmSpeedSourceUpdated = true;
      }


      else if (tail === "ArtistName" || tail === "Track/ArtistName") {
        if (typeof value === "string") ds.artist = value.trim() ? value : "—";
      } else if (tail === "SongName" || tail === "Track/SongName") {
        if (typeof value === "string") {
          if (value.trim()) {
            ds.title = value;
            ds.trackLoaded = this.explicitTrackLoaded[deck] ?? true;
          } else {
            ds.title = "—";
            ds.trackLoaded = this.explicitTrackLoaded[deck] ?? false;
          }
        }
      } else if (/^(Track\/)?(FileName|Filename|FilePath|Path)$/i.test(tail)) {
        if (typeof value === "string" && value.trim()) {
          this.captureNetPath(deck, value);
          ds.fileName = toFileName(value);
          this.maybeFireTrackChanged(deck);
        }
      } else if (tail === "CurrentKeyIndex" || tail === "Track/CurrentKeyIndex") {
        if (typeof value === "number") ds.keyIndex = value;
      } else if (/^(?:Track\/)?(?:CurrentKey|Camelot|Key)$/i.test(tail)) {
        this.currentKeyCamelot[deck] = keyNameToCamelot(value);
      } else if (tail === "Play" || tail === "PlayState") {
        // Some builds may surface play state here too
        const playing = this.coerceBool(value);
        if (typeof playing === "boolean") {
          ds.play = playing;
          this.transportRevision[deck]++;
          this.maybeLogPlayChange(deck, playing);
        }
      }

      // ---- Discover unmatched loop paths via stateChanged ----
      if (/loop/i.test(tail)) {
        if (!this.seen.loops && /loop/i.test(tail)) {
          this.seen.loops = true;
          logDiscover(deck, "[DISCOVER] First loop path (stateChanged):", name, "=", JSON.stringify(value));
        }
      }

      // ---- HotCues: not exposed via stateChanged either; see m.db extraction script. ----

      // ---- Active loop via stateChanged ----
      if (tail === "Track/LoopEnableState" || tail === "LoopEnableState") {
        const active = this.coerceBool(value);
        if (typeof active === "boolean") {
          ds.loopActive = active;
          logCues(deck, `[CUE] Deck ${deck} loop ${active ? 'ENABLED' : 'DISABLED'}`);
        }
      }
      if ((tail === "Track/CurrentLoopInPosition" || tail === "CurrentLoopInPosition") && typeof value === "number") {
        this.loopInSamples[deck] = value;
        const sr = this.sampleRateHz[deck];
        if (typeof sr === "number" && sr > 0) {
          ds.loopInSec = value / sr;
          this.touch(deck);
          logDiscover(deck, "[DISCOVER] LoopIn set (stateChanged):", value, "/ sr=", sr, "->", ds.loopInSec.toFixed(3) + "s");
          logCues(deck, `[CUE] Deck ${deck} loop in @ ${ds.loopInSec.toFixed(3)}s`);
        } else {
          this.loopInSamples[deck] = value;
          logDiscover(deck, "[DISCOVER] LoopIn deferred (stateChanged, no SampleRate):", value, "samples");
        }
      }
      if ((tail === "Track/CurrentLoopOutPosition" || tail === "CurrentLoopOutPosition") && typeof value === "number") {
        this.loopOutSamples[deck] = value;
        const sr = this.sampleRateHz[deck];
        if (typeof sr === "number" && sr > 0) {
          ds.loopOutSec = value / sr;
          this.touch(deck);
          logDiscover(deck, "[DISCOVER] LoopOut set (stateChanged):", value, "/ sr=", sr, "->", ds.loopOutSec.toFixed(3) + "s");
          logCues(deck, `[CUE] Deck ${deck} loop out @ ${ds.loopOutSec.toFixed(3)}s`);
        } else {
          this.loopOutSamples[deck] = value;
          logDiscover(deck, "[DISCOVER] LoopOut deferred (stateChanged, no SampleRate):", value, "samples");
        }
      }

      // ---- Saved loops via stateChanged ----
      const quickLoopMatch2 = tail.match(/^(?:Track\/)?Loop\/QuickLoop([1-8])$/i);
      if (quickLoopMatch2) {
        const idx = Number(quickLoopMatch2[1]);
        let inSamples: number | undefined;
        let outSamples: number | undefined;
        let active: boolean | undefined;
        if (typeof value === "object" && value !== null) {
          const obj = value as any;
          inSamples = obj.startPosition ?? obj.inPosition ?? obj.in;
          outSamples = obj.endPosition ?? obj.outPosition ?? obj.out;
          active = typeof obj.isActive === "boolean" ? obj.isActive : (obj.active === true);
        } else if (typeof value === "number") {
          inSamples = value;
        }
        const sr = this.sampleRateHz[deck];
        const toSec = (s: number) => (typeof sr === "number" && sr > 0) ? s / sr : s;
        if (typeof inSamples === "number" && inSamples >= 0) {
          const entry = {
            index: idx,
            inSec: toSec(inSamples),
            outSec: typeof outSamples === "number" && outSamples >= 0 ? toSec(outSamples) : toSec(inSamples),
            active: active ?? false,
          };
          ds.savedLoops = [
            ...ds.savedLoops.filter((l) => l.index !== idx),
            entry,
          ].sort((a, b) => a.index - b.index);
          logCues(deck, `[CUE] Deck ${deck} QuickLoop${idx} ${entry.inSec.toFixed(3)}s–${entry.outSec.toFixed(3)}s active=${entry.active}`);
        }
      }

      this.recomputeDerived(deck);
      this.touch(deck);

      if (bpmSpeedSourceUpdated) {
        this.emitBpmDebug(deck, `stateChanged.${tail}`);
      }
      } catch (e: any) {
        logError('[StageLinq] stateChanged handler error:', e?.message || e);
      }
    });
  }

  async connect() {
    this.realBeatReceivedSinceConnect = false;
    await this.stageLinq.connect();
    this.lastAnyBeatAtMs = monotonicNowMs();
    this.startWatchdog();
  }

  async disconnect() {
    this.stopWatchdog();
    this.resetState();
    const instance = this.stageLinq;
    // Also stops discovery timers when an initial connect never completed.
    instance.devices.disconnectAll();
    try { await instance.disconnect(); } catch (error) {
      logError('[StageLinq] Disconnect cleanup failed:', error);
    }
    instance.devices.removeAllListeners();
    // A fresh public instance remains usable even if logout fails on a lost network.
    this.wire();
  }

  private stopWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  private resetState() {
    for (const d of DECKS) {
      this.decks[d] = this.blankDeck(d);
      this.currentKeyCamelot[d] = null;
      this.explicitTrackLoaded[d] = null;
      this.lastBeatAtMs[d] = 0;
      this.positionAtMs[d] = null;
      this.positionTrackId[d] = '';
      this.positionRevision[d]++;
      this.lastTriggeredTrackPaths[d] = '';
      this.rawNetworkPaths[d] = '';
      this.sampleRateHz[d] = null;
      this.currentBpmRaw[d] = null;
      this.speedStateRaw[d] = null;
      this.lastSpeedDiscoverSig[d] = null;
      this.trackLengthSamples[d] = null;
      this.loopInSamples[d] = null;
      this.loopOutSamples[d] = null;
      this.lastElapsedEmitSec[d] = -1;
      this.lastPlay[d] = undefined;
    }
    this.lastAnyBeatAtMs = 0;
    this.realBeatReceivedSinceConnect = false;
  }

  private startWatchdog() {
    this.stopWatchdog();
    this.watchdogInterval = setInterval(() => {
      const now = monotonicNowMs();

      for (const deck of DECKS) {
        const ds = this.decks[deck];
        if (ds.play && this.lastBeatAtMs[deck] > 0) {
          const silenceMs = now - this.lastBeatAtMs[deck];
          if (silenceMs > BEAT_WATCHDOG_TIMEOUT_S * 1000) {
            logError(
              `[Watchdog] Deck ${deck}: playing but no beat for ${(silenceMs / 1000).toFixed(1)}s — marking stopped`,
            );
            ds.play = false;
            this.touch(deck);
          }
        }
      }

      if (this.lastAnyBeatAtMs > 0) {
        const silenceMs = now - this.lastAnyBeatAtMs;
        const threshold = this.realBeatReceivedSinceConnect
          ? DISCONNECT_DETECT_TIMEOUT_S * 1000
          : CONNECT_BEAT_GRACE_S * 1000;
        if (silenceMs > threshold) {
          logError(`[Watchdog] No beat for ${(silenceMs / 1000).toFixed(1)}s — triggering reconnect`);
          this.lastAnyBeatAtMs = 0; // prevent re-trigger before disconnect completes
          this.opts.onCommunicationLost?.();
        }
      }
    }, 1000);
  }

  getDecks(): Record<DeckNumber, DeckState> {
    const out = {} as Record<DeckNumber, DeckState>;
    for (const d of DECKS) out[d] = { ...this.decks[d] };
    return out;
  }

  getDeck(deck: DeckNumber): DeckState {
    return { ...this.decks[deck] };
  }

  getDeckTiming(deck: DeckNumber): SourceTiming {
    return {
      positionAtMs: this.positionAtMs[deck],
      positionRevision: this.positionRevision[deck],
      transportRevision: this.transportRevision[deck],
      trackId: this.positionTrackId[deck],
    };
  }

  getDeckTimings(): Record<DeckNumber, SourceTiming> {
    return Object.fromEntries(DECKS.map((deck) => [deck, this.getDeckTiming(deck)])) as Record<DeckNumber, SourceTiming>;
  }

  getRawNetworkPath(deck: DeckNumber): string {
    return this.rawNetworkPaths[deck];
  }

  /** Ms since last beat received. Returns Infinity if no real beat has arrived since last connect. */
  getLastBeatAgeMs(): number {
    if (!this.realBeatReceivedSinceConnect) return Infinity;
    if (this.lastAnyBeatAtMs === 0) return Infinity;
    return monotonicNowMs() - this.lastAnyBeatAtMs;
  }

  /**
   * Subscribe to per-deck state mutations. Listener fires synchronously from inside touch()
   * on every change (full bridge cadence — no throttling). Returns an unsubscribe function.
   */
  subscribeDeckState(fn: DeckStateListener): () => void {
    this.deckListeners.add(fn);
    return () => { this.deckListeners.delete(fn); };
  }

  async downloadFile(
    netPath: string,
    onProgress: (pct: number) => void,
  ): Promise<Uint8Array> {
    const parsedPath = parseNetworkPath(netPath);
    if (!parsedPath || !parsedPath.sourceName || !parsedPath.folderPath) {
      throw new Error('Invalid net path (expected net://uuid/source/file): "' + netPath + '"');
    }
    const deviceId = 'net://' + parsedPath.deviceUuid;
    const filePath = '/' + parsedPath.sourceName + '/' + parsedPath.folderPath;

    logWaveform(`[WAVEFORM] downloadFile deviceId="${deviceId}" filePath="${filePath}"`);

    // FileTransfer has a single shared buffer per device — concurrent getFile() calls corrupt
    // each other's data. Serialize all downloads for the same device via a promise chain.
    let result!: Uint8Array;
    const prev = this.downloadQueues.get(deviceId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const POLL_MS = 500;
      const TIMEOUT_MS = 30_000;
      const deadline = Date.now() + TIMEOUT_MS;

      while (true) {
        const ft = this.stageLinqDevices?.getFileTransferService?.(deviceId);
        if (ft) {
          const handler = (progress: { percentComplete: number }) => {
            onProgress(Math.round(progress.percentComplete));
          };
          ft.on('fileTransferProgress', handler);
          try {
            result = await ft.getFile(filePath);
            return;
          } finally {
            ft.off('fileTransferProgress', handler);
          }
        }

        if (Date.now() >= deadline) {
          throw new Error(`FileTransfer service not available for ${deviceId} after ${TIMEOUT_MS / 1000}s`);
        }
        logWaveform(`${YEL}[WAVEFORM] FileTransfer not ready yet for ${deviceId}, retrying in ${POLL_MS}ms…${RST}`);
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    });
    this.downloadQueues.set(deviceId, next.catch(() => {}));
    await next;
    return result;
  }
}
