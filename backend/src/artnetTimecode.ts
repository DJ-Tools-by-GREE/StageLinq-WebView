import dgram from 'node:dgram';
import type { DeckState } from './types.js';
import {
  ARTNET_BIND_TIMEOUT_MS,
  ARTNET_DRIFT_THRESHOLD_RATIO,
  ARTNET_SOCKET_RECOVERY_COOLDOWN_MS,
  ARTNET_SOCKET_RECOVERY_DELAY_MS,
} from './constants.js';

export interface ArtNetOptions {
  enabled: boolean;
  targetIp: string;
  port: number;
  fps: number;
  sendHz?: number;
  fpsType: number; // 0x00=24,0x01=25,0x02=29.97,0x03=30
  deck: 1 | 2 | 3 | 4;
  latencyCompMs?: number;
  sendWhenStopped?: boolean;
}

function buildArtNetTimecode(hours: number, minutes: number, seconds: number, frames: number, fpsType: number): Buffer {
  const buffer = Buffer.alloc(19);
  buffer.write('Art-Net\0', 0, 8, 'ascii');
  buffer.writeUInt16LE(0x9700, 8);
  buffer.writeUInt16BE(14, 10);
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

export class ArtNetTimecodeBroadcaster {
  private socket = dgram.createSocket('udp4');
  private opts: ArtNetOptions;
  private loop: NodeJS.Timeout | null = null;
  private timelineFrames: number | null = null;
  private lastTickMs: number | null = null;
  private sendWhenStopped: boolean;
  private expectedIntervalMs = 0;
  private fpsWindowStartMs: number | null = null;
  private sentInWindow = 0;
  private lastCadenceWarnMs = 0;
  private lastSendAtMs: number | null = null;
  private socketFaulted = false;
  private lastSocketRecoveryMs = 0;
  private lastSentStoppedFrames: number | null = null;

  constructor(opts: ArtNetOptions) {
    this.opts = opts;
    this.sendWhenStopped = opts.sendWhenStopped === true;
  }

  setSendWhenStopped(enabled: boolean) {
    this.sendWhenStopped = enabled;
  }

  async start(getDeckState: () => DeckState | undefined) {
    if (!this.opts.enabled) return;
    this.socket.on('error', (err) => {
      console.error('[ArtNet] Socket error:', err.message);
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('[ArtNet] socket.bind() timed out after 5s')),
        ARTNET_BIND_TIMEOUT_MS,
      );
      this.socket.bind(() => {
        clearTimeout(timeout);
        try { this.socket.setBroadcast(true); } catch {}
        resolve();
      });
    });

    const sendHz = Math.max(1, Number(this.opts.sendHz ?? this.opts.fps));
    const intervalMs = Math.max(1, Math.round(1000 / sendHz));
    this.expectedIntervalMs = intervalMs;
    this.loop = setInterval(() => {
      const deckState = getDeckState();
      if (!deckState) return;
      this.tick(deckState);
    }, intervalMs);

    console.log(`Art-Net TC enabled: ${this.opts.targetIp}:${this.opts.port} @ ${this.opts.fps}fps, send=${sendHz}Hz (deck ${this.opts.deck})`);
  }

  stop() {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    this.socketFaulted = false;
    try { this.socket.close(); } catch {}
  }

  private async recoverSocket() {
    console.warn('[ArtNet] Network error — recreating socket in 5s');
    try { this.socket.close(); } catch {}
    await new Promise<void>(r => setTimeout(r, ARTNET_SOCKET_RECOVERY_DELAY_MS));
    if (!this.loop) return;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => {
      console.error('[ArtNet] Socket error:', err.message);
    });
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.error('[ArtNet] Socket rebind timed out');
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
    console.log('[ArtNet] Socket recreated');
  }

  tick(deckState: DeckState) {
    if (!this.opts.enabled) return;

    const nowMs = Date.now();
    const sourceSec = Number(deckState.elapsedSec) || 0;
    const sourceFrames = Math.max(0, sourceSec * this.opts.fps);

    if (!this.sendWhenStopped && deckState.play !== true) {
      const wasPlaying = this.lastTickMs !== null;
      this.timelineFrames = sourceFrames;
      this.lastTickMs = null;
      this.fpsWindowStartMs = null;
      this.sentInWindow = 0;
      this.lastSendAtMs = null;

      let stoppedFrame = Math.floor(sourceFrames);
      const totalSec = Number(deckState.totalSec) || 0;
      if (totalSec > 0) {
        stoppedFrame = Math.min(stoppedFrame, Math.max(0, Math.floor(totalSec * this.opts.fps) - 1));
      }

      if (wasPlaying) {
        // Just stopped — record position without sending.
        this.lastSentStoppedFrames = stoppedFrame;
      } else if (this.lastSentStoppedFrames !== stoppedFrame) {
        this.lastSentStoppedFrames = stoppedFrame;
        if (stoppedFrame > 0 && !this.socketFaulted) {
          const tc = framesToHMSF(stoppedFrame, this.opts.fps);
          const pkt = buildArtNetTimecode(tc.hours, tc.minutes, tc.seconds, tc.frames, this.opts.fpsType);
          this.socket.send(pkt, 0, pkt.length, this.opts.port, this.opts.targetIp, (err) => {
            if (err) {
              console.error('[ArtNet] Send error:', err.message);
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
      return;
    }

    if (this.timelineFrames == null) {
      this.timelineFrames = sourceFrames;
    }

    // Warm-up tick: avoid emitting a single packet right when sender starts/resumes.
    if (this.lastTickMs == null) {
      this.lastTickMs = nowMs;
      this.timelineFrames = sourceFrames;
      return;
    }

    const dtSec = Math.max(0, (nowMs - this.lastTickMs) / 1000);
    this.timelineFrames += dtSec * this.opts.fps;

    // Re-sync on seeks/jumps to keep sender aligned with deck timeline.
    const drift = Math.abs(sourceFrames - this.timelineFrames);
    if (drift > this.opts.fps * ARTNET_DRIFT_THRESHOLD_RATIO) {
      this.timelineFrames = sourceFrames;
    }

    // Never trail behind the source while playing.
    if (this.timelineFrames < sourceFrames) {
      this.timelineFrames = sourceFrames;
    }

    // Do not emit before song position 00:00 (raw, pre-offset/pre-latency domain).
    if (this.timelineFrames <= 0) {
      return;
    }

    this.lastTickMs = nowMs;

    const latencyCompFrames = (this.opts.fps * (this.opts.latencyCompMs ?? 80)) / 1000;
    const rawFramePos = this.timelineFrames + latencyCompFrames;
    if (rawFramePos < 0) {
      // Do not emit timecode before 00:00:00:00.
      return;
    }

    let totalFrames = Math.floor(rawFramePos);

    // Prevent running past track end (can trigger after-roll warnings on some desks).
    const totalSec = Number(deckState.totalSec) || 0;
    if (totalSec > 0) {
      const maxFrame = Math.max(0, Math.floor(totalSec * this.opts.fps) - 1);
      totalFrames = Math.min(totalFrames, maxFrame);
    }

    // Send every loop tick (no frame-skipping), so receivers get continuous TC updates.

    const tc = framesToHMSF(totalFrames, this.opts.fps);
    console.log(
      `[ArtNet OUT] ${String(tc.hours).padStart(2, '0')}:${String(tc.minutes).padStart(2, '0')}:${String(tc.seconds).padStart(2, '0')}:${String(tc.frames).padStart(2, '0')} ` +
      `(totalFrames=${totalFrames})`
    );
    if (this.socketFaulted) return;
    const pkt = buildArtNetTimecode(tc.hours, tc.minutes, tc.seconds, tc.frames, this.opts.fpsType);
    this.socket.send(pkt, 0, pkt.length, this.opts.port, this.opts.targetIp, (err) => {
      if (err) {
        console.error('[ArtNet] Send error:', err.message);
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

    const sendNow = Date.now();
    if (this.lastSendAtMs != null) {
      const dtMs = sendNow - this.lastSendAtMs;
      if (dtMs > this.expectedIntervalMs * 1.6 && (sendNow - this.lastCadenceWarnMs) > 1000) {
        this.lastCadenceWarnMs = sendNow;
        const instFps = 1000 / dtMs;
        console.warn(
          `[ArtNet] Cadence drop detected: ${instFps.toFixed(2)}fps (target ${this.opts.fps}fps, interval ${dtMs.toFixed(1)}ms)`
        );
      }
    }
    this.lastSendAtMs = sendNow;

    if (this.fpsWindowStartMs == null) {
      this.fpsWindowStartMs = sendNow;
      this.sentInWindow = 0;
    }
    this.sentInWindow += 1;

    const windowMs = sendNow - this.fpsWindowStartMs;
    if (windowMs >= 1000) {
      const avgFps = (this.sentInWindow * 1000) / windowMs;
      if (avgFps < (this.opts.fps - 0.5)) {
        console.warn(
          `[ArtNet] Average output below target: ${avgFps.toFixed(2)}fps (target ${this.opts.fps}fps, samples ${this.sentInWindow}/${windowMs.toFixed(0)}ms)`
        );
      }
      this.fpsWindowStartMs = sendNow;
      this.sentInWindow = 0;
    }
  }
}
