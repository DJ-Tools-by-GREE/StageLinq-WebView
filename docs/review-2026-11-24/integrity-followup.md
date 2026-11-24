# Transfer, media-cache and recording integrity follow-up

The user selected these categories for implementation and requested that other findings remain documented. The changes span the linked local StageLinq package and WebView. There is no npm publication or dependency-version change.

## Implemented

| Area | Behavior after this change | Findings |
|---|---|---|
| Package transfers | Full/range/stat/source calls serialize; empty files, failures, abort and timeout release state/listeners/timers. Unsafe streams close before lazy reconnect. Full downloads accept a pre-allocation byte limit. TCP connect deadlines destroy/reject stalled sockets and are cleared for healthy connections. | BO-15, TP-01 |
| WebView transfers | Each request captures its session/service manager. Obsolete tracks and session resets cancel queued/active work. Polling is abortable, progress listeners detach, and queue tails are removed by identity. Two total download-through-extraction jobs bound retained inputs. | BO-16 |
| Media identity/cache | Full network source/path identifies jobs, manifests, IPC, WS and browser media. SHA256 names avoid filesystem limits. Atomic versioned manifests replace extension/sentinel races and validate identity, density, peaks, artwork digest/MIME and sizes. Startup is lazy. | MR-21/22/23/29-cache |
| Media resources | Backend cache: 128 MiB / 32 entries; browser: 64 MiB / 24, with active preference and URL revocation. Input/download limit: 256 MiB; worker audio admission: 256 MiB; eight pending callers; one extraction job, at most two children. Two-minute deadline; abort/shutdown drains tracked children and temporary inputs, with forced cleanup as fallback. | MR-24/28, FE-11, TP-02 |
| Artwork correctness | metadata-connect first; parser rejection reaches ffprobe/ffmpeg fallback. Confirmed absence is distinct from unsupported/failed extraction. Usable peaks can survive artwork failure without persisting false absence. | MR-30 |
| Replay media | Historical output identities lazily load cache-only media after restart. They never trigger downloads from a historical device path. Real backup-audio beats do not clear replay cache requests/pins. | TP-03 |
| Recording fidelity | Schema v2 carries applied offset/config events, position heartbeats and explicit transport revisions/state. Event times use monotonic elapsed time. Replay follows historical offset maps; checkpoints preserve transport provenance inside watchdog intervals. | MR-25/27 |
| Recording integrity/scaling | Backpressure-aware accepted-data queue bounded to 8 MiB, 1 MiB event limit; visible failure rather than silent event loss. Incremental cooperative parsing validates core events with line errors; torn trailing lines remain recoverable. Mappings share parsed logs; checkpoints every 1,024 deck events accelerate forward/backward seeks. Completed orphan footers repair missing sidecars; corrupt recovery remains visibly blocked until explicitly discarded. | MR-26/29-log |

## Compatibility and operator notes

- The local StageLinq checkout remains the dependency. Existing getFile(path) callers work; the new optional arguments are AbortSignal and maxBytes. getFileRange/getFileSize/getSources also accept an optional AbortSignal. Internal serialization complements the bridge queue.
- Media WS frames now require trackId, matched against DeckState.mediaId. fileName remains the human label and the existing basename key for playlists/replay mappings. External media clients must adopt trackId; rebuild/reload the included frontend and backend together.
- Legacy basename caches remain untouched but are ignored; tracks regenerate on demand. New manifests live below WAVEFORM_CACHE_DIR/media-cache-v1. Disk retention is not automatic. Replacing contents at the identical path requires invalidation until a device version/mtime source is available.
- ffmpeg and ffprobe must both be on PATH. metadata-connect still handles supported embedded artwork first.
- Version 1 logs still load. Timing missing from old logs is inferred; crash-resumed legacy logs may contain mixed provenance. v2 logs add data that older consumers may not understand. Full global output/freewheel configuration remains live; the historical configuration recorded here is offsets plus playlist reference.
- Bounds describe retained payloads/admitted work, not total RSS, transient JSON parsing or decoded browser/GPU images. Active media exceeding the entire cache budget may be evicted. Armed replay retains parsed events in memory; parsing yields between batches instead of using another worker.
- A visible recording failure leaves an incomplete log and recovery lock. Accepted events drain if storage allows. Interior corruption does not silently disappear. Explicit resume-abort discards recovery selection, preserving the log file.

## Validation

Final integration validation: full linked-package/frontend/backend build passed; all 140 WebView tests passed with zero skips/failures. StageLinq build and all 284 tests across 25 files passed; its existing Vitest unawaited-assertion warning remains. Both repositories pass git diff --check. The legacy 72-minute simulation remains unchanged (159,637 deck events, 129,418 ticks; D1/D2/D4 corrections 45/60/18). No live hardware or npm publication was performed. Tests include empty/failure/abort/reconnect transfer recovery, a genuinely stalled TCP connection, same-basename identities, Unicode cache keys, manifest corruption, positive/absent transitions, LRU and queued-audio bounds, resistant child-process cancellation, metadata/ffmpeg extraction, cold replay cache loading, monotonic recording, backpressure/overflow, torn/interior logs, missing sidecars, historical offsets, transport provenance and checkpoint seeks. HTTP integration binds only loopback and stubs hardware.

The checked-in legacy 72-minute recording parses as 159,637 deck events over 4,313,902 ms with 155 seek checkpoints. Live Denon devices, console output, real packet-loss behavior and browser/tablet GPU performance have not been tested.

## Deliberately deferred

The original reports retain concrete fixes for: multi-device deck assignment; OSC deselection/hold; remaining socket recovery diagnostics; QuickLoop/short-clip unit ambiguity and metadata ordering; pitched-backup interpolation/BPM policy; 29.97 drop-frame support; full configuration/environment validation; modal keyboard/focus/accessibility and target-device checks; cue-helper matching/read-only/portability work; simulator chart decimation; platform-aware show runner; dependency advisories; and disk/log retention. Artwork-only remote metadata range extraction is still a proposed optimization. See the [remaining roadmap](README.md#remaining-work-ordered-by-practical-impact) and area reports.
