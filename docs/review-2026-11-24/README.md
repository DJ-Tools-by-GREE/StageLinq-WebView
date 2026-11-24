# StageLinq-WebView detailed review — 2026-11-24

The review covered the complete active WebView codebase, its setup/tooling, both repositories' existing documentation and memories, and the actual linked StageLinq APIs. Three parallel agents reviewed frontend, bridge/output, and media/recording; the parent reviewed server/configuration/tooling and integrated the changes. A separate peer pass found and corrected additional integration races. Findings below distinguish implemented changes from proposed follow-up work; overlapping cross-module findings are intentionally cross-referenced rather than counted as separate fixed bugs.

## Detailed findings, evidence and coverage

| Area | Report |
|---|---|
| StageLinq bridge, Art-Net/OSC, source timing and lifecycle | [Bridge and outputs](bridge-outputs.md) |
| Recording/replay, waveform/artwork, workers, cue tools and simulator | [Media and recording](media-recording.md) |
| React UI, rendering, settings, configuration editor, CSV and accessibility | [Frontend](frontend.md) |
| HTTP server, persistence, sACN, logging, setup and dependencies | [Server and tooling](server-tooling.md) |
| Final integration review and regression fixes | [Peer review](peer-review.md) |

Each report includes source references, concrete triggers, severity, suggested fix, implementation status and validation limits. Historical archives are evidence, not a second maintained codebase. Tests use synthetic devices and loopback HTTP; no real show output was sent.

## Implemented changes

- **StageLinq integration:** public StageLinqInstance lifecycle and parseNetworkPath replace private singleton edits and custom path parsing. Preserve the fork's needed sample/BPM/pitch subscriptions and per-device transfer queue. Distinguish same-name network tracks, keep valid keys when artist is blank, reset reconnect caches, recalculate sample-derived duration/loops after sample-rate changes, and publish one complete beat snapshot per deck.
- **Timing/output:** per-deck monotonic position timestamps and explicit transport revisions drive the existing freewheel mode. Metadata and unrelated deck activity no longer mask a dropout. New samples are extrapolated to the current tick, preventing old cached positions from pulling the timeline backward between beats. Explicit pause/unload and real seek/loop stay distinct from disconnect defaults. Live worker and simulator share one timing implementation. Worker initialization failures reject and clean up. Art-Net type bytes follow supported 24/25/30 fps; unsupported drop-frame input is rejected.
- **Recording/replay:** attaching now advances, backward seeks and end recovery work, obsolete arm operations cancel, and recorder lifecycle work serializes. Write failures are visible; crash recovery repairs a torn final line; initial selected deck is captured; shutdown awaits footer/sidecar completion. Replay uses saved offsets, and recording excludes loading/armed replay. Configured backup audio remains excluded from waveform extraction while disarmed.
- **Media:** Chris's metadata-connect parser extracts embedded artwork, with ffmpeg fallback and maintained MIME detection. PCM reduction streams rather than retaining two complete decoded buffers. Unique temporary directories avoid collisions. Worker startup, transfer and shared-job errors settle all callers; missing artwork cache is distinct from confirmed absence.
- **Frontend:** WebSocket reconnect accepts a restarted server's sequence and rejects stale socket callbacks. Long/silent waveforms render safely; drawing work is bounded by display width. Static panels avoid telemetry-rate rerenders. Config defaults match backend behavior; optional notes render; edits made during save stay dirty. User settings wait for hydration, serialize/coalesce writes and show retryable errors. Freewheel slider requests coalesce. Stale media status cannot overwrite the current file; explicit absent artwork releases its old URL.
- **Editor:** Papa Parse replaces the handwritten CSV parser, supports quoted multiline/escaped fields and maps headers with useful errors. File-reading races are guarded. Track/mashup deletion preserves all remaining offsets and frames. Deleting the active playlist clears selection; deleting another keeps the active playlist's identity.
- **Server/tooling:** JSONC parsing replaces regex comment stripping. Shared atomic persistence and queued reload prevent destructive recovery, write collisions, false success and stale runtime restoration. Express forwards async failures as JSON responses. sACN uses raw packet bytes, honors zero/OFF and corrects simulator D1. Logging failures do not crash recursively; disabled diagnostics avoid unnecessary work. Outgoing WebSocket work is bounded without rejecting healthy large-waveform transfers. Builds rebuild the local sibling and typecheck the frontend; durable regression suites are wired into npm test.

## Standardized implementations adopted or retained

