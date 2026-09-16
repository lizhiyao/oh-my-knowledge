/**
 * 观测收件箱的面板由地址决定（#903 D3）。
 *
 * 收件箱外壳有七个面板，切换要能分享、能刷新回来，所以初始面板来自路由页校验过的 `?tab=`。
 * 这里钉两件事：高亮的是 `initialTab`，以及**渲染出来的内容**也跟着换——只看高亮会放过
 * 「状态写对了、面板却仍按默认值渲染」这一类缺陷。antd 在服务端渲染里只输出当前面板的内容，
 * 所以「别的面板的文字不在输出里」是可得的事实，不是额外要求的实现细节。
 */

import { createElement } from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, expect, it } from 'vitest';
import { buildObservationInboxViewModel } from '../../../src/observability/inbox/view-model.js';
import { DEFAULT_OBSERVE_INBOX_TAB, type ObserveInboxTab } from '../../../src/studio/http/page-params.js';
import { InboxView } from '../../../src/studio/web/components/observe/inbox/inbox.js';
import { activeTabKey } from '../../helpers/react-ssr.js';

const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-tabs-'));
const model = buildObservationInboxViewModel(dir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function render(initialTab: ObserveInboxTab): string {
  return renderToStaticMarkup(createElement(InboxView, { model, lang: 'zh', initialTab }));
}

it('地址里的面板既是高亮的那个，也是渲染出来的那个', () => {
  const metrics = render('metrics');
  expect(activeTabKey(metrics)).toBe('metrics');
  expect(metrics).toContain('这些指标只解释');

  const timeline = render('timeline');
  expect(activeTabKey(timeline)).toBe('timeline');
  expect(timeline).not.toContain('这些指标只解释');

  // 收件箱的默认面板是产品决定：`initialTab` 是必填属性，组件没有兜底分支可测，所以只钉常量本身。
  // 轨迹页那条兜底（`?? DEFAULT_TRAJECTORY_TAB`）由 observe-trajectory-page.test.tsx 按渲染钉。
  expect(DEFAULT_OBSERVE_INBOX_TAB).toBe('signals');
});
