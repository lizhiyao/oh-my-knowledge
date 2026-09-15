/**
 * 架构边界守门：Studio 页面地址只有一个 owner（`src/studio/http/page-paths.ts`），且每个地址都
 * 对应 `web/app` 下真实存在的路由。
 *
 * 起因是 #903 第三项：同一批页面地址此前有三类 owner 各写一遍字面量——`http/next-server.ts`
 * 判断宿主是否接管该路由组、`http/pages/*-page.ts` 判断装载哪个页面模型、`web/components/**`
 * 拼用户点的链接。`/measure` 一个地址就有四处写法。三者必须一致却没有任何机制保证：把路由目录
 * 改名，链接照样渲染，用户点下去拿到 HTTP adapter 的纯文本 404，而装载器与页面都还在——没有
 * 编译错误、没有 lint、没有测试变红，只能靠人在浏览器里点到。
 *
 * 口径边界（刻意不扩）：
 *  - 判据是 AST 里的字符串／模板字面量，不是全文搜索：注释、README、`src/studio/README.md` 里
 *    的 `/observe/health/:id` 都是文档，改名时它们该跟着改但不该让门禁变红。
 *  - 只认三个页面根 `/observe`、`/measure`、`/knowledge`。`/api/**` 是机器可读资源地址，
 *    由各自 route 模块拥有，不是页面地址，不在本门禁机制里。
 *  - `/` 根入口与 `conversation-link.ts` 里的 `/tasks/` 子段不判：前者是宿主入口而非页面地址，
 *    后者是深链 owner 内部的段拼接，两者都不存在第二类 owner。
 *  - 反向覆盖只到「路由组」粒度：它钉的是新增一个顶级路由组时必须有 owner 常量，不要求每个
 *    动态段都有常量。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STUDIO_DIR = join(REPO_ROOT, 'src', 'studio');
const OWNER_FILE = join(STUDIO_DIR, 'http', 'page-paths.ts');
const APP_DIR = join(STUDIO_DIR, 'web', 'app');
const SKIPPED_DIRS = new Set(['.next', 'node_modules', 'dist', 'coverage']);
/** 页面根之外的地址（`/api/**`、`/`）由各自的机制拥有，不在本门禁里。 */
const PAGE_ROOTS = ['observe', 'measure', 'knowledge'] as const;
const PAGE_ADDRESS = new RegExp(`^/(?:${PAGE_ROOTS.join('|')})(?:/.*)?$`);

