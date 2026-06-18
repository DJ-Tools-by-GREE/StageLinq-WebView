# StageLinq WebView

Real-time DJ deck visualizer for Denon Prime 4+ (Engine DJ / StageLinq). Displays all 4 decks in a browser, broadcasts Art-Net SMPTE timecode, and accepts DMX/sACN control input — all from a single Node.js server.

## Features

**Web UI**
- 4-quadrant dark-theme layout, one deck per quadrant
- Per deck: title, artist, album artwork, elapsed/total/remaining time, key (Camelot notation), current BPM, derived track BPM, relative pitch %, channel fader, scrollable waveform with playhead
- Header bar showing selected deck, live BPM, and next-track name
- Live connection status badge (LIVE / OFFLINE)
- Overlay button to toggle timecode transmission while playback is stopped
- **User switcher** (header dropdown) — `Default User`, `Jan`, `Dennis`. Each user has their own UI settings, stored server-side in `users.json` and applied on the fly when switched. The active-user pick is per-browser (`localStorage`).
- Settings popup (gear icon in the header) — adjusts the visible time-window of the detail waveform (4–30 s, default 10 s) for the active user; persisted to the server via `PUT /api/users/:name/settings`.
- WebSocket stream at 30 Hz

**Art-Net timecode output** (optional)
- Broadcasts the active deck's playhead as SMPTE timecode over UDP Art-Net
- Configurable FPS, target IP/port, deck selection, and latency compensation
- Drift detection and re-sync; suppresses frames before 00:00:00:00 and after track end
- Per-track offset mapping via `config.json` for alignment with external systems
- **Runs in a dedicated Node worker thread** with its own dgram socket and a self-correcting deadline timer, so the timecode cadence is unaffected by waveform extraction, WebSocket broadcasts, or any other main-thread work

**sACN / DMX control input** (optional)
- Receives a single DMX channel over sACN to select which deck's timecode is broadcast
- DMX thresholds: 0–49 → off, 50–100 → deck 1, 101–151 → deck 2, 152–202 → deck 3, 203–255 → deck 4

**OSC BPM output** (optional)
- Sends BPM to an OSC-compatible device when a deck is active via sACN
- Format: `/cmd "Master 3.<channel> At BPM <bpm>"`

## Prerequisites

- Node.js 22+
- Denon Prime 4+ (or compatible Engine DJ device) on the same LAN as this server

## Install

```bash
npm install
```

## Development

Start the backend (serves the UI on port 8090, connects to StageLinq, streams WebSocket):

```bash
npm run -w backend dev
```

Open `http://<this-pc-ip>:8090/`

Optionally run the frontend dev server with Vite HMR in a second terminal (proxies `/ws` and `/api` to the backend):

```bash
npm run -w frontend dev
```

## Production

```bash
npm run build   # builds frontend then backend
npm start       # runs built backend, which also serves the frontend
```

## Live show (macOS)

