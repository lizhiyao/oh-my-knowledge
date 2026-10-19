import ts from 'typescript';
import { sourceFiles, parseSourceFile, sourceModuleReferences, resolveSourceModule } from '../helpers/source-files.js';
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');
const PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  exports?: Record<string, string | Record<string, string>>;
  bin?: Record<string, string>;
};

/** 静态与动态 import、require 的字面量目标。 */
function importedModules(file: string): string[] {
  return [...new Set(sourceModuleReferences(parseSourceFile(file)).flatMap(({ specifier }) => {
    if (!ts.isStringLiteralLike(specifier)) return [];
    const target = resolveSourceModule(file, specifier.text);
    return target ? [target] : [];
  }))];
}

const toRepoRelative = (file: string): string => relative(REPO_ROOT, file).split(sep).join('/');

/** 把 package.json 里指向 dist 的入口映射回源模块；映射不到就是入口悬空。 */
function packageEntryTargets(): Array<{ declared: string; source: string | null }> {
  const declared: string[] = [];
  for (const value of Object.values(PACKAGE_JSON.exports ?? {})) {
    const specs = typeof value === 'string' ? [value] : Object.values(value);
    for (const spec of specs) {
      if (typeof spec === 'string' && !spec.includes('*') && spec.endsWith('.js')) declared.push(spec);
    }
  }
  for (const binPath of Object.values(PACKAGE_JSON.bin ?? {})) declared.push(binPath);
  return [...new Set(declared)].map((entry) => {
    const relDist = entry.replace(/^\.\//, '').replace(/^dist\//, '');
    const source = ['src/' + relDist.replace(/\.js$/, '.ts'), 'src/' + relDist.replace(/\.js$/, '.tsx')]
      .find((candidate) => existsSync(join(REPO_ROOT, candidate)));
    return { declared: entry, source: source ?? null };
  });
}

/**
 * 不经静态 import 到达、但确实是生产入口的模块。
 *
 * 每条都要给出可机器复核的理由：subprocess 必须有 src 里的 spawn／URL 目标串，
 * build-script 必须真的被 scripts/ 导入，package-entrypoint 必须同时登记在
 * src-root-layout 的 PACKAGE_ENTRYPOINTS 里。理由失效即红，登记表不允许腐烂。
 */
const NON_STATIC_ENTRIES: Array<{
  path: string;
  reason: 'subprocess' | 'build-script' | 'package-entrypoint';
  evidence?: string;
}> = [
  {
    path: 'src/cli/lib/update-fetch-worker.ts',
    reason: 'subprocess',
    evidence: 'src/cli/lib/update-check.ts',
  },
  {
    path: 'src/observability/conversation/index-process.ts',
    reason: 'subprocess',
    evidence: 'src/observability/conversation/catalog.ts',
  },
  {
    path: 'src/eval-workflows/inputs/schemas/json-schema.ts',
    reason: 'build-script',
    evidence: 'scripts/build/schemas-samples.mjs',
  },
  {
    path: 'src/cli/runtime/entity-capture.ts',
    reason: 'build-script',
    evidence: 'scripts/bench/entity-capture-provider.ts',
  },
  {
    path: 'src/cli/runtime/knowledge-study.ts',
    reason: 'build-script',
    evidence: 'scripts/bench/knowledge-study.ts',
  },
  { path: 'src/eval-workflows/inputs/eval-samples.ts', reason: 'package-entrypoint' },
  { path: 'src/eval-workflows/projections/index.ts', reason: 'package-entrypoint' },
];

const NEXT_ENTRY_PATTERN = /(?:^|\/)(?:page|layout|route|template|error|not-found|loading)\.tsx?$/;

function productionRoots(modules: string[]): { roots: Set<string>; dangling: string[] } {
  const roots = new Set<string>();
  const dangling: string[] = [];
  for (const entry of packageEntryTargets()) {
    if (!entry.source) {
      dangling.push(entry.declared);
      continue;
    }
    roots.add(join(REPO_ROOT, entry.source));
  }
  for (const module of modules) {
    const rel = toRepoRelative(module);
    // oclif 按路径发现命令，Next 按文件约定发现页面：两者都是运行时入口，没有静态 importer。
    if (rel.startsWith('src/cli/commands/')
      || rel === 'src/cli/index.ts'
      || (rel.startsWith('src/studio/') && NEXT_ENTRY_PATTERN.test(rel))) {
      roots.add(module);
    }
  }
  return { roots, dangling };
}

function unreachableModules(): { unreachable: string[]; redundantEntries: string[]; dangling: string[]; rootCount: number } {
  const modules = sourceFiles(SRC_DIR, { skippedDirectories: new Set(['.next', 'node_modules']) });
  const { roots, dangling } = productionRoots(modules);
  const seen = new Set<string>();
  const visit = (entries: Iterable<string>) => {
    const queue = [...entries];
    while (queue.length) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const target of importedModules(file)) if (!seen.has(target)) queue.push(target);
    }
  };
  visit(roots);
  const redundantEntries = NON_STATIC_ENTRIES.filter(entry => seen.has(join(REPO_ROOT, entry.path))).map(entry => entry.path).sort();
  // 有具体入口证据的组合根及其静态依赖都属于生产闭包，不逐个豁免其实现模块。
  visit(NON_STATIC_ENTRIES.map(entry => join(REPO_ROOT, entry.path)));
  return {
    unreachable: modules.filter((file) => !seen.has(file)).map(toRepoRelative).sort(),
    redundantEntries,
    dangling,
    rootCount: roots.size,
  };
}

describe('生产可达性守门', () => {
  it('package.json 的每个入口都指向真实源模块', () => {
    const { dangling } = unreachableModules();
    expect(dangling).toEqual([]);
  });

  it('src 下不存在生产入口到不了的模块（非静态入口必须登记并给出可复核理由）', () => {
    const { unreachable, redundantEntries, rootCount } = unreachableModules();
    expect(rootCount).toBeGreaterThan(0);
    // 双向：闭包外模块是孤儿；已静态可达的额外入口登记是腐烂条目。
    expect({ unreachable, redundantEntries }).toEqual({ unreachable: [], redundantEntries: [] });
  });

  it('每条非静态入口登记都仍然成立', () => {
    for (const entry of NON_STATIC_ENTRIES) {
      const abs = join(REPO_ROOT, entry.path);
      expect({ path: entry.path, exists: existsSync(abs) }).toEqual({ path: entry.path, exists: true });
      const stem = entry.path.replace(/\.tsx?$/, '');
      const base = `${stem.slice(stem.lastIndexOf('/') + 1)}.js`;
      if (entry.reason === 'package-entrypoint') {
        const layoutGuard = readFileSync(join(REPO_ROOT, 'test/architecture/src-root-layout.test.ts'), 'utf-8');
        expect({ path: entry.path, declaredAsEntrypoint: layoutGuard.includes(`'${entry.path.replace(/^src\//, '')}'`) })
          .toEqual({ path: entry.path, declaredAsEntrypoint: true });
        continue;
      }
      const evidenceFile = join(REPO_ROOT, entry.evidence as string);
      expect({ path: entry.path, evidenceExists: existsSync(evidenceFile) })
        .toEqual({ path: entry.path, evidenceExists: true });
      const evidence = readFileSync(evidenceFile, 'utf-8');
      expect({ path: entry.path, reason: entry.reason, referencedByEvidence: evidence.includes(base) })
        .toEqual({ path: entry.path, reason: entry.reason, referencedByEvidence: true });
    }
  });
});
