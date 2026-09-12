/**
 * 架构边界守门：Studio React 渲染层的两条不变量。
 *
 * 1. 不得引入原始 HTML 逃生口。收件箱从 HTML 字符串拼接迁到 React（#839）后，
 *    手工 e()/jsString 转义随之消失，转义安全只剩「JSX 文本节点默认转义」这一条屏障。
 * 2. 必须渲染复核派生后的有效投影。直接渲染原始 `experienceReports` 会丢掉已提交的
 *    复核结论与指标标注，页面看起来正常但口径错了。
 *
 * 两条都覆盖 src/studio/web 全部页面（不只收件箱），后续新增页面自动纳入。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB_DIR = join(REPO_ROOT, 'src', 'studio', 'web');
const SKIPPED_DIRS = new Set(['.next', 'node_modules']);

/** 这些 API 让字符串直接进入 DOM 结构或代码求值，JSX 转义对它们无效。 */
const RAW_HTML_ESCAPES = [
  'dangerouslySetInnerHTML',
  '.innerHTML',
  'insertAdjacentHTML',
  '.outerHTML',
  'document.write',
  'new Function(',
  'eval(',
] as const;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listSourceFiles(path, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(path);
  }
  return out;
}

describe('Studio React 渲染层守门', () => {
  it('src/studio/web 不使用 raw HTML 注入 API', () => {
    const files = listSourceFiles(WEB_DIR);
    // 扫描为空会让这条断言变成假绿：React 页面必须真实在场。
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith('components/inbox/inbox.tsx'))).toBe(true);

    const violations = files.flatMap((file) => {
      const source = readFileSync(file, 'utf-8');
      return RAW_HTML_ESCAPES
        .filter((escape) => source.includes(escape))
        .map((escape) => `${relative(REPO_ROOT, file)}::${escape}`);
    });

    expect(violations).toEqual([]);
  });

  it('src/studio/web 渲染有效复核投影而不是原始 experienceReports', () => {
    const files = listSourceFiles(WEB_DIR);
    const inboxPage = files.find((file) => file.endsWith('components/inbox/inbox.tsx'));
    expect(inboxPage, '收件箱页面必须在场，否则这条守门是假绿').toBeTruthy();
    // effectiveExperienceReports 里的 E 是大写，不会命中这个子串。
    expect(readFileSync(inboxPage!, 'utf-8').includes('effectiveExperienceReports')).toBe(true);

    const violations = files
      .filter((file) => readFileSync(file, 'utf-8').includes('experienceReports'))
      .map((file) => relative(REPO_ROOT, file));

    expect(violations).toEqual([]);
  });
});
