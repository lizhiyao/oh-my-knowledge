import { MODULE_SOURCE_EXTENSIONS, sourceFiles, sourceScriptKind as scriptKind, parseSourceFile, sourceModuleReferences, resolveSourceModule as resolveLocalModule } from '../helpers/source-files.js';
import { REGISTERED_RUNTIME_CYCLES, REGISTERED_NON_LITERAL_DYNAMIC_IMPORTS, MUTUAL_BOUNDARY_VALIDATORS } from './dependency-exceptions.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = resolve('src');
const SCRIPTS_DIR = resolve('scripts');
const SOURCE_ROOTS = [SRC_DIR, SCRIPTS_DIR];
const SOURCE_SCAN_OPTIONS = {
  extensions: MODULE_SOURCE_EXTENSIONS,
  skippedDirectories: new Set(['.next', 'node_modules']),
};
const COMPOSITION_ROOT_PREFIXES = [
  'scripts/',
  'cli/',
  'dsh-plugin/',
  'eval-workflows/hosts/',
  'mcp/',
  'studio/',
] as const;
const EVAL_WORKFLOW_SUBDOMAINS = new Set([
  'analysis',
  'artifact-store',
  'assertions',
  'gold',
  'hosts',
  'input-compilation',
  'inputs',
  'instruments',
  'measurement',
  'orchestration',
  'projections',
  'resume-disposition',
  'sample-generation',
]);

// 知识伞下保留领域所有权；仅有类型依赖的方向不能借目录合并升级成 runtime 依赖。
const KNOWLEDGE_SUBDOMAIN_DEPENDENCIES: Record<string, { runtime: readonly string[]; typeOnly?: readonly string[] }> = {
  'knowledge/adapters': { runtime: ['knowledge', 'knowledge/entities', 'knowledge/extraction', 'knowledge/entity-library', 'knowledge/entity-linking'] },
  'knowledge/application': { runtime: ['knowledge', 'knowledge/adapters', 'knowledge/entities', 'knowledge/extraction', 'knowledge/entity-library', 'knowledge/entity-linking'] },
  'knowledge/artifacts/authoring': { runtime: ['knowledge/artifacts/sources'], typeOnly: ['knowledge'] },
  'knowledge/artifacts/doctor': { runtime: ['knowledge/artifacts/authoring', 'knowledge/artifacts/skills', 'knowledge/artifacts/sources'], typeOnly: ['knowledge/artifacts'] },
  'knowledge/artifacts/sources': { runtime: ['knowledge/artifacts/skills'], typeOnly: ['knowledge/artifacts'] },
  'knowledge/entities': { runtime: ['knowledge', 'knowledge/entity-library'] },
  'knowledge/extraction': { runtime: ['knowledge', 'knowledge/adapters', 'knowledge/entities'] },
  'knowledge/entity-library': { runtime: ['knowledge'] },
  'knowledge/entity-linking': { runtime: ['knowledge', 'knowledge/adapters', 'knowledge/application', 'knowledge/entities', 'knowledge/entity-library'] },
};

interface ModuleEdge {
  importer: string;
  target: string;
  importerDomain: string;
  targetDomain: string;
  typeOnly: boolean;
}

interface NonLiteralDynamicImport {
  importer: string;
  expression: string;
  sourceSha256: string;
}

interface DependencyGraph {
  edges: ModuleEdge[];
  nonLiteralDynamicImports: NonLiteralDynamicImport[];
}

function sourceRelative(path: string): string {
  const root = path.startsWith(`${SRC_DIR}${sep}`) ? SRC_DIR : resolve('.');
  return relative(root, path).split(sep).join('/');
}

function moduleDomain(path: string): string {
  const [topLevel, subdomain, lifecycle] = path.split('/');
  if (topLevel === 'eval-core' && subdomain !== undefined && subdomain.includes('.') === false) {
    return `${topLevel}/${subdomain}`;
  }
  if (topLevel === 'knowledge') {
    if (subdomain === 'artifacts' && ['authoring', 'doctor', 'skills', 'sources'].includes(lifecycle)) {
      return `${topLevel}/${subdomain}/${lifecycle}`;
    }
    if (['adapters', 'application', 'artifacts', 'entities', 'extraction', 'entity-library', 'entity-linking'].includes(subdomain)) {
      return `${topLevel}/${subdomain}`;
    }
  }
  if (
    topLevel === 'eval-workflows'
    && EVAL_WORKFLOW_SUBDOMAINS.has(subdomain)
  ) {
    return `${topLevel}/${subdomain}`;
  }
  if (topLevel === 'evidence' && ['graph', 'storage'].includes(subdomain)) {
    return `${topLevel}/${subdomain}`;
  }
  if (topLevel === 'executors' && subdomain === 'preflight') {
    return `${topLevel}/${subdomain}`;
  }
  return topLevel;
}

