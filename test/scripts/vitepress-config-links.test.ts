import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const PROJECT_ROOT = join(__dirname, '..', '..');
const DOCS_ROOT = join(PROJECT_ROOT, 'docs');
const CONFIG_PATH = join(DOCS_ROOT, '.vitepress', 'config.ts');

interface ConfigLink {
  link: string;
  line: number;
}

function propertyName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
}

function collectConfigLinks(source: ts.SourceFile): ConfigLink[] {
  const links: ConfigLink[] = [];
  const stringConstants = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)
        || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)
          && declaration.initializer !== undefined
          && ts.isStringLiteralLike(declaration.initializer)) {
        stringConstants.set(declaration.name.text, declaration.initializer.text);
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'link') {
      const line = source.getLineAndCharacterOfPosition(node.initializer.getStart(source)).line + 1;
      const link = ts.isStringLiteralLike(node.initializer)
        ? node.initializer.text
        : ts.isIdentifier(node.initializer)
          ? stringConstants.get(node.initializer.text)
          : undefined;
      if (link === undefined) {
        throw new TypeError(`VitePress config.ts:${line} 的 link 必须是可静态检查的字符串。`);
      }
      if (link.startsWith('/')) {
        links.push({ link, line });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return links;
}

/**
 * nav 与 sidebar 是两份手写的平行字面量（`config.ts` 里没有生成器也没有共享数组），
 * 只比「每条链接都能落到某个页面」比不出「一侧多一项」。按 `/zh/` 前缀切成两列后，
 * 英文侧与中文侧的路径序列必须完全一致 —— 少一项、错一位、只加在一侧都会红。
 * 标签文本本身就是两种语言，不参与比较。语言切换项（`locales.zh.link` = `/zh/`）按语言
 * 固有、根 locale 没有对应字面量，因此 locale 首页本身不算导航条目。
 */
function localeMirrorPaths(links: string[]): { english: string[]; chinese: string[] } {
  const normalize = (link: string) => `/${link.replace(/^\/zh\//u, '').replace(/^\//u, '')}`.replace(/\/+$/u, '');
  const english: string[] = [];
  const chinese: string[] = [];
  for (const link of links) {
    const path = normalize(link);
    if (path === '') continue;
    if (link === '/zh' || link.startsWith('/zh/')) chinese.push(path);
    else english.push(path);
  }
  return { english, chinese };
}

function resolvesToPublishedPage(link: string): boolean {
  const pathname = link.split(/[?#]/u, 1)[0]!.replace(/^\/+|\/+$/gu, '');
  const base = join(DOCS_ROOT, pathname);
  return [
    `${base}.md`,
    join(base, 'index.md'),
  ].some((candidate) => existsSync(candidate));
}

describe('VitePress config internal links', () => {
  it('中英 nav 与 sidebar 两棵树同序同集合', () => {
    const source = ts.createSourceFile(CONFIG_PATH, readFileSync(CONFIG_PATH, 'utf8'), ts.ScriptTarget.Latest, true);
    const { english, chinese } = localeMirrorPaths(collectConfigLinks(source).map((entry) => entry.link));
    expect(english.length).toBeGreaterThan(0);
    expect(chinese).toEqual(english);
  });

  it('rejects missing pages and dynamic links instead of silently skipping them', () => {
    const missing = ts.createSourceFile(
      'missing.ts',
      "export default { link: '/guides/definitely-missing' };",
      ts.ScriptTarget.Latest,
      true,
    );
    expect(collectConfigLinks(missing)).toEqual([{
      link: '/guides/definitely-missing',
      line: 1,
    }]);
    expect(resolvesToPublishedPage('/guides/definitely-missing')).toBe(false);

    const dynamic = ts.createSourceFile(
      'dynamic.ts',
      'declare function getTarget(): string; export default { link: getTarget() };',
      ts.ScriptTarget.Latest,
      true,
    );
    expect(() => collectConfigLinks(dynamic)).toThrow(/必须是可静态检查的字符串/u);
  });

  it('all absolute nav and sidebar links resolve to published Markdown pages', () => {
    const source = ts.createSourceFile(
      CONFIG_PATH,
      readFileSync(CONFIG_PATH, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const links = collectConfigLinks(source);
    expect(links.length).toBeGreaterThan(0);

    const violations = links
      .filter(({ link }) => !resolvesToPublishedPage(link))
      .map(({ link, line }) => `${relative(PROJECT_ROOT, CONFIG_PATH)}:${line} -> ${link}`);
    expect(violations, 'VitePress 导航存在无法解析到 Markdown 页面的站内链接').toEqual([]);
  });
});
