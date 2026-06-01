// Watchdog and reconnect timing. Edit here to tune all related behaviour.

/** Seconds a playing deck can go without a beatMessage before it is marked stopped. */
export const BEAT_WATCHDOG_TIMEOUT_S = 5;

/** Seconds of silence across ALL decks before a full StageLinq reconnect is triggered. */
export const DISCONNECT_DETECT_TIMEOUT_S = 10;

/** Milliseconds to wait between reconnect attempts. */
export const RECONNECT_DELAY_MS = 3000;

// UI / WebSocket

/** Snapshot broadcast rate to WebSocket clients (Hz). */
export const WS_FPS = 30;

// Art-Net timecode

/** Milliseconds to wait for the Art-Net UDP socket to bind before giving up. */
export const ARTNET_BIND_TIMEOUT_MS = 5000;

/** Milliseconds to wait before recreating the Art-Net socket after a fatal network error. */
export const ARTNET_SOCKET_RECOVERY_DELAY_MS = 5000;

/** Minimum milliseconds between socket recovery attempts. */
export const ARTNET_SOCKET_RECOVERY_COOLDOWN_MS = 12000;

/**
 * Fraction of one frame (at the configured FPS) that the internal timeline can drift from the
 * source position before it is snapped back. E.g. 0.15 = 1/7th of a frame at 30 fps (~5 ms).
 */
export const ARTNET_DRIFT_THRESHOLD_RATIO = 0.15;

// StageLinq bridge

/** Minimum elapsed-time change (seconds) before a BeatInfo update is written to deck state. */
export const ELAPSED_THROTTLE_S = 0.1;

// OSC

/** Milliseconds between periodic OSC BPM heartbeat sends (independent of on-change sends). */
export const OSC_HEARTBEAT_INTERVAL_MS = 1000;

// Waveform generation

/** Sample rate used when extracting raw PCM from audio files via ffmpeg. */
export const WAVEFORM_FFMPEG_SAMPLE_RATE = 8000;

/** Number of PCM samples per waveform peak (= WAVEFORM_FFMPEG_SAMPLE_RATE / WAVEFORM_PEAKS_PER_SEC). */
export const WAVEFORM_SAMPLES_PER_PEAK = 40;

/** Resulting waveform peaks per second (8000 / 40 = 200). */
export const WAVEFORM_PEAKS_PER_SEC = 200;
