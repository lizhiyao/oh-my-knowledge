/**
 * 架构边界守门：`?tab=` 的参数名与每组面板取值只有一个 owner（`src/studio/http/page-params.ts`），
 * 且 owner 里的键集合与组件里真实渲染出来的 `Tabs` 项一致（含顺序）。
 *
 * 起因是 #903 的 D3：面板切换收进地址之后，同一个键集合有两类读者——RSC 路由页按它校验地址，
 * `'use client'` 组件按它渲染面板。取值不能由组件拥有（RSC 只能 `import type` `'use client'`
 * 模块），于是它搬到叶子文件里；搬过去就带来一个新风险：加一个面板只改组件，或改了键名忘了改
 * owner。前者不会变红（owner 只是多一个没人用的键），后者也不会（组件照样渲染，只是所有分享出去
 * 的地址静默回到默认面板）。所以这里按 AST 把两侧对齐，而不是靠人记住两处要同步。
 *
 * 除键集合外，这里还按标识符名钉三件接线（不比对文本格式，重排代码不会误伤）：
 *  - 读侧：每个路由页恰好一次 `parseTab(地址值, 本页取值集合, 本页默认值)`，并真的把结果过给组件的
 *    `initialTab`。收件箱那条编译器能逼出来（属性是必需的），轨迹页那条逼不出来——`ObserveView` 同时
 *    服务三条路由，只有 trajectory 分支用得到面板，所以属性是可选的，删掉读侧只是少传一个可选值。
 *  - 写侧：`mirrorTabToUrl(面板, 本页默认值)` 的默认值实参必须是同一页的 `DEFAULT_*`，否则「默认面板
 *    不占参数」会在某一页上悄悄失效。
 *  - 单一写入口：组件里 `setActiveTab(...)` 只能有 `changeTab` 内部那一次。绕过它直接改状态的切换不写
 *    地址，于是地址停在被跳走的面板上——刷新回到另一个界面，分享出去的链接也是错的。
 *
 * 口径边界（刻意不扩）：
 *  - 只认 `Tabs` 元素上 `items` 数组的直接对象字面量项的 `key` 字符串属性。回调里的
 *    `changeTab('signals')`、JSX 上的 `key={page.revision}` 都不是面板定义，不收。
 *  - 键值本身允许在别处出现（`source`、`signals` 这些词在展示文案里合法），本门禁不搜全文；
 *    它只钉「谁定义面板集合」和「谁写地址」两处对齐。
 *  - 参数名只钉「不得绕过 owner 用字面量操作 query」；`view`／`id`／`workspace` 这些还没收进
 *    owner 的参数不在本门禁里，等各自的决策。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { OBSERVE_INBOX_TABS, TAB_PARAM, TRAJECTORY_TABS } from '../../src/studio/http/page-params.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STUDIO_DIR = join(REPO_ROOT, 'src', 'studio');
const OWNER_FILE = join(STUDIO_DIR, 'http', 'page-params.ts');
const SKIPPED_DIRS = new Set(['.next', 'node_modules', 'dist', 'coverage']);
/** 面板键目前的两个消费者：收件箱外壳与任务轨迹页，各自对应一个 owner 数组和一个 RSC 路由页。 */
const TAB_SURFACES = [
  {
    file: join(STUDIO_DIR, 'web', 'components', 'observe', 'inbox', 'inbox.tsx'),
    page: join(STUDIO_DIR, 'web', 'app', 'observe', 'inbox', 'page.tsx'),
    tabsName: 'OBSERVE_INBOX_TABS',
    fallbackName: 'DEFAULT_OBSERVE_INBOX_TAB',
    owner: OBSERVE_INBOX_TABS,
  },
  {
    file: join(STUDIO_DIR, 'web', 'components', 'observe', 'observe.tsx'),
    page: join(STUDIO_DIR, 'web', 'app', 'observe', 'conversations', '[threadId]', 'tasks', '[turnId]', 'page.tsx'),
    tabsName: 'TRAJECTORY_TABS',
    fallbackName: 'DEFAULT_TRAJECTORY_TAB',
    owner: TRAJECTORY_TABS,
  },
] as const;

