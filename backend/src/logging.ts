import { format as utilFormat } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const isTTY = Boolean(process.stdout.isTTY);

const LOG_DIR = path.resolve(process.cwd(), 'logs');
let logFileStream: fs.WriteStream | null = null;

function getLogStream(): fs.WriteStream {
    if (!logFileStream) {
        try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(LOG_DIR, `run-${ts}.log`);
        logFileStream = fs.createWriteStream(file, { flags: 'a' });
        logFileStream.write(`--- session start ${new Date().toISOString()} ---\n`);
    }
    return logFileStream;
}

function writeToFile(level: 'ERROR' | 'WARN', ...args: any[]) {
    try {
        const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
        getLogStream().write(`[${ts}] [${level}] ${utilFormat(...args)}\n`);
    } catch {}
}

export const R    = '\x1b[0m';
export const DIM  = '\x1b[2m';
export const BOLD = '\x1b[1m';

export const RED = isTTY ? '\x1b[31m' : '';
export const GRN = isTTY ? '\x1b[32m' : '';
export const YEL = isTTY ? '\x1b[33m' : '';
export const RST = isTTY ? '\x1b[0m'  : '';

const DECK_COLORS = ['\x1b[35m', '\x1b[34m', '\x1b[32m', '\x1b[31m'];

export function deckColor(deck: number, s: string) {
    if (!isTTY) return s;
    return `${DECK_COLORS[(deck - 1) & 3]}${s}${R}`;
}

const statusSlots = new Map<string, string>();
let lastDashboardLines: string[] = [];
let lastDashboardContent = '';
let lastDrawMs = 0;
const DASHBOARD_THROTTLE_MS = 100; // ~10Hz
let rows = isTTY ? (process.stdout.rows ?? 0) : 0;
let scrollBottom = 0;

// Most recent Art-Net TC reading (HH:MM:SS), prefixed onto every terminal log line.
// Updated at 10 Hz from the Art-Net worker via setArtnetTcHms().
let artnetTcHms = '--:--:--';

export function setArtnetTcHms(hms: string) {
    artnetTcHms = hms;
}

function tcPrefix(): string {
    return isTTY ? `${DIM}[${artnetTcHms}]${R} ` : `[${artnetTcHms}] `;
}

export const DISPLAY_ENABLED = {
    dashboard: true,
    artnet: true,
    info: true,
};

export function applyDisplayConfig(cfg: { dashboard?: boolean; artnet?: boolean; info?: boolean }) {
    if (cfg.dashboard !== undefined) DISPLAY_ENABLED.dashboard = cfg.dashboard;
    if (cfg.artnet    !== undefined) DISPLAY_ENABLED.artnet    = cfg.artnet;
    if (cfg.info      !== undefined) DISPLAY_ENABLED.info      = cfg.info;
}

if (isTTY) {
    process.stdout.on('resize', () => {
        rows = process.stdout.rows ?? 0;
        if (lastDashboardLines.length > 0) {
            applyScrollRegion();
            drawDashboard();
        }
    });
    process.on('exit', () => {
        // Reset scroll region and leave cursor on a clean line below the dashboard
        process.stdout.write(`\x1b[r\x1b[${rows};1H\n`);
    });
}

function applyScrollRegion() {
    if (!rows) return;
    scrollBottom = Math.max(1, rows - lastDashboardLines.length);
    process.stdout.write(`\x1b[1;${scrollBottom}r\x1b[${scrollBottom};1H`);
}

function drawDashboard() {
    if (!rows || lastDashboardLines.length === 0) return;
    const startRow = rows - lastDashboardLines.length + 1;
    // DECAWM off (\x1b[?7l) so a dashboard line wider than the terminal is
    // truncated at the right edge instead of wrapping onto the next row and
    // corrupting the line above. Re-enabled before restoring the cursor so
    // log lines in the scroll region wrap normally.
    let out = '\x1b7\x1b[?7l'; // save cursor (DECSC) + autowrap off
    for (let i = 0; i < lastDashboardLines.length; i++) {
        out += `\x1b[${startRow + i};1H\x1b[2K${lastDashboardLines[i]}`;
    }
    out += '\x1b[?7h\x1b8'; // autowrap on + restore cursor (DECRC)
    process.stdout.write(out);
}

export function logDashboard(lines: string[]) {
    if (!isTTY || !DISPLAY_ENABLED.dashboard) return;
    const content = lines.join('\n');
    const now = Date.now();
    const prevHeight = lastDashboardLines.length;
    lastDashboardLines = lines;
    if (content === lastDashboardContent && now - lastDrawMs < DASHBOARD_THROTTLE_MS) return;
    lastDashboardContent = content;
    lastDrawMs = now;
    if (prevHeight !== lines.length) {
        applyScrollRegion();
    }
    drawDashboard();
}

export function getStatusSlot(key: string): string {
    return statusSlots.get(key) ?? '';
}

export function logStatus(key: string, msg: string) {
    const prev = statusSlots.get(key);
    statusSlots.set(key, msg);
    if (scrollBottom > 0) return; // dashboard owns the display
    if (!isTTY) {
        if (msg !== prev && msg) console.log(msg);
        return;
    }
    const line = [...statusSlots.values()].filter(Boolean).join('  |  ');
    process.stdout.write('\r\x1b[2K' + line);
}

export const LOG_ENABLED = {
    lifecycle: true,
    playback: true,
    discover: true,
    discoverSpeed: false,
    bpmDebug: false,
    uiOut: false,
    errors: true,
    cues: false,
    artnetStats: true, // periodic [ArtNet/wk] tick stats info heartbeat (every ~10s); warns ignore this flag
};

