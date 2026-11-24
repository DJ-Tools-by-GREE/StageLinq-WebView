import type { DeckNumber, DeckState, SourceTiming } from './types.js';
import type { TrackOffsetMap } from './artnetWorkerMessages.js';

type Decks = Record<DeckNumber, DeckState>;

export function makeArtNetSourceSync(options: {
  getDecks(): Decks;
  getDeckTimings(): Record<DeckNumber, SourceTiming>;
  getReplayOffsets(): TrackOffsetMap | null;
  getLiveOffsets(): TrackOffsetMap;
  setSource(decks: Decks, timings: Record<DeckNumber, SourceTiming>, offsets: TrackOffsetMap): void;
}) {
  let appliedOffsets: TrackOffsetMap | null | undefined;
  return (decks?: Decks, force = false): boolean => {
    const offsets = options.getReplayOffsets();
    if (!force && offsets === appliedOffsets) return false;
    const states = decks ?? options.getDecks();
    const nextOffsets = options.getReplayOffsets();
    options.setSource(states, options.getDeckTimings(), nextOffsets ?? options.getLiveOffsets());
    appliedOffsets = nextOffsets;
    return true;
  };
}
