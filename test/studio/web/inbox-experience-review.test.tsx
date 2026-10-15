import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, it } from 'vitest';
import { buildObservationInboxReport } from '../../../src/observability/inbox/index.js';
import type { ObservationReviewState } from '../../../src/observability/contracts/review.js';
import { buildObservationInboxViewModel } from '../../../src/observability/inbox/view-model.js';
import { InboxView } from '../../../src/studio/web/components/observe/inbox/inbox';
import { ExperienceReviewSection } from '../../../src/studio/web/components/observe/inbox/experience-review';

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
  it('两种语言都深链回对话任务，语言不进入地址', () => {
    const href = `/observe/conversations/${encodeURIComponent(sessions()[0].threadId)}`;

    const zh = renderToString(
      <ExperienceReviewSection sessions={sessions()} reviewState={emptyReviewState} lang="zh" />,
    );
    // reviewer 看到结论却回不到证据，等于这条复盘没有出口。
    // 语言由本机设置决定，链接只承载证据地址。
    assert.ok(zh.includes(`href="${href}"`), `复盘卡片必须深链到 ${href}`);
    assert.ok(zh.includes('查看对话任务'));
    assert.ok(zh.includes('建议优先复盘'));

    const en = renderToString(
      <ExperienceReviewSection sessions={sessions()} reviewState={emptyReviewState} lang="en" />,
    );
    assert.ok(en.includes(`href="${href}"`), '英文页面的深链一致，语言不进地址');
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

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it.each(['experience', 'timeline'] as const)('收件箱 %s 面板实际渲染有效复核投影，原始报告不覆盖已复核事实', tab => {
  const directory = mkdtempSync(join(tmpdir(), 'omk-inbox-effective-render-'));
  directories.push(directory);
  const report = buildObservationInboxReport(fixtureTrace).experience!;
  const session = report.sessions[0];
  const effectiveSession = {
    ...session,
    skillName: 'reviewed-skill-marker',
    sessionStory: { ...session.sessionStory!, summary: '已复核摘要 marker' },
    timelinePreview: [{ ...session.timelinePreview[0], label: '已复核事件 marker' }],
  };
  const rawSession = { ...session, skillName: 'raw-skill-marker' };
  const model = {
    ...buildObservationInboxViewModel(directory),
    experienceReports: [{ ...report, sessions: [rawSession] }],
    effectiveExperienceReports: [{ ...report, sessions: [effectiveSession] }],
  };
  for (const lang of ['zh', 'en'] as const) {
    const html = renderToString(<InboxView model={model} lang={lang} initialTab={tab}/>);
    assert.ok(html.includes('reviewed-skill-marker'), '有效投影必须到达实际面板');
    assert.ok(!html.includes('raw-skill-marker'), '原始报告不能覆盖复核后的显示事实');
    assert.ok(html.includes(tab === 'experience' ? '已复核摘要 marker' : '已复核事件 marker'));
  }
});
