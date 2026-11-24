# StageLinq WebView

Real-time DJ deck visualizer for Denon Prime 4+ (Engine DJ / StageLinq). Displays all 4 decks in a browser, broadcasts Art-Net SMPTE timecode, accepts DMX/sACN control input, and optionally sends synchronized music videos over four NDI outputs on macOS.

Detailed audit, implemented fixes, remaining recommendations and validation: [2026-11-24 review](docs/review-2026-11-24/README.md).

## Features

**Web UI**
- 4-quadrant dark-theme layout, one deck per quadrant
- Per deck: title, artist, album artwork, elapsed/total/remaining time, key (Camelot notation), current BPM, derived track BPM, relative pitch %, channel fader, scrollable waveform with playhead
- Header bar showing selected deck, live BPM, and the next-track name from the active playlist
- Live connection status badge (LIVE / OFFLINE)
- Freewheel controls for temporary source-data dropouts; explicit playback pauses stop timecode output
- **User switcher** (header dropdown) — `Default User`, `Jan`, `Dennis`. Each user has their own UI settings (waveform zoom, role, track-note popups, deck layout, …), stored server-side in `users.json` and applied on the fly when switched. The active-user pick is per-browser (`localStorage`). Each user carries a fixed-vocabulary `role` (`Viewer` / `DJ` / `Lighting & Tech`); the role can be picked from the Settings modal but new roles require a code change. Users with role `DJ` get track-note popups on by default; everyone else gets them off — an explicit toggle in Settings always overrides the role-derived default.
- Settings popup (gear icon in the header) — adjusts the visible time-window of the detail waveform (4–30 s, default 10 s), toggles the **deck layout** between the full 4-deck 2×2 grid (default) and a 2-deck side-by-side view (D1 & D2 only), and other per-user preferences for the active user; persisted to the server via `PUT /api/users/:name/settings`. Also hosts an **Open config editor…** button that launches a full-screen overlay for editing the on-disk `config.json` (playlists, timecode targets, OSC, sACN, logging, freewheel, …). The editor saves over `PUT /api/config`; saves are **write-only** — press `Ctrl+R` in the backend terminal, click **Settings → Controls → Reload config**, or `POST /api/config/reload` to apply.
- **Live terminal panel** (chevron-prompt icon in the header) — unfolds an overlay below the header that mirrors the backend's per-event log lines as they're printed. Subscribed only while the panel is open: backend pushes nothing over the wire when no client is watching, and the static dashboard rows are excluded by design (only newly printed lines stream). Seeded on open with the recent ring buffer (~500 lines).
- WebSocket stream at 30 Hz

**Art-Net timecode output** (optional)
- Broadcasts the active deck's playhead as SMPTE timecode over UDP Art-Net
- Configurable FPS, target IP/port, deck selection, and latency compensation
- Drift detection and re-sync; suppresses frames before 00:00:00:00 and after track end
- Per-track offset mapping via `config.json` for alignment with external systems
- **Runs in a dedicated Node worker thread** that owns the entire timecode pipeline — the dgram socket, the 30 Hz self-correcting tick, the per-deck state cache, the selected-deck pointer, the per-track offsets, and the freewheel-stale derivation. The main thread only **pushes** state changes (bridge mutations, sACN deck flips, config reloads). During main-thread stalls, the worker can continue from the selected deck’s last reliable sample within the configured freewheel limit. Position timestamps are captured from BeatInfo; metadata and other decks cannot refresh that clock. OS scheduling and hardware still affect actual packet delivery.

**sACN / DMX control input** (optional)
- Receives a single DMX channel over sACN to select which deck's timecode is broadcast
- DMX thresholds: 0–50 → off, 51–101 → deck 1, 102–152 → deck 2, 153–203 → deck 3, 204–255 → deck 4

**OSC BPM output** (optional)
- Sends BPM to an OSC-compatible device when a deck is active via sACN
- Format: `/cmd "Master 3.<channel> At BPM <bpm>"`

## Video / NDI output (macOS, optional)

Play matching music videos in sync with each deck and send four independent,
video-only NDI sources to another computer over Ethernet. A native macOS helper
owns decoding and NDI encoding; Node exchanges timing and status with it. Video
does not depend on sACN deck selection or channel faders. During Record & Replay,
it follows the four reconstructed tracks through the same state provider as the
other outputs, using the current video configuration.

### Setup

