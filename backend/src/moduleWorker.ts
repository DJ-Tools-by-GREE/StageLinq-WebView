import { Worker } from 'node:worker_threads';

export function createModuleWorker(workerUrl: URL): Worker {
  if (!workerUrl.pathname.endsWith('.ts')) return new Worker(workerUrl);

  // Worker threads need their own tsx resolver for .js imports of TypeScript sources.
  const bootstrap = `import { tsImport } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
await tsImport(${JSON.stringify(workerUrl.href)}, ${JSON.stringify(import.meta.url)});`;
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`));
}