interface Literal {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listSourceFiles(path, out);
    else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

function parse(path: string): ts.SourceFile {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

function pageLiterals(files: string[], display: (path: string) => string): Literal[] {
  const found: Literal[] = [];
  for (const file of files) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      const text = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text : undefined;
      if (text !== undefined && PAGE_ADDRESS.test(text)) {
        found.push({ file: display(file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found.sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : left.line - right.line);
}

/** 路由目录 → 地址：`web/app/observe/health/[analysisId]/page.tsx` ⇒ `/observe/health/[analysisId]`。 */
function routeAddresses(): string[] {
  return listSourceFiles(APP_DIR)
    .filter((file) => file.endsWith(`${sep}page.tsx`))
    .map((file) => `/${relative(APP_DIR, dirname(file)).split(sep).join('/')}`)
    .sort();
}

function ownerConstants(): Record<string, string> {
  const source = parse(OWNER_FILE);
  const constants: Record<string, string> = {};
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isStringLiteralLike(declaration.initializer)) continue;
      constants[declaration.name.text] = declaration.initializer.text;
    }
  }
  return constants;
}

/** 地址常量与路由的匹配：`/observe/health/` 这类前缀常量由更深的动态段路由满足。 */
function matchesRoute(value: string, routes: string[]): string | undefined {
  const base = value.endsWith('/') ? value.slice(0, -1) : value;
  return routes.find((route) => route === base || route.startsWith(`${base}/`));
}

function displayRepoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

function importedModules(path: string): string[] {
  return parse(path).statements.filter(ts.isImportDeclaration).map((statement) => statement.moduleSpecifier.getText().slice(1, -1));
}

/**
 * 控制组：门禁自己也得证明能变红，且证明注释与 `/api/**` 不会误伤。
 *
 * 写成测试期落盘的临时根，理由同 `studio-client-runtime-closure.test.ts`：`test/fixtures/`
 * 在 eslint ignores 里，显式传入会报「File ignored」并挂掉 `--max-warnings 0`。
 */
const FIXTURE: Record<string, string> = {
  // 判死：组件里硬抄了一个页面地址。
  'hardcoded.tsx': `import Link from 'next/link';

export function Hardcoded(): JSX.Element {
  return <Link href="/observe/inbox?lang=zh">收件箱</Link>;
}
`,
  // 判活：注释里出现地址（含反引号包裹）不算字面量；`/api/**` 是接口地址不是页面地址。
  'allowed.ts': `/**
 * 宿主侧 \`src/studio/http/next-server.ts\` 把 \`/measure/\` 之后仍带 \`/\` 的地址当作 404。
 */
export function load(): Promise<unknown> {
  return fetch('/api/knowledge/candidates', { method: 'POST' }).then((response) => response.json());
}
`,
  // 判死：宿主绕过装载器，自己按地址常量匹配前缀。
  'host-matches.ts': `import { MEASURE_DETAIL_PREFIX, MEASURE_INDEX_PATH } from './page-paths.js';

export function taken(path: string): boolean {
  return path === MEASURE_INDEX_PATH || path.startsWith(MEASURE_DETAIL_PREFIX);
}
`,
};

let fixtureRoot = '';

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'omk-studio-page-paths-'));
  for (const [name, content] of Object.entries(FIXTURE)) {
    const target = join(fixtureRoot, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Studio 页面地址的单一 owner 守门', () => {
  it('页面地址字面量只出现在 page-paths.ts', () => {
    const files = listSourceFiles(STUDIO_DIR).filter((file) => file !== OWNER_FILE);
    // 扫描退化会让门禁变成假绿：Studio 源码必须真的被扫到。
    expect(files.length).toBeGreaterThan(50);
    expect(pageLiterals([OWNER_FILE], displayRepoPath).length, 'owner 文件里已经读不到地址常量，扫描口径失效').toBeGreaterThan(0);

    const violations = pageLiterals(files, displayRepoPath);
    if (violations.length > 0) {
      throw new Error([
        `这些页面地址在 owner 之外又写了一遍（共 ${violations.length} 处）：`,
        ...violations.map((entry) => `  ${entry.file}:${entry.line} ⇒ ${entry.text}`),
        '',
        '处理：改用 src/studio/http/page-paths.ts 的常量；确实是新页面就在该文件加常量，',
        '并在 src/studio/web/app 下建对应路由目录。地址抄两遍时改一处只会让用户拿到纯文本 404。',
      ].join('\n'));
    }
  });

  it('每个地址常量都对应 web/app 下真实存在的路由，每个路由都被某个常量覆盖', () => {
    const routes = routeAddresses();
    const constants = ownerConstants();
    expect(routes.length).toBeGreaterThan(0);
    expect(Object.keys(constants).length).toBeGreaterThan(0);

    const dangling = Object.entries(constants)
      .filter(([, value]) => matchesRoute(value, routes) === undefined)
      .map(([name, value]) => `  ${name} = ${value} ⇒ web/app 下没有对应路由目录`);
    const unowned = routes
      .filter((route) => !Object.values(constants).some((value) => matchesRoute(value, [route]) !== undefined))
      .map((route) => `  ${route} ⇒ 没有 owner 常量，链接与装载器只能各抄一遍`);

    if (dangling.length > 0 || unowned.length > 0) {
      throw new Error([
        '页面地址与路由目录不同步：',
        ...dangling,
        ...unowned,
      ].join('\n'));
    }
  });

  it('控制组：硬抄的页面地址判死，注释与 /api/** 判活', () => {
    const display = (path: string): string => path.slice(fixtureRoot.length + 1);
    const violations = pageLiterals([join(fixtureRoot, 'hardcoded.tsx'), join(fixtureRoot, 'allowed.ts')], display);
    expect(violations.map((entry) => `${entry.file}:${entry.line} ⇒ ${entry.text}`)).toEqual([
      'hardcoded.tsx:4 ⇒ /observe/inbox?lang=zh',
    ]);
  });

  /**
   * 第二道边界：地址常量只有一个 owner 还不够，识别地址这件事也得只有一个地方做。
   * `src/studio/README.md` 写明 `pages/` 的装载器负责「识别地址、装载证据、给出契约」，宿主只按
   * 路由组开关决定接不接管。宿主自己抄一遍前缀匹配时，装载器改了识别口径宿主不会跟着改——
   * 页面装载得到，请求却根本不被接管，用户拿到 HTTP adapter 的纯文本 404。
   */
  it('地址识别谓词在装载器里，宿主不自己匹配前缀', () => {
    const host = join(STUDIO_DIR, 'http', 'next-server.ts');
    const hostImports = importedModules(host);
    expect(hostImports, '宿主里已经读不到装载器 import，判据失效').toContain('./pages/measure-page.js');
    if (hostImports.includes('./page-paths.js')) {
      throw new Error([
        'src/studio/http/next-server.ts 又自己按地址常量匹配页面了。',
        '',
        '处理：识别地址属 pages/*-page.ts 的装载器（导出 is*Path 谓词），宿主只保留',
        'studioPages／observationInbox 这类路由组开关。两处各匹配一遍时，改装载器不会让宿主跟着改。',
      ].join('\n'));
    }
    const pagesDir = join(STUDIO_DIR, 'http', 'pages');
    const loaders = readdirSync(pagesDir).filter((name) => name.endsWith('-page.ts')).sort();
    expect(loaders, '装载器数量变了，这条门禁需要重新核对覆盖面').toEqual([
      'health-page.ts', 'inbox-page.ts', 'knowledge-page.ts', 'managed-page.ts', 'measure-page.ts', 'observe-page.ts',
    ]);
    for (const loader of loaders) {
      expect(readFileSync(join(pagesDir, loader), 'utf8'), `${loader} 没有导出地址识别谓词`).toMatch(/export function is\w+Path\(/u);
    }
  });

  it('控制组：宿主重新按常量匹配地址时判死', () => {
    expect(importedModules(join(fixtureRoot, 'host-matches.ts'))).toContain('./page-paths.js');
    expect(importedModules(join(STUDIO_DIR, 'http', 'pages', 'measure-page.ts'))).toContain('../page-paths.js');
  });
});
