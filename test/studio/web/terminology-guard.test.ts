/**
 * 界面用词门禁：钉住 `docs/zh/specs/terminology-spec.md` §三.8 与 §三.9 的口径。
 *
 * 只扫 `src/studio/web` 下源码里的**中文字符串字面量**（走 TypeScript AST，注释天然不参与）：
 *  1. 不得出现「知识对象」——它分不清知识内容与知识载体两层，规范已登记为被拒别名。
 *  2. 含「会话」的中文文案必须同时带「来源」限定。规则是「同一所指必须同名」，不是「同屏只许一个词」：
 *     指宿主落盘的原始记录时「来源会话」正是正确用词（Agents 的来源统计、健康度来源列、收件箱时间轴选择器），
 *     被禁的是**未限定的**「会话」，不是「会话」二字。
 *
 * 只管中文：英文侧 `conversation` 与 `session` 本就是两个词，分层不存在歧义，且 ASCII 串里混着 CSS 类名与
 * `--session` 这类真实参数名，按字面量禁用会误伤。范围也只含 Studio：CLI 与观测内核的「会话」指宿主记录，
 * 也没有双语界面。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve('src/studio/web');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const FORBIDDEN_CONTENT_TERM = '知识对象';

/** 判定一条界面字面量是否违例；返回规则名，未违例返回 null。 */
function rejectedLiteral(text: string): string | null {
  if (text.includes(FORBIDDEN_CONTENT_TERM)) return '被拒别名「知识对象」';
  if (text.includes('会话') && !text.includes('来源')) return '中文「会话」未限定为「来源会话」';
  return null;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

/** 一条字面量的文本：普通字符串、无替换模板串、模板串的固定片段。 */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let all = node.head.text;
    for (const span of node.templateSpans) all += span.literal.text;
    return all;
  }
  return null;
}

interface Found { text: string; file: string }

function literals(): Found[] {
  return sourceFiles(ROOT).flatMap((path) => {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ESNext, true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const found: Found[] = [];
    const visit = (node: ts.Node): void => {
      const value = literalText(node);
      if (value !== null) found.push({ text: value, file: relative(process.cwd(), path) });
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return found;
  });
}

describe('Studio 界面用词门禁（terminology-spec §三.8／§三.9）', () => {
  it('界面中文文案不出现被拒别名，且「会话」都带来源限定', () => {
    const violations = literals()
      .filter(({ text }) => rejectedLiteral(text) !== null)
      .map(({ text, file }) => `${rejectedLiteral(text)} — ${file}: ${text.slice(0, 50)}`);
    expect(violations).toEqual([]);
  });

  it('判据正反两侧都有牙，且扫描确实覆盖界面文案', () => {
    // 正例：带限定的来源层用词必须放过——否则下一次改名会把正确文案改坏。
    for (const ok of ['来源会话：', '选择来源会话', '暂无来源会话的复盘记录。', '采集 N 份来源会话']) {
      expect(rejectedLiteral(ok), ok).toBeNull();
    }
    // 反例：未限定用词与被拒别名必须被抓到。
    for (const bad of ['会话列表', '这个会话的提炼记录', '知识对象', '搜索知识对象']) {
      expect(rejectedLiteral(bad), bad).not.toBeNull();
    }
    // 覆盖性：扫描器不是空转在极少数字面量上，且英文串与 CSS 类名不参与中文判定。
    const collected = literals();
    expect(collected.length).toBeGreaterThan(500);
    expect(rejectedLiteral('observe-session-list')).toBeNull();
    expect(rejectedLiteral('omk agents extract --session <runId>')).toBeNull();
  });
});
