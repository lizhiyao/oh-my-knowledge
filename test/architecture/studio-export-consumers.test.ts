/**
 * 架构边界守门：`src/studio/**` 的具名导出必须有仓库内按名导入的消费者。
 *
 * 起因是 Studio 冗余盘点：一轮审计在 web／http／view-models 里找出一批零引用导出（类型别名、
 * 只被已删渲染层用过的投影函数）。仓库里没有静态信号能看见它们：`@typescript-eslint/no-unused-vars`
 * 虽然因 `--max-warnings 0` 拦得住未使用的局部，但它把 `export` 本身算作使用；未使用的**导出**
 * 同样不在编译器眼里（`noUnusedLocals` 是 false，`yarn typecheck` 的 tsconfig 还排除了
 * `src/studio/web`）。于是这类代码只能靠人眼发现，
 * 清干净一轮又会重新长回来。这里把「声明在 Studio、除声明文件外没人按名字导入」变成 CI 失败。
 *
 * 口径边界（刻意不扩）：
 *  - 只判具名导出。`export default` 由文件路径本身寻址（Next 按目录装载页面），没有名字可查。
 *  - 判据是「按名导入图」，不是全文搜索：同名局部变量、Markdown 里的一句说明都不算消费者，
 *    否则门禁会在最容易数错的地方给出假绿。
 *  - `import * as ns`、`export * from`、`import('…')`、`require('…')`、`import type { X } from`
 *    形式的整模块引用一律保守视为被引用：静态枚举不出用到的成员，宁可不报也不误删。
 *  - 只被测试按名导入算「活着」。本门禁删的是没人要的声明；「只服务于测试的导出」要连带删测试，
 *    属于逐例判断的减法，不是一条路径规则。
 *  - `web/app/**` 的 Next 约定导出（`dynamic`／`metadata`／`generateMetadata` …）由框架按名字
 *    读取，仓库里没有 importer，因此按「名字 + 位置」豁免；位置之外的同名导出不享受豁免。
 *  - 消费者集合是 src／test／scripts／examples 下全部 TS/TSX。`scripts/*.mjs` 只按路径引用构建
 *    产物（`dist/studio/web`），不 import 符号，因此不构成额外来源。
 *  - 发布面与本门禁无关：package exports 里没有 Studio 子路径（口径见 `src/studio/README.md`），
 *    Studio 的具名导出全部是仓库内部符号。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STUDIO_DIR = join(REPO_ROOT, 'src', 'studio');
const NEXT_APP_DIR = join(STUDIO_DIR, 'web', 'app');
/** 可能按名导入 Studio 导出的目录。 */
const CONSUMER_DIRS = ['src', 'test', 'scripts', 'examples'];
const SKIPPED_DIRS = new Set(['.next', 'node_modules', 'dist', 'coverage']);
/** Next 按文件约定读取的导出名，与 route segment config / metadata API 同名。 */
const NEXT_CONVENTION_EXPORTS = new Set([
  'dynamic', 'revalidate', 'revalidatePath', 'revalidateTag', 'runtime', 'fetchCache',
  'maxDuration', 'preferredRegion', 'metadata', 'generateMetadata', 'viewport',
  'generateViewport', 'generateStaticParams', 'config',
]);
const SCRIPT_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts'] as const;

interface UnusedExport {
  readonly file: string;
  readonly name: string;
}

interface Audit {
  readonly declarationCount: number;
  readonly unresolvedImports: string[];
  readonly unused: UnusedExport[];
}

