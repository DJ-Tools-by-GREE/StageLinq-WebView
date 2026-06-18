# Project memory — StageLinq WebView

Active architectural decisions and known quirks. Update **immediately** on any
decision/bug-confirmation/direction change (per CLAUDE.md).

---

## Architectural decisions

### 2026-06-18 — Record & Replay (backup-show fallback)

**What:** Operator can record every state change the StageLinq bridge produces during a live show into a JSONL log under `recordings/`, then later replay that log synchronized to a single prerecorded audio file played on a deck. From the lighting console's perspective the replay is byte-identical to the live show — same Art-Net timecode, OSC, WS UI — and the console keeps full live control of `selectedDeck` (sACN CH1) and the suggestion-execute channel (sACN CH3) regardless of what was recorded.

**Architecture:** Recording happens at the **bridge output boundary** — every call to `bridge.touch(deck)` notifies registered listeners ([backend/src/stagelinqBridge.ts](backend/src/stagelinqBridge.ts) — new `subscribeDeckState()` / `DeckStateListener`). The recorder ([backend/src/recorder.ts](backend/src/recorder.ts)) maintains per-deck "last emitted" snapshots and writes either a full `state` keyframe (on track change / session start) or a field-level `diff` to JSONL. selectedDeck and sACN CH3 events are recorded from `index.ts` callsites since they are not bridge state.

A new shim ([backend/src/stateProvider.ts](backend/src/stateProvider.ts)) sits between the bridge and the three output paths (Art-Net poll, OSC poll, WS snapshot loop). When replay is overriding outputs, all four decks come from the replay engine ([backend/src/replay.ts](backend/src/replay.ts)) — including the audio playback deck, whose real state is hidden from the console. When idle, stateProvider passes through to the bridge.

**Replay clock:** the audio deck's sample-accurate `elapsedSec` (not wall-clock). Pause / scrub / pitch on the audio deck drag the replay timeline along automatically. Dropouts >250 ms force `play=false` on all simulated decks, then the existing Art-Net worker freewheel handles the silence. End-of-log holds all decks `play=false` and lets the console see a clean stop.

**Track-changed waveform suppression:** Mapped audio files (the long backup-set wavs) are gated out of the waveform/artwork extraction path in `onTrackChanged` regardless of replay state — they're large and useless to scan.

**Filename matching:** uses `normalizeTrackName()` (basename, case-sensitive). Same rule as playlist offsets.

**sACN CH3 during replay:** recorded `sacn_execute` events are NOT replayed. The lighting console's automation drives suggestion-execute on its own timecode-aligned schedule, exactly as in a live show.

**REST endpoints:** `POST /api/record/start|stop`, `GET /api/record/status`, `GET /api/recordings`, `POST /api/replay/arm|disarm`, `GET /api/replay/status`. Mappings live in `config.json` under `recordings: [{ audio_file, log_file }]`. The config editor has a new "Recordings (Replay)" section with a dropdown of available logs from the recordings dir.

**Storage:** JSONL + `.meta.json` sidecars in `<repo-root>/recordings/`, gitignored. Full event rate (no throttling).

**Invariant:** all output paths read from `stateProvider`, never `bridge` directly. The waveform extraction code path is the only exception (it asks the real bridge for `totalSec` of the deck currently being downloaded — fine, since mapped audio files are gated out before that path runs).

### 2026-06-18 — Art-Net: no TC frame on paused deck switch

**What:** When `sendWhenStopped` is off and the operator switches the selected
deck via sACN while everything is paused, the worker no longer fires the
"snapshot at the new position" packet. Previously the diff `lastSentStoppedFrames !== stoppedFrame` would trigger because the new deck's frozen `elapsedSec` differs, so the lighting console jumped to that deck's frozen TC despite nothing playing. Fixed in [backend/src/artnetWorker.ts](backend/src/artnetWorker.ts) by tracking `lastSentStoppedDeck` and silently re-baselining (no packet) on a deck-identity change.

**Preserved:** the original "snap when scrubbing on a paused deck" behavior
(commit `4c2d50a`) — within the same deck, a position change while paused still
emits one packet.

### 2026-06-18 — In-app config editor (absorbed from stagelinq-config-editor)

**What:** The standalone `stagelinq-config-editor` repo's components have been
copied into `frontend/src/configEditor/` and re-wired against the running
backend instead of the File System Access API. Reachable from the gear-icon
SettingsModal → **Open config editor…** as a full-screen overlay.

**Endpoints:**

