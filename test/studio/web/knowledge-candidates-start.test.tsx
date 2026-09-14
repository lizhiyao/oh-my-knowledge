import { ExtractedKnowledge } from '../../../src/studio/web/components/observe/extracted-knowledge.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KnowledgeCandidateStart, KnowledgeCandidates } from '../../../src/studio/web/components/knowledge/candidates.js';
import type { KnowledgeCandidateRun } from '../../../src/studio/view-models/knowledge-candidates.js';
const latest: KnowledgeCandidateRun = { runId: 'fixture', status: 'completed', committed: [], rejections: [] };
const render = (overrides = {}) => renderToStaticMarkup(createElement(KnowledgeCandidateStart, {
  lang: 'zh', hasWorkspace: true, loading: false, busy: false, onChoose() {}, onHistory() {}, ...overrides,
}));
describe('knowledge extraction onboarding', () => {
  it('explains the next action and keeps workspace paths out of the empty main page', () => {
    const html = renderToStaticMarkup(createElement(KnowledgeCandidates, { lang: 'zh', initialWorkspace: '/private/example' }));
    expect(html).toContain('从会话选择');
    expect(html).toContain('预览并提炼');
    expect(html).toContain('核对并保留');
    expect(html).not.toContain('/private/example');
    expect(html).not.toContain('选择一条陈述查看依据');
  });
  it('distinguishes zero candidates, rejected output, failure, loading, and a fresh workspace', () => {
    expect(render({ latest })).toContain('上次提炼完成，返回 0 条候选');
    expect(render({ latest })).not.toContain('还没有提炼记录');
    expect(render({ latest: { ...latest, rejections: [{ index: 0, reasons: ['quote_mismatch'] }] } })).toContain('未通过引用或格式校验');
    expect(render({ latest: { ...latest, status: 'failed' } })).toContain('上次提炼：提炼失败');
    expect(render({ latest, loading: true })).not.toContain('上次提炼完成');
    expect(render({ failedToLoad: true })).toContain('暂时无法读取已有记录');
    expect(render()).toContain('还没有提炼记录');
    expect(render({ hasWorkspace: false })).toContain('设置保存位置并开始');
  });
  it('starts extraction in place instead of navigating to a selection page', () => {
    const html = renderToStaticMarkup(createElement(ExtractedKnowledge, { lang: 'zh', threadId: 'thread/a', turnId: 'turn&b' }));
    expect(html).toContain('提炼知识');
    expect(html).toContain('已提炼知识');
    expect(html).not.toContain('href=');
    expect(html).toContain('<button');
  });
  it('provides the same guidance in English', () => {
    const html = render({ lang: 'en', latest });
    expect(html).toContain('Choose a conversation');
    expect(html).toContain('Last extraction completed with 0 candidates');
    expect(html).toContain('Preview the content before confirming a model request.');
  });
});
