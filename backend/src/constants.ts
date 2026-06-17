// Watchdog and reconnect timing. Edit here to tune all related behaviour.

/** Seconds a playing deck can go without a beatMessage before it is marked stopped. */
export const BEAT_WATCHDOG_TIMEOUT_S = 5;

/** Seconds of beat silence before the status indicator turns red AND a reconnect is triggered. */
export const DISCONNECT_DETECT_TIMEOUT_S = 2;

/** Seconds to wait for the first beat after connect() before triggering reconnect (StateMap setup takes time). */
export const CONNECT_BEAT_GRACE_S = 20;

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
export const ELAPSED_THROTTLE_S = 0;

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

// Diagnostics

/** Interval at which the Art-Net worker reports rolling tick statistics. */
export const ARTNET_TICK_STATS_LOG_INTERVAL_MS = 2_000;

/** Main-thread event-loop lag (ms) above which a warning is logged (rate-limited to 1/s). */
export const MAIN_EVENT_LOOP_LAG_WARN_MS = 50;

/** Per-iteration WebSocket broadcast cost (ms) above which a warning is logged. */
export const WS_BROADCAST_WARN_MS = 5;

/**
 * If the worker self-correcting timer falls more than this many target intervals behind,
 * snap forward to "now + interval" and log a hard-stall warning instead of trying to catch up.
 */
export const ARTNET_HARD_STALL_INTERVALS = 3;
