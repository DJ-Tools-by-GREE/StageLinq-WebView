import type { DeckNumber, DeckState, StageLinqStatus } from './types.js';
import type { StageLinqBridge } from './stagelinqBridge.js';
import type { Replay } from './replay.js';

/**
 * Indirection between the StageLinq bridge and the output paths (Art-Net, OSC, WS snapshot).
 * When replay is overriding outputs, all four decks come from the replay engine and the
 * status presents as 'connected' so the Art-Net worker doesn't freewheel and the UI shows green.
 *
 * Selected deck stays under live sACN control regardless — handled in index.ts, not here.
 */
export interface StateProvider {
  getDecks(): Record<DeckNumber, DeckState>;
  getDeck(deck: DeckNumber): DeckState;
  getLastBeatAgeMs(): number;
  getStatus(reconnecting: boolean): StageLinqStatus;
  isReplayOverriding(): boolean;
}

export interface StateProviderDeps {
  bridge: StageLinqBridge;
  replay: Replay;
  // 'connected' | 'no-device' threshold (seconds). Mirrors DISCONNECT_DETECT_TIMEOUT_S.
  disconnectTimeoutSec: number;
}

export function makeStateProvider(deps: StateProviderDeps): StateProvider {
  const { bridge, replay, disconnectTimeoutSec } = deps;

  function override(): null | Record<DeckNumber, DeckState> {
    if (!replay.isOverridingOutputs()) return null;
    // We need the audio deck's real elapsedSec from the bridge to drive the replay clock.
    const status = replay.getStatus();
    if (!status.audioDeck) return null;
    const audio = bridge.getDeck(status.audioDeck);
    const tickResult = replay.tick(audio.play, audio.elapsedSec);
    return tickResult ? tickResult.decks : null;
  }

  return {
    getDecks() {
      const replayed = override();
      return replayed ?? bridge.getDecks();
    },
    getDeck(deck) {
      const replayed = override();
      return replayed ? replayed[deck] : bridge.getDeck(deck);
    },
    getLastBeatAgeMs() {
      return replay.isOverridingOutputs() ? 0 : bridge.getLastBeatAgeMs();
    },
    getStatus(reconnecting) {
      if (replay.isOverridingOutputs()) return 'connected';
      if (reconnecting) return 'reconnecting';
      return bridge.getLastBeatAgeMs() <= disconnectTimeoutSec * 1000 ? 'connected' : 'no-device';
    },
    isReplayOverriding() { return replay.isOverridingOutputs(); },
  };
}
