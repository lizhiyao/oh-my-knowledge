/**
 * `?tab=` 的读侧口径（#903 D3）。
 *
 * owner 的键集合与组件是否一致由 `test/architecture/studio-page-params.test.ts` 钉；这里只钉
 * 「地址里的一个值怎么变成页面状态」这一条降级规则：认识的取值才认，其余一律回默认面板。
 * 停在哪个面板不改变装载的数据，所以一个陌生取值没有值得拒绝的语义，回默认而不是 400。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OBSERVE_INBOX_TAB,
  DEFAULT_TRAJECTORY_TAB,
  OBSERVE_INBOX_TABS,
  parseTab,
  TAB_PARAM,
  TRAJECTORY_TABS,
} from '../../../src/studio/http/page-params.js';

describe('parseTab', () => {
  it('认识的取值原样认，两个页面的键各自独立', () => {
    expect(parseTab('source', TRAJECTORY_TABS, DEFAULT_TRAJECTORY_TAB)).toBe('source');
    expect(parseTab('skill-board', OBSERVE_INBOX_TABS, DEFAULT_OBSERVE_INBOX_TAB)).toBe('skill-board');
    // 同一批词在另一页未必合法：收件箱没有 replay，轨迹页没有 chains。
    expect(parseTab('chains', TRAJECTORY_TABS, DEFAULT_TRAJECTORY_TAB)).toBe(DEFAULT_TRAJECTORY_TAB);
    expect(parseTab('replay', OBSERVE_INBOX_TABS, DEFAULT_OBSERVE_INBOX_TAB)).toBe(DEFAULT_OBSERVE_INBOX_TAB);
  });

  it('不认识的取值回默认面板，不报错也不改写', () => {
    for (const raw of [undefined, '', 'Replay', 'replay ', 'constructor', '__proto__']) {
      expect(parseTab(raw, TRAJECTORY_TABS, DEFAULT_TRAJECTORY_TAB)).toBe(DEFAULT_TRAJECTORY_TAB);
    }
  });

  it('默认面板是自己的键集合成员，参数名固定为 tab', () => {
    expect(TRAJECTORY_TABS).toContain(DEFAULT_TRAJECTORY_TAB);
    expect(OBSERVE_INBOX_TABS).toContain(DEFAULT_OBSERVE_INBOX_TAB);
    expect(TAB_PARAM).toBe('tab');
  });
});
