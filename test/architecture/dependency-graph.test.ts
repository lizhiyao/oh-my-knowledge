import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = resolve('src');
const COMPOSITION_ROOT_PREFIXES = [
  'cli/',
  'dsh-plugin/',
  'eval-hosts/',
  'mcp/',
  'studio/',
] as const;
const DIAGNOSIS_OBSERVABILITY_PRODUCER_TARGETS = new Set([
  'observability/experience.ts',
  'observability/inbox/index.ts',
  'observability/inbox/problem-patterns.ts',
  'observability/skill-health/advisories.ts',
  'observability/skill-health/skill-chain.ts',
]);
const EVAL_WORKFLOW_SUBDOMAINS = new Set([
  'analysis',
  'artifact-store',
  'assertions',
  'gold',
  'input-compilation',
  'inputs',
  'instruments',
  'measurement',
  'orchestration',
  'projections',
  'resume-admission',
]);

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

const REGISTERED_RUNTIME_CYCLES = [
  {
    domains: ['diagnosis', 'observability'],
    edges: [
      'diagnosis/observe-producer.ts → observability/skill-health/advisories.ts',
      'diagnosis/observe-producer.ts → observability/skill-health/skill-chain.ts',
      'observability/inbox/index.ts → diagnosis/contracts/parser.ts',
    ],
    rationale: 'Diagnosis produces Observability projections while Observability parses the stable Diagnosis wire contract.',
  },
] as const;

const REGISTERED_NON_LITERAL_DYNAMIC_IMPORTS = [
  {
    importer: 'executors/anthropic/claude/sdk.ts',
    expression: 'CLAUDE_AGENT_SDK_PACKAGE',
    sourceSha256: 'c4d92bdfa7385281fba50233c15f365ba3a6020eab5a4609b829577c70214b4a',
    rationale: 'Loads the fixed optional Claude SDK package; the source hash seals its binding.',
  },
  {
    importer: 'executors/openai/codex/sdk.ts',
    expression: 'CODEX_SDK_PACKAGE',
    sourceSha256: 'd38e53693dda6414841f2d62d6f393c9e40d98608a420a35aff23839533f9921',
    rationale: 'Loads the fixed optional Codex SDK package; the source hash seals its binding.',
  },
  {
    importer: 'eval-hosts/adapters/claude/sdk-runtime.ts',
    expression: 'sdkModuleUrl.href',
    sourceSha256: 'ecc6f7786371066da5853a70b1fe1fe6fd1af088f8a9e1207e626670e6830c21',
    rationale: 'Loads the resolved optional Claude SDK entrypoint with a per-runtime file URL.',
  },
  {
    importer: 'eval-hosts/adapters/codex/sdk-runtime.ts',
    expression: 'sdkModuleUrl.href',
    sourceSha256: '779eb62d9a6d67712ce454466e47802901637b00b6c2e99056dcd8b06fcedac1',
    rationale: 'Loads the resolved optional Codex SDK entrypoint with a per-runtime file URL.',
  },
] as const;

const SOURCE_FILE_PATTERN = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const DECLARATION_FILE_PATTERN = /\.d\.(?:[cm]?ts|tsx)$/;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) listSourceFiles(path, out);
    else if (SOURCE_FILE_PATTERN.test(entry) && !DECLARATION_FILE_PATTERN.test(entry)) out.push(path);
  }
  return out;
}

