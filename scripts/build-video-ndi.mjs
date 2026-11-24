import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') {
  process.stdout.write('Native video output is supported on macOS; skipping native build.\n');
  process.exit(0);
}
const candidates = [
  process.env.NDI_SDK_DIR,
  '/Library/NDI SDK for Apple',
  '/Library/NDI SDK for macOS',
].filter(Boolean);
let includeDir;
let runtimePath;
for (const candidate of candidates) {
  for (const include of [path.join(candidate, 'include'), candidate]) {
    try {
      await fs.access(path.join(include, 'Processing.NDI.Lib.h'));
      includeDir = include;
      for (const lib of ['lib/macOS/libndi.dylib', 'lib/macOS/libndi.6.dylib', 'lib/libndi.dylib']) {
        const absolute = path.join(candidate, lib);
        try { await fs.access(absolute); runtimePath = absolute; break; } catch {}
      }
      break;
    } catch {}
  }
  if (includeDir) break;
}
if (process.env.NDI_SDK_DIR && !includeDir) {
  throw new Error('NDI_SDK_DIR does not contain include/Processing.NDI.Lib.h');
}
const outputDir = path.join(root, 'native/video-ndi/dist');
await fs.mkdir(outputDir, { recursive: true });
const args = [
  '--sdk', 'macosx', 'clang++', '-std=c++17', '-fobjc-arc', '-O2',
  '-Wall', '-Wextra', '-Wno-deprecated-declarations',
  '-framework', 'Foundation', '-framework', 'AVFoundation',
  '-framework', 'CoreMedia', '-framework', 'CoreVideo',
  '-framework', 'CoreImage', '-framework', 'CoreGraphics',
  '-DSLWV_NDI_AVAILABLE=' + (includeDir ? '1' : '0'),
  ...(includeDir ? ['-I', includeDir] : []),
  ...(runtimePath ? ['-DSLWV_NDI_DEFAULT_RUNTIME=' + JSON.stringify(runtimePath)] : []),
  path.join(root, 'native/video-ndi/main.mm'),
  '-o', path.join(outputDir, 'video-ndi-helper'),
];
const result = spawnSync('xcrun', args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write(includeDir
  ? 'Native video helper built with the official NDI SDK.\n'
  : 'Native decoder/test helper built without NDI. Set NDI_SDK_DIR to your installed SDK and rebuild to enable network output.\n');
