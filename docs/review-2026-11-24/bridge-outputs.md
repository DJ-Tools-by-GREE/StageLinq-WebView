# StageLinq bridge and live-output audit

Baseline: StageLinq-WebView 78b7bd0, with the merged sibling StageLinq 3.5.7 based on chrisle upstream 83f6723. This report covers every line of backend/src/stagelinqBridge.ts, camelot.ts, artnetTimecode.ts, artnetWorker.ts, artnetWorkerMessages.ts, oscBpm.ts, constants.ts, types.ts, and the original bridge tests. I also traced all output integration call sites in index.ts, the replay timing contract, and upstream StageLinqInstance, StageLinqDevices, Player, BeatInfo, FileTransfer, ConnectionHealth, and track-path utilities. Read AGENTS.md and relevant README/memory architecture and hardware decisions. Source line references below use the baseline for original faults; current functions/new files identify fixes after line movement.

No live equipment was contacted. Reproductions used synthetic events, mocked workers/sockets, the actual compiled bridge/library, and a deterministic pure timeline. There was no firmware capture, production benchmark, or lighting-console acceptance test. Root owns integration/configuration changes and the final combined build/test/commit.

## Confirmed findings and applied fixes

### BO-01 — P1 — Normal gaps between position packets send backward timecode

- Source: baseline artnetWorker.ts:359–373; constants.ts:69–72. Baseline source positions were compared with the advancing timeline on every 30 Hz tick, even though no new position had arrived. A normal 166 ms gap is below the 250 ms stale threshold but above the actual 150 ms drift tolerance.
- Reproduction: actual worker class with a fake clock and captured packets emitted frame sequence 300, 301, 303, 303, 300 while the source remained at 10 seconds. Script: /private/tmp/audit-artnet-repro.mjs. Normal documented BeatInfo cadence is 50–200 ms.
- Impact: backward lighting-console jumps during ordinary playback, before freewheel is even entered.
- Applied: new shared TimecodeTimeline projects a new sample from its capture timestamp, advances between packets, and reconciles only on new positions. Real seeks, loops, or track replacements can still deliberately rebase. The misleading drift-constant comment now says 150 ms, matching the pre-existing numeric setting.
- Validation: committed timecodeTimeline.test.mjs tests continuous 200 ms BeatInfo cadence, delayed delivery, backward seek, short loop, pitch, and replacement. Simulator consumes the same class via media agent.

### BO-02 — P1 — Metadata and unrelated decks conceal a selected-deck outage

- Source: baseline artnetWorker.ts:175–196; index.ts bridge subscription and replay push loop. Every state push refreshed a single worker heartbeat; replay refreshed it every snapshot even when its audio clock was frozen. The beatPulse method was not wired to actual beats.
- Trigger: selected deck stops sending positions while another deck, mixer faders, or metadata keeps updating; or replay snapshot timer continues while audio stops advancing.
- Impact: worker thinks frozen source is fresh, snaps against stale elapsed data, and fails to enter its existing freewheel mode.
- Applied, with user approval: SourceTiming carries per-deck position capture timestamp/revision, explicit transport revision, and the identity captured with that position. Only valid BeatInfo samples advance position timing. Metadata and watchdog stops do not. Worker selects that deck's timing; replay/stateProvider preserve their audio source's timing instead of synthesizing a heartbeat on each snapshot.
- Validation: bridge timing tests, actual worker cache test with another deck and metadata activity, queued-old-sample test, media replay timing tests. Preserves existing enable, stale threshold, and maximum duration controls.

### BO-03 — P1 — Partial reconnect snapshots erase the last good freewheel source

