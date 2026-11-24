# Media, recording, replay and offline tooling audit

Audit date: 2026-11-24. Original line references below refer to the pre-audit implementation, so findings remain traceable after the fixes. P1 = core show feature failure/data loss; P2 = functional defect or material performance/reliability risk; P3 = bounded maintenance/tooling issue. “Applied” describes the media agent's changes; index.ts integration belongs to the root agent.

## Coverage

Fully inspected all assigned implementation files: backend/src/recorder.ts (521 original lines), replay.ts (330), stateProvider.ts (59), waveformService.ts (210), waveformWorker.ts (482), waveformWorkerMessages.ts (65), scripts/extractCues.ts (385), scripts/simulateTimecode.ts (1,007), and read_cues.py (181). Also inspected relevant index.ts routes/shutdown/track-change/snapshot paths, bridge download/track identity and state subscriptions, live Art-Net timeline/worker, constants, type contracts, backend manifests, WebView AGENTS.md and relevant README/memory sections. Read actual sibling StageLinq metadata/index.ts, metadata/reader.ts, DbConnection, FileTransfer APIs, and installed metadata-connect parsers/reader contracts before identifying replacement candidates.

The review deliberately preserves the standalone, read-only cue workflow. It does not claim hardware validation, cover raw exported database/audio content, or infer that StageLinq provides waveform or hot-cue decoding when it does not.

## Confirmed findings fixed in this pass

### MR-01 — Replay could never leave attaching (P1, applied)

Original stateProvider.ts:30-37 returns before calling Replay.tick unless replay already overrides outputs; replay.ts:270-272 changes attaching to active only inside tick. There is no other replay.tick caller. Arming, loading the mapped audio and pressing play therefore leaves live deck output active forever. Temporary reproduction advanced five real-deck positions through StateProvider and returned state=attaching, overriding=false, file=real.wav. StateProvider now ticks an attached session before deciding whether the returned output owns the decks. Regression covers paused attach, activation, recorded output, and recorded-offset handoff. No judgment required.

### MR-02 — Backward seeks and end-of-log recovery were broken (P1, applied)

Original replay.ts:262-268 treats lastClockMs as an increasing high-water mark. Seeking from 10s to 2s makes every following position below 10s appear stalled, forcing play=false despite advancing audio. The ended state at 276-279 never clears when seeking back into the recording. Both failures were reproduced directly: seek to 2s and 2.05s returned play=false; seek back from end retained state=ended. Movement in either direction now refreshes the clock, and seeking before the end re-enters active state. Regression tests cover both paths. No judgment required; scrubbing is a documented feature.

### MR-03 — Recorded playlist offsets were discarded (P1, applied including root integration)

Original replay.ts:66-68 retained only startedAt from the header, while index.ts continued to feed current live trackOffsets to Art-Net. Changing a playlist or timecode offset after recording therefore changes the supposedly identical backup show. Replay now validates and retains saved offsets and exposes getTrackOffsets(), returning null for live output. User chose saved recording offsets. Root has integrated applying/restoring that map around replay and preserving it across config reload. The separate PR-03 peer-review fix for an atomic live/replay source-plus-offset handoff is being finalized by root/bridge. Regression verifies saved map and live null transition. Remaining limitation: configuration changes made DURING a recording are not currently recorded as offset events (MR-25).

### MR-04 — Concurrent recorder operations caused duplicate recording and lost recovery locks (P1, applied)

Original recorder.ts:329-352 checks active before asynchronous mkdir/open/lock work. Two simultaneous starts both pass, create two streams, and subscribe twice; only the last stream remains accessible. A temporary Promise.all of start(first)/start(second) returned [true,true] and two subscribers. Original stop at 430 marks inactive before flush/sidecar/lock removal; a new start can write its lock and then have it deleted by the old stop. Delaying sidecar I/O reproduced active=true with lockExists=false. All recorder lifecycle operations now serialize; isBusy() reserves synchronously, and shutdown() drains in-flight startup/resume/stop work. Regression verifies single start, stop/start lock retention and shutdown-during-start. No judgment required.

### MR-05 — Disk errors were silently reported as successful recordings (P1, applied)

