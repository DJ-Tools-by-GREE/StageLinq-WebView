# Detailed frontend audit — StageLinq-WebView

Audited 2026-11-24. Scope: all 31 original files under frontend/, including every TypeScript/TSX/CSS source and build configuration. JPEG assets were inspected for format/dimensions/size, not manually judged for design. Parent owns backend integration and documentation. No StageLinq protocol implementation is duplicated in the frontend; its custom code concerns state, rendering, forms and CSV import.

Severity: P1 = can break the live display or configuration workflow; P2 = substantive correctness/performance/data-loss issue; P3 = lower-priority usability/maintenance issue. Line references below describe the pre-audit source so findings remain traceable after edits. Applied items are present in the working tree; no commits were made by this agent.

## Confirmed findings and fixes

### FE-01 — P1 — Backend restart freezes the display until its sequence catches up — FIXED
- Location: frontend/src/App.tsx:299–302; backend/src/index.ts:914,1461.
- Trigger: run the backend for an hour, restart it, leave browser open.
- Cause: lastSeq lived in a React ref across reconnects, while backend seq restarts at zero. Every new snapshot was rejected until its number exceeded the old maximum. The heartbeat was refreshed before rejection and connected remained true, so the frozen display could still say Live.
- Reproduction: actual App handler accepted seq 108000 for before.mp3, reconnected, rejected seq 1 for after.mp3. This implies roughly an hour of stale UI at 30 Hz.
- Fix applied: sequence belongs to one WebSocket connection; obsolete socket callbacks are ignored. New seq 1 immediately renders after.mp3.
- Regression: frontend/test/frontend.test.mjs backend restart test.

### FE-02 — P1 — Long waveform crashes the whole React tree — FIXED
- Location: frontend/src/WaveformDisplay.tsx:65.
- Trigger: sufficiently long track at 200 peaks/sec. Math.max(...peaks) exceeds the JavaScript engine's function argument limit.
- Evidence: actual React SSR component succeeds at five minutes / 60000 peaks, throws RangeError at eleven minutes / 132000 peaks and at fifteen/sixty minutes. Exact limit is engine-specific; no React error boundary catches it.
- Fix applied: iterative finite maximum, memoized by peaks identity; silent data uses denominator 1. One-hour / 720000-peak and all-zero data render successfully.
- Regression: long/silent waveform test and peak bins test.

### FE-03 — P1 — Valid config with omitted optional note crashes editor and display — FIXED
- Location: frontend/src/configEditor/restApi.ts:59–73,114–122; components/PlaylistEditor.tsx:236,248.
- Trigger: open the editor with a documented entry such as { song_index: 'a.mp3', offset_sec: 0 }. README explicitly allows absent note and other fields are optional in backend RootConfig.
- Cause: migration returned note-less entries unchanged while both form and serializer dereferenced entry.note.description unconditionally. Playlist content missing entirely was also retained undefined.
- Evidence: actual migrated config fails both React SSR render and serializeConfig with Cannot read properties of undefined (reading 'description').
- Fix applied: default optional entry fields, empty note, default delay and empty playlist content during migration. No operator-entered fields are overwritten.
- Regression: documented optional playlist fields test.
- Remaining input-schema validation is FE-17; this does not claim malformed arbitrary JSON is now completely validated.

### FE-04 — P2 — React StrictMode produces duplicate WebSockets — FIXED
- Location: frontend/src/App.tsx:444–467 and frontend/src/main.tsx:7.
- Trigger: standard development mount → effect cleanup → effect setup, then asynchronous close event from first socket.
- Cause: shared unmounting ref has already returned to false when the old close arrives. It schedules another connect while the replacement socket is alive. Shared heartbeat refs can then clear the wrong interval and leak the first.
- Evidence: deterministic execution of the actual effect/handlers produced three constructed sockets with two live after one StrictMode remount.
- Fix applied: cleanup detaches handlers and clears active socket; all handlers reject superseded sockets. Reproduction now constructs two sockets with one live and one heartbeat.
- Regression: StrictMode cleanup/stale close test.

