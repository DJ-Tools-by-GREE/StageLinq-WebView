import dgram from 'node:dgram';
import type { DeckState } from './types.js';

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

  constructor(opts: OscBpmOptions) {
    this.opts = opts;
    this.socket.on('error', (err) => {
      console.error('[OSC] Socket error:', err.message);
    });
  }

  stop() {
    try { this.socket.close(); } catch {}
    console.log('[OSC] Sender stopped');
  }

  sendDeckBpm(deck: DeckState | undefined) {
    if (!this.opts.enabled) {
      return;
    }
    if (!deck) {
      return;
    }

    const bpm = Number(deck.currentBpm) > 0 ? Number(deck.currentBpm) : Number(deck.trackBpm);
    if (!Number.isFinite(bpm) || bpm <= 0) return;

    const roundedBpm = Math.round(bpm * 100) / 100;
    const command = `Master 3.${this.opts.speedMaster} At BPM ${roundedBpm}`;

    if (command === this.lastCommand) return;
    this.lastCommand = command;

    const packet = buildOscMessage('/cmd', [command]);
    console.log(`[OSC] /cmd -> ${command} (${this.opts.targetIp}:${this.opts.targetPort})`);
    this.socket.send(packet, 0, packet.length, this.opts.targetPort, this.opts.targetIp, (err) => {
      if (err) console.error('[OSC] Send error:', err.message);
    });
  }
}
