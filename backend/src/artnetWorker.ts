import { parentPort } from 'node:worker_threads';
import dgram from 'node:dgram';
import type { DeckState } from './types.js';
import {
  ARTNET_BIND_TIMEOUT_MS,
  ARTNET_DRIFT_THRESHOLD_RATIO,
  ARTNET_SOCKET_RECOVERY_COOLDOWN_MS,
  ARTNET_SOCKET_RECOVERY_DELAY_MS,
  ARTNET_TICK_STATS_LOG_INTERVAL_MS,
  ARTNET_HARD_STALL_INTERVALS,
} from './constants.js';
import type {
  ArtNetWorkerInitOptions,
  MainToWorker,
  WorkerToMain,
} from './artnetWorkerMessages.js';

if (!parentPort) {
  throw new Error('artnetWorker must be spawned as a worker_thread');
}

const port = parentPort;

function send(msg: WorkerToMain) {
  port.postMessage(msg);
}

function logInfo(msg: string) { send({ type: 'log', level: 'info', msg }); }
function logWarn(msg: string) { send({ type: 'log', level: 'warn', msg }); }
function logError(msg: string) { send({ type: 'log', level: 'error', msg }); }

function buildArtNetTimecode(hours: number, minutes: number, seconds: number, frames: number, fpsType: number, streamId: number): Buffer {
  const buffer = Buffer.alloc(19);
  buffer.write('Art-Net\0', 0, 8, 'ascii');
  buffer.writeUInt16LE(0x9700, 8);
  buffer.writeUInt16BE(14, 10);
  buffer[12] = 0x00;
  buffer[13] = streamId & 0xff;
  buffer[14] = frames & 0xff;
  buffer[15] = seconds & 0xff;
  buffer[16] = minutes & 0xff;
  buffer[17] = hours & 0xff;
  buffer[18] = fpsType & 0xff;
  return buffer;
}

function framesToHMSF(totalFrames: number, fps: number) {
  const frames = ((totalFrames % fps) + fps) % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = ((totalSeconds % 60) + 60) % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = ((totalMinutes % 60) + 60) % 60;
  const hours = ((Math.floor(totalMinutes / 60) % 24) + 24) % 24;
  return { hours, minutes, seconds, frames };
}

class ArtNetWorker {
  private socket: dgram.Socket = dgram.createSocket('udp4');
  private opts!: ArtNetWorkerInitOptions;
  private targetIntervalMs = 0;
  private nextDeadlineMs = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  private currentDeck: DeckState | null = null;
  private sendWhenStopped = false;

  private timelineFrames: number | null = null;
  private lastTickMs: number | null = null;
  private lastSentStoppedFrames: number | null = null;

  private socketFaulted = false;
  private lastSocketRecoveryMs = 0;
  private socketRecoveryCount = 0;
  private lastTcDisplayMs = 0;

  // Cadence stats over a rolling window.
  private intervals: number[] = [];
  private behinds: number[] = [];
  private hardStallsInWindow = 0;
  private windowStartMs = 0;
  private lastSendAtMs: number | null = null;
  private lastLateWarnMs = 0;
  private statsTimer: NodeJS.Timeout | null = null;

