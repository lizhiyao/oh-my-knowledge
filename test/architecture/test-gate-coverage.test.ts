/**
 * 门禁自守：磁盘上真实存在的文件，必须落在某个真的会跑它的检查器里。
 *
 * 两条同类的静默假绿，机制不同而病灶一样：
 *  - vitest 的 `include` 必须覆盖 `test/` 下每种测试扩展名。收件箱收口（#839）时 React 页面的
 *    测试是 `.tsx` 而 include 只写了 `.ts`，文件被跳过、CI 仍然全绿。
 *  - `yarn typecheck` 的每个 tsc 程序必须收下它声称负责的文件。#913 里 `src/studio/web` 被根
 *    tsconfig 整片排除，`.tsx` 用例又不进任何程序，于是「给 web 子树加一条用例」要先踩
 *    `TS2835`／`TS6142` 才知道该改文件名——归属没定，绕行就成了默认答案。
 *
 * 口径边界（刻意不扩）：
 *  - 程序收下哪些文件、按什么语义收下，都取自 TypeScript 自己的配置解析（`extends`、glob、
 *    `exclude` 按真实语义展开），这里不重复实现一套匹配规则。
 *  - `.tsx` 只归 `tsconfig.studio-web.json`（它 extends `src/studio/web/tsconfig.json`，语义随
 *    Next 自己那份走）：根程序是 Node16 且不开 `--jsx`，而 `exclude` 只裁剪始发文件列表、不裁剪
 *    import 图，所以一个 `.ts` 只要 import web 子树的 `.tsx`，就会在 `layout/shell.tsx` 那类文件
 *    上撞 `TS6142`。这条按机制守住，而不是靠「用例记得用 `.tsx` 命名」。
 *  - 只判直接 import：把 web 的 `.tsx` 经两跳拖进根程序同样会红，但那正是 `yarn typecheck` 自己
 *    报的 `TS6142`，不在这里重复建模传递闭包。
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TEST_DIR = join(REPO_ROOT, 'test');
const WEB_SOURCE_DIR = 'src/studio/web';
const WEB_TEST_DIR = 'test/studio/web';
const SKIPPED_DIRS = new Set(['node_modules', '__snapshots__', '.next']);
const TEST_FILE = /\.test\.([A-Za-z]+)$/;

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** 仓库相对路径；跳过构建产物与 Next 生成的声明，与程序 `include` 的口径一致。 */
function listScriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listScriptFiles(path, out);
    else if (entry.endsWith('.d.ts')) continue;
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(toPosix(relative(REPO_ROOT, path)));
    }
  }
  return out;
}

function collectTestExtensions(dir: string, out: Set<string> = new Set()): Set<string> {
  for (const file of listScriptFiles(dir)) {
    const match = TEST_FILE.exec(basename(file));
    if (match) out.add(match[1]);
  }
  return out;
}

/** 读 vitest 实际解析的源码层 include（默认全量，非分片模式），不依赖配置文本形态。 */
function declaredIncludePatterns(): string[] {
  // 分层后 include 只在 project 内声明（根级 include 会与 project include 取并集导致
  // --project 过滤失效），且源码层 include 可能是分片清单。这里直接断言源码层默认
  // 收集全量 test/ 树的契约：OMK_SOURCE_SHARD 未设置时 include 为全量 glob。
  delete process.env.OMK_SOURCE_SHARD;
  const source = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf-8');
  expect(source, 'vitest.config.ts 必须保留源码层默认全量 include').toContain("'test/**/*.test.{ts,tsx}'");
  return ['test/**/*.test.{ts,tsx}'];
}

function declaredExtensions(patterns: string[]): Set<string> {
  const out = new Set<string>();
  for (const pattern of patterns) {
    for (const group of pattern.matchAll(/\{([^}]*)\}/g)) {
      for (const extension of group[1].split(',')) out.add(extension.trim());
    }
    const single = TEST_FILE.exec(pattern);
    if (single) out.add(single[1]);
  }
  return out;
}

function parseProgram(configFile: string): { files: Set<string>; options: ts.CompilerOptions } {
  const read = ts.readConfigFile(join(REPO_ROOT, configFile), ts.sys.readFile);
  if (read.error !== undefined) {
    throw new Error(`${configFile} 解析失败：${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`);
  }
  const content = ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT);
  const diagnostics = content.errors.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, ' '));
  expect(diagnostics, `${configFile} 本身必须无配置错误`).toEqual([]);
  return {
    files: new Set(content.fileNames.map((file) => toPosix(relative(REPO_ROOT, file)))),
    options: content.options,
  };
}

