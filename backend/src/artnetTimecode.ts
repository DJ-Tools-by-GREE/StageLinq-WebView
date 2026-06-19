import { Worker } from 'node:worker_threads';
import type { DeckNumber, DeckState } from './types.js';
import type {
  ArtNetWorkerInitOptions,
  MainToWorker,
  TrackOffsetMap,
  WorkerToMain,
} from './artnetWorkerMessages.js';
import { logError, logWarn, logLifecycle, logStatus, setArtnetTcHms, LOG_ENABLED, GRN, RST } from './logging.js';

export interface ArtNetOptions {
  enabled: boolean;
  targetIps: string[];
  port: number;
  fps: number;
  sendHz?: number;
  fpsType: number; // 0x00=24,0x01=25,0x02=29.97,0x03=30
  streamId?: number;
  deck: 1 | 2 | 3 | 4;
  latencyCompMs?: number;
  enableFreewheeling?: boolean;
  freewheelMaxDurationSec?: number;
  /** Stale threshold in ms — passed verbatim into the worker. */
  freewheelStaleThresholdMs: number;
}

/**
 * Owns the Art-Net worker thread. The worker now owns the full timecode pipeline:
 *  - the 30 Hz tick (no main-thread setInterval pump anymore)
 *  - the deck-state cache for all 4 decks
 *  - selectedDeck, trackOffsets, freewheel-stale derivation
 *
 * The main thread is reduced to forwarding state changes:
 *  - setSelectedDeck() on sACN flip
 *  - setTrackOffsets() on config (re)load
 *  - pushDeckState() on each bridge mutation (or pushAllDeckStates() during replay)
 *  - beatPulse() on every StageLinq beatMessage so freewheel-stale resets
 *
 * Even if main-thread CPU stalls for seconds (huge StageLinq downloads, ffmpeg
 * storms, GC pauses), the worker keeps ticking and freewheels cleanly across the
 * gap. When main resumes and pushes the catch-up state, the timeline rebases
 * cleanly because the drift snap is suppressed during stall.
 */
export class ArtNetTimecodeBroadcaster {
  private opts: ArtNetOptions;
  private worker: Worker | null = null;
  private freewheelActive = false;
  private freewheelChangeCb: ((active: boolean) => void) | null = null;

  constructor(opts: ArtNetOptions) {
    this.opts = opts;
  }

  isFreewheelActive(): boolean {
    return this.freewheelActive;
  }

  onFreewheelChange(cb: (active: boolean) => void): void {
    this.freewheelChangeCb = cb;
  }

  setFreewheel(enableFreewheeling: boolean, freewheelMaxDurationSec: number) {
    this.opts.enableFreewheeling = enableFreewheeling;
    this.opts.freewheelMaxDurationSec = freewheelMaxDurationSec;
    this.post({ type: 'setFreewheel', enableFreewheeling, freewheelMaxDurationSec });
  }

  /** Compatibility shim — kept so callers don't need to change. The real timeline lives in the worker. */
  getElapsedSec(): number {
    return 0;
  }

  setSelectedDeck(deck: DeckNumber | null) {
    this.post({ type: 'setSelectedDeck', deck });
  }

  setTrackOffsets(offsets: TrackOffsetMap) {
    this.post({ type: 'setTrackOffsets', offsets });
  }

  pushDeckState(deck: DeckNumber, state: DeckState) {
    this.post({ type: 'pushDeckState', deck, state });
  }

  pushAllDeckStates(decks: Record<DeckNumber, DeckState>, bumpBeat: boolean) {
    this.post({ type: 'pushAllDeckStates', decks, bumpBeat });
  }

  beatPulse(atMs: number) {
    this.post({ type: 'beatPulse', atMs });
  }

  setReconnecting(reconnecting: boolean) {
    this.post({ type: 'setReconnecting', reconnecting });
  }

  async start(): Promise<void> {
    if (!this.opts.enabled) return;

    // tsx propagates its loader to worker_threads automatically (tsx 4.x), so we can resolve
    // both the .ts (dev under tsx watch) and the .js (compiled dist) source from the same path
    // by switching extensions at runtime.
    const isTs = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(`./artnetWorker.${isTs ? 'ts' : 'js'}`, import.meta.url);

    const worker = new Worker(workerUrl);
    this.worker = worker;

    worker.on('message', (m: WorkerToMain) => this.handleWorkerMessage(m));
    worker.on('error', (err) => {
      logError('[ArtNet] Worker error:', err?.message || err);
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        logError(`[ArtNet] Worker exited with code ${code}`);
      }
      this.worker = null;
    });

    const sendHz = Math.max(1, Number(this.opts.sendHz ?? this.opts.fps));
    const initOpts: ArtNetWorkerInitOptions = {
      enabled: this.opts.enabled,
      targetIps: this.opts.targetIps,
      port: this.opts.port,
      fps: this.opts.fps,
      sendHz,
      fpsType: this.opts.fpsType,
      streamId: this.opts.streamId ?? 0x00,
      latencyCompMs: this.opts.latencyCompMs ?? 80,
      enableFreewheeling: this.opts.enableFreewheeling ?? true,
      freewheelMaxDurationSec: this.opts.freewheelMaxDurationSec ?? 30,
      freewheelStaleThresholdMs: this.opts.freewheelStaleThresholdMs,
    };

    await new Promise<void>((resolve, reject) => {
      const onMessage = (m: WorkerToMain) => {
        if (m.type === 'ready') {
          worker.off('message', onMessage);
          worker.off('error', onError);
          resolve();
        }
      };
      const onError = (err: Error) => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        reject(err);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      this.post({ type: 'init', opts: initOpts });
    });

    logLifecycle(`${GRN}Art-Net TC enabled: ${this.opts.targetIps.join(', ')}:${this.opts.port} @ ${this.opts.fps}fps, send=${sendHz}Hz (worker thread, deck ${this.opts.deck}, pump-in-worker)${RST}`);
  }

  async stop(): Promise<void> {
    if (!this.worker) return;
    this.post({ type: 'shutdown' });
    const w = this.worker;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { w.terminate(); } catch {}
        resolve();
      }, 1000);
      w.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.worker = null;
  }

  private post(msg: MainToWorker) {
    if (!this.worker) return;
    try {
      this.worker.postMessage(msg);
    } catch (e: any) {
      logError('[ArtNet] postMessage failed:', e?.message || e);
    }
  }

  private handleWorkerMessage(m: WorkerToMain) {
    switch (m.type) {
      case 'log':
        if (m.level === 'error') logError(m.msg);
        else if (m.level === 'warn') logWarn(m.msg);
        else if (m.level === 'success') logLifecycle(`${GRN}${m.msg}${RST}`);
        else logLifecycle(m.msg);
        break;
      case 'statsHeartbeat':
        if (LOG_ENABLED.artnetStats) logLifecycle(m.msg);
        break;
      case 'tcDisplay':
        logStatus('artnet', m.text);
        setArtnetTcHms(m.hms);
        break;
      case 'freewheelState':
        if (this.freewheelActive !== m.active) {
          this.freewheelActive = m.active;
          try { this.freewheelChangeCb?.(m.active); } catch (e: any) {
            logError('[ArtNet] freewheel change callback threw:', e?.message || e);
          }
        }
        break;
      case 'stats':
      case 'ready':
        break;
    }
  }
}