Original recorder.ts:344-347 attaches a once(error,reject) listener only for opening. After open, its promise is settled, so later asynchronous write failure is swallowed; write() catches only synchronous exceptions. Destroying the real stream with an injected disk error left active=true, incremented eventCount, and stop() still returned ok=true with a success sidecar. Persistent error handling now marks recording inactive, detaches subscribers, and retains the recovery lock. stop uses Node stream/promises.finished, propagates flush/sidecar/lock failures, and does not create success metadata after failed audio-state writes. Lock creation is mandatory, not a logged-and-ignored operation. Regressions inject a disk failure and assert rejection, no sidecar and retained lock. No judgment required.

### MR-06 — Signal shutdown exited before recorder flush (P1, applied by root)

Original index.ts:1115-1124 starts asynchronous recorder.stop on SIGINT/SIGTERM, but the separately registered handlers at 1196-1210 immediately call process.exit(0). Footer flush, sidecar and lock cleanup cannot finish reliably. In non-sACN modes, these exit handlers may not exist at all. Required fix is one coordinated asynchronous shutdown that awaits Recorder.shutdown and worker cleanup before exiting, independent of control-input mode. Media supplies shutdown() and a regression demonstrating it waits for an in-flight start. Root has integrated coordinated signal wiring and Express rejection responses; its real HTTP/SIGTERM integration test verifies footer and sidecar completion.

### MR-07 — Crash recovery appended its gap marker onto a torn JSON line (P2, applied)

Original recorder.ts:147-158 tolerates a partial final JSON line while scanning, but finalizeResume:285 appends directly to it. A deliberately torn tail produced one invalid concatenated line and zero valid gap events. Resume now truncates a malformed unterminated tail before append, or adds a newline after an intact final JSON value. Regression checks every resulting line parses and the gap marker survives. No judgment required.

### MR-08 — Initial/resumed deck selection was absent from recordings (P2, applied including root callback wiring)

Original recorder start/resume emitted decks/status only. index.ts:1158 recorded selection only when it later changed, so the simulator's selection strip omits the first part of the show and selection at resume. Added optional getSelectedDeck callback and selected events at both keyframes. Regression covers initial selection and recovered selection. No judgment required.

### MR-09 — Recorder abort and replay arm could finish after a conflicting command (P2, applied)

Original abortPendingResume() fire-and-forgets lock removal; start can replace the lock before that removal completes. Recorder operation serialization now awaits removal. Original replay.arm loads files asynchronously and then unconditionally changes mappings/state; disarm during read is undone when loading finishes. Reproduction ended in armed after disarm. A generation guard now cancels obsolete arm work. isArmedOrActive includes loading synchronously for mutual exclusion with REC. User selected recording/armed-replay exclusivity; root has integrated route/automatic-resume guards against the synchronously reserved lifecycle state. Regression covers disarm during loading.

### MR-10 — Worker startup and transport failures left promises unresolved (P1, applied)

Original waveformWorker.ts:451-460 logs init failure without signaling rejection; index awaits initialization before starting the server. Invalid cache root reproduction stayed unresolved after 400ms. Original waveformService.ts:44-52 drops the worker on exit without rejecting pending extraction jobs; post():146-153 swallows clone/transfer errors after requestExtraction stores its resolver. Reproduction with an untransferable buffer remained pending. Added explicit initError IPC, startup exit rejection/cleanup, shared initialization promise, job rejection on worker exit, and synchronous postMessage error propagation/removal. Regressions cover startup failure/retry and untransferable buffers. No judgment required.

### MR-11 — A waveform-only cache falsely meant artwork was known absent (P2, applied)

Original waveformWorker.ts:141-163 creates an artwork=null frame for every waveform key even when no artwork cache exists. Main ingest then records a negative artwork cache hit. OnTrackChanged sees both caches as complete and never tries to recover missing artwork after interrupted extraction. Reproduction loaded one peaks file and zero artwork files, yet artworkFrameCache.has returned true. Cache IPC now represents missing artwork with a null frame, distinct from a persisted no-artwork result. Regression covers this distinction. No judgment required.

### MR-12 — Deduplicated extraction hid failure and reread disk unnecessarily (P2, applied)

