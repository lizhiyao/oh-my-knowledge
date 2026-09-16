/**
 * 轨迹页这一屏的两条展示口径（#903 第一优先项）。
 *
 * 一、标题归一：同一串来自宿主的 Markdown 标题，在侧栏、阅读区、轨迹页 H1 与泳道卡片必须读成
 * 同一句。归一规则本身由 `test/studio/application/conversation-label.test.ts` 的 owner 用例锁住，
 * 这里只钉「展示面确实调用了它」，以及「原文没有因此丢失」——卡片提示仍拿原串，完整请求 Popover
 * 同理，派生视图不覆盖原始证据。
 *
 * 二、工具报错的强调：它决定用户要不要点开这条，但报错次数不等于工作失败（免责文案自己就这么写），
 * 因此两页都用比同层正文深一档的墨色，不借用严重度红。属性侧由本文件钉，色值侧钉 CSS。
 */
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ObserveView } from '../../../src/studio/web/components/observe/observe.js';
import type { ObservePage } from '../../../src/studio/http/pages/observe-page.js';
import type { ReplayProjection } from '../../../src/studio/view-models/conversations/replay.js';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));

const css = readFileSync(new URL('../../../src/studio/web/app/studio.css', import.meta.url), 'utf8');
const rawTitle = '[https://github.com/example/repo/issues/375](https://github.com/example/repo/issues/375) 里报的登录超时';
const card = {
  id: 'card/1', operationId: 'op/1', lane: 'conversation', conversationRole: 'user', row: 0,
  position: 0, width: 200, compact: false, tone: 'conversation', kindLabel: '用户', model: '',
  title: rawTitle, detail: '', timestamp: '2026-09-16T00:00:00.000Z', facetIds: [],
};
const replay = {
  cards: [card], operations: [], facets: [], axisTicks: [], gaps: [], milestones: [],
  detailWidth: 900, startTimestamp: '2026-09-16T00:00:00.000Z', endTimestamp: '2026-09-16T00:10:00.000Z',
} as unknown as ReplayProjection;
const page = {
  pageKind: 'trajectory', threadId: 'thread/a', turnId: 'turn/1', revision: 'test', live: false,
  status: 'open', replay,
  model: {
    summary: {
      userGoal: rawTitle, observedStartTimestamp: '2026-09-16T00:00:00.000Z',
      observedModels: ['model-a'], toolCallCount: 3, toolFailureCount: 1,
    },
    integrity: { status: 'complete', notices: [] },
    knowledgeEvidence: [], normalizedEvents: [],
  },
} as unknown as ObservePage;
const html = renderToStaticMarkup(createElement(ObserveView, { page, lang: 'zh' }));

it('H1 与泳道卡片把同一串 Markdown 标题读成同一句', () => {
  expect(html).toContain('Issue #375 里报的登录超时');
  expect(html).not.toContain('>[https://');
  expect(html.match(/\[https:\/\/github/g)?.length).toBe(1);
});

it('归一不丢原文：卡片提示仍是未经改动的来源标题', () => {
  expect(html).toContain(`title="${rawTitle}"`);
});

it('工具报错计数落在自己的强调类上', () => {
  expect(html).toContain('<span class="observe-failure">1 次工具失败</span>');
});

it('两页的强调都是深一档墨色，不借用严重度红', () => {
  expect(css).toContain('.observe-detail-meta .observe-failure{color:#293348}');
  expect(css).toContain('.observe-session-meta .observe-session-error{color:#657085}');
  expect(css).not.toMatch(/\.observe-failure\{color:#b42318\}/);
});
