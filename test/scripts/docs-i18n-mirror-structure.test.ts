/**
 * 中英文档镜像的结构门禁：`docs/<path>` 与 `docs/zh/<path>` 必须逐节同构。
 *
 * 已有的 `docs-i18n-mirror-links.test.ts` 只比文件清单，比不出「中文少一整节」——
 * 每个发布页都有 zh 镜像，zh 侧少一节、EN 侧少一张表都能清单全绿而读者拿到的内容
 * 不同（实测：terminology-spec 的 zh 少 2 个 `###` 与 25 行表格）。这里按结构而不是
 * 字节比：标题深度序列、表格数与表格行数、代码块数。翻译本就会改变行数与词数，
 * 所以只比与语言无关的形状，不比行数、不比字数。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS_ROOT = join(PROJECT_ROOT, 'docs');
const ZH_ROOT = join(DOCS_ROOT, 'zh');

interface Shape {
  headingDepth: number[];
  tableCount: number;
  tableRows: number;
  fenceBlocks: number;
}

/** `docs/zh` 是 zh locale 的根：扫英文侧时必须跳过，否则英文清单会把整棵中文树算进来。 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.vitepress', 'zh']);

function walkMarkdown(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function mirrorPaths(): string[] {
  return walkMarkdown(DOCS_ROOT, []).map((file) => relative(DOCS_ROOT, file)).sort();
}

function readShape(root: string, path: string): Shape {
  const shape: Shape = { headingDepth: [], tableCount: 0, tableRows: 0, fenceBlocks: 0 };
  let inFence = false;
  let previousWasTableRow = false;
  for (const line of readFileSync(join(root, path), 'utf8').split(/\r?\n/)) {
    if (/^ {0,3}```/.test(line)) {
      if (!inFence) shape.fenceBlocks += 1;
      inFence = !inFence;
      previousWasTableRow = false;
      continue;
    }
    if (inFence) continue;
    const heading = /^ {0,3}(#{1,6})\s+\S/.exec(line);
    if (heading) {
      shape.headingDepth.push(heading[1].length);
      previousWasTableRow = false;
      continue;
    }
    const isTableRow = /^ {0,3}\|/.test(line);
    if (isTableRow) {
      shape.tableRows += 1;
      if (!previousWasTableRow) shape.tableCount += 1;
    }
    previousWasTableRow = isTableRow;
  }
  return shape;
}

describe('中英文档镜像结构门禁', () => {
  const paths = mirrorPaths();

  // 文件清单一致由 docs-i18n-mirror-links.test.ts 判；这里只在镜像缺失时给出
  // 一句能定位的断言，避免 ENOENT 顶掉真正的形状差异。
  it.each(paths)('docs/%s 与中文镜像同构', (path) => {
    expect(existsSync(join(ZH_ROOT, path)), `missing mirror docs/zh/${path}`).toBe(true);
    expect(readShape(ZH_ROOT, path)).toEqual(readShape(DOCS_ROOT, path));
  });
});

/**
 * 落地页正文是两份独立维护的 HTML（`Landing.vue` 按语言选 `landing-body.html`／
 * `landing-body.en.html`），不属于 VitePress locale 镜像，上面的路径清单覆盖不到它。
 * 两份文件唯一的差别应当是文字：DOM 元素序列、class 序列与 section id 序列逐项相同，
 * 否则一侧改版、另一侧悄悄掉块。链接只比 pathname —— 锚点片段按语言书写是 by-design。
 */
describe('落地页双语正文同构', () => {
  const THEME_ROOT = join(DOCS_ROOT, '.vitepress', 'theme');

  function elementSignature(text: string): string[] {
    return [...text.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/gu)].map(([, tag, attrs]) => {
      const className = /class="([^"]*)"/u.exec(attrs)?.[1]?.split(/\s+/u).sort().join(' ') ?? '';
      const id = /id="([^"]*)"/u.exec(attrs)?.[1] ?? '';
      return `${tag.toLowerCase()}|${className}|${id}`;
    });
  }

  function hrefPaths(text: string): string[] {
    return [...text.matchAll(/href="([^"]*)"/gu)]
      .map(([, href]) => href.split('#', 1)[0]!.replace(/^\/zh\//u, '/'))
      .sort();
  }

  function textLineCount(text: string): number {
    return text.split(/\r?\n/)
      .map((line) => line.replace(/<[^>]*>/gu, '').trim())
      .filter((line) => line.length > 0).length;
  }

  const chinese = readFileSync(join(THEME_ROOT, 'landing-body.html'), 'utf8');
  const english = readFileSync(join(THEME_ROOT, 'landing-body.en.html'), 'utf8');

  it('元素、class 与 id 序列逐项一致', () => {
    expect(elementSignature(english)).toEqual(elementSignature(chinese));
  });

  it('链接目标集合一致（锚点片段按语言书写，不参与比较）', () => {
    expect(hrefPaths(english)).toEqual(hrefPaths(chinese));
  });

  it('非空文本行数一致，一侧不会整段掉字', () => {
    expect(textLineCount(english)).toEqual(textLineCount(chinese));
  });

  it('舞台说明的中英文分支键集合相同', () => {
    const script = readFileSync(join(THEME_ROOT, 'landing-init.js'), 'utf8');
    const branches = /const caps = isZh \? \{([\s\S]*?)\} : \{([\s\S]*?)\};/u.exec(script);
    expect(branches, 'caps 的双语分支形状变了，门禁要跟上').not.toBeNull();
    const keys = (block: string) => [...block.matchAll(/^\s*(\w+):/gmu)].map(([, key]) => key).sort();
    expect(keys(branches![2]!)).toEqual(keys(branches![1]!));
  });
});

/**
 * 英文发布页的标题必须是英文：标题是读者扫目录时唯一必读的内容，中文标题就是翻译漏段。
 * 围栏内是原样引用的产物（评委 prompt 字节、命令输出等），那是内容不是标题，因此按
 * 围栏状态切段后再判。
 */
describe('英文文档标题不残留中文', () => {
  it.each(mirrorPaths())('docs/%s 的标题不含中日韩文字', (path) => {
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
    let inFence = false;
    const offenders: string[] = [];
    readFileSync(join(DOCS_ROOT, path), 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (/^ {0,3}```/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      if (/^ {0,3}#{1,6}\s+\S/.test(line) && cjk.test(line)) offenders.push(`${path}:${index + 1} ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});
