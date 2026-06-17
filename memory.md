# Project memory — StageLinq WebView

Active architectural decisions and known quirks. Update **immediately** on any
decision/bug-confirmation/direction change (per CLAUDE.md).

---

## Architectural decisions

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
