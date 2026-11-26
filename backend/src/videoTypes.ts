export type VideoOutputFormat = 'source' | '1080p30';

export interface VideoConfig {
  enabled: boolean;
  directory: string;
  ndi_name_prefix: string;
  output_format: VideoOutputFormat;
  latency_comp_ms: number;
  offsets_sec: Record<string, number>;
}

export interface VideoFile {
  stem: string;
  fileName: string;
  path: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAtMs: number;
  version: string;
}

export interface VideoLibraryIssue {
  code: 'ambiguous' | 'symlink' | 'unsupported';
  message: string;
  paths: string[];
}

export interface VideoLibrary {
  directory: string | null;
  files: VideoFile[];
  byAudioFile: Map<string, VideoFile>;
  byStem: Map<string, VideoFile>;
  ambiguous: Map<string, VideoFile[]>;
  issues: VideoLibraryIssue[];
  issueCount: number;
  scannedEntries: number;
  scannedAt: number;
}

export type VideoMatch =
  | { kind: 'matched'; file: VideoFile }
  | { kind: 'ambiguous'; files: VideoFile[] }
  | { kind: 'missing' };
