import { ConversationExtractionConfirmation, ConversationExtractionPicker } from '../../../src/studio/web/components/knowledge/conversation-extraction.js';
import type { KnowledgeConversationPreview } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import { ExtractedKnowledge } from '../../../src/studio/web/components/observe/extracted-knowledge.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeCandidateStart, KnowledgeCandidates } from '../../../src/studio/web/components/knowledge/candidates.js';
import type { KnowledgeCandidateRun } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));
const latest: KnowledgeCandidateRun = { runId: 'fixture', status: 'completed', committed: [], rejections: [] };
const render = (overrides = {}) => renderToStaticMarkup(createElement(KnowledgeCandidateStart, {
  lang: 'zh', loading: false, busy: false, onChoose() {}, onHistory() {}, ...overrides,
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
  it('distinguishes zero candidates, rejected output, failure, loading, and a fresh workspace', () => {
    expect(render({ latest })).toContain('上次提炼完成，返回 0 条候选');
    expect(render({ latest })).not.toContain('还没有提炼记录');
    expect(render({ latest: { ...latest, rejections: [{ index: 0, reasons: ['quote_mismatch'] }] } })).toContain('未通过引用或格式校验');
    expect(render({ latest: { ...latest, status: 'failed' } })).toContain('上次提炼：提炼失败');
    expect(render({ latest, loading: true })).not.toContain('上次提炼完成');
    expect(render({ failedToLoad: true })).toContain('暂时无法读取已有记录');
    expect(render()).toContain('还没有提炼记录');
    expect(render()).not.toContain('设置保存位置并开始');
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
