import type { CachedWaveformEntry, MediaFrames } from './waveformWorkerMessages.js';

export class MediaMemoryCache {
  readonly peaksFrames = new Map<string, string>();
  readonly artworkFrames = new Map<string, string>();
  readonly artwork = new Map<string, { data: Buffer; mime: string } | null>();
  private readonly sizes = new Map<string, number>();
  private active = new Set<string>();
  private bytes = 0;

  constructor(private readonly maxBytes: number, private readonly maxEntries: number) {}

  get sizeBytes(): number { return this.bytes; }

  get(trackId: string): MediaFrames | undefined {
    const size = this.sizes.get(trackId);
    if (size === undefined) return undefined;
    this.sizes.delete(trackId);
    this.sizes.set(trackId, size);
    return {
      peaksFrame: this.peaksFrames.get(trackId) ?? null,
      artworkFrame: this.artworkFrames.get(trackId) ?? null,
    };
  }

  setActive(ids: Iterable<string>): void {
    this.active = new Set(Array.from(ids).filter(Boolean));
    this.trim();
  }

  put(entry: CachedWaveformEntry): void {
    const { trackId } = entry;
    if (entry.peaksFrame !== null) this.peaksFrames.set(trackId, entry.peaksFrame);
    if (entry.artworkFrame !== null) {
      this.artworkFrames.set(trackId, entry.artworkFrame);
      this.artwork.set(trackId, entry.artworkBytes && entry.artworkMime
        ? { data: Buffer.from(entry.artworkBytes), mime: entry.artworkMime } : null);
    }
    const size = 2 * ((this.peaksFrames.get(trackId)?.length ?? 0)
      + (this.artworkFrames.get(trackId)?.length ?? 0) + trackId.length)
      + (this.artwork.get(trackId)?.data.byteLength ?? 0);
    this.bytes -= this.sizes.get(trackId) ?? 0;
    this.sizes.delete(trackId);
    if (!this.peaksFrames.has(trackId) && !this.artworkFrames.has(trackId)) return;
    this.sizes.set(trackId, size);
    this.bytes += size;
    this.trim();
  }

  clear(): void {
    this.peaksFrames.clear();
    this.artworkFrames.clear();
    this.artwork.clear();
    this.sizes.clear();
    this.bytes = 0;
  }

  private trim(): void {
    while (this.bytes > this.maxBytes || this.sizes.size > this.maxEntries) {
      const oldest = this.sizes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const id = Array.from(this.sizes.keys()).find(key => !this.active.has(key)) ?? oldest;
      this.bytes -= this.sizes.get(id)!;
      this.sizes.delete(id);
      this.peaksFrames.delete(id);
      this.artworkFrames.delete(id);
      this.artwork.delete(id);
    }
  }
}