### FE-05 — P2 — Saving marks newer unsaved edits as saved — FIXED
- Location: frontend/src/configEditor/ConfigEditorOverlay.tsx:75–85,111.
- Trigger: Save draft A; change another field while PUT remains pending; A's response arrives.
- Cause: completion unconditionally sets dirty=false and Saved, although local config is now draft B. Save becomes disabled and closing loses B without discard warning. Duplicate Save clicks can also overlap.
- Evidence: actual callback sequence submitted current_playlist=2, then changed local draft to 0; completion left draft 0 with dirty=false and Save disabled.
- Fix applied: revision counter only marks the submitted revision clean; one save in flight, visible Saving state. New edits remain dirty and saveable.
- Regression: edit-during-save plus duplicate-save test.

### FE-06 — P2 — Editor introduces enabled features while saving unrelated config — FIXED for confirmed divergent defaults
- Location: frontend/src/configEditor/defaults.ts:4,7,22 and restApi.ts:84–106; backend/src/index.ts:469,484,313,325.
- Trigger: load a minimal/partial config and save any unrelated field.
- Cause: editor defaults enabled OSC and sACN simulator, while backend defaults disable both; omitted current_playlist became 0 while backend treats omission as -1 / no active playlist.
- Evidence: actual loadConfig synthesized osc.enabled=true, sacn_sim.enabled=true, current_playlist=0.
- Fix applied: defaults false, false and -1; active-playlist selector represents no active playlist. Explicit existing config values remain unchanged.
- Behavior implication: saving a partial config no longer silently enables these outputs/tools or chooses the first playlist. -1 preserves existing backend no-active-playlist behavior.

### FE-07 — P2 — Waveform paint cost scales with the entire track every snapshot — FIXED core cost
- Location: frontend/src/WaveformDisplay.tsx:81–140,153–171,218–224.
- Trigger: four ordinary five-minute waveforms while receiving 30 Hz snapshots.
- Evidence: overview loops through 60000 peaks per deck per render: 7.2 million fillRect calls/sec, plus repeated max scans and canvas reallocation. Hotcue/saved-loop arrays arrive with fresh identities, so paused snapshots also redraw. Detail loop reads canvas layout every animation frame and issues one draw per peak in visible window (up to 6000 per deck at 30s zoom).
- Fix applied: overview peak bins cached by data/width, at most one amplitude bar per CSS pixel; detail draws at most one bar per CSS pixel. Maximum memoized. ResizeObserver supplies dimensions; backing buffers resize only on size/device-ratio change; drawing respects device pixel ratio. Redundant detail animation frames with identical state/time are skipped.
- At 700px width, overview amplitude calls are bounded to 84000/sec across four decks, about 86x fewer than the 5-minute baseline; this is a work-count comparison, not a measured browser FPS claim.
- Regression: bins retain transients/padding and one-hour arrays are bounded by requested column count. Browser GPU and physical tablet profiling remain pending.
- Further option: cache the static colored waveform layer and only composite played tint/playhead; pause hidden canvases. Current bounds already remove track-length-dependent draw calls.

### FE-08 — P2 — Static terminal/config editor re-render at telemetry rate — FIXED high-cost subtrees
- Location: App.tsx:308,527–528,586–587; TerminalPanel.tsx:54–61; ConfigEditorOverlay.tsx:152–154.
- Trigger: terminal with 1000 lines or editor with a large playlist, while 30 Hz snapshots update unrelated deck state.
- Cause: unmemoized children re-render their entire line/table trees. Terminal recalculates 1000 date strings per snapshot even with no new log lines. Editor rerenders every playlist row while idle.
- Fix applied: memoized TerminalPanel and ConfigEditorOverlay with stable close callback; memoized track marquee components. Relevant props/internal changes still update normally.
- Remaining: SettingsModal props are mostly inline callbacks, and DeckCard still renders at 30 Hz for formatted second-level time. Further split metadata/seconds from high-rate time refs if profiling justifies it.

