import { format as utilFormat } from 'node:util';

const isTTY = Boolean(process.stdout.isTTY);

export const R    = '\x1b[0m';
export const DIM  = '\x1b[2m';
export const BOLD = '\x1b[1m';
const DECK_COLORS = ['\x1b[35m', '\x1b[34m', '\x1b[32m', '\x1b[31m'];

export function deckColor(deck: number, s: string) {
    return `${DECK_COLORS[(deck - 1) & 3]}${s}${R}`;
}

const statusSlots = new Map<string, string>();
let lastDashboardLines: string[] = [];
let lastDashboardContent = '';
let lastDrawMs = 0;
const DASHBOARD_THROTTLE_MS = 100; // ~10Hz
let rows = isTTY ? (process.stdout.rows ?? 0) : 0;
let scrollBottom = 0;

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
    let out = '\x1b7'; // save cursor (DECSC)
    for (let i = 0; i < lastDashboardLines.length; i++) {
        out += `\x1b[${startRow + i};1H\x1b[2K${lastDashboardLines[i]}`;
    }
    out += '\x1b8'; // restore cursor (DECRC)
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
};

export function applyLoggingConfig(cfg: {
    lifecycle?: boolean;
    playback?: boolean;
    discover?: boolean;
    discoverSpeed?: boolean;
    bpmDebug?: boolean;
    uiOut?: boolean;
    errors?: boolean;
}) {
    if (cfg.lifecycle     !== undefined) LOG_ENABLED.lifecycle     = cfg.lifecycle;
    if (cfg.playback      !== undefined) LOG_ENABLED.playback      = cfg.playback;
    if (cfg.discover      !== undefined) LOG_ENABLED.discover      = cfg.discover;
    if (cfg.discoverSpeed !== undefined) LOG_ENABLED.discoverSpeed = cfg.discoverSpeed;
    if (cfg.bpmDebug      !== undefined) LOG_ENABLED.bpmDebug      = cfg.bpmDebug;
    if (cfg.uiOut         !== undefined) LOG_ENABLED.uiOut         = cfg.uiOut;
    if (cfg.errors        !== undefined) LOG_ENABLED.errors        = cfg.errors;
}

export const LOG_DECK_FILTER = {
    enabled: false,
    deck1: false,
    deck2: true,
    deck3: false,
    deck4: false,
};

function splitDeckArgs(args: any[]): { shouldLog: boolean; payload: any[] } {
    const first = args[0];
    if (typeof first !== 'number' || !Number.isInteger(first) || first < 1 || first > 4) {
        return { shouldLog: true, payload: args };
    }
    if (!LOG_DECK_FILTER.enabled) {
        return { shouldLog: true, payload: args.slice(1) };
    }
    const allow =
        (first === 1 && LOG_DECK_FILTER.deck1) ||
        (first === 2 && LOG_DECK_FILTER.deck2) ||
        (first === 3 && LOG_DECK_FILTER.deck3) ||
        (first === 4 && LOG_DECK_FILTER.deck4);
    return { shouldLog: allow, payload: args.slice(1) };
}

function printLog(method: 'log' | 'error', ...args: any[]) {
    if (!isTTY || scrollBottom <= 0) {
        console[method](...args);
        return;
    }
    const text = utilFormat(...args);
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
    const { shouldLog, payload } = splitDeckArgs(args);
    if (shouldLog) printLog('log', ...payload);
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
    if (LOG_ENABLED.errors) printLog('error', ...args);
}
