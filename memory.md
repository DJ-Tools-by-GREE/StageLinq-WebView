# Project memory — StageLinq WebView

Active architectural decisions and known quirks. Update **immediately** on any
decision/bug-confirmation/direction change (per CLAUDE.md).

---

## Architectural decisions

### 2026-06-19 — Offline timecode simulator (TC analysis addon)

**What:** Standalone read-only script at [backend/src/scripts/simulateTimecode.ts](backend/src/scripts/simulateTimecode.ts), wired as `npm run -w backend simulate-tc -- <recording.jsonl>`. Reads a Record & Replay `.jsonl`, reconstructs all four `DeckState` timelines from keyframes + diffs, then runs **one Art-Net-worker tick loop per deck in parallel** — each deck simulated as if it were continuously sACN-selected — and writes a single self-contained HTML page with an inline SVG overlay of every deck's hypothetical TC, plus a JSON analysis blob.

**Why "hypothetical per deck", not "follow recorded selectedDeck":** the live worker only emits TC for whichever deck is sACN-selected; in a recording, that's mostly one deck at a time, so a graph of recorded TC is mostly silent gaps. The analytical question we actually want to answer post-show is "where would each deck's TC have landed at any moment?" — which catches mis-set per-track `offset_seconds`, freewheel triggers, drift-snaps, and TC clamps that *would* have been visible if that deck had been the selected one. The actual sACN selection is still rendered as a colored bar under the plot for cross-reference.

**TC fidelity:** the script is a line-for-line port of [backend/src/artnetWorker.ts](backend/src/artnetWorker.ts) `doSend()`. Same `timelineFrames` state machine, same `treatAsPlaying` with stale-coasting, same drift-snap at 15% of one frame (only when not stale), same monotonic guard, same 80 ms latency comp, same clamp to `floor(totalSec * fps) - 1`. The freewheel-stale check uses the same logic — derived per-tick from "no fresh deck event globally for > `stale-ms`" — instead of a `lastBeatAtMs` since the script doesn't have a live beat stream.

**Why a single SVG, not a JS chart lib:** zero new deps (this is the project's first script that produces user-facing artifacts), portable across browsers, no offline-vs-online concerns, opens fine on a phone next to the booth. ~3000 chart points per deck after decimation keeps the page under 500 KB even on a 70-minute show.

**Track offsets resolution priority:** (1) the recording's own header `trackOffsets` block (it's a snapshot of what was active at recording start, the most accurate source for replaying that show); (2) `--config <file>` if passed; (3) auto-detected `config.json` at cwd. Prevents the common confusion of "I edited offsets after the show, why does the simulator show the new ones?".

**Verification:** smoke-tested on `recordings/2026-06-18T20-32-59-281Z.jsonl` (72 min, 159 637 deck events, 23 sACN flips). Output: deck 1 emitted 81 645 packets / 4254.6s span / 177 drift-snaps, deck 2 71 569 / 4063.8s / 205 snaps, deck 3 unused (one load, never played → 0 emits, 0 freewheel — correct), deck 4 7 745 / 329.9s / 30 snaps. HTML 375 KB, JSON 14 KB. Drift-snap counts come out elevated because the simulation ticks at exactly the same `tickHz` as the recording's diff cadence, so source/timeline alignment is essentially perfect — drift-snaps in this output should be read as "rare boundary events" (track loads, deck flips) not "show stability" — matches expectation.

**Why `--out` defaults next to the input** (not under a `tc-analyses/` dir): the project doesn't have a convention for analysis artifacts, and operators are likely to want the HTML in the same folder as the `.jsonl` they're investigating. If we accumulate more analysis tools, that folder convention can come later.

---

### 2026-06-19 — Art-Net pump-in-worker (TC immune to main-thread stalls)

**What:** The Art-Net worker now owns the **entire timecode pipeline**, not just the UDP send. It holds the 30 Hz tick timer, the deck-state cache for all 4 decks, the `selectedDeck` pointer, the per-track offset map, and the freewheel-stale derivation. The main thread no longer runs a polling pump — it just **pushes state changes** to the worker as they happen.

**Why:** the prior architecture (worker for the send loop only, main thread polled `stateProvider.getDeck()` at 30 Hz and posted to the worker) was still vulnerable to any main-thread stall: if `pumpDeckState()` couldn't run for ≥ 33 ms, the worker's `lastBeatAtMs` didn't refresh and freewheel kicked in, then snapped back when the pump caught up. We saw three classes of stall in production:

