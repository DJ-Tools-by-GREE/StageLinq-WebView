import type { VideoStatus } from './videoTypes.js';

async function responseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : `HTTP ${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  return body;
}

function parseStatus(body: unknown): VideoStatus {
  if (!body || typeof body !== 'object' || !('decks' in body) || !body.decks ||
      typeof body.decks !== 'object' || !('enabled' in body) || typeof body.enabled !== 'boolean') {
    throw new Error('Invalid video status response');
  }
  for (const deck of ['1', '2', '3', '4']) {
    if (!(deck in body.decks)) throw new Error('Incomplete video status response');
  }
  return body as VideoStatus;
}

export async function fetchVideoStatus(signal?: AbortSignal): Promise<VideoStatus> {
  return parseStatus(await responseBody(await fetch('/api/video/status', { signal })));
}

export async function rescanVideos(signal?: AbortSignal): Promise<VideoStatus> {
  const body = await responseBody(await fetch('/api/video/rescan', { method: 'POST', signal }));
  if (!body || typeof body !== 'object' || !('status' in body)) throw new Error('Invalid video rescan response');
  return parseStatus(body.status);
}
