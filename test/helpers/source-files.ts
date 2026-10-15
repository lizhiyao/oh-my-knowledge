import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import ts from 'typescript';

export const MODULE_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx'];
const SKIPPED_DIRECTORIES = new Set(['.next', 'node_modules', 'dist', 'coverage']);

/** Scan policy stays explicit; unreadable source trees fail closed. */
export function sourceFiles(directory: string, options: {
  extensions?: readonly string[];
  skippedDirectories?: ReadonlySet<string>;
} = {}): string[] {
  const extensions = options.extensions ?? TYPESCRIPT_EXTENSIONS;
  const skipped = options.skippedDirectories ?? SKIPPED_DIRECTORIES;
  const files: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    if (skipped.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path, options));
    else if (extensions.includes(extname(entry)) && !/\.d\.[cm]?tsx?$/.test(entry)) files.push(path);
  }
  return files;
}

export function sourceScriptKind(path: string): ts.ScriptKind {
  switch (extname(path)) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

export function parseSourceFile(path: string, content = readFileSync(path, 'utf8')): ts.SourceFile {
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, sourceScriptKind(path));
}

export interface SourceModuleReference {
  readonly referenceKind: 'import' | 'export' | 'import-equals' | 'import-type' | 'dynamic-import' | 'require';
  readonly specifier: ts.Expression;
  readonly typeOnly: boolean;
}

/** Keep non-literal loads for callers that require explicit registration. */
export function sourceModuleReferences(source: ts.SourceFile): SourceModuleReference[] {
  const references: SourceModuleReference[] = [];
  const add = (referenceKind: SourceModuleReference['referenceKind'], specifier: ts.Expression, typeOnly: boolean) => {
    references.push({ referenceKind, specifier, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly === true || (!clause?.name && bindings !== undefined
        && ts.isNamedImports(bindings) && bindings.elements.length > 0
        && bindings.elements.every(element => element.isTypeOnly));
      add('import', node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const typeOnly = node.isTypeOnly || (clause !== undefined && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly));
      add('export', node.moduleSpecifier, typeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression) {
      add('import-equals', node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) {
      add('import-type', node.argument.literal, true);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add('dynamic-import', node.arguments[0], false);
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add('require', node.arguments[0], false);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

/** Resolve emitted specifiers to source files, never to a directory. */
export function resolveSourceModule(importer: string, specifier: string, options: { extensions?: readonly string[] } = {}): string | null {
  if (!specifier.startsWith('.')) return null;
  const target = resolve(dirname(importer), specifier);
  const emitted = extname(specifier);
  const sourceExtensions: Record<string, readonly string[]> = {
    '.js': ['.ts', '.tsx', '.js'],
    '.jsx': ['.tsx', '.jsx'],
    '.mjs': ['.mts', '.mjs'],
    '.cjs': ['.cts', '.cjs'],
  };
  const extensions = options.extensions ?? MODULE_SOURCE_EXTENSIONS;
  const candidates = emitted in sourceExtensions
    ? sourceExtensions[emitted]!.map(extension => target.slice(0, -emitted.length) + extension)
    : [target, ...extensions.map(extension => target + extension),
        ...extensions.map(extension => join(target, `index${extension}`))];
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}
