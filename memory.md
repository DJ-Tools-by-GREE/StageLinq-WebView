# Project memory — StageLinq WebView

Active architectural decisions and known quirks. Update **immediately** on any
decision/bug-confirmation/direction change (per CLAUDE.md).

---

## Architectural decisions

### 2026-06-17 — Per-user UI settings (`users.json` + `/api/users`)

**What:** A header dropdown lets the operator switch between fixed users
(`Default User`, `Jan`, `Dennis`). Each user owns an independent blob of UI
settings; switching simply re-applies that user's settings live.

**Storage:** `users.json` at the repo root, shape
`{ "users": { "<name>": { ... } } }`. Backend module
[backend/src/userSettings.ts](backend/src/userSettings.ts) loads/persists with
serialized writes via `tmp + rename` to avoid torn files. Missing fixed users
are auto-created on load. Unknown user names are rejected by the API.

**Wire format:**
- `GET /api/users` → `{ users: [{ name, settings }, ...] }`
- `GET /api/users/:name/settings` → `{ name, settings }`
- `PUT /api/users/:name/settings` body is the new settings blob (replace, not
  merge — the frontend sends the full object).

**Frontend ownership** ([frontend/src/userSettings.ts](frontend/src/userSettings.ts),
[frontend/src/App.tsx](frontend/src/App.tsx)):
- Active user is per-browser, persisted in `localStorage` under
  `stagelinq.activeUser`. Default is `Default User` on first load.
- All users' settings are fetched once on mount and held in a single
  `UsersMap` in App state. PUTs are debounced **per-user** (250 ms) — one
  timer per user so editing user A and then quickly switching to and editing
  user B doesn't drop A's pending write.
- `effectiveZoom()` falls back to `DEFAULT_DETAIL_ZOOM_SEC = 10` when a user
  has no `detailZoomSec` field yet, so a fresh user starts at the default.

**Settings shape:** open-ended on disk and at the API — frontend sends a JSON
object; backend stores it verbatim. Today the only field is
`detailZoomSec: number` (4–30, controls the visible time-window of the per-deck
detail waveform). Future fields are added by extending the typed
`UserSettings` interface; no schema migration on the server side.

**Out of scope by design:**
- No auth — anyone on the LAN can pick any user. This is a show tool.
- The user list is fixed in code (`FIXED_USERS` constant on both sides). No
  add/rename/delete UI.
- Active user is **not** synchronized between browsers; switching on one
  tablet does not affect another. Per-browser was the explicit choice — it
  matches how multiple operator displays might want different views.

---

### 2026-06-17 — `mashup_only` flag on playlist entries

**What:** Each entry in `playlists[].content[]` may carry an optional
`mashup_only: boolean` field. When `true`, the entry is an overlay (vocal stem,
mashup top-line) that is only ever played on top of another track and never
played standalone.

**Backend semantics — treat the entry as if it were not in the playlist at all:**
- [`buildTrackOffsetMap`](backend/src/index.ts) skips it → its
  `offset_sec`/`offset_frame` never apply, even if the deck loads it.
- [`buildActivePlaylistFileSet`](backend/src/index.ts) skips it → the file is
  not "in the active set", so waveform extraction follows the same rule as a
  track outside the playlist (runs only when `waveform.all_tracks === true`).
- [`computeNextTrack`](backend/src/index.ts) skips it when picking the *next*
  track for the header display. If the currently loaded track is itself
  flagged, its position is still used as the cursor — the next playable entry
  after it wins.

**Out of scope by design:** if the operator selects (via sACN) a deck that is
holding a `mashup_only` track, that's user error. No fallback or auto-switch
logic exists; Art-Net timecode behaves as it would for any track without an
offset entry.

**Why:** lets the operator keep overlays in the playlist (so they can be
discovered, browsed, or auto-loaded by a controller) without polluting the
"current/next" UI or skewing timecode with an unintended offset.

**Editor surface:** the [stagelinq-config-editor](../stagelinq-config-editor)
sibling project owns the per-row checkbox UI; backend just consumes the field.

---

### 2026-06-16 — Multi-IP fan-out for Art-Net and OSC

**What:** The Art-Net timecode worker and OSC BPM sender now accept a list of
target IPs instead of a single one and emit each UDP packet to every listed
host. Internally `targetIp: string` became `targetIps: string[]` on
`ArtNetOptions` ([backend/src/artnetTimecode.ts](backend/src/artnetTimecode.ts)),
`ArtNetWorkerInitOptions`
([backend/src/artnetWorkerMessages.ts](backend/src/artnetWorkerMessages.ts)),
and `OscBpmOptions` ([backend/src/oscBpm.ts](backend/src/oscBpm.ts)).

