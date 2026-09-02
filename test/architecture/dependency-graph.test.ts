import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = resolve('src');
const COMPOSITION_ROOT_PREFIXES = [
  'cli/',
  'dsh-plugin/',
  'eval-workflows/production-host/',
  'studio/',
] as const;
const DIAGNOSIS_OBSERVABILITY_PRODUCER_TARGETS = new Set([
  'observability/experience.ts',
  'observability/inbox/index.ts',
  'observability/inbox/problem-patterns.ts',
  'observability/skill-health/advisories.ts',
  'observability/skill-health/skill-chain.ts',
]);

interface ModuleEdge {
  importer: string;
  target: string;
  importerDomain: string;
  targetDomain: string;
  typeOnly: boolean;
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) listSourceFiles(path, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

function sourceRelative(path: string): string {
  return relative(SRC_DIR, path).split(sep).join('/');
}

function resolveLocalModule(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const unresolved = normalize(resolve(dirname(importer), specifier));
  const candidates = specifier.endsWith('.js')
    ? [unresolved.replace(/\.js$/, '.ts'), unresolved.replace(/\.js$/, '.tsx')]
    : [unresolved, `${unresolved}.ts`, `${unresolved}.tsx`, join(unresolved, 'index.ts')];
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

function collectModuleEdges(): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  const add = (importer: string, specifier: string, typeOnly: boolean): void => {
    const target = resolveLocalModule(importer, specifier);
    if (!target || !target.startsWith(`${SRC_DIR}${sep}`)) return;
    const importerRelative = sourceRelative(importer);
    const targetRelative = sourceRelative(target);
    const importerDomain = importerRelative.split('/')[0];
    const targetDomain = targetRelative.split('/')[0];
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
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
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
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1
        && ts.isStringLiteralLike(node.arguments[0])
      ) {
        add(file, node.arguments[0].text, false);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return edges;
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
  [domainPair('grading', 'inputs')]: (edge) =>
    edge.importerDomain === 'grading'
      ? edge.targetDomain === 'inputs'
      : edge.typeOnly && isContractBoundary(edge.target),
  [domainPair('inputs', 'preflight')]: (edge) =>
    edge.typeOnly && isContractBoundary(edge.target),
  [domainPair('doctor', 'measurement-artifacts')]: (edge) => {
    if (edge.importerDomain === 'doctor') {
      return edge.importer === 'doctor/index.ts'
        && edge.target === 'measurement-artifacts/file-names.ts';
    }
    return edge.importer === 'measurement-artifacts/discovery-index.ts'
      && edge.typeOnly
      && edge.target === 'doctor/contracts.ts';
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
  const edges = collectModuleEdges();

  it('delivery composition root 只装配领域，不被领域反向依赖', () => {
    const violations = edges
      .filter((edge) => (
        isCompositionRootModule(edge.target)
        && !isCompositionRootModule(edge.importer)
      ))
      .map(describeEdge);
    expect(violations).toEqual([]);
  });

  it('运行时实现依赖图保持无环', () => {
    const runtimeImplementationEdges = edges.filter(
      (edge) => !edge.typeOnly && !isContractBoundary(edge.target),
    );
    const cycles = stronglyConnectedComponents(runtimeImplementationEdges);
    expect(cycles, `发现运行时实现依赖环：${cycles.map((cycle) => cycle.join(' → ')).join('；')}`).toEqual([]);
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
