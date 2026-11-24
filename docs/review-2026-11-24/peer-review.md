# Final read-only peer review

Reviewed root changes in backend/src/jsonFile.ts, globalSettings.ts, userSettings.ts, httpUtils.ts, sacnControl.ts, full index.ts diff and relevant surrounding source; reviewed backend/test/serverSupport.test.mjs, serverIntegration.test.mjs and helpers/serverFixture.mjs. Cross-read Replay/stateProvider and worker API contracts where required. No repository edits made. Three concrete blockers found:

## PR-01 — P1 — Large legitimate waveform frame causes a permanent reconnect loop — FIXED
- Source: backend/src/httpUtils.ts:9–15, constants.ts:124 (8 MiB), index.ts:1311–1318 cached media replay on every connection.
- sendWsFrame compares bufferedAmount + the entire next frame size to 8 MiB, so a single frame larger than 8 MiB terminates even a completely empty, healthy connection. On reconnect the same cached waveform is sent again, terminating forever. Frontend long-waveform render fixes cannot help because the frame never arrives.
- Executed actual compiled helper with realistic waveform normalization: 720000 peaks (one hour at 200/sec), peak[i]=(i%32767)/32767. JSON frame is 13,874,298 bytes; bufferedAmount=0; send count=0, terminate count=1. Similar failures begin around 37 minutes for these values. Mapped backup audio is gated but ordinary long mixes and cached tracks are still valid.
- Applied: per-socket serialized outgoing queue sends one frame until its ws.send callback completes. A valid oversized media frame is allowed on an empty healthy socket; later frames wait instead of comparing the active media against the old 8 MiB threshold. Queued snapshots coalesce to the latest. Waiting shared string references are bounded to 128 frames and 128 MiB, plus one active media frame; a 30-second send deadline disconnects stalled consumers. Close/error paths clear queued references and timers. Callsites keep sendWsFrame(ws, frame).
- Validation: realistic 13.87 MB one-hour waveform, four initial media frames, and 100 pending snapshots drain to all four media plus only snapshot 100 without disconnecting. Regressions also cover frame-count/byte overflow, unrelated socket backlog, send callback failure, socket close and stalled-send deadline. Backend tsc build and all 16 serverSupport tests pass (including the root concurrent-reload fix test).

## PR-02 — P2 — Reload reads old freewheel config before pending PUT finishes, then resets runtime to stale value — FIXED
- Source: backend/src/index.ts:432,447–449; backend/src/globalSettings.ts:67–70,74–85.
- Reload reads config outside the GlobalSettingsStore queue. Its reset is queued after pending setFreewheel writes, but the reset value was captured before those writes commit. This guarantees stale runtime restoration for this interleaving: duration30; start PUT90 and pause its disk write; reload reads30; enqueue reset30; PUT commits90/responds; queued reset sets cache30 and root pushes30 to worker. Disk remains90, GET/worker return30 despite successful PUT.
- Reproduced with actual compiled GlobalSettingsStore and gated fs.writeFile. Final output: disk max_duration_sec=90, runtime max_duration_sec=30.
- Fix: serialize the reload read and store reset together with the entire settings mutation sequence, or expose a queued reload-from-disk method that reads only after prior writes settle and returns that parsed config for runtime application. Do not merely queue reset around a value read earlier. Add a PUT-vs-reload overlap test.

## PR-03 — P1 — Leaving replay restores offsets without restoring worker deck/timing cache — FIXED
- Source: backend/src/index.ts:1257–1259 and 1354–1366; replay.ts:254–262 / 273–277.
- During replay all live bridge pushes are suppressed. When replay is disarmed/detaches, snapshot code restores live offsets but pushes deck states only while replay.isOverridingOutputs(). The worker still holds replayed play/elapsed/file/timing until each live deck happens to publish a later mutation. Paused/unloaded or disconnected decks may not publish, so the worker can emit/freewheel replay data combined with live offsets while WS/OSC already display live state.
- Executed the actual snapshot integration block twice with stub stateProvider/worker: first replay-playing/play=true, then live-paused/play=false. After second tick worker still has replay-playing/play=true while its offsets have switched to the live map. This is a direct integration-state mismatch, independent of timing algorithm internals.
- Fix: track replay override/session transitions and on exit push all current live bridge decks and SourceTiming values (and live offsets) together before emitting another worker tick. Also consider the brief interval between bridge callback detachment and next 30 Hz offset switch: avoid live states being interpreted with replay offsets. Prefer an explicit mode/atomic source-switch worker message or a coordinated full-state rebase. Test disarm/detach with no subsequent bridge mutation.

## Other reviewed behavior

No additional blocker found in per-path JSON write serialization/temp-name uniqueness, rejection propagation into Express, user-settings commit-after-persist behavior, exact sACN raw-buffer channel indexing and off band, or recorder shutdown ordering covered by integration test. Validation currently checks config structural types, not all ranges; that remains already-documented audit scope rather than a new peer-review finding.

The existing serverSupport tests cover plain writer ordering and invalid files, but not reload/read-vs-write overlap or a single oversized media frame. serverIntegration verifies recording footer/metadata on SIGTERM with isolated bridge/network outputs; it does not exercise replay-to-live worker source transition. Parent should add the above regression cases alongside fixes before final build/test/commit.


## Final integration resolution

All three blockers are resolved before the audit commit.

- PR-01: serialized sends, snapshot coalescing, pending queue limits and deadline; realistic four-frame large-waveform regression passes (see implementation note above).
- PR-02: GlobalSettingsStore.reload reads through the shared file queue and applies config inside the settings operation queue. A gated-write regression verifies disk, runtime cache and applied setting all end at 90 rather than stale30.
- PR-03: artnet.setSource atomically replaces all four deck states/timings/offsets and resets the worker timeline. makeArtNetSourceSync detects transitions at disarm, track callbacks, bridge publication and snapshots. Tests cover disarm with no later bridge events, provider-triggered activation, and the actual mocked worker returning to a paused/null-timed live source.

The original findings above preserve the review evidence; they are not outstanding blockers.