### FE-09 — P2 — Previous CSV read can override the currently selected file — FIXED
- Location: frontend/src/configEditor/components/CsvImportModal.tsx:22–35,61,123.
- Trigger: choose large A.csv, then small B.csv before A finishes; A finishes last. Also, choose an unreadable file after a valid import preview.
- Cause: uncontrolled FileReader completions overwrite songs regardless of selection; no onerror path or pending state; previous songs remain importable during a new read/error.
- Fix applied: native File.text() with generation guard, pending state, cleared preview, read errors, captured filename, and unmount invalidation. Import is disabled until current file completes.
- Regression: reversed read completion displays second.mp3; subsequent read failure disables import.

### FE-10 — P2 — Null artwork update leaves stale image — FIXED
- Location: frontend/src/App.tsx:420–428.
- Trigger: backend sends an explicit artwork_data frame with data:null/mime:null for a previously cached filename.
- Cause: early return ignored the removal, retaining old blob URL/image.
- Fix applied: revoke old URL and delete both map entries on explicit absent artwork. Positive replacements still revoke prior URLs.
- Follow-up: broader lifetime/identity concerns are FE-11.

### FE-11 — P2 — Frontend media caches grow for the browser's entire lifetime — FIXED
- Location: frontend/src/App.tsx:91–102,408,423–428,264–271.
- Trigger: leave an operator browser open through many tracks/sets.
- Evidence: peaksByFileRef retains every file forever; artwork URLs are released only on replacement of the same name or app unmount. Deck unloads do not evict either cache. Artwork setState also spreads the entire accumulated map on each new image.
- Impact: 300 five-minute waveforms retain ~18 million JS numbers (~144 MB for numeric storage alone), plus array/object overhead, artwork blobs and transient WS JSON strings. Browser memory pressure/GC can degrade the live display.
- Suggested fix: bounded LRU with loaded-file pins; revoke URLs on eviction. Keep a small cache for pre-snapshot media arrival. Consider serving artwork through the existing HTTP endpoint with browser caching and a stable track identity instead of persistent base64/blob maps. Coordinate cache identity with backend media agent.
- Follow-up applied: full trackId keys, 64 MiB/24-entry browser cache, active-entry preference, bounded pre-snapshot retention and URL revocation. Rapid pending arrivals do not evict active media while inactive candidates exist. Hard limits still win when active entries alone exceed them. Collision, pending-frame, bound and URL regressions pass.

### FE-12 — P2 — Stale waveform status can erase current track's ready peaks — FIXED
- Location: App.tsx:387–401; backend/src/index.ts:1016–1039,1047,1065.
- Trigger: A is downloading; switch to cached B or a gated/mapped track. Backend taskId increments only after early returns, so A's later progress/error can still be broadcast for the deck. Frontend overwrites B's waveform state solely by deck without validating fileName.
- Impact: progress/error for A replaces B's peaks. Later snapshots only rebind cached peaks when filename changes, so a stable B can remain without waveform indefinitely.
- Suggested fix: invalidate backend task generation before every track change/unload/early return; frontend associate status with file identity and only apply to its matching deck. Preserve legitimate pre-snapshot arrival with a small pending status cache.
- Applied: root invalidates backend waveform task IDs before early returns; frontend validates file identity and keeps a per-deck pending status for valid pre-snapshot arrival. Regression covers ready B surviving an error for A and early progress for C binding on its snapshot.

### FE-13 — P2 — User settings can overwrite saved preferences before hydration completes — FIXED
- Location: App.tsx:115–125,148–157,202–224; userSettings.ts:111–119.
- Trigger: slow or failed GET /api/users, then open Settings and change one value.
- Cause: every user initially has {}, controls remain editable, and PUT replaces the full object. The outgoing object can omit saved role, layout and notes. A late GET then overwrites optimistic client state as well. Hydration/PUT failures are silently swallowed.
- Impact: saved preferences lost or UI claims changes that did not persist.
- Applied: extracted useUserPreferences; controls and mutation callback wait for hydration, failures surface Retry loading, writes preserve unknown keys, and save failures expose Retry saving. Regression covers pre-hydration edits, unknown fields, failed load and successful retry.
- Suggested fix: explicit loading/error state; gate writes until hydration or merge user patches onto hydrated state with revision protection. Serialize writes per user, coalesce pending patches, reflect server success/error and offer retry. Preserve unknown keys. Keep active-user selection per-browser, as intentionally documented.

