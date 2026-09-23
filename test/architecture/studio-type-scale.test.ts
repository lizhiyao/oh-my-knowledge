/**
 * Studio 排版尺度的防漂移门禁。
 *
 * 为什么钉这条：Issue #1060 之前，页级标题在 `studio.css` 里散成 8 条规则、四种字号
 * （22／20／18／17）外加两处窄屏降档（18→16、20→17），Agent 页还是 18px/26px。
 * 结果是同一个应用里「这一页的标题」有四种视觉重量，读者无法靠字号判断层级。
 * 收敛后统一为 20px/28px，本门禁保证它不再被单页特例重新拉开——加一条 `font-size:18px`
 * 的 h1 规则在 lint、tsc 和渲染断言里都不会有反应。
 *
 * 口径边界（刻意不查）：
 *  - 只查页级 h1。区段标题（h2、`measure-section h2` 18px）与统计数字（`health-stat-value`
 *    20px）是不同角色，规范没有把它们并进页标题尺度。
 *  - 不查字体族与字重：现状是系统字体栈，字重仍随组件，未收敛成规范。
 *  - 不查具体像素以外的排版（间距、圆角、断点），那几条尚未接入运行时。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const css = readFileSync(join(REPO_ROOT, 'src', 'studio', 'web', 'app', 'studio.css'), 'utf8');

/** 抽出所有命中 h1 的规则块（含媒体查询内的窄屏档）。 */
function h1Rules(source: string): string[] {
  return [...source.matchAll(/[^{}]*h1[^{}]*\{[^{}]*\}/g)].map((match) => match[0].trim());
}

describe('Studio 页级标题尺度', () => {
  it('每一条 h1 规则都取 20px/28px，不留单页特例', () => {
    const rules = h1Rules(css);
    expect(rules.length, '没读到任何 h1 规则，检查抽取方式').toBeGreaterThan(3);
    const offenders = rules.filter((rule) =>
      /font-size:(?!20px\b)[^;}]+/.test(rule) || (/line-height:/.test(rule) && !/line-height:28px/.test(rule)));
    expect(offenders, 'h1 字号或行高出现了非 20px/28px 的特例').toEqual([]);
  });

  it('对话阅读正文取 15px/27px', () => {
    const reader = css.match(/\.observe-reading-message\{[^}]*\}/);
    expect(reader, '找不到对话阅读正文规则').not.toBeNull();
    expect(reader![0]).toContain('font-size:15px');
    expect(reader![0]).toContain('line-height:27px');
  });
});
