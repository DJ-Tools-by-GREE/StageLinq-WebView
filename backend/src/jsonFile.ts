import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

export function parseConfig(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: false });
  if (errors.length) {
    const error = errors[0];
    throw new Error(`Invalid config: ${printParseErrorCode(error.error)} at offset ${error.offset}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Config must be a JSON object');
  }
  const config = value as Record<string, unknown>;
  validateConfig(config);
  return config;
}

export function validateConfig(config: Record<string, unknown>): void {
  const object = (value: unknown, name: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + ' must be an object');
    return value as Record<string, unknown>;
  };
  const array = (value: unknown, name: string): unknown[] => {
    if (!Array.isArray(value)) throw new Error(name + ' must be an array');
    return value;
  };
  const optional = (value: unknown, type: 'string' | 'boolean' | 'number', name: string) => {
    if (value === undefined) return;
    if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) throw new Error(name + ' must be a finite ' + type);
  };
  optional(config.current_playlist, 'number', 'current_playlist');
  if (config.current_playlist !== undefined && !Number.isInteger(config.current_playlist)) throw new Error('current_playlist must be an integer');
  for (const name of ['timecode', 'control_input', 'osc', 'sacn_sim', 'waveform', 'freewheel', 'logging', 'display']) {
    if (config[name] === undefined) continue;
    const section = object(config[name], name);
    for (const key of ['target_ip', 'mode']) optional(section[key], 'string', name + '.' + key);
    for (const key of ['fps', 'target_port', 'stream_id', 'universe', 'address', 'speedmaster', 'max_duration_sec']) {
      optional(section[key], 'number', name + '.' + key);
    }
    for (const key of ['enabled', 'all_tracks', 'enable_freewheeling']) optional(section[key], 'boolean', name + '.' + key);
    if (section.target_ips !== undefined) {
      for (const ip of array(section.target_ips, name + '.target_ips')) optional(ip, 'string', name + '.target_ips entry');
    }
  }
  if (config.playlists !== undefined) {
    for (const raw of array(config.playlists, 'playlists')) {
      const playlist = object(raw, 'playlist');
      optional(playlist.name, 'string', 'playlist.name');
      for (const rawTrack of playlist.content === undefined ? [] : array(playlist.content, 'playlist.content')) {
        const track = object(rawTrack, 'track');
        optional(track.song_index, 'string', 'song_index');
        optional(track.offset_sec, 'number', 'offset_sec');
        optional(track.offset_frame, 'number', 'offset_frame');
        optional(track.mashup_only, 'boolean', 'mashup_only');
        if (track.note !== undefined) {
          const note = object(track.note, 'note');
          optional(note.description, 'string', 'note.description');
          optional(note.show_secs_after_load, 'number', 'note.show_secs_after_load');
        }
      }
    }
  }
  if (config.recordings !== undefined) {
    for (const raw of array(config.recordings, 'recordings')) {
      const entry = object(raw, 'recording');
      optional(entry.audio_file, 'string', 'audio_file');
      optional(entry.log_file, 'string', 'log_file');
    }
  }
}

const writes = new Map<string, Promise<unknown>>();

async function serialize<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  writes.set(key, next);
  try {
    return await next;
  } finally {
    if (writes.get(key) === next) writes.delete(key);
  }
}

async function replaceJson(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 4) + '\n', 'utf8');
    await fs.rename(tmp, filePath);
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

export function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  return serialize(filePath, () => replaceJson(filePath, value));
}

export function updateConfigFile(
  filePath: string,
  update: (config: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  return serialize(filePath, async () => {
    let config: Record<string, unknown>;
    try {
      config = parseConfig(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      config = {};
    }
    await replaceJson(filePath, update(config));
  });
}


export function readConfigFile(filePath: string): Promise<Record<string, unknown>> {
  return serialize(filePath, async () => parseConfig(await fs.readFile(filePath, 'utf8')));
}
