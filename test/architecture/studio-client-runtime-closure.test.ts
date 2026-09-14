/**
 * 架构边界守门：'use client' 模块的运行时依赖闭包不得触达 Node 内建模块。
 *
 * 起因是 `application/health-format.ts` 里的一句注释：它只服务服务端，React 页面只能
 * 按类型 import，「值导入会经 analyzer.ts 把 node:fs 拖进客户端 bundle」。口径成立却
 * 没人钉。把 `components/observe/health.tsx` 改成值导入做反向验证：健康页的 React 渲染
 * 用例、`yarn lint`、`yarn typecheck` 全绿（`src/studio/web` 甚至不在根 tsconfig 的
 * 类型检查集合里），既有检查里只有 `next build` 会报，它在打浏览器 chunk 时报
 * `UnhandledSchemeError: Reading from "node:fs" is not handled by plugins`，且 webpack
 * 的 import trace 与本门禁给出的链路一致 —— 泄漏要等一整轮构建才看得见。
 *
 * 上游唯一的机制是 `server-only` 标记包（`web/catalog.tsx` 已在用；Next 在 webpack 里
 * 别名注入，不需要装依赖），但它按模块手工声明、只覆盖被声明的那一个，同样在构建期才
 * 报错；现成的 RSC 边界 ESLint 插件要么没这条规则，要么已停更。所以按「什么真的会挂」
 * 自守：沿运行时边算闭包，出现 Node 内建说明符即红，零豁免。
 *
 * 口径边界（刻意不扩）：
 *  - `import type`／`export type`／全 type 具名导入会被 TS 擦除，不进浏览器 chunk，
 *    因此不算闭包成员；副作用 import、动态 import 与 require 算运行时边。
 *  - 判据是「闭包里有没有 Node 宿主能力」，不是「有没有跨出 web 目录」：
 *    `components/knowledge/knowledge.tsx` 与 `components/observe/swimlane.tsx` 按值调用
 *    application 的纯投影函数是既有口径，门禁不去管它管不到的机制。
 *  - 第三方包（react／antd／next/*）不展开，由包自身的浏览器兼容性负责。
 *  - 只判 import 说明符：不经导入直接使用 `process`、`Buffer` 这类宿主全局不会让构建
 *    失败（Next 会内联或留空），不在本门禁的机制里；`node:process` 这类说明符照样判红。
 *  - 非字面量 dynamic import 与解析不到的相对运行时边都判红：闭包证明不了就是没证明，
 *    否则解析器一退化，上面的口径会悄悄变成永真断言。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB_DIR = join(REPO_ROOT, 'src', 'studio', 'web');
const SKIPPED_DIRS = new Set(['.next', 'node_modules']);
const SCRIPT_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs'] as const;
/** 静态资源由 bundler 自己处理，不是 TS 模块，不参与闭包。 */
const ASSET_PATTERN = /\.(?:css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|md)$/;
const NODE_BUILTIN_NAMES = new Set(builtinModules);

interface RuntimeEdge {
  readonly specifier: string;
  /** 说明符不是字面量时无法展开，记录原文。 */
  readonly opaqueExpression?: string;
}

interface ClosureFindings {
  readonly nodeLeaks: Array<{ readonly chain: string[]; readonly specifier: string }>;
  readonly unresolved: Array<{ readonly importer: string; readonly specifier: string }>;
  readonly opaque: Array<{ readonly importer: string; readonly expression: string }>;
}

interface ClosureReport extends ClosureFindings {
  /** 带 'use client' 指令的入口，闭包遍历的种子。 */
  readonly entries: string[];
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listSourceFiles(path, out);
    else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function scriptKind(path: string): ts.ScriptKind {
  return path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** 指令必须落在语句前的 directive prologue 里，写在函数体内不算声明。 */
function isClientEntry(source: ts.SourceFile): boolean {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteralLike(statement.expression)) {
      return false;
    }
    if (statement.expression.text === 'use client') return true;
  }
  return false;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause?.isTypeOnly) return true;
  if (!clause || clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) {
    return false;
  }
  // `import {} from 'x'` 没有绑定，按运行时边处理：它仍是副作用 import。
  return clause.namedBindings.elements.length > 0
    && clause.namedBindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  return node.exportClause !== undefined
    && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0
    && node.exportClause.elements.every((element) => element.isTypeOnly);
}

function isModuleLoaderCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return false;
  return node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
}

function collectRuntimeEdges(source: ts.SourceFile): RuntimeEdge[] {
  const edges: RuntimeEdge[] = [];
  // import() 与 require() 的实参可能是变量：能取到字面量就展开，取不到就记成无法证明。
  const pushLoaderCall = (node: ts.CallExpression): void => {
    const argument = node.arguments[0];
    if (ts.isStringLiteralLike(argument)) edges.push({ specifier: argument.text });
    else edges.push({ specifier: '', opaqueExpression: argument.getText(source) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteralLike(node.moduleSpecifier) && !isTypeOnlyImport(node)) {
        edges.push({ specifier: node.moduleSpecifier.text });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier) && !isTypeOnlyExport(node)) {
        edges.push({ specifier: node.moduleSpecifier.text });
      }
    } else if (isModuleLoaderCall(node)) {
      pushLoaderCall(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

/** 与 `next.config.mjs` 的 `extensionAlias` 同口径：`.js` 说明符解析回 TS 源。 */
function resolveLocalModule(importer: string, specifier: string): string | null {
  const target = resolve(dirname(importer), specifier);
  const candidates = specifier.endsWith('.js')
    ? [target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx'), target]
    : [
        target,
        ...SCRIPT_EXTENSIONS.map((extension) => `${target}.${extension}`),
        ...SCRIPT_EXTENSIONS.map((extension) => join(target, `index.${extension}`)),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  // 旧式裸名同样会被打包器当成宿主模块解析（`fs`、`fs/promises`）。
  return NODE_BUILTIN_NAMES.has(specifier.split('/')[0]);
}

function displayPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

function analyzeRuntimeClosure(entries: string[], parse: (path: string) => ts.SourceFile): ClosureFindings {
  const nodeLeaks: ClosureFindings['nodeLeaks'] = [];
  const unresolved: ClosureFindings['unresolved'] = [];
  const opaque: ClosureFindings['opaque'] = [];
  const chains = new Map<string, string[]>();
  const queue = [...new Set(entries)];
  for (const entry of queue) chains.set(entry, [entry]);

  while (queue.length > 0) {
    const file = queue.shift()!;
    const chain = chains.get(file)!;
    for (const edge of collectRuntimeEdges(parse(file))) {
      if (edge.opaqueExpression !== undefined) {
        opaque.push({ importer: file, expression: edge.opaqueExpression });
        continue;
      }
      const { specifier } = edge;
      if (isNodeBuiltin(specifier)) {
        nodeLeaks.push({ chain, specifier });
      } else if (specifier.startsWith('.')) {
        if (ASSET_PATTERN.test(specifier)) continue;
        const target = resolveLocalModule(file, specifier);
        if (target === null) {
          unresolved.push({ importer: file, specifier });
          continue;
        }
        if (!chains.has(target)) {
          chains.set(target, [...chain, target]);
          queue.push(target);
        }
      }
      // 第三方包与宿主注入的别名（server-only）不展开。
    }
  }
  return { nodeLeaks, unresolved, opaque };
}

function inspect(rootDir: string): ClosureReport {
  const cache = new Map<string, ts.SourceFile>();
  const parse = (path: string): ts.SourceFile => {
    const cached = cache.get(path);
    if (cached) return cached;
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(path),
    );
    cache.set(path, source);
    return source;
  };
  const files = listSourceFiles(rootDir);
  const entries = files.filter((file) => isClientEntry(parse(file)));
  return { ...analyzeRuntimeClosure(entries, parse), entries };
}

function leakLines(report: ClosureReport, show: (path: string) => string = displayPath): string[] {
  return [
    ...report.nodeLeaks.map((leak) =>
      `  ${leak.chain.map(show).join(' → ')} ⇒ ${leak.specifier}`),
    ...report.unresolved.map((gap) => `  未解析：${show(gap.importer)} → ${gap.specifier}`),
    ...report.opaque.map((gap) => `  无法展开：${show(gap.importer)} import(${gap.expression})`),
  ];
}

/**
 * 控制组：门禁自己也得证明能变红。
 *
 * 写成测试期落盘的临时根，而不是 `test/fixtures/` 下的静态文件——那个目录在
 * `eslint.config.mjs` 的 ignores 里，作为 lint-staged 显式传入的文件会报
 * 「File ignored」警告并挂掉 `--max-warnings 0`。
 */
const CONTROL_TREE: Record<string, string> = {
  // 负向控制：node-touching 真的 import 了 `node:fs`，但一进一出两条边都只传类型，
  // TS 会擦掉它们；`./studio.css` 覆盖静态资源说明符跳过的分支。
  'clean/entry.tsx': `'use client';
import './studio.css';
import { describeName } from './facts';
import type { NodeReport } from './node-touching';

export function summarize(report: NodeReport): string {
  return describeName() + ': ' + String(report.bytes);
}
`,
  'clean/facts.ts': `export type { NodeReport } from './node-touching.js';

export function describeName(): string {
  return 'OMK';
}
`,
  'clean/node-touching.ts': `import { readFileSync } from 'node:fs';

export type NodeReport = { readonly bytes: number };

export function readReport(path: string): NodeReport {
  return { bytes: readFileSync(path).byteLength };
}
`,
  'clean/studio.css': '/* 静态资源：按扩展名跳过，不参与闭包。 */\n',
  // 正向控制：三跳值导入链，中间一跳是只转发值的桶文件——最常见的泄漏形态。
  'leaky/entry.tsx': `'use client';
import { noteBytes } from './panel';

export function note(): string {
  return noteBytes('/tmp/omk-control-note');
}
`,
  'leaky/panel.ts': `export { noteBytes } from './store.js';
`,
  'leaky/store.ts': `import { readFileSync } from 'node:fs';

export function noteBytes(path: string): number {
  return readFileSync(path).byteLength;
}
`,
};

let controlRoot = '';

function controlPath(path: string): string {
  return relative(controlRoot, path).split(sep).join('/');
}

beforeAll(() => {
  controlRoot = mkdtempSync(join(tmpdir(), 'omk-studio-client-closure-'));
  for (const [path, content] of Object.entries(CONTROL_TREE)) {
    const target = join(controlRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
});

// 用例失败或中断也要收掉临时根，不给下一轮留半棵目录树。
afterAll(() => {
  rmSync(controlRoot, { recursive: true, force: true });
});

describe('客户端运行时依赖闭包守门', () => {
  it('Studio 页面的客户端闭包不触达 Node 内建模块', () => {
    const report = inspect(WEB_DIR);
    // 扫描为空或解析退化都会把门禁变成假绿：入口必须真实在场，每条边必须算得动。
    expect(report.entries.length).toBeGreaterThan(0);
    expect(
      report.entries.some((entry) => entry.endsWith(join('components', 'inbox', 'inbox.tsx'))),
      '收件箱客户端组件必须在场，否则入口发现已经失效',
    ).toBe(true);

    const leaks = leakLines(report);
    if (leaks.length > 0) {
      throw new Error([
        `${report.entries.length} 个 'use client' 入口的运行时闭包里出现了宿主能力：`,
        ...leaks,
        '',
        '修复路径：把该模块拆成「纯投影（可进浏览器）+ 宿主侧装载」，页面只按值 import 前者；',
        '只是类型需要的话改用 `import type`，它会被 TS 擦除、不进 chunk。',
        '口径见 src/studio/AGENTS.md 与本文件头部注释。',
      ].join('\n'));
    }
  });

  it('闭包只沿运行时边展开：type-only 与静态资源不算成员', () => {
    const report = inspect(join(controlRoot, 'clean'));
    expect(report.entries.map(controlPath)).toEqual(['clean/entry.tsx']);
    expect(leakLines(report, controlPath)).toEqual([]);
  });

  it('运行时边触达 Node 内建模块时报出完整链路', () => {
    const report = inspect(join(controlRoot, 'leaky'));
    expect(leakLines(report, controlPath)).toEqual([
      '  leaky/entry.tsx → leaky/panel.ts → leaky/store.ts ⇒ node:fs',
    ]);
  });
});