Original worker:185-211 catches and ignores the first same-file job failure, then reads absent caches and returns a successful result for the second caller. Two concurrent invalid MP3 requests reproduced job 1=error, job 2=result with peaksFrame=null. Jobs now share the actual extraction result/rejection; every waiter receives the same failure, no disk round-trip is needed, and an artwork-only shared job cannot satisfy a subsequent peaks request without doing that work. Regression asserts both callers reject. No judgment required.

### MR-13 — Temporary audio filenames could collide (P2, applied)

Original worker:216-222 uses only eight MD5 hex characters of content plus extension for the shared OS temp path. Concurrent differently named copies of the same audio necessarily choose the same path; one job's finally can remove/truncate another job's input. Separate processes also collide. Replaced this with fs.mkdtemp and a private input path. Both parallel extraction branches settle before temporary-directory removal. Source-level proof; no live media/device access required. No judgment required.

### MR-14 — Waveform reduction held two full decoded PCM copies (P2, applied)

Original worker:398-425 retained every PCM chunk and Buffer.concat allocated a second full PCM buffer before peak reduction. At 8kHz mono 16-bit, a one-hour file adds about 115MB of transient PCM allocations, excluding original audio and concurrent jobs. PCM is now reduced incrementally across arbitrary byte/chunk boundaries, retaining only peak output and one partial sample/window. Progress posts only when the displayed percentage changes. Full-scale -32768 samples are clamped to the advertised 0..1 range (previously slightly above 1). A real ffmpeg WAV fixture checks final partial peak, exact values, sampling density and full-scale clamp. No judgment required.

### MR-15 — Custom artwork extraction duplicated a maintained parser and misidentified WebP (P2, applied)

Original worker:353-379 always spawns ffmpeg and guesses JPEG unless two bytes resemble PNG/GIF/WebP. WebP starts with RIFF, not WE, so the WebP branch is wrong. The worker now uses Chris Le's metadata-connect createBufferReader/extractMetadata over already downloaded audio, returning its artwork/MIME for supported tags. ffmpeg remains the fallback for unsupported containers/tags or missing parser artwork; file-type's maintained ESM detector identifies fallback image bytes. Direct dependencies declare metadata-connect ^1.2.0 and file-type ^21.3.1; root installed 1.2.2/21.3.4 after checking advisories. The fixture intentionally removes ffmpeg from PATH and still extracts embedded PNG artwork, proving use of the parser. Waveform decoding itself is not provided by StageLinq/metadata-connect.

### MR-16 — Replay snapshots fabricated fresh position data during audio dropout (P1, applied with shared timeline integration)

Original stateProvider.ts:49-55 always reports fresh/connected during override, while index.ts:1429 pushes every snapshot with bumpBeat=true. The worker therefore cannot use the documented freewheel mode when backup audio samples stop; replay instead emits play=false. Added SourceTiming plumbing: real audio BeatInfo revision/capture time controls replay freshness, repeated snapshots cannot refresh it, watchdog play=false without transport revision cannot issue a deliberate pause, and explicit audio pause/resume/end do update transport revisions. Only actual recorded position events generate replay deck position revisions, so missing recorded positions are not laundered into fresh data just because backup audio moves. Record position time is projected against the audio clock. Regressions cover missing audio position, synthetic reset, explicit pause, fresh recovery, and a gap between recorded positions. Root/bridge agent has integrated live SourceTiming and worker input plumbing; the separate PR-03 peer-review atomic source handoff is being finalized. User approved correcting freshness/position inputs while retaining existing freewheel controls.

### MR-17 — Offline simulator duplicated the live timing algorithm and used metadata as heartbeat (P2, applied)

Original simulateTimecode.ts:295-399 copied doSend, and 519-531 used any deck event globally as freshness. Changing title/BPM on one deck masks a missing position source on another; future live fixes silently diverge. Simulator now imports the pure TimecodeTimeline used by Art-Net, deriving per-deck timing from recorded elapsedSec/keyframes and play changes. Offset, latency and clamp application match the live worker. Shared corrected flag supplies source-correction counts. A synthetic recording with only metadata after its initial position now freewheels even while those metadata events continue. Legacy logs lack raw repeated BeatInfo and explicit-versus-watchdog provenance; HTML/JSON disclose that limitation. Detailed real-log comparison below.

### MR-18 — Simulator input and offset edge cases produced incorrect results (P2, applied)

