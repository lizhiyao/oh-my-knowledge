import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');
const PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  exports?: Record<string, string | Record<string, string>>;
  bin?: Record<string, string>;
};

/** Next.js 生成的类型文件住在 src/studio/web/.next 下，不是源码模块。 */
const isGenerated = (file: string): boolean => file.split(sep).includes('.next');

function listSourceModules(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fp = join(dir, entry);
    const st = statSync(fp);
    if (st.isDirectory()) {
      if (isGenerated(fp)) continue;
      listSourceModules(fp, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts') && !isGenerated(fp)) {
      out.push(fp);
    }
  }
  return out;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = spec.endsWith('.js')
    ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base]
    : [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

/** 静态与动态 import、require 的字面量目标。 */
function importedModules(file: string): string[] {
  const text = readFileSync(file, 'utf-8');
  const targets = new Set<string>();
  for (const match of text.matchAll(/(?:\bfrom|\bimport|require)\s*\(?\s*'([^']+)'/g)) {
    const target = resolveSpecifier(file, match[1]);
    if (target) targets.add(target);
  }
  return [...targets];
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

function unreachableModules(): { unreachable: string[]; dangling: string[]; rootCount: number } {
  const modules = listSourceModules(SRC_DIR);
  const { roots, dangling } = productionRoots(modules);
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const target of importedModules(file)) if (!seen.has(target)) queue.push(target);
  }
  return {
    unreachable: modules.filter((file) => !seen.has(file)).map(toRepoRelative).sort(),
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
    const { unreachable, rootCount } = unreachableModules();
    expect(rootCount).toBeGreaterThan(0);
    const registered = NON_STATIC_ENTRIES.map((entry) => entry.path).sort();
    // 双向：未登记的不可达模块＝停在生产层里的非生产代码；已登记却静态可达的＝腐烂条目。
    expect({ unreachable, registered }).toEqual({ unreachable: registered, registered });
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
