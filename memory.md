# Project memory — StageLinq WebView

Active architectural decisions and known quirks. Update **immediately** on any
decision/bug-confirmation/direction change (per CLAUDE.md).

---

## Architectural decisions

### 2026-06-18 — Freewheel config + Settings modal sections

**What:** The Art-Net freewheel introduced earlier today now has two operator
knobs, surfaced both in `config.json` and the Settings modal:

- `freewheel.enable_freewheeling: boolean` (default `true`)
- `freewheel.max_duration_sec: number` (default `30`, clamped 0–3600)

`config.json` example:

```json
"freewheel": {
  "enable_freewheeling": true,
  "max_duration_sec": 30
}
```

**Worker behaviour matrix** (in [backend/src/artnetWorker.ts](backend/src/artnetWorker.ts)):
- `enable_freewheeling=false` AND stale → packet send is skipped immediately;
  `lastTickMs` is reset so the freewheel restarts cleanly when beats resume.
- `enable_freewheeling=true` AND stale, within `max_duration_sec` of stale-onset
  → freewheel as before (last-good deck snapshot, drift-snap suppressed).
- `enable_freewheeling=true` AND stale, past `max_duration_sec` → packet send
  skipped (silent), one-shot warn log
  `[ArtNet/wk] Freewheel timeout reached (Ns) — going silent until beats resume`.

`updateDeck` records `staleSinceMs` on the rising edge of stale and clears it
when fresh beats return, so the duration window is per-stall, not cumulative.

**REST surface** ([backend/src/index.ts](backend/src/index.ts)):
- `GET /api/global-settings` →
  `{ freewheel: {...}, meta: { freewheel_max_duration_sec: { min, max } } }`.
- `PUT /api/global-settings/freewheel` body
  `{ enable_freewheeling?: boolean, max_duration_sec?: number }` — partial
  patch. The handler clamps the duration server-side
  ([backend/src/globalSettings.ts](backend/src/globalSettings.ts)), persists to
  `config.json` via tmp+rename, and live-pushes the new values to the worker
  through a new `setFreewheel(...)` IPC message
  ([backend/src/artnetWorkerMessages.ts](backend/src/artnetWorkerMessages.ts))
  so the change applies without a process restart.

**Persistence model — single source of truth:** `config.json` already exists
and is the operator-facing config file. Rather than introduce a second store
(à la `users.json`), the freewheel section lives in the same file, edited via
`GlobalSettingsStore`. The store reads the file fresh on each write so it
preserves any sibling keys (playlists, target_ips, etc.) and never overwrites
unrelated changes the operator made manually. Trade-off: comments would be
lost on write, but `config.json` doesn't carry any. Ctrl+R config reload
re-seeds the store from disk and re-pushes to the worker.

**Frontend UI** ([frontend/src/SettingsModal.tsx](frontend/src/SettingsModal.tsx)):
the modal now has three sections separated by hairlines and SECTION-HEADER
caps:
1. **User Settings** — existing per-user detail-zoom slider (unchanged).
2. **Global Settings** — freewheel duration slider (range from server's
   `meta.freewheel_max_duration_sec`).
3. **Controls** — single toggle button to enable/disable freewheeling
   instantly. Reuses the existing `.toggleBtn on/off` styles for consistency
   with the "TC while stopped" toggle.

Hydration: App fetches `/api/global-settings` once on mount; updates are
optimistic with reconcile-on-success and refetch-on-failure.

**Why the section split:** the user asked for "global settings" (not
per-user) plus a separate "Controls" section for the kill switch. The
duration slider is a knob you tune once for your venue (Global Settings); the
toggle is a panic button you may want to flip live during a show (Controls).
Keeping them in different sections matches that mental model and makes the
kill switch easy to find.

---

### 2026-06-18 — Art-Net freewheel + center disconnect badge

**What:** Across a brief StageLinq disconnect (cable pull, device off, mid-reconnect)
the Art-Net worker no longer freezes the timecode at the last source frame. The
main thread's poll lambda now returns `{ deck, stale }` instead of just a
`DeckState`. `stale === true` flips the worker into freewheel mode:

- The worker keeps the last-good `DeckState` snapshot and ignores the watchdog's
  `play=false` flip during a stall — `treatAsPlaying` falls back to "was already
  running" while stale.
- The drift-correction snap (`Math.abs(sourceFrames - timelineFrames)` clamp and
  the `timelineFrames < sourceFrames` floor) is skipped while stale, so the
  freewheel timeline isn't yanked back to the frozen source elapsed.
- `timelineFrames += dtSec * fps * (1 + speedState/100)` continues to advance
  using the last-known speed.

`stale` is computed in [backend/src/index.ts](backend/src/index.ts) with the same
threshold the snapshot uses for `stagelinqStatus`:
`reconnecting || bridge.getLastBeatAgeMs() > DISCONNECT_DETECT_TIMEOUT_S * 1000`.

