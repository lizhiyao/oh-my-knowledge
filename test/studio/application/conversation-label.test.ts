/**
 * 会话标题的展示层归一锁在唯一 owner 上（#903 第一优先项）。
 *
 * 这份实现原先是侧栏组件的私有函数，只服务一处，于是同一串标题在侧栏读成「Issue #375」，
 * 在轨迹页 H1 与泳道卡片却仍是 `[https://…](https://…)` 的原始 Markdown。这里锁归一口径本身，
 * 页面上是否真的用上由 `test/studio/web/observe-conversation-label.test.tsx` 负责。
 *
 * 只归一**摘要类**展示面；详情抽屉、完整请求 Popover、原始记录仍给原串，派生视图不覆盖原始证据。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { conversationLabel } from '../../../src/studio/application/display/conversation-label.js';

describe('标题归一', () => {
  it('把行内 Markdown 链接收成链接文字', () => {
    assert.equal(conversationLabel('[修复登录超时](https://example.com/a)'), '修复登录超时');
  });

  it('把 GitHub 议题与合并请求地址收成短标识', () => {
    assert.equal(conversationLabel('[https://github.com/o/r/issues/375](https://github.com/o/r/issues/375)'), 'Issue #375');
    assert.equal(conversationLabel('https://github.com/o/r/pull/944'), 'PR #944');
  });

  it('清掉加粗标记与实体空格，并裁掉首尾空白', () => {
    assert.equal(conversationLabel('  **先&#32;做&#x20;A**  '), '先 做 A');
  });

  it('没有 Markdown 时原样交出，不误伤普通标题', () => {
    assert.equal(conversationLabel('重构 Studio 阅读区 [2 份]'), '重构 Studio 阅读区 [2 份]');
  });

  it('对同一串重复归一结果不变，多个展示面各自调用也不会分叉', () => {
    const once = conversationLabel('[a](u) **b** https://github.com/o/r/issues/1');
    assert.equal(conversationLabel(once), once);
  });
});