### FE-14 — P2 — Debounced settings still race and pending changes vanish on page exit — FIXED for same-browser writes; cross-browser policy unchanged
- Location: App.tsx:202–232; userSettings.ts:111–119.
- Trigger: two edits farther apart than 250ms while first PUT remains in flight; network delivers second first. Or reload/navigate during the debounce.
- Cause: timers coalesce only before sending; requests themselves are concurrent full replacements, ignored responses, and cleanup simply cancels pending writes.
- Impact: older response/request can restore older settings; recent UI edits disappear without feedback.
- Applied: SettingsWriter serializes each user independently, keeps only newest queued state, ignores obsolete acknowledgements, preserves failed data for retry and shows save status. pagehide flushes debounce, PUT uses fetch keepalive, and beforeunload warns only while writes remain unacknowledged. Forced browser/process termination cannot guarantee persistence. Tests assert a second request cannot begin while the first is unresolved and only the newest intent is acknowledged.
- Suggested fix: per-user single-flight queue with latest full state / revisions; dirty/error indicator; flush using pagehide plus fetch keepalive where practical, or explicit save acknowledgement. A failed request must not silently claim success.
- Multi-browser last-writer behavior needs a server revision/ETag if concurrent edits of the same user's preferences must merge rather than replace. Ask user about this policy before altering it.

### FE-15 — P2 — Freewheel slider floods disk/API and stale responses roll UI backward — FIXED for same-browser writes
- Location: App.tsx:172–187; SettingsModal.tsx:271–280; globalSettings.ts:30–40.
- Trigger: drag duration slider continuously on LAN with nonzero latency.
- Cause: each native input change starts a PUT that persists config.json and updates live worker; every completion unconditionally replaces freewheel state. Slower old responses or recovery GET can overwrite a newer optimistic choice.
- Impact: excessive disk/IPC work during a show, slider jumping/stale state, potentially last received value differing from latest operator intent.
- Applied: duration changes coalesce at 250ms with one request in flight; enable/disable flushes immediately after any active request; pending patches merge without changing cross-browser patch semantics. Failed earlier patch fields are retained when a newer patch follows. Stale refresh/PUT responses cannot undo optimistic newer intent. Errors are visible with retry. Regression exercises reversed refresh timing, rapid slider input, queued immediate toggle and failed patch merging. Cross-browser live synchronization remains a separate optional improvement.
- Suggested fix: coalesce duration changes with one request in flight and revision guards; keep enable/disable action immediate while serializing against duration requests. Parent owns backend global store serialization. Refetch on opening settings/reconnect or push versioned global-settings updates to keep multiple browsers accurate.

### FE-16 — P2 — Playlist deletion changes active playlist unexpectedly — FIXED with user-approved policy
- Location: frontend/src/configEditor/components/PlaylistEditor.tsx:43–46; GlobalSettings.tsx:373–379.
- Trigger: playlists A/B/C with active index=1 (B); delete A.
- Evidence: actual delete callback leaves index=1, now C. Deleting a preceding item while last playlist is selected can leave index outside array, disabling active-set filtering/next-track display.
- Applied: deleting a preceding playlist decrements current_playlist, preserving the selected identity. Deleting the active playlist now sets current_playlist=-1, as explicitly selected by the user. Deleting a following playlist leaves selection untouched; no-active stays no-active.
- Regression: active, preceding, following and no-active deletion cases verify index and surviving identity.

