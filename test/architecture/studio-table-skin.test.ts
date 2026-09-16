/**
 * 架构边界守门：表格皮肤只有一个中性类名 `studio-table`，且它的横向滚动提示常驻在皮肤自己的
 * 滚动容器上。
 *
 * 起因是 #903 的 D4／D5。`.measure-table` 原先是五个区共用的皮肤类名（评测列表、知识列表、受管
 * 决策史、观测健康度、原始记录），名字却把皮肤说成评测区独有：在 `.knowledge-table` 里加一条规则
 * 会不会串到评测列表，只能靠人记住「这两个类名其实是一层」。类名收中性之后，区名后缀只承担该区
 * 自己的差异，共享层与差异层从名字上就能分开。这条门禁钉住收口结果，防止有人再写回旧名或用某个
 * 区名重新拥有皮肤。
 *
 * 另一条是宽表的读法：`.studio-table` 的表普遍声明了 `scroll.x`，而 macOS 默认把滚动条渲染成
 * 覆盖式、只在滚动瞬间出现，于是 1460px 的评测列表在 1440 视口里只读得到「最后一列被切掉了」，
 * 读不出「它还能横向滚」。提示由 CSS 承担而不是 JS 测量，所以这里锁的是规则本身在不在、挂在哪个
 * 选择器上——像素验收只能证明一次构建，规则被删掉时不会有任何东西变红。
 *
 * 口径边界（刻意不扩）：
 *  - 只认 `<Table>` 元素上字符串字面量形式的 `className`。变量拼出来的类名、`Table` 之外元素的
 *    同名类（`.measure-table-block` 是评测区的区块容器，不是皮肤）都不在本门禁里。
 *  - 没有 `className` 的 `<Table>` 不在本门禁里：它今天确实存在（知识详情的待优化项表），是否要
 *    上皮肤是另一个决策，不由这条门禁替它决定。
 *  - 不检查各区后缀类名之间的差异是否合理，只检查「共用皮肤必须出现」这一条。
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STUDIO_DIR = join(REPO_ROOT, 'src', 'studio');
const CSS_FILE = join(STUDIO_DIR, 'web', 'app', 'studio.css');
const SKIN_CLASS = 'studio-table';
/** 皮肤类名的中性化前身：名字把共用层错标成评测区独有。 */
const LEGACY_SKIN = /measure-table(?!-block)/;
/** 评测区的区块容器（`<div>` + `<h3>`），与被改名的皮肤只是前缀相同。 */
const BLOCK_CLASS = 'measure-table-block';
const SKIPPED_DIRS = new Set(['.next', 'node_modules', 'dist', 'coverage']);

function scriptFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...scriptFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

/** `<Table … className="a b">` 的类名 token 列表；没有字符串字面量 className 的 Table 不产出条目。 */
export function tableSkinClasses(path: string): string[][] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const classes: string[][] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
      && ts.isIdentifier(node.tagName) && node.tagName.text === 'Table') {
      const attribute = node.attributes.properties.find(
        (property): property is ts.JsxAttribute => ts.isJsxAttribute(property)
          && ts.isIdentifier(property.name) && property.name.text === 'className',
      );
      if (attribute?.initializer && ts.isStringLiteral(attribute.initializer)) {
        classes.push(attribute.initializer.text.split(/\s+/).filter(Boolean));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return classes;
}

/** 仍在使用旧皮肤类名的文件（相对 `src/studio`）；`.measure-table-block` 不算。 */
export function legacySkinFiles(root: string): string[] {
  return scriptFiles(root).filter((file) => LEGACY_SKIN.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file).split(sep).join('/'));
}

/** 声明了 className 却缺皮肤类名的 `<Table>`。 */
export function unskinnedTables(root: string): string[] {
  return scriptFiles(root).flatMap((file) => tableSkinClasses(file)
    .filter((tokens) => !tokens.includes(SKIN_CLASS))
    .map(() => relative(root, file).split(sep).join('/')));
}

describe('表格皮肤只有一个中性类名', () => {
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'omk-table-skin-'));
    writeFileSync(join(fixtureRoot, 'legacy.tsx'), `export const c = 'measure-table knowledge-table';\n`);
    writeFileSync(join(fixtureRoot, 'bare.tsx'), 'export const T = () => <Table className="knowledge-table"/>;\n');
    writeFileSync(join(fixtureRoot, 'skinned.tsx'), 'export const T = () => <Table className="studio-table knowledge-table"/>;\n');
    // 区块容器与被改名的皮肤只是前缀相同，不得被当成旧名命中。
    writeFileSync(join(fixtureRoot, 'block.tsx'), 'export const T = () => <div className="measure-table-block"/>;\n');
  });

  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  it('控件组：旧名与缺皮肤的 Table 都能被抓到，皮肤名与区块容器不会误伤', () => {
    expect(legacySkinFiles(fixtureRoot)).toEqual(['legacy.tsx']);
    expect(unskinnedTables(fixtureRoot)).toEqual(['bare.tsx']);
  });

  it('src/studio 里不再有把共用皮肤标成评测区独有的类名', () => {
    expect(legacySkinFiles(STUDIO_DIR)).toEqual([]);
    expect(readFileSync(CSS_FILE, 'utf8')).toContain(`.${BLOCK_CLASS}`);
  });

  it('每个声明了 className 的 Table 都带上共用皮肤', () => {
    expect(unskinnedTables(STUDIO_DIR)).toEqual([]);
  });
});

describe('宽表的横向滚动提示挂在皮肤自己的滚动容器上', () => {
  /** 样式表里的 `选择器 {声明}` 对；先剥注释，否则上一条注释会被并进选择器。 */
  const rules = [...readFileSync(CSS_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, declarations]) => ({
      selectors: selector.replace(/\s+/g, ' ').trim().split(',').map((part) => part.trim()),
      declarations,
    }));
  const SCROLLERS = [`.${SKIN_CLASS} .ant-table`, `.${SKIN_CLASS} .ant-table-content`];
  /** 伪元素挂在谁身上，去掉伪元素后缀就是滚动容器本身。 */
  const baseSelectors = (entry: { selectors: string[] }): string[] => entry.selectors.map((selector) => selector.replace(/::-\w+-scrollbar\S*/, '').trim());
  const pseudoRules = rules.filter((entry) => entry.selectors.some((selector) => /scrollbar/.test(selector)));

  it('提示由 ::-webkit-scrollbar 承担，且只挂在皮肤的两个滚动容器上', () => {
    expect(pseudoRules.length).toBeGreaterThan(0);
    for (const entry of pseudoRules) expect(baseSelectors(entry)).toEqual(SCROLLERS);
  });

  it('滚动容器把 scrollbar-color 复位成 auto', () => {
    // 1440×900 实测：antd 在 `.ant-table` 上设的 scrollbar-color 会被继承，而它一旦不是 auto，
    // Chrome 就整个忽略 `::-webkit-scrollbar`——只有伪元素没有这条复位，滚动条根本不出现。
    const reset = rules.filter((entry) => entry.declarations.includes('scrollbar-color:auto'));
    expect(reset.map((entry) => entry.selectors)).toEqual([SCROLLERS]);
  });
});
