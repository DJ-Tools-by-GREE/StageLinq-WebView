# CLAUDE.md — StageLinq WebView

Project-level instructions for Claude Code. Read this before touching any file.

---

## Working Rules

### Zero Guesswork
If you are unsure about an approach, missing context, or lack information about hardware behavior, network topology, protocol details, or project intent — **stop and ask**. Never assume, infer silently, or proceed with a guess. One clarifying question is always better than a broken show.

### StageLinq Package Context
The source ZIP of the upstream StageLinq library is at **`StageLinq-main.zip`** in the repo root (there is also a `project.zip` snapshot). When diagnosing issues with `@gree44/stagelinq` behavior — event names, payload shapes, undocumented quirks — extract and read the ZIP source first rather than guessing from type definitions alone.

### Maintain Project State (`memory.md`)
Keep **`memory.md`** at the repo root up to date. It tracks:
- Active architectural decisions and their rationale
- Known hardware quirks and workarounds
- Current in-progress work and blockers
- Anything that would be painful to re-derive from git history

Update it **immediately** whenever a decision is made, a bug is confirmed, or the direction changes. Do not batch updates.

### Auto-Update Documentation
Whenever a change affects setup, architecture, configuration schema, environment variables, API endpoints, or core features — **update `README.md` in the same commit**. The README is the primary operator reference; it must stay accurate.

### Self-Evolving Instructions
If a new workflow, convention, or constraint emerges during our work that is worth standardizing, **proactively suggest an update to this file** (or make it directly if clearly correct). These instructions should reflect how we actually work, not an idealized snapshot from day one.

### Commits
Never commit unless explicitly asked. Stage and edit freely, but leave `git commit` to the user.

### Branch
Work on `main` by default. Only switch to or create another branch when the user says so.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22+ (ESM, `"type": "module"`) |
| Backend language | TypeScript 5.x, compiled with `tsc` |
| Backend framework | Express 4 + `ws` (WebSocketServer) |
| Backend dev runner | `tsx watch` (no build step during dev) |
| StageLinq protocol | `@gree44/stagelinq` (npm package; ZIP source at root) |
| Art-Net output | Raw UDP via Node `dgram` (in `artnetTimecode.ts`) |
| sACN input | `sacn` npm package |
| OSC output | Raw UDP (in `oscBpm.ts`) |
| Frontend language | TypeScript + React 18 |
| Frontend bundler | Vite 5 |
| Monorepo | npm workspaces (`backend/`, `frontend/`) |
| Process manager | PM2 (production / live-show deployments) |

---

## Directory Structure

```
StageLinq-WebView/
├── CLAUDE.md                   # ← you are here
├── memory.md                   # project state & decisions (maintain actively)
├── README.md                   # operator reference (keep in sync with changes)
├── config.json                 # runtime config (Art-Net, sACN, OSC, playlists)
├── StageLinq-main.zip          # upstream StageLinq library source (reference)
├── project.zip                 # full project snapshot
├── package.json                # workspace root; top-level dev/build/start scripts
├── receiveSacn.js              # standalone sACN debug script (not part of the app)
├── backend/
│   ├── src/
│   │   ├── index.ts            # entry point: Express, WebSocket, snapshot loop, sACN input
│   │   ├── stagelinqBridge.ts  # StageLinq event wiring, deck state, watchdog
│   │   ├── artnetTimecode.ts   # Art-Net SMPTE timecode broadcaster (UDP)
│   │   ├── oscBpm.ts           # OSC BPM sender (UDP)
│   │   ├── waveformService.ts  # waveform peak extraction + artwork extraction; in-memory + disk cache
│   │   ├── camelot.ts          # key index (0–23) → Camelot notation string
│   │   ├── constants.ts        # all tunable timing/threshold values in one place
│   │   ├── logging.ts          # configurable debug-channel logging
│   │   └── types.ts            # DeckState, WsPayload, DeckNumber
│   ├── dist/                   # compiled output (gitignored / not hand-edited)
│   ├── package.json
│   └── tsconfig.json
└── frontend/
    ├── src/
    │   ├── App.tsx             # WebSocket client, 4-quadrant layout
    │   ├── DeckCard.tsx        # per-deck display component
    │   ├── HeaderBar.tsx       # top bar: selected deck, BPM, next track display
    │   ├── WaveformDisplay.tsx # waveform peak renderer
    │   ├── types.ts            # shared types (mirrors backend types.ts)
    │   ├── appTypes.ts         # frontend-only types (WaveformState, etc.)
    │   ├── main.tsx            # React entry point
    │   └── styles.css          # global styles
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    └── vite.config.ts
```

---

## Common Commands

```bash
# Development (backend only — serves UI on :8090)
npm run -w backend dev

# Development (frontend HMR on :5173, proxies /ws + /api to backend)
npm run -w frontend dev

# Production build (frontend → backend)
npm run build

# Production start
npm start

# Hot-reload config without restart (while backend is running, TTY only)
# Press Ctrl+R in the terminal

# PM2 (live-show persistent service)
npm run build
pm2 start npm --name stagelinq-webview -- start
pm2 logs stagelinq-webview
pm2 restart stagelinq-webview
```

---

## Architecture Overview

```
Denon Prime 4+  ──StageLinq UDP──►  StageLinqBridge  ──► DeckState[1..4]
                                                              │
                                          ┌───────────────────┤
                                          ▼                   ▼
                                   ArtNetTimecode      OscBpmSender
                                   (UDP → lighting)    (UDP → console)
                                          │
                                   Express + WS (30 Hz)
                                          │
                                     Browser UI
                                   (React, 4 decks)

Control input: sACN universe → DMX channel → selected deck index
               (thresholds: 0–50 off, 51–101 D1, 102–152 D2, 153–203 D3, 204–255 D4)
```