### FE-17 — P2 — Deleting a song silently rewrites later timecode offsets — FIXED with user-approved policy
- Location: frontend/src/configEditor/components/PlaylistEditor.tsx:57–65.
- Trigger: remove a row before later tracks. Code subtracts the gap to the next row from every later offset.
- Evidence: with A=10800, mashup=0, B=11400, deleting the mashup moves B to 0. Reordered/nonmonotonic offsets can increase later offsets instead. offset_frame is not included in gap arithmetic.
- Impact: saved/reloaded config can remap a lighting timeline far beyond the deleted song.
- Applied: user selected Preserve all remaining offsets. Removed compaction; deleting any track or mashup only removes that row. All retained offset_sec and offset_frame values remain exactly unchanged. No renumber action was added.
- Regression: deleting first/last track and middle mashup preserves complete retained entries, including distinct nonzero frame values.

### FE-18 — P2 — Handwritten CSV parser silently drops valid records — FIXED with Papa Parse
- Location: frontend/src/configEditor/utils/csv.ts:3–25,31–41.
- Trigger: Engine DJ export containing quoted newline in title/artist. Reordered/export-version header columns also fail because indexes 1,2,11 are hardcoded.
- Evidence: actual parseCSV returns one track for normal title; returns [] for the same quoted record whose title contains one newline. Line splitting occurs before quote parsing. Unclosed quotes/invalid rows are silently tolerated/dropped, so UI catch rarely runs.
- Suggested fix: replace handwritten parser with maintained Papa Parse (or csv-parse browser entry), enable proper quoted multiline parsing, validate/map known headers and surface row diagnostics. Retain basename normalization as explicit domain behavior. Add fixture tests for escaped quotes, CRLF/BOM, multiline fields and supported Engine exports.
- Applied: Papa Parse replaces custom quote/line parsing; maps Title/Artist/File name headers (including conventional aliases), requires one of each, reports parse errors, missing filenames and wrong field counts. Diagnostics reach the import modal. Added papaparse and @types/papaparse declarations; root installed dependencies/updated lockfile. Fixtures cover multiline quoted fields, escaped quotes, BOM/CRLF, column reordering, missing headers/filename and malformed records. The real Party Set V3.csv imports all 45 tracks.

### FE-19 — P2 — Config form accepts values outside protocol/domain constraints — OPEN, backend validation required
- Location: GlobalSettings.tsx:114–164,201–212; PlaylistEditor.tsx:221–228; ConfigEditorOverlay.tsx:75–85.
- Trigger: enter out-of-range port/universe/DMX address, arbitrary FPS, invalid IPv4, fractional/out-of-range frame, or duplicate/empty recording mapping, then Save.
- Cause: numeric inputs mostly have no domain bounds; frame max=29 is hardcoded even if FPS differs; Save is an onClick rather than validated form submission, so HTML min/max do not prevent writes. Invalid IPs are merely red text borders. Backend PUT currently validates only object shape (parent audit).
- Suggested fix: authoritative backend schema validation with useful field errors, mirrored frontend checks for quick feedback. Restrict FPS to actually supported protocol rates before deriving frame range. Validate finite integers/ranges, target list, mapping uniqueness and playlist references. Avoid silently clamping values that change lighting meaning.
- Hardware/protocol FPS semantics belong to bridge/output audit; do not invent accepted rates here.

### FE-20 — P2/P3 — Nested/ordinary modals do not own focus or Escape correctly — OPEN
- Location: SettingsModal.tsx:87–93,124–133; TrackNotePopup.tsx:19–29; ConfigEditorOverlay.tsx:54–67; CsvImportModal.tsx:39–43.
- Trigger: keyboard operator opens Settings/CSV/track note and uses Tab/Escape.
- Evidence: custom div dialogs do not focus themselves, trap/restore focus or make underlying page inert. Track note has no Escape handler. CSV has no handler, so Escape bubbles to the outer config editor's window listener and can close/discard the entire editor instead of just CSV. A track-note popup over Settings also allows Settings' window listener to act underneath it.
- Suggested fix: native dialog.showModal() (standard browser top layer/focus behavior) or a maintained accessible dialog primitive; route Escape to the topmost dialog and restore initiating focus. Coordinate modal stack rather than several global listeners.
- No authentication/role restriction is requested; this is keyboard correctness, not a request to add auth.