Original simulator:461 treats an explicitly saved empty offset map as absent, so later live config silently changes that recording. It now respects empty maps. Numeric CLI arguments accepted Infinity/zero/negative values (tickHz=Infinity can lead to an infinite loop); finite/positive or nonnegative validation now rejects them. Zero-duration graphs no longer divide by zero. Config fallback checks both backend cwd and its parent, uses the shared config parser, and handles out-of-range current_playlist consistently with the live offset builder. Regression covers empty saved offsets and Infinity rejection. No judgment required.

### MR-19 — Mapped backup audio was suppressed only after ARM (P2, applied including root config hooks)

Original replay.ts initialized mappedAudioFiles empty and clears it on disarm, despite README/memory promising mapped long recordings are never scanned. Loading a configured backup while idle therefore downloads/decodes a potentially hour-long file. configureMappedAudioFiles now manages that set independently of arming, and disarm retains it. Root has integrated these calls on boot/config reload. Regression verifies suppression persists across disarm and updates when mappings are removed. No judgment required.

### MR-20 — Empty or invalid recordings could arm successfully (P2, applied basic validation)

Original replay.parseLog silently skipped malformed lines and arm accepted zero deck events/duration 0. A file containing only 'not a recording' returned ok=true and could replace outputs with blanks. Parser now requires a valid header and usable keyframe, checks finite event timestamps/keyframe positions and recorded offsets, supports version 1, and sorts deck events by time. Regression rejects the invalid log. More complete per-diff validation remains recommended in MR-29.

## Follow-up findings and implementation status

### MR-21 — Media cache identity is still only the basename (P2, applied follow-up)

Full network identity flows through DeckState.mediaId, jobs, manifests, IPC, WS trackId and browser maps. Basenames remain display/playlist/replay keys. Legacy caches are ignored; same-path replacement still requires version/mtime metadata or manual invalidation. Collision/cold-replay tests cover this.

### MR-22 — Artwork disk keys can exceed filesystem filename limits (P2, applied follow-up)

SHA256 identity names have fixed length even for long Unicode paths. Validated manifests retain the original identity. Long-name tests cover filesystem limits.

### MR-23 — Stale artwork sentinel/extension siblings can win nondeterministically (P2, applied follow-up)

One atomic versioned manifest stores positive/absent/missing artwork state with peaks. Legacy extension/sentinel siblings cannot override it. Transition/corruption tests cover deterministic replacement.

### MR-24 — Media work and caches remain unbounded (P2, applied follow-up)

Lazy startup avoids bulk reads. Backend/browser LRUs and count/byte admission limits bound retained media/work. MediaCoordinator bounds downloads before extraction and cancels obsolete tracks. Budgets are documented in README/integrity-followup.md; disk retention remains operator-controlled.

### MR-25 — Recording does not capture config changes or complete timing provenance (P2, applied follow-up)

Schema v2 records monotonic event time, applied offsets/playlist references and position/explicit transport provenance, including equal-position heartbeats and transportPlay. Replay/simulator support v1/v2 and historical offset changes. Global output/freewheel settings remain live; missing legacy provenance cannot be reconstructed.

### MR-26 — Recorder ignores backpressure and whole-log parsing can block show work (P2, applied follow-up)

Accepted writes honor drain/backpressure with an 8 MiB bound; overflow stops visibly and retains recovery state. Incremental cooperative parsing replaces whole-file text/split; duplicate mappings share parsed logs. Checkpoints every 1,024 deck events bound seek reconstruction. Parsed events remain in memory while armed.

### MR-27 — Recording timestamps use an adjustable wall clock (P2, applied follow-up)

Event elapsed time uses a monotonic clock with a fixed resume offset. Wall time labels files and estimates crash gaps from mtime. Clock-jump regression verifies order/duration remain stable.

### MR-28 — Worker shutdown is still a timer, not a drain/cancel protocol (P2, applied follow-up)

Child-aware cancellation/shutdown tracks processes and temporary inputs, stops admission and drains cleanup. Two-minute deadlines and bounded worker termination have main-thread child/temp cleanup. Tests cover cancellation, stalled children and shutdown/restart.

### MR-29 — Corrupt interior log diffs and caches are only partially validated (P2, applied follow-up)