1. **Large StageLinq downloads.** `bridge.downloadFile()` runs `getFile()` over the StageLinq library's TCP socket on the main thread. For audio files (3–10 MB) this is ~500 ms; for the 100+ MB `.mp4` that the operator loaded one evening, it produced 7 minutes of continuous 200–500 ms event-loop lag. The downloads can't be slowed down (the library doesn't expose backpressure on `getFile()`), can't move to a worker thread (they share the StageLinq TCP socket with `beatMessage` traffic — head-of-line blocking is at the protocol layer, not Node's CPU). The right fix is to make the timecode pump *not care* what main is doing.
2. **sACN deck flips.** Each `selectedDeck` change rebases the source deck (different `elapsedSec`, different per-track offset). Under the old design, the next pump tick posted the new deck's frame, and the worker's drift snap re-aligned timeline → source — emitting one bad frame at the boundary. The lighting console flagged that as a TC jump.
3. **Recorder writes / WS broadcasts / GC pauses.** Sub-50 ms stalls are below the warning threshold but still drop a tick or two.

**Architecture after the change:**
- [backend/src/artnetWorker.ts](backend/src/artnetWorker.ts) holds: `decks: Record<DeckNumber, DeckState | null>`, `selectedDeck`, `trackOffsets`, `lastBeatAtMs`, `reconnecting`, the freewheel timeline, and the self-correcting tick deadline. On every tick it computes `stale = reconnecting || (now - lastBeatAtMs) > FREEWHEEL_STALE_THRESHOLD_MS` itself — main no longer derives that flag.
- [backend/src/artnetWorkerMessages.ts](backend/src/artnetWorkerMessages.ts) exposes new message types: `setSelectedDeck`, `setTrackOffsets`, `pushDeckState`, `pushAllDeckStates` (replay path), `beatPulse`, `setReconnecting`. `pollDeck` and the old "pull from main" model are gone.
- [backend/src/artnetTimecode.ts](backend/src/artnetTimecode.ts) is a thin push API: no `setInterval`, no main-thread timer, no `pollDeck` closure. Just `setSelectedDeck()`, `setTrackOffsets()`, `pushDeckState()`, etc.
- [backend/src/index.ts](backend/src/index.ts) wiring:
  - `bridge.subscribeDeckState((deck, state) => artnet.pushDeckState(deck, state))` — every bridge mutation forwards to the worker. While replay overrides outputs, this listener short-circuits.
  - `setSelectedDeck()` helper now also calls `artnet.setSelectedDeck()`. The worker resets `timelineFrames`/`lastTickMs` on the boundary so the new deck rebases cleanly without the drift snap firing on the boundary frame.
  - `reloadConfig()` calls `artnet.setTrackOffsets(buildTrackOffsetObject(trackOffsets))` so the new offsets take effect on the worker's next tick (no race with the live show).
  - `onCommunicationLost` calls `artnet.setReconnecting(true)`/`(false)` around the reconnect loop, so the worker engages freewheel immediately rather than waiting `FREEWHEEL_STALE_THRESHOLD_MS` for its own derivation to trip.
  - Snapshot-loop replay path: when `replay.isOverridingOutputs()`, the synthesized 4-deck state is pushed via `artnet.pushAllDeckStates(decks, true)` (the `bumpBeat: true` flag keeps `lastBeatAtMs` fresh because the audio-deck-elapsedSec replay clock is the source-of-truth for "is the show still moving").
  - On startup, before the first tick, we seed the worker with `bridge.getDecks()` (blank-deck values) so it doesn't have to wait for the first state mutation to resolve a (silent) source deck.

**Why a clean rebase on selectedDeck flip:** the worker's `setSelectedDeck()` deliberately nulls `timelineFrames` and `lastTickMs`. Without that, the next tick's `dtSec` calculation would use the previous deck's source position, then drift-snap to the new one — emitting one bad frame at the boundary value (which the lighting console flags). With the reset, the next tick sees `timelineFrames == null`, takes the new source frame on the spot, and starts fresh.

**The drift-snap suppression while stale is the linchpin.** Whenever any class of main-thread stall happens, the worker tips into stale (no fresh `pushDeckState`/`beatPulse`), freewheels at the last-known speed, and on resume — when main pushes catch-up state — exits stale. `doSend` skips the drift snap during stale, so the timeline keeps advancing from where freewheel left it instead of snapping to the catch-up source frame. The lighting console sees one continuous TC stream regardless of how long main was blocked.

**Cost of the change:** every bridge state mutation now costs one structured-clone postMessage (DeckState is ~20 fields, mostly numbers). That's a few µs per call, swamped by everything else the bridge does on the same hot path. The `pushAllDeckStates` call is one per 33 ms during replay — same scale.

**Verification (smoke-boot):** worker reports `[ArtNet/wk] ready: ... (target interval 33.333ms, stale=250ms)` with the pump-in-worker note in lifecycle. Steady-state heartbeat: `avg=33.34ms p50=33.0 maxBehind=1.7ms hardStalls=0`. No regressions on the existing freewheel/flap detector path or the replay-override path.

---

### 2026-06-19 — sACN 0–50 explicitly deselects (TC silent)

**What:** [`mapDmxToDeck`](backend/src/index.ts) now returns `null` for DMX
values ≤ 50, matching the documented "off" band in
[CLAUDE.md](CLAUDE.md). Previously 0–101 all selected D1, so there was no way
to deselect without unplugging sACN. The Art-Net poll lambda already converts
a null `selectedDeck` into `{ deck: undefined, stale }` — the worker sees a
null `currentDeck` in `doSend()` and skips the UDP packet entirely, so timecode
goes silent on the receiver immediately.

**Worker timeline reset on deselect:** [`updateDeck`](backend/src/artnetWorker.ts)
now also clears `timelineFrames` and `lastTickMs` when a non-stale `null` deck
arrives. Without this, a later reselection would compute a multi-second `dt`
on the first tick, jump the freewheel timeline, then drift-snap back — emitting
one wrong TC packet at re-engagement. With the reset, reselection starts
cleanly from the source `elapsedSec`. The stale path is unchanged (it keeps
the last-good snapshot for freewheel continuity, as designed).

**Why:** the operator needs an explicit "no deck selected" sACN value so the
lighting console can pause TC at section breaks without hard-disconnecting.

---

### 2026-06-19 — Waveform/artwork pipeline moved to a worker thread

**What:** ffmpeg invocations (peaks + artwork extraction), `computePeaks` PCM scan, JSON serialization of the peaks array, base64 encoding of the artwork, and waveform/artwork disk-cache I/O **all run in a dedicated worker thread** ([backend/src/waveformWorker.ts](backend/src/waveformWorker.ts)). The main thread is reduced to: StageLinq audio download (must stay on main, FileTransfer service binding lives there) → zero-copy `postMessage` of the audio `ArrayBuffer` into the worker → fan-out of pre-built WS frame strings on the way back. Pattern mirrors [backend/src/artnetWorker.ts](backend/src/artnetWorker.ts).

**Why:** during a track change, the main thread used to block 200 ms–1.3 s on ffmpeg + computePeaks + JSON.stringify(peaks) + base64(artwork) + disk writes. The 30 Hz Art-Net deck-state polling pump (see [backend/src/artnetTimecode.ts:121](backend/src/artnetTimecode.ts#L121)) lives on the main thread; missed pump ticks meant the Art-Net worker freewheeled, then snapped back to a stale-then-fresh source frame on resume — the **drift-snap** at [backend/src/artnetWorker.ts:262](backend/src/artnetWorker.ts#L262) (`drift > 0.15 fps` ≈ 5 ms @ 30 fps) caused visible TC jumps on the lighting console. Cached-track jitter was smaller because it skipped ffmpeg, but the 30–60 ms `JSON.stringify(peaks)` on every broadcast was still enough to drop a couple of pump ticks.

**Cache shape change — pre-serialized WS frames:**
- New: `peaksFrameCache: Map<string, string>` and `artworkFrameCache: Map<string, string>` hold the **complete `ws.send`-ready** JSON frame strings.
- Retained: `artworkCache: Map<string, { data: Buffer; mime: string } | null>` for the HTTP `/api/artwork/:deck` route.
- The old `peaksCache: Map<string, number[]>` is gone — broadcast paths look up the pre-built string and `ws.send` it. Zero CPU on the broadcast path, regardless of cache-hit or post-extraction.

**Boot-time cache load** runs in the worker too. Worker scans `waveform-cache/` and `artwork-cache/`, builds the WS frame strings, and replies with a single `cacheLoaded` IPC message that transfers all artwork bytes back to the main thread (zero-copy). After boot the main thread does no waveform-related disk I/O at all.

**WS wire shape change:** `WaveformDataPayload` no longer carries `deck` ([backend/src/types.ts](backend/src/types.ts), [frontend/src/types.ts](frontend/src/types.ts)). The frame is keyed only by `fileName`; the frontend ([frontend/src/App.tsx](frontend/src/App.tsx) `waveform_data` handler) fans the peaks out to every deck currently holding that file (via `latestDecksRef`). Side-benefit: the same track on two decks now renders correctly without the backend having to broadcast twice. `ArtworkDataPayload` already had no `deck` field, so it was already shape-correct.

**IPC contract:** [backend/src/waveformWorkerMessages.ts](backend/src/waveformWorkerMessages.ts). Audio bytes ride into the worker as a transferred `ArrayBuffer`; artwork bytes ride out the same way. Worker dedups same-fileName concurrent requests via an internal `inFlight` map (same semantics as the previous in-process `inFlight` in waveformService.ts).

**Per-deck cancellation:** `waveformTaskIds` in [backend/src/index.ts](backend/src/index.ts) still gates whether the *broadcast* fires when the worker's result arrives. The worker is not interrupted — its job is short and its result populates the cache regardless, which is strictly fine because the cache key is fileName.

**Replay & playlist gates unchanged:** `replay.shouldSuppressWaveformExtraction(fileName)` and the `waveformAllTracks`/`activePlaylistFiles` gates in `onTrackChanged` still fire before any worker IPC.

**Signal handling:** SIGINT/SIGTERM in [backend/src/index.ts](backend/src/index.ts) call `shutdownWaveformWorker()` (50 ms drain then exit) alongside the existing OSC/sACN cleanup.

**Verification:** during track changes, `[main] event-loop lag` warnings should be rare/absent and `[ArtNet/wk] Late tick` / `hardStalls` should stay at 0 across both cached and uncached track loads. The lighting console should no longer flag TC jumps on track change.

---

### 2026-06-19 — Freewheel threshold decoupled from disconnect threshold

**What:** [backend/src/index.ts](backend/src/index.ts) now derives the `stale`
flag from a new `FREEWHEEL_STALE_THRESHOLD_MS = 250` constant (in
[backend/src/constants.ts](backend/src/constants.ts)) instead of reusing
`DISCONNECT_DETECT_TIMEOUT_S * 1000` (= 2 s). The two thresholds answer
different questions:

- `FREEWHEEL_STALE_THRESHOLD_MS` (250 ms) — "is the next beat overdue, freewheel
  now". Sized to be just past steady-state max beat gap (50–200 ms; observed
  outliers up to ~245 ms in clean sessions).
- `DISCONNECT_DETECT_TIMEOUT_S` (2 s) — "is the device gone, time to flip the
  red badge and trigger `bridge.disconnect()` + reconnect loop". Stays at 2 s.

**Why the bug:** at the old 2 s threshold the lighting console saw TC stall
for up to two seconds during a brief beat dropout, then resume freewheeling
~1–2 s behind the audio. Tightening the trigger to one missed-beat window
keeps TC continuously aligned without changing the more expensive reconnect
machinery's hysteresis.

**Why the worker logic didn't need changes:** existing
`treatAsPlaying = deckIsStale ? lastTickMs !== null : deckState.play === true`
already correctly handles all the "don't freewheel" cases —

- **Pause** while connected: `Play=false` arrives in ~10 ms, the next worker
  tick (≤33 ms later) hits the stopped branch and clears `lastTickMs` BEFORE
  the 250 ms stale window can flip on, so subsequent stale ticks see
  `lastTickMs == null` and stay silent.
- **Track end:** same path as pause.
- **Watchdog late `play=false` mid-stall** (cable was actually pulled, not a
  pause): worker is already in the freewheel branch with `lastTickMs` set,
  ignores the stale watchdog signal — exactly correct.

So only the constant + import in `index.ts` moved; the worker is unchanged.

**Tuning note:** if the field reports rare false-positive freewheel
engagements on healthy networks (single ~33 ms tick of freewheel timeline
during a 250–300 ms beat outlier), bump `FREEWHEEL_STALE_THRESHOLD_MS` to
`400`–`500`. Don't drop it below ~220 ms or it will flap on every clean
session (steady-state inter-beat intervals are 50–200 ms).

---

### 2026-06-18 — Per-user deck layout toggle (2 vs 4 decks)

**What:** Users can pick between the original 4-deck 2×2 grid (default) and a 2-deck side-by-side layout that renders only D1 and D2. Lives in the user-scoped Settings modal, persisted via the existing `users.json` round-trip (new `deckLayout: 2 | 4` field on `UserSettings`). 4 is the default for any user without an explicit choice — all current users keep their existing view.

**Architecture:**
- `frontend/src/userSettings.ts` adds `DECK_LAYOUTS = [2, 4]`, `DeckLayout` type, `DEFAULT_DECK_LAYOUT = 4`, an `effectiveDeckLayout()` helper, and the `deckLayout?` field on `UserSettings`. Backend is open-ended (`UserSettings = Record<string, unknown>`) so no backend change is needed — the field just appears in `users.json` once a user picks a value.
- `App.tsx` derives `visibleDecks` (`[1,2]` or `[1,2,3,4]`) and applies a `grid--2` / `grid--4` class so CSS can switch templates. Backend keeps emitting all four deck states; the 2-deck view is purely a render filter on the client. Backend output paths (Art-Net, OSC, sACN) are unaffected — they read from `stateProvider`, not the UI.
- `styles.css` `.grid--2` overrides to `grid-template-columns: 1fr 1fr; grid-template-rows: 1fr;` (full-height side-by-side); `.grid` (and `.grid--4`) keep the original 2×2.

**Why a render filter, not a backend gate:** the deck-selection sACN channel still needs to accept D3/D4 even when the operator picked the 2-deck UI; lighting console must remain authoritative. Hiding the UI cards is the right level — the user's choice does not lie to the rest of the system.

### 2026-06-18 — In-app terminal panel (live backend log stream)

**What:** Header has a chevron-prompt icon next to the gear; clicking unfolds a panel below the header that mirrors the backend's per-event log lines (lifecycle, playback, errors, …). Only newly printed lines are shown — the static dashboard rows that take over the bottom of the TTY (`logDashboard`) deliberately bypass the tap, since "the static line" is exactly what the user did NOT want to see in the browser.

**Architecture:**
- `backend/src/logging.ts` — every call to `printLog()` (which already funnels every per-event log) also pushes a stripped (ANSI-removed) entry into a small ring (`TERMINAL_RING_MAX = 500`) and notifies any subscribers. Dashboard rendering happens through `logDashboard()` and is unaffected.
- `backend/src/index.ts` — per-WS opt-in. Client sends `{type:'terminal_subscribe', enabled:true|false}`. Backend keeps a `Set<ws>` of subscribers; the global tap is attached lazily on the first subscribe and released when the set empties. New subscribers are seeded with the ring as a `terminal_lines` `replace` frame; subsequent lines stream as `append` frames.
- `frontend/src/TerminalPanel.tsx` + `App.tsx` — opens on toggle, sends `terminal_subscribe`, renders up to 1000 lines with auto-follow scroll. Re-subscribes on WS reconnect if still open.

**Performance posture:** when no client is subscribed, the cost per log line is one Set-size check (always `0`) and one O(1) ring push. The 30 Hz dashboard never enters this path. When subscribed, each line pays one ANSI-strip + one JSON.stringify + one `ws.send` per subscriber — at the natural rate of these logs (sparse, bursts on track change) this is well below the existing 30 Hz snapshot loop's cost. No new timers.

### 2026-06-18 — Record & Replay (backup-show fallback)

**What:** Operator can record every state change the StageLinq bridge produces during a live show into a JSONL log under `recordings/`, then later replay that log synchronized to a single prerecorded audio file played on a deck. From the lighting console's perspective the replay is byte-identical to the live show — same Art-Net timecode, OSC, WS UI — and the console keeps full live control of `selectedDeck` (sACN CH1) regardless of what was recorded.

**Architecture:** Recording happens at the **bridge output boundary** — every call to `bridge.touch(deck)` notifies registered listeners ([backend/src/stagelinqBridge.ts](backend/src/stagelinqBridge.ts) — new `subscribeDeckState()` / `DeckStateListener`). The recorder ([backend/src/recorder.ts](backend/src/recorder.ts)) maintains per-deck "last emitted" snapshots and writes either a full `state` keyframe (on track change / session start) or a field-level `diff` to JSONL. selectedDeck transitions are recorded from `index.ts` callsites since they are not bridge state.

A new shim ([backend/src/stateProvider.ts](backend/src/stateProvider.ts)) sits between the bridge and the three output paths (Art-Net poll, OSC poll, WS snapshot loop). When replay is overriding outputs, all four decks come from the replay engine ([backend/src/replay.ts](backend/src/replay.ts)) — including the audio playback deck, whose real state is hidden from the console. When idle, stateProvider passes through to the bridge.

**Replay clock:** the audio deck's sample-accurate `elapsedSec` (not wall-clock). Pause / scrub / pitch on the audio deck drag the replay timeline along automatically. Dropouts >250 ms force `play=false` on all simulated decks, then the existing Art-Net worker freewheel handles the silence. End-of-log holds all decks `play=false` and lets the console see a clean stop.

**Track-changed waveform suppression:** Mapped audio files (the long backup-set wavs) are gated out of the waveform/artwork extraction path in `onTrackChanged` regardless of replay state — they're large and useless to scan.

**Filename matching:** uses `normalizeTrackName()` (basename, case-sensitive). Same rule as playlist offsets.

**REST endpoints:** `POST /api/record/start|stop`, `GET /api/record/status`, `GET /api/recordings`, `POST /api/replay/arm|disarm`, `GET /api/replay/status`. Mappings live in `config.json` under `recordings: [{ audio_file, log_file }]`. The config editor has a new "Recordings (Replay)" section with a dropdown of available logs from the recordings dir.

**Storage:** JSONL + `.meta.json` sidecars in `<repo-root>/recordings/`, gitignored. Full event rate (no throttling).

**Invariant:** all output paths read from `stateProvider`, never `bridge` directly. The waveform extraction code path is the only exception (it asks the real bridge for `totalSec` of the deck currently being downloaded — fine, since mapped audio files are gated out before that path runs).

### 2026-06-19 — Record & Replay: crash-recovery resume

**What:** If the backend dies mid-recording (crash, kill -9, power cut), the next start picks up where the previous run left off. Once `stagelinqStatus` flips to `'connected'` (handled in the snapshot-loop status-edge block), the recorder reopens the file in append mode and writes a `gap` event (`crashedAtWall`, `resumedAtWall`, `gapMs`) followed by fresh keyframes for all four decks, then continues normal recording.

**Resume gating via lock file (2026-06-19 revision):** the recorder writes `recordings/.active-recording` on `start()` (contents = active `.jsonl` basename) and deletes it on clean `stop()`. On boot, the lock's presence is the *only* signal that triggers resume — stale unfinished `.jsonl` files from older shows that no longer have a lock are intentionally ignored. The previous logic of "find any orphan" was too eager: it would resume `.jsonl`s left behind by *any* prior crash, not just the most recent run. Lock-write is in `start()` after the stream is open; lock-clear is in `stop()` *after* the sidecar is written so a crash between footer-write and lock-clear self-heals (findOrphan rejects locks pointing at sidecar'd files).

**Why deferred until 'connected':** the gap marker should be paired with a real keyframe of current deck state. Resuming into a still-broken bridge (no-device / reconnecting) would write `play=false` blanks into the keyframe slot.

**Skip cases (lock self-heals):** lock points at missing/empty/sidecar'd file (clear and skip), file >24 h old (clear and skip), file has no header line (clear and skip), malformed lock contents (clear and skip), replay is currently active (skip but keep lock for next try).

**Graceful shutdown:** `SIGINT`/`SIGTERM`/`beforeExit` handlers call `recorder.stop()` first, so the sidecar gets written and the lock is cleared.

**Operator escape hatch:** `POST /api/record/resume-abort` discards a pending resume *and clears the lock* so a fresh recording can be started without the same orphan re-appearing. `POST /api/record/start` refuses with 409 while a resume is pending — the operator must explicitly choose between resume and fresh.

**Cannot recover the gap content** — the bridge has no history. The `gap` event is a forensic marker so analysis tools detect the discontinuity. `gap` event type is part of the JSONL schema; replay's parser silently ignores unknown event types so old replay engines don't break.

### 2026-06-18 — Art-Net: TC silent whenever a deck isn't moving (toggle removed)

**What:** Removed the `sendWhenStopped` toggle and its supporting plumbing
end-to-end. TC must never be emitted while the selected deck is paused — the
toggle was always-off in practice, so keeping it added live-show foot-gun
surface for no benefit.

**Removed (dead):**
- Frontend: `<button>` in [HeaderBar.tsx](frontend/src/HeaderBar.tsx), `sendWhenStopped` / `settingBusy` state, `toggleSendWhenStopped` callback, GET-on-mount and POST handlers in [App.tsx](frontend/src/App.tsx).
- Backend: `GET`/`POST /api/timecode/send-when-stopped` endpoints, `sendTimecodeWhenStopped` module var ([index.ts](backend/src/index.ts)).
- Worker harness: `setSendWhenStopped()` method, `sendWhenStopped` option/field ([artnetTimecode.ts](backend/src/artnetTimecode.ts)).
- Worker thread: `sendWhenStopped` field/setter, `setSendWhenStopped` message dispatch, **and the scrub-while-paused emission arm** along with `lastSentStoppedFrames` / `lastSentStoppedDeck` bookkeeping ([artnetWorker.ts](backend/src/artnetWorker.ts), [artnetWorkerMessages.ts](backend/src/artnetWorkerMessages.ts)).

**Preserved:** the freewheel path is unchanged. The stopped-branch in `doSend()`
collapses to "deck paused → reset `timelineFrames` / `lastTickMs` and return
without emitting a packet." A play-resume still rebases cleanly off the source
position. The 2026-06-18 deck-switch fix becomes vacuous (no packet was going
to fire on a paused deck switch anyway).

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
   instantly. Reuses the existing `.toggleBtn on/off` styles.

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
  flagged candidates.

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
`DeckState` snapshot to the worker, and forwards `setFreewheel`/`stop`
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

## Hot cue extraction (offline, not StageLinq)

Engine DJ **does not** stream hot-cue positions on StageLinq StateMap, even though the `@gree44/stagelinq` package will technically match `/Engine/DeckX/Track/HotCueN` keys. The `HotCue1..8` handlers in [backend/src/stagelinqBridge.ts](backend/src/stagelinqBridge.ts) lines 756-776 / 1113-1131 never fire on real hardware (Prime 4+ / SC6000) because the device just doesn't publish those keys. Confirmed by inspection: `DeckState.hotCues` stays `[]` from network sources alone.

The `@gree44/stagelinq` package *does* expose `FileTransfer.getFile()` and `Databases.downloadDb()`, which can pull `m.db` over the wire — but the offline path is simpler, faster (no 60 s download timeout, no FLTX handshake), works without the device powered on, and the blob format is byte-identical. So we extract from the SD card / USB drive directly.

**Tool:** [backend/src/scripts/extractCues.ts](backend/src/scripts/extractCues.ts), invoked via `npm run -w backend extract-cues`. Auto-detects `/Volumes/*/Engine Library/Database2/m.db`, the in-repo `copy of exported library/...` snapshot, and `~/Music/Engine Library/Database2/m.db`; prompts on stdin if multiple are found. Iterates every `song_index` in `config.playlists[*].content[*]` (or `--current-only`), opens `m.db` read-only, decodes `PerformanceData.quickCues` (zlib-compressed big-endian `int64` count + per-slot `u8` name-length + UTF-8 name + `f64` sample position + `u32` ARGB), writes one `<md5(fileName).slice(0,16)>.json` file to `backend/hotcue-cache/`.

**Cache key matches waveform cache:** identical stem function to `waveformStem()` in [backend/src/waveformWorker.ts](backend/src/waveformWorker.ts). A future feature that wants cues + waveform + artwork together can compute the stem once and look up all three caches.

**Standalone by design:** the script imports nothing from the rest of the backend (no StageLinq, no express, no waveform pipeline). Safe to re-run mid-show against a freshly mutated SD card. Separate `tsx` entry point, not part of the runtime backend.

The runtime backend does not yet read `hotcue-cache/` — the script builds the cache; consumption is a separate feature still to be wired up.

---

## In-progress / blockers

(none)