### FE-21 — P3 — Editor overlay was beneath header toggle — FIXED
- Location: frontend/src/configEditor/editor.css:719–723; styles.css:234–238.
- Trigger: open full-screen config editor. Its z-index 1000 was below header toggle 9999, so the unrelated toggle remained visible/clickable above editor chrome.
- Fix applied: editor at modal layer 10000. Native dialog conversion would remove manual stacking concerns entirely.

### FE-22 — P3 — Production frontend build does not typecheck — FIXED by root tooling
- Location: frontend/package.json build script; frontend/tsconfig.json.
- Evidence: build runs vite build only, which strips TypeScript without checking it. Current independent tsc -p frontend/tsconfig.json passes, so no current type failure is claimed.
- Applied by root: build now runs npm run typecheck before vite build. This full frontend production build passed after all frontend changes. Root owns final combined test/CI integration.

### FE-23 — P3 — HTTP operations can stay pending indefinitely — OPEN
- Location: RecordingControls.tsx:17–29,54–78; globalSettings.ts:24–40,53–63; configEditor/restApi.ts:212–239.
- Trigger: stalled connection where fetch neither resolves nor rejects. Controls can remain busy/disabled indefinitely; old responses can update unmounted UI.
- Suggested fix: AbortController/AbortSignal.timeout at actual HTTP boundaries with useful timeout feedback and effect cleanup. Mutating requests timing out must be reconciled via status GET before retrying (timeout does not prove server rejected a mutation).

### FE-24 — P3 — Presentation issues requiring browser/target-device verification — OPEN, lower confidence than deterministic findings
- Locations: styles.css headerBar/headerLeft/headerRight (55–86), trackNoteDialog:1148; configEditor/editor.css:455–458; utils/format.ts:1–5.
- Evidence: header has nonshrinking controls and no responsive header mode; four-deck phone view retains two columns; track-note min-width=360px exceeds a 320px viewport. Playlist table max-height calc(100vh - 380px) has no lower bound on a short landscape viewport. Continuous CSS animations do not honor prefers-reduced-motion. secToHMS(-1) produces -1:-1:-1 and decimal offsets can produce long fractional strings.
- Suggested fix: responsive header overflow/wrapping controls, viewport-bounded dialog minimum, usable minimum table height, reduced-motion media query, explicit sign/finite/precision handling for duration formatting. Confirm target minimum viewport and desired offset precision before design changes. No measured visual defect is claimed without a browser.

### FE-25 — P3 — Maintainability and duplicated frontend constants — OPEN/partly cleaned
- Locations: SettingsModal.tsx:27–29 vs userSettings.ts:11–13; WaveformDisplay.tsx:4 vs userSettings.ts:11; App.tsx:40,42,285–288,448; RecordingControls.tsx:17–28 and globalSettings.ts:61.
- Evidence: zoom defaults/limits are repeated; timing values scattered; repeated fetch wrappers use any where unknown+narrowing is sufficient; large App combines socket/media/settings/popups; comments describe removed architecture (e.g. some reload descriptions omit UI button). Relative imports in main/WaveformDisplay omitted .js contrary to project convention.
- Applied: corrected those .js imports; peak/size logic extracted to focused modules; user/global persistence extracted from App into useSettingsPersistence.ts with reusable settingsWriter.ts and one frontend debounce constant. App shrank despite added status guards.
- Suggested fix: import frontend zoom constants from userSettings, extract cohesive useDeckConnection/useUserSettings hooks and small typed HTTP boundary helper, keep tunables discoverable without importing server-only code into browser. Preserve deliberate mirrored frontend/backend types; they currently match structurally (diff found comments/order only).

## Coverage inventory

Read every original source/config file in full. For frontend/src: App.tsx, DeckCard.tsx, HeaderBar.tsx, RecordingControls.tsx, SettingsModal.tsx, TerminalPanel.tsx, TrackNotePopup.tsx, WaveformDisplay.tsx, main.tsx, appTypes.ts, globalSettings.ts, types.ts, userSettings.ts and styles.css.

