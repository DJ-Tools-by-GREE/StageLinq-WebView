import path from 'node:path';
import type { DeckNumber, DeckState, SourceTiming } from './types.js';
import type { VideoConfig, VideoLibrary } from './videoTypes.js';
import type { VideoStatus, VideoDeckStatus } from './videoStatus.js';
import type { NativeVideoStatus, VideoDeckCommand } from './videoProtocol.js';
import { parseVideoConfig } from './videoConfig.js';
import { emptyVideoLibrary, findVideo, scanVideoLibrary } from './videoLibrary.js';
import { NativeVideoHelper, type VideoRenderer } from './videoHelper.js';
import { monotonicNowMs } from './timecodeTimeline.js';
import { FREEWHEEL_STALE_THRESHOLD_MS, VIDEO_HELPER_RESTART_DELAY_MS } from './constants.js';
import { logError, logLifecycle } from './logging.js';

const DECKS: DeckNumber[] = [1, 2, 3, 4];
type RendererFactory = (callbacks: { status: (status: NativeVideoStatus) => void; error: (message: string) => void }) => VideoRenderer;

export function videoDeckCommand(deck: DeckState, timing: SourceTiming, config: VideoConfig,
  library: VideoLibrary, sourceEpoch: string, nowMs: number): VideoDeckCommand {
  const match = deck.trackLoaded ? findVideo(library, deck.fileName) : { kind: 'missing' as const };
  const file = match.kind === 'matched' ? match.file : null;
  const rate = 1 + deck.speedState / 100;
  const validRate = Number.isFinite(rate) && rate > 0;
  const ageMs = timing.positionAtMs === null ? Infinity : nowMs - timing.positionAtMs;
  const positionTrackId = timing.trackId.replace(/^replay:\d+:[1-4]:/, '');
  const matchingIdentity = deck.mediaId ? positionTrackId === deck.mediaId :
    path.basename(positionTrackId) === path.basename(deck.fileName);
  // Legacy recordings can have inferred positions with no saved source identity.
  const inferredReplay = /^replay:\d+:[1-4]:$/.test(timing.trackId);
  const fresh = (matchingIdentity || inferredReplay) && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= FREEWHEEL_STALE_THRESHOLD_MS;
  const transportPlay = timing.transportPlay ?? deck.play;
  const elapsed = deck.elapsedSec + (transportPlay && fresh && validRate ? ageMs / 1000 * rate : 0);
  const offset = config.offsets_sec[path.basename(deck.fileName.trim())] ?? 0;
  const positionSec = elapsed + offset + (validRate ? config.latency_comp_ms / 1000 * rate : 0);
  return {
    deck: deck.deck,
    generation: JSON.stringify([sourceEpoch, timing.trackId, deck.mediaId, file?.path, file?.version]),
    path: file?.path ?? null,
    positionSec: Number.isFinite(positionSec) ? positionSec : 0,
    rate: validRate ? rate : 1,
    playing: !!file && fresh && transportPlay && validRate && Number.isFinite(positionSec) &&
      positionSec >= 0 && (deck.totalSec <= 0 || elapsed < deck.totalSec),
  };
}

export class VideoService {
  private config = parseVideoConfig(undefined);
  private library = emptyVideoLibrary();
  private baseDir = process.cwd();
  private renderer: VideoRenderer | null = null;
  private starting: VideoRenderer | null = null;
  private error: string | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private epoch = 0;
  private retries: Record<DeckNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  private retry: NodeJS.Timeout | null = null;
  private scanning: AbortController | null = null;
  private commands = new Map<DeckNumber, VideoDeckCommand>();
  private native = new Map<DeckNumber, NativeVideoStatus>();
  private timing = new Map<DeckNumber, { identity: string; revision: number; transport: number; play: boolean; waiting: number | null }>();
  private decks: Record<DeckNumber, VideoDeckStatus>;

