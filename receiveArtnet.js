#!/usr/bin/env node
/*
 * Art-Net timecode arrival monitor.
 *
 * Run on a second machine on the same LAN to verify that the StageLinq-WebView
 * backend is sending Art-Net timecode at a steady cadence. Expected interval
 * at 30 fps is 33.33 ms; this tool plots per-packet inter-arrival deltas, a
 * rolling rate, a delta histogram, and counts dropped frames (gaps in the
 * SMPTE frame counter).
 *
 * NOTE: the sender targets a unicast IP by default (config.timecode.target_ip).
 * To receive on a different machine, either:
 *   - set target_ip to a directed broadcast (e.g. 192.168.178.255), or
 *   - temporarily point target_ip at this sniffer's IP.
 *
 * Usage:
 *   node receiveArtnet.js               # listens on UDP 6454, UI on http://<ip>:8091
 *   ARTNET_PORT=6454 UI_PORT=8091 node receiveArtnet.js
 */

const dgram = require('node:dgram');
const http = require('node:http');

const ARTNET_PORT = Number(process.env.ARTNET_PORT || 6454);
const UI_PORT = Number(process.env.UI_PORT || 8091);
const HISTORY = 1200; // ~40s at 30fps; ring buffer for the time-series chart

const sseClients = new Set();
let pktCount = 0;
let lostCount = 0;
let lastHrNs = null;
let lastFrameCounter = null; // h*3600*fps + m*60*fps + s*fps + f, for gap detection
let rateBucket = 0; // packets received since last 1Hz tick

function broadcast(obj) {
  if (sseClients.size === 0) return;
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch {}
  }
}

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sock.on('error', (err) => {
  console.error('[udp] error:', err.message);
});

sock.on('message', (msg, rinfo) => {
  // Validate Art-Net header
  if (msg.length < 19) return;
  if (msg.toString('ascii', 0, 7) !== 'Art-Net') return;
  const opcode = msg.readUInt16LE(8);
  if (opcode !== 0x9700) return; // OpTimeCode

  const frames = msg[14];
  const seconds = msg[15];
  const minutes = msg[16];
  const hours = msg[17];
  const fpsType = msg[18];
  const fps = ({ 0: 24, 1: 25, 2: 30, 3: 30 })[fpsType] ?? 30;

  const nowNs = process.hrtime.bigint();
  const tMs = Number(nowNs / 1000n) / 1000; // monotonic ms
  let deltaMs = null;
  if (lastHrNs !== null) {
    deltaMs = Number(nowNs - lastHrNs) / 1e6;
  }
  lastHrNs = nowNs;

  const frameCounter = ((hours * 3600 + minutes * 60 + seconds) * fps) + frames;
  let gap = 0;
  if (lastFrameCounter !== null) {
    const diff = frameCounter - lastFrameCounter;
    // Expected diff is +1 per packet. Negative means seek/loop; ignore.
    if (diff > 1 && diff < fps * 5) {
      gap = diff - 1;
      lostCount += gap;
    }
  }
  lastFrameCounter = frameCounter;

  pktCount += 1;
  rateBucket += 1;

  broadcast({
    type: 'pkt',
    n: pktCount,
    tMs,
    deltaMs,
    h: hours, m: minutes, s: seconds, f: frames,
    fps,
    gap,
    lost: lostCount,
    src: rinfo.address,
  });
});

// 1Hz rate aggregator — emits packets/sec for the rolling rate chart
setInterval(() => {
  broadcast({ type: 'rate', t: Date.now(), count: rateBucket });
  rateBucket = 0;
}, 1000);

sock.bind(ARTNET_PORT, () => {
  try { sock.setBroadcast(true); } catch {}
  console.log(`[udp] listening on 0.0.0.0:${ARTNET_PORT} for Art-Net OpTimeCode (0x9700)`);
});