For frontend/src/configEditor: ConfigEditorOverlay.tsx, defaults.ts, editorTypes.ts, restApi.ts, editor.css, components/CsvImportModal.tsx, components/GlobalSettings.tsx, components/PlaylistEditor.tsx, components/RecordingsEditor.tsx, utils/csv.ts and utils/format.ts.

Build/assets: frontend/package.json, tsconfig.json, vite.config.ts, index.html; public/fallbacks/dondiablo_hex_logo.jpg (270x270, ~20KB), martin_garrix_logo.jpg (1024x576, ~96KB). No material issue found in HTML/React entrypoint setup apart from imports/StrictMode lifecycle. Vite's proxy assumes backend 8090; configurable alternate backend ports require a matching dev proxy, a documented setup constraint rather than a runtime bug.

Read AGENTS.md and relevant README/memory architecture, current-key/local-dependency history, user-settings, editor, notes, freewheel, waveform worker and intentional no-auth/per-browser-user decisions. Cross-read backend types, snapshot sequence lifecycle, waveform status generation, config/default parsing and optional field contracts. Backend internals outside these contracts are covered by other agents.

## Validation and limits

- Before fixes: actual-source React SSR reproduced long-waveform and optional-note crashes; deterministic execution of actual App/editor handlers reproduced restart freeze, duplicate StrictMode sockets, save data-loss race, playlist-index bug; parseCSV reproduced multiline record loss.
- Temporary probe: /private/tmp/stagelinq-webview-frontend-probe.mjs. It can run against original or modified sources via FRONTEND_SOURCE. It reports observations rather than pretending pending findings have passed.
- Added frontend/test/frontend.test.mjs and test/loadSource.mjs. Sixteen regression tests currently pass. Initial cases: long/silent waveforms; peak-bin transients/padding; optional config defaults; sequence restart/stale socket; StrictMode socket cleanup; edits during save/duplicate saves; overlapping CSV reads/read errors. Added cases cover serialized/coalesced writes, failed patches/retry, user hydration/error retry/unknown keys/pagehide, freewheel latest-intent/refetch ordering, stale/pre-snapshot waveform status, and full CSV quoting/header/error handling.
- Tests execute real TS/TSX source with TypeScript's compiler; React SSR checks rendering and a deterministic hook/socket harness tests lifecycle callbacks. This is not a substitute for a browser DOM/timing integration test.
- Independent frontend TypeScript noEmit check passes. Frontend production build (including tsc) also passed with Papa Parse bundled. Parent will run final combined integration checks.
- No hardware, LAN services, real output packets or recording controls were used. No browser automation tool was available. Browser raster/resize and tablet performance remain to be checked on actual devices.

## Implementation summary

Applied: per-connection sequences and socket generation safety; finite memoized waveform max; pixel-bounded waveform rendering and ResizeObserver/device-ratio sizing; static subtree memoization; optional config defaults; safe revision-aware saves; backend-aligned disabled OSC/simulator/no-active-playlist defaults; native File.text reads with latest-selection gating; explicit null-artwork cleanup; editor stacking; ESM import cleanup. Additional fixes: Papa Parse with explicit CSV diagnostics; per-user/global hydration and ordered/coalesced saves with visible failure/retry; pagehide/keepalive handling; stale media status rejection; preserving the active index when deleting a preceding playlist. New modules: useCanvasSize.ts, waveformPeaks.ts, settingsWriter.ts and useSettingsPersistence.ts. New tests: sixteen regressions, including approved playlist deletion semantics.

Applied user decisions: track/mashup deletion preserves retained offsets/frames; active playlist deletion clears selection.

Not applied: broad configuration schema validation and HTTP request timeouts, cross-browser settings conflict/live-sync policy, media cache budget/identity design, native-dialog conversion and responsive redesign. All have concrete suggestions above; none should be described as fixed in final summary.

