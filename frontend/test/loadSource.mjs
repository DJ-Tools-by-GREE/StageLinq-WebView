import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
export const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

export function loadSource(file, mocks = {}, cache = new Map()) {
  file = path.resolve(sourceRoot, file);
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const localRequire = spec => {
    if (Object.hasOwn(mocks, spec)) return mocks[spec];
    if (spec.endsWith('.css')) return {};
    if (!spec.startsWith('.')) return require(spec);
    const base = path.resolve(path.dirname(file), spec).replace(/\.js$/, '');
    const target = [base, base + '.ts', base + '.tsx'].find(candidate => fs.existsSync(candidate));
    if (!target) throw new Error('Cannot resolve ' + spec);
    return loadSource(target, mocks, cache);
  };
  vm.runInThisContext('(function(require,exports,module){' + code + '\n})', { filename: file })(localRequire, exports, { exports });
  return exports;
}

export function hookHarness(file, mocks = {}, exportName = 'default') {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  const hooks = {
    memo(fn) { return fn; },
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(fn, deps) {
      const i = cursor++;
      const old = slots[i];
      if (!old || !deps || deps.some((value, j) => value !== old.deps?.[j])) pendingEffects.push(i);
      slots[i] = { ...old, fn, deps };
    },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!slots[i] || deps.some((value, j) => value !== slots[i].deps?.[j])) slots[i] = { value: fn(), deps };
      return slots[i].value;
    },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const loaded = loadSource(file, { react: hooks, ...mocks });
  const component = loaded[exportName] ?? loaded.CsvImportModal;
  return {
    render(props = {}) { cursor = 0; return component(props); },
    effects() { for (const i of pendingEffects) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].fn(); } pendingEffects = []; },
    cleanup() { for (const slot of slots) slot?.cleanup?.(); },
    remountEffects() { for (const slot of slots) if (slot?.fn) slot.cleanup = slot.fn(); },
  };
}

export function elements(tree, predicate) {
  const found = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (predicate(node)) found.push(node);
    visit(node.props?.children);
  };
  visit(tree);
  return found;
}
