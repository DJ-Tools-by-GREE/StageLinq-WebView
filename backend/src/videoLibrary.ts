import fs from 'node:fs/promises';
import path from 'node:path';
import {
  VIDEO_LIBRARY_MAX_DEPTH, VIDEO_LIBRARY_MAX_ENTRIES, VIDEO_LIBRARY_MAX_FILES, VIDEO_LIBRARY_MAX_ISSUES,
} from './constants.js';
import type { VideoConfig, VideoFile, VideoLibrary, VideoLibraryIssue, VideoMatch } from './videoTypes.js';

const suffix = ' (Music Video)';
const extensions = new Set(['.mp4', '.m4v', '.mov']);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const compareIssue = (a: VideoLibraryIssue, b: VideoLibraryIssue): number => compare(a.paths[0] ?? '', b.paths[0] ?? '') || compare(a.code, b.code);

export function emptyVideoLibrary(): VideoLibrary {
  return { directory: null, files: [], byStem: new Map(), ambiguous: new Map(), issues: [], issueCount: 0, scannedEntries: 0, scannedAt: Date.now() };
}

export function audioVideoStem(audioFileName: string): string {
  return path.parse(path.basename(audioFileName.trim())).name;
}

export function findVideo(library: VideoLibrary, audioFileName: string): VideoMatch {
  const stem = audioVideoStem(audioFileName);
  const ambiguous = library.ambiguous.get(stem);
  if (ambiguous) return { kind: 'ambiguous', files: ambiguous };
  const file = library.byStem.get(stem);
  return file ? { kind: 'matched', file } : { kind: 'missing' };
}

export async function scanVideoLibrary(config: VideoConfig, baseDir: string, signal?: AbortSignal): Promise<VideoLibrary> {
  signal?.throwIfAborted();
  const library = emptyVideoLibrary();
  if (!config.enabled) return library;
  const configuredDirectory = path.resolve(baseDir, config.directory);
  const report = (issue: VideoLibraryIssue): void => {
    library.issueCount++;
    library.issues.push(issue);
    library.issues.sort(compareIssue);
    if (library.issues.length > VIDEO_LIBRARY_MAX_ISSUES) library.issues.pop();
  };
  try {
    const root = await fs.realpath(configuredDirectory);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('not a directory');
    library.directory = root;
    const pending = [{ directory: root, depth: 0 }];
    while (pending.length) {
      signal?.throwIfAborted();
      const current = pending.pop()!;
      if ((await fs.lstat(current.directory)).isSymbolicLink()) {
        report({ code: 'symlink', message: 'Symbolic link skipped', paths: [path.relative(root, current.directory)] });
        continue;
      }
      const realDirectory = await fs.realpath(current.directory);
      const relativeDirectory = path.relative(root, realDirectory);
      if (relativeDirectory === '..' || relativeDirectory.startsWith('..' + path.sep) || path.isAbsolute(relativeDirectory)) {
        throw new Error('directory changed to a path outside the video folder');
      }
      const dir = await fs.opendir(realDirectory);
      for await (const entry of dir) {
        signal?.throwIfAborted();
        library.scannedEntries++;
        if (library.scannedEntries > VIDEO_LIBRARY_MAX_ENTRIES) throw new Error(`scan exceeds ${VIDEO_LIBRARY_MAX_ENTRIES} directory entries`);
        const absolute = path.join(realDirectory, entry.name);
        const relative = path.relative(root, absolute);
        if (entry.isSymbolicLink()) {
          report({ code: 'symlink', message: 'Symbolic link skipped', paths: [relative] });
          continue;
        }
        if (entry.isDirectory()) {
          if (current.depth >= VIDEO_LIBRARY_MAX_DEPTH) throw new Error(`scan exceeds ${VIDEO_LIBRARY_MAX_DEPTH} nested directories`);
          pending.push({ directory: absolute, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const parsed = path.parse(entry.name);
        if (!parsed.name.endsWith(suffix) || parsed.name.length === suffix.length) continue;
        if (!extensions.has(parsed.ext.toLowerCase())) {
          report({ code: 'unsupported', message: 'Video container is unsupported; use MP4, M4V, or MOV', paths: [relative] });
          continue;
        }
        if (library.files.length >= VIDEO_LIBRARY_MAX_FILES) throw new Error(`scan exceeds ${VIDEO_LIBRARY_MAX_FILES} matching video files`);
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) {
          report({ code: 'symlink', message: 'Symbolic link skipped', paths: [relative] });
          continue;
        }
        if (!stat.isFile()) throw new Error(`video changed during scan: ${relative}`);
        library.files.push({
          stem: parsed.name.slice(0, -suffix.length), fileName: entry.name, path: absolute, relativePath: relative,
          sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs, version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
        });
      }
    }
    library.files.sort((a, b) => compare(a.relativePath, b.relativePath));
    for (const file of library.files) {
      const ambiguous = library.ambiguous.get(file.stem);
      if (ambiguous) {
        ambiguous.push(file);
      } else {
        const previous = library.byStem.get(file.stem);
        if (previous) {
          library.byStem.delete(file.stem);
          library.ambiguous.set(file.stem, [previous, file]);
        } else {
          library.byStem.set(file.stem, file);
        }
      }
    }
    for (const [stem, files] of library.ambiguous) {
      report({ code: 'ambiguous', message: `Multiple videos match ${stem}; no video will be selected`, paths: files.map(file => file.relativePath) });
    }
    library.scannedAt = Date.now();
    return library;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw new Error(`Cannot scan video directory ${configuredDirectory}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