| Previous custom approach | Replacement / decision |
|---|---|
| Private StageLinq singleton/export mutation | Public StageLinqInstance |
| Manual net:// path splitting | StageLinq parseNetworkPath |
| Fork's duplicate BeatInfo and TrackLength support | Chris's upstream implementations |
| ffmpeg-only artwork parsing and handwritten MIME sniffing | metadata-connect first, file-type for fallback; ffmpeg retained where needed |
| Guessed sACN object scale/index | Packet.payloadAsBuffer |
| JSON comment regex | jsonc-parser |
| Handwritten CSV parsing | Papa Parse |
| Ad hoc stream completion and temporary filename | Node stream/promises.finished and fs.mkdtemp |
| Copied live/offline timecode algorithms | Shared TimecodeTimeline |
| Read-only cue decoding, waveform PCM reduction, device download serialization | Retained: upstream has no equivalent safe contract |

## StageLinq upstream merge and compatibility summary

The package merged 50 upstream commits through Chris's 83f6723 (v3.5.7), retaining the @gree44/stagelinq identity. [The package memory](../../../StageLinq/memory.md) contains the complete merge decisions and compatibility matrix.

Incoming changes include Engine OS 5 large/partial file-transfer fixes; fragmented/malformed TCP and discovery-message handling; better retries, rediscovery cooldown and offline announcement behavior; BeatInfo events; Genre/CurrentKey/TrackLength/TrackUri metadata; exported database APIs and Engine DJ 5 schema types; background database downloads; ignored-mixer warnings; updated SQLite/metadata dependencies; release/test tooling; and expanded protocol documentation/tests.

BeatInfo forwarding and TrackLength subscriptions were features this fork had independently added earlier. Both now use Chris's code. WebView-specific sample rate, numeric key fallback, track BPM, Speed telemetry and cancellation remain necessary. CurrentKey is normalized to Camelot with named keys taking precedence and numeric KEY_MAP fallback; it no longer alternates Am/8A on beat updates.

Compatibility changes to know: retry backoff increases by 500ms per attempt; ready no longer means optional database downloads have finished; Engine DJ 5 Track types move performance fields out of Track; new PlayerStatus metadata fields may be absent until hardware supplies them. WebView does not consume that Track table interface or enable automatic database downloads. It now uses the explicitly selected local sibling checkout rather than published 3.1.0.

## Remaining work, ordered by practical impact

The selected file-transfer, media-cache and recording-integrity findings are implemented. See [integrity follow-up](integrity-followup.md) for budgets, compatibility and validation. Remaining work is deliberately documented:

1. **Boundary validation:** complete address/range/env/mapping/frame-offset schemas with field errors.
2. **Output/protocol policy:** multiple-device deck assignment, OSC deselection, remaining socket recovery diagnostics, QuickLoop/short-clip units and metadata ordering. Pitched-backup interpolation/BPM policy and genuine 29.97 drop-frame support remain open; use unpitched backup audio.
3. **UI/tooling:** modal keyboard/focus/accessibility, target-device rendering checks, simulator chart decimation, read-only/unambiguous cue helpers and platform-aware show runner behavior.
4. **Dependencies:** WebView qs and Vite/esbuild advisories and the sibling package's file-type 16 migration remain separate follow-ups. No forced framework upgrade was applied.
5. **Retention/fidelity:** automatic disk/log retention, same-path content-version invalidation when device metadata is available, and recording/replaying every global output/freewheel setting. Disk retention remains operator policy.

The area reports propose a fix for every remaining finding. Settings role/authentication semantics and the intentional live console deck-selection model were not redesigned. Existing recordings/logs were preserved; generated-file retention should be an explicit repository decision.

## Validation

Original audit verification (before this follow-up): clean npm ci succeeded; npm run build rebuilt the sibling library and both workspaces with frontend typechecking; npm test passed all 100 tests with zero failures/skips; git diff --check passed. A real Engine DJ CSV imported all 45 tracks. HTTP tests bind only to loopback and stub hardware connections. The earlier StageLinq merge/alignment validation passed 265 tests across 23 files, native SQLite queries, metadata import, clean install/build and packing. One pre-existing Vitest unawaited-assertion warning remains documented in that repository.

The corrected simulator also processed the checked-in 72-minute recording: 159,637 deck events, 4,313.9 seconds and 129,418 ticks. Source corrections fell from 177 to 45 (D1), 205 to 60 (D2), and 30 to 18 (D4); unused D3 remained silent. More per-deck stale spans are expected because unrelated metadata/decks no longer conceal missing positions. These are simulation results, not captured hardware packet-loss or latency measurements.

No live Denon firmware, lighting console, browser GPU/tablet rendering or npm publication was validated. Legacy recording provenance limits the simulator's reconstruction of exact heartbeat/transport behavior. See the individual reports for reproducible fixtures and narrower validation claims.

Final integration validation: full linked-package/frontend/backend build passed; all 140 WebView tests passed with zero skips/failures. StageLinq build and all 284 tests across 25 files passed; its existing Vitest unawaited-assertion warning remains. Both repositories pass git diff --check. The legacy 72-minute simulation remains unchanged (159,637 deck events, 129,418 ticks; D1/D2/D4 corrections 45/60/18). No live hardware or npm publication was performed.