**Key data flows:**
- `beatMessage` → elapsed time (samples / sampleRate), live BPM, watchdog heartbeat
- `message` / `stateChanged` → play state, track metadata, key, fader, speed
- `nowPlaying` → high-level track metadata (title, artist, fileName)
- Snapshot loop at `WS_FPS` (default 30 Hz) broadcasts `SnapshotPayload` to all WebSocket clients

---

## Configuration

Settings layer order (highest → lowest priority): **env vars → `config.json` → hardcoded defaults**.

`config.json` lives at the repo root (or `backend/`). All fields optional. See README for the full table of env vars. Key sections:

| Section | Purpose |
|---|---|
| `timecode` | Art-Net target IP/port, FPS |
| `control_input` | sACN universe and DMX address for deck selection |
| `osc` | OSC BPM output target, enabled flag, SpeedMaster channel |
| `playlists` | Per-track timecode offsets (matched by normalized filename) |
| `current_playlist` | 0-indexed active playlist |

---

## Coding Conventions

- **ESM throughout** — always use `.js` extensions in import paths (TypeScript resolves them to `.ts` during dev via `tsx`).
- **No barrel files** — import directly from the source module.
- **All tunable constants in `constants.ts`** — never hardcode timing thresholds or magic numbers elsewhere.
- **Logging via `logging.ts` channels** — never use `console.log` directly. Use `logLifecycle`, `logError`, `logPlayback`, `logDiscover`, etc.
- **No comments by default** — only add one when the WHY is non-obvious (hidden constraint, protocol quirk, hardware workaround). Never describe WHAT the code does.
- **Prefer `unknown` + narrowing over `any`** — `any` is allowed only at third-party library boundaries (StageLinq, sACN) where types are absent or wrong.
- **Frontend types mirror backend** — keep `frontend/src/types.ts` in sync with `backend/src/types.ts` by hand; do not generate or share a package between them.

---

## Error Handling

- **System boundaries only** — validate at external inputs (sACN packets, StageLinq messages, config file) not internal calls.
- **Ignorable StageLinq errors** — `isIgnorableStageLinqError()` in `index.ts` filters known non-fatal library noise. Add to this list when a new ignorable pattern is confirmed, not speculatively.
- **Crash vs. continue** — `uncaughtException` / `unhandledRejection` exit with code 1 unless the error is explicitly ignorable. Do not swallow unknown errors.
- **WebSocket send errors** — always wrap in `try/catch`; a closed socket must not crash the broadcast loop.
- **StageLinq reconnect** — the watchdog in `StageLinqBridge` handles per-deck stale beat detection and global disconnect detection. Reconnect retries indefinitely with `RECONNECT_DELAY_MS` delay. Do not add additional retry logic outside this mechanism.

---

## Hardware Notes

- Target hardware: **Denon SC6000 / Prime 4+** running Engine DJ firmware.
- `@gree44/stagelinq` emits both flattened (`{ deck: 0..3, ... }`) and aggregated (`{ decks: [...] }`) `beatMessage` payloads depending on firmware version — `stagelinqBridge.ts` handles both.
- `TrackLength` may arrive in **samples** (not seconds) on some firmware builds. The bridge defers conversion until `SampleRate` is known, using `pendingTrackLengthSamples`.
- Key index 0–23 maps to Camelot via `camelot.ts`. If a device uses a different order, override with the `KEY_MAP` env var.
- Known non-fatal library errors: `"No broadcast targets have been found"`, `"File Transfer Unhandled message id '6'"`.

---

## WebSocket Protocol

Port `8090` (configurable via `PORT` env). Path `/ws`.

```jsonc
// hello (sent once on connect)
{ "type": "hello", "ts": 1234567890, "version": "0.1.0", "fps": 30 }

// snapshot (sent at WS_FPS, default 30 Hz)
{
  "type": "snapshot",
  "seq": 42,
  "ts": 1234567890,
  "selectedDeck": 1,       // DeckNumber | null — currently sACN-selected deck
  "nextTrack": "song.mp3", // string | null — next track filename if available
  "decks": {
    "1": DeckState,
    "2": DeckState,
    "3": DeckState,
    "4": DeckState
  }
}

// waveform_status (sent during peak analysis)
{ "type": "waveform_status", "deck": 1, "stage": "downloading" | "analyzing" | "done" | "error", "progress": 0.0–1.0, "fileName": "..." }

// waveform_data (sent when peaks are ready)
{ "type": "waveform_data", "deck": 1, "fileName": "...", "peaks": number[], "peaksPerSec": number }

// artwork_data (sent when artwork is ready or absent)
{ "type": "artwork_data", "deck": 1, "fileName": "...", "data": "<base64>" | null }
```

`DeckState` fields: `deck`, `trackLoaded`, `fileName`, `title`, `artist`, `elapsedSec`, `totalSec`, `currentBpm`, `trackBpm`, `speedState`, `keyIndex`, `keyCamelot`, `fader`, `play`, `updatedAt`, `hotCues`, `loopActive`, `loopInSec`, `loopOutSec`, `savedLoops`.

---

## REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check → `{ ok: true, ts: number }` |
| `GET` | `/api/timecode/send-when-stopped` | Query "send timecode while paused" flag |
| `POST` | `/api/timecode/send-when-stopped` | Set flag; body: `{ "enabled": true \| false }` |
| `GET` | `/api/artwork/:deck` | Serve cached artwork image for deck 1–4 (Content-Type from file) |

---

## Deck Color Accents

| Deck | Accent |
|---|---|
| 1 | Purple / Magenta |
| 2 | Blue |
| 3 | Green |
| 4 | Red |