**Config surface:** `timecode.target_ips` and `osc.target_ips` are arrays in
`config.json`; the legacy scalar `target_ip` still works for back-compat (when
both are present, the array wins). The env vars `ARTNET_TARGET_IP` /
`OSC_TARGET_IP` accept a comma-separated list and override the file. Resolution
order is centralized in `resolveTargetIps()` in
[backend/src/index.ts](backend/src/index.ts).

**Why:** the user runs multiple lighting consoles / OSC receivers on the same
LAN that should each get an identical packet stream rather than relying on a
single broadcast address.

**Send strategy:** each `socket.send` is fired per-IP from the same dgram
socket — no per-target socket. Errors are logged with the offending IP. The
existing `ENETUNREACH` / `EADDRNOTAVAIL` socket-recovery path still triggers if
any send fails with one of those codes.

---

### 2026-06-16 — Art-Net SMPTE timecode runs in a worker thread

**What:** The UDP send loop and `dgram` socket for Art-Net SMPTE timecode were moved
out of the main event loop into a dedicated `worker_threads` worker
([backend/src/artnetWorker.ts](backend/src/artnetWorker.ts)).

The main thread keeps the public class
([backend/src/artnetTimecode.ts](backend/src/artnetTimecode.ts)) as a thin harness
that spawns the worker, runs a `sendHz` polling pump that posts the latest
`DeckState` snapshot to the worker, and forwards `setSendWhenStopped`/`stop`
lifecycle calls. Message contract is typed in
[backend/src/artnetWorkerMessages.ts](backend/src/artnetWorkerMessages.ts).

**Why:**
1. Track changes used to stall the timecode briefly. The main thread had to
   handle the FileTransfer download, two `ffmpeg` invocations (peaks + artwork),
   `JSON.stringify` of a multi-thousand-element peaks array, base64 of the
   artwork, and a WebSocket broadcast — all in addition to the 30 Hz timecode
   tick. The lighting console saw the TC "collapse" during the storm.
2. Steady-state cadence was structurally always slightly under 30 fps. The
   previous `setInterval(33)` rounds 33.333ms down, and event-loop jitter from
   the WS broadcast loop, OSC sender, sACN receiver, and StageLinq message
   handlers stacked on top.

The worker is immune to all of that: its own thread, its own socket, and a
**self-correcting deadline timer** (`nextDeadlineMs += 1000/sendHz` as a float,
no rounding loss; snap forward if behind > `ARTNET_HARD_STALL_INTERVALS`
intervals and log it).

**How the harness reaches the worker source:** dev under `tsx watch` resolves
`./artnetWorker.ts`, prod under `node dist/index.js` resolves `./artnetWorker.js`.
The harness picks the extension at runtime by checking whether
`import.meta.url` ends in `.ts`. tsx 4.x propagates its loader to
`worker_threads` automatically.

**Diagnostic logs added at the same time** (so any remaining cadence loss is
observable):
- `[ArtNet/wk] tick stats` (10 s rolling): count, avg interval, p50/p95/max,
  max behind, hard stalls.
- `[ArtNet/wk] Late tick`: per-late warning, ≤1/s.
- `[main] event-loop lag Xms`: 250 ms probe in the main thread; warns when
  `> MAIN_EVENT_LOOP_LAG_WARN_MS` (default 50).
- `[WAVEFORM] track-change deck=N download=Xms ffmpeg=Yms total=Zms`: per
  track-change timing breakdown in [backend/src/index.ts](backend/src/index.ts).
- `[main] WS broadcast slow`: warns when a snapshot send takes longer than
  `WS_BROADCAST_WARN_MS` (default 5).

The post-ffmpeg `broadcastWaveformData`/`broadcastArtwork` calls in the
`onTrackChanged` continuation are also wrapped in `setImmediate(...)` so the JSON
serialization and base64 work doesn't run in the same microtask tail as the
ffmpeg-done callback. The worker doesn't care, but it lets the main-thread WS
snapshot tick fire in between.

---

## Known hardware quirks

(none recorded yet beyond what's already in [CLAUDE.md](CLAUDE.md))

---

## In-progress / blockers

(none)
