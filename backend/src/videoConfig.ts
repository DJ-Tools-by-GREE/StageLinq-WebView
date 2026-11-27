import path from 'node:path';
import { VIDEO_MAX_NDI_PREFIX_BYTES, VIDEO_MAX_OFFSET_ENTRIES } from './constants.js';
import type { VideoConfig } from './videoTypes.js';

export function parseVideoConfig(raw: unknown): VideoConfig {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('video must be an object');
  }
  const value = (raw ?? {}) as Record<string, unknown>;
  const string = (key: string, fallback: string): string => {
    const item = value[key];
    if (item === undefined) return fallback;
    if (typeof item !== 'string' || item.includes('\0')) throw new Error(`video.${key} must be a string without NUL characters`);
    return item;
  };
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('video.enabled must be a boolean');
  const enabled = value.enabled ?? false;
  if (value.multi_ndi_stream !== undefined && typeof value.multi_ndi_stream !== 'boolean') {
    throw new Error('video.multi_ndi_stream must be a boolean');
  }
  const multiNdiStream = value.multi_ndi_stream ?? false;
  const directory = string('directory', '');
  if (enabled && !directory.trim()) throw new Error('video.directory is required when video is enabled');
  const ndiNamePrefix = string('ndi_name_prefix', 'StageLinq');
  if (!ndiNamePrefix.trim() || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(ndiNamePrefix)
    || Buffer.byteLength(ndiNamePrefix, 'utf8') > VIDEO_MAX_NDI_PREFIX_BYTES) {
    throw new Error(`video.ndi_name_prefix must be a nonempty NDI source name of at most ${VIDEO_MAX_NDI_PREFIX_BYTES} UTF-8 bytes, without reserved characters`);
  }
  const outputFormat = value.output_format === undefined ? 'source' : value.output_format;
  if (outputFormat !== 'source' && outputFormat !== '1080p30') throw new Error('video.output_format must be source or 1080p30');
  const latencyCompMs = value.latency_comp_ms === undefined ? 0 : value.latency_comp_ms;
  if (typeof latencyCompMs !== 'number' || !Number.isFinite(latencyCompMs)) throw new Error('video.latency_comp_ms must be a finite number');
  const offsets = value.offsets_sec;
  if (offsets !== undefined && (!offsets || typeof offsets !== 'object' || Array.isArray(offsets))) {
    throw new Error('video.offsets_sec must be an object keyed by audio filename including extension');
  }
  const entries = Object.entries(offsets ?? {});
  if (entries.length > VIDEO_MAX_OFFSET_ENTRIES) throw new Error(`video.offsets_sec exceeds ${VIDEO_MAX_OFFSET_ENTRIES} entries`);
  const offsetsSec: Record<string, number> = {};
  for (const [audioFileName, offset] of entries) {
    if (!audioFileName.trim() || /[\\/\0]/.test(audioFileName) || path.extname(audioFileName).length < 2 || !path.parse(audioFileName).name) {
      throw new Error('video.offsets_sec keys must be audio basenames including extension');
    }
    if (typeof offset !== 'number' || !Number.isFinite(offset)) throw new Error(`video.offsets_sec[${audioFileName}] must be a finite number`);
    offsetsSec[audioFileName] = offset;
  }
  return { enabled, multi_ndi_stream: multiNdiStream, directory, ndi_name_prefix: ndiNamePrefix,
    output_format: outputFormat, latency_comp_ms: latencyCompMs, offsets_sec: offsetsSec };
}
