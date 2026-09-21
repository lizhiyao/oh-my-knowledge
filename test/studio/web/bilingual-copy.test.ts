/**
 * Studio 双语完整性门禁：走语言分支的英文侧不得留下未翻的中文。
 *
 * Studio 没有 i18n 框架，文案是组件里的 `zh ? '中文' : 'English'`（实测 417 处语言分支，
 * 其中 350 处两侧都是字面量）。这类写法最容易出的事故不是「没接上语言」，而是**只写了
 * 中文那一侧**：英文分支留成中文或空着，页面切了语言却还是中文，CI 与编译器都不判。
 *
 * 判据只取零假阳性的那一条：英文分支含汉字即违规。刻意不判「中文分支必须含汉字」——
 * 实测那些都是分隔符（、／：）、语言码（`zh-CN`）、品牌复数（Agent／Agents）与同名文件
 * （SKILL.md），把它们也算违规只会逼出豁免名单。
 *
 * 唯一豁免是语言自称：`zh ? '英文' : '中文'` 这类切换控件按「每种语言用自己的文字自称」
 * 呈现（与 `中文`／`English` 选项标签同一口径，见 docs/specs/terminology-spec.md §4），
 * 因此英文侧出现「中文」这两个字是设计而非漏翻。豁免按整对字面量精确匹配，不做模糊判断。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve('src/studio');
const HAN = /[\u4e00-\u9fff]/u;
const SELF_REFERENTIAL_LANGUAGE_NAMES = new Set(['中文', '英文', '简体中文']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '.next') sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function isLanguageConditional(node: ts.ConditionalExpression, source: ts.SourceFile): boolean {
  return /\blang\b|===\s*['"]zh['"]|^\s*zh\s*$/u.test(node.condition.getText(source));
}

function englishBranchLeaksChinese(whenTrue: ts.Node, whenFalse: ts.Node): boolean {
  if (!(ts.isStringLiteral(whenTrue) || ts.isNoSubstitutionTemplateLiteral(whenTrue))) return false;
  if (!(ts.isStringLiteral(whenFalse) || ts.isNoSubstitutionTemplateLiteral(whenFalse))) return false;
  const chinese = (whenTrue as ts.StringLiteral).text;
  const english = (whenFalse as ts.StringLiteral).text;
  if (!HAN.test(chinese) || !HAN.test(english)) return false;
  // 两侧都是语言自称词（如 英文／中文）时按 by-design 放行。
  return !(SELF_REFERENTIAL_LANGUAGE_NAMES.has(chinese) && SELF_REFERENTIAL_LANGUAGE_NAMES.has(english));
}

function collectViolations(files: string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(
      file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isConditionalExpression(node) && isLanguageConditional(node, source)
        && englishBranchLeaksChinese(node.whenTrue, node.whenFalse)) {
        const text = (node.whenFalse as ts.StringLiteral).text;
        violations.push(`${file}: 英文分支仍是中文 —— ${text.slice(0, 60)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

function conditionalCount(files: string[]): number {
  let total = 0;
  for (const file of files) {
    const source = ts.createSourceFile(
      file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isConditionalExpression(node) && isLanguageConditional(node, source)) total += 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return total;
}

/** 用一段最小源码验证判据本身，避免门禁只在真实文件上「碰巧全绿」。 */
function snippetLeaksChinese(body: string): boolean {
  const source = ts.createSourceFile(
    'probe.tsx', `declare const lang: 'zh' | 'en'; const f = (${body}); export default f;`,
    ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isConditionalExpression(node) && isLanguageConditional(node, source)
      && englishBranchLeaksChinese(node.whenTrue, node.whenFalse)) hits.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits.length > 0;
}

describe('Studio 英文分支不残留中文', () => {
  const files = sourceFiles(ROOT);

  it('真实源码里零泄漏', () => {
    expect(collectViolations(files)).toEqual([]);
  });

  it('判据确实在扫语言分支，不是空跑', () => {
    expect(conditionalCount(files)).toBeGreaterThan(200);
  });

  it.each([
    // 只写了中文侧：切到英文仍是中文，必须判红。
    ["lang => lang === 'zh' ? '保存草稿' : '保存草稿'", true],
    // 英文侧混进未翻的术语，也要判红。
    ["lang => lang === 'zh' ? '候选版本' : 'candidate 版本'", true],
    // 两侧同文字但不是中文（品牌名）与语言自称，都不算漏翻。
    ["lang => lang === 'zh' ? 'SKILL.md' : 'SKILL.md'", false],
    ["lang => lang === 'zh' ? '英文' : '中文'", false],
    // 非字面量分支（取值来自表）不在本门禁判据内。
    ["lang => lang === 'zh' ? labels[a] : labels[b]", false],
  ])('判据对 %s 的结果是 %s', (body, expected) => {
    expect(snippetLeaksChinese(body)).toBe(expected);
  });
});