function sourceRelative(path: string): string {
  return relative(SRC_DIR, path).split(sep).join('/');
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(?:[cm]?js)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function moduleDomain(path: string): string {
  const [topLevel, subdomain] = path.split('/');
  if (topLevel === 'eval-core' && subdomain !== undefined && subdomain.includes('.') === false) {
    return `${topLevel}/${subdomain}`;
  }
  if (
    topLevel === 'knowledge-artifacts'
    && ['authoring', 'doctor', 'governance', 'skills', 'sources'].includes(subdomain)
  ) {
    return `${topLevel}/${subdomain}`;
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

function resolveLocalModule(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const unresolved = normalize(resolve(dirname(importer), specifier));
  const candidates = specifier.endsWith('.mjs')
    ? [unresolved.replace(/\.mjs$/, '.mts'), unresolved]
    : specifier.endsWith('.cjs')
      ? [unresolved.replace(/\.cjs$/, '.cts'), unresolved]
      : specifier.endsWith('.js')
        ? [
            unresolved.replace(/\.js$/, '.ts'),
            unresolved.replace(/\.js$/, '.tsx'),
            unresolved.replace(/\.js$/, '.mts'),
            unresolved,
          ]
        : [
            unresolved,
            ...['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs'].map(
              (extension) => `${unresolved}.${extension}`,
            ),
            ...['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs'].map(
              (extension) => join(unresolved, `index.${extension}`),
            ),
          ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function importIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause?.isTypeOnly) return true;
  if (!clause || clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) {
    return false;
  }
  return clause.namedBindings.elements.length > 0
    && clause.namedBindings.elements.every((element) => element.isTypeOnly);
}

function exportIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  return node.exportClause !== undefined
    && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0
    && node.exportClause.elements.every((element) => element.isTypeOnly);
}

function dynamicImportSpecifiers(source: ts.SourceFile): ts.Expression[] {
  const specifiers: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length >= 1
    ) specifiers.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function collectDependencyGraph(): DependencyGraph {
  const edges: ModuleEdge[] = [];
  const nonLiteralDynamicImports: NonLiteralDynamicImport[] = [];
  const add = (importer: string, specifier: string, typeOnly: boolean): void => {
    const target = resolveLocalModule(importer, specifier);
    if (!target || !target.startsWith(`${SRC_DIR}${sep}`)) return;
    const importerRelative = sourceRelative(importer);
    const targetRelative = sourceRelative(target);
    const importerDomain = moduleDomain(importerRelative);
    const targetDomain = moduleDomain(targetRelative);
    if (importerDomain === targetDomain || !importerRelative.includes('/')) return;
    edges.push({
      importer: importerRelative,
      target: targetRelative,
      importerDomain,
      targetDomain,
      typeOnly,
    });
  };

  for (const file of listSourceFiles(SRC_DIR)) {
    const sourceText = readFileSync(file, 'utf8');
    const canonicalSource = sourceText.replaceAll('\r\n', '\n');
    const sourceSha256 = createHash('sha256').update(canonicalSource).digest('hex');
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        add(file, statement.moduleSpecifier.text, importIsTypeOnly(statement));
      } else if (
        ts.isExportDeclaration(statement)
        && statement.moduleSpecifier
        && ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        add(file, statement.moduleSpecifier.text, exportIsTypeOnly(statement));
      }
    }
    for (const specifier of dynamicImportSpecifiers(source)) {
      if (ts.isStringLiteralLike(specifier)) {
        add(file, specifier.text, false);
      } else {
        nonLiteralDynamicImports.push({
          importer: sourceRelative(file),
          expression: specifier.getText(source),
          sourceSha256,
        });
      }
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
      edges: runtimeEdges
        .filter((edge) => domainSet.has(edge.importerDomain) && domainSet.has(edge.targetDomain))
        .map(edgeKey)
        .sort(),
    };
  }).sort((left, right) => left.domains.join('/').localeCompare(right.domains.join('/')));
}

function isCompositionRootModule(path: string): boolean {
  return COMPOSITION_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix));
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

const MUTUAL_BOUNDARY_VALIDATORS: Record<string, (edge: ModuleEdge) => boolean> = {
  [domainPair('evidence/storage', 'knowledge-artifacts/doctor')]: (edge) => {
    if (edge.importerDomain === 'knowledge-artifacts/doctor') {
      return edge.targetDomain === 'evidence/storage';
    }
    return edge.importer === 'evidence/storage/discovery-index.ts'
      && edge.typeOnly
      && edge.target === 'knowledge-artifacts/doctor/contracts.ts';
  },
  [domainPair('diagnosis', 'observability')]: (edge) => {
    if (edge.importerDomain === 'observability') {
      return edge.target.startsWith('diagnosis/contracts');
    }
    return edge.importer === 'diagnosis/observe-producer.ts'
      && DIAGNOSIS_OBSERVABILITY_PRODUCER_TARGETS.has(edge.target);
  },
};

