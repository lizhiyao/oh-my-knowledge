import { ExtractionQualityView } from '../../../src/studio/web/components/knowledge/extraction-quality.js';
import { ConversationExtractionConfirmation, ConversationExtractionPicker } from '../../../src/studio/web/components/knowledge/conversation-extraction.js';
import type { KnowledgeConversationPreview } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import { ExtractedKnowledge } from '../../../src/studio/web/components/observe/extracted-knowledge.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeCandidateStart, KnowledgeCandidates, ScopedCandidateEmpty } from '../../../src/studio/web/components/knowledge/candidates.js';
import type { KnowledgeCandidateRun } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import { KnowledgeInboxSummary } from '../../../src/studio/web/components/knowledge/inbox.js';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));
const latest: KnowledgeCandidateRun = { runId: 'fixture', schemaStatus: 'current', status: 'completed', bodies: [], phases: [], nextAction: 'none', archiveChecks: [], archiveVerification: 'not_verified' };
const render = (overrides = {}) => renderToStaticMarkup(createElement(KnowledgeCandidateStart, {
  lang: 'zh', loading: false, busy: false, onChoose() {}, onHistory() {}, onRetry() {}, ...overrides,
}));
describe('knowledge extraction onboarding', () => {
  it('explains the next action and keeps workspace paths out of the empty main page', () => {
    const html = renderToStaticMarkup(createElement(KnowledgeCandidates, { lang: 'zh', initialWorkspace: '/private/example' }));
    expect(html).toContain('从对话选择');
    expect(html).toContain('预览并提炼');
    expect(html).toContain('在这里选择对话和轮次');
    expect(html).toContain('核对并保留');
    expect(html).not.toContain('/private/example');
    expect(html).not.toContain('选择一条陈述查看依据');
  });
  it('distinguishes empty output, failure, unsupported history and unreadable records', () => {
    expect(render({ latest })).toContain('上次提炼完成，返回 0 条候选');
    expect(render({ latest: { ...latest, status: 'failed' } })).toContain('上次提炼：正文阶段失败');
    expect(render({ latest: { ...latest, schemaStatus: 'unsupported', status: 'unsupported', nextAction: 'unsupported' } })).toContain('旧格式运行');
    const unavailable = render({ latest: { ...latest, schemaStatus: 'unavailable', status: 'unavailable', nextAction: 'unavailable' } });
    expect(unavailable).toContain('提炼记录不可读'); expect(unavailable).toContain('无法确认结果及来源范围'); expect(unavailable).not.toContain('返回 0 条候选');
    expect(render({ latest: { ...latest, sourceMetadataStatus: 'frozen_input' } })).toContain('不表示来源当前可读');
    expect(render({ latest })).toContain('原始归档尚未完整核验');
    expect(render({ latest: { ...latest, archiveVerification: 'verified' } })).toContain('原始归档已完成完整性核验');
    expect(render({ latest, loading: true })).not.toContain('上次提炼完成');
    expect(render({ failedToLoad: true })).toContain('读取失败不表示没有候选');
    expect(render({ failedToLoad: true })).toContain('重新读取候选');
  });
  it('starts extraction in place instead of navigating to a selection page', () => {
    const html = renderToStaticMarkup(createElement(ExtractedKnowledge, { lang: 'zh', threadId: 'thread/a', turnId: 'turn&b' }));
    expect(html).toContain('提炼这轮');
    expect(html).not.toContain('已提炼知识');
    const header = renderToStaticMarkup(createElement(ExtractedKnowledge, { threadId: 'thread', lang: 'zh' }));
    expect(header).toContain('开启自动提炼'); expect(header).toContain('知识待办');
    expect(html).not.toContain('href=');
    expect(html).toContain('<button');
  });
  it('provides the same guidance in English', () => {
    const html = render({ lang: 'en', latest });
    expect(html).toContain('Choose a conversation');
    expect(html).toContain('Last extraction completed with 0 candidates');
    expect(html).toContain('Preview the content before confirming a model request.');
  });
  it('does not report an empty source scope until loading succeeds, and offers a retry after failure', () => {
    const scoped = (overrides = {}) => renderToStaticMarkup(createElement(ScopedCandidateEmpty, { lang: 'zh', loading: false, busy: false, failedToLoad: false, onRetry() {}, ...overrides }));
    const initial = renderToStaticMarkup(createElement(KnowledgeCandidates, { lang: 'zh', initialWorkspace: '/private/example', scope: { threadId: 'thread' } }));
    expect(initial).toContain('正在读取此来源范围的候选');
    expect(initial).not.toContain('此来源范围没有候选');
    expect(scoped({ failedToLoad: true })).toContain('重新读取候选');
    expect(scoped({ failedToLoad: true })).not.toContain('此来源范围没有候选');
    expect(scoped({ failedToLoad: true, busy: true })).toMatch(/<button[^>]+disabled/);
    expect(scoped()).toContain('此来源范围没有候选');
    expect(scoped({ failedToLoad: true, lang: 'en' })).toContain('Reload candidates');
    expect(scoped({ incompleteHistory: true })).toContain('当前候选清单可能不完整');
    expect(scoped({ incompleteHistory: true })).not.toContain('此来源范围没有候选');
    const summary = (overrides = {}) => renderToStaticMarkup(createElement(KnowledgeInboxSummary, { lang: 'zh', failedToLoad: false, ...overrides }));
    expect(summary()).toContain('正在读取候选数量');
    expect(summary()).not.toContain('共 0 条候选');
    expect(summary({ total: 7, failedToLoad: true })).toContain('候选数量暂不可读');
    expect(summary({ total: 7, failedToLoad: true })).not.toContain('共 7 条候选');
    expect(summary({ total: 0 })).toContain('共 0 条候选');
    expect(summary({ total: 3, lang: 'en' })).toContain('3 candidates grouped by source');
    const incompleteSummary = summary({ total: 0, incomplete: true });
    expect(incompleteSummary).toContain('数量暂无法确认'); expect(incompleteSummary).not.toContain('共 0 条候选');
    expect(summary({ total: 7, incomplete: true, lang: 'en' })).toContain('counts cannot be confirmed');
    expect(summary({ total: 7, incomplete: true, lang: 'en' })).not.toContain('7 candidates');
  });
});

