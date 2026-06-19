/**
 * extractCues — pull hot cues out of an Engine DJ `m.db` for every track
 * referenced by any playlist in the project's `config.json`, and write the
 * result into the project's hotcue-cache (one JSON file per track, sibling to
 * waveform-cache / artwork-cache).
 *
 * This script is intentionally standalone: it does NOT import from the rest of
 * the backend (no StageLinq, no express, no waveform pipeline). It only
 * touches the filesystem and SQLite. The runtime backend then reads the cached
 * JSON at boot via the waveform worker.
 *
 * Cue blob format (Engine DJ `PerformanceData.quickCues`):
 *   bytes[0..4]   — 4-byte uncompressed-size header (skipped)
 *   zlib.inflate(bytes[4..]) →
 *     [0..8]    big-endian int64 — number of cue slots (typically 8)
 *     per slot:
 *       [u8]     name length (n)
 *       [n]      UTF-8 name (may be empty)
 *       [f64 BE] sample position (44100 sps); negative → unset
 *       [u32 BE] ARGB color
 *
 * Run from repo root:
 *   npm run -w backend extract-cues
 *   npm run -w backend extract-cues -- --db "/Volumes/MY SD/Engine Library/Database2/m.db"
 *   npm run -w backend extract-cues -- --all-playlists   # default: same as omitted
 *   npm run -w backend extract-cues -- --current-only    # only config.current_playlist
 */

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Constants — kept local to the script per CLAUDE.md "all tunables in
// constants.ts" rule, EXCEPT for script-local invariants like the Engine DJ
// blob header layout which are not user-tunable.
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 44100;
const HOTCUE_SLOTS = 8;
const QUICK_CUES_HEADER_BYTES = 4;

// Cache layout sits next to waveform-cache / artwork-cache. The waveform
// worker spins up at backend boot via initWaveformCache(process.cwd()) where
// cwd is the backend workspace dir, so caches live under backend/<name>-cache.
const CACHE_DIR_NAME = 'hotcue-cache';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConfigTrack {
  song_index?: string;
  mashup_only?: boolean;
}
interface ConfigPlaylist {
  name?: string;
  content?: ConfigTrack[];
}
interface ProjectConfig {
  current_playlist?: number;
  playlists?: ConfigPlaylist[];
}

interface HotCue {
  index: number;            // 1..8
  sec: number;              // sample / SAMPLE_RATE
  samples: number;          // raw sample position (preserved for precision)
  label: string;            // empty string if Engine DJ stored no name
  argb: string;             // 8-char hex e.g. "FF00CCFF"
}

interface CachedCueEntry {
  fileName: string;         // basename used as the lookup key
  trackId: number;          // Engine DJ Track.id (for traceability)
  source: string;           // absolute path of the m.db this came from
  extractedAt: string;      // ISO timestamp
  cues: HotCue[];           // sorted by index ascending; only set cues
}

// ---------------------------------------------------------------------------
// CLI argument parsing — minimal, no dependency
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { dbPath: string | null; scope: 'all' | 'current' } {
  let dbPath: string | null = null;
  let scope: 'all' | 'current' = 'all';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db' && argv[i + 1]) {
      dbPath = argv[++i];
    } else if (a === '--current-only') {
      scope = 'current';
    } else if (a === '--all-playlists') {
      scope = 'all';
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return { dbPath, scope };
}

function printHelp(): void {
  console.log(`extractCues — extract Engine DJ hot cues into the project cache.

Options:
  --db <path>          Path to m.db. If omitted, candidates are auto-detected
                       and the user is prompted.
  --current-only       Only iterate config.current_playlist.
  --all-playlists      Iterate every playlist in config (default).
  -h, --help           This text.

Output: <repo>/${CACHE_DIR_NAME}/<md5(filename)>.json — one file per track.
`);
}

// ---------------------------------------------------------------------------
// DB candidate discovery
// ---------------------------------------------------------------------------