function collectDependencyGraph(): DependencyGraph {
  const edges: ModuleEdge[] = [];
  const nonLiteralDynamicImports: NonLiteralDynamicImport[] = [];
  const add = (importer: string, specifier: string, typeOnly: boolean): void => {
    const target = resolveLocalModule(importer, specifier);
    if (!target || !SOURCE_ROOTS.some((root) => target.startsWith(`${root}${sep}`))) return;
    const importerRelative = sourceRelative(importer);
    const targetRelative = sourceRelative(target);
    const importerDomain = moduleDomain(importerRelative);
    const targetDomain = moduleDomain(targetRelative);
    if (importerDomain === targetDomain) return;
    edges.push({
      importer: importerRelative,
      target: targetRelative,
      importerDomain,
      targetDomain,
      typeOnly,
    });
  };

  for (const file of SOURCE_ROOTS.flatMap((root) => sourceFiles(root, SOURCE_SCAN_OPTIONS))) {
    const sourceText = readFileSync(file, 'utf8');
    const canonicalSource = sourceText.replaceAll('\r\n', '\n');
    const sourceSha256 = createHash('sha256').update(canonicalSource).digest('hex');
    const source = parseSourceFile(file, sourceText);
    for (const { specifier, typeOnly } of sourceModuleReferences(source)) {
      if (ts.isStringLiteralLike(specifier)) add(file, specifier.text, typeOnly);
      else nonLiteralDynamicImports.push({
        importer: sourceRelative(file), expression: specifier.getText(source), sourceSha256,
      });
    }
  }
  return { edges, nonLiteralDynamicImports };
}

function isContractBoundary(target: string): boolean {
  return target.includes('/contracts/')
    || target.endsWith('/contracts.ts');
}

function domainPair(left: string, right: string): string {
  return [left, right].sort().join('↔');
}

function describeEdge(edge: ModuleEdge): string {
  return `${edge.importer} → ${edge.target}${edge.typeOnly ? '（type-only）' : ''}`;
}

function edgeKey(edge: Pick<ModuleEdge, 'importer' | 'target'>): string {
  return `${edge.importer} → ${edge.target}`;
}

function dynamicImportKey(site: NonLiteralDynamicImport): string {
  return `${site.importer} → import(${site.expression}) @ sha256:${site.sourceSha256}`;
}

interface RuntimeCycle {
  domains: string[];
  edges: string[];
}

function runtimeCycles(edges: ModuleEdge[]): RuntimeCycle[] {
  const runtimeEdges = edges.filter((edge) => !edge.typeOnly);
  return stronglyConnectedComponents(runtimeEdges).map((domains) => {
    const domainSet = new Set(domains);
    return {
      domains,
      edges: [...new Set(runtimeEdges
        .filter((edge) => domainSet.has(edge.importerDomain) && domainSet.has(edge.targetDomain))
        .map(edgeKey))].sort(),
    };
  }).sort((left, right) => left.domains.join('/').localeCompare(right.domains.join('/')));
}

function isCompositionRootModule(path: string): boolean {
  return path === 'index.ts'
    || COMPOSITION_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function stronglyConnectedComponents(edges: ModuleEdge[]): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.importerDomain)) adjacency.set(edge.importerDomain, new Set());
    adjacency.get(edge.importerDomain)!.add(edge.targetDomain);
    if (!adjacency.has(edge.targetDomain)) adjacency.set(edge.targetDomain, new Set());
  }
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const connect = (domain: string): void => {
    indices.set(domain, nextIndex);
    lowLinks.set(domain, nextIndex);
    nextIndex += 1;
    stack.push(domain);
    onStack.add(domain);
    for (const target of adjacency.get(domain) ?? []) {
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(domain, Math.min(lowLinks.get(domain)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(domain, Math.min(lowLinks.get(domain)!, indices.get(target)!));
      }
    }
    if (lowLinks.get(domain) !== indices.get(domain)) return;
    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
    } while (current !== domain);
    components.push(component.sort());
  };

  for (const domain of adjacency.keys()) {
    if (!indices.has(domain)) connect(domain);
  }
  return components.filter((component) => component.length > 1);
}

