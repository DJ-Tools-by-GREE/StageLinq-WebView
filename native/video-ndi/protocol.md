# Native video output protocol

The helper reads and writes newline-delimited UTF-8 JSON over stdin/stdout. Logs
belong on stderr. Protocol version 1 accepts lines up to 64 KiB. Closing stdin or
sending `{"type":"shutdown"}` stops all decoders and destroys all senders.

The helper emits `{"type":"ready","protocol":1}` before configuration.

```json
{"type":"ping","id":1}
{"type":"pong","id":1,"hostTimeSec":12345.678}
```

`hostTimeSec` is `CMClockGetTime(CMClockGetHostTimeClock())` in seconds. Map a
ping's Node send/receive midpoint to the returned host time, preferring the
lowest round-trip measurement. State positions are projected to that host clock.

```json
{
  "type":"configure",
  "protocol":1,
  "sourceNames":["StageLinq Deck 1","StageLinq Deck 2","StageLinq Deck 3","StageLinq Deck 4"],
  "outputFormat":"source",
  "settings":{
    "stateTimeoutMs":1000,
    "loadTimeoutMs":15000,
    "seekThresholdSec":0.25,
    "maxFramePixels":33177600,
    "maxOutputFps":240,
    "maxDecodeFramesPerTick":32,
    "timerLeewayMs":1
  }
}
```

The settings above are examples; the backend supplies its constants. A successful
configuration emits `{"type":"configured","protocol":1}`. `outputFormat` is
`source` (source dimensions, nominal source FPS multiplied by playback rate) or
`1080p30` (letterboxed, fixed 1920×1080 at 30 FPS). Neither mode sends audio.

```json
{
  "type":"state",
  "seq":1,
  "hostTimeSec":12345.678,
  "decks":[
    {"deck":1,"generation":"live:track:1","path":"/Videos/Song.mp4","positionSec":42.5,"rate":1.04,"playing":true},
    {"deck":2,"generation":"idle:2","path":null,"positionSec":0,"rate":1,"playing":false},
    {"deck":3,"generation":"idle:3","path":null,"positionSec":0,"rate":1,"playing":false},
    {"deck":4,"generation":"idle:4","path":null,"positionSec":0,"rate":1,"playing":false}
  ]
}
```

Every state includes all four decks. Sequence numbers increase within a process.
Positions already include video alignment and output latency compensation. The
helper extrapolates `positionSec + (hostNow - hostTimeSec) * rate` while playing.
The backend resolves transport freshness and replay; the helper independently
blacks out when commands exceed `stateTimeoutMs`. Paused, unavailable, loading,
failed and out-of-duration media are black. Generation changes invalidate loads
and seeks. The native workers retain only the newest pending deck state.

```json
{"type":"status","deck":1,"generation":"live:track:1","state":"playing","width":1920,"height":1080,"fps":31.2}
{"type":"status","deck":1,"generation":"live:track:1","state":"error","error":"No playable video track"}
{"type":"error","error":"Fatal configuration or runtime error"}
```

Deck states are `idle`, `loading`, `playing`, and `error`. A track failure stays
black and is cleared by a new generation. Fatal errors cause a nonzero exit.
`--self-test`, `--probe <file> [positionSec]` and `--test-mode` never initialize NDI
or create network senders. Test mode runs the complete decoder/scheduler against
an in-process sink and reports it in the ready message.