- Source: baseline artnetWorker.ts:175–180,209–214,301–307; bridge resetState and reconnect call chain.
- Trigger: reconnect resets the bridge; the first incoming metadata publishes elapsedSec=0/play=false before fresh BeatInfo. Worker overwrites its cached valid source and resets the timeline, even while reconnecting/freewheeling.
- Reproduction: actual worker class initialized with a running deck; set reconnecting=true; push blank elapsed=0 state; next send resets lastTickMs to null and goes silent. This contradicts the documented hold-last-good behavior.
- Applied: TimecodeTimeline retains its source snapshot through null/old timing and partial metadata, until a new reliable position arrives. Track identity is captured with the sample, so new path metadata cannot apply an old elapsed value under the new track's offset.
- Explicit stop distinction: real Play/PlayState or SongLoaded=false advances a transport revision and stops output, even before a post-reconnect position. Reset/watchdog blanks do not advance that revision.
- Validation: reconnect hold, new-position recovery, path-before-position, explicit pause and unload, worker-cache tests. Zero-duration freewheel now emits no synthetic frame at stale onset.
- Peer-review follow-up applied: artnet.setSource(decks,timings,offsets) switches all output caches and resets the timeline atomically. Leaving replay for a paused/unloaded/null-timed live source cannot retain old replay state while applying live offsets. Root wires mode/session transitions before further live pushes; actual-worker regression covers no subsequent bridge event.

### BO-04 — P2 — Wall-clock changes alter cadence, staleness, and timeline position

- Source: baseline artnetWorker.ts:134,195,228,235,359 and bridge watchdog clocks.
- Trigger: NTP/manual clock correction, system wake, or a wall-clock step during a show.
- Reproduction: adding 5 seconds to Date.now advanced the running worker by 150 frames in a single tick; a backwards clock step can delay a scheduled tick.
- Applied: timeline/scheduler/position/watchdog timing uses performance.timeOrigin + performance.now, comparable across Node threads and unaffected by Date.now changes. Human-readable state/log timestamps remain wall-clock values.
- Validation: deterministic timeline and monotonic-clock test. Actual OS sleep/wake timing remains a hardware/runtime acceptance check.

### BO-05 — P2 — Reconnect retains the prior sample rate, BPM, speed, and deferred conversions

- Source: baseline stagelinqBridge.ts:1188–1198 reset only cleared visible decks, keys, paths and heartbeat timestamps.
- Reproduction: set 48 kHz, raw BPM=120, SpeedState=10; disconnect; receive a beat BPM=140/samples=480000. The blank new session became elapsed=10, speed=10, baseBpm=109.09 using the previous session's caches.
- Impact: incorrect elapsed/derived BPM and stray pending length/loop values after reconnect, until every relevant StateMap field happens to be resent.
- Applied: disconnect resets raw rate/BPM/pitch, raw length/loop values, discovery signatures, elapsed throttle and playback edge state, position timing, and explicit loaded state. Revisions remain monotonic to distinguish sessions.
- Validation: bridge regression verifies no elapsed conversion before a new sample rate, no old derived BPM/speed, no deferred old duration, and old event listeners/timers detached.

### BO-06 — P2 — A new sample rate never corrects an early duration/loop conversion

- Source: baseline stagelinqBridge.ts:562–601,612–628,748–770; cached sample rate survives track changes.
- Trigger: new 48 kHz track length arrives before its rate, while the deck still holds 44.1 kHz from its previous track.
- Reproduction: TrackLength=480000 followed by SampleRate=48000 left totalSec=10.8843537 rather than 10. Loop positions have the same failure when converted with a previously known rate.
- Applied: retain raw sample values after conversion and recalculate them when SampleRate changes; explicit second/millisecond duration values clear the sample cache. Raw pending values are cleared on session reset.
- Validation: bridge test corrects total=10, loop-in=1, loop-out=2 when 48 kHz arrives after sample positions.
- Remaining ordering limitation: the library does not accumulate SampleRate and protocol messages are not a track transaction. Blindly clearing the rate at TrackNetworkPath can discard the *new* rate when it arrived before the path. Full per-track metadata generation tagging needs hardware event ordering/captures; retained samples fix the confirmed permanent error without inventing an ordering guarantee. Old duration/title can still be displayed briefly during incomplete replacement metadata.

### BO-07 — P2 — Distinct network tracks with the same basename suppress track-change work