describe('src 依赖图', () => {
  const { edges, nonLiteralDynamicImports } = collectDependencyGraph();

  it('按稳定子域而非粗粒度物理顶层分析聚合领域依赖', () => {
    expect(moduleDomain('knowledge-artifacts/contracts.ts')).toBe('knowledge-artifacts');
    expect(moduleDomain('eval-core/contracts/comparability.ts')).toBe('eval-core/contracts');
    expect(moduleDomain('eval-core/compiler/index.ts')).toBe('eval-core/compiler');
    expect(moduleDomain('knowledge-artifacts/doctor/index.ts')).toBe('knowledge-artifacts/doctor');
    expect(moduleDomain('knowledge-artifacts/governance/store.ts')).toBe('knowledge-artifacts/governance');
    expect(moduleDomain('knowledge-artifacts/sources/content-hash.ts')).toBe('knowledge-artifacts/sources');
    expect(moduleDomain('eval-workflows/inputs/load-samples.ts')).toBe('eval-workflows/inputs');
    expect(moduleDomain('eval-workflows/instruments/prompts/judge-prompts.ts')).toBe('eval-workflows/instruments');
    expect(moduleDomain('eval-workflows/gold/human.ts')).toBe('eval-workflows/gold');
    expect(moduleDomain('eval-workflows/analysis/bootstrap.ts')).toBe('eval-workflows/analysis');
    expect(moduleDomain('eval-workflows/artifact-store/node-run-store.ts')).toBe('eval-workflows/artifact-store');
    expect(moduleDomain('eval-workflows/assertions/layers.ts')).toBe('eval-workflows/assertions');
    expect(moduleDomain('eval-workflows/input-compilation/compile.ts')).toBe('eval-workflows/input-compilation');
    expect(moduleDomain('eval-workflows/orchestration/orchestration.ts')).toBe('eval-workflows/orchestration');
    expect(moduleDomain('eval-workflows/projections/cli.ts')).toBe('eval-workflows/projections');
    expect(moduleDomain('eval-workflows/resume-admission/admit.ts')).toBe('eval-workflows/resume-admission');
    expect(moduleDomain('eval-workflows/measurement/analysis/composite-node.ts')).toBe('eval-workflows/measurement');
    expect(moduleDomain('eval-hosts/composition/assembly.ts')).toBe('eval-hosts');
    expect(moduleDomain('evidence/graph/schema.ts')).toBe('evidence/graph');
    expect(moduleDomain('evidence/storage/report-bundle.ts')).toBe('evidence/storage');
    expect(moduleDomain('executors/preflight/dependencies.ts')).toBe('executors/preflight');
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

  it('eval-core contracts 不反向依赖 Core 实现子域', () => {
    const violations = edges
      .filter((edge) => edge.importerDomain === 'eval-core/contracts')
      .filter((edge) => (
        edge.targetDomain.startsWith('eval-core/')
        && edge.targetDomain !== 'eval-core/contracts'
      ))
      .map(describeEdge);
    expect(violations).toEqual([]);
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
  });

  it('非字面量 dynamic import 必须按调用点、表达式与完整来源约束完成审计登记', () => {
    const expected = REGISTERED_NON_LITERAL_DYNAMIC_IMPORTS.map((registered) =>
      dynamicImportKey(registered)).sort();
    expect(nonLiteralDynamicImports.map(dynamicImportKey).sort()).toEqual(expected);
    expect(listSourceFiles(SRC_DIR).map(sourceRelative)).toContain(
      'executors/mock-runtime/mock-hook.cjs',
    );

    const registered = REGISTERED_NON_LITERAL_DYNAMIC_IMPORTS[0];
    expect(dynamicImportKey({ ...registered, sourceSha256: '0'.repeat(64) }))
      .not.toBe(dynamicImportKey(registered));
  });

  it('所有受支持的 TypeScript 与可执行 JavaScript 源类型都解析 dynamic import', () => {
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
      expect(SOURCE_FILE_PATTERN.test(file), file).toBe(true);
      expect(scriptKind(file), file).toBe(expectedScriptKind);
      const source = ts.createSourceFile(
        file,
        "void import(process.env.SDK_TARGET, { with: { type: 'json' } });",
        ts.ScriptTarget.Latest,
        true,
        scriptKind(file),
      );
      expect(dynamicImportSpecifiers(source).map((specifier) =>
        specifier.getText(source)), file).toEqual(['process.env.SDK_TARGET']);
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
