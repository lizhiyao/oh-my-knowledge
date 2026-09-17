/**
 * 面板切换写地址的口径（#903 D3）。
 *
 * 两条要紧的：一是浅写必须保留地址里已有的东西（`doctorRun` 这类下钻参数、`skill` 这类筛选参数
 * 都不能丢），二是默认面板不占参数，否则「参数缺席」和「参数写着默认值」会变成两种渲染等价、
 * 分享出去却看起来不一样的地址。
 */

import { afterEach, expect, it, vi } from 'vitest';
import { mirrorTabToUrl } from '../../../src/studio/web/components/tab-url.js';
import { DEFAULT_OBSERVE_INBOX_TAB, DEFAULT_TRAJECTORY_TAB, TAB_PARAM } from '../../../src/studio/http/page-params.js';

/** 用假 window 接住 replaceState，返回真正落到地址栏里的那条地址。 */
function write(href: string, tab: string, defaultTab: string): URL {
  const written: unknown[] = [];
  vi.stubGlobal('window', {
    location: { href },
    history: { replaceState: (...args: unknown[]) => written.push(args[2]) },
  });
  mirrorTabToUrl(tab, defaultTab);
  expect(written).toHaveLength(1);
  return new URL(String(written[0]));
}

afterEach(() => vi.unstubAllGlobals());

it('换面板是覆盖同一个参数，路径与其余 query 原样保留', () => {
  const url = write('http://127.0.0.1:7799/observe/conversations/a/tasks/b?tab=replay&doctorRun=run%2F1', 'source', DEFAULT_TRAJECTORY_TAB);
  expect(url.pathname).toBe('/observe/conversations/a/tasks/b');
  expect(url.searchParams.getAll(TAB_PARAM)).toEqual(['source']);
  expect(url.searchParams.get('doctorRun')).toBe('run/1');
});

it('默认面板不占参数：已有值被删掉，而不是留着或写两遍', () => {
  const url = write('http://127.0.0.1:7799/observe/inbox?skill=demo&tab=metrics', DEFAULT_OBSERVE_INBOX_TAB, DEFAULT_OBSERVE_INBOX_TAB);
  expect(url.searchParams.getAll(TAB_PARAM)).toEqual([]);
  expect(url.searchParams.get('skill')).toBe('demo');
});
