/**
 * 评测运行报告深链的单一 owner（#902 §五 同类项）。
 *
 * 编码钉一次：两处手拼时最容易分叉的就是「一处 encodeURIComponent、一处直接拼」。
 * 语言不进地址：渲染语言只看本机设置，链接一律不带 `lang`。
 */
import { expect, it } from 'vitest';
import { runReportHref } from '../../../src/studio/web/components/run-report-link.js';

it('整体编码 runId，带路径字符的运行 ID 也能落到单段地址', () => {
  expect(runReportHref('run/a b')).toBe('/measure/run%2Fa%20b');
});

it('地址不含语言参数，语言由本机设置决定', () => {
  expect(runReportHref('core-run-1')).toBe('/measure/core-run-1');
});
