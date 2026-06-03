import type { DeckNumber, DeckState } from "./types.js";
import path from "node:path";
import { keyIndexToCamelot } from "./camelot.js";
import { logBpmDebug, logDiscover, logDiscoverSpeed, logError, logLifecycle, logPlayback, logWaveform, GRN, YEL, RST } from "./logging.js";
import { BEAT_WATCHDOG_TIMEOUT_S, DISCONNECT_DETECT_TIMEOUT_S, ELAPSED_THROTTLE_S } from "./constants.js";

import * as pkg from "@gree44/stagelinq";


// Resolve StageLinq export shape (some versions export default, some export { StageLinq }).
const StageLinq: any = (pkg as any).StageLinq ?? (pkg as any).default ?? pkg;

const DECKS: DeckNumber[] = [1, 2, 3, 4];

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

  // Avoid repeated [DISCOVER] speed logs when values haven't changed.
  private lastSpeedDiscoverSig: Record<DeckNumber, string | null> = {
    1: null,
    2: null,
    3: null,
    4: null,
  };

  // TrackLength is sometimes published in *samples* (not seconds).
  // If we see a "too large" number, we keep it here until we have SampleRate.
  private pendingTrackLengthSamples: Record<DeckNumber, number | null> = { 1: null, 2: null, 3: null, 4: null };

  // Throttle elapsedSec updates (we don't need frame-accurate like timecode)
  private lastElapsedEmitSec: Record<DeckNumber, number> = { 1: -1, 2: -1, 3: -1, 4: -1 };

  // Watchdog: timestamps of last beatMessage received per deck and across all decks
  private lastBeatAtMs: Record<DeckNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  private lastAnyBeatAtMs = 0;
  private watchdogInterval: NodeJS.Timeout | null = null;

  // Captured full net:// paths (before basename stripping) and change-tracking for onTrackChanged.
  private rawNetworkPaths: Record<DeckNumber, string> = { 1: '', 2: '', 3: '', 4: '' };
  private lastTriggeredFileNames: Record<DeckNumber, string> = { 1: '', 2: '', 3: '', 4: '' };

  private stageLinqDevices: any = null;
  // Serialize downloads per device: FileTransfer has a single shared buffer and cannot handle concurrent getFile() calls.
  private downloadQueues = new Map<string, Promise<void>>();

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
    };
  }

  private touch(deck: DeckNumber) {
    this.decks[deck].updatedAt = Date.now();
  }

  private captureNetPath(deck: DeckNumber, rawValue: unknown) {
    if (typeof rawValue === 'string') {
      const s = rawValue.trim();
      if (s) this.rawNetworkPaths[deck] = s;
    }
  }

  private maybeFireTrackChanged(deck: DeckNumber) {
    const fn = this.decks[deck].fileName;
    const netPath = this.rawNetworkPaths[deck];
    if (!fn || !netPath) return;
    if (fn !== this.lastTriggeredFileNames[deck]) {
      this.lastTriggeredFileNames[deck] = fn;
      this.opts.onTrackChanged?.(deck, fn, netPath);
    }
  }
  private unloadDeck(deck: DeckNumber) {
    this.decks[deck].trackLoaded = false;
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
    ds.keyCamelot = keyIndexToCamelot(ds.keyIndex);

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
      this.touch(deck);
      this.maybeFireTrackChanged(deck);
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
      ds.totalSec = durMs / 1000;
      this.touch(deck);
      if (!this.seen.total) {
        this.seen.total = true;
        logDiscover(deck, "[DISCOVER] totalSec from TrackData (ms):", deck, ds.totalSec);
      }
    } else if (typeof durSec === "number" && durSec > 0) {
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

    if (typeof keyIdx === "number") {
      ds.keyIndex = keyIdx;
      this.recomputeDerived(deck);
      this.touch(deck);
      if (!this.seen.key) {
        this.seen.key = true;
        logDiscover(deck, "[DISCOVER] keyIndex from TrackData:", deck, keyIdx, "->", ds.keyCamelot);
      }
      return;
    }

    // camelot string directly
    const camelot =
      (typeof obj.camelot === "string" ? obj.camelot : undefined) ??
      (typeof obj.key === "string" ? obj.key : undefined);

    if (typeof camelot === "string" && camelot.trim()) {
      ds.keyCamelot = camelot.trim();
      this.touch(deck);
      if (!this.seen.key) {
        this.seen.key = true;
        logDiscover(deck, "[DISCOVER] key (string) from TrackData:", deck, ds.keyCamelot);
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
    // Set options (including logger) before the static instance is created via devices access.
    StageLinq.options = {
      downloadDbSources: false,
      enableFileTranfer: true,
      logger: {
        trace: () => {},
        debug: () => {},
        info:  (msg: string, ...args: unknown[]) => logLifecycle('[StageLinq]', msg, ...args),
        warn:  (msg: string, ...args: unknown[]) => logError('[StageLinq]', msg, ...args),
        error: (msg: string, ...args: unknown[]) => logError('[StageLinq]', msg, ...args),
      },
    };
    const devices = StageLinq.devices;
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
        this.touch(deck);
        this.maybeFireTrackChanged(deck);
      }

      // ---- Explicit track-loaded flag (if emitted by device) ----
      if (/TrackIsLoaded$/i.test(tail) || /IsLoaded$/i.test(tail)) {
        const loaded = this.coerceBool(rawValue);
        if (typeof loaded === "boolean") {
          if (!loaded) {
            this.unloadDeck(deck);
          } else {
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
          const pendingSamples = this.pendingTrackLengthSamples[deck];
          if (Number.isFinite(pendingSamples) && (pendingSamples as number) > 0) {
            ds.totalSec = (pendingSamples as number) / rawValue;
            this.pendingTrackLengthSamples[deck] = null;
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
          const sr = this.sampleRateHz[deck];
          if (typeof sr === "number" && Number.isFinite(sr) && sr > 0) {
            ds.totalSec = Math.max(0, rawValue / sr);
          } else {
            // We'll convert once SampleRate arrives.
            this.pendingTrackLengthSamples[deck] = rawValue;
          }
        } else {
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

      // Sometimes key comes as a string (already Camelot like "8A")
      if (/(Track\/)?(Camelot|Key)$/i.test(tail) && typeof rawValue === "string" && rawValue.trim()) {
        ds.keyCamelot = rawValue.trim();
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
        ds.trackLoaded = true;
        this.touch(deck);
      } else if ((/SongName$/i.test(tail) || /Title$/i.test(tail)) && typeof rawValue === "string" && !rawValue.trim()) {
        this.unloadDeck(deck);
        this.touch(deck);
      }
      if ((/ArtistName$/i.test(tail) || /Artist$/i.test(tail)) && typeof rawValue === "string" && rawValue.trim()) {
        ds.artist = rawValue;
        ds.trackLoaded = true;
        this.touch(deck);
      } else if ((/ArtistName$/i.test(tail) || /Artist$/i.test(tail)) && typeof rawValue === "string" && !rawValue.trim()) {
        this.unloadDeck(deck);
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
          this.touch(deck);
          this.maybeLogPlayChange(deck, playing2);
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
      const layerMap: Record<string, DeckNumber> = { A: 1, B: 2, C: 3, D: 4 };
      const deck: DeckNumber | undefined = layerMap[String(status?.layer).toUpperCase()];
      if (!deck || !DECKS.includes(deck)) return;

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
          ds.trackLoaded = true;
        } else {
          this.unloadDeck(deck);
        }
      }
      if (typeof status?.artist === "string") {
        if (status.artist.trim()) {
          ds.artist = status.artist;
          ds.trackLoaded = true;
        } else {
          this.unloadDeck(deck);
        }
      }

      // Some builds include key info in nowPlaying
      if (typeof status?.currentKeyIndex === "number") ds.keyIndex = status.currentKeyIndex;
      if (typeof status?.keyIndex === "number") ds.keyIndex = status.keyIndex;


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
      const now = Date.now();
      this.lastAnyBeatAtMs = now;

      // A) flattened payload: has deck index
      if (payload && (typeof payload.deck === "number" || typeof payload.deck === "string")) {
        const deck = (Number(payload.deck) + 1) as DeckNumber; // 0..3 -> 1..4
        if (!DECKS.includes(deck)) return;
        this.lastBeatAtMs[deck] = now;

        const ds = this.decks[deck];
        if (typeof payload.samples === "number") {
          const sr = this.sampleRateHz[deck];
          if (typeof sr === "number" && sr > 0) {
            const elapsed = payload.samples / sr;

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
              this.touch(deck);
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
          if (typeof d?.samples === "number") {
            const sr = this.sampleRateHz[deck];
            if (typeof sr === "number" && sr > 0) {
              const elapsed = d.samples / sr;

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
                this.touch(deck);
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
        if (typeof value === "string") {
          if (value.trim()) {
            ds.artist = value;
            ds.trackLoaded = true;
          } else {
            this.unloadDeck(deck);
          }
        }
      } else if (tail === "SongName" || tail === "Track/SongName") {
        if (typeof value === "string") {
          if (value.trim()) {
            ds.title = value;
            ds.trackLoaded = true;
          } else {
            this.unloadDeck(deck);
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
      } else if (tail === "Play" || tail === "PlayState") {
        // Some builds may surface play state here too
        const playing = this.coerceBool(value);
        if (typeof playing === "boolean") {
          ds.play = playing;
          this.maybeLogPlayChange(deck, playing);
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
    await StageLinq.connect();
    this.lastAnyBeatAtMs = Date.now();
    this.startWatchdog();
  }

  async disconnect() {
    this.stopWatchdog();
    this.resetState();
    await StageLinq.disconnect();
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
      this.lastBeatAtMs[d] = 0;
    }
    this.lastAnyBeatAtMs = 0;
  }

  private startWatchdog() {
    this.stopWatchdog();
    this.watchdogInterval = setInterval(() => {
      const now = Date.now();

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
        if (silenceMs > DISCONNECT_DETECT_TIMEOUT_S * 1000) {
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

  getRawNetworkPath(deck: DeckNumber): string {
    return this.rawNetworkPaths[deck];
  }

  async downloadFile(
    netPath: string,
    onProgress: (pct: number) => void,
  ): Promise<Uint8Array> {
    const parts = netPath.split('/');
    // net://uuid/source/path → parts: ['net:', '', 'uuid', 'source', ...]
    if (parts.length < 4 || parts[0] !== 'net:') {
      throw new Error(`Invalid net path (expected net://uuid/source/...): "${netPath}"`);
    }
    const deviceId = `net://${parts[2]}`;
    const filePath = '/' + parts.slice(3).join('/');

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