function moduleSpecifiers(content: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const literalOf = (node: ts.Node): ts.StringLiteralLike | undefined => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const { moduleSpecifier } = node;
      return moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier : undefined;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && ['import', 'require'].includes(node.expression.text) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      return ts.isStringLiteralLike(argument) ? argument : undefined;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    const literal = literalOf(node);
    if (literal !== undefined) specifiers.push(literal.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** 相对说明符是否指向真实存在的 `.tsx`：Node16 下 `./x.js` 解析到的就是 `./x.tsx`。 */
function tsxTarget(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(REPO_ROOT, dirname(importer), specifier);
  const candidates = [base, `${base.replace(/[.](?:js|mjs|cjs)$/, '')}.tsx`];
  for (const candidate of candidates) {
    if (!candidate.endsWith('.tsx')) continue;
    const path = toPosix(relative(REPO_ROOT, candidate));
    if (existsSync(join(REPO_ROOT, path))) return path;
  }
  return null;
}

describe('测试门禁覆盖面自守', () => {
  it('include 覆盖 test/ 下每种测试文件扩展名', () => {
    const patterns = declaredIncludePatterns();
    const onDisk = collectTestExtensions(TEST_DIR);
    // 任一侧为空都会让断言变成假绿。
    expect(patterns.length).toBeGreaterThan(0);
    expect(onDisk.size).toBeGreaterThan(0);
    // React 页面测试是这条守门的起因，必须在场，否则上面的包含关系无意义。
    expect(onDisk.has('tsx')).toBe(true);

    const declared = declaredExtensions(patterns);
    const uncovered = [...onDisk].filter((extension) => !declared.has(extension)).sort();
    expect(uncovered, `这些测试扩展名不会被 vitest 收集：${uncovered.join('、')}`).toEqual([]);
  });

  it('include 覆盖整棵 test/ 树而不是某个子目录', () => {
    const patterns = declaredIncludePatterns();
    expect(patterns.every((pattern) => pattern.startsWith('test/') && pattern.includes('**'))).toBe(true);
  });

  it('每个测试文件都落在产物层清单或某个源码层分片清单（覆盖不减）', () => {
    const readList = (path: string): Set<string> => new Set(
      readFileSync(join(REPO_ROOT, path), 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#')),
    );
    const productLayer = readList('test/product-layer.txt');
    const shardFiles = [1, 2, 3, 4].map((index) => readList(`test/shards/source-${index}.txt`));
    const covered = new Set<string>([...productLayer, ...shardFiles.flatMap((files) => [...files])]);
    const onDisk = listScriptFiles(TEST_DIR).filter((file) => TEST_FILE.test(basename(file)));
    const missing = onDisk.filter((file) => !covered.has(file)).sort();
    expect(missing, `这些测试文件不在产物层也不在任何源码层分片：${missing.join('、')}`).toEqual([]);
    // 分片之间不得重叠（重叠会让同一文件跑多遍，虚增覆盖且浪费 runner）。
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const files of shardFiles) {
      for (const file of files) {
        if (seen.has(file)) duplicated.push(file);
        seen.add(file);
      }
    }
    expect(duplicated, `这些文件落在多个源码层分片：${[...new Set(duplicated)].join('、')}`).toEqual([]);
    // 产物层与源码层分片不得重叠。
    const crossLayer = [...productLayer].filter((file) => seen.has(file)).sort();
    expect(crossLayer, `这些文件同时在产物层与源码层分片：${crossLayer.join('、')}`).toEqual([]);
  });
});

describe('tsc 程序归属自守', () => {
  const typecheck = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts: { typecheck: string };
  }).scripts.typecheck;

  it('typecheck 真的跑根程序与 web 程序', () => {
    expect(typecheck).toContain('tsc --noEmit -p tsconfig.json');
    expect(typecheck).toContain('tsc --noEmit -p tsconfig.studio-web.json');
  });

  it('web 子树源码与 test/studio/web 用例逐个进 web 程序', () => {
    const owned = parseProgram('tsconfig.studio-web.json').files;
    const onDisk = [
      ...listScriptFiles(join(REPO_ROOT, WEB_SOURCE_DIR)),
      ...listScriptFiles(join(REPO_ROOT, WEB_TEST_DIR)),
    ];
    // 空集合与「只有 .tsx」都会让这条断言退化成 #913 之前的状态。
    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk.some((file) => file.endsWith('.ts') && !file.endsWith('.tsx'))).toBe(true);
    const missing = onDisk.filter((file) => !owned.has(file)).sort();
    expect(missing, `这些文件不在 yarn typecheck 的任何程序里：${missing.join('、')}`).toEqual([]);
  });

  it('根程序不碰 web 子树，归属唯一', () => {
    const root = parseProgram('tsconfig.json').files;
    const overlap = [...root]
      .filter((file) => file.startsWith(WEB_SOURCE_DIR) || file.startsWith(WEB_TEST_DIR))
      .sort();
    expect(overlap, `这些文件同时属于根程序和 web 程序：${overlap.join('、')}`).toEqual([]);
  });

  it('web 程序按 Next 的语义检查，extends 断掉时包含关系不算数', () => {
    const { options } = parseProgram('tsconfig.studio-web.json');
    expect(options.jsx).toBe(ts.JsxEmit.ReactJSX);
    expect(options.moduleResolution).toBe(ts.ModuleResolutionKind.Bundler);
    // 根程序反过来必须不开 jsx：两份配置的分工就是这条断言的意义。
    expect(parseProgram('tsconfig.json').options.jsx).toBeUndefined();
  });

  it('.tsx 只存在于 test/studio/web，其余 .tsx 不属于任何程序', () => {
    const strays = listScriptFiles(TEST_DIR)
      .filter((file) => file.endsWith('.tsx') && !file.startsWith(`${WEB_TEST_DIR}/`))
      .sort();
    expect(strays, `这些 .tsx 不会被任何 tsc 程序检查：${strays.join('、')}`).toEqual([]);
  });

  it('根程序里的 .ts 不得把 web 子树的 .tsx 拽进不开 jsx 的编译', () => {
    const root = parseProgram('tsconfig.json').files;
    const offenders: string[] = [];
    for (const file of root) {
      if (file.startsWith(WEB_SOURCE_DIR) || file.startsWith(WEB_TEST_DIR)) continue;
      const content = readFileSync(join(REPO_ROOT, file), 'utf-8');
      // 指向该子树的相对路径必含 `web/` 段；不含的文件不必建 AST。
      if (!content.includes('web/')) continue;
      for (const specifier of moduleSpecifiers(content, file)) {
        const target = tsxTarget(file, specifier);
        if (target !== null && target.startsWith(`${WEB_SOURCE_DIR}/`)) offenders.push(`${file} → ${target}`);
      }
    }
    expect(offenders, `这些 import 会让根程序撞 TS6142：${offenders.join('、')}`).toEqual([]);
  });
});
