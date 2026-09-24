/**
 * 阅读区落地之后的状态文案（#903 第一项）。
 *
 * `ConversationReader` 的空状态与单轮退路只有在 fetch 落地后才会出现，整组件静态渲染永远停在
 * 「正在读取对话…」，因此这两段用户真正读到的文字与链接直接对拆出来的呈现组件断言。
 * 滚动位置不在这里覆盖：仓库没有 DOM 测试环境，jsdom 的 `scrollHeight` 恒为 0，
 * 该行为由 `test/studio/application/reader-viewport.test.ts` 的纯函数用例钉住。
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'vitest';
import { ReaderEmptyState, ReaderTurnBody, ReaderTurnHeader } from '../../../src/studio/web/components/observe/reader.js';
import type { ConversationReaderPage } from '../../../src/studio/view-models/conversations/conversation-reader.js';

type Turn = ConversationReaderPage['turns'][number];

const turn = (task: Partial<Turn['task']> = {}, extra: Partial<Turn> = {}): Turn => ({
  task: { turnId: 'turn/1', ...task } as Turn['task'],
  messages: [],
  unavailable: false,
  ...extra,
});
const body = (value: Turn, lang: 'zh' | 'en' = 'zh'): string =>
  renderToStaticMarkup(createElement(ReaderTurnBody, { turn: value, threadId: 'thread/a', lang }));

describe('空状态', () => {
  it('说明可能原因并给出重新读取，不只是说一句没有内容', () => {
    const html = renderToStaticMarkup(createElement(ReaderEmptyState, { lang: 'zh', onRetry() {} }));
    assert.match(html, /没有可读取的对话轮次。来源可能尚未写入，或记录已不可读。/);
    assert.match(html, />重新读取</);
  });

  it('英文给出同一句解释与同一个动作', () => {
    const html = renderToStaticMarkup(createElement(ReaderEmptyState, { lang: 'en', onRetry() {} }));
    assert.match(html, /No conversation turns available\. The source may not have been written yet, or its records are unreadable\./);
    assert.match(html, />Read again</);
  });
});

describe('单轮退路', () => {
  it('原始记录读不出来时说明只影响这一轮，并给出执行详情链接', () => {
    const html = body(turn({ sourceTurnId: 'src/9' }, { unavailable: true }));
    assert.match(html, /这一轮的原始记录读不出来，其余轮次仍可阅读。/);
    assert.match(html, />查看执行详情</);
    assert.match(html, /href="\/observe\/conversations\/thread%2Fa\/tasks\/src%2F9"/);
    assert.doesNotMatch(html, /没有对话消息/);
  });

  it('没有来源轮次时退回用本轮定位，深链不因为缺字段而指向别处', () => {
    assert.match(body(turn({}, { unavailable: true })), /href="\/observe\/conversations\/thread%2Fa\/tasks\/turn%2F1"/);
  });

  it('按角色渲染消息，外部文本保持转义', () => {
    const html = body(turn({}, { messages: [{ role: 'user', text: '<script>bad</script>' }, { role: 'assistant', text: 'fine' }] }));
    assert.match(html, /observe-reading-message human/);
    assert.match(html, /observe-reading-message assistant/);
    assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>bad/);
    assert.match(html, />你</);
    assert.match(html, />助手</);
  });

  it('有这一轮但没有消息时如实说明，不冒充记录不可读', () => {
    const html = body(turn());
    assert.match(html, /这一轮没有对话消息。/);
    assert.doesNotMatch(html, /原始记录读不出来/);
  });

  it('英文使用同一套退路文案', () => {
    assert.match(body(turn({}, { unavailable: true }), 'en'), /The raw record for this turn is unreadable\. Other turns remain readable\./);
    assert.match(body(turn({}, { messages: [] }), 'en'), /No conversation messages in this turn\./);
  });
});


describe('紧凑轮次信息', () => {
  const header = (timestamp?: string, previousTimestamp?: string, status = 'completed', lang: 'zh' | 'en' = 'zh') => renderToStaticMarkup(createElement(ReaderTurnHeader, {
    turn: turn({ startTimestamp: timestamp, status: status as Turn['task']['status'], sourceTurnId: 'source/1' }), previousTimestamp, threadId: 'thread/a', lang,
  }));
  it('同日同区仅显示时刻，完整时间保留在可访问标签与提示中', () => {
    const html = header('2026-09-18T06:40:35Z', '2026-09-18T06:39:32Z');
    assert.match(html, /dateTime="2026-09-18T06:40:35Z"/);
    assert.match(html, /aria-label="2026-09-18 06:40:35 UTC">06:40:35<\/time>/);
    assert.match(html, /href="\/observe\/conversations\/thread%2Fa\/tasks\/source%2F1"/);
    assert.match(html, />已完成<\/span>/);
  });
  it('首轮、跨日、时区变化和缺失时间不丢日期或冒充 UTC', () => {
    for (const previous of [undefined, '2026-09-17T06:39:32Z', '2026-09-18T06:39:32+08:00']) {
      assert.match(header('2026-09-18T06:40:35Z', previous), />2026-09-18 06:40:35 UTC<\/time>/);
    }
    assert.match(header(undefined), />—<\/time>/);
    assert.match(header('2026-09-18T06:40:35+08:00'), />2026-09-18 06:40:35\+08:00<\/time>/);
  });
  it('异常状态保留可见文字与执行入口，英文可读', () => {
    assert.match(header(undefined, undefined, 'failed'), /失败/);
    assert.match(header(undefined, undefined, 'interrupted'), /已中断/);
    const html = header(undefined, undefined, 'open', 'en');
    assert.match(html, /studio-running-status/);
    assert.match(html, /Execution details/);
  });
});


describe('对话 Markdown 展示', () => {
  it('渲染强调、链接、列表、代码和实体，并解析转义标点', () => {
    const html = body(turn({}, { messages: [{ role: 'assistant', text: '**已合并** [PR](https://example.com/pr) `main` &amp; &#x20;\n\n1. 第一步\n2. 第二步\n\n```ts\nconst x = "<tag>";\n```' }, { role: 'user', text: '\\#878 与 \\*字面星号\\*' }] }));
    assert.match(html, /<strong>已合并<\/strong>/);
    assert.match(html, /href="https:\/\/example.com\/pr"/);
    assert.match(html, /<code>main<\/code>/);
    assert.match(html, /<ol>/);
    assert.match(html, /<li>第一步<\/li>/);
    assert.match(html, /<pre tabindex="0"><code class="language-ts">/);
    assert.match(html, /&lt;tag&gt;/);
    assert.match(html, /#878 与 \*字面星号\*/);
    assert.doesNotMatch(html, /&amp;#x20;/);
  });
  it('原始 HTML 保持文本，危险链接不可点击，图片不自动发起加载', () => {
    const html = body(turn({}, { messages: [{ role: 'assistant', text: '<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![证据图](https://example.com/private.png)' }] }));
    assert.doesNotMatch(html, /<script>|href="javascript:|<img/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /href="https:\/\/example.com\/private.png"/);
    assert.match(html, /证据图/);
  });
  it('表格有独立可聚焦滚动区域，代码中的 Markdown 保持原样', () => {
    const html = body(turn({}, { messages: [{ role: 'assistant', text: '| 列 A | 列 B |\n| --- | --- |\n| 内容 | **重点** |\n\n`**literal**`' }] }));
    assert.match(html, /role="region" aria-label="对话中的表格"/);
    assert.match(html, /<th>列 A<\/th>/);
    assert.match(html, /<strong>重点<\/strong>/);
    assert.match(html, /<code>\*\*literal\*\*<\/code>/);
  });
});