- Source: baseline stagelinqBridge.ts:217–230 compared only lastTriggeredFileNames, despite storing full network paths.
- Trigger: load source/a/track.mp3, then source/b/track.mp3 or another device's identically named file.
- Reproduction: two network paths produced one onTrackChanged callback; old loop data remained. Basename metadata preservation added by the earlier key fix made the identity available but did not update this deduplication key.
- Applied: callback deduplication uses the full captured network identity. Track-change loop clearing precedes publication, so subscribers cannot record a new filename with the previous loop state.
- Validation: same-basename replacement triggers twice, repeated identical paths/basename nowPlaying metadata do not, and published replacement state has no old active loop.
- Remaining scope: waveform/artwork cache and playlist matching intentionally still use basenames elsewhere. Distinct files sharing a basename can still collide there; media/frontend reports cover those caches. Changing playlist identity requires an explicit migration policy.

### BO-08 — P2 — Missing artist/title tags can mark a playing loaded song unloaded

- Source: baseline stagelinqBridge.ts:691–705,840–855,1039–1056.
- Trigger: valid SongLoaded=true track emits ArtistName="" (common with untagged files) or an empty title.
- Reproduction: loaded=true/current key Am then ArtistName="" produced loaded=false/key="--".
- Applied: artist metadata only updates artist display. Empty title uses the placeholder and respects the explicit SongLoaded state. Late nonempty title cannot override an explicit unload. Real unload clears keys and records stopped transport.
- Validation: loaded untagged track remains loaded/playing and keeps its key across raw/nowPlaying/named-state artist updates; explicit unload stops output and cannot be undone by delayed title metadata.

### BO-09 — P2 — One BeatInfo deck event publishes two snapshots, one partially updated

- Source: baseline stagelinqBridge.ts:925,938 and 978,987. Elapsed handling touched a deck before BPM/derived updates, then touched it again at the end. ELAPSED_THROTTLE_S=0 makes this happen even for unchanged positions.
- Reproduction: one unchanged deck beat invoked a subscribed listener twice. Four decks therefore made eight structured-clone worker messages per packet, plus recorder diff work.
- Applied: publish one complete state per deck at the end of BeatInfo handling. Accumulated upstream key state does not republish an unchanged normalized key.
- Validation: one four-deck BeatInfo packet publishes exactly four complete elapsed/BPM snapshots. This reduces that hot-path publication work by half; no claim is made about total CPU or network throughput without production profiling.

### BO-10 — P2 — Worker startup can hang indefinitely after bind/init failure

- Source: baseline artnetTimecode.ts:135–151 and artnetWorker.ts:119–129,525–527.
- Trigger: bind times out or rejects; worker catches the failure and only logs it. Main awaits ready/error forever because a handled init rejection emits neither. An early clean worker exit also never settled readiness.
- Applied: explicit initError message; bounded main readiness timeout; ready/error/exit/timeout handlers clean each other up; failed worker terminates. Initial socket errors reject binding promptly. Exit/stop clears the freewheel badge.
- Validation: mocked actual compiled broadcaster tests failure message, early exit, worker error, no-response timeout, successful start/stop. No network socket is created by these tests.

### BO-11 — P2 — Advertised FPS and Art-Net frame type disagree

- Source: baseline index.ts:464–466 always used fpsType=3 (30 FPS), while README advertised 24,25,29.97,30. artnetWorker.ts:49–56 uses fractional modulo for 29.97 and cannot generate correct SMPTE drop-frame numbering.
- Impact: receivers decode a different timebase from the configured one; 29.97 values are truncated into byte fields without a correct drop-frame conversion.
- Root applied: 24/25/30 now map to the appropriate type byte; 29.97 is rejected explicitly until drop-frame support exists. README must reflect this supported set. The worker's raw packet helper remains simple and appropriate for supported integer frame rates.
- Suggested follow-up if 29.97 is needed: agree receiver drop-frame expectations, use a verified SMPTE conversion, and test minute/tenth-minute/hour boundaries before enabling it. No hardware guess made here.

## Confirmed remaining findings and suggested fixes

### BO-12 — P1 for multi-device installations — Devices overwrite each other's deck slots

