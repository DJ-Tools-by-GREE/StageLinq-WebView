import type { Request, Response, RequestHandler } from 'express';
import type { WebSocket } from 'ws';
import { WS_MAX_BUFFERED_BYTES, WS_MAX_QUEUED_BYTES, WS_MAX_QUEUED_FRAMES, WS_SEND_TIMEOUT_MS } from './constants.js';

export function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => { void handler(req, res).catch(next); };
}

interface PendingFrame {
  frame: string;
  bytes: number;
  snapshot: boolean;
}

interface OutgoingState {
  pending: PendingFrame[];
  queuedBytes: number;
  sending: boolean;
  closed: boolean;
  timeout: NodeJS.Timeout | null;
}

const outgoing = new WeakMap<WebSocket, OutgoingState>();

function release(state: OutgoingState): void {
  state.closed = true;
  state.pending.length = 0;
  state.queuedBytes = 0;
  if (state.timeout) clearTimeout(state.timeout);
  state.timeout = null;
}

function disconnect(ws: WebSocket, state: OutgoingState): void {
  release(state);
  try { ws.terminate(); } catch {}
}

function drain(ws: WebSocket, state: OutgoingState): void {
  if (state.closed || state.sending || state.pending.length === 0) return;
  if (ws.readyState !== ws.OPEN) { release(state); return; }
  if (ws.bufferedAmount >= WS_MAX_BUFFERED_BYTES) { disconnect(ws, state); return; }
  const item = state.pending.shift()!;
  state.queuedBytes -= item.bytes;
  state.sending = true;
  state.timeout = setTimeout(() => disconnect(ws, state), WS_SEND_TIMEOUT_MS);
  state.timeout.unref();
  try {
    ws.send(item.frame, (error?: Error) => {
      if (state.closed) return;
      if (state.timeout) clearTimeout(state.timeout);
      state.timeout = null;
      state.sending = false;
      if (error) { disconnect(ws, state); return; }
      drain(ws, state);
    });
  } catch { disconnect(ws, state); }
}

export function sendWsFrame(ws: WebSocket, frame: string): void {
  if (ws.readyState !== ws.OPEN) return;
  let state = outgoing.get(ws);
  if (!state) {
    state = { pending: [], queuedBytes: 0, sending: false, closed: false, timeout: null };
    outgoing.set(ws, state);
    const current = state;
    ws.once('close', () => release(current));
    ws.once('error', () => release(current));
  }
  if (state.closed) return;
  const item = { frame, bytes: Buffer.byteLength(frame), snapshot: frame.startsWith('{"type":"snapshot",') };
  const existing = item.snapshot ? state.pending.findIndex(queued => queued.snapshot) : -1;
  if (existing >= 0) {
    state.queuedBytes -= state.pending[existing].bytes;
    state.pending[existing] = item;
  } else {
    state.pending.push(item);
  }
  state.queuedBytes += item.bytes;
  // A single media frame may exceed the backlog budget; it goes directly to an idle socket.
  const immediatelySendable = !state.sending && state.pending.length === 1;
  if (!immediatelySendable && (state.pending.length > WS_MAX_QUEUED_FRAMES || state.queuedBytes > WS_MAX_QUEUED_BYTES)) {
    disconnect(ws, state);
    return;
  }
  drain(ws, state);
}
