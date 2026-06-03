import dgram from 'node:dgram';
import type { DeckState } from './types.js';
import { OSC_HEARTBEAT_INTERVAL_MS } from './constants.js';
import { logError, logLifecycle, logStatus, GRN, RST } from './logging.js';

export interface OscBpmOptions {
  enabled: boolean;
  targetIp: string;
  targetPort: number;
  speedMaster: number;
}

function pad4(buf: Buffer): Buffer {
  const pad = (4 - (buf.length % 4)) % 4;
  if (pad === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(pad)]);
}

function oscString(value: string): Buffer {
  return pad4(Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]));
}

function buildOscMessage(address: string, args: string[]): Buffer {
  const addressBuf = oscString(address);
  const typeTagBuf = oscString(`,${'s'.repeat(args.length)}`);
  const argBufs = args.map((a) => oscString(a));
  return Buffer.concat([addressBuf, typeTagBuf, ...argBufs]);
}

export class OscBpmSender {
  private socket = dgram.createSocket('udp4');
  private opts: OscBpmOptions;
  private lastCommand: string | null = null;
  private lastDeck: DeckState | undefined;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(opts: OscBpmOptions) {
    this.opts = opts;
    this.socket.on('error', (err) => {
      logError('[OSC] Socket error:', err.message);
    });
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), OSC_HEARTBEAT_INTERVAL_MS);
  }

  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try { this.socket.close(); } catch {}
    logLifecycle(`${GRN}[OSC] Sender stopped${RST}`);
  }

  sendDeckBpm(deck: DeckState | undefined) {
    if (!this.opts.enabled) return;
    if (!deck) return;

    this.lastDeck = deck;

    const bpm = Number(deck.currentBpm) > 0 ? Number(deck.currentBpm) : Number(deck.trackBpm);
    if (!Number.isFinite(bpm) || bpm <= 0) return;

    const roundedBpm = Math.round(bpm * 100) / 100;
    const command = `Master 3.${this.opts.speedMaster} At BPM ${roundedBpm}`;

    if (command === this.lastCommand) return;
    this.lastCommand = command;

    this.transmit(command);
  }

  private sendHeartbeat() {
    if (!this.opts.enabled || !this.lastDeck) return;
    const deck = this.lastDeck;
    const bpm = Number(deck.currentBpm) > 0 ? Number(deck.currentBpm) : Number(deck.trackBpm);
    if (!Number.isFinite(bpm) || bpm <= 0) return;

    const roundedBpm = Math.round(bpm * 100) / 100;
    const command = `Master 3.${this.opts.speedMaster} At BPM ${roundedBpm}`;
    this.lastCommand = null;
    this.transmit(command);
    this.lastCommand = command;
  }

  private transmit(command: string) {
    const packet = buildOscMessage('/cmd', [command]);
    logStatus('osc', `[OSC] /cmd -> ${command} (${this.opts.targetIp}:${this.opts.targetPort})`);
    this.socket.send(packet, 0, packet.length, this.opts.targetPort, this.opts.targetIp, (err) => {
      if (err) logError('[OSC] Send error:', err.message);
    });
  }
}