  constructor(private factory: RendererFactory = callbacks => new NativeVideoHelper(callbacks)) {
    this.decks = Object.fromEntries(DECKS.map(deck => [deck, this.blankStatus(deck)])) as Record<DeckNumber, VideoDeckStatus>;
  }

  async initialize(raw: unknown, baseDir: string): Promise<void> {
    this.config = parseVideoConfig(raw);
    this.baseDir = baseDir;
    this.decks = Object.fromEntries(DECKS.map(deck => [deck, this.blankStatus(deck)])) as Record<DeckNumber, VideoDeckStatus>;
    try {
      this.library = await scanVideoLibrary(this.config, baseDir);
      if (this.config.enabled) this.renderer = await this.launch(this.config);
    }
    catch (error) { this.setError(error); }
  }

  configure(raw: unknown, baseDir: string): Promise<void> {
    return this.enqueue(() => this.applyConfiguration(raw, baseDir));
  }

  private async applyConfiguration(raw: unknown, baseDir: string, retryFailed = false): Promise<void> {
    if (this.closed) throw new Error('Video output is shutting down');
    const config = parseVideoConfig(raw);
    const scan = new AbortController();
    this.scanning = scan;
    let library: VideoLibrary;
    try { library = await scanVideoLibrary(config, baseDir, scan.signal); }
    finally { if (this.scanning === scan) this.scanning = null; }
    if (this.closed) throw new Error('Video output is shutting down');
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const previous = this.config;
    const previousRenderer = this.renderer;
    const replace = !config.enabled || !previousRenderer || config.ndi_name_prefix !== previous.ndi_name_prefix || config.output_format !== previous.output_format;
    if (replace) {
      this.renderer = null;
      await previousRenderer?.stop();
      try {
        if (config.enabled) this.renderer = await this.launch(config);
      } catch (error) {
        if (previousRenderer && !this.closed) {
          try { this.renderer = await this.launch(previous); }
          catch (restoreError) { this.setError(restoreError); this.scheduleRestart(); }
        }
        throw error;
      }
    }
    if (this.closed) { await this.renderer?.stop(); this.renderer = null; throw new Error('Video output is shutting down'); }
    this.config = config;
    this.library = library;
    this.baseDir = baseDir;
    this.error = null;
    if (replace) {
      this.epoch++;
      this.commands.clear();
      this.native.clear();
      this.timing.clear();
      this.decks = Object.fromEntries(DECKS.map(deck => [deck, this.blankStatus(deck)])) as Record<DeckNumber, VideoDeckStatus>;
    } else if (retryFailed) {
      for (const deck of DECKS) {
        if (this.native.get(deck)?.state !== 'error') continue;
        this.retries[deck]++;
        this.native.delete(deck);
        this.timing.delete(deck);
      }
    }
    logLifecycle('[VIDEO]', config.enabled ? 'Indexed ' + library.files.length + ' videos in ' + library.directory : 'Disabled');
    for (const issue of library.issues) logError('[VIDEO]', issue.message, issue.paths.join(', '));
  }

  rescan(): Promise<void> { return this.enqueue(() => this.applyConfiguration(this.config, this.baseDir, true)); }

