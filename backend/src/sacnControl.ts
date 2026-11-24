import type { Packet } from 'sacn';
import type { DeckNumber } from './types.js';

export const DECK_DMX: Record<DeckNumber, number> = { 1: 76, 2: 127, 3: 178, 4: 230 };

export function mapDmxToDeck(value: number): DeckNumber | null {
  if (!Number.isFinite(value) || value <= 50) return null;
  if (value <= 101) return 1;
  if (value <= 152) return 2;
  if (value <= 203) return 3;
  return 4;
}

export function readDmxChannel(packet: Pick<Packet, 'payloadAsBuffer'>, address: number): number | null {
  const payload = packet.payloadAsBuffer;
  if (!payload || !Number.isInteger(address) || address < 1 || address > payload.length) return null;
  return payload[address - 1];
}
