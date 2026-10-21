import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTRACTION_STUDY_DEPENDENCY_SEEDS } from '../../src/knowledge/adapters/study-host.js';
import { parseSourceFile, resolveSourceModule, sourceFiles, sourceModuleReferences } from '../helpers/source-files.js';

const repository = resolve('.'), source = join(repository, 'src');
const roots = ['cli/runtime/knowledge-study.ts', 'cli/runtime/knowledge-study-worker.ts',
  'knowledge/application/study-inspection-service.ts', 'knowledge/application/study-inspection-worker.ts'];
// These exact two imports construct injected executors. Producer proofs/capability validation stay in the closure.
const executionImports = new Set(['executors/openai/archive.ts', 'executors/openai/codex/archive.ts']);
function manifestFor(importer: string, name: string): string {
  const require = createRequire(importer);
  try { return realpathSync(require.resolve(`${name}/package.json`)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    let directory = dirname(realpathSync(require.resolve(name)));
    while (true) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return realpathSync(manifest);
      const parent = dirname(directory); if (parent === directory) throw new Error('Unresolved package manifest.'); directory = parent;
    }
  }
}
function coveredManifests() {
  const pending = EXTRACTION_STUDY_DEPENDENCY_SEEDS.map(name => ({ importer: join(source, 'knowledge/adapters/study-host.ts'), name: String(name) }));
  const covered = new Set<string>();
  for (const item of pending) {
    const manifest = manifestFor(item.importer, item.name); if (covered.has(manifest)) continue; covered.add(manifest);
    const data = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> };
    for (const name of Object.keys(data.dependencies ?? {})) pending.push({ importer: manifest, name });
  }
  return covered;
}
function audit(entries: string[], covered: ReadonlySet<string>, allowExecutionImports = false) {
  const seen = new Set<string>(), cut = new Set<string>(), violations: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return; seen.add(file);
    const parsed = parseSourceFile(file), rel = relative(source, file).split('\\').join('/');
    for (const ref of sourceModuleReferences(parsed)) {
      if (ref.typeOnly) continue;
      if (!ts.isStringLiteralLike(ref.specifier)) { violations.push(`${rel}: opaque runtime load`); continue; }
      const specifier = ref.specifier.text;
      if (specifier === 'node:worker_threads' && rel !== 'shared/worker-job.ts') {
        violations.push(`${rel}: worker construction must use a registered fixed delivery client`);
      }
      if (isBuiltin(specifier)) continue;
      if (specifier.startsWith('.')) {
        const target = resolveSourceModule(file, specifier);
        if (!target) { violations.push(`${rel}: unresolved ${specifier}`); continue; }
        if (target === join(source, 'shared/worker-job.ts')) {
          const declaration = ref.specifier.parent;
          const bindings = ts.isImportDeclaration(declaration) ? declaration.importClause?.namedBindings : undefined;
          const importsFactory = !bindings || !ts.isNamedImports(bindings)
            || bindings.elements.some(binding => (binding.propertyName ?? binding.name).text === 'createWorkerJobService');
          if (importsFactory && !['cli/runtime/knowledge-study.ts', 'knowledge/application/study-inspection-service.ts'].includes(rel)) {
            violations.push(`${rel}: unregistered worker service factory`);
          }
        }
        if (allowExecutionImports && executionImports.has(rel) && target === join(source, 'executors/index.ts')) {
          const declaration = ref.specifier.parent;
          const bindings = ts.isImportDeclaration(declaration) ? declaration.importClause?.namedBindings : undefined;
          if (!ts.isImportDeclaration(declaration) || declaration.importClause?.name || !bindings || !ts.isNamedImports(bindings)
            || bindings.elements.length !== 1 || bindings.elements[0].name.text !== 'createExecutor' || bindings.elements[0].propertyName) {
            violations.push(`${rel}: execution boundary import changed`);
          } else cut.add(rel);
          continue;
        }
        visit(target);
      } else {
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        try { createRequire(file).resolve(specifier); if (!covered.has(manifestFor(file, name))) violations.push(`${rel}: uncovered ${specifier}`); }
        catch { violations.push(`${rel}: unresolved package ${specifier}`); }
      }
    }
  };
  entries.forEach(visit); return { violations: violations.sort(), cut: [...cut].sort() };
}
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('study checker dependency-byte coverage', () => {
  it('covers both fixed workers and their real validation imports, with exact executor construction boundaries', () => {
    expect(EXTRACTION_STUDY_DEPENDENCY_SEEDS).toEqual(['zod', 'ajv', 'js-yaml', 'smol-toml']);
    expect(audit(roots.map(path => join(source, path)), coveredManifests(), true))
      .toEqual({ violations: [], cut: [...executionImports].sort() });
    const pairs = [ ['cli/runtime/knowledge-study.ts', './knowledge-study-worker.js', 'cooperative'],
      ['knowledge/application/study-inspection-service.ts', './study-inspection-worker.js', 'terminate'] ];
    for (const [file, worker, cancellation] of pairs) {
      const parsed = parseSourceFile(join(source, file));
      const calls: ts.CallExpression[] = [];
      const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'createWorkerJobService') calls.push(node); ts.forEachChild(node, visit); };
      visit(parsed); expect(calls).toHaveLength(1); expect(calls[0].arguments).toHaveLength(2);
      expect(calls[0].arguments[1].getText(parsed)).toBe(`'${cancellation}'`);
      expect(calls[0].arguments[0].getText(parsed)).toBe(`new URL('${worker}', import.meta.url)`);
    }
    // A sync processor remains a worker/unit boundary, never a second product entry.
    const importers = sourceFiles(source).filter(file => sourceModuleReferences(parseSourceFile(file)).some(ref =>
      !ref.typeOnly && ts.isStringLiteralLike(ref.specifier) && resolveSourceModule(file, ref.specifier.text) === join(source, 'knowledge/application/study-inspection.ts')));
    expect(importers.map(file => relative(source, file))).toEqual(['knowledge/application/study-inspection-worker.ts']);
  });

  it('fails on uncovered package versions, opaque loads and unresolved local modules, while ignoring type-only imports', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-imports-'))); temporary.push(directory);
    const entry = join(directory, 'entry.ts'), packageRoot = join(directory, 'node_modules/uncovered-validator'); mkdirSync(packageRoot, { recursive: true });
    const manifest = join(packageRoot, 'package.json'); writeFileSync(manifest, '{"name":"uncovered-validator","version":"1.0.0","main":"index.js"}');
    writeFileSync(join(packageRoot, 'index.js'), 'module.exports = {};'); writeFileSync(join(packageRoot, 'subpath.js'), 'module.exports = {};');
    writeFileSync(entry, "import type { Missing } from 'unavailable-types'; import 'node:crypto'; import 'uncovered-validator/subpath';");
    expect(audit([entry], new Set()).violations).toEqual([expect.stringContaining('uncovered uncovered-validator/subpath')]);
    expect(audit([entry], new Set([realpathSync(manifest)]))).toEqual({ violations: [], cut: [] });
    writeFileSync(entry, "const name = './data.js'; void import(name); import './missing.js';");
    expect(audit([entry], new Set()).violations).toEqual([expect.stringContaining('opaque runtime load'), expect.stringContaining('unresolved ./missing.js')]);
    const otherManifest = join(directory, 'other-package.json'); writeFileSync(otherManifest, readFileSync(manifest));
    writeFileSync(entry, "import 'uncovered-validator';");
    expect(audit([entry], new Set([otherManifest])).violations).toEqual([expect.stringContaining('uncovered uncovered-validator')]);
  });
});
