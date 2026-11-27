import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { monotonicNowMs } from './timecodeTimeline.js';
import { logLifecycle } from './logging.js';
import type { VideoConfig } from './videoTypes.js';
import type { NativeVideoStatus, VideoDeckCommand } from './videoProtocol.js';
import {
  VIDEO_HELPER_START_TIMEOUT_MS, VIDEO_HELPER_STOP_TIMEOUT_MS, VIDEO_HELPER_MAX_LINE_BYTES,
  VIDEO_HELPER_MAX_PENDING_BYTES, VIDEO_HELPER_CLOCK_SAMPLES, VIDEO_HELPER_PING_TIMEOUT_MS,
  VIDEO_HELPER_STATE_TIMEOUT_MS, VIDEO_HELPER_LOAD_TIMEOUT_MS, VIDEO_HELPER_DRIFT_SEC,
  VIDEO_MAX_FRAME_PIXELS, VIDEO_MAX_OUTPUT_FPS, VIDEO_MAX_DECODE_FRAMES_PER_TICK, VIDEO_TIMER_LEEWAY_MS,
} from './constants.js';

export interface VideoRenderer {
  start(config: VideoConfig): Promise<void>;
  send(decks: VideoDeckCommand[], nowMs: number): void;
  stop(): Promise<void>;
}