The wire-protocol type is in
[backend/src/artnetWorkerMessages.ts](backend/src/artnetWorkerMessages.ts)
(`updateDeck` now carries `stale: boolean`); the worker consumes it in
[backend/src/artnetWorker.ts](backend/src/artnetWorker.ts) (`updateDeck` /
`doSend`); the harness's poll signature is
[`DeckPollResult`](backend/src/artnetTimecode.ts).

**Frontend:** [frontend/src/HeaderBar.tsx](frontend/src/HeaderBar.tsx) now
renders a big red pulsing badge in the center of the top bar
(`.headerError` in [frontend/src/styles.css](frontend/src/styles.css))
whenever the WS is offline, the bridge is reconnecting, or no device is
present. The existing left-side `connDot` + label is unchanged — it sits next
to the badge rather than being replaced. Three labels:
`WS DISCONNECTED` (no socket), `STAGELINQ RECONNECTING`,
`STAGELINQ DISCONNECTED` (no-device).

**Why:** the lighting console expects monotonic SMPTE TC. When StageLinq
flickers, freezing the TC at the last source frame causes lights to stop
moving along the timeline and visibly snap when beats resume. Freewheeling at
the last-known speed keeps the show looking continuous; the badge tells the
operator the feed is degraded so they know not to trust live BPM/elapsed.

**Limits / scope:** freewheel is open-loop — if the disconnect lasts long
enough for the deck to actually stop, scratch, or change tempo, the timeline
will diverge from reality until beats resume and the drift snap re-engages.
Acceptable for short network blips; longer outages are still operator
intervention territory. No new constants were introduced (`stale` reuses
`DISCONNECT_DETECT_TIMEOUT_S`).

---

### 2026-06-17 — Run-scoped error/warn log files (`logs/run-<ISO>.log`)

**What:** [backend/src/logging.ts](backend/src/logging.ts) writes a fresh log
file per backend run into `logs/` at the working directory, named
`run-<ISO-timestamp>.log` (colons/dots replaced with `-` for FS-safety). Only
`logError(...)` and the new `logWarn(...)` persist to disk; everything else
(`logLifecycle`, `logPlayback`, `logWaveform`, dashboard, status slots, …) is
terminal-only. Each line is `[HH:MM:SS.mmm] [ERROR|WARN] <message>`.

**Migration:** the previous append-only `errorlog.md` at the repo root is gone.
`logWaveform` no longer writes to disk (it was only `[WAVEFORM]` lifecycle
chatter — not an error/warn). The Art-Net worker `warn` channel (cadence
drops, late ticks, hard stalls) now routes through `logWarn` instead of being
re-tagged as an error in [backend/src/artnetTimecode.ts](backend/src/artnetTimecode.ts).
`logs/` is already covered by the `logs` line in `.gitignore`.

**Why:** old log was unbounded and mixed run boundaries with a single
separator line; per-run files are easier to attach to a bug report and prune.

---

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

### 2026-06-18 — Per-track `note` block: in-UI popup on load

**What:** Each entry in `playlists[].content[]` may carry an optional `note`
block:

```json
"note": { "description": "remember the laser cue", "show_secs_after_load": 5 }
```

When a track with a non-empty `description` loads on any deck, the frontend
shows a modal popup `show_secs_after_load` seconds later (default 0). The popup
is dismissed by clicking the backdrop or the close button. Replacing/unloading
the track on that deck before the delay elapses cancels the pending popup.

**Renaming note:** the adjacent `show_secs_before_transition_starts` field
(present in early `config.json` snapshots but never read by code) was renamed
to `show_secs_after_load` in the same change. No backwards-compat shim — the
old name is gone everywhere.

**Wiring:**
- Backend: [`buildTrackNoteMap`](backend/src/index.ts) builds a normalized
  filename → `{ description, showSecsAfterLoad }` map, prioritizing the active
  playlist (same priority logic as `buildTrackOffsetMap`). The snapshot
  loop writes a per-deck `deckNotes: Record<DeckNumber, TrackNote | null>`
  field on `SnapshotPayload`.
- Frontend: [App.tsx](frontend/src/App.tsx) keeps a `pendingPopupTimers` map
  (one timer per deck) and a `seenNoteForFile` ref to fire the timer exactly
  once per `(deck, fileName)`. Popups queue in order — only the head is
  rendered. The popup component [TrackNotePopup.tsx](frontend/src/TrackNotePopup.tsx)
  uses the per-deck accent (`theme-d1..d4`) for the border/header tint.

**Why:** lets the operator stash short notes against tracks (cue reminders,
transition recipes) and have them surface automatically a few seconds into
playback — no need to read the config during a show.

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