const preview: KnowledgeConversationPreview = { origin: { threadId: 'thread/a', turnId: 'turn/1', title: '<script>对话</script>' }, sourceVersion: 'version', messages: [
  { evidenceRef: 'm1', recordIndex: 10, eventKind: 'message', role: 'user', text: '<script>原文</script>' },
  { evidenceRef: 'm2', recordIndex: 11, eventKind: 'message', role: 'assistant', text: '回复' },
] };
const confirm = (overrides = {}) => renderToStaticMarkup(createElement(ConversationExtractionConfirmation, {
  preview, turnId: 'turn/1', selected: [10, 11], workspace: '/example/knowledge', executor: 'codex', model: 'configured-model', adjust: false, lang: 'zh',
  onSelected() {}, onWorkspace() {}, onExecutor() {}, onModel() {}, onAdjust() {}, ...overrides,
}));
it('confirms the exact scope and model while optional message/configuration controls stay collapsed', () => {
  const html = confirm();
  expect(html).toContain('当前这一轮'); expect(html).toContain('已选 2 条消息'); expect(html).toContain('codex / configured-model');
  expect(html).toContain('将这些消息交给模型'); expect(html).toContain('查看／调整消息');
  expect(html).toContain('先保存完整知识正文，再关联实体');
  expect(html).not.toContain('<details class="conversation-extract-options" open');
  expect(html).toContain('&lt;script&gt;原文&lt;/script&gt;'); expect(html).not.toContain('<script>');
  expect(confirm({ selected: [] })).toContain('已选 0 条消息');
  expect(confirm({ turnId: undefined, lang: 'en' })).toContain('Entire conversation');
  expect(confirm({ model: '', adjust: true })).toContain('尚未设置');
  expect(confirm({ adjust: true })).toMatch(/<details[^>]+open=""/);
});
it('keeps conversation and turn selection on the knowledge page, with explicit empty-source guidance', () => {
  const html = renderToStaticMarkup(createElement(ConversationExtractionPicker, { conversations: [{ threadId: 't', title: '对话' }], conversationId: 't', loading: false, lang: 'zh',
    conversation: { threadId: 't', title: '对话', tasks: [{ turnId: 'turn', title: '这一轮' }] }, onConversation() {}, onScope() {},
  }));
  expect(html).toContain('选择来源对话'); expect(html).toContain('选择要提炼的一轮'); expect(html).toContain('确认后才发送给模型');
  expect(html).not.toContain('href=');
  const empty = renderToStaticMarkup(createElement(ConversationExtractionPicker, { conversations: [], conversationId: '', loading: false, lang: 'en', onConversation() {}, onScope() {} }));
  expect(empty).toContain('No local conversations available'); expect(empty).toContain('Import a log file from More');
});

it('keeps execution records distinct from quality and does not infer an empty workspace after failure', () => {
  const quality = { projectionKind: 'knowledge-body-admission' as const, schemaVersion: 1 as const, current: [], unsupported: [], unavailable: [], archiveChecks: [], semanticQuality: 'not_assessed' as const };
  const view = (failed: boolean) => renderToStaticMarkup(createElement(ExtractionQualityView, { quality, loading: false, failed, lang: 'zh', onRetry() {} }));
  expect(view(false)).toContain('不能据此判断知识是否准确、有用');
  expect(view(false)).toContain('暂无当前流程记录');
  expect(view(true)).toContain('记录暂不可读'); expect(view(true)).not.toContain('暂无当前流程记录');
  const incomplete = renderToStaticMarkup(createElement(ExtractionQualityView, { quality: { ...quality,
    current: [{ runId: 'fixture', status: 'completed', savedBodies: 1, phases: [] }],
    unavailable: [{ runId: 'broken', reason: 'unreadable', detail: 'Unreadable journal.' }],
    archiveChecks: [{ runId: 'fixture', invocationId: 'present', archiveStatus: 'present', verificationStatus: 'not_verified' },
      { runId: 'fixture', invocationId: 'missing', archiveStatus: 'missing', verificationStatus: 'not_verified' },
      { runId: 'fixture', invocationId: 'invalid', archiveStatus: 'invalid', verificationStatus: 'not_verified' },
      { runId: 'fixture', invocationId: 'not-recorded', archiveStatus: 'not_recorded', verificationStatus: 'not_verified' },
      { runId: 'fixture', invocationId: 'unknown', archiveStatus: 'unknown', verificationStatus: 'not_verified' }],
  }, loading: false, failed: false, lang: 'zh', onRetry() {} }));
  for (const text of ['当前统计可能不完整', '原始归档尚未完整核验', '文件存在，内容未核验', '归档缺失', '归档文件元数据不匹配', '尚无归档引用', '归档状态未知']) expect(incomplete).toContain(text);
});
