export const BROWSER_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
export const BROWSER_MEDIA_MAX_ENTRIES = 24;
export const BROWSER_MEDIA_PENDING_MS = 3000;

interface Entry {
  peaks?: number[];
  peaksPerSec?: number;
  artworkUrl?: string;
  artworkBytes: number;
  receivedAt: number;
}

export class MediaCache {
  private entries = new Map<string, Entry>();
  private active = new Set<string>();
  constructor(private maxBytes = BROWSER_MEDIA_MAX_BYTES, private maxEntries = BROWSER_MEDIA_MAX_ENTRIES) {}

  get(id: string): Entry | undefined {
    const entry = this.entries.get(id);
    if (entry) { this.entries.delete(id); this.entries.set(id, entry); }
    return entry;
  }

  setActive(ids: Iterable<string>): void {
    this.active = new Set(ids);
    this.trim();
  }

  setPeaks(id: string, peaks: number[], peaksPerSec: number): void {
    if (!id || !Number.isFinite(peaksPerSec) || peaksPerSec <= 0 ||
        peaks.length * 8 > this.maxBytes || peaks.some(p => !Number.isFinite(p) || p < 0 || p > 1)) return;
    const entry = this.get(id) ?? { artworkBytes: 0, receivedAt: Date.now() };
    entry.peaks = peaks;
    entry.peaksPerSec = peaksPerSec;
    entry.receivedAt = Date.now();
    this.entries.set(id, entry);
    this.trim();
  }

  setArtwork(id: string, blob: Blob | null): void {
    if (!id || (blob && blob.size > this.maxBytes)) return;
    const entry = this.get(id) ?? { artworkBytes: 0, receivedAt: Date.now() };
    if (entry.artworkUrl) URL.revokeObjectURL(entry.artworkUrl);
    entry.artworkUrl = blob ? URL.createObjectURL(blob) : undefined;
    entry.artworkBytes = blob?.size ?? 0;
    entry.receivedAt = Date.now();
    this.entries.set(id, entry);
    this.trim();
  }

  artworkUrls(): Record<string, string> {
    return Object.fromEntries([...this.entries].filter(([, e]) => e.artworkUrl).map(([id, e]) => [id, e.artworkUrl!]));
  }

  get byteLength(): number {
    let bytes = 0;
    for (const [id, e] of this.entries) bytes += id.length * 2 + (e.peaks?.length ?? 0) * 8 + e.artworkBytes;
    return bytes;
  }

  get size(): number { return this.entries.size; }

  private trim(): void {
    let bytes = this.byteLength;
    while (this.entries.size > this.maxEntries || bytes > this.maxBytes) {
      const id = [...this.entries.keys()].find(key => !this.active.has(key) && Date.now() - this.entries.get(key)!.receivedAt > BROWSER_MEDIA_PENDING_MS) ?? [...this.entries.keys()].find(key => !this.active.has(key)) ?? this.entries.keys().next().value;
      if (id === undefined) break;
      const entry = this.entries.get(id)!;
      bytes -= id.length * 2 + (entry.peaks?.length ?? 0) * 8 + entry.artworkBytes;
      if (entry.artworkUrl) URL.revokeObjectURL(entry.artworkUrl);
      this.entries.delete(id);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) if (entry.artworkUrl) URL.revokeObjectURL(entry.artworkUrl);
    this.entries.clear();
  }
}