- Source: stagelinqBridge.ts raw message listener ignores connectionInfo; BeatInfo maps array index to global deck1–4; nowPlaying maps only layer A–D and ignores player/device identity.
- Trigger: two SC6000/SC5000 units each publish a local Deck1/layer A. The later unit overwrites the first unit's title, BPM, elapsed, rate, and heartbeat. Single Prime 4+ does not have this ambiguity.
- Evidence: direct event mapping in raw, BeatInfo and PlayerStatus branches; upstream explicitly supplies connectionInfo and PlayerStatus.player/address/deviceId/layer for this reason.
- Impact: wrong deck data/timecode and misleading connection freshness in a multi-player rig.
- Suggested fix: one explicit device/player/layer-to-WebView-deck mapping, applied identically to StateMap, BeatInfo, mixer assignments and metadata. Add two-device interleaving regressions.
- Not applied: requires the user's actual player numbering/topology and desired four-deck mapping. Do not infer mixer channel order from addresses.

### BO-13 — P2 — OSC heartbeat keeps sending the previously selected deck after deselection

- Source: oscBpm.ts:54–58,72–82 and index.ts selectedDeck-gated call.
- Trigger: select a deck with valid BPM, then sACN deselects all decks. sendDeckBpm is no longer called; lastDeck stays set and the heartbeat sends that stale BPM indefinitely. Calling sendDeckBpm(undefined) would not clear it either.
- Impact: OSC behavior diverges from the intentionally silent Art-Net off band and may keep a lighting speed master moving.
- Suggested fix: explicitly clear lastDeck/lastCommand on deselection and do not heartbeat without a selected valid source. Test selection→none→same BPM reselection with a mocked UDP sender. Consider a stopped flag so calls after stop cannot send on a closed socket.
- Not applied: whether OSC should hold BPM or stop during deselection was not part of the timecode approval and needs an operator policy decision. Stopped-but-selected BPM may also be intentionally useful; do not silently gate it on play.

### BO-14 — P2 — Socket recovery reports success after a failed rebind and suppresses healthy targets

- Source: current artnetWorker.ts:283–324 (baseline 412–453).
- Trigger: one destination returns ENETUNREACH/EADDRNOTAVAIL. One global socketFaulted disables every destination for five seconds. During recovery a rebind timeout resolves as success, clears socketFaulted, increments recovery count, and logs Socket recreated even though no bind callback ran. A synchronous bind failure rejects a void recovery promise without a catch.
- Impact: an unreachable console can interrupt healthy consoles; status claims recovery that did not occur; an unexpected recovery exception can terminate the worker.
- Suggested fix: separate destination reachability from socket/interface failure, retain sends to healthy targets where possible, use one rejecting bind helper for initial/recovery bind, catch recovery rejection, and update success state only after listening. Use the existing recovery policy rather than adding competing retry loops. Test injected per-IP send failures, bind error/timeout, and shutdown during recovery.
- Not applied: runtime recovery policy changes should be validated with the venue's multi-target/interface topology. The deterministic initial-start hang is fixed separately.

### BO-15 — P2 — Upstream whole-file failure can poison future downloads

- Source: bridge downloadFile calls upstream FileTransfer.getFile. Upstream services/FileTransfer.ts:216–279 allocates receivedFile and sets _available=false; its size=0 return exits before resetting either. Several error paths also leave receivedFile set; the download timeout is not cleared after success, and the async Promise executor's loop can keep running after timeout.
- Reproduction: actual compiled FileTransfer with mocked response size=0 returns empty bytes; receivedFile remains non-null and _available=false; the next getFile rejects with ERR_ASSERTION. Script /private/tmp/audit-upstream-transfer-repro.mjs. No network involved.
- Impact: a missing/streaming file can make every later waveform download for that device fail until reconnect. Timeouts can retain buffers, progress work and listeners longer than intended.
- Suggested fix: in the package, guarantee buffer/availability/timer cleanup with a finally block on every exit, replace the async Promise executor with a cancellable transfer wait, and test missing→valid, timeout→valid and disconnect paths. Preserve the per-device queue. This is an inherited upstream bug, not evidence that adopting upstream is generally unsafe.
- Not applied by this agent: outside the owned WebView files. Root may choose a focused library fix; report it explicitly if left for follow-up.