  async start(opts: ArtNetWorkerInitOptions) {
    this.opts = opts;
    this.sendWhenStopped = opts.sendWhenStopped;

    this.socket.on('error', (err) => {
      logError(`[ArtNet/wk] Socket error: ${err.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('[ArtNet/wk] socket.bind() timed out')),
        ARTNET_BIND_TIMEOUT_MS,
      );
      this.socket.bind(() => {
        clearTimeout(timeout);
        try { this.socket.setBroadcast(true); } catch {}
        resolve();
      });
    });

    const sendHz = Math.max(1, opts.sendHz);
    this.targetIntervalMs = 1000 / sendHz;

    const now = Date.now();
    this.nextDeadlineMs = now + this.targetIntervalMs;
    this.windowStartMs = now;

    this.scheduleNext();

    this.statsTimer = setInterval(() => this.flushStats(), ARTNET_TICK_STATS_LOG_INTERVAL_MS);

    logInfo(
      `[ArtNet/wk] ready: ${opts.targetIps.join(', ')}:${opts.port} @ ${opts.fps}fps, send=${sendHz}Hz (target interval ${this.targetIntervalMs.toFixed(3)}ms)`
    );
    send({ type: 'ready' });
  }

  setSendWhenStopped(enabled: boolean) {
    this.sendWhenStopped = enabled;
  }

  updateDeck(deck: DeckState | null) {
    this.currentDeck = deck;
  }

  private scheduleNext() {
    if (this.shuttingDown) return;
    const delay = Math.max(0, this.nextDeadlineMs - Date.now());
    this.tickTimer = setTimeout(() => this.tick(), delay);
  }

  private tick() {
    if (this.shuttingDown) return;

    const now = Date.now();
    const behind = now - this.nextDeadlineMs;

    // If we've fallen pathologically behind, snap forward and warn.
    if (behind > this.targetIntervalMs * ARTNET_HARD_STALL_INTERVALS) {
      logWarn(`[ArtNet/wk] Hard stall: behind by ${behind.toFixed(1)}ms (>${ARTNET_HARD_STALL_INTERVALS} intervals); resyncing deadline.`);
      this.nextDeadlineMs = now + this.targetIntervalMs;
      this.hardStallsInWindow++;
    } else {
      this.nextDeadlineMs += this.targetIntervalMs;
    }

    try {
      this.doSend(now);
    } catch (e: any) {
      logError(`[ArtNet/wk] tick error: ${e?.message || e}`);
    }

    // Per-interval cadence tracking.
    if (this.lastSendAtMs != null) {
      const dt = now - this.lastSendAtMs;
      this.intervals.push(dt);
      this.behinds.push(behind);
      if (dt > this.targetIntervalMs * 1.6 && (now - this.lastLateWarnMs) > 1000) {
        this.lastLateWarnMs = now;
        logWarn(
          `[ArtNet/wk] Late tick: ${dt.toFixed(1)}ms (target ${this.targetIntervalMs.toFixed(1)}ms, behind ${behind.toFixed(1)}ms)`
        );
      }
    }
    this.lastSendAtMs = now;

    this.scheduleNext();
  }

  private doSend(nowMs: number) {
    if (!this.opts.enabled) return;
    const deckState = this.currentDeck;
    if (!deckState) return;

    const sourceSec = Number(deckState.elapsedSec) || 0;
    const sourceFrames = Math.max(0, sourceSec * this.opts.fps);

    if (!this.sendWhenStopped && deckState.play !== true) {
      const wasPlaying = this.lastTickMs !== null;
      this.timelineFrames = sourceFrames;
      this.lastTickMs = null;

      let stoppedFrame = Math.floor(sourceFrames);
      const totalSec = Number(deckState.totalSec) || 0;
      if (totalSec > 0) {
        stoppedFrame = Math.min(stoppedFrame, Math.max(0, Math.floor(totalSec * this.opts.fps) - 1));
      }

      if (wasPlaying) {
        this.lastSentStoppedFrames = stoppedFrame;
      } else if (this.lastSentStoppedFrames !== stoppedFrame) {
        this.lastSentStoppedFrames = stoppedFrame;
        if (stoppedFrame > 0 && !this.socketFaulted) {
          const tc = framesToHMSF(stoppedFrame, this.opts.fps);
          const pkt = buildArtNetTimecode(tc.hours, tc.minutes, tc.seconds, tc.frames, this.opts.fpsType, this.opts.streamId);
          this.sendPacket(pkt);
        }
      }
      return;
    }

    if (this.timelineFrames == null) {
      this.timelineFrames = sourceFrames;
    }

    if (this.lastTickMs == null) {
      this.lastTickMs = nowMs;
      this.timelineFrames = sourceFrames;
      return;
    }

    const dtSec = Math.max(0, (nowMs - this.lastTickMs) / 1000);
    const playRate = 1 + (deckState.speedState ?? 0) / 100;
    this.timelineFrames += dtSec * this.opts.fps * playRate;

    const drift = Math.abs(sourceFrames - this.timelineFrames);
    if (drift > this.opts.fps * ARTNET_DRIFT_THRESHOLD_RATIO) {
      this.timelineFrames = sourceFrames;
    }

    if (this.timelineFrames < sourceFrames) {
      this.timelineFrames = sourceFrames;
    }

    if (this.timelineFrames <= 0) return;

    this.lastTickMs = nowMs;

    const latencyCompFrames = (this.opts.fps * this.opts.latencyCompMs) / 1000;
    const rawFramePos = this.timelineFrames + latencyCompFrames;
    if (rawFramePos < 0) return;

    let totalFrames = Math.floor(rawFramePos);
    const totalSec = Number(deckState.totalSec) || 0;
    if (totalSec > 0) {
      const maxFrame = Math.max(0, Math.floor(totalSec * this.opts.fps) - 1);
      totalFrames = Math.min(totalFrames, maxFrame);
    }

    if (this.socketFaulted) return;
    const tc = framesToHMSF(totalFrames, this.opts.fps);
    const pkt = buildArtNetTimecode(tc.hours, tc.minutes, tc.seconds, tc.frames, this.opts.fpsType, this.opts.streamId);
    this.sendPacket(pkt);

    // Throttled TC display update (10 Hz) so the main-thread dashboard can show the running TC
    // without paying for it 30 times per second.
    if (nowMs - this.lastTcDisplayMs >= 100) {
      this.lastTcDisplayMs = nowMs;
      const hh = String(tc.hours).padStart(2, '0');
      const mm = String(tc.minutes).padStart(2, '0');
      const ss = String(tc.seconds).padStart(2, '0');
      const ff = String(tc.frames).padStart(2, '0');
      send({
        type: 'tcDisplay',
        text: `[ArtNet TC] ${hh}:${mm}:${ss}:${ff}`,
        hms: `${hh}:${mm}:${ss}`,
      });
    }
  }

  private sendPacket(pkt: Buffer) {
    for (const ip of this.opts.targetIps) {
      this.socket.send(pkt, 0, pkt.length, this.opts.port, ip, (err) => {
        if (err) {
          logError(`[ArtNet/wk] Send error to ${ip}: ${err.message}`);
          const code = (err as NodeJS.ErrnoException).code;
          if ((code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL') && !this.socketFaulted) {
            const now = Date.now();
            if (now - this.lastSocketRecoveryMs > ARTNET_SOCKET_RECOVERY_COOLDOWN_MS) {
              this.socketFaulted = true;
              void this.recoverSocket();
            }
          }
        }
      });
    }
  }

  private async recoverSocket() {
    logError('[ArtNet/wk] Network error — recreating socket in 5s');
    try { this.socket.close(); } catch {}
    await new Promise<void>(r => setTimeout(r, ARTNET_SOCKET_RECOVERY_DELAY_MS));
    if (this.shuttingDown) return;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => {
      logError(`[ArtNet/wk] Socket error: ${err.message}`);
    });
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        logError('[ArtNet/wk] Socket rebind timed out');
        resolve();
      }, ARTNET_BIND_TIMEOUT_MS);
      this.socket.bind(() => {
        clearTimeout(timeout);
        try { this.socket.setBroadcast(true); } catch {}
        resolve();
      });
    });
    this.lastSocketRecoveryMs = Date.now();
    this.socketFaulted = false;
    this.socketRecoveryCount++;
    logInfo('[ArtNet/wk] Socket recreated');
  }

  private flushStats() {
    const now = Date.now();
    const windowMs = now - this.windowStartMs;
    const count = this.intervals.length;
    if (count === 0) {
      this.windowStartMs = now;
      return;
    }
    const sorted = this.intervals.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / count;
    const p50 = sorted[Math.floor(count * 0.5)];
    const p95 = sorted[Math.min(count - 1, Math.floor(count * 0.95))];
    const maxMs = sorted[count - 1];
    const maxBehind = this.behinds.length > 0
      ? this.behinds.reduce((a, b) => Math.max(a, b), -Infinity)
      : 0;

    const avgFps = count > 0 && windowMs > 0 ? (count * 1000) / windowMs : 0;
    const targetFps = 1000 / this.targetIntervalMs;
    const isUnder = avgFps < targetFps - 0.5;

    const line =
      `[ArtNet/wk] tick stats: ${count} ticks/${windowMs}ms ` +
      `avg=${avg.toFixed(2)}ms (${avgFps.toFixed(2)}fps) ` +
      `p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} max=${maxMs.toFixed(1)} ` +
      `maxBehind=${maxBehind.toFixed(1)}ms hardStalls=${this.hardStallsInWindow} ` +
      `target=${this.targetIntervalMs.toFixed(2)}ms`;
    if (isUnder || this.hardStallsInWindow > 0 || maxBehind > this.targetIntervalMs) {
      logWarn(line);
    } else {
      logInfo(line);
    }

    send({
      type: 'stats',
      stats: {
        windowMs,
        count,
        avgIntervalMs: avg,
        p50,
        p95,
        maxMs,
        maxBehindMs: maxBehind,
        targetMs: this.targetIntervalMs,
        hardStalls: this.hardStallsInWindow,
        socketRecoveries: this.socketRecoveryCount,
      },
    });

    this.intervals.length = 0;
    this.behinds.length = 0;
    this.hardStallsInWindow = 0;
    this.windowStartMs = now;
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.tickTimer) { clearTimeout(this.tickTimer); this.tickTimer = null; }
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    try { this.socket.close(); } catch {}
  }
}

const worker = new ArtNetWorker();

port.on('message', (raw: MainToWorker) => {
  switch (raw.type) {
    case 'init':
      worker.start(raw.opts).catch((e) => {
        logError(`[ArtNet/wk] init failed: ${e?.message || e}`);
      });
      break;
    case 'updateDeck':
      worker.updateDeck(raw.deck);
      break;
    case 'setSendWhenStopped':
      worker.setSendWhenStopped(raw.enabled);
      break;
    case 'shutdown':
      worker.shutdown();
      // Allow the close callback to fire before exiting.
      setTimeout(() => process.exit(0), 50);
      break;
  }
});
