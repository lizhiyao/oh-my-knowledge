/**
 * 架构边界守门：Studio 渲染层的站内跳转只有一个声明式机制——`next/link`。
 *
 * 起因是 #903 第三项：壳层一级导航、品牌位、语言切换、知识区的全部返回链接与表格链接都用原生
 * `<a href>`，观测区与评测区却已经用 `Link`。Studio 是常驻壳层的全屏应用，原生 `<a>` 每次跳转
 * 都是整文档导航：壳层被卸载重建，各页的客户端状态（打开的抽屉、筛选、分页、阅读区的跟随位置）
 * 全部丢失，用户看到的是整屏闪一下再回到另一个分区。同一个「切到观测」的动作，从页头点是重载、
 * 从会话卡片点是客户端导航，这种不一致没有任何静态信号能看见，清一轮又会重新长回来。
 *
 * 口径边界（刻意不扩）：
 *  - 判据是「`href` 属性的归属元素」，不是全文搜索：字符串里出现的 `href`、`window.location.href`
 *    的读取、对象字面量里作为数据字段的 `href:`（如分区导航的条目数组，最终交给 `Link`）都不算。
 *  - 允许的持有者按 import 解析，不按名字：`import Link from 'next/link'` 的默认导入叫什么名字都认，
 *    没有这个 import 时任何 `href` 属性都判违规。仓库里统一写作 `Link`。
 *  - 原生 `<a>` 一律判违规，不区分站内站外。站外地址同样交给 `Link`：Next 自己判定非站内地址时
 *    退回普通浏览器导航，所以规则不需要为外链留口子。
 *  - 按钮形态的跳转（antd Button 之类自己渲染锚点、又不可能被 `Link` 包裹的组件）不在本门禁的
 *    声明式口径内，改用 `useRouter().push`；这类命令式跳转的约束由各页的行为测试承担。
 *  - 只扫 `src/studio/web`：这是唯一的 React 渲染层，`http`／`view-models`／`application` 不产出标记。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB_DIR = join(REPO_ROOT, 'src', 'studio', 'web');
const SKIPPED_DIRS = new Set(['.next', 'node_modules', 'dist', 'coverage']);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

interface Audit {
  readonly fileCount: number;
  readonly linkCount: number;
  readonly violations: Violation[];
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
    else if (entry.endsWith('.tsx') || (entry.endsWith('.ts') && !entry.endsWith('.d.ts'))) out.push(path);
  }
  return out;
}

/** `next/link` 默认导入在本文件里的名字；没有这个 import 时返回 undefined。 */
function linkComponentName(source: ts.SourceFile): string | undefined {
  let name: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'next/link') {
      const clause = node.importClause;
      if (clause?.name) name = clause.name.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return name;
}

function audit(files: string[], display: (path: string) => string): Audit {
  const violations: Violation[] = [];
  let linkCount = 0;
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const link = linkComponentName(source);
    const report = (node: ts.Node, reason: string): void => {
      violations.push({ file: display(file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, reason });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        if (tag === 'a') report(node, '原生 <a>：站内跳转必须走 next/link');
        else {
          const holdsHref = node.attributes.properties
            .some((property) => ts.isJsxAttribute(property) && property.name.getText(source) === 'href');
          if (holdsHref) {
            if (link && tag === link) linkCount += 1;
            else report(node, `<${tag}> 持有 href：href 只允许出现在 next/link 上`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { fileCount: files.length, linkCount, violations: violations.sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : left.line - right.line) };
}

function displayRepoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

const FIXTURE: Record<string, string> = {
  // 判死：原生锚点，以及自己渲染锚点的组件持有 href。
  'dead.tsx': `export function Dead(): JSX.Element {
  return <div><a href="/observe?lang=zh">观测</a><button type="button" href="/measure?lang=zh">评测</button></div>;
}
`,
  // 判活：next/link 的默认导入，名字不叫 Link 也认。
  'aliased.tsx': `import NextLink from 'next/link';

export function Aliased(): JSX.Element {
  return <NextLink href="/knowledge?lang=zh">知识</NextLink>;
}
`,
  'plain.tsx': `import Link from 'next/link';

export function Plain(): JSX.Element {
  return <Link href="/observe?lang=zh">观测</Link>;
}
`,
  // 判死：没有 next/link 导入时，同名 Link 也不认。
  'unresolved.tsx': `function Link(props: { href: string }): JSX.Element {
  return <span>{props.href}</span>;
}

export function Unresolved(): JSX.Element {
  return <Link href="/observe?lang=zh">观测</Link>;
}
`,
};

let fixtureRoot = '';

function fixturePath(name: string): string {
  return join(fixtureRoot, name);
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'omk-studio-internal-navigation-'));
  for (const [name, content] of Object.entries(FIXTURE)) {
    const target = fixturePath(name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Studio 站内跳转的机制守门', () => {
  it('渲染层里不存在 next/link 之外的 href 持有者', () => {
    const files = listSourceFiles(WEB_DIR);
    // 扫描退化会让门禁变成假绿：渲染层必须真的被扫到，且已经在用 Link。
    expect(files.length).toBeGreaterThan(0);

    const report = audit(files, displayRepoPath);
    expect(report.linkCount, '渲染层里没有任何 next/link 用法，扫描口径已经失效').toBeGreaterThan(0);

    if (report.violations.length > 0) {
      throw new Error([
        `这些站内跳转没有走 next/link（共 ${report.violations.length} 处）：`,
        ...report.violations.map((entry) => `  ${entry.file}:${entry.line} ⇒ ${entry.reason}`),
        '',
        '处理：文字链接改成 next/link 的 Link；按钮形态的跳转改成 useRouter().push，不要让组件自己持有 href。',
        '原生 <a> 会让常驻壳层整文档重载并丢掉各页客户端状态。口径见本文件头部注释。',
      ].join('\n'));
    }
  });

  it('控制组：原生锚点与非 next/link 的 href 判死，next/link 判活且不认同名替身', () => {
    const report = audit(
      ['dead.tsx', 'aliased.tsx', 'plain.tsx', 'unresolved.tsx'].map(fixturePath),
      (path) => path.slice(`${fixtureRoot}/`.length),
    );

    expect(report.linkCount).toBe(2);
    expect(report.violations.map((entry) => `${entry.file}:${entry.line} ⇒ ${entry.reason}`)).toEqual([
      'dead.tsx:2 ⇒ 原生 <a>：站内跳转必须走 next/link',
      'dead.tsx:2 ⇒ <button> 持有 href：href 只允许出现在 next/link 上',
      'unresolved.tsx:6 ⇒ <Link> 持有 href：href 只允许出现在 next/link 上',
    ]);
  });
});
