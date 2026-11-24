/**
 * Best-effort mapping for Denon/Engine "CurrentKeyIndex" -> Camelot keycode.
 *
 * The StageLinq protocol exposes a numeric key index, but public docs do not
 * clearly standardize the index-to-key mapping.
 *
 * Default strategy here:
 *   index 0..23 maps to 1A,1B,2A,2B,...,12A,12B
 *
 * If your device uses a different mapping, you can override by setting
 * KEY_MAP env var to a comma-separated list of 24 entries.
 * Example:
 *   KEY_MAP="8A,8B,9A,9B,..."
 */

const DEFAULT_MAP: string[] = Array.from({ length: 24 }, (_, i) => {
  const num = Math.floor(i / 2) + 1; // 1..12
  const letter = i % 2 === 0 ? 'A' : 'B';
  return `${num}${letter}`;
});

function loadEnvMap(): string[] | null {
  const raw = process.env.KEY_MAP;
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 24) {
    console.warn(`KEY_MAP ignored: expected 24 comma-separated values, got ${parts.length}`);
    return null;
  }
  return parts;
}

const MAP = loadEnvMap() ?? DEFAULT_MAP;
const NATURAL_PITCH_CLASSES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR_CAMELOT = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const MINOR_CAMELOT = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

export function keyNameToCamelot(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().replaceAll('♯', '#').replaceAll('♭', 'b');
  if (/^(?:[1-9]|1[0-2])[AB]$/i.test(key)) return key.toUpperCase();

  const note = key.match(/^([A-G])([#b]?)(?:\s*(m|M|min|maj|minor|major))?$/i);
  if (!note) return null;

  const accidental = note[2].toLowerCase();
  const offset = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  const pitchClass = (NATURAL_PITCH_CLASSES[note[1].toUpperCase()] + offset + 12) % 12;
  const mode = note[3] ?? '';
  const minor = mode !== 'M' && ['m', 'min', 'minor'].includes(mode.toLowerCase());
  return (minor ? MINOR_CAMELOT : MAJOR_CAMELOT)[pitchClass];
}

export function keyIndexToCamelot(keyIndex: number | null | undefined): string {
  if (keyIndex == null || !Number.isFinite(keyIndex)) return '--';
  const idx = Math.trunc(keyIndex);
  if (idx < 0 || idx >= MAP.length) return '--';
  return MAP[idx] ?? '--';
}