describe('src 与 scripts 依赖图', () => {
  const { edges, nonLiteralDynamicImports } = collectDependencyGraph();

  it('按稳定子域而非粗粒度物理顶层分析聚合领域依赖', () => {
    expect(moduleDomain('knowledge/contracts.ts')).toBe('knowledge');
    for (const subdomain of ['adapters', 'application', 'entities', 'extraction', 'entity-library', 'entity-linking']) {
      expect(moduleDomain(`knowledge/${subdomain}/module.ts`)).toBe(`knowledge/${subdomain}`);
    }
    expect(moduleDomain('knowledge/artifacts/contracts.ts')).toBe('knowledge/artifacts');
    expect(moduleDomain('eval-core/contracts/comparability.ts')).toBe('eval-core/contracts');
    expect(moduleDomain('eval-core/compiler/index.ts')).toBe('eval-core/compiler');
    expect(moduleDomain('knowledge/artifacts/doctor/index.ts')).toBe('knowledge/artifacts/doctor');
    expect(moduleDomain('knowledge/artifacts/sources/content-hash.ts')).toBe('knowledge/artifacts/sources');
    expect(moduleDomain('eval-workflows/inputs/load-samples.ts')).toBe('eval-workflows/inputs');
    expect(moduleDomain('eval-workflows/instruments/prompts/judge-prompts.ts')).toBe('eval-workflows/instruments');
    expect(moduleDomain('eval-workflows/gold/human.ts')).toBe('eval-workflows/gold');
    expect(moduleDomain('eval-workflows/analysis/sample-size.ts')).toBe('eval-workflows/analysis');
    expect(moduleDomain('eval-workflows/artifact-store/node-run-store.ts')).toBe('eval-workflows/artifact-store');
    expect(moduleDomain('eval-workflows/assertions/layers.ts')).toBe('eval-workflows/assertions');
    expect(moduleDomain('eval-workflows/input-compilation/compile.ts')).toBe('eval-workflows/input-compilation');
    expect(moduleDomain('eval-workflows/orchestration/orchestration.ts')).toBe('eval-workflows/orchestration');
    expect(moduleDomain('eval-workflows/projections/cli.ts')).toBe('eval-workflows/projections');
    expect(moduleDomain('eval-workflows/resume-disposition/disposition.ts')).toBe('eval-workflows/resume-disposition');
    expect(moduleDomain('eval-workflows/measurement/analysis/composite-node.ts')).toBe('eval-workflows/measurement');
    expect(moduleDomain('eval-workflows/hosts/composition/assembly.ts')).toBe('eval-workflows/hosts');
    expect(moduleDomain('evidence/graph/schema.ts')).toBe('evidence/graph');
    expect(moduleDomain('evidence/storage/report-bundle.ts')).toBe('evidence/storage');
    expect(moduleDomain('executors/preflight/dependencies.ts')).toBe('executors/preflight');
  });

  it('知识子域只消费已登记方向，type-only 边不升级为运行时依赖', () => {
    const allowed = (edge: Pick<ModuleEdge, 'importerDomain' | 'targetDomain' | 'typeOnly'>): boolean => {
      const dependencies = KNOWLEDGE_SUBDOMAIN_DEPENDENCIES[edge.importerDomain];
      return dependencies?.runtime.includes(edge.targetDomain) === true
        || (edge.typeOnly && dependencies?.typeOnly?.includes(edge.targetDomain) === true);
    };
    expect(edges.filter((edge) => edge.importerDomain.startsWith('knowledge')
      && edge.targetDomain.startsWith('knowledge') && !allowed(edge)).map(describeEdge)).toEqual([]);
    const fixture = { importerDomain: 'knowledge/artifacts/authoring', targetDomain: 'knowledge', typeOnly: true };
    expect(allowed(fixture)).toBe(true);
    expect(allowed({ ...fixture, typeOnly: false })).toBe(false);
    expect(allowed({ importerDomain: 'knowledge', targetDomain: 'knowledge/application', typeOnly: true })).toBe(false);
  });

  it('根公开入口和维护脚本都进入检查范围', () => {
    expect(edges.some((edge) => edge.importer === 'index.ts')).toBe(true);
    expect(nonLiteralDynamicImports.map((item) => item.importer)).toContain('scripts/build/docs.ts');
    expect(nonLiteralDynamicImports.map((item) => item.importer)).toContain('scripts/bench/studio-baseline.ts');
    expect(SOURCE_ROOTS.flatMap((root) => sourceFiles(root, SOURCE_SCAN_OPTIONS))
      .some((path) => path.includes(`${sep}.next${sep}`))).toBe(false);
    const target = resolveLocalModule(resolve('scripts/build/fixture.cjs'), '../../src/cli/index.js');
    expect(target).toBe(resolve('src/cli/index.ts'));
    expect(isCompositionRootModule('scripts/build/fixture.cjs')).toBe(true);
    expect(isCompositionRootModule('index.ts')).toBe(true);
  });

  it('delivery composition root 只装配领域，不被领域反向依赖', () => {
    const violations = edges
      .filter((edge) => (
        isCompositionRootModule(edge.target)
        && !isCompositionRootModule(edge.importer)
      ))
      .map(describeEdge);
    expect(violations).toEqual([]);
  });

  it('eval-runtime 只依赖 Core 与 type-only Executor contracts', () => {
    const violations = edges.filter((edge) => edge.importerDomain === 'eval-runtime')
      .filter((edge) => (
        edge.targetDomain !== 'eval-core'
        && !edge.targetDomain.startsWith('eval-core/')
        && !(edge.targetDomain === 'executors'
          && edge.typeOnly
          && edge.target.startsWith('executors/contracts/'))
      ))
      .map(describeEdge);
    expect(violations).toEqual([]);
  });

  it('Workflow 只通过 Runtime 获取 Core 执行能力', () => {
    const violations = edges.filter((edge) => edge.importer.startsWith('eval-workflows/')
      && !edge.typeOnly
      && (edge.target.startsWith('eval-core/engine/') || edge.target.startsWith('eval-core/series/')))
      .map(describeEdge);
    expect(violations).toEqual([]);
  });

  it('eval-core contracts 只依赖契约与无依赖的基础不变量', () => {
    const violations = edges
      .filter((edge) => edge.importerDomain === 'eval-core/contracts')
      .filter((edge) => (
        edge.targetDomain.startsWith('eval-core/')
        && edge.targetDomain !== 'eval-core/contracts'
        && edge.targetDomain !== 'eval-core/primitives'
      ))
      .map(describeEdge);
    expect(violations).toEqual([]);
    expect(edges.filter((edge) => edge.importerDomain === 'eval-core/primitives')).toEqual([]);
  });

  it('运行时实现环只允许完整拓扑精确匹配的已审计登记', () => {
    const expected = REGISTERED_RUNTIME_CYCLES.map(({ domains, edges: registeredEdges }) => ({
      domains: [...domains],
      edges: [...registeredEdges].sort(),
    }));
    expect(runtimeCycles(edges)).toEqual(expected);
    expect(REGISTERED_RUNTIME_CYCLES.every((cycle) => (
      cycle.edges.some((key) => isContractBoundary(key.split(' → ')[1] ?? ''))
    ))).toBe(true);
  });

  it('已登记边参与新的三领域环时会改变完整拓扑', () => {
    const fixture: ModuleEdge[] = [
      {
        importer: 'diagnosis/index.ts',
        target: 'observability/contracts/value.ts',
        importerDomain: 'diagnosis',
        targetDomain: 'observability',
        typeOnly: false,
      },
      {
        importer: 'observability/index.ts',
        target: 'diagnosis/contracts/value.ts',
        importerDomain: 'observability',
        targetDomain: 'diagnosis',
        typeOnly: false,
      },
    ];
    const expandedFixture: ModuleEdge[] = [
      ...fixture,
      {
        importer: 'diagnosis/index.ts',
        target: 'evidence/index.ts',
        importerDomain: 'diagnosis',
        targetDomain: 'evidence',
        typeOnly: false,
      },
      {
        importer: 'evidence/index.ts',
        target: 'observability/index.ts',
        importerDomain: 'evidence',
        targetDomain: 'observability',
        typeOnly: false,
      },
    ];
    expect(runtimeCycles(fixture)).toHaveLength(1);
    expect(runtimeCycles(expandedFixture)[0]?.domains).toEqual([
      'diagnosis',
      'evidence',
      'observability',
    ]);
    expect(runtimeCycles(expandedFixture)).not.toEqual(runtimeCycles(fixture));
    const typeOnlyExpansion = expandedFixture.map((edge) =>
      edge.importerDomain === 'evidence' || edge.targetDomain === 'evidence'
        ? { ...edge, typeOnly: true } : edge);
    expect(runtimeCycles(typeOnlyExpansion)).toEqual(runtimeCycles(fixture));
  });

  it('非字面量 dynamic import／require 必须按调用点、表达式与完整来源约束完成审计登记', () => {
    const expected = REGISTERED_NON_LITERAL_DYNAMIC_IMPORTS.map((registered) =>
      dynamicImportKey(registered)).sort();
    expect(nonLiteralDynamicImports.map(dynamicImportKey).sort()).toEqual(expected);

    const registered = REGISTERED_NON_LITERAL_DYNAMIC_IMPORTS[0];
    expect(dynamicImportKey({ ...registered, sourceSha256: '0'.repeat(64) }))
      .not.toBe(dynamicImportKey(registered));
  });

  it('所有受支持的源码类型都解析动态加载和 CommonJS require', () => {
    const fixtures: ReadonlyArray<readonly [string, ts.ScriptKind]> = [
      ['fixture.ts', ts.ScriptKind.TS],
      ['fixture.tsx', ts.ScriptKind.TSX],
      ['fixture.mts', ts.ScriptKind.TS],
      ['fixture.cts', ts.ScriptKind.TS],
      ['fixture.js', ts.ScriptKind.JS],
      ['fixture.jsx', ts.ScriptKind.JSX],
      ['fixture.mjs', ts.ScriptKind.JS],
      ['fixture.cjs', ts.ScriptKind.JS],
    ];
    for (const [file, expectedScriptKind] of fixtures) {
      expect(MODULE_SOURCE_EXTENSIONS, file).toContain(extname(file));
      expect(scriptKind(file), file).toBe(expectedScriptKind);
      const source = ts.createSourceFile(
        file,
        "void import(process.env.SDK_TARGET, { with: { type: 'json' } }); require('../../src/cli/index.js');",
        ts.ScriptTarget.Latest,
        true,
        scriptKind(file),
      );
      expect(sourceModuleReferences(source).map(({ specifier }) =>
        specifier.getText(source)), file).toEqual(['process.env.SDK_TARGET', "'../../src/cli/index.js'"]);
    }
  });

  it('跨域双向依赖只允许已审计的 contracts／producer 边界', () => {
    const directionsByPair = new Map<string, Set<string>>();
    for (const edge of edges) {
      const pair = domainPair(edge.importerDomain, edge.targetDomain);
      if (!directionsByPair.has(pair)) directionsByPair.set(pair, new Set());
      directionsByPair.get(pair)!.add(`${edge.importerDomain}→${edge.targetDomain}`);
    }
    const violations: string[] = [];
    for (const [pair, directions] of directionsByPair) {
      if (directions.size < 2) continue;
      const validator = MUTUAL_BOUNDARY_VALIDATORS[pair];
      const pairEdges = edges.filter(
        (edge) => domainPair(edge.importerDomain, edge.targetDomain) === pair,
      );
      if (!validator) {
        violations.push(`${pair}：未登记的新双向依赖`);
        continue;
      }
      violations.push(...pairEdges
        .filter((edge) => !validator(edge))
        .map((edge) => `${pair}：${describeEdge(edge)}`));
    }
    expect(violations).toEqual([]);
  });

  it('双向依赖登记与真实依赖图同步', () => {
    const activePairs = new Set<string>();
    const directionPairs = new Map<string, Set<string>>();
    for (const edge of edges) {
      const pair = domainPair(edge.importerDomain, edge.targetDomain);
      if (!directionPairs.has(pair)) directionPairs.set(pair, new Set());
      directionPairs.get(pair)!.add(`${edge.importerDomain}→${edge.targetDomain}`);
    }
    for (const [pair, directions] of directionPairs) {
      if (directions.size === 2) activePairs.add(pair);
    }
    expect(Object.keys(MUTUAL_BOUNDARY_VALIDATORS).sort()).toEqual([...activePairs].sort());
  });
});