type Callbacks = { status: (status: NativeVideoStatus) => void; error: (message: string) => void };
type Waiter = { resolve: (hostTimeSec: number) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class NativeVideoHelper implements VideoRenderer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private stopping = false;
  private blocked = false;
  private latestState: string | null = null;
  private seq = 0;
  private pingId = 0;
  private offsetSec = 0;
  private waits = new Map<number, Waiter>();
  private failStart: ((error: Error) => void) | null = null;
  private readyStart: (() => void) | null = null;
  private exited: Promise<void> | null = null;

  constructor(private callbacks: Callbacks, private executable = process.env.VIDEO_HELPER_PATH ??
    fileURLToPath(new URL('../../native/video-ndi/dist/video-ndi-helper', import.meta.url))) {}

  async start(config: VideoConfig): Promise<void> {
    if (this.child) throw new Error('Video helper is already started');
    this.stopping = false;
    const child = spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let pending = '';
    let stderr = '';
    const decoder = new StringDecoder('utf8');
    const started = new Promise<void>((resolve, reject) => { this.readyStart = resolve; this.failStart = reject; });
    const timer = setTimeout(() => this.fail(new Error('Video helper startup timed out')), VIDEO_HELPER_START_TIMEOUT_MS);
    this.exited = new Promise(resolve => child.once('close', () => {
      const unexpected = !this.stopping;
      this.child = null;
      this.rejectPings(new Error('Video helper closed'));
      if (unexpected) this.fail(new Error(stderr.trim() || 'Video helper exited unexpectedly'));
      this.ready = false;
      resolve();
    }));
    child.on('error', error => this.fail(new Error('Cannot start video helper: ' + error.message + '. Run npm run build:video with the NDI SDK installed.')));
    child.stdin.on('error', error => { if (!this.stopping) this.fail(error); });
    child.stdin.on('drain', () => {
      this.blocked = false;
      if (this.latestState) { const line = this.latestState; this.latestState = null; this.write(line); }
    });
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-VIDEO_HELPER_MAX_LINE_BYTES); });
    child.stdout.on('data', (data: Buffer) => {
      pending += decoder.write(data);
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > VIDEO_HELPER_MAX_LINE_BYTES) { this.fail(new Error('Video helper output exceeded line limit')); return; }
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
      }
      if (Buffer.byteLength(pending) > VIDEO_HELPER_MAX_LINE_BYTES) this.fail(new Error('Video helper output exceeded line limit'));
    });
    this.write(JSON.stringify({
      type: 'configure', protocol: 1,
      sourceNames: config.multi_ndi_stream ? [1, 2, 3, 4].map(deck => config.ndi_name_prefix + ' Deck ' + deck) : [config.ndi_name_prefix],
      outputFormat: config.output_format,
      settings: { stateTimeoutMs: VIDEO_HELPER_STATE_TIMEOUT_MS, loadTimeoutMs: VIDEO_HELPER_LOAD_TIMEOUT_MS,
        seekThresholdSec: VIDEO_HELPER_DRIFT_SEC, maxFramePixels: VIDEO_MAX_FRAME_PIXELS,
        maxOutputFps: VIDEO_MAX_OUTPUT_FPS, maxDecodeFramesPerTick: VIDEO_MAX_DECODE_FRAMES_PER_TICK,
        timerLeewayMs: VIDEO_TIMER_LEEWAY_MS },
    }) + '\n');
    try {
      await started;
      let bestRtt = Infinity;
      for (let i = 0; i < VIDEO_HELPER_CLOCK_SAMPLES; i++) {
        const before = monotonicNowMs();
        const hostTimeSec = await this.ping();
        const after = monotonicNowMs();
        if (after - before < bestRtt) {
          bestRtt = after - before;
          this.offsetSec = hostTimeSec - (before + after) / 2000;
        }
      }
      this.ready = true;
      logLifecycle('[VIDEO] Native renderer ready');
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
      this.failStart = null;
      this.readyStart = null;
    }
  }

  send(decks: VideoDeckCommand[], nowMs: number): void {
    if (!this.ready || !this.child || this.stopping) return;
    const line = JSON.stringify({ type: 'state', seq: ++this.seq, hostTimeSec: nowMs / 1000 + this.offsetSec, decks }) + '\n';
    if (this.blocked) this.latestState = line;
    else this.write(line);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.latestState = null;
    this.rejectPings(new Error('Video helper stopping'));
    this.failStart?.(new Error('Video helper stopping'));
    const child = this.child;
    if (!child) return;
    const kill = setTimeout(() => child.kill('SIGKILL'), VIDEO_HELPER_STOP_TIMEOUT_MS);
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end(JSON.stringify({ type: 'shutdown' }) + '\n');
    else if (child.stdin.destroyed) child.kill('SIGTERM');
    try { await this.exited; } finally { clearTimeout(kill); }
  }

  private write(line: string): void {
    if (!this.child || this.stopping) return;
    if (this.child.stdin.writableLength + Buffer.byteLength(line) > VIDEO_HELPER_MAX_PENDING_BYTES) {
      this.fail(new Error('Video helper input backlog exceeded limit')); return;
    }
    this.blocked = !this.child.stdin.write(line);
  }

  private ping(): Promise<number> {
    const id = ++this.pingId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waits.delete(id); reject(new Error('Video helper clock synchronization timed out')); }, VIDEO_HELPER_PING_TIMEOUT_MS);
      this.waits.set(id, { resolve, reject, timer });
      this.write(JSON.stringify({ type: 'ping', id }) + '\n');
    });
  }

  private rejectPings(error: Error): void {
    for (const waiter of this.waits.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waits.clear();
  }

  private fail(error: Error): void {
    const wasReady = this.ready;
    this.ready = false;
    this.failStart?.(error);
    this.rejectPings(error);
    this.child?.kill('SIGTERM');
    if (wasReady) this.callbacks.error(error.message);
  }

  private receive(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid video helper message');
    const message = raw as Record<string, unknown>;
    if (message.type === 'ready' && message.protocol === 1) {
      if (message.testMode === true) throw new Error('Video helper is in test mode and cannot send NDI');
      return;
    }
    if (message.type === 'configured' && message.protocol === 1) { this.readyStart?.(); return; }
    if (message.type === 'pong' && typeof message.id === 'number' && typeof message.hostTimeSec === 'number' && Number.isFinite(message.hostTimeSec)) {
      const waiter = this.waits.get(message.id);
      if (waiter) { clearTimeout(waiter.timer); this.waits.delete(message.id); waiter.resolve(message.hostTimeSec); }
      return;
    }
    if (message.type === 'error' && typeof message.error === 'string') throw new Error(message.error);
    if (message.type !== 'status' || ![1, 2, 3, 4].includes(Number(message.deck)) || typeof message.deck !== 'number' ||
      !['idle', 'loading', 'playing', 'error'].includes(String(message.state))) throw new Error('Invalid video helper status');
    for (const key of ['width', 'height', 'fps']) {
      if (message[key] !== undefined && (typeof message[key] !== 'number' || !Number.isFinite(message[key]) || Number(message[key]) < 0)) throw new Error('Invalid video helper format');
    }
    if (message.error !== undefined && typeof message.error !== 'string') throw new Error('Invalid video helper error');
    if (message.generation !== undefined && typeof message.generation !== 'string') throw new Error('Invalid video generation');
    this.callbacks.status(message as unknown as NativeVideoStatus);
  }
}
