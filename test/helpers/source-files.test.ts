import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { testDirectory } from './temp-directory.js';
import { MODULE_SOURCE_EXTENSIONS, parseSourceFile, resolveSourceModule, sourceFiles, sourceModuleReferences, sourceScriptKind } from './source-files.js';

const references = (text: string, file = 'fixture.ts') => sourceModuleReferences(parseSourceFile(file, text))
  .map(({ specifier, typeOnly, referenceKind }) => ({
    specifier: ts.isStringLiteralLike(specifier) ? specifier.text : specifier.getText(), typeOnly, referenceKind,
  }));

describe('shared source analysis', () => {
  it.each(["'", '"', '`'])('recognizes literal loads quoted with %s without evaluating source', quote => {
    const literal = (text: string) => `${quote}${text}${quote}`;
    const text = `throw new Error('never evaluate');\nvoid import(${literal('./dynamic.js')}, { with: { type: 'json' } }); require(${literal('./common.cjs')});`;
    expect(references(text)).toEqual([
      { specifier: './dynamic.js', typeOnly: false, referenceKind: 'dynamic-import' },
      { specifier: './common.cjs', typeOnly: false, referenceKind: 'require' },
    ]);
  });
  it.each(["'", '"'])('recognizes static imports and exports quoted with %s', quote => {
    expect(references(`import Value from ${quote}./value.js${quote}; export { Value } from ${quote}./export.js${quote};`))
      .toEqual([
        { specifier: './value.js', typeOnly: false, referenceKind: 'import' },
        { specifier: './export.js', typeOnly: false, referenceKind: 'export' },
      ]);
  });
  it('distinguishes erased types from runtime side effects and mixed bindings', () => {
    const text = `
      import type { A } from './a.js';
      import { type B } from './b.js';
      import Default, { type C } from './c.js';
      import { D, type E } from './d.js';
      import {} from './e.js';
      import './f.js';
      export type { G } from './g.js';
      export { type H } from './h.js';
      export { I, type J } from './i.js';
      export {} from './j.js';
      export * from './k.js';
      type Value = import('./l.js').Value;
      import Legacy = require('./m.cjs');
      import type LegacyType = require('./n.cjs');
    `;
    expect(references(text).map(ref => ref.typeOnly)).toEqual([
      true, true, false, false, false, false, true, true, false, false, false, true, false, true,
    ]);
    expect(references(text).slice(-3).map(ref => ref.referenceKind)).toEqual(['import-type', 'import-equals', 'import-equals']);
  });
  it('keeps non-literal loads visible and ignores comments, text, and method names', () => {
    expect(references(`
      // import './comment.js';
      const text = "from './text.js'";
      const template = \`require('./template.js')\`;
      object.require('./method.js');
      void import(runtimeTarget); require(requireTarget);
    `)).toEqual([
      { specifier: 'runtimeTarget', typeOnly: false, referenceKind: 'dynamic-import' },
      { specifier: 'requireTarget', typeOnly: false, referenceKind: 'require' },
    ]);
  });
  it.each(MODULE_SOURCE_EXTENSIONS)('parses nested module calls inside %s sources', extension => {
    const jsx = ['.tsx', '.jsx'].includes(extension);
    const code = jsx ? `const node = <div onClick={() => import('./view.js')} />;` : `function load() { return require('./nested.js'); }`;
    expect(references(code, 'fixture' + extension)).toEqual([
      { specifier: jsx ? './view.js' : './nested.js', typeOnly: false, referenceKind: jsx ? 'dynamic-import' : 'require' },
    ]);
    expect(sourceScriptKind('fixture' + extension)).toBe(jsx
      ? extension === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.JSX
      : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  });
  it('separates TypeScript-only and complete module scans and excludes generated declarations', () => {
    const root = testDirectory('omk-source-scan-');
    for (const extension of MODULE_SOURCE_EXTENSIONS) writeFileSync(join(root, 'source' + extension), '');
    for (const name of ['types.d.ts', 'types.d.mts', 'types.d.cts']) writeFileSync(join(root, name), '');
    for (const directory of ['.next', 'node_modules', 'dist', 'coverage']) {
      mkdirSync(join(root, directory)); writeFileSync(join(root, directory, 'generated.ts'), '');
    }
    expect(sourceFiles(root)).toEqual(['source.ts', 'source.tsx'].map(name => join(root, name)));
    expect(sourceFiles(root, { extensions: MODULE_SOURCE_EXTENSIONS })).toHaveLength(MODULE_SOURCE_EXTENSIONS.length);
    expect(sourceFiles(root, { skippedDirectories: new Set() })).toHaveLength(6);
    expect(sourceFiles(root, { skippedDirectories: new Set(['.next', 'node_modules']) })).toHaveLength(4);
    expect(() => sourceFiles(join(root, 'missing'))).toThrow();
  });
  it.each([
    ['./value.js', 'value.ts'], ['./view.js', 'view.tsx'], ['./module.mjs', 'module.mts'],
    ['./common.cjs', 'common.cts'], ['./legacy.cjs', 'legacy.cjs'], ['./jsx.jsx', 'jsx.tsx'],
    ['./folder', 'folder/index.ts'], ['./plain', 'plain.js'],
  ])('resolves %s to the actual source %s', (specifier, name) => {
    const root = testDirectory('omk-source-resolve-');
    mkdirSync(join(root, 'folder')); writeFileSync(join(root, name), '');
    expect(resolveSourceModule(join(root, 'importer.ts'), specifier)).toBe(join(root, name));
    expect(resolveSourceModule(join(root, 'importer.ts'), './missing.js')).toBeNull();
    expect(resolveSourceModule(join(root, 'importer.ts'), 'node:fs')).toBeNull();
  });
  it('prefers TypeScript over emitted JS and never returns a directory', () => {
    const root = testDirectory('omk-source-priority-');
    writeFileSync(join(root, 'value.ts'), ''); writeFileSync(join(root, 'value.js'), '');
    mkdirSync(join(root, 'directory.js'));
    writeFileSync(join(root, 'module.mts'), '');
    expect(resolveSourceModule(join(root, 'importer.ts'), './module.js')).toBeNull();
    expect(resolveSourceModule(join(root, 'importer.ts'), './value', { extensions: ['.mts'] })).toBeNull();
    expect(resolveSourceModule(join(root, 'importer.ts'), './value.js')).toBe(join(root, 'value.ts'));
    expect(resolveSourceModule(join(root, 'importer.ts'), './directory.js')).toBeNull();
  });
});
