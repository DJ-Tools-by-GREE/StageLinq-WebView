import { Worker } from 'node:worker_threads';
import type { DeckState } from './types.js';
import type {
  ArtNetWorkerInitOptions,
  MainToWorker,
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
  sendWhenStopped?: boolean;
}

/**
 * Owns the Art-Net worker thread. The actual UDP send loop runs entirely off the main thread,
 * so waveform extraction, WebSocket broadcasts, and JSON serialization can never starve it.
 *
 * The main thread only does two things:
 *  - poll getDeckState() at sendHz and post it to the worker (a few µs per tick)
 *  - forward setSendWhenStopped() and stop() lifecycle calls
 *
 * The worker holds the dgram socket, the self-correcting tick deadline, and all stats.
 */
export class ArtNetTimecodeBroadcaster {
  private opts: ArtNetOptions;
  private worker: Worker | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private getDeckState: (() => DeckState | undefined) | null = null;
  private sendWhenStopped: boolean;

  constructor(opts: ArtNetOptions) {
    this.opts = opts;
    this.sendWhenStopped = opts.sendWhenStopped === true;
  }

  setSendWhenStopped(enabled: boolean) {
    this.sendWhenStopped = enabled;
    this.post({ type: 'setSendWhenStopped', enabled });
  }

  /** Compatibility shim — kept so callers don't need to change. The real timeline lives in the worker. */
  getElapsedSec(): number {
    return 0;
  }

  async start(getDeckState: () => DeckState | undefined): Promise<void> {
    if (!this.opts.enabled) return;

    this.getDeckState = getDeckState;

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
      sendWhenStopped: this.sendWhenStopped,
    };

    // Wait for ready before starting the polling pump so we don't enqueue updateDeck
    // messages against an un-bound socket.
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

    const pollIntervalMs = Math.max(1, Math.round(1000 / sendHz));
    this.pollTimer = setInterval(() => this.pumpDeckState(), pollIntervalMs);

    logLifecycle(`${GRN}Art-Net TC enabled: ${this.opts.targetIps.join(', ')}:${this.opts.port} @ ${this.opts.fps}fps, send=${sendHz}Hz (worker thread, deck ${this.opts.deck})${RST}`);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
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

  private pumpDeckState() {
    if (!this.getDeckState || !this.worker) return;
    const ds = this.getDeckState();
    this.post({ type: 'updateDeck', deck: ds ?? null });
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
        // 'warn' covers cadence drops, late ticks, hard stalls — visible in yellow and persisted
        // to the run log; 'error' is red and also persisted.
        if (m.level === 'error') logError(m.msg);
        else if (m.level === 'warn') logWarn(m.msg);
        else if (m.level === 'success') logLifecycle(`${GRN}${m.msg}${RST}`);
        else logLifecycle(m.msg);
        break;
      case 'statsHeartbeat':
        // Periodic healthy tick-stats info line — gated by its own flag so it can be silenced
        // without affecting other lifecycle output or the warn/error variants.
        if (LOG_ENABLED.artnetStats) logLifecycle(m.msg);
        break;
      case 'tcDisplay':
        logStatus('artnet', m.text);
        setArtnetTcHms(m.hms);
        break;
      case 'stats':
      case 'ready':
        // 'stats' messages exist for programmatic consumers; the human-readable form is already
        // logged from the worker via 'log' / 'statsHeartbeat'. 'ready' is consumed in start().
        break;
    }
  }
}
