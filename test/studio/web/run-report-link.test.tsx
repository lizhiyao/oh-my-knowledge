/**
 * 评测运行报告深链的单一 owner（#902 §五 同类项）。
 *
 * 编码与显式 `lang` 两条各钉一次：两处手拼时最容易分叉的就是「一处 encodeURIComponent、
 * 一处直接拼」，以及英文页面漏掉 `?lang=` 后被宿主 302 改写。
 *
 * 文件名以 `.tsx` 结尾是约束而不是风格：根 tsconfig 的 `include` 在 `test` 目录只收 `.ts` 后缀，写成
 * `.ts` 会把这个用例连同它 import 的 `src/studio/web` 子树拽进 Node16 编译程序，在 `layout/shell.tsx`
 * 上撞 `--jsx` 未开启；`.tsx` 让根程序整体跳过它，交给 Next 的编译链。
 */
import { expect, it } from 'vitest';
import { runReportHref } from '../../../src/studio/web/components/run-report-link.js';

it('逐段编码 runId，带路径字符的运行 ID 也能打开', () => {
  expect(runReportHref('run/a b', 'zh')).toBe('/measure/run%2Fa%20b?lang=zh');
});

it('两种语言都显式带 lang，不给 302 改写留口子', () => {
  expect(runReportHref('core-run-1', 'zh')).toBe('/measure/core-run-1?lang=zh');
  expect(runReportHref('core-run-1', 'en')).toBe('/measure/core-run-1?lang=en');
});