### BO-16 — P2 — Download queue work survives the session and can head-of-line block new tracks

- Source: stagelinqBridge.ts:1301–1333 and resetState/disconnect.
- Trigger: user changes tracks rapidly while a file download is pending, then reconnects. Queued closures retain old file paths/progress handlers; reset never invalidates downloadQueues. Service polling starts when each queue item begins, so many obsolete requests can consume successive 30-second waits.
- Impact: new track waveforms are delayed behind obsolete work; old callbacks can report progress after reconnect; one hung getFile blocks the device's entire queue.
- Suggested fix: add a bridge session generation/cancellation token and obsolete-track checks before queued work begins and during service polling. Remove a queue entry only if it is still that device's current tail. Upstream transfer cancellation must be made safe before aborting an active shared-buffer transfer.
- Not applied: requires coordination with the media service's in-flight cache/jobs and the upstream cleanup in BO-15. The existing serialization itself is necessary and tested, not redundant code to remove.

### BO-17 — P2 — QuickLoop positions received before SampleRate become permanent huge seconds

- Source: stagelinqBridge.ts QuickLoop handlers (current 777–808 and 1116–1145; baseline 789–801,1134–1146).
- Trigger: QuickLoop in/out raw sample counts arrive before SampleRate. toSec returns the original sample number when rate is missing; unlike active-loop positions, these values are not retained for conversion later.
- Example: in=48000/out=96000 becomes 48,000–96,000 seconds, remaining wrong when 48 kHz arrives.
- Suggested fix: retain raw QuickLoop sample entries or defer publication until a valid rate exists; convert/reconvert on rate updates and clear raw entries on replacement/unload. Add out-of-order sample-rate tests. Handle device-specific deletion/sentinel payloads only after confirming their representation.
- Not applied: a deterministic unit-conversion fix is safe, but saved-loop payload shape/support remains an observed-firmware question. Do not assume the whole family is unsupported just because hot cues are not broadcast.

### BO-18 — P2/P3 — Numeric protocol boundaries accept NaN/Infinity and heuristic duration can misclassify clips

- Source: core CurrentBPM/length/key/QuickLoop numeric branches mostly check typeof only; TrackLength raw>100000 heuristic distinguishes samples/seconds.
- Trigger: malformed numeric payload, nonfinite decoded float, or sample-based clips shorter than about 2.1 seconds at 48 kHz. A 48000-sample length is interpreted as 48000 seconds under the heuristic.
- Impact: nonfinite UI/BPM data, invalid derived values; short clips can have wildly incorrect duration. Timing's new position boundary rejects nonfinite sample positions and the packet boundary rejects nonfinite frame output, limiting live-output damage.
- Suggested fix: consistently validate finite domain values at the StageLinq boundary; identify TrackLength units by confirmed path/device/firmware semantics rather than magnitude if short clips are used. Add actual-device short-clip fixtures before changing the heuristic globally.
- Not fully applied: finite-domain validation is safe; changing unit assumptions requires real payload evidence.

### BO-19 — P3 — Legacy duplicate parsing now obscures the supported upstream contract

- Source: bridge retains export-shape, flattened-vs-aggregate, named-stateChanged and many alias fallbacks; current upstream emits a typed aggregate BeatData and accumulated PlayerStatus. Export-shape guessing is now removed; named-stateChanged still duplicates metadata/loop handling and assigns TrackLength directly without the raw-message sample conversion.
- Impact: extra maintenance surface, inconsistent fallback units, tests can validate synthetic shapes the installed package does not actually emit, and it is harder to distinguish hardware variation from package-version variation.
- Suggested fix: migrate canonical high-level metadata to typed PlayerStatus/trackLoaded and a single raw telemetry normalizer, keeping only explicitly documented compatibility adapters. Keep raw SampleRate/Speed/loop handling until upstream exposes the equivalent typed fields. Remove fallback branches only after confirming no supported alternative package build is required.
- Not fully applied: public instance/path APIs are adopted now; a wholesale parser rewrite would combine protocol behavior changes with this audit and requires a focused compatibility decision.

