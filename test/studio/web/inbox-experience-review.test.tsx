import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import { buildObservationInboxReport } from '../../../src/observability/inbox/index.js';
import type { ObservationReviewState } from '../../../src/observability/contracts/review.js';
import { ExperienceReviewSection } from '../../../src/studio/web/components/inbox/experience-review';

/**
 * 复盘卡片的渲染契约：深链、复盘优先级与未生效标注。
 * 用真实 trace fixture 投影出的 session，不手搓半个 summary。
 * 深链目标路由在宿主侧由 test/studio/http/next-inbox.test.ts 锁定为 200。
 */

const fixtureTrace = fileURLToPath(new URL('../../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url));

const emptyReviewState: ObservationReviewState = {
  kind: 'observe-review-state',
  schemaVersion: 2,
  updatedAt: '2026-09-12T00:00:00.000Z',
  entries: {},
};

function sessions() {
  return buildObservationInboxReport(fixtureTrace).experience!.sessions;
}

describe('经验复盘卡片渲染契约', () => {
  it('给出回到对话任务的深链，英文下保留语言参数', () => {
    const href = `/observe/conversations/${encodeURIComponent(sessions()[0].threadId)}`;

    const zh = renderToString(
      <ExperienceReviewSection sessions={sessions()} reviewState={emptyReviewState} lang="zh" />,
    );
    // reviewer 看到结论却回不到证据，等于这条复盘没有出口。
    assert.ok(zh.includes(`href="${href}"`), `复盘卡片必须深链到 ${href}`);
    assert.ok(zh.includes('查看对话任务'));
    assert.ok(zh.includes('建议优先复盘'));

    const en = renderToString(
      <ExperienceReviewSection sessions={sessions()} reviewState={emptyReviewState} lang="en" />,
    );
    assert.ok(en.includes(`href="${href}?lang=en"`), '英文页面的深链必须带上 lang 参数');
    assert.ok(en.includes('Conversation tasks'));
  });

  it('透出未生效的指标标注而不是静默忽略', () => {
    const [session] = sessions();
    const html = renderToString(
      <ExperienceReviewSection
        sessions={[session]}
        reviewState={emptyReviewState}
        unappliedMetricAnnotations={{ [session.id]: ['hard_rule'] }}
        lang="zh"
      />,
    );
    assert.ok(html.includes('标注未生效：hard_rule'));
    assert.ok(html.includes('已存指标未改变'));
  });
});