// ─── HTTP + SSE ────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', pktCount, lostCount })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
httpServer.listen(UI_PORT, () => {
  console.log(`[ui]  http://localhost:${UI_PORT}  (open from any machine on the LAN)`);
});

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Art-Net TC Monitor</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 13px/1.4 -apple-system, system-ui, sans-serif; background: #111; color: #ddd; }
  header { padding: 10px 14px; background: #1a1a1a; border-bottom: 1px solid #333; display: flex; gap: 24px; align-items: baseline; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 14px; font-weight: 600; color: #fff; }
  .stat { font-variant-numeric: tabular-nums; }
  .stat b { color: #fff; }
  .stat.warn b { color: #f88; }
  .stat.ok b { color: #8f8; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 10px; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 8px 10px; }
  .card h2 { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; }
  canvas { width: 100%; display: block; }
  .full { grid-column: 1 / -1; }
  .ref { color: #888; font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>Art-Net Timecode Monitor</h1>
  <span class="stat">pkts: <b id="s_pkts">0</b></span>
  <span class="stat">last Δ: <b id="s_delta">–</b> ms</span>
  <span class="stat">rate (1s): <b id="s_rate">–</b> /s</span>
  <span class="stat">mean Δ: <b id="s_mean">–</b> ms</span>
  <span class="stat">p99 Δ: <b id="s_p99">–</b> ms</span>
  <span class="stat warn">lost: <b id="s_lost">0</b></span>
  <span class="stat">TC: <b id="s_tc">––:––:––:––</b> @ <b id="s_fps">–</b>fps</span>
  <span class="stat">src: <b id="s_src">–</b></span>
</header>
<div class="grid">
  <div class="card full">
    <h2>Inter-arrival delta (ms) <span class="ref">— green line = expected (1000/fps)</span></h2>
    <canvas id="c_delta" height="220"></canvas>
  </div>
  <div class="card">
    <h2>Rolling rate (packets/s, last 60 s)</h2>
    <canvas id="c_rate" height="180"></canvas>
  </div>
  <div class="card">
    <h2>Δ histogram (last ${HISTORY} pkts, 1ms bins, 0–100 ms)</h2>
    <canvas id="c_hist" height="180"></canvas>
  </div>
</div>
<script>
const HISTORY = ${HISTORY};
const deltas = []; // ring buffer
const rates = [];
let expectedMs = 1000/30;
let lastFps = 30;

const ctxDelta = document.getElementById('c_delta').getContext('2d');
const ctxRate  = document.getElementById('c_rate').getContext('2d');
const ctxHist  = document.getElementById('c_hist').getContext('2d');

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.canvas.clientWidth, h = c.canvas.clientHeight;
  if (c.canvas.width !== w*dpr || c.canvas.height !== h*dpr) {
    c.canvas.width = w*dpr; c.canvas.height = h*dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return { w, h };
}

function drawDelta() {
  const { w, h } = fitCanvas(ctxDelta);
  ctxDelta.clearRect(0,0,w,h);
  const pad = 28;
  const yMax = Math.max(expectedMs * 3, 60);
  // grid + expected line
  ctxDelta.strokeStyle = '#2a2a2a'; ctxDelta.lineWidth = 1;
  for (let v = 0; v <= yMax; v += 10) {
    const y = h - pad - (v/yMax)*(h-pad-8);
    ctxDelta.beginPath(); ctxDelta.moveTo(pad, y); ctxDelta.lineTo(w-4, y); ctxDelta.stroke();
    ctxDelta.fillStyle = '#666'; ctxDelta.font = '10px sans-serif';
    ctxDelta.fillText(v+'ms', 2, y+3);
  }
  // expected reference
  const yE = h - pad - (expectedMs/yMax)*(h-pad-8);
  ctxDelta.strokeStyle = '#3a7'; ctxDelta.setLineDash([4,3]);
  ctxDelta.beginPath(); ctxDelta.moveTo(pad, yE); ctxDelta.lineTo(w-4, yE); ctxDelta.stroke();
  ctxDelta.setLineDash([]);
  // points
  const n = deltas.length;
  if (n < 2) return;
  ctxDelta.strokeStyle = '#6cf'; ctxDelta.lineWidth = 1;
  ctxDelta.beginPath();
  for (let i = 0; i < n; i++) {
    const x = pad + (i/(HISTORY-1))*(w-pad-4);
    const v = deltas[i] ?? 0;
    const y = h - pad - Math.min(v, yMax)/yMax*(h-pad-8);
    if (i === 0) ctxDelta.moveTo(x,y); else ctxDelta.lineTo(x,y);
  }
  ctxDelta.stroke();
  // outliers
  ctxDelta.fillStyle = '#f66';
  for (let i = 0; i < n; i++) {
    const v = deltas[i] ?? 0;
    if (v > expectedMs * 1.6) {
      const x = pad + (i/(HISTORY-1))*(w-pad-4);
      const y = h - pad - Math.min(v, yMax)/yMax*(h-pad-8);
      ctxDelta.beginPath(); ctxDelta.arc(x,y,2,0,Math.PI*2); ctxDelta.fill();
    }
  }
}

function drawRate() {
  const { w, h } = fitCanvas(ctxRate);
  ctxRate.clearRect(0,0,w,h);
  const pad = 28;
  const yMax = Math.max(lastFps * 1.5, 40);
  ctxRate.strokeStyle = '#2a2a2a';
  for (let v = 0; v <= yMax; v += 10) {
    const y = h - pad - (v/yMax)*(h-pad-8);
    ctxRate.beginPath(); ctxRate.moveTo(pad, y); ctxRate.lineTo(w-4, y); ctxRate.stroke();
    ctxRate.fillStyle = '#666'; ctxRate.font = '10px sans-serif';
    ctxRate.fillText(v+'', 2, y+3);
  }
  const yE = h - pad - (lastFps/yMax)*(h-pad-8);
  ctxRate.strokeStyle = '#3a7'; ctxRate.setLineDash([4,3]);
  ctxRate.beginPath(); ctxRate.moveTo(pad, yE); ctxRate.lineTo(w-4, yE); ctxRate.stroke();
  ctxRate.setLineDash([]);
  if (rates.length < 2) return;
  ctxRate.strokeStyle = '#fc6'; ctxRate.lineWidth = 1.5;
  ctxRate.beginPath();
  for (let i = 0; i < rates.length; i++) {
    const x = pad + (i/(60-1))*(w-pad-4);
    const y = h - pad - Math.min(rates[i], yMax)/yMax*(h-pad-8);
    if (i === 0) ctxRate.moveTo(x,y); else ctxRate.lineTo(x,y);
  }
  ctxRate.stroke();
}

function drawHist() {
  const { w, h } = fitCanvas(ctxHist);
  ctxHist.clearRect(0,0,w,h);
  const pad = 28, BINS = 100;
  const bins = new Array(BINS).fill(0);
  for (const v of deltas) {
    if (v == null) continue;
    const b = Math.min(BINS-1, Math.max(0, Math.floor(v)));
    bins[b]++;
  }
  const max = Math.max(1, ...bins);
  const barW = (w - pad - 4) / BINS;
  for (let i = 0; i < BINS; i++) {
    const v = bins[i];
    const bh = (v/max) * (h-pad-8);
    const x = pad + i*barW;
    const y = h - pad - bh;
    const isExpected = Math.abs(i - expectedMs) < 1.5;
    ctxHist.fillStyle = isExpected ? '#3a7' : '#6cf';
    ctxHist.fillRect(x, y, Math.max(1, barW-0.5), bh);
  }
  ctxHist.fillStyle = '#666'; ctxHist.font = '10px sans-serif';
  for (let v = 0; v <= 100; v += 20) {
    const x = pad + (v/BINS)*(w-pad-4);
    ctxHist.fillText(v+'ms', x-8, h-8);
  }
}

function redraw() { drawDelta(); drawRate(); drawHist(); requestAnimationFrame(redraw); }
redraw();

function pad2(n) { return String(n).padStart(2,'0'); }

const es = new EventSource('/events');
es.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === 'pkt') {
    if (m.deltaMs != null) {
      deltas.push(m.deltaMs);
      if (deltas.length > HISTORY) deltas.shift();
    }
    lastFps = m.fps; expectedMs = 1000/m.fps;
    document.getElementById('s_pkts').textContent = m.n;
    document.getElementById('s_delta').textContent = (m.deltaMs ?? 0).toFixed(2);
    document.getElementById('s_lost').textContent = m.lost;
    document.getElementById('s_tc').textContent = pad2(m.h)+':'+pad2(m.m)+':'+pad2(m.s)+':'+pad2(m.f);
    document.getElementById('s_fps').textContent = m.fps;
    document.getElementById('s_src').textContent = m.src;
    if (deltas.length > 0) {
      const sorted = [...deltas].sort((a,b)=>a-b);
      const mean = sorted.reduce((s,v)=>s+v,0)/sorted.length;
      const p99 = sorted[Math.min(sorted.length-1, Math.floor(sorted.length*0.99))];
      document.getElementById('s_mean').textContent = mean.toFixed(2);
      document.getElementById('s_p99').textContent = p99.toFixed(2);
    }
  } else if (m.type === 'rate') {
    rates.push(m.count);
    if (rates.length > 60) rates.shift();
    document.getElementById('s_rate').textContent = m.count;
  }
};
</script>
</body>
</html>`;

process.on('SIGINT', () => { console.log('\nbye'); process.exit(0); });
