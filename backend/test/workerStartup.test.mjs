import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/workerStartup.mjs', import.meta.url));

for (const [name, args] of [
  ['development with the tsx CLI', [fileURLToPath(import.meta.resolve('tsx/cli')), fixture, 'src']],
  ['development with native TypeScript support', ['--import', 'tsx', fixture, 'src']],
  ['development without native TypeScript support', ['--no-experimental-strip-types', '--import', 'tsx', fixture, 'src']],
  ['compiled production', [fixture, 'dist']],
]) {
  test(`Art-Net and waveform workers start in ${name}`, { timeout: 20000 }, async () => {
    const { stderr } = await run(process.execPath, args, { timeout: 15000 });
    assert.equal(stderr, '');
  });
}
