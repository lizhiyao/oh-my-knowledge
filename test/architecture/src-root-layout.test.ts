import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = resolve('src');
const EXPECTED_ROOT_DIRECTORIES = [
  'cli',
  'diagnosis',
  'dsh-plugin',
  'eval-core',
  'eval-runtime',
  'eval-workflows',
  'evidence',
  'executors',
  'knowledge-artifacts',
  'mcp',
  'observability',
  'shared',
  'studio',
] as const;

const PACKAGE_ENTRYPOINTS = new Set([
  'index.ts',
  'dsh-plugin/index.ts',
  'eval-core/index.ts',
  'eval-runtime/index.ts',
  'eval-workflows/inputs/eval-samples.ts',
  'eval-workflows/projections/index.ts',
  'mcp/index.ts',
  'studio/index.ts',
]);

const EXPECTED_SHARED_FILES = [
  'atomic-json.ts',
  'content-hash.ts',
  'file-lock.ts',
  'json-safe-truncation.ts',
  'json-value.ts',
  'keyed-mutex.ts',
  'language.ts',
  'record-count.ts',
  'shell-quote.ts',
  'time.ts',
  'timestamp.ts',
] as const;

const RETIRED_TOP_LEVEL_DIRECTORIES = [
  'artifact-graph',
  'authoring',
  'doctor',
  'evaluation-core',
  'grading',
  'inputs',
  'managed',
  'measurement-artifacts',
  'package-api',
  'preflight',
  'skill-definition',
] as const;

function sourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

function sourceRelative(path: string): string {
  return relative(SRC_ROOT, path).split(sep).join('/');
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
}

function resolveLocalModule(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const unresolved = normalize(resolve(dirname(importer), specifier));
  const candidates = specifier.endsWith('.js')
    ? [unresolved.replace(/\.js$/, '.ts'), unresolved.replace(/\.js$/, '.tsx')]
    : [unresolved, `${unresolved}.ts`, `${unresolved}.tsx`, join(unresolved, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate));
}

describe('src 最终领域地图', () => {
  it('一级目录和文件与稳定领域地图完全一致', () => {
    const entries = readdirSync(SRC_ROOT, { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      .toEqual([...EXPECTED_ROOT_DIRECTORIES].sort());
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
      .toEqual(['index.ts']);
  });

  it('shared 只保留无领域语义且不依赖上层的技术叶子', () => {
    const entries = readdirSync(resolve('src/shared'), { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      .toEqual([]);
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
      .toEqual([...EXPECTED_SHARED_FILES].sort());
  });

  it('Evidence 只由 storage 与 graph 两个事实子域组成', () => {
    const entries = readdirSync(resolve('src/evidence'), { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      .toEqual(['graph', 'storage']);
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
      .toEqual([]);
  });

  it('不恢复任何迁移前的顶层目录或构建产物', () => {
    const violations = RETIRED_TOP_LEVEL_DIRECTORIES.flatMap((directory) => [
      `src/${directory}`,
      `test/${directory}`,
      ...(existsSync(resolve('dist')) ? [`dist/${directory}`] : []),
    ]).filter((path) => existsSync(resolve(path)));
    expect(violations).toEqual([]);
  });

  it('不保留集中式 API 目录或批量 public.ts', () => {
    expect(existsSync(resolve('src/package-api'))).toBe(false);
    expect(existsSync(resolve('src/public-api'))).toBe(false);
    expect(existsSync(resolve('src/exports'))).toBe(false);
    expect(sourceFiles(SRC_ROOT).map(sourceRelative).filter((path) => path.endsWith('/public.ts')))
      .toEqual([]);
  });

  it('内部生产代码不经 package 聚合入口跨域依赖', () => {
    const violations: string[] = [];
    for (const importer of sourceFiles(SRC_ROOT)) {
      const importerRelative = sourceRelative(importer);
      for (const specifier of importSpecifiers(readFileSync(importer, 'utf8'))) {
        if (specifier === 'oh-my-knowledge' || specifier.startsWith('oh-my-knowledge/')) {
          violations.push(`${importerRelative} → ${specifier}`);
          continue;
        }
        const target = resolveLocalModule(importer, specifier);
        if (!target) continue;
        const targetRelative = sourceRelative(target);
        if (PACKAGE_ENTRYPOINTS.has(targetRelative)) {
          violations.push(`${importerRelative} → ${targetRelative}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('package exports 直接指向所属领域的自然入口', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
    });
    expect(manifest.exports['./eval-core']).toEqual({
      types: './dist/eval-core/index.d.ts',
      import: './dist/eval-core/index.js',
    });
    expect(manifest.exports['./eval-runtime']).toEqual({
      types: './dist/eval-runtime/index.d.ts',
      import: './dist/eval-runtime/index.js',
    });
    expect(manifest.exports['./eval-samples']).toEqual({
      types: './dist/eval-workflows/inputs/eval-samples.d.ts',
      import: './dist/eval-workflows/inputs/eval-samples.js',
    });
    expect(manifest.exports['./projections']).toEqual({
      types: './dist/eval-workflows/projections/index.d.ts',
      import: './dist/eval-workflows/projections/index.js',
    });
    expect(manifest.exports['./studio']).toEqual({
      types: './dist/studio/index.d.ts',
      import: './dist/studio/index.js',
    });
    expect(manifest.exports['./mcp']).toEqual({
      types: './dist/mcp/index.d.ts',
      import: './dist/mcp/index.js',
    });
    expect(manifest.exports['./dsh-plugin']).toEqual({
      types: './dist/dsh-plugin/index.d.ts',
      import: './dist/dsh-plugin/index.js',
    });
    expect(JSON.stringify(manifest.exports)).not.toContain('/package-api/');
    expect(manifest.exports).not.toHaveProperty('./evaluation-core');
  });
});