interface AuditOptions {
  /** Next 约定导出的所在目录。 */
  readonly appDir: string;
  /** 报告里的路径写法，默认相对仓库根。 */
  readonly display?: (path: string) => string;
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out; // CONSUMER_DIRS 里的目录可以缺席（examples 不一定有 TS）。
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listSourceFiles(path, out);
    else if (SCRIPT_EXTENSIONS.some((extension) => entry.endsWith(`.${extension}`)) && !entry.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function scriptKind(path: string): ts.ScriptKind {
  return path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(path));
}

function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 与 `next.config.mjs` 的 `extensionAlias` 同口径：`.js` 说明符解析回 TS 源。 */
function resolveLocalModule(importer: string, specifier: string): string | undefined {
  const target = resolve(dirname(importer), specifier);
  const candidates = specifier.endsWith('.js')
    ? [target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx'), target]
    : [
        target,
        ...SCRIPT_EXTENSIONS.map((extension) => `${target}.${extension}`),
        ...SCRIPT_EXTENSIONS.map((extension) => join(target, `index.${extension}`)),
      ];
  return candidates.find((candidate) => existsAsFile(candidate));
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  if (!modifiers) return false;
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    && !modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

/** 一条导出声明对外承诺的名字；解构等非标识符名没有可查的消费者，跳过。 */
function declarationNames(node: ts.Node): string[] {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map((declaration) => declaration.name)
      .filter(ts.isIdentifier)
      .map((name) => name.text);
  }
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
    const name = node.name;
    return name && ts.isIdentifier(name) ? [name.text] : [];
  }
  return [];
}

/** 本文件对外承诺的具名导出（含只转发本地声明的 `export { x }`）。 */
function declaredExportNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) names.push(element.name.text);
      }
    } else if (hasExportModifier(node)) {
      names.push(...declarationNames(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

interface ReferenceGraph {
  /** module → 被按名引用的导出 → 引用方文件。 */
  readonly byName: Map<string, Map<string, Set<string>>>;
  /** 被整体引用的模块（namespace import、`export *`、动态 import）。 */
  readonly wholesale: Set<string>;
  readonly unresolved: string[];
}

function collectReferences(importer: string, source: ts.SourceFile, graph: ReferenceGraph): void {
  const name = (target: string, exported: string): void => {
    const perModule = graph.byName.get(target) ?? new Map<string, Set<string>>();
    graph.byName.set(target, perModule);
    const importers = perModule.get(exported) ?? new Set<string>();
    perModule.set(exported, importers);
    importers.add(importer);
  };
  const wholeModule = (target: string): void => { graph.wholesale.add(target); };
  const localTarget = (specifier: string): string | undefined => {
    if (!specifier.startsWith('.')) return undefined; // 第三方包不可能是 Studio 导出。
    const target = resolveLocalModule(importer, specifier);
    if (!target) graph.unresolved.push(`${importer} → ${specifier}`);
    return target;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = localTarget(node.moduleSpecifier.text);
      if (target) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) wholeModule(target);
        else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) name(target, (element.propertyName ?? element.name).text);
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = localTarget(node.moduleSpecifier.text);
      if (target) {
        if (!node.exportClause) wholeModule(target); // export * from './m'
        else if (ts.isNamespaceExport(node.exportClause)) wholeModule(target); // export * as ns from './m'
        else for (const element of node.exportClause.elements) name(target, (element.propertyName ?? element.name).text);
      }
    } else if (ts.isImportTypeNode(node) && ts.isStringLiteralLike(node.argument)) {
      const target = localTarget(node.argument.text);
      if (target) wholeModule(target);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const target = localTarget(node.arguments[0].text);
      if (target) wholeModule(target); // 动态取模块：枚举不出用到的成员，整模块算被引用。
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function audit(declarationFiles: string[], consumerFiles: string[], options: AuditOptions): Audit {
  const display = options.display ?? displayRepoPath;
  const parsed = new Map<string, ts.SourceFile>();
  const parse = (path: string): ts.SourceFile => {
    const cached = parsed.get(path) ?? parseSource(path);
    parsed.set(path, cached);
    return cached;
  };
  const graph: ReferenceGraph = { byName: new Map(), wholesale: new Set(), unresolved: [] };
  for (const file of consumerFiles) collectReferences(file, parse(file), graph);

  const unused: UnusedExport[] = [];
  let declarationCount = 0;
  for (const file of declarationFiles) {
    const underAppDir = file.startsWith(`${options.appDir}${sep}`);
    const wholeModule = graph.wholesale.has(file);
    for (const exported of declaredExportNames(parse(file))) {
      declarationCount += 1;
      if (underAppDir && NEXT_CONVENTION_EXPORTS.has(exported)) continue;
      if (wholeModule) continue;
      const importers = graph.byName.get(file)?.get(exported);
      if (importers && [...importers].some((importer) => importer !== file)) continue;
      unused.push({ file: display(file), name: exported });
    }
  }
  return {
    declarationCount,
    unresolvedImports: graph.unresolved.map((entry) => entry.replace(`${REPO_ROOT}/`, '')),
    unused: unused.sort((a, b) => `${a.file}#${a.name}` < `${b.file}#${b.name}` ? -1 : 1),
  };
}

function displayRepoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

function studioSources(): { declarations: string[]; consumers: string[] } {
  const declarations = listSourceFiles(STUDIO_DIR);
  const consumers = CONSUMER_DIRS.flatMap((dir) => listSourceFiles(join(REPO_ROOT, dir)));
  return { declarations, consumers };
}

const FIXTURE: Record<string, string> = {
  // 判死：值、类型、以及「只被同文件自己用过的导出」都不算有消费者。
  'lib/dead.ts': `export function unusedHelper(): string {
  return 'nobody imports me';
}

export type UnusedShape = { readonly gone: boolean };

function localOnly(): string {
  return 'not an export at all';
}

export function selfReferenced(): string {
  return localOnly();
}
`,
  // 判活：被 lib/consumer.ts 按名导入，`as` 别名与 type-only 两种写法都算消费者。
  'lib/live.ts': `export const LIVE_CONST = 1;

export type LiveType = { readonly ok: boolean };

export function liveFn(): number {
  return LIVE_CONST;
}
`,
  'lib/consumer.ts': `import { LIVE_CONST as CONST, liveFn } from './live.js';
import { consumeWhole } from './whole-users.js';
import type { LiveType } from './live.js';

export function use(value: LiveType): number {
  return liveFn() + CONST + consumeWhole() + (value.ok ? 1 : 0);
}
`,
  // 整体引用：namespace、`export *`、动态 import 三种边都不许判死。
  'lib/whole-a.ts': `export const A_ONE = 1;
export const A_TWO = 2;
`,
  'lib/whole-b.ts': `export const B_ONE = 1;
`,
  'lib/whole-c.ts': `export const C_ONE = 1;
`,
  'lib/whole-users.ts': `import * as wholeA from './whole-a.js';
export * from './whole-b.js';

async function readDynamic(): Promise<unknown> {
  return import('./whole-c.js');
}

export function consumeWhole(): number {
  void readDynamic();
  return wholeA.A_ONE + wholeA.A_TWO;
}
`,
  // Next 约定豁免只覆盖 app 目录之下、且只覆盖约定名本身：
  // 同一个名字放在 `app` 外照样判死，`app` 内的非约定名也照样判死。
  'app/page.tsx': `export const dynamic = 'force-dynamic';
export function unusedInAppDir(): number {
  return 1;
}
export default function Page(): null {
  return null;
}
`,
  'lib/not-an-app-page.ts': `export const dynamic = 'force-dynamic';
`,
};

let fixtureRoot = '';

function fixturePath(...segments: string[]): string {
  return join(fixtureRoot, ...segments);
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'omk-studio-export-consumers-'));
  for (const [path, content] of Object.entries(FIXTURE)) {
    const target = fixturePath(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
});

// 用例失败或中断也要收掉临时根，不给下一轮留半棵目录树。
afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Studio 具名导出的消费者守门', () => {
  it('Studio 里不存在零消费者的具名导出', () => {
    const { declarations, consumers } = studioSources();
    // 扫描退化会让门禁变成假绿：两侧都必须真实在场。
    expect(declarations.length).toBeGreaterThan(0);
    expect(consumers.length).toBeGreaterThan(declarations.length);

    const report = audit(declarations, consumers, { appDir: NEXT_APP_DIR });
    expect(report.declarationCount).toBeGreaterThan(0);
    expect(
      report.unresolvedImports,
      `存在解析不到的相对 import，按名引用图不完整：${report.unresolvedImports.join('、')}`,
    ).toEqual([]);

    if (report.unused.length > 0) {
      throw new Error([
        `这些具名导出除声明文件外没有任何按名导入（共 ${report.unused.length} 个）：`,
        ...report.unused.map((entry) => `  ${entry.file} ⇒ ${entry.name}`),
        '',
        '处理：确认没有反射／动态用法后删除声明与随之失效的测试；确有用途时补一个真实调用方，',
        '不要加豁免名单。口径见 src/studio/AGENTS.md 与本文件头部注释。',
      ].join('\n'));
    }
  });

  it('控制组：按名导入判活，整体引用与 Next 约定豁免，其余判死', () => {
    const report = audit(
      [
        'dead.ts', 'live.ts', 'consumer.ts', 'whole-a.ts', 'whole-b.ts', 'whole-c.ts',
        'whole-users.ts', 'not-an-app-page.ts',
      ].map((entry) => fixturePath('lib', entry)).concat(fixturePath('app', 'page.tsx')),
      listSourceFiles(fixtureRoot),
      { appDir: fixturePath('app'), display: (path) => path.slice(`${fixtureRoot}/`.length) },
    );

    // 豁免的正向半：`dynamic` 不在结果里，而同一个文件的 `unusedInAppDir` 在——
    // 少了后一条，「整个 app 目录跳过」这种实现也能通过本用例。
    expect(report.unused.map((entry) => `${entry.file} ⇒ ${entry.name}`)).toEqual([
      'app/page.tsx ⇒ unusedInAppDir',
      'lib/consumer.ts ⇒ use',
      'lib/dead.ts ⇒ UnusedShape',
      'lib/dead.ts ⇒ selfReferenced',
      'lib/dead.ts ⇒ unusedHelper',
      'lib/not-an-app-page.ts ⇒ dynamic',
    ]);
  });
});