function findDatabaseCandidates(repoRoot: string): string[] {
  const candidates: string[] = [];

  // 1. Mounted volumes (macOS) — /Volumes/<name>/Engine Library/Database2/m.db
  const volumesDir = '/Volumes';
  if (existsSync(volumesDir)) {
    for (const name of safeReaddir(volumesDir)) {
      const p = join(volumesDir, name, 'Engine Library', 'Database2', 'm.db');
      if (existsSync(p)) candidates.push(p);
    }
  }

  // 2. In-repo snapshot — useful when the SD card isn't plugged in.
  const inRepo = join(repoRoot, 'copy of exported library', 'Engine Library', 'Database2', 'm.db');
  if (existsSync(inRepo)) candidates.push(inRepo);

  // 3. On-PC Engine DJ install location (mp3-cutter convention).
  const inHome = join(homedir(), 'Music', 'Engine Library', 'Database2', 'm.db');
  if (existsSync(inHome)) candidates.push(inHome);

  // De-dup while preserving order (a symlinked /Volumes path can collide).
  const seen = new Set<string>();
  return candidates.filter((p) => {
    const key = resolve(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeReaddir(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

async function pickDatabase(candidates: string[]): Promise<string> {
  if (candidates.length === 0) {
    throw new Error(
      'No Engine DJ database found. Plug in an SD card / USB drive with an ' +
      '"Engine Library" folder, or pass --db <path>.',
    );
  }
  if (candidates.length === 1) {
    console.log(`Using only candidate: ${candidates[0]}`);
    return candidates[0];
  }

  console.log('Multiple Engine DJ databases detected:');
  candidates.forEach((p, i) => {
    let sizeMB = '';
    try {
      sizeMB = (statSync(p).size / 1024 / 1024).toFixed(1) + ' MB';
    } catch {}
    console.log(`  [${i + 1}] ${p}  (${sizeMB})`);
  });

  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question(`Pick one (1-${candidates.length}): `)).trim();
    const idx = Number(ans) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
      throw new Error(`Invalid selection: ${ans}`);
    }
    return candidates[idx];
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Project config loading
// ---------------------------------------------------------------------------

function loadConfig(repoRoot: string): { config: ProjectConfig; path: string } {
  const candidates = [
    join(repoRoot, 'config.json'),
    join(repoRoot, 'backend', 'config.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const config = JSON.parse(readFileSync(p, 'utf8')) as ProjectConfig;
      return { config, path: p };
    }
  }
  throw new Error('config.json not found at repo root or backend/.');
}

function collectPlaylistFilenames(cfg: ProjectConfig, scope: 'all' | 'current'): Set<string> {
  const out = new Set<string>();
  const playlists = Array.isArray(cfg.playlists) ? cfg.playlists : [];

  const indexes: number[] = [];
  if (scope === 'current') {
    const i = Number(cfg.current_playlist ?? 0);
    if (Number.isInteger(i) && i >= 0 && i < playlists.length) indexes.push(i);
  } else {
    for (let i = 0; i < playlists.length; i++) indexes.push(i);
  }

  for (const i of indexes) {
    const pl = playlists[i];
    for (const item of pl?.content ?? []) {
      const name = item?.song_index;
      if (typeof name === 'string' && name.length > 0) out.add(name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cue blob decoding
// ---------------------------------------------------------------------------

function decodeQuickCues(blob: Buffer): HotCue[] {
  if (blob.length <= QUICK_CUES_HEADER_BYTES) return [];
  const data = inflateSync(blob.subarray(QUICK_CUES_HEADER_BYTES));

  // The slot count appears stable at 8, but Engine has historically written
  // the count itself; honor it and clamp at HOTCUE_SLOTS to be safe.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numCues = Number(view.getBigInt64(0, false /* big-endian */));
  if (numCues < 0 || numCues > HOTCUE_SLOTS * 4) {
    throw new Error(`Implausible cue count ${numCues} — blob layout mismatch`);
  }

  let pos = 8;
  const cues: HotCue[] = [];
  const slotCount = Math.min(numCues, HOTCUE_SLOTS);

  for (let i = 0; i < slotCount; i++) {
    if (pos + 1 > data.length) break;
    const nameLen = data[pos]; pos += 1;
    if (pos + nameLen + 12 > data.length) break;
    const label = data.subarray(pos, pos + nameLen).toString('utf8'); pos += nameLen;
    const samples = view.getFloat64(pos, false); pos += 8;
    const argbInt = view.getUint32(pos, false); pos += 4;

    if (samples >= 0 && Number.isFinite(samples)) {
      cues.push({
        index: i + 1,
        samples,
        sec: samples / SAMPLE_RATE,
        label,
        argb: argbInt.toString(16).toUpperCase().padStart(8, '0'),
      });
    }
  }

  return cues;
}

// ---------------------------------------------------------------------------
// Cache writing
// ---------------------------------------------------------------------------

function cueCacheStem(fileName: string): string {
  // Match waveformWorker.waveformStem() exactly so a future feature can join
  // the two caches by a shared key derived from the file name.
  return createHash('md5').update(fileName).digest('hex').slice(0, 16);
}

function writeCueCache(cacheRoot: string, entry: CachedCueEntry): string {
  const dir = join(cacheRoot, CACHE_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${cueCacheStem(entry.fileName)}.json`);
  writeFileSync(path, JSON.stringify(entry, null, 2), 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Repo root: this file lives at <repo>/backend/src/scripts/extractCues.ts.
  // Backend runtime cwd (where waveform-cache lives) is <repo>/backend.
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const backendDir = resolve(scriptDir, '..', '..');           // <repo>/backend
  const repoRoot = resolve(backendDir, '..');                  // <repo>
  const args = parseArgs(process.argv.slice(2));

  const dbPath = args.dbPath ?? await pickDatabase(findDatabaseCandidates(repoRoot));
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const { config, path: configPath } = loadConfig(repoRoot);
  const wanted = collectPlaylistFilenames(config, args.scope);
  console.log(`Config: ${configPath}`);
  console.log(`Scope: ${args.scope === 'all' ? 'all playlists' : `current_playlist=${config.current_playlist ?? 0}`}`);
  console.log(`Tracks to look up: ${wanted.size}`);

  if (wanted.size === 0) {
    console.log('Nothing to do. Exiting.');
    return;
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  // The exported library m.db has no journal-mode lock contention, but
  // setting WAL would require write-mode. Read-only is enough.
  const trackStmt = db.prepare('SELECT id FROM Track WHERE filename = ?');
  const cuesStmt = db.prepare('SELECT quickCues FROM PerformanceData WHERE trackId = ?');

  let written = 0;
  let missing = 0;
  let noCues = 0;
  const missingFiles: string[] = [];

  for (const fileName of wanted) {
    const trackRow = trackStmt.get(fileName) as { id: number } | undefined;
    if (!trackRow) {
      missing++;
      missingFiles.push(fileName);
      continue;
    }

    const perfRow = cuesStmt.get(trackRow.id) as { quickCues: Buffer | null } | undefined;
    if (!perfRow || !perfRow.quickCues) {
      noCues++;
      continue;
    }

    let cues: HotCue[];
    try {
      cues = decodeQuickCues(perfRow.quickCues);
    } catch (e: any) {
      console.warn(`  [skip] ${fileName}: decode failed (${e?.message || e})`);
      continue;
    }

    const entry: CachedCueEntry = {
      fileName,
      trackId: trackRow.id,
      source: dbPath,
      extractedAt: new Date().toISOString(),
      cues,
    };
    writeCueCache(backendDir, entry);
    written++;
  }

  db.close();

  console.log('');
  console.log(`Wrote: ${written}`);
  console.log(`No cues stored:   ${noCues}`);
  console.log(`Missing in DB:    ${missing}`);
  if (missingFiles.length > 0) {
    console.log('');
    console.log('Tracks not found in Track.filename (check naming / playlist drift):');
    for (const m of missingFiles) console.log(`  - ${m}`);
  }
  console.log('');
  console.log(`Cache: ${join(backendDir, CACHE_DIR_NAME)}`);
}

main().catch((err) => {
  console.error('extractCues failed:', err?.message || err);
  process.exit(1);
});