  update(decks: Record<DeckNumber, DeckState>, timings: Record<DeckNumber, SourceTiming>, replay: boolean, nowMs = monotonicNowMs()): void {
    if (!this.config.enabled || this.closed) return;
    const commands: VideoDeckCommand[] = [];
    for (const deck of DECKS) {
      const state = decks[deck];
      const command = videoDeckCommand(state, timings[deck], this.config, this.library,
        this.epoch + ':' + this.retries[deck] + ':' + (replay ? 'replay' : 'live'), nowMs);
      const timing = timings[deck];
      const play = timing.transportPlay ?? state.play;
      const priorTiming = this.timing.get(deck);
      let waiting = priorTiming?.identity === command.generation ? priorTiming.waiting : null;
      if (priorTiming?.identity === command.generation && timing.transportRevision !== priorTiming.transport &&
        play && !priorTiming.play && timing.positionRevision === priorTiming.revision) waiting = timing.positionRevision;
      if (waiting !== null && waiting !== timing.positionRevision) waiting = null;
      if (waiting !== null) command.playing = false;
      this.timing.set(deck, { identity: command.generation, revision: timing.positionRevision,
        transport: timing.transportRevision, play, waiting });
      const previous = this.commands.get(deck);
      if (previous?.generation !== command.generation) this.native.delete(deck);
      this.commands.set(deck, command);
      commands.push(command);
      const match = state.trackLoaded ? findVideo(this.library, state.fileName) : { kind: 'missing' as const };
      const native = this.native.get(deck);
      let status: VideoDeckStatus['state'] = 'idle';
      let message: string | null = null;
      if (state.trackLoaded) {
        if (match.kind === 'ambiguous') { status = 'ambiguous'; message = 'Multiple videos match this track'; }
        else if (match.kind === 'missing') { status = 'unmatched'; message = 'No matching video'; }
        else if (this.error) { status = 'error'; message = this.error; }
        else if (native?.state === 'error') { status = 'error'; message = native.error ?? 'Video decoder failed'; }
        else if (!command.playing) status = 'black';
        else if (native?.state === 'playing') status = 'playing';
        else if (native?.state === 'idle') status = 'black';
        else status = 'loading';
      }
      this.decks[deck] = {
        deck, track: state.fileName, video: match.kind === 'matched' ? match.file.relativePath : null,
        sourceName: this.config.ndi_name_prefix + ' Deck ' + deck, state: status, message,
        positionSec: command.path ? command.positionSec : null,
        width: native?.width ?? null, height: native?.height ?? null, fps: native?.fps ?? null,
      };
    }
    this.renderer?.send(commands, nowMs);
  }

  getStatus(): VideoStatus {
    return { enabled: this.config.enabled, running: this.renderer !== null, directory: this.library.directory ?? this.config.directory,
      outputFormat: this.config.output_format, sourcePrefix: this.config.ndi_name_prefix,
      indexedVideos: this.library.files.length, ambiguousMatches: [...this.library.ambiguous.keys()],
      error: this.error, decks: structuredClone(this.decks) };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.scanning?.abort();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const stopping = this.renderer?.stop();
    const starting = this.starting?.stop();
    this.renderer = null;
    await Promise.allSettled([this.pending, stopping, starting]);
  }

  private async launch(config: VideoConfig): Promise<VideoRenderer> {
    const renderer = this.factory({
      status: status => {
        if (this.renderer !== renderer) return;
        const generation = this.commands.get(status.deck)?.generation;
        if (status.generation !== undefined && status.generation !== generation) return;
        this.native.set(status.deck, status);
      },
      error: message => {
        if (this.renderer !== renderer || this.closed) return;
        this.renderer = null;
        this.setError(new Error(message));
        void renderer.stop().catch(error => logError('[VIDEO] Stop failed:', error));
        this.scheduleRestart();
      },
    });
    this.starting = renderer;
    try { await renderer.start(config); }
    catch (error) { await renderer.stop(); throw error; }
    finally { if (this.starting === renderer) this.starting = null; }
    return renderer;
  }

  private scheduleRestart(): void {
    if (this.closed || !this.config.enabled || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.rescan().catch(error => { this.setError(error); this.scheduleRestart(); });
    }, VIDEO_HELPER_RESTART_DELAY_MS);
    this.retry.unref();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => undefined).then(operation);
    this.pending = next;
    return next;
  }

  private setError(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    logError('[VIDEO]', this.error);
  }

  private blankStatus(deck: DeckNumber): VideoDeckStatus {
    return { deck, track: '', video: null, sourceName: this.config.ndi_name_prefix + ' Deck ' + deck,
      state: 'idle', message: null, positionSec: null, width: null, height: null, fps: null };
  }
}
