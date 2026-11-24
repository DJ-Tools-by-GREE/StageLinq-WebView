import { Worker } from 'node:worker_threads';
import { ARTNET_WORKER_READY_TIMEOUT_MS } from './constants.js';
import type { DeckNumber, DeckState, SourceTiming } from './types.js';
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

/** Pushes deck state and captured position timing to the independent UDP worker. */
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

  setSource(decks: Record<DeckNumber, DeckState>, timings: Record<DeckNumber, SourceTiming>, offsets: TrackOffsetMap) {
    this.post({ type: 'setSource', decks, timings, offsets });
  }

  setTrackOffsets(offsets: TrackOffsetMap) {
    this.post({ type: 'setTrackOffsets', offsets });
  }

  pushDeckState(deck: DeckNumber, state: DeckState, timing: SourceTiming) {
    this.post({ type: 'pushDeckState', deck, state, timing });
  }

  pushAllDeckStates(decks: Record<DeckNumber, DeckState>, timings: Record<DeckNumber, SourceTiming>) {
    this.post({ type: 'pushAllDeckStates', decks, timings });
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
      if (this.worker === worker) {
        this.worker = null;
        this.handleWorkerMessage({ type: 'freewheelState', active: false });
      }
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

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
        };
        const onMessage = (m: WorkerToMain) => {
          if (m.type === 'ready') { cleanup(); resolve(); }
          else if (m.type === 'initError') { cleanup(); reject(new Error(m.message)); }
        };
        const onError = (err: Error) => { cleanup(); reject(err); };
        const onExit = (code: number) => { cleanup(); reject(new Error('Art-Net worker exited before ready: ' + code)); };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('Art-Net worker readiness timed out'));
        }, ARTNET_WORKER_READY_TIMEOUT_MS);
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);
        worker.postMessage({ type: 'init', opts: initOpts } satisfies MainToWorker);
      });
    } catch (error) {
      await worker.terminate();
      if (this.worker === worker) this.worker = null;
      throw error;
    }

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
    this.handleWorkerMessage({ type: 'freewheelState', active: false });
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
      case 'initError':
        break;
    }
  }
}