- `GET /api/config` → `{ config: <parsed JSON, comments stripped>, sourcePath }`
- `PUT /api/config` → atomic tmp+rename write of the body. Backend does NOT
  call `reloadConfig()`; the operator must `Ctrl+R` (TTY), click
  **Settings → Controls → Reload config**, or `POST /api/config/reload` to
  apply. `200 { ok: true, applied: false }`.
- `POST /api/config/reload` → fires the same `reloadConfig()` closure as
  `Ctrl+R`. Returns `{ ok: true, sourcePath, offsetEntries }` on success,
  `409 { ok: false, error: 'reload already in progress' }` if one is already
  running, `500 { ok: false, error }` on parse/IO failure. The UI button is
  arm-gated in the Controls section and shows the result inline as
  `idle / reloading… / ok ✓ / error: <msg>`, auto-clearing after 3 s.

**One reload path, two triggers:** Both Ctrl+R and the HTTP endpoint go
through the same `reloadConfig()` closure in `backend/src/index.ts`. Any new
config-derived state added to that function is automatically picked up by
both triggers — do not split the logic.

**Why write-only:** A Save mid-show would otherwise re-init the StageLinq
bridge / Art-Net worker by surprise. The runtime freewheel knob in the
Settings modal (`PUT /api/global-settings/freewheel`) is the live-knob path
and stays unaffected.

**Freewheel race when both UIs are open:** The editor wins on Save —
`PUT /api/config` overwrites whatever freewheel value is on disk with the
editor's. The cog modal's freewheel toggle is still live in memory until
Ctrl+R; the on-disk value and runtime value diverge until reload. Documented
behaviour, not a bug.

**Editor location:** `frontend/src/configEditor/` (no new workspace). CSS is
fully scoped under `.config-editor-root` to prevent leakage into the webview
chrome. The editor's `types.ts` was renamed `editorTypes.ts` to avoid
colliding with `frontend/src/types.ts`. Migration helpers (`migrateConfig`,
`orderedConfig`, `orderedEntry`, `serializeConfig`) lifted verbatim — they
remain the single source of truth for config diff-cleanliness.

**Status of standalone repo:** `stagelinq-config-editor` is now redundant.
Keep the repo around for archive but consider it deprecated.

### 2026-06-18 — Auto deck-suggestion (UI tag, blinking artwork, OSC out)

**What:** The backend now emits a `suggestedDeck: DeckNumber | null` field on
every snapshot. It is the deck the operator is advised to switch to next; it
never overrides the manual sACN CH1 selection.

**Triggers** (either fires; both require: candidate has the playlist's "next
track" loaded, no loop active on the candidate, candidate ≠ selected deck):
- **A** — candidate deck `play === true`.
- **B** — selected deck `play === false` AND candidate has the next track
  loaded. ("Stopped" is just `play=false` per Q1 ruling — paused mid-mix
  triggers it; the operator avoids that mistake live.)

Common gates: active playlist resolves a non-null `computeNextTrack(...)` for
the selected deck's current file, and exactly one (or, on a tie, the playing
one wins; otherwise lowest deck number) deck holds that filename. All
implemented in `computeSuggestedDeck` in
[backend/src/index.ts](backend/src/index.ts), keyed off the same
`normalizeTrackName` helper that backs offsets/notes.

**OSC fan-out:** OSC dispatch is gated by a new sACN execute channel
(`control_input.execute_address`, default 3, env `SACN_EXECUTE_ADDRESS`). On
the **rising edge** of that channel above 127 (≤127 → >127), the sACN packet
handler in [backend/src/index.ts](backend/src/index.ts) sends one
`/cmd "sugDeck_<n>"` for whatever `currentSuggestedDeck` holds at that
instant. Held-high does nothing until the value drops back ≤127. If no
suggestion is active when the edge fires, it's logged and ignored.
Implementation reuses `OscBpmSender` via a new `sendCustomCommand` method
([backend/src/oscBpm.ts](backend/src/oscBpm.ts)) so we keep one socket / one
config block. The snapshot loop publishes the latest suggestion to a
closure-scoped `currentSuggestedDeck` variable each tick; the sACN handler
reads it.

**Edge tracker init:** `lastExecuteHigh` starts as `true` so a packet that
arrives already-high (re-subscribe mid-show, console sitting on >127) does
NOT count as a fresh edge — only a transition through the threshold fires.

**No automatic OSC.** Earlier iteration of this feature emitted
`sugDeck_<n>` on every change of the suggestion; that's been replaced by the
operator-confirmation flow above. The UI still reflects suggestions live
(header pill, blinking artwork) regardless of whether CH3 is fired.