### BO-20 — P3 — Documentation and small implementation cleanup

- Sources: types.ts fader comment still says ExternalMixerVolume although bridge uses CHn fader position; baseline README says 10-second disconnect, elapsed from timeline, and 10-second statistics, while constants are 2 seconds, samples/SampleRate, and 2 seconds. AGENTS hardware note confuses package output shapes with firmware shapes. artnetTimecode.getElapsedSec always returns 0 and has no current caller. Several duplicated tuning literals remain outside constants.
- Impact: misleading operator tuning and future maintenance; no evidence these comments alone cause a runtime fault.
- Suggested fix: refresh the current architectural reference, retain historical memory entries as history, remove unused compatibility APIs/imports, and move live tunables to constants when next touching the subsystem. Keep the tiny verified OSC/Art-Net packet encoders unless adding real new protocol surface; another package is not automatically a stability improvement for a fixed 19-byte packet.
- Root owns final README/memory updates. Earlier inaccurate claims that FileTransfer and BeatInfo share one TCP socket should be corrected: NetworkDevice creates separate service sockets; they still share the main event loop.

## Upstream standardization decisions

| Custom behavior | Public upstream capability | Decision |
|---|---|---|
| Singleton private _instance mutation / export guessing | StageLinqInstance | Adopted; owns one public instance per bridge session. reset() alone was not equivalent after logout failure because isConnected can remain true. |
| Manual net:// path split | parseNetworkPath | Adopted for device/source/folder parsing and validation; actual FileTransfer path retains source/folder structure. |
| BeatInfo service forwarding and TrackLength subscription | Current upstream implementations | Already adopted by preceding merge; kept. |
| Download promise chain | StageLinqDevices.downloadFile/waitTillAvailable | Kept queue. Availability waiting is not an atomic serialized queue and does not clean poisoned getFile state. |
| Watchdog/freewheel | ConnectionHealth | Kept app semantics. Generic monitor combines activity/retry behavior and does not replace per-deck position freshness, explicit pauses, replay clock, 20-second first-beat grace, or bounded freewheel. |
| Musical CurrentKey→Camelot | PlayerStatus.key supplies named value | Kept validated converter; no equivalent public StageLinq Camelot converter found. Prior key ordering tests remain. |
| Duration/sample conversion | PlayerStatus.trackLength | Kept conversion because upstream forwards the raw value, with no normalized seconds guarantee. |
| Artwork extraction | Upstream/metadata-connect parsing capability | Media agent handles adoption and fallback; this report does not duplicate its implementation audit. |
| Timecode simulator copy of worker math | New shared TimecodeTimeline | Adopted by worker and simulator to prevent future divergence. Legacy recordings cannot reconstruct raw heartbeat-vs-watchdog distinctions they never recorded. |

## Validation and remaining acceptance work

Final focused verification passed: backend TypeScript build; 47 tests in stagelinqBridge.test.mjs, timecodeTimeline.test.mjs and artnetLifecycle.test.mjs; diff whitespace check. This includes explicit unload, zero-duration, selected-worker freshness and atomic source switching. Existing CurrentKey tests, including actual upstream Player queue ordering and all 24 named keys, remain present. Root owns final full-suite/build verification across agents' changes.

Pure simulation can prove the algorithm, timestamp propagation and packet field construction under defined inputs. It cannot prove actual firmware event ordering, multi-device mapping, network interface recovery or console behavior. Recommended hardware acceptance: normal 50–200 ms cadence; short cable dropout; reconnect with metadata preceding first sample; pause/resume and a short loop; 44.1/48 kHz track replacement; verify configured FPS at every receiver. The user has approved the corrected timing semantics; remaining mapping/OSC/unit questions should be asked only where they materially affect this installation.
