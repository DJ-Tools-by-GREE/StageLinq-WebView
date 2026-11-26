import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { parseTree, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { VIDEO_MAPPINGS_MAX_BYTES, VIDEO_MAPPINGS_MAX_ENTRIES } from './constants.js';

export async function readVideoMappings(directory: string, signal?: AbortSignal): Promise<Map<string, string>> {
  signal?.throwIfAborted();
  const mappingPath = path.join(directory, 'mappings.json');
  let stat: Stats;
  try { stat = await fs.lstat(mappingPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('mappings.json must be a regular file, not a symbolic link');
  if (stat.size > VIDEO_MAPPINGS_MAX_BYTES) throw new Error(`mappings.json exceeds ${VIDEO_MAPPINGS_MAX_BYTES} bytes`);
  const file = await fs.open(mappingPath, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(VIDEO_MAPPINGS_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > VIDEO_MAPPINGS_MAX_BYTES) throw new Error(`mappings.json exceeds ${VIDEO_MAPPINGS_MAX_BYTES} bytes`);
    text = buffer.toString('utf8', 0, size).replace(/^\uFEFF/, '');
  } finally { await file.close(); }
  signal?.throwIfAborted();
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length) {
    const error = errors[0];
    throw new Error(`Invalid mappings.json: ${printParseErrorCode(error.error)} at offset ${error.offset}`);
  }
  if (!tree || tree.type !== 'object') throw new Error('mappings.json must be a JSON object mapping audio filenames to video paths');
  const properties = tree.children ?? [];
  if (properties.length > VIDEO_MAPPINGS_MAX_ENTRIES) throw new Error(`mappings.json exceeds ${VIDEO_MAPPINGS_MAX_ENTRIES} entries`);
  const mappings = new Map<string, string>();
  for (const property of properties) {
    const audio: unknown = property.children?.[0]?.value;
    const video: unknown = property.children?.[1]?.value;
    if (typeof audio !== 'string' || !audio.trim() || audio !== audio.trim() || /[\\/:\0]/.test(audio)
      || path.extname(audio).length < 2 || !path.parse(audio).name) {
      throw new Error('mappings.json keys must be audio basenames including extension, without surrounding whitespace');
    }
    if (mappings.has(audio)) throw new Error(`Duplicate audio filename in mappings.json: ${JSON.stringify(audio)}`);
    if (typeof video !== 'string' || !video.trim() || /[\\:\0]/.test(video)
      || video.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`mappings.json[${JSON.stringify(audio)}] must be a relative video path inside the video folder, using forward slashes`);
    }
    mappings.set(audio, video);
  }
  return mappings;
}