**Manual deck-select unchanged.** The execute channel does not touch
`selectedDeck`. CH1 (`control_input.address`, default 1) keeps mapping
0–101 / –152 / –203 / –255 to decks 1/2/3/4 exactly as before.

**Frontend:**
- `App.tsx` carries `suggestedDeck` state, threads it to
  [HeaderBar.tsx](frontend/src/HeaderBar.tsx) (new `SUGGESTED DECK` pill, sits
  next to the selected-deck badge in the suggested deck's accent color) and
  [DeckCard.tsx](frontend/src/DeckCard.tsx) (new `art--suggested` outline +
  `.artChangeOverlay` blinking "Change Deck" overlay covering the artwork at
  1 Hz via `@keyframes artChangeBlink`).
- The overlay clears the moment the suggestion goes away or moves — React
  unmounts it on the next snapshot.

**Logging:** every suggestion change emits a `[DECK SUGGEST]` line via
`logLifecycle` with the trigger reason ("next-track deck playing" or
"selected deck stopped, next track pre-loaded"), or "cleared" on the falling
edge.

**Why:** automates the operator's "the next track just dropped on deck N,
switch the timecode/lighting focus over there" chore. Suggestion only — the
lighting console is still the authority on which deck is live.

---

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

**Per-user opt-out:** the popup is gated by the `showTrackNotes` field in
`UserSettings` (default **off** for everyone except users whose `role`
resolves to `"DJ"`, where it defaults on). Surfaced as a toggle in the User
Settings section of [SettingsModal.tsx](frontend/src/SettingsModal.tsx).
Persists per-user via the existing `users.json` round-trip — flipping it off
cancels any pending timer and dismisses any visible popup; flipping it back
on does not retroactively pop a note for an already-loaded track (the
active fileName is marked seen so the next *load* is the next surface).
**Important:** an explicit `showTrackNotes` value (set the moment the user
toggles it) always wins over the role-derived default — so a DJ who turned
the popups off stays opted-out across page reloads.

**Roles:** `UserSettings.role` is one of the fixed strings `"Viewer"`, `"DJ"`,
or `"Lighting & Tech"` (default `"Viewer"`). The user can pick from these
three in the User Settings modal. Adding a *new* role still requires a code
change — the union lives in [frontend/src/userSettings.ts](frontend/src/userSettings.ts)
and is the source of truth for both the picker options and the
`effectiveRole`/`effectiveShowTrackNotes` lookups. Backend `UserSettings` is
an open bag (`[key: string]: unknown`), so no schema migration was needed.

**Role-derived keys + reset:** the list of fields whose default depends on
the role lives in `ROLE_DERIVED_KEYS` (today: `['showTrackNotes']`). The
"Reset to {role} defaults" button in SettingsModal patches all those keys to
`undefined`, and `updateUserSettings` honors `undefined` by **deleting** the
key from the persisted object — so the field falls back to whatever its
role-derived default returns. Adding a new role-driven setting in the future
is one line in `ROLE_DERIVED_KEYS` plus the corresponding `effective*`
helper. Settings without a role default (e.g. `detailZoomSec`) are not
touched by the reset.

---

### 2026-06-17 — `mashup_only` flag on playlist entries

**What:** Each entry in `playlists[].content[]` may carry an optional
`mashup_only: boolean` field. When `true`, the entry is an overlay (vocal stem,
mashup top-line) that is only ever played on top of another track and never
played standalone.

**Backend semantics — treat the entry as if it were not in the playlist at all:**
- [`buildTrackOffsetMap`](backend/src/index.ts) skips it → its
  `offset_sec`/`offset_frame` never apply, even if the deck loads it.
- [`buildTrackNoteMap`](backend/src/index.ts) skips it → no track-note popup
  fires when a mashup loads, even if the operator hand-edited a `note` block
  onto a flagged entry (the in-app editor disables note input for mashup rows,
  but the backend enforces the invariant independently).
- [`buildActivePlaylistFileSet`](backend/src/index.ts) skips it → the file is
  not "in the active set", so waveform extraction follows the same rule as a
  track outside the playlist (runs only when `waveform.all_tracks === true`).
- [`computeNextTrack`](backend/src/index.ts) filters mashups out of the
  playlist before doing any cursor work: a flagged track yields `pos = -1`
  (so it can never be the "current track" anchor), and lookahead skips
  flagged candidates. The same path feeds `computeSuggestedDeck`, so the
  auto deck-select feature inherits this behavior — no suggestion ever
  fires while a mashup is the currently-selected track, and no mashup is
  ever proposed as the next deck.

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