export function applyLoggingConfig(cfg: {
    lifecycle?: boolean;
    playback?: boolean;
    discover?: boolean;
    discoverSpeed?: boolean;
    bpmDebug?: boolean;
    uiOut?: boolean;
    errors?: boolean;
    cues?: boolean;
    artnetStats?: boolean;
}) {
    if (cfg.lifecycle     !== undefined) LOG_ENABLED.lifecycle     = cfg.lifecycle;
    if (cfg.playback      !== undefined) LOG_ENABLED.playback      = cfg.playback;
    if (cfg.discover      !== undefined) LOG_ENABLED.discover      = cfg.discover;
    if (cfg.discoverSpeed !== undefined) LOG_ENABLED.discoverSpeed = cfg.discoverSpeed;
    if (cfg.bpmDebug      !== undefined) LOG_ENABLED.bpmDebug      = cfg.bpmDebug;
    if (cfg.uiOut         !== undefined) LOG_ENABLED.uiOut         = cfg.uiOut;
    if (cfg.errors        !== undefined) LOG_ENABLED.errors        = cfg.errors;
    if (cfg.cues          !== undefined) LOG_ENABLED.cues          = cfg.cues;
    if (cfg.artnetStats   !== undefined) LOG_ENABLED.artnetStats   = cfg.artnetStats;
}

export const LOG_DECK_FILTER = {
    enabled: false,
    deck1: false,
    deck2: true,
    deck3: false,
    deck4: false,
};

function splitDeckArgs(args: any[]): { shouldLog: boolean; deck: number | null; payload: any[] } {
    const first = args[0];
    if (typeof first !== 'number' || !Number.isInteger(first) || first < 1 || first > 4) {
        return { shouldLog: true, deck: null, payload: args };
    }
    if (!LOG_DECK_FILTER.enabled) {
        return { shouldLog: true, deck: first, payload: args.slice(1) };
    }
    const allow =
        (first === 1 && LOG_DECK_FILTER.deck1) ||
        (first === 2 && LOG_DECK_FILTER.deck2) ||
        (first === 3 && LOG_DECK_FILTER.deck3) ||
        (first === 4 && LOG_DECK_FILTER.deck4);
    return { shouldLog: allow, deck: first, payload: args.slice(1) };
}

function printLog(method: 'log' | 'error', ...args: any[]) {
    if (!isTTY || scrollBottom <= 0) {
        console[method](tcPrefix() + utilFormat(...args));
        return;
    }
    const text = tcPrefix() + utilFormat(...args);
    // Move to bottom of scroll region, clear line, print.
    // The trailing \n at scrollBottom causes the scroll region [1..scrollBottom] to scroll up by one;
    // the dashboard lives below scrollBottom and is unaffected.
    process.stdout.write(`\x1b[${scrollBottom};1H\x1b[2K${text}\n`);
}

export function logLifecycle(...args: any[]) {
    if (LOG_ENABLED.lifecycle) printLog('log', ...args);
}

export function logPlayback(...args: any[]) {
    if (!LOG_ENABLED.playback) return;
    const { shouldLog, deck, payload } = splitDeckArgs(args);
    if (!shouldLog) return;
    if (deck !== null && isTTY) {
        const col = DECK_COLORS[(deck - 1) & 3];
        printLog('log', `${col}${utilFormat(...payload)}${R}`);
    } else {
        printLog('log', ...payload);
    }
}

export function logDiscover(...args: any[]) {
    if (!LOG_ENABLED.discover) return;
    const { shouldLog, payload } = splitDeckArgs(args);
    if (shouldLog) printLog('log', ...payload);
}

export function logDiscoverSpeed(...args: any[]) {
    if (!(LOG_ENABLED.discover && LOG_ENABLED.discoverSpeed)) return;
    const { shouldLog, payload } = splitDeckArgs(args);
    if (shouldLog) printLog('log', ...payload);
}

export function logBpmDebug(...args: any[]) {
    if (!LOG_ENABLED.bpmDebug) return;
    const { shouldLog, payload } = splitDeckArgs(args);
    if (shouldLog) printLog('log', ...payload);
}

export function logUiOut(...args: any[]) {
    if (LOG_ENABLED.uiOut) printLog('log', ...args);
}

export function logError(...args: any[]) {
    writeToFile('ERROR', ...args);
    if (!LOG_ENABLED.errors) return;
    if (isTTY) {
        printLog('error', `${RED}${utilFormat(...args)}${R}`);
    } else {
        printLog('error', ...args);
    }
}

export function logWarn(...args: any[]) {
    writeToFile('WARN', ...args);
    if (!LOG_ENABLED.errors) return;
    if (isTTY) {
        printLog('error', `${YEL}${utilFormat(...args)}${R}`);
    } else {
        printLog('error', ...args);
    }
}

export function logWaveform(...args: any[]) {
    if (LOG_ENABLED.lifecycle) printLog('log', ...args);
}

export function logCues(...args: any[]) {
    if (!LOG_ENABLED.cues) return;
    const { shouldLog, deck, payload } = splitDeckArgs(args);
    if (!shouldLog) return;
    if (deck !== null && isTTY) {
        const col = DECK_COLORS[(deck - 1) & 3];
        printLog('log', `${col}${utilFormat(...payload)}${R}`);
    } else {
        printLog('log', ...payload);
    }
}
