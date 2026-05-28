const isTTY = Boolean(process.stdout.isTTY);
let currentStatus = '';

function clearStatus() {
    if (isTTY && currentStatus) {
        process.stdout.write('\r\x1b[K');
        currentStatus = '';
    }
}

export function logStatus(msg: string) {
    if (!msg) { clearStatus(); return; }
    if (isTTY) {
        process.stdout.write('\r\x1b[K' + msg);
        currentStatus = msg;
    } else if (msg !== currentStatus) {
        currentStatus = msg;
        console.log(msg);
    }
}

// Logging switches: set these booleans to control console output.
export const LOG_ENABLED = {
    lifecycle: true,
    playback: true,
    discover: true,
    discoverSpeed: false,
    bpmDebug: false,
    uiOut: false,
    errors: true,
};

// Deck filter for deck-scoped logs (discover/playback/speed).
// Set enabled=true and toggle deck booleans to restrict output.
export const LOG_DECK_FILTER = {
    enabled: false,
    deck1: false,
    deck2: true,
    deck3: false,
    deck4: false,
};

function splitDeckArgs(args: any[]): { shouldLog: boolean; payload: any[] } {
    const first = args[0];
    if (typeof first !== "number" || !Number.isInteger(first) || first < 1 || first > 4) {
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

export function logLifecycle(...args: any[]) {
    if (LOG_ENABLED.lifecycle) { clearStatus(); console.log(...args); }
}

export function logPlayback(...args: any[]) {
    if (!LOG_ENABLED.playback) return;
    const { shouldLog, payload } = splitDeckArgs(args);
    if (shouldLog) { clearStatus(); console.log(...payload); }
}

export function logDiscover(...args: any[]) {
    if (!LOG_ENABLED.discover) return;
    const { shouldLog, payload } = splitDeckArgs(args);
    if (shouldLog) { clearStatus(); console.log(...payload); }
}

export function logDiscoverSpeed(...args: any[]) {
    if (!(LOG_ENABLED.discover && LOG_ENABLED.discoverSpeed)) return;
    const { shouldLog, payload } = splitDeckArgs(args);
    if (shouldLog) { clearStatus(); console.log(...payload); }
}

export function logBpmDebug(...args: any[]) {
    if (!LOG_ENABLED.bpmDebug) return;
    const { shouldLog, payload } = splitDeckArgs(args);
    if (shouldLog) { clearStatus(); console.log(...payload); }
}

export function logUiOut(...args: any[]) {
    if (LOG_ENABLED.uiOut) { clearStatus(); console.log(...args); }
}

export function logError(...args: any[]) {
    if (LOG_ENABLED.errors) { clearStatus(); console.error(...args); }
}