The shared loader validates core deck/config/timing events and reports interior corruption with line numbers. Only a torn final line is recoverable; deliberately optional future events are allowed. Manifests validate version/identity/density, finite ranged peaks, artwork encoding/digest/MIME and sizes.

### MR-30 — Artwork-only failures can persist a false no-artwork result (P2, applied follow-up)

metadata-connect remains first choice; parser rejection reaches ffprobe/ffmpeg fallback. Only validated no-cover inspection persists absence. Unsupported/broken artwork remains retryable; valid peaks can still return. Tests cover fallback and artwork-only failures.

### MR-31 — Cue extraction leaves stale cache entries when cues disappear (P2, proposed)

extractCues.ts:342-345 skips NULL/missing PerformanceData.quickCues without clearing an existing cache file. Re-running after removing cues can retain old cue markers. Runtime currently does not consume this cache, so impact is on offline artifacts/future consumers. Proposed fix: write an explicit empty validated cue entry for a found track with no cues (or remove only that track's old entry), and report missing/decode-failed tracks separately without pretending stale data was refreshed. No user-policy uncertainty for confirmed empty cues.

### MR-32 — Cue filename matching can select the wrong track or miss a supported path (P2, proposed)

extractCues.ts:229 stores raw song_index, but the live app normalizes basenames; a path-valued song_index can work for timecode while the cue SQL lookup fails. SELECT id WHERE filename = ? returns only the first row if duplicate basenames exist. read_cues.py:111-113 additionally treats filename underscores/percent signs as LIKE wildcards. Temporary SQLite reproduction requesting track_1.mp3 returned id 1 for the different file trackA1.mp3. Proposed fix: normalize consistently, escape LIKE wildcards if fallback is retained, reject ambiguous matches, and prefer source/path identity where available. User judgment: choose the intended source when a library actually contains ambiguous duplicates; never guess the first row.

### MR-33 — Cue tooling has portability/read-only/documentation gaps (P3, proposed)

extractCues.ts:302 derives filesystem paths from URL.pathname, so spaces/non-ASCII escapes in the checkout path produce nonexistent percent-encoded paths; use Node fileURLToPath. read_cues.py opens SQLite without mode=ro and repeatedly opens two connections per track; use a shared read-only URI connection with context/finally cleanup. The TS header says runtime reads hotcue-cache at boot, but actual worker and memory.md correctly show no consumer yet. Fix that misleading comment. Python helper has no caller in the local repo and duplicates the TypeScript blob decoder; clarify/archive its intended external use or share fixtures to prevent format drift. Do not replace the standalone read-only script with StageLinq.DbConnection: that API opens a writable connection and provides no quickCues decoder.

### MR-34 — Simulator chart decimation can hide short gaps (P3, proposed)

Original/current simulator keeps roughly 3,000 uniformly sampled points per deck. For a 72-minute show that is about 1.4s between displayed points; a shorter silent interval can vanish, and buildPath then draws a line across it. nearestPoint is a lower-bound lookup, not the closest point, so hover can display a future sample up to one decimation interval away. Proposed fix: always retain transitions/gap boundaries/extrema in addition to regular points; choose actual nearest neighbor or label tooltip as sampled. Aggregate counts are independent of plot decimation. No judgment required.

### MR-35 — Pitched backup audio is not fully reflected in interpolation/freewheel rate (P2, proposed)

Cross-review confirmed that TimecodeTimeline extrapolates using output DeckState.speedState, which is the recorded live deck's rate. Replay indexes recorded events with the backup audio clock, but does not pass the backup deck's own pitch multiplier to the timeline. Its projection of a recorded position timestamp also subtracts the recording-clock delta as if that delta elapsed at 1x wall time. At +20% backup pitch, fresh recorded events still advance the cursor, but between those events and during dropout the projected timecode runs at the recorded rate rather than recorded-rate × 1.2. This is a source-level finding; no complete pitched-backup fidelity validation is claimed.

Current documented/default usage is unpitched backup audio; README already says not to pitch backup because emitted currentBpm remains the recorded value. This pass does not change that behavior. Proposed fix: explicitly carry the backup playback rate into replay timing; project recorded event age using the backup audio rate, and extrapolate with (1 + recordedSpeedState/100) × (1 + audioSpeedState/100). Keep the telemetry/OSC policy explicit instead of silently rewriting the recorded currentBpm or historical deck speed display. Add deterministic +20% backup-rate tests covering fresh interpolation, pause/resume, seek and dropout/freewheel before claiming rate fidelity. User judgment: decide whether BPM/OSC remains historical or should scale with pitched backup; timecode rate fidelity itself should follow the audible backup when this feature is supported.

## Standardization decisions

Applied: metadata-connect for tagged embedded artwork; file-type for fallback MIME detection; Node stream/promises.finished for recorder flush/error propagation; fs.mkdtemp for collision-free temporary input; one shared TimecodeTimeline for live and offline timing; shared config parser for simulator config.

Kept intentionally: ffmpeg PCM decoding/peaks because neither StageLinq nor metadata-connect supplies the display waveform. Kept the read-only cue SQL/decoder because the actual upstream APIs do not provide this Engine PerformanceData decoder and upstream DbConnection would weaken read-only guarantees. Kept serialized per-device file transfer because upstream range/full-transfer internals are not atomic across concurrent clients (bridge agent audited this separately).

Further optimization: when peaks already exist and only artwork is missing, StageLinq.extractMetadataFromDevice can read selected ranges rather than download the whole audio file. It must run inside the same bridge per-device queue; using it beside a full download would reintroduce transfer races. Apply metadata-connect locally to already downloaded audio otherwise. This is proposed, not claimed implemented.

## Validation and results

Before fixes: temporary reproductions confirmed stuck attaching, seek high-water freeze, ended latch, invalid log accepted, arm undoing disarm, simultaneous starts, stop/start lock deletion, swallowed async write error, torn-tail gap loss, invented negative artwork cache, unresolved initialization/postMessage promises, and inconsistent dedup failure. Python SQLite reproduction confirmed unescaped LIKE matches the wrong filename. All fixtures and generated outputs are under /private/tmp; no device/UDP/hardware operations were used.

Backend TypeScript build passed after root installed dependencies and integrated timing APIs. Initial new suite: 17/17 tests passed, including real ffmpeg PCM reduction and metadata artwork with ffmpeg deliberately unavailable. One additional recorded-position-gap regression was then added; final count/update below.

Real log: recordings/2026-06-18T20-32-59-281Z.jsonl, 159,637 deck events, 23 selections, 4,313.9 seconds, 129,418 simulation ticks at 30Hz. Both baseline and corrected runs wrote standalone HTML/JSON under /private/tmp.

| Deck | Old corrections | Shared-timeline corrections | Old freewheel spans | New freewheel spans | New emitted samples |
|---|---:|---:|---:|---:|---:|
| 1 | 177 | 45 | 46 | 58 | 81,631 |
| 2 | 205 | 60 | 52 | 66 | 71,560 |
| 3 | 0 | 0 | 0 | 0 | 0 |
| 4 | 30 | 18 | 4 | 4 | 7,740 |

The larger per-deck freewheel counts are expected: another deck's/metadata events no longer mask missing position data. These values are analytical output, not captured hardware packet statistics. Legacy data cannot establish every actual heartbeat or transport cause. Artifacts: /private/tmp/slwv-audit-tc-analysis.html, /private/tmp/slwv-audit-tc-analysis.json, /private/tmp/slwv-audit-tc-corrected.html, /private/tmp/slwv-audit-tc-corrected.json.

Final focused validation update: backend build passed and 18/18 media/recording/replay/simulator tests passed, with no skips. A final small recorder change reuses root's shared atomic writeJsonFile for the sidecar; this avoids partial metadata making a completed log disappear from the recordings list after interruption. Recorder integration tests are rerun after that change. Treat this as part of MR-05 (applied), not a new unimplemented item.

Final atomic-sidecar follow-up verified: backend TypeScript build passed; all 11 recorder/replay regressions passed again; media-owned tracked-file git diff --check passed. The other seven media/simulator tests passed in the immediately preceding 18-test run and their code did not change afterward. No commits or pushes were made by this child agent.

Root integration status update: MR-03/06/08/09/19 are implemented end to end by root plus media APIs. PR-03 atomic source/offset handoff remains a separately tracked peer-review blocker until root/bridge finishes its transition regression. MR-35 is explicitly remaining; no pitched-backup behavior was changed.