For a live show, use `npm run show`. It requires [tmux](https://formulae.brew.sh/formula/tmux) — install once via Homebrew:

```bash
brew install tmux
```

Then:

```bash
npm run build
npm run show
```

This starts a persistent tmux session named `stagelinq` with:
- **Interactive terminal** — live status display works as designed
- **Auto-restart** — the process restarts automatically after any crash (2 s delay)
- **caffeinate** — prevents display sleep, idle sleep, and screen lock
- **Detachable** — closing the terminal window does not kill the process

**Session commands:**

```bash
tmux attach -t stagelinq          # reattach to the live interactive display
tmux kill-session -t stagelinq    # stop everything completely
```

Inside the session:
- `Ctrl+B` then `D` — detach (app keeps running in background)
- `Ctrl+C` — restart the app (loop relaunches after 2 s)
- `Ctrl+C` then `exit` within 2 s — stop the app and close the session

**First run on a new machine** (or after pulling code changes):

```bash
npm run fresh   # npm install + full rebuild + show
```

## Configuration

Settings can be provided as **environment variables** or in an optional **`config.json`** file at the repo root (or in `backend/`). Environment variables take precedence.

Hot-reload: press **Ctrl+R** in the terminal running the backend to reload `config.json` without restarting.

### General

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8090` | HTTP and WebSocket port |

### Art-Net timecode

| Variable | Default | Description |
|---|---|---|
| `ARTNET_ENABLED` | `true` | Enable Art-Net timecode output |
| `ARTNET_TARGET_IP` | `255.255.255.255` | Destination IP(s) — single IP or comma-separated list (e.g. `192.168.1.10,192.168.1.11`) for multi-host fan-out |
| `ARTNET_PORT` | `6454` | Destination UDP port |
| `ARTNET_DECK` | `1` | Deck to broadcast (overridden by sACN input) |
| `ARTNET_FPS` | `30` | Timecode frame rate — valid values: `24`, `25`, `29.97`, `30` |
| `ARTNET_SEND_HZ` | *(same as `ARTNET_FPS`)* | UDP send rate in Hz (override to send faster than FPS tick rate) |
| `ARTNET_LATENCY_COMP_MS` | `80` | Latency compensation in milliseconds |

### sACN control input

| Variable | Default | Description |
|---|---|---|
| `CONTROL_INPUT_MODE` | `sacn` | Set to `none` to disable |
| `SACN_UNIVERSE` | `20` | sACN universe to listen on |
| `SACN_ADDRESS` | `1` | DMX channel (1-indexed) |

### OSC BPM output

| Variable | Default | Description |
|---|---|---|
| `OSC_ENABLED` | `false` | Enable OSC BPM sender |
| `OSC_TARGET_IP` | `127.0.0.1` | OSC target IP(s) — single IP or comma-separated list for multi-host fan-out |
| `OSC_TARGET_PORT` | `8000` | OSC target UDP port |
| `OSC_SPEEDMASTER` | `15` | SpeedMaster channel number in the OSC command |

### Camelot key mapping

StageLinq exposes `CurrentKeyIndex` as a number 0–23. The default mapping is `1A, 1B, 2A, 2B, … 12A, 12B`. If your device firmware uses a different order, override it:

```bash
KEY_MAP="1A,1B,2A,2B,3A,3B,4A,4B,5A,5B,6A,6B,7A,7B,8A,8B,9A,9B,10A,10B,11A,11B,12A,12B"
```

### config.json

All settings can also be placed in `config.json` at the repo root (or in `backend/`). Environment variables take precedence over file values. The file is fully optional — any omitted section falls back to env vars or defaults.

```json
{
  "current_playlist": 0,
  "timecode": {
    "fps": 30,
    "target_ips": ["192.168.1.100", "192.168.1.101"],
    "target_port": 6454
  },
  "control_input": {
    "mode": "sacn",
    "universe": 20,
    "address": 1
  },
  "osc": {
    "enabled": true,
    "target_ips": ["192.168.1.100"],
    "target_port": 8000,
    "speedmaster": 15
  },
  "playlists": [
    {
      "name": "Show A",
      "content": [
        { "song_index": "track-filename.mp3", "offset_sec": 2, "offset_frame": 5 },
        { "song_index": "vocal-overlay.mp3", "offset_sec": 0, "offset_frame": 0, "mashup_only": true },
        {
          "song_index": "transition-cue.mp3",
          "offset_sec": 0,
          "offset_frame": 0,
          "note": {
            "description": "Drop the laser cue at the first build, then hand off to deck 2.",
            "show_secs_after_load": 5
          }
        },
        { "song_index": "outro.mp3", "offset_sec": 0, "offset_frame": 0 }
      ]
    }
  ]
}
```

Tracks are matched by normalized filename (basename only, case-insensitive). `current_playlist` selects which playlist entry from the array is active (0-indexed).

Set `mashup_only: true` on a track to mark it as an overlay (vocal stem, mashup top-line, etc.) that is only ever played on top of another track. The backend treats such entries as if they were *not* in the playlist: their `offset_sec`/`offset_frame` are ignored (no Art-Net timecode adjustment), they are skipped when computing the *next track* shown in the header, and waveform extraction follows the same rules as a track outside the playlist (only happens when `waveform.all_tracks` is `true`). The flag defaults to `false`/absent. Selecting a deck that holds a `mashup_only` track via sACN is treated as operator error — no fallback logic.

The optional `note` block on a track shows an in-UI popup once that track loads on any deck. `description` is the body text — leaving it empty (or omitting `note` entirely) suppresses the popup. `show_secs_after_load` is the delay in seconds before the popup appears after the track loads (default `0` = immediate). The popup is keyed per `(deck, fileName)`: it fires once per load, is dismissed by clicking the backdrop or the close button, and is auto-cancelled if the track is unloaded or replaced before the delay elapses.

Both `timecode` and `osc` accept either a single `target_ip` (string) or a `target_ips` array — when both are present, `target_ips` wins. The same packets are fanned out to every listed host. The env vars `ARTNET_TARGET_IP` / `OSC_TARGET_IP` accept a comma-separated list for the same purpose and override the config file.

### Waveform and artwork cache

Waveforms and artwork are extracted automatically when a track loads and cached to disk under `~/.cache/stagelinq-webview/` (or `WAVEFORM_CACHE_DIR` env var). By default all tracks are processed. To restrict processing to tracks in the active playlist only, set `waveform.all_tracks` to `false` in `config.json`:

```json
{
  "waveform": {
    "all_tracks": false
  }
}
```

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/timecode/send-when-stopped` | Query current "send when stopped" state |
| `POST` | `/api/timecode/send-when-stopped` | Set state; body: `{ "enabled": true \| false }` |
| `GET` | `/api/artwork/:deck` | Serve cached album artwork for deck 1–4 |
| `GET` | `/api/users` | List all users and their UI-settings blobs (`{ users: [{ name, settings }] }`) |
| `GET` | `/api/users/:name/settings` | Get one user's settings blob |
| `PUT` | `/api/users/:name/settings` | Replace one user's settings blob; body is the JSON object to store. Stored to `users.json` at the repo root. |
| `GET` | `/api/global-settings` | Read backend-owned settings (currently `{ freewheel: { enable_freewheeling, max_duration_sec }, meta }`). |
| `PUT` | `/api/global-settings/freewheel` | Patch the freewheel section; body `{ enable_freewheeling?: boolean, max_duration_sec?: number }`. Persisted to `config.json` and pushed live into the Art-Net worker. |

## Deck color accents

| Deck | Color |
|---|---|
| 1 | Purple / Magenta |
| 2 | Blue |
| 3 | Green |
| 4 | Red |

## Project structure

```
StageLinq-WebView/
├── backend/src/
│   ├── index.ts            # Express server, WebSocket, snapshot loop
│   ├── stagelinqBridge.ts  # StageLinq protocol handler
│   ├── artnetTimecode.ts   # Art-Net broadcaster (main-thread harness around the worker)
│   ├── artnetWorker.ts     # Art-Net SMPTE worker (owns dgram socket + self-correcting tick)
│   ├── artnetWorkerMessages.ts # typed message contract between main thread and worker
│   ├── oscBpm.ts           # OSC BPM sender
│   ├── waveformService.ts  # Waveform peak extraction and artwork cache
│   ├── camelot.ts          # Key index → Camelot string
│   ├── constants.ts        # Tunable timing and threshold constants
│   ├── logging.ts          # Configurable debug logging
│   └── types.ts            # DeckState, WsPayload
└── frontend/src/
    ├── App.tsx             # WebSocket client, 4-quadrant layout
    ├── DeckCard.tsx        # Per-deck display component
    ├── HeaderBar.tsx       # Top bar: selected deck, BPM, next track
    ├── WaveformDisplay.tsx # Waveform peak renderer
    ├── appTypes.ts         # Frontend-only types (WaveformState)
    └── types.ts            # Shared types (mirrors backend)
```

## WebSocket protocol

On connect the server sends a hello frame, then snapshot frames at 30 Hz. Additional one-shot frames are sent when waveform analysis or artwork extraction completes:

```jsonc
// hello
{ "type": "hello", "ts": 1234567890, "version": "1.0.0", "fps": 30 }

// snapshot (30 Hz)
{ "type": "snapshot", "seq": 42, "ts": 1234567890, "selectedDeck": 1, "nextTrack": "song.mp3", "decks": { "1": DeckState, ... } }

// waveform_status — progress during peak analysis
{ "type": "waveform_status", "deck": 1, "stage": "downloading|analyzing|done|error", "progress": 0.0, "fileName": "..." }

// waveform_data — peak array when analysis is complete
{ "type": "waveform_data", "deck": 1, "fileName": "...", "peaks": [...], "peaksPerSec": 10 }

// artwork_data — album art (base64) or null if unavailable
{ "type": "artwork_data", "deck": 1, "fileName": "...", "data": "<base64>" | null }
```

## Notes

- **Track BPM** is derived from `CurrentBPM / Speed`.
- **Relative pitch %** is `(Speed − 1) × 100`.
- Track length reads from `/Engine/DeckX/TrackLength`; elapsed from BeatInfo `timeline`.
- StageLinq discovery and event parsing are handled by the `@gree44/stagelinq` library.

## Resilience and auto-reconnect

The backend has a built-in watchdog that monitors the StageLinq connection and automatically recovers from hardware disconnects.

**Per-deck watchdog:** if a deck is playing but no `beatMessage` has arrived for `BEAT_WATCHDOG_TIMEOUT_S` (default 5 s), the deck is marked stopped so stale timecode is not sent.

**Global disconnect detection:** if no `beatMessage` arrives from *any* deck for `DISCONNECT_DETECT_TIMEOUT_S` (default 10 s), the bridge disconnects and retries with `RECONNECT_DELAY_MS` (default 3 s) between attempts. This handles cable pulls, power-cycles, and device sleep without requiring a process restart.

**Art-Net freewheel during a stall:** while StageLinq is unreachable (`reconnecting`, or no fresh beats within `DISCONNECT_DETECT_TIMEOUT_S`), the Art-Net worker holds the last-good `DeckState` and keeps advancing its internal timeline at the last-known speed instead of freezing the timecode at the last source frame. The lighting console keeps seeing a smoothly advancing TC across the gap; the drift snap is skipped while stale and re-engages as soon as beats resume. The web UI surfaces this with a big red `STAGELINQ DISCONNECTED` / `STAGELINQ RECONNECTING` / `WS DISCONNECTED` badge in the centre of the header bar — the small left-side status dot keeps its existing semantics and renders alongside.

The freewheel has two operator knobs, persisted in `config.json` under `freewheel` and editable live in the in-app **Settings → Global Settings / Controls** sections (no restart needed):

| Field | Default | Effect |
|---|---|---|
| `freewheel.enable_freewheeling` | `true` | When `false`, the worker stops sending TC the moment StageLinq goes stale — no freewheel at all. Toggle in **Settings → Controls**. |
| `freewheel.max_duration_sec` | `30` | Ceiling (seconds) on how long the worker keeps freewheeling after the source went stale. Past this it goes silent until beats resume. Slider in **Settings → Global Settings**. |

REST: `GET /api/global-settings` (returns `{ freewheel, meta }`) / `PUT /api/global-settings/freewheel` (`{ enable_freewheeling?, max_duration_sec? }`). Updates are persisted to `config.json` and live-pushed into the Art-Net worker.

All three values — plus `WS_FPS`, `ARTNET_BIND_TIMEOUT_MS`, `ARTNET_DRIFT_THRESHOLD_RATIO`, and `ELAPSED_THROTTLE_S` — are collected in [`backend/src/constants.ts`](backend/src/constants.ts) so they can be adjusted in one place.

## Diagnostics

To make timecode-cadence problems observable, the backend logs:

- **`[ArtNet/wk] tick stats`** — emitted every 10 s by the Art-Net worker. Shows tick count, average interval, p50, p95, max interval, max "behind" (how late the worker self-corrected from), and any hard stalls. A healthy line at 30 fps reads roughly `avg=33.33ms (30.00fps) p95<35 max<40 maxBehind<5 hardStalls=0`.
- **`[ArtNet/wk] Late tick`** — single late tick warning, rate-limited to 1/s.
- **`[main] event-loop lag Xms`** — main-thread event-loop lag warning. The Art-Net worker is unaffected by main-thread stalls; this log just tells you where to look when the WS UI feels sluggish (typical cause: ffmpeg-done callback or a large JSON serialization).
- **`[WAVEFORM] track-change deck=N download=Xms ffmpeg=Yms total=Zms`** — per-track-change timing breakdown. Useful to see whether download or PCM extraction is the bottleneck.
- **`[main] WS broadcast slow`** — WebSocket broadcast warning if a single snapshot send takes longer than `WS_BROADCAST_WARN_MS` (default 5 ms).

Tunable thresholds for the diagnostics live alongside the existing tunables in [`backend/src/constants.ts`](backend/src/constants.ts): `ARTNET_TICK_STATS_LOG_INTERVAL_MS`, `MAIN_EVENT_LOOP_LAG_WARN_MS`, `WS_BROADCAST_WARN_MS`, `ARTNET_HARD_STALL_INTERVALS`.

## License

MIT — Jan Müller (2026)
