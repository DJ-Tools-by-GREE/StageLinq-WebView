# StageLinq WebView

Real-time DJ deck visualizer for Denon Prime 4+ (Engine DJ / StageLinq). Displays all 4 decks in a browser, broadcasts Art-Net SMPTE timecode, and accepts DMX/sACN control input — all from a single Node.js server.

## Features

**Web UI**
- 4-quadrant dark-theme layout, one deck per quadrant
- Per deck: title, artist, artwork placeholder, elapsed/total/remaining time, key (Camelot notation), current BPM, derived track BPM, relative pitch %, channel fader, waveform placeholder
- Live connection status badge (LIVE / OFFLINE)
- Overlay button to toggle timecode transmission while playback is stopped
- WebSocket stream at 30 Hz

**Art-Net timecode output** (optional)
- Broadcasts the active deck's playhead as SMPTE timecode over UDP Art-Net
- Configurable FPS, target IP/port, deck selection, and latency compensation
- Drift detection and re-sync; suppresses frames before 00:00:00:00 and after track end
- Per-track offset mapping via `config.json` for alignment with external systems

**sACN / DMX control input** (optional)
- Receives a single DMX channel over sACN to select which deck's timecode is broadcast
- DMX thresholds: 0–49 → off, 50–100 → deck 1, 101–151 → deck 2, 152–202 → deck 3, 203–255 → deck 4

**OSC BPM output** (optional)
- Sends BPM to an OSC-compatible device when a deck is active via sACN
- Format: `/cmd "Master 3.<channel> At BPM <bpm>"`

## Prerequisites

- Node.js 22+
- Denon Prime 4+ (or compatible Engine DJ device) on the same LAN as this server

## Install

```bash
npm install
```

## Development

Start the backend (serves the UI on port 8090, connects to StageLinq, streams WebSocket):

```bash
npm run -w backend dev
```

Open `http://<this-pc-ip>:8090/`

Optionally run the frontend dev server with Vite HMR in a second terminal (proxies `/ws` and `/api` to the backend):

```bash
npm run -w frontend dev
```

## Production

```bash
npm run build   # builds frontend then backend
npm start       # runs built backend, which also serves the frontend
```

## Configuration

Settings can be provided as **environment variables** or in an optional **`config.json`** file at the repo root (or in `backend/`). Environment variables take precedence.

Hot-reload: press **Ctrl+R** in the terminal running the backend to reload `config.json` without restarting.

### General

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8090` | HTTP and WebSocket port |

### Art-Net timecode

| Variable | Default | Description |
|---|---|---|
| `ARTNET_ENABLED` | `true` | Enable Art-Net timecode output |
| `ARTNET_TARGET_IP` | `255.255.255.255` | Destination IP (broadcast or unicast) |
| `ARTNET_PORT` | `6454` | Destination UDP port |
| `ARTNET_DECK` | `1` | Deck to broadcast (overridden by sACN input) |
| `ARTNET_FPS` | `30` | Timecode frame rate — valid values: `24`, `25`, `29.97`, `30` |
| `ARTNET_SEND_HZ` | *(same as `ARTNET_FPS`)* | UDP send rate in Hz (override to send faster than FPS tick rate) |
| `ARTNET_LATENCY_COMP_MS` | `80` | Latency compensation in milliseconds |

### sACN control input

| Variable | Default | Description |
|---|---|---|
| `CONTROL_INPUT_MODE` | `sacn` | Set to `none` to disable |
| `SACN_UNIVERSE` | `20` | sACN universe to listen on |
| `SACN_ADDRESS` | `1` | DMX channel (1-indexed) |

### OSC BPM output

| Variable | Default | Description |
|---|---|---|
| `OSC_ENABLED` | `false` | Enable OSC BPM sender |
| `OSC_TARGET_IP` | `127.0.0.1` | OSC target IP |
| `OSC_TARGET_PORT` | `8000` | OSC target UDP port |
| `OSC_SPEEDMASTER` | `15` | SpeedMaster channel number in the OSC command |

### Camelot key mapping

StageLinq exposes `CurrentKeyIndex` as a number 0–23. The default mapping is `1A, 1B, 2A, 2B, … 12A, 12B`. If your device firmware uses a different order, override it:

```bash
KEY_MAP="1A,1B,2A,2B,3A,3B,4A,4B,5A,5B,6A,6B,7A,7B,8A,8B,9A,9B,10A,10B,11A,11B,12A,12B"
```

### config.json

All settings can also be placed in `config.json` at the repo root (or in `backend/`). Environment variables take precedence over file values. The file is fully optional — any omitted section falls back to env vars or defaults.

```json
{
  "current_playlist": 0,
  "timecode": {
    "fps": 30,
    "target_ip": "192.168.1.100",
    "target_port": 6454
  },
  "control_input": {
    "mode": "sacn",
    "universe": 20,
    "address": 1
  },
  "osc": {
    "enabled": true,
    "target_ip": "192.168.1.100",
    "target_port": 8000,
    "speedmaster": 15
  },
  "playlists": [
    {
      "name": "Show A",
      "content": [
        { "song_index": "track-filename.mp3", "offset_sec": 2, "offset_frame": 5 },
        { "song_index": "outro.mp3", "offset_sec": 0, "offset_frame": 0 }
      ]
    }
  ]
}
```

Tracks are matched by normalized filename (basename only, case-insensitive). `current_playlist` selects which playlist entry from the array is active (0-indexed).

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/timecode/send-when-stopped` | Query current "send when stopped" state |
| `POST` | `/api/timecode/send-when-stopped` | Set state; body: `{ "enabled": true \| false }` |

## Deck color accents

| Deck | Color |
|---|---|
| 1 | Purple / Magenta |
| 2 | Blue |
| 3 | Green |
| 4 | Red |

## Project structure

```
StageLinq-WebView/
├── backend/src/
│   ├── index.ts            # Express server, WebSocket, snapshot loop
│   ├── stagelinqBridge.ts  # StageLinq protocol handler
│   ├── artnetTimecode.ts   # Art-Net SMPTE timecode broadcaster
│   ├── oscBpm.ts           # OSC BPM sender
│   ├── camelot.ts          # Key index → Camelot string
│   ├── logging.ts          # Configurable debug logging
│   └── types.ts            # DeckState, WsPayload
└── frontend/src/
    ├── App.tsx             # WebSocket client, 4-quadrant layout
    ├── DeckCard.tsx        # Per-deck display component
    └── types.ts            # Shared types (mirrors backend)
```

## WebSocket protocol

On connect the server sends a hello frame, then snapshot frames at 30 Hz:

```jsonc
// hello
{ "type": "hello", "ts": 1234567890, "version": "1.0.0", "fps": 30 }

// snapshot
{ "type": "snapshot", "seq": 42, "ts": 1234567890, "decks": { "1": DeckState, "2": DeckState, "3": DeckState, "4": DeckState } }
```

## Notes

- **Track BPM** is derived from `CurrentBPM / Speed`.
- **Relative pitch %** is `(Speed − 1) × 100`.
- Track length reads from `/Engine/DeckX/TrackLength`; elapsed from BeatInfo `timeline`.
- StageLinq discovery and event parsing are handled by the `@gree44/stagelinq` library.

## License

MIT — Jan Müller (2026)
