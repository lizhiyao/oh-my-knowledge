import { readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  WIRE_SCHEMA_CATALOG,
  wireSchemaCatalogVersion,
} from '../../src/eval-core/contracts/index.js';

const CORE_ROOT = resolve('src/eval-core');
const CORE_PUBLIC_ENTRY = resolve(CORE_ROOT, 'index.ts');
const SCHEMA_ROOT = resolve('schemas/eval-core');
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const PROHIBITED_PUBLIC_TERMS = new Set([
  'runner',
  'suite',
  'cases',
  'candidate',
  'scoring',
]);
// The terminology spec names rejected aliases deliberately; guard executable examples here and
// assert its required context boundary separately below.
const PUBLIC_DOCS = [
  'docs/specs/eval-core-vnext.md',
  'docs/zh/specs/eval-core-vnext.md',
  'docs/reference/eval-runtime-api.md',
  'docs/zh/reference/eval-runtime-api.md',
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && TYPESCRIPT_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

function identifierTerms(name: string): string[] {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function prohibitedNames(names: readonly string[]): string[] {
  return names.filter((name) => (
    identifierTerms(name).some((term) => PROHIBITED_PUBLIC_TERMS.has(term))
  ));
}

function declaredName(node: ts.NamedDeclaration): string | undefined {
  const { name } = node;
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
    ? name.text
    : undefined;
}

function declarationShapeNames(declaration: ts.Declaration): string[] {
  const names: string[] = [];
  if ('name' in declaration) {
    const name = declaredName(declaration as ts.NamedDeclaration);
    if (name !== undefined) names.push(name);
  }
  const collectParameters = (parameters: ts.NodeArray<ts.ParameterDeclaration>): void => {
    for (const parameter of parameters) {
      const name = declaredName(parameter);
      if (name !== undefined) names.push(name);
    }
  };
  const collectMembers = (members: ts.NodeArray<ts.TypeElement | ts.ClassElement>): void => {
    for (const member of members) {
      if ('name' in member) {
        const name = declaredName(member as ts.NamedDeclaration);
        if (name !== undefined) names.push(name);
      }
      if ('parameters' in member && member.parameters !== undefined) {
        collectParameters(member.parameters as ts.NodeArray<ts.ParameterDeclaration>);
      }
    }
  };

  if (ts.isFunctionDeclaration(declaration)) collectParameters(declaration.parameters);
  if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
    collectMembers(declaration.members);
  }
  if (ts.isTypeAliasDeclaration(declaration) && ts.isTypeLiteralNode(declaration.type)) {
    collectMembers(declaration.type.members);
  }
  return names;
}

function corePublicApiNames(): string[] {
  const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile);
  if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve('.'));
  const program = ts.createProgram([CORE_PUBLIC_ENTRY], parsed.options);
  const source = program.getSourceFile(CORE_PUBLIC_ENTRY);
  if (source === undefined) throw new Error('Evaluation Core public entry is missing.');
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error('Evaluation Core public entry has no module symbol.');

  return checker.getExportsOfModule(moduleSymbol).flatMap((exported) => {
    const target = (exported.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(exported)
      : exported;
    return [exported.name, ...(target.declarations ?? []).flatMap(declarationShapeNames)];
  });
}

function schemaPropertyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaPropertyNames);
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  const names = properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
  return [...names, ...Object.values(record).flatMap(schemaPropertyNames)];
}

function activeSchemaPropertyNames(): string[] {
  return WIRE_SCHEMA_CATALOG.flatMap((entry) => {
    const path = resolve(
      SCHEMA_ROOT,
      wireSchemaCatalogVersion(entry),
      entry.fileName,
    );
    return schemaPropertyNames(JSON.parse(readFileSync(path, 'utf8')));
  });
}

function stableErrorCodes(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'core-contract.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const codes: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && /^[A-Z][A-Z0-9_]+$/.test(node.text)) {
      codes.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return codes;
}

function markdownCodeIdentifiers(source: string): string[] {
  const fragments = [
    ...source.matchAll(/```[^\n]*\n([\s\S]*?)```/g),
    ...source.matchAll(/`([^`\n]+)`/g),
  ].map((match) => match[1]);
  return fragments.flatMap((fragment) => fragment.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
}

describe('Evaluation Core terminology guard', () => {
  it('keeps canonical public declarations free of competing evaluation terms', () => {
    expect(prohibitedNames(corePublicApiNames())).toEqual([]);
    expect(prohibitedNames([
      'TargetDefinition',
      'RuntimeIdentity',
      'ComparabilityRunIdentity',
      'EvaluationCandidate',
      'RunSuite',
    ])).toEqual(['EvaluationCandidate', 'RunSuite']);
  });

  it('keeps active wire properties free of competing evaluation terms', () => {
    expect(prohibitedNames(activeSchemaPropertyNames())).toEqual([]);
    expect(prohibitedNames(schemaPropertyNames({
      properties: {
        runIdentityDigest: { type: 'string' },
        candidateDigest: { type: 'string' },
      },
    }))).toEqual(['candidateDigest']);
  });

  it('keeps stable Core error codes free of competing evaluation terms', () => {
    const violations = sourceFiles(CORE_ROOT).flatMap((file) => (
      prohibitedNames(stableErrorCodes(readFileSync(file, 'utf8')))
        .map((code) => `${relative(CORE_ROOT, file)}: ${code}`)
    ));
    expect(violations).toEqual([]);
    expect(prohibitedNames(stableErrorCodes(`
      type ErrorCode = 'COMPARABILITY_RUN_IDENTITY_DIGEST_MISMATCH'
        | 'COMPARABILITY_CANDIDATE_DIGEST_MISMATCH';
    `))).toEqual(['COMPARABILITY_CANDIDATE_DIGEST_MISMATCH']);
  });

  it('keeps public documentation examples on canonical Core terms', () => {
    const violations = PUBLIC_DOCS.flatMap((file) => (
      prohibitedNames(markdownCodeIdentifiers(readFileSync(resolve(file), 'utf8')))
        .map((identifier) => `${file}: ${identifier}`)
    ));
    expect(violations).toEqual([]);
    expect(prohibitedNames(markdownCodeIdentifiers(`
      Use \`ComparabilityRunIdentity\`, not \`ComparabilityCandidateIdentity\`.
    `))).toEqual(['ComparabilityCandidateIdentity']);
  });

  it('keeps runtime and sample context boundaries explicit in both languages', () => {
    for (const file of [
      'docs/specs/terminology-spec.md',
      'docs/zh/specs/terminology-spec.md',
      'docs/reference/eval-runtime-api.md',
      'docs/zh/reference/eval-runtime-api.md',
    ]) {
      const source = readFileSync(resolve(file), 'utf8');
      expect(source).toContain('runtime context');
      expect(source).toContain('executionContext');
      expect(source).toContain('evaluationContext');
    }
  });
});
