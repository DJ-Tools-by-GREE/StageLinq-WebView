import type { DeckNumber, DeckState, WaveformStage } from './types.js';
import { MEDIA_PIPELINE_CONCURRENCY } from './constants.js';
import { loadCachedMedia, requestExtraction, setActiveMediaTracks } from './waveformService.js';
import { logError } from './logging.js';

interface Options {
  download: (trackId: string, progress: (percent: number) => void, signal: AbortSignal) => Promise<Uint8Array>;
  eligible: (fileName: string) => boolean;
  status: (deck: DeckNumber, trackId: string, fileName: string, stage: WaveformStage, progress: number) => void;
  frame: (frame: string) => void;
}

export class MediaCoordinator {
  private desired = new Map<string, DeckState[]>();
  private attempted = new Set<string>();
  private downloadable = new Set<string>();
  private running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private stopped = false;
  constructor(private options: Options, private service = { loadCachedMedia, requestExtraction, setActiveMediaTracks }) {}

  update(decks: Record<DeckNumber, DeckState>, outputDecks?: Record<DeckNumber, DeckState>): void {
    if (this.stopped) return;
    const desired = new Map<string, DeckState[]>();
    const pins = new Set<string>();
    const downloadable = new Set<string>();
    for (const deck of Object.values(decks)) {
      if (!deck.trackLoaded || !deck.mediaId) continue;
      pins.add(deck.mediaId);
      if (!this.options.eligible(deck.fileName)) continue;
      downloadable.add(deck.mediaId);
      const list = desired.get(deck.mediaId) ?? [];
      list.push(deck);
      desired.set(deck.mediaId, list);
    }
    for (const deck of Object.values(outputDecks ?? {})) {
      if (!deck.trackLoaded || !deck.mediaId) continue;
      pins.add(deck.mediaId);
      if (!desired.has(deck.mediaId) && this.options.eligible(deck.fileName)) desired.set(deck.mediaId, [deck]);
    }
    for (const id of downloadable) if (!this.downloadable.has(id)) this.attempted.delete(id);
    this.downloadable = downloadable;
    this.desired = desired;
    this.service.setActiveMediaTracks(pins);
    for (const id of this.attempted) if (!desired.has(id)) this.attempted.delete(id);
    for (const [id, job] of this.running) if (!desired.has(id)) job.controller.abort();
    this.pump();
  }

  private pump(): void {
    if (this.stopped) return;
    for (const [id, decks] of this.desired) {
      if (this.running.size >= MEDIA_PIPELINE_CONCURRENCY) break;
      if (this.attempted.has(id) || this.running.has(id)) continue;
      const controller = new AbortController();
      this.attempted.add(id);
      const promise = this.run(id, decks[0], controller.signal).finally(() => {
        this.running.delete(id);
        if (controller.signal.aborted) this.attempted.delete(id);
        this.pump();
      });
      this.running.set(id, { controller, promise });
    }
  }

  private async run(id: string, deck: DeckState, signal: AbortSignal): Promise<void> {
    const progress = (stage: WaveformStage, percent: number) => {
      if (signal.aborted) return;
      for (const consumer of this.desired.get(id) ?? []) {
        this.options.status(consumer.deck, id, deck.fileName, stage, percent);
      }
    };
    try {
      const cached = await this.service.loadCachedMedia(id, deck.fileName, signal);
      signal.throwIfAborted();
      if (cached.peaksFrame) this.options.frame(cached.peaksFrame);
      if (cached.artworkFrame) this.options.frame(cached.artworkFrame);
      if (cached.peaksFrame && cached.artworkFrame) return;
      if (!this.downloadable.has(id)) return;
      progress('downloading', 0);
      const bytes = await this.options.download(id, p => progress('downloading', p), signal);
      signal.throwIfAborted();
      progress('generating', 0);
      const current = this.desired.get(id)?.[0] ?? deck;
      const result = await this.service.requestExtraction(id, deck.fileName, current.totalSec, bytes,
        !!cached.peaksFrame, (stage, p) => progress(stage, p), signal);
      signal.throwIfAborted();
      if (result.peaksFrame) this.options.frame(result.peaksFrame);
      if (result.artworkFrame) this.options.frame(result.artworkFrame);
      progress('ready', 100);
    } catch (error) {
      if (signal.aborted) return;
      logError('[WAVEFORM] ' + deck.fileName + ' failed:', error);
      progress('error', 0);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.desired.clear();
    for (const job of this.running.values()) job.controller.abort();
    await Promise.allSettled([...this.running.values()].map(job => job.promise));
    this.service.setActiveMediaTracks([]);
  }
}