1. Obtain the **NDI SDK for Apple** from [NDI](https://ndi.video/for-developers/ndi-sdk/download/).
   Build with Apple's Command Line Tools installed. If the SDK is not in its
   standard location, set **NDI_SDK_DIR** to the directory containing its include folder:

   ~~~bash
   NDI_SDK_DIR="/Library/NDI SDK for Apple" npm run build
   ~~~

2. The helper loads the SDK's runtime dynamically. If necessary, set
   **NDI_RUNTIME_LIBRARY** to the absolute path of the official libndi.dylib
   when starting WebView. **VIDEO_HELPER_PATH** can override the native executable.
   Rebuild just the helper with **npm run build:video**.
   The SDK headers are needed to build; running the compiled helper requires
   the NDI runtime library, not the development headers.
3. Set the video folder and enable output in Config Editor → Video / NDI,
   then Save and Reload config. Settings → Video / NDI shows active output
   status and provides **Rescan videos** after files are added or replaced.
4. In TouchDesigner, create four [NDI In TOPs](https://docs.derivative.ca/NDI_In_TOP)
   and select **StageLinq Deck 1** through **StageLinq Deck 4** under this Mac's
   hostname. Source names remain available and send black while idle.

Without the SDK, the macOS build creates an explicitly limited decoder/test
helper; enabling network output reports a setup error. Other platforms skip the
native build. The rest of WebView remains usable with video disabled. SDK
headers and runtime binaries are not included in this repository.

### Configuration and matching

The checked-in configuration has video disabled with an empty folder. All
video fields are optional; this is an enabled example:

~~~json
"video": {
  "enabled": true,
  "directory": "/Volumes/Show/Videos",
  "ndi_name_prefix": "StageLinq",
  "output_format": "source",
  "latency_comp_ms": 0,
  "offsets_sec": {
    "Artist - Song.mp3": 2.0
  }
}
~~~

- **directory:** root folder plus every subfolder. Relative paths resolve
  against the configuration file's directory. Nested symbolic links are skipped
  to avoid cycles and unintended traversal.
- **Matching:** Artist - Song.mp3 matches Artist - Song (Music Video).mp4.
  Audio extensions are removed; video stems and the suffix are case-sensitive.
  MP4, M4V and MOV extensions are accepted case-insensitively; codecs must be
  supported by macOS AVFoundation. Multiple matches remain black and are
  reported for resolution, rather than selecting an arbitrary file.
- **output_format:** source preserves dimensions and sends at nominal source
  FPS multiplied by deck speed. 1080p30 letterboxes to 1920 × 1080 at a fixed
  30 fps while content still follows pitch. Source-mode rates above the
  configured ceiling use 1080p30. Input/output resource limits live in
  backend/src/constants.ts; the default frame-size limit is 3840 × 2160 pixels
  and the output-rate ceiling is 120 fps.
- **offsets_sec:** keys are exact audio basenames **including extension**.
  Video position = deck position + offset. +2 skips a two-second video intro;
  −2 starts the video two seconds into the audio track. Positions outside the
  video's duration are black. These offsets are independent of lighting
  playlist offsets.
- **latency_comp_ms:** positive values advance the video to compensate for
  NDI receiver, rendering and display delay. Calibrate against the final
  display; this is separate from the content alignment offset.

The helper follows play/pause, normal pitch changes, cue jumps and loops.
Scratching and reverse are not supported. Pause, missing/ambiguous files,
decoder failure and video end produce black. Missing fresh deck positions
produce black after the source freshness threshold (250 ms by default);
repeated snapshots do not refresh it. A separate 500 ms native command timeout
also blacks out a stalled control connection. This video behavior does not
change Art-Net's freewheel settings. Audio is never sent.

The backend supervises the helper, restarts it after a runtime failure, bounds
IPC queues and joins shutdown. Rescan/config reload prepares a complete catalog
before replacing the active configuration; failures are returned to the caller.
Folder scanning is bounded and does not load entire video files into Node.

TouchDesigner's project/display frame rate is independent of the source's
pitch-adjusted delivery rate. Validate source-mode cadence, latency and four
simultaneous streams on the actual Mac, Ethernet link and receiver; 1080p30
provides a fixed-format alternative. The existing unpitched-backup guidance
for Record & Replay still applies.

**REST:** GET /api/video/status returns runtime/library and per-deck status.
POST /api/video/rescan rescans the active folder and returns
{ ok: true, status: VideoStatus }; errors preserve the previous active catalog.

**Validation:** run npm test for backend/frontend regressions. On macOS, run
npm run build:video followed by npm run test:video for real decoding, format,
transport and four-deck tests. These native tests use synthetic clips and an
in-process sink; they never initialize NDI or announce network sources.
Testing actual NDI transmission and TouchDesigner display sync is a separate
deployment check with the SDK/runtime installed.

The SDK 6.4.0.2 build was also verified with four real local NDI receivers in
both source and 1080p30 modes: pitch-adjusted cadence, independent seek/pause,
blackouts, no audio and orderly shutdown passed. This loopback check does not
replace Ethernet and final-display latency calibration.

[NDI®](https://ndi.video/) is a registered trademark of Vizrt NDI AB.

## Record & Replay (backup show)

Record bridge state during a live show, then replay it against a prerecorded audio file played on a deck. Replay uses the timecode offsets saved in the recording, including changes applied during the show, even if today's playlist differs. Live sACN still selects the output deck. Output fidelity depends on the recording, audio alignment and available telemetry; legacy logs lack raw heartbeat/transport provenance.

### Recording

1. Start the backend, connect a Prime 4+ / SC6000.
2. In the header, click **REC** (or `POST /api/record/start`). The button pulses red while active and shows the elapsed duration.
3. Mix the show as usual.
4. Click **REC** again to stop. The recorder writes `recordings/<iso>.jsonl` plus a `<iso>.meta.json` sidecar.

The recorder refuses to start if StageLinq is not connected, if a recording is already running, or if replay is loading, armed or active. Arming replay is also blocked while recording starts, runs, stops or awaits recovery.

### Crash recovery (auto-resume)

If the backend dies mid-recording (crash, power loss, accidental kill -9), the next start will pick up where the previous run left off. Once StageLinq is back online, the recorder reopens the file in append mode and writes:

- one `gap` event with `crashedAtWall`, `resumedAtWall`, and `gapMs`
- fresh keyframes for all four decks at the resume time
- normal recording continues

Anything that happened on the decks during the gap is **not** recoverable — the bridge has no history. The gap event is a forensic marker so analysis tools can detect the discontinuity.

**Resume gating:** auto-resume only fires when the previous run died **with a recording active**. The recorder writes a small `recordings/.active-recording` lock file on `start()` (containing the active `.jsonl` basename) and deletes it on clean `stop()`. On boot, the lock's presence is the *only* signal that triggers resume — stale unfinished `.jsonl` files from older shows that no longer have a lock are intentionally ignored, no log spam.

Constraints: files older than 24 h are skipped (lock cleared). If the lock points at a missing/empty/sidecar'd file, it self-heals and clears. Use `POST /api/record/resume-abort` to discard a pending resume (and clear the lock) before starting a fresh recording. Graceful shutdown (SIGINT/SIGTERM) waits for pending recording operations and flushes the footer and sidecar before exit. A failed write returns an error and retains recovery state. A torn final JSONL line is repaired before resuming. A completed footer with missing sidecar reconstructs the sidecar before clearing its lock. Interior corruption blocks recovery and a new recording visibly until resume-abort explicitly discards recovery selection; the original log stays intact.

### Replay

1. Bounce the live show to a single audio file (Reaper / DAW / hardware recorder).
2. Open the **Config Editor → Recordings (Replay)** section. Add a mapping: audio-file basename → `<iso>.jsonl`. Save and reload (`Ctrl+R` in the backend TTY, or **Settings → Controls → Reload config**).
3. Click **ARM REPLAY** in the header. The badge shows `ARMED`.
4. Load the audio file on any deck — the badge changes to `ATTACHING`.
5. Press play. The badge changes to `REPLAY` and the Art-Net / OSC / WS outputs now come from the log, indexed by the audio deck's sample-accurate `elapsedSec`.

The audio playback deck's own state is hidden from outputs while replay is active — all four simulated decks come from the log.

### Replay clock and dropouts

Replay uses the audio deck's `elapsedSec` as the master timeline (sample-accurate, set by the deck's beatMessage stream). This means:

- **Pausing the audio deck** deliberately stops replay timecode output. **Missing fresh audio-deck data** engages the existing freewheel controls after the stale threshold; repeated UI snapshots do not count as fresh source data.
- **Scrubbing** the audio deck rewinds replay to the corresponding log position.
- **Pitching** the audio deck speeds up or slows down replay accordingly. Don't pitch the backup audio during a real fallback — the recorded `currentBpm` we emit will not match the pitched playback rate.
- **End of log**: when the audio plays past the recorded show's duration, replay holds all decks `play=false` and the badge changes to `REPLAY END`. Seeking back inside the log resumes replay.
- **Loading a different (non-mapped) audio file** detaches replay back to `ARMED`.

### Storage

Logs and sidecars live in `recordings/` at the repo root. Historical recording/log files are currently tracked; the ignore rules are commented out. One JSONL line per event, full bridge cadence, with deck-state diffs between keyframes. New logs use schema v2: the header stores initial offsets; config events store later applied offset maps and playlist references. Deck events preserve repeated position heartbeats, source identity and explicit transport state separately from watchdog display changes. Event time uses a monotonic clock; wall-clock timestamps label files and estimate crash gaps. Version 1 remains readable with inferred timing where provenance is missing.

Writes honor stream backpressure with an 8 MiB accepted-data bound (1 MiB per event). Overflow or storage failure stops recording visibly in the header and /api/record/status; the incomplete log and recovery lock remain. Accepted events drain when storage permits. The loader reports malformed interior events with line numbers and only repairs an incomplete final line. Incremental parsing yields between input batches, shares duplicate mapped logs and creates checkpoints every 1,024 deck events for seeks. Parsed events remain in memory while armed. Output/freewheel settings remain the current runtime configuration; v2 records historical offsets and source timing, not every global setting. Size depends on event cadence and metadata; inspect disk usage before long recordings.

## Prerequisites

- Node.js 22+
- ffmpeg and ffprobe on PATH for waveform decoding and fallback artwork inspection (both ship with ffmpeg)
- Denon Prime 4+ (or compatible Engine DJ device) on the same LAN as this server

## Install

Keep this repository beside the StageLinq checkout. Both WebView workspaces
resolve @gree44/stagelinq from ../StageLinq. Install and build that package
first, then install WebView from its lockfile.

```bash
npm ci --prefix ../StageLinq
npm ci
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
npm run build   # rebuilds sibling StageLinq, typechecks/builds frontend, builds backend
npm test        # deterministic regressions; hardware access is stubbed
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

Hot-reload: press **Ctrl+R** in the terminal running the backend to reload `config.json` without restarting. For headless / PM2 deployments where there is no TTY, the same reload is exposed in the UI as **Settings → Controls → Reload config from disk** (arm-gated) and over HTTP as `POST /api/config/reload`.

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
| `ARTNET_FPS` | `30` | Timecode frame rate: `24`, `25` or `30`. 29.97 drop-frame is not implemented and is rejected |
| `ARTNET_SEND_HZ` | *(same as `ARTNET_FPS`)* | UDP send rate in Hz (override to send faster than FPS tick rate) |
| `ARTNET_LATENCY_COMP_MS` | `80` | Latency compensation in milliseconds |

### sACN control input

| Variable | Default | Description |
|---|---|---|
| `CONTROL_INPUT_MODE` | `sacn` | Set to `none` to disable |
| `SACN_UNIVERSE` | `20` | sACN universe to listen on |
| `SACN_ADDRESS` | `1` | DMX channel (1-indexed) for deck-select |

### OSC BPM output

| Variable | Default | Description |
|---|---|---|
| `OSC_ENABLED` | `false` | Enable OSC BPM sender |
| `OSC_TARGET_IP` | `127.0.0.1` | OSC target IP(s) — single IP or comma-separated list for multi-host fan-out |
| `OSC_TARGET_PORT` | `8000` | OSC target UDP port |
| `OSC_SPEEDMASTER` | `15` | SpeedMaster channel number in the OSC command |

### Camelot key mapping

The bridge converts StageLinq's `CurrentKey` into Camelot notation and keeps it across beat updates. It accepts Camelot values such as `8A` and musical names such as `Am`, `A minor`, `C major`, `F#m`, and `B♭`. A valid named key takes precedence over the numeric index, including any `KEY_MAP` override.

An empty or unrecognized named key falls back to `CurrentKeyIndex`, a number 0–23. The default index mapping is `1A, 1B, 2A, 2B, … 12A, 12B`. `KEY_MAP` overrides this numeric fallback when firmware uses a different order. Track changes, unloads, and reconnects clear the previous key.

```bash
KEY_MAP="1A,1B,2A,2B,3A,3B,4A,4B,5A,5B,6A,6B,7A,7B,8A,8B,9A,9B,10A,10B,11A,11B,12A,12B"
```

Run the focused key regressions after building the backend.

```bash
npm run -w backend build
node --test backend/test/stagelinqBridge.test.mjs
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

**Runs in a dedicated worker thread.** ffmpeg, peak compute, JSON serialization of the peaks array, base64 encoding of the artwork, and disk-cache I/O all run off the main thread (in [backend/src/waveformWorker.ts](backend/src/waveformWorker.ts)). The main thread only forwards the StageLinq-downloaded audio bytes into the worker (zero-copy `ArrayBuffer` transfer) and fans out the pre-built WS frame strings on the way back. Artwork first uses Chris’s metadata-connect parser, with ffprobe/ffmpeg fallback. Extraction failures remain retryable; absence is cached only after validated inspection. PCM is reduced to peaks incrementally in the worker. The independent Art-Net worker can freewheel while main is stalled, subject to its configured limits and OS scheduling.

Media is keyed by the full network source/path (DeckState.mediaId and media-message trackId); fileName remains the display label and the existing playlist/replay mapping key. Different devices or directories with the same filename have separate caches. Disk entries are lazy, validated, atomic manifests under media-cache-v1/<SHA256(trackId)>.json. Legacy basename waveform/artwork caches remain untouched and are ignored, so tracks regenerate once as needed. Full paths cannot identify content overwritten at the exact same path without a device version/mtime signal; clear that track's manifest when replacing content in place. Disk retention remains operator-controlled.

Resource defaults are in [backend/src/constants.ts](backend/src/constants.ts): two download-through-extraction jobs, one worker extraction job (at most two child processes), 256 MiB maximum input per download, 256 MiB total worker audio admission, eight pending worker callers, and a 128 MiB / 32-entry backend cache. Waveforms are capped at four hours / 200 peaks per second; artwork at 16 MiB. Media jobs have a two-minute deadline. Abandoned tracks and reconnects cancel work; per-device downloads stay serialized through cleanup. The package closes unsafe transfer streams before reuse, and TCP connection attempts have a real deadline. Worker shutdown drains child-process/temp-file cleanup, with bounded forced cleanup as a fallback.

The browser cache is capped at 64 MiB / 24 entries, prefers loaded tracks and retains a small window for frames arriving before their snapshot. Eviction revokes artwork URLs. Active entries can be evicted if they alone exceed the hard budget. These bounds account for retained payloads, not total process memory, transient JSON decoding or image/GPU allocations. Replay lazily loads historical media from disk without downloading historical device paths. The mutable /api/artwork/:deck response uses no-store to avoid serving the preceding track's cover.

### Hot cue cache

Engine DJ does not stream hot-cue positions over StageLinq's StateMap (StageLinq advertises the keys, but Prime 4+ / SC6000 firmware doesn't publish them). To make cues available to the app anyway, an offline extraction script reads the `quickCues` BLOB out of the Engine DJ SQLite database (the `m.db` on the SD card or USB drive the controller boots from) and writes one JSON file per track to `backend/hotcue-cache/`.

#### Usage

Run from the repo root, **before the show**, with the SD card / USB drive plugged into the laptop:

```bash
npm run -w backend extract-cues
```

The script auto-detects all candidate `m.db` locations:
1. Every mounted volume — `/Volumes/*/Engine Library/Database2/m.db`
2. The in-repo snapshot — `copy of exported library/Engine Library/Database2/m.db` (if you keep one for testing)
3. The on-PC Engine DJ install — `~/Music/Engine Library/Database2/m.db`

If multiple are found, you'll be prompted to pick one:

```
Multiple Engine DJ databases detected:
  [1] /Volumes/BACKUP 8GB/Engine Library/Database2/m.db  (33.9 MB)
  [2] /Users/jan/Music/Engine Library/Database2/m.db     (12.4 MB)
Pick one (1-2):
```

If exactly one is found, the script uses it without prompting. If none are found, it errors out and asks you to plug something in or pass `--db`.

##### Flags

| Flag | Meaning |
|---|---|
| `--db <path>` | Skip auto-detection and prompt — use this exact `m.db`. Useful in scripts. |
| `--current-only` | Only process the playlist at `config.current_playlist`. |
| `--all-playlists` | Process every playlist in `config.playlists` (the default). |
| `-h`, `--help` | Print usage and exit. |

##### Examples

```bash
# Default: prompt if multiple DBs, scan every playlist
npm run -w backend extract-cues

# Skip prompt — use the SD card directly
npm run -w backend extract-cues -- --db "/Volumes/BACKUP 8GB/Engine Library/Database2/m.db"

# Skip prompt + only the active playlist (faster on huge libraries)
npm run -w backend extract-cues -- --db "/Volumes/BACKUP 8GB/Engine Library/Database2/m.db" --current-only
```

##### Output

Per-track summary on stdout, plus a list of any tracks listed in `config.json` that aren't found in the database (usually playlist drift — the song was renamed or removed since the playlist was edited):

```
Config: /Users/jan/Git_Repos/StageLinq-WebView/config.json
Scope: all playlists
Tracks to look up: 29

Wrote: 28
No cues stored:   0
Missing in DB:    1

Tracks not found in Track.filename (check naming / playlist drift):
  - 06. Shake It Off (Extended Mix).flac

Cache: /Users/jan/Git_Repos/StageLinq-WebView/backend/hotcue-cache
```

##### Re-running

Safe at any time — even mid-show. The script:

- imports nothing from the runtime backend (no StageLinq, no express, no waveform pipeline) and opens the database read-only,
- overwrites entries in place (one full-file write per track), and
- never deletes anything, so stale entries from removed playlists stick around. To wipe and rebuild from scratch: `rm -rf backend/hotcue-cache && npm run -w backend extract-cues`.

The runtime backend does not yet load `hotcue-cache/` at boot — the script populates the cache; consumption (e.g. seeding `DeckState.hotCues` on track-load) is a separate feature still to be wired up.

#### Cache layout

[backend/hotcue-cache/](backend/hotcue-cache/) — one file per track using the legacy basename digest. This offline cue format remains separate from runtime media full-identity manifests.

```jsonc
{
  "fileName": "02 Messy (Łaszewo Extended Edit).mp3",  // the cache key (basename)
  "trackId": 28,                                        // Engine DJ Track.id, traceability
  "source": "/Volumes/BACKUP 8GB/Engine Library/Database2/m.db",
  "extractedAt": "2026-06-19T11:40:12.599Z",
  "cues": [
    { "index": 1, "samples": 0,           "sec": 0.000,  "label": "Cue 1", "argb": "FFF4D338" },
    { "index": 2, "samples": 631880.5970, "sec": 14.328, "label": "Cue 2", "argb": "FFEF8130" },
    // ...only set slots, sorted by index ascending; unset slots elided
  ]
}
```

- `cues[]` is **sorted by `index` ascending** (1..8) and **only contains set slots**.
- `samples` is preserved alongside `sec` so a future consumer with a non-44100 Hz track can recompute exactly. Convention: `sec = samples / 44100`.
- `argb` is an 8-char uppercase hex string — alpha (always `FF` in practice), R, G, B. Drop in CSS as `'#' + argb.slice(2)`.
- `label` is whatever Engine DJ stored. Hardware default is `"Cue 1"`, `"Cue 2"`, … but the DJ may have renamed cues.

## Timecode simulator (offline TC analysis)

Standalone, read-only addon that takes a Record & Replay `.jsonl` and produces a graph of the timecode every deck *would* emit if it were continuously sACN-selected. Useful for post-show review (where did the TC stall, drift-snap, freewheel?), playlist-offset sanity checks (do the per-track offsets line up where expected?), and pre-show dry runs.

The simulator and live worker share [TimecodeTimeline](backend/src/timecodeTimeline.ts), eliminating the separate copied clock algorithm. It uses the same pitch, source extrapolation, drift correction, freewheel controls and duration clamp, without UDP. Old recordings infer position/transport updates from deck events; they cannot recreate missing repeated BeatInfo samples or distinguish every watchdog update, so simulation is diagnostic rather than proof of hardware timing.

Run from the repo root:

```bash
npm run -w backend simulate-tc -- /absolute/path/to/recording.jsonl
```

Pass an absolute path (the workspace runs from `backend/`, so a path relative to the repo root won't resolve). Output is a self-contained HTML file — no external assets, opens in any browser — written next to the input by default.

#### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--out <file>` | `<input>.tc-analysis.html` | Output HTML path. |
| `--json <file>` | (off) | Also dump per-deck stats + freewheel spans as JSON. |
| `--config <file>` | (auto) | Use this `config.json` for track offsets. By default the recording's historical header/config offsets are used; if absent, a `config.json` next to the cwd is auto-loaded. |
| `--fps <n>` | `30` | TC fps (must match what the worker would use). |
| `--latency <ms>` | `80` | Latency-comp added to every emitted frame, mirroring `latencyCompMs`. |
| `--tickHz <n>` | `30` | Simulation tick rate. |
| `--freewheel-max <s>` | `30` | Max freewheel duration before going silent. |
| `--no-freewheel` | (off) | Disable freewheel — silent on first stall instead of coasting. |
| `--stale-ms <ms>` | `250` | Stale threshold for freewheel detection. |

#### What's in the HTML

- **Overlay graph** — each deck's hypothetical TC plotted as `HH:MM:SS` over wall-clock time, in the same colors as the live UI (D1 purple, D2 blue, D3 green, D4 red).
- **Freewheel bands** — translucent shading per deck wherever the worker logic would have been freewheeling at that moment.
- **Recording gaps** — vertical dashed amber lines at any `gap` event from the recorder (only present in crash-recovered logs).
- **sACN selected-deck timeline** — a thin colored bar under the chart showing which deck *was* actually selected during the show, for cross-reference against the hypothetical-per-deck plots.
- **Per-deck files list** — every `(t, fileName)` transition per deck.
- **Analysis blob** — JSON dump of duration, offset count, drift-snap counts, freewheel spans, file counts.
- **Hover tooltip** — hover anywhere on the chart to see the exact `HH:MM:SS:FF` value each deck would be emitting at that wall-clock moment.

The simulation treats every deck as if it were *the* selected deck for the whole recording, so the graph shows what each deck *could* have emitted — not just what the actual sACN selection picked. The selected-deck bar at the bottom records what was actually live.

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/artwork/:deck` | Serve cached album artwork for deck 1–4 |
| `GET` | `/api/users` | List all users and their UI-settings blobs (`{ users: [{ name, settings }] }`) |
| `GET` | `/api/users/:name/settings` | Get one user's settings blob |
| `PUT` | `/api/users/:name/settings` | Replace one user's settings blob; body is the JSON object to store. Stored to `users.json` at the repo root. |
| `GET` | `/api/global-settings` | Read backend-owned settings (currently `{ freewheel: { enable_freewheeling, max_duration_sec }, meta }`). |
| `PUT` | `/api/global-settings/freewheel` | Patch the freewheel section; body `{ enable_freewheeling?: boolean, max_duration_sec?: number }`. Persisted to `config.json` and pushed live into the Art-Net worker. |
| `GET` | `/api/config` | Read the on-disk `config.json` for the in-app config editor. Returns `{ config, sourcePath }` (parsed JSON, JS-style comments stripped). |
| `PUT` | `/api/config` | Atomically write the full `config.json` (tmp+rename). Body is the new top-level config object. **Write-only**: the runtime is NOT hot-reloaded by this — press `Ctrl+R` in the backend terminal, click **Settings → Controls → Reload config**, or `POST /api/config/reload` to apply. |
| `POST` | `/api/config/reload` | Hot-reload `config.json` mid-show — same code path as `Ctrl+R` on the backend TTY. Re-applies playlist offsets, track notes, freewheel, logging, and display settings. Returns `409 { error: "reload already in progress" }` if a reload is currently running. Backs the **Settings → Controls → Reload config** button. |
| `POST` | `/api/record/start` | Start recording the live show to `recordings/<iso>.jsonl`. Optional body `{ "name": "..." }` is appended to the filename. Refuses with `409` if already recording, replay is loading/armed/active, or StageLinq is not connected. |
| `POST` | `/api/record/stop` | Stop the active recording, flush, and write the `.meta.json` sidecar. Returns `{ ok, file, durationMs, eventCount }` or `409` if not recording. |
| `GET` | `/api/record/status` | Current recorder state. |
| `POST` | `/api/record/resume-abort` | Discard a pending crash-recovery resume so a fresh recording can be started. `409` if no resume is pending. |
| `GET` | `/api/recordings` | List `recordings/*.meta.json` sidecars for the config-editor dropdown. |
| `POST` | `/api/replay/arm` | Load all configured recordings and watch for a mapped audio file to land on a deck. Refuses if recording is in progress. |
| `POST` | `/api/replay/disarm` | Drop loaded recordings and return to idle. |
| `GET` | `/api/replay/status` | Current replay state (`idle` / `armed` / `attaching` / `active` / `ended`). |

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
│   ├── recorder.ts         # Record-mode JSONL writer (Record & Replay)
│   ├── replay.ts           # Replay engine (Record & Replay)
│   ├── stateProvider.ts    # Output-side shim: bridge state vs. replay state
│   ├── waveformService.ts  # Main-thread harness for the waveform worker (frame caches + IPC)
│   ├── waveformWorker.ts   # Waveform worker (ffmpeg + computePeaks + JSON/base64 + disk cache)
│   ├── waveformWorkerMessages.ts # typed message contract for the waveform worker
│   ├── camelot.ts          # Key index → Camelot string
│   ├── constants.ts        # Tunable timing and threshold constants
│   ├── logging.ts          # Configurable debug logging
│   └── types.ts            # DeckState, WsPayload
└── frontend/src/
    ├── App.tsx             # WebSocket client, 4-quadrant layout
    ├── DeckCard.tsx        # Per-deck display component
    ├── HeaderBar.tsx       # Top bar: selected deck, BPM, next track
    ├── RecordingControls.tsx # REC + ARM REPLAY buttons (Record & Replay)
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

// waveform_status — progress during peak analysis (per-deck, has `deck` field)
{ "type": "waveform_status", "deck": 1, "stage": "downloading|generating|ready|error", "progress": 0, "trackId": "net://device/USB/path/song.mp3", "fileName": "song.mp3" }

// waveform_data — peak array, keyed by trackId (matches DeckState.mediaId).
// The frontend applies it to every deck currently holding that file (so the
// same track on two decks renders correctly without duplicate broadcasts).
// Pre-serialized in the waveform worker so the broadcast path does zero CPU work.
{ "type": "waveform_data", "trackId": "net://device/USB/path/song.mp3", "fileName": "song.mp3", "peaks": [...], "peaksPerSec": 200 }

// artwork_data — album art (base64) or confirmed absence. Keyed by trackId.
{ "type": "artwork_data", "trackId": "net://device/USB/path/song.mp3", "fileName": "song.mp3", "data": "<base64>" | null, "mime": "image/jpeg" | null }

// terminal_lines — backend log lines for the in-app terminal panel.
// Sent only to clients that opted in by sending {type:'terminal_subscribe', enabled:true}.
// `replace` is sent once per (re)subscribe with the recent ring buffer; subsequent
// frames use `append` with one or more lines as they're printed.
{ "type": "terminal_lines", "mode": "replace" | "append",
  "lines": [{ "ts": 1234567890, "level": "log" | "error", "text": "..." }] }
```

### Client → server

The client sends a single message type so far:

```jsonc
// terminal_subscribe — opt this WS in/out of the live log stream
{ "type": "terminal_subscribe", "enabled": true | false }
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

**Art-Net freewheel during a stall:** the worker uses the selected deck's timestamped BeatInfo position. After FREEWHEEL_STALE_THRESHOLD_MS (250 ms), or during reconnect, it advances from the last reliable state within the configured limit. Metadata, another deck, or queued old samples cannot refresh it. Incomplete reconnect snapshots cannot reset the timeline to zero. Drift correction compares newly received positions extrapolated to the current tick; explicit pauses stop output, and real seeks/loops rebase to their new positions. The independent 2-second disconnect watchdog controls the reconnect/status path.

The freewheel has two operator knobs, persisted in `config.json` under `freewheel` and editable live in the in-app **Settings → Global Settings / Controls** sections (no restart needed):

| Field | Default | Effect |
|---|---|---|
| `freewheel.enable_freewheeling` | `true` | When `false`, the worker stops sending TC the moment StageLinq goes stale — no freewheel at all. Toggle in **Settings → Controls**. |
| `freewheel.max_duration_sec` | `30` | Ceiling (seconds) on how long the worker keeps freewheeling after the source went stale. Past this it goes silent until beats resume. Slider in **Settings → Global Settings**. |

REST: `GET /api/global-settings` (returns `{ freewheel, meta }`) / `PUT /api/global-settings/freewheel` (`{ enable_freewheeling?, max_duration_sec? }`). Updates are persisted to `config.json` and live-pushed into the Art-Net worker.

All three values — plus `WS_FPS`, `ARTNET_BIND_TIMEOUT_MS`, `ARTNET_DRIFT_THRESHOLD_RATIO`, and `ELAPSED_THROTTLE_S` — are collected in [`backend/src/constants.ts`](backend/src/constants.ts) so they can be adjusted in one place.

## Diagnostics

To make timecode-cadence problems observable, the backend logs:

- **`[ArtNet/wk] tick stats`** — emitted every 2 s by the Art-Net worker. Shows tick count, average interval, p50, p95, max interval, max "behind" (how late the worker self-corrected from), and any hard stalls. A healthy line at 30 fps reads roughly `avg=33.33ms (30.00fps) p95<35 max<40 maxBehind<5 hardStalls=0`.
- **`[ArtNet/wk] Late tick`** — single late tick warning, rate-limited to 1/s.
- **`[main] event-loop lag Xms`** — main-thread event-loop lag warning. The Art-Net worker is unaffected by main-thread stalls; this log just tells you where to look when the WS UI feels sluggish (typical cause: ffmpeg-done callback or a large JSON serialization).
- **`[main] WS broadcast slow`** — WebSocket broadcast warning if a single snapshot send takes longer than `WS_BROADCAST_WARN_MS` (default 5 ms).

Tunable thresholds for the diagnostics live alongside the existing tunables in [`backend/src/constants.ts`](backend/src/constants.ts): `ARTNET_TICK_STATS_LOG_INTERVAL_MS`, `MAIN_EVENT_LOOP_LAG_WARN_MS`, `WS_BROADCAST_WARN_MS`, `ARTNET_HARD_STALL_INTERVALS`.

## License

MIT — Jan Müller (2026)


## Configuration and display corrections (2026-11-24)

- Saving config accepts JSON comments, preserves quoted comment-like text and serializes to ordinary JSON. Malformed config is rejected without replacing live mappings or overwriting the file. Failed settings writes return an error and do not update the live freewheel value.
- Deleting a track or mashup preserves all remaining timecode offsets and frame offsets. Deleting the active playlist leaves no active playlist; deleting another preserves the current selection.
- CSV import uses Papa Parse, maps Engine DJ column headers and reports malformed records instead of silently dropping quoted multiline fields.
- User settings wait for initial loading; requests are serialized/coalesced and failures are shown. Freewheel duration changes coalesce while enable/disable remains responsive.
- A backend restart starts a new WebSocket sequence immediately. Long waveforms use bounded pixel columns rather than one draw per sample. WebSocket sends serialize and coalesce queued snapshots. Queue limits and stalled-send deadlines disconnect overloaded clients; large waveform messages can drain on healthy sockets.
- The package supplies BeatInfo, TrackLength, CurrentKey and public instance/path APIs. WebView retains its sample conversion, key normalization, device download queue, cue extraction and output-specific logic where upstream has no equivalent contract.

Selected transfer/cache/recording fixes, compatibility, tests and deliberately deferred work: [integrity follow-up](docs/review-2026-11-24/integrity-followup.md).