function parse(path: string): ts.SourceFile {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

function stringValue(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** 文件里每个 `Tabs` 元素 `items` 数组的直接对象项 `key`，按出现顺序。 */
function declaredTabKeys(path: string): string[][] {
  const source = parse(path);
  const groups: string[][] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
      && ts.isIdentifier(node.tagName) && node.tagName.text === 'Tabs') {
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name) || attribute.name.text !== 'items') continue;
        const value = attribute.initializer;
        if (!value || !ts.isJsxExpression(value) || !value.expression || !ts.isArrayLiteralExpression(value.expression)) continue;
        const keys: string[] = [];
        for (const element of value.expression.elements) {
          if (!ts.isObjectLiteralExpression(element)) continue;
          for (const property of element.properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'key') continue;
            const key = stringValue(property.initializer);
            if (key !== undefined) keys.push(key);
          }
        }
        groups.push(keys);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return groups;
}

function scriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) scriptFiles(path, out);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

function collect<T>(path: string, pick: (node: ts.Node) => T | undefined): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node): void => {
    const hit = pick(node);
    if (hit !== undefined) out.push(hit);
    ts.forEachChild(node, visit);
  };
  visit(parse(path));
  return out;
}

function identifierName(node: ts.Node | undefined): string | undefined {
  return node && ts.isIdentifier(node) ? node.text : undefined;
}

/** 文件里每次 `parseTab(地址值, 面板集合, 默认面板)` 的后两个实参标识符名。 */
function parseTabArgs(path: string): Array<{ tabs: string | undefined; fallback: string | undefined }> {
  return collect(path, (node) => (ts.isCallExpression(node) && identifierName(node.expression) === 'parseTab'
    ? { tabs: identifierName(node.arguments[1]), fallback: identifierName(node.arguments[2]) }
    : undefined));
}

/** 文件里每次 `mirrorTabToUrl(面板, 默认面板)` 的第二个实参标识符名。 */
function mirroredDefaults(path: string): Array<string | undefined> {
  return collect(path, (node) => (ts.isCallExpression(node) && identifierName(node.expression) === 'mirrorTabToUrl'
    ? identifierName(node.arguments[1])
    : undefined));
}

/** `setActiveTab(...)` 的调用点数：面板状态应当只有一个写入口，否则地址会静默落后。 */
function stateWriteCalls(path: string): number {
  return collect(path, (node) => (ts.isCallExpression(node) && identifierName(node.expression) === 'setActiveTab' ? true : undefined)).length;
}

/** 本文件是否真的往组件上过 `initialTab` 属性。 */
function passesInitialTab(path: string): boolean {
  return collect(path, (node) => {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) return undefined;
    const hit = node.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute)
      && ts.isIdentifier(attribute.name) && attribute.name.text === 'initialTab');
    return hit ? true : undefined;
  }).length > 0;
}

/** `dir` 下绕过 owner、直接用字面量操作 `tab` 这个 query 参数的文件（绝对路径，排序便于断言）。 */
function rawTabParamWrites(dir: string): string[] {
  const offenders: string[] = [];
  for (const file of scriptFiles(dir)) {
    if (file === OWNER_FILE) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.expression)
        && node.expression.expression.name.text === 'searchParams'
        && ['set', 'get', 'delete', 'has'].includes(node.expression.name.text)
        && stringValue(node.arguments[0]) === TAB_PARAM) {
        offenders.push(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
  }
  return offenders.sort();
}

function displayRepoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

/**
 * 控制组：collector 必须只认 `Tabs items` 的直接对象项，扫描器必须真的能判死绕过 owner 的写法。
 *
 * 写成测试期落盘的临时文件，理由同 `studio-page-paths.test.ts`：`test/fixtures/` 在 eslint
 * ignores 里，显式传入会报「File ignored」并挂掉 `--max-warnings 0`。
 */
