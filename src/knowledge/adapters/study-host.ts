import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../store.js';
import type { ExtractionStudyHost } from '../extraction/study-plan.js';

const bytesDigest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function codeFiles(root: string, prefix = ''): { path: string; digest: string }[] {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap(entry => {
    const path = join(root, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Frozen study runtime must not contain symbolic code links.');
    if (entry.name === 'node_modules' || relative === 'studio/web' || relative.startsWith('studio/web/')) return [];
    if (entry.isDirectory()) return codeFiles(path, relative);
    return entry.isFile() && /\.(?:js|mjs|cjs|json|wasm|node|txt|yaml)$/.test(entry.name) ? [{ path: relative, digest: bytesDigest(readFileSync(path)) }] : [];
  });
}

function dependencyFiles() {
  const require = createRequire(import.meta.url), pending = [
    { require, name: 'zod' }, { require, name: 'ajv' }, { require, name: 'js-yaml' }, { require, name: 'smol-toml' },
  ];
  const seen = new Set<string>(), result: { name: string; manifest: string; code: ReturnType<typeof codeFiles> }[] = [];
  for (const item of pending) {
    let manifestPath: string;
    try { manifestPath = realpathSync(item.require.resolve(`${item.name}/package.json`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      let directory = dirname(realpathSync(item.require.resolve(item.name)));
      while (true) {
        const path = join(directory, 'package.json');
        if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).name === item.name) { manifestPath = path; break; }
        const parent = dirname(directory);
        if (parent === directory) throw new Error('Study dependency manifest is unavailable.');
        directory = parent;
      }
    }
    if (seen.has(manifestPath)) continue;
    seen.add(manifestPath);
    const bytes = readFileSync(manifestPath), manifest = JSON.parse(bytes.toString('utf8')) as { name: string; dependencies?: Record<string, string> };
    const nestedRequire = createRequire(manifestPath);
    for (const name of Object.keys(manifest.dependencies ?? {}).sort()) pending.push({ require: nestedRequire, name });
    result.push({ name: manifest.name, manifest: bytesDigest(bytes), code: codeFiles(dirname(manifestPath)) });
  }
  return result.sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
}

/** Fixed installed runtime paths only. Portable input cannot choose code or its expected identity. */
export function extractionStudyHostIdentity(): ExtractionStudyHost {
  if (!import.meta.url.endsWith('/study-host.js')) throw new Error('Study identity requires the built runtime.');
  const runtime = fileURLToPath(new URL('../../', import.meta.url));
  const files = codeFiles(runtime);
  const dependencies = dependencyFiles();
  const runnerPaths = new Set(['cli/runtime/knowledge-study.js', 'knowledge/application/study-runner.js', 'knowledge/application/study-local.js',
    'knowledge/extraction/study-plan.js', 'knowledge/extraction/study-corpus.js', 'knowledge/extraction/study-review.js',
    'knowledge/extraction/study-analysis.js', 'knowledge/adapters/study-files.js', 'knowledge/adapters/study-host.js']);
  const runner = files.filter(file => runnerPaths.has(file.path));
  if (runner.length !== runnerPaths.size) throw new Error('Study runtime build is incomplete.');
  return {
    runtimeDigest: bytesDigest(canonicalJson(files)), dependencyDigest: bytesDigest(canonicalJson(dependencies)),
    runnerDigest: bytesDigest(canonicalJson(runner)), nodeVersion: process.version,
    nodeBinaryDigest: bytesDigest(readFileSync(process.execPath)),
  };
}
