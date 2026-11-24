import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { MEDIA_MAX_ARTWORK_BYTES, MEDIA_MAX_MANIFEST_BYTES, MEDIA_MAX_PEAKS, WAVEFORM_PEAKS_PER_SEC } from './constants.js';

export interface Artwork { data: Buffer; mime: string }
export interface CachedMedia { peaks?: number[]; artwork?: Artwork | null }

const imageMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const digest = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function validateArtwork(data: Buffer): Promise<Artwork> {
  if (data.length === 0 || data.length > MEDIA_MAX_ARTWORK_BYTES) throw new Error('artwork exceeds the supported size limit or is empty');
  const type = await fileTypeFromBuffer(data);
  if (!type || !imageMimes.has(type.mime)) throw new Error('unsupported or corrupt artwork image');
  return { data, mime: type.mime };
}

export class MediaDiskCache {
  readonly directory: string;
  constructor(cacheRoot: string, private readonly warn: (message: string) => void = () => {}) {
    this.directory = path.join(cacheRoot, 'media-cache-v1');
  }

  async init(): Promise<void> { await fs.mkdir(this.directory, { recursive: true }); }
  filePath(trackId: string): string { return path.join(this.directory, digest(trackId) + '.json'); }

  async read(trackId: string): Promise<CachedMedia> {
    try {
      const handle = await fs.open(this.filePath(trackId), 'r');
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > MEDIA_MAX_MANIFEST_BYTES) throw new Error('invalid manifest size');
        bytes = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset !== stat.size) throw new Error('manifest changed while reading');
        bytes = bytes.subarray(0, offset);
      } finally { await handle.close(); }
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!object(value) || value.version !== 1 || value.trackId !== trackId || value.peaksPerSec !== WAVEFORM_PEAKS_PER_SEC) {
        throw new Error('invalid manifest version, identity or sample density');
      }
      const result: CachedMedia = {};
      if (value.peaks !== undefined) {
        if (!Array.isArray(value.peaks) || value.peaks.length === 0 || value.peaks.length > MEDIA_MAX_PEAKS
          || !value.peaks.every((peak: unknown) => typeof peak === 'number' && Number.isFinite(peak) && peak >= 0 && peak <= 1)) {
          throw new Error('invalid waveform peaks');
        }
        result.peaks = value.peaks;
      }
      if (value.artwork !== undefined) {
        const art = value.artwork;
        if (!object(art)) throw new Error('invalid artwork record');
        if (art.status === 'absent') {
          result.artwork = null;
        } else if (art.status === 'present' && typeof art.base64 === 'string'
          && art.base64.length <= 4 * Math.ceil(MEDIA_MAX_ARTWORK_BYTES / 3)
          && typeof art.mime === 'string' && typeof art.sha256 === 'string') {
          const data = Buffer.from(art.base64, 'base64');
          if (data.toString('base64') !== art.base64 || digest(data) !== art.sha256) throw new Error('invalid artwork encoding or digest');
          result.artwork = await validateArtwork(data);
          if (result.artwork.mime !== art.mime) throw new Error('artwork MIME does not match image bytes');
        } else throw new Error('invalid artwork status');
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn(`[WAVEFORM] Ignoring invalid media cache: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  async write(trackId: string, media: CachedMedia, signal?: AbortSignal): Promise<void> {
    if (media.peaks === undefined && media.artwork === undefined) return;
    signal?.throwIfAborted();
    const artwork = media.artwork === undefined ? undefined : media.artwork === null
      ? { status: 'absent' }
      : { status: 'present', mime: media.artwork.mime, base64: media.artwork.data.toString('base64'), sha256: digest(media.artwork.data) };
    const serialized = JSON.stringify({ version: 1, trackId, peaksPerSec: WAVEFORM_PEAKS_PER_SEC, peaks: media.peaks, artwork });
    if (Buffer.byteLength(serialized) > MEDIA_MAX_MANIFEST_BYTES) throw new Error('media cache manifest exceeds size limit');
    const destination = this.filePath(trackId);
    const temporary = destination + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, serialized, { flag: 'wx', signal });
      signal?.throwIfAborted();
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}