const FIXTURES: Record<string, string> = {
  'panel.tsx': `import { Tabs } from 'antd';
export function Panel() {
  return <Tabs items={[
    { key: 'alpha', label: 'A', children: <Tabs items={[{ key: 'nested', label: 'N' }]} /> },
    { key: 'beta', label: 'B', children: <Child key="react-key" /> },
    { label: 'no key', children: <button onClick={() => changeTab('phantom')} /> },
  ]} />;
}
`,
  // 判死：绕过 owner，在组件里抄字面量操作 tab 参数。
  'bypass.ts': `export function select(url: URL): void {
  url.searchParams.set('tab', 'source');
}
`,
  // 判活：经 TAB_PARAM 取参数名，或操作的是还没收进 owner 的别的参数。
  'allowed.ts': `import { TAB_PARAM } from './page-params.js';
export function select(url: URL): void {
  url.searchParams.set(TAB_PARAM, 'source');
  url.searchParams.delete('view');
}
`,
};

let fixtureRoot = '';

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'omk-studio-page-params-'));
  for (const [name, content] of Object.entries(FIXTURES)) {
    writeFileSync(join(fixtureRoot, name), content);
  }
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Studio 地址参数 ?tab= 的单一 owner 守门', () => {
  it('owner 的每组面板键都与组件真实渲染的面板一致（含顺序）', () => {
    for (const surface of TAB_SURFACES) {
      const groups = declaredTabKeys(surface.file);
      expect(groups.length, `${surface.file} 里读不到 Tabs 定义，判据失效`).toBe(1);
      expect(groups[0], `面板键与 owner 不一致：${displayRepoPath(surface.file)}`).toEqual([...surface.owner]);
    }
  });

  it('读侧接在 owner 上：路由页把地址值过给 parseTab 并带上本页的取值集合', () => {
    for (const surface of TAB_SURFACES) {
      const display = displayRepoPath(surface.page);
      expect(passesInitialTab(surface.page), `${display} 没有把面板过给组件`).toBe(true);
      expect(parseTabArgs(surface.page), `${display} 不是从地址校验出面板`).toEqual([
        { tabs: surface.tabsName, fallback: surface.fallbackName },
      ]);
    }
  });

  it('写侧接在 owner 上：面板状态只有一个写入口，且它会镜像地址', () => {
    for (const surface of TAB_SURFACES) {
      const display = displayRepoPath(surface.file);
      expect(mirroredDefaults(surface.file), `${display} 没有把当前面板写回地址`).toEqual([surface.fallbackName]);
      // 绕过 changeTab 直接 setState 的切换不会写地址：地址停在被跳走的面板上，用户刷新就回到
      // 另一个界面，分享出去的链接也是错的，所以只允许一个写入口。
      expect(stateWriteCalls(surface.file), `${display} 出现了 changeTab 之外的面板写点`).toBe(1);
    }
  });

  it('写地址的一侧通过 TAB_PARAM 取参数名', () => {
    expect(TAB_PARAM).toBe('tab');
    // 扫描退化会让这条门禁变成永真断言：Studio 源码必须真的被扫到。
    expect(scriptFiles(STUDIO_DIR).length).toBeGreaterThan(50);
    const offenders = rawTabParamWrites(STUDIO_DIR).map(displayRepoPath);
    expect(offenders, `这些文件绕过 owner 直接用字面量操作 tab 参数：${offenders.join('、')}`).toEqual([]);
  });

  it('控制组：抄字面量操作 tab 判死，经 TAB_PARAM 或别的参数判活', () => {
    expect(rawTabParamWrites(fixtureRoot).map((file) => basename(file))).toEqual(['bypass.ts']);
  });

  it('控制组：一个 Tabs 出一组键，嵌套的面板自成一档，React key 与回调实参不掺进来', () => {
    expect(declaredTabKeys(join(fixtureRoot, 'panel.tsx'))).toEqual([['alpha', 'beta'], ['nested']]);
  });
});
