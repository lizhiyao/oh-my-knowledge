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

  it("圆角只有控件与容器两档，且都走 token", () => {
    // 现状本来就是 6px（控件）与 8px（容器）两档，外加 50% 圆形品牌标记；
    // 这里不新增形状，只是把已有两档钉成变量，防止后来者随手写第三个圆角。
    expect(css).toContain("--studio-radius-control:6px");
    expect(css).toContain("--studio-radius-container:8px");
    const raw = [...css.matchAll(/border-radius:(?!var|50%)[^;}]+/g)].map((m) => m[0]);
    expect(raw, "出现了未走 token 的圆角").toEqual([]);
  });

  it('间距走 token：阶梯值不再以字面量出现在布局声明里', () => {
    // 规范 §3.2 的阶梯是 4/8/12/16/20/24/32。这条只钉「同一个值只有一个来源」，
    // 不钉「所有间距都必须在阶梯上」——现网仍有 97 条一次性值（0 14px、8px 7px 等），
    // 把它们归档会挪动整站元素（实测 2305/3290 个元素尺寸或位置变化、无溢出），
    // 属需要看观感的布局决定，不在这一条里偷偷做。
    for (const [n, px] of [['2', 4], ['3', 8], ['4', 12], ['5', 16], ['6', 20], ['7', 24], ['9', 32]] as const) {
      expect(css, `缺少 --studio-space-${n}（${px}px）`).toContain(`--studio-space-${n}:${px}px`);
    }
    const ladder = /\b(?:4|8|12|16|20|24|32)px\b/;
    const offenders = [...css.matchAll(/(padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?\s*:\s*([^;}]+)/g)]
      .filter(([, , value]) => !value.includes(':root') && ladder.test(value) && !/var\(--studio-space/.test(value))
      .map((m) => `${m[1]}:${m[2].trim()}`);
    expect(offenders, '这些布局声明仍把阶梯值写死').toEqual([]);
  });

  it('长表的数字列保持等宽', () => {
    // 数字列不等宽时，耗时与用量的位数对不齐，跨行比较要逐字看。这条在真实页面上量得到
    // （knowledge／measure 的表格单元格计算值为 tabular-nums），单元格不换行由同一条规则钉住。
    const cell = css.match(/\.ant-table-cell\{[^}]*\}/);
    expect(cell, '找不到表格单元格规则').not.toBeNull();
    expect(cell![0], '表格单元格未启用等宽数字').toContain('font-variant-numeric:tabular-nums');
    expect(cell![0], '表格单元格又允许换行').toContain('white-space:nowrap');
    // 吸顶表头刻意不钉在这条里：两次尝试（裸选择器与加 .ant-table 限定）都被 antd 自己的
    // position: relative 压过，计算值量不到效果；而现网能纵向滚动的表格要真跑一次
    // omk eval 才有数据可滚。补这条时走 antd 的 sticky 属性，并在能滚动的页面上验，
    // 不在样式里留一条没人能证实生效的规则。
    expect(css, '未生效的 sticky 规则又回到了样式里').not.toMatch(/ant-table-thead>tr>th\{[^}]*position:sticky/);
  });

  it('对话阅读正文取 15px/27px', () => {
    const reader = css.match(/\.observe-reading-message\{[^}]*\}/);
    expect(reader, '找不到对话阅读正文规则').not.toBeNull();
    expect(reader![0]).toContain('font-size:15px');
    expect(reader![0]).toContain('line-height:27px');
  });
});
