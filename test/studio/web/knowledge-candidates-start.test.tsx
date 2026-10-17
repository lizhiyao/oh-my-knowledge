import { ExtractionQualityView } from '../../../src/studio/web/components/knowledge/extraction-quality.js';
import { extractionQuality } from '../../../src/observability/knowledge-extraction/extraction/quality.js';
import { ConversationExtractionConfirmation, ConversationExtractionPicker } from '../../../src/studio/web/components/knowledge/conversation-extraction.js';
import type { KnowledgeConversationPreview } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import { ExtractedKnowledge } from '../../../src/studio/web/components/observe/extracted-knowledge.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeCandidateStart, KnowledgeCandidates, ScopedCandidateEmpty } from '../../../src/studio/web/components/knowledge/candidates.js';
import type { KnowledgeCandidateRun } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import { KnowledgeInboxSummary } from '../../../src/studio/web/components/knowledge/inbox.js';
import { GenerationPolicyFields } from '../../../src/studio/web/components/knowledge/generation-policy-fields.js';
import type { ExtractionBoundedPolicy } from '../../../src/observability/knowledge-extraction/extraction/generation-policy.js';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));
const latest: KnowledgeCandidateRun = { runId: 'fixture', status: 'completed', committed: [], rejections: [],
  invocation: { policyId: 'knowledge-generation-single/v1', outputMode: 'json-schema', wireId: `sha256:${'a'.repeat(64)}`,
    attemptCount: 1, archiveStatus: 'recorded', failureKind: null, limits: { maxInvocations: 1, maxReasks: 0 },
    budget: { reservedTokens: 0, observedTokens: null, unknownAttempts: 1 } } };
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
  it('distinguishes zero candidates, rejected output, failure, loading, and a fresh workspace', () => {
    expect(render({ latest })).toContain('上次提炼完成，返回 0 条候选');
    expect(render({ latest })).not.toContain('尚无当前 v5 提炼记录');
    expect(render({ latest })).toContain('结果证据归档：已记录');
    expect(render({ latest })).toContain('knowledge-generation-single/v1');
    expect(render({ latest })).toContain('json-schema'); expect(render({ latest })).toContain(latest.invocation.wireId!);
    expect(render({ latest })).toContain('本运行限 1 次 OMK 调用；不自动重试或 fallback');
    expect(render({ latest })).toContain('未启用预约核算；原生用量见运行详情'); expect(render({ latest })).not.toContain('用量未知调用');
    const bounded = render({ latest: { ...latest, invocation: { ...latest.invocation, policyId: 'knowledge-generation-bounded/v1', attemptCount: 2,
      limits: { maxInvocations: 3, maxReasks: 2 }, budget: { reservedTokens: 2108192, maxTotalTokens: 3162288, observedTokens: 1200, unknownAttempts: 0 } } } });
    expect(bounded).toContain('本运行最多 3 次 OMK 调用，含最多 2 次校验重问'); expect(bounded).toContain('已记录 OMK 调用尝试：2');
    expect(bounded).toContain('token 预约已用 2108192／总额 3162288'); expect(bounded).toContain('观测 token 用量：1200');
    expect(render({ latest })).toContain('归档不代表内容已通过接纳或质量验证');
    expect(render({ latest: { ...latest, rejections: [{ index: 0, reasons: ['quote_mismatch'] }] } })).toContain('未通过引用或格式校验');
    expect(render({ latest: { ...latest, status: 'failed' } })).toContain('上次提炼：提炼失败');
    const pending = render({ latest: { ...latest, status: 'failed', invocation: { ...latest.invocation, archiveStatus: 'pending', failureKind: '<unsafe>' } } });
    expect(pending).toContain('结果证据归档：待归档'); expect(pending).not.toContain('结果证据归档：已记录');
    expect(pending).toContain('待归档不能证明请求未发送或费用为零'); expect(pending).toContain('恢复不会再次调用模型');
    expect(pending).toContain('失败类别：&lt;unsafe&gt;'); expect(pending).not.toContain('<unsafe>');
    expect(render({ latest, loading: true })).not.toContain('上次提炼完成');
    expect(render({ failedToLoad: true })).toContain('暂时无法读取已有记录');
    expect(render({ failedToLoad: true })).toContain('重新读取候选');
    expect(render({ failedToLoad: true })).toContain('读取失败不表示没有候选');
    expect(render()).toContain('尚无当前 v5 提炼记录'); expect(render()).toContain('旧 runs/ 记录不在此读取');
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
    expect(html).toContain('Outcome evidence archive: Recorded');
    expect(render({ lang: 'en', latest: { ...latest, invocation: { ...latest.invocation, outputMode: 'prompt-json', wireId: null, archiveStatus: 'pending' } } })).toContain('Structural wire: Not used');
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
    const summary = (overrides = {}) => renderToStaticMarkup(createElement(KnowledgeInboxSummary, { lang: 'zh', failedToLoad: false, ...overrides }));
    expect(summary()).toContain('正在读取候选数量');
    expect(summary()).not.toContain('共 0 条候选');
    expect(summary({ total: 7, failedToLoad: true })).toContain('候选数量暂不可读');
    expect(summary({ total: 7, failedToLoad: true })).not.toContain('共 7 条候选');
    expect(summary({ total: 0 })).toContain('共 0 条候选');
    expect(summary({ total: 3, lang: 'en' })).toContain('3 candidates grouped by source');
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
const boundedPolicy: ExtractionBoundedPolicy = { policyId: 'knowledge-generation-bounded/v1', maxInvocations: 3, maxReasks: 2,
  profileId: 'openai-gpt54-snapshot-context/v1', maxTotalTokens: 3_162_288, maxOutputTokens: 4096,
  retry: 'transient-and-empty-validation/v1', fallback: 'none', accounting: 'reserve-upper-bound-no-refund/v1',
  unknownUsage: 'charge-reservation', selection: 'last-attempt-preserve-partial/v1', feedbackVersion: 'knowledge-generation-feedback/v1',
  backoff: { baseMs: 500, capMs: 30_000, retryAfterCapMs: 300_000, jitter: 'full/v1' } };
it('confirms the exact scope and model while optional message/configuration controls stay collapsed', () => {
  const html = confirm();
  expect(html).toContain('当前这一轮'); expect(html).toContain('已选 2 条消息'); expect(html).toContain('codex / configured-model');
  expect(html).toContain('将这些消息交给模型'); expect(html).toContain('查看／调整消息');
  expect(html).toContain('本运行限 1 次 OMK 调用'); expect(html).toContain('校验重问 0 次'); expect(html).toContain('未启用 token 预约预算');
  const defaults = renderToStaticMarkup(createElement(GenerationPolicyFields, { lang: 'zh' }));
  expect(defaults).not.toMatch(/<input[^>]*checked/); expect(defaults).not.toContain('预算依据');
  expect(html).not.toContain('<details class="conversation-extract-options" open');
  expect(html).toContain('&lt;script&gt;原文&lt;/script&gt;'); expect(html).not.toContain('<script>');
  expect(confirm({ selected: [] })).toContain('已选 0 条消息');
  expect(confirm({ turnId: undefined, lang: 'en' })).toContain('Entire conversation');
  expect(confirm({ model: '', adjust: true })).toContain('尚未设置');
  expect(confirm({ adjust: true })).toMatch(/<details[^>]+open=""/);
  const bounded = confirm({ policy: boundedPolicy });
  expect(bounded).toContain('本运行最多 3 次 OMK 调用，含最多 2 次校验重问');
  expect(bounded).toContain('本运行 token 预约总额 3162288'); expect(bounded).toContain('每次输出上限 4096 token');
  expect(bounded).toContain('已预约额度不返还，未知用量也不返还'); expect(bounded).toContain('预约预算不表示金额上限');
  expect(bounded.indexOf('本运行最多')).toBeLessThan(bounded.indexOf('调整本次配置'));
  expect(bounded).not.toContain('loopback-test');
  const en = confirm({ policy: boundedPolicy, lang: 'en' });
  expect(en).toContain('including up to 2 validation reasks'); expect(en).toContain('Total token reservation for this run: 3162288');
  expect(en).toContain('Reservations are not refunded, including when usage is unknown');
});
it('keeps bounded controls frozen while busy and names the conversation permission budget scope', () => {
  const frozen = renderToStaticMarkup(createElement(GenerationPolicyFields, { lang: 'en', value: boundedPolicy, disabled: true }));
  const inputs = frozen.match(/<input\b[^>]*>/g) ?? [];
  expect(inputs.length).toBeGreaterThanOrEqual(5); expect(inputs.every(input => /\bdisabled/.test(input))).toBe(true);
  expect(frozen).toContain('Maximum OMK invocations per run (including retries and reasks)');
  expect(frozen).toContain('Maximum validation reasks within that limit');
  expect(frozen).toContain('openai-gpt54-snapshot-context/v1'); expect(frozen).not.toContain('loopback-test');
  expect(frozen).toContain('official OpenAI API endpoint and gpt-5.4-2026-03-05');
  expect(frozen).toContain('Codex remains available with the default single policy');
  const conversation = renderToStaticMarkup(createElement(GenerationPolicyFields, { lang: 'zh', value: boundedPolicy, scope: 'conversation' }));
  expect(conversation).toContain('本次授权跨窗口累计 token 预约总额（同时限制单个运行）');
  expect(conversation).toContain('本运行最多 3 次 OMK 调用，含最多 2 次校验重问');
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

it('presents admission scope, unknown denominators and retry without claiming semantic quality', () => {
  const renderQuality = (overrides = {}) => renderToStaticMarkup(createElement(ExtractionQualityView, {
    quality: extractionQuality([]), loading: false, failed: false, lang: 'zh', onRetry() {}, ...overrides,
  }));
  const empty = renderQuality(); expect(empty).toContain('仅统计当前工作区 extraction-runs/ 中的 v5 运行'); expect(empty).toContain('不采用后续人工修订');
  expect(empty).toContain('旧 runs/ 记录不计入'); expect(empty).toContain('没有 v5 记录不代表工作区从未提炼');
  expect(empty).toContain('分组不证明 endpoint 或完整运行条件相同');
  expect(empty).toContain('位置匹配不证明语义准确'); expect(empty).toContain('零接纳不代表质量通过'); expect(empty).toContain('尚无 v5 提炼运行');
  const failed = renderQuality({ failed: true }); expect(failed).toContain('统计暂不可读'); expect(failed).toContain('重新读取统计'); expect(failed).not.toContain('共 0 次运行');
  expect(renderQuality({ loading: true })).not.toContain('尚无 v5 提炼运行');
  const group = { identity: { schemaVersion: 5, promptVersion: 'knowledge-extraction-v15', promptHash: '<unsafe>', executor: 'fixture', model: 'fixture',
    policyId: 'knowledge-generation-single/v1', policy: { policyId: 'knowledge-generation-single/v1' as const, maxInvocations: 1 as const, retry: 'none' as const, fallback: 'none' as const },
    timeoutMs: 300_000, maxOutputTokens: 4096, outputMode: 'json-schema' as const, wireId: '<wire>', producerId: '<producer>', producerRevision: '<revision>' },
    runs: { total: 1, generating: 0, prepared: 0, completed: 0, failed: 1, cancelled: 0, withAdmission: 0, withoutAdmission: 1, zeroAccepted: 0, zeroKnowledge: 0 },
    entities: { accepted: 0, rejected: 0, recorded: 0, unknownRuns: 1, acceptanceRate: null },
    mentions: { accepted: 0, rejected: 0, recorded: 0, unknownRuns: 1, acceptanceRate: null },
    proposals: { accepted: 0, rejected: 0, recorded: 0, unknownRuns: 1, acceptanceRate: null },
    localization: { passed: 0, rejected: 0, notChecked: 0, unknown: 0, unknownRuns: 1, passRate: null },
    identifierFragmentRejections: 0, identifierFragmentRejectionRate: null, referenceRejections: 0, reasons: [],
  };
  const html = renderQuality({ quality: { ...extractionQuality([]), runCount: 1, groups: [group] } });
  expect(html).toContain('未知／无分母'); expect(html).toContain('逐字定位：通过／拒绝／未检查／未知'); expect(html).toContain('1 次检查记录未知');
  expect(html).toContain('&lt;unsafe&gt;'); expect(html).not.toContain('<unsafe>');
  expect(html).toContain('Schema 5'); expect(html).toContain('knowledge-extraction-v15');
  expect(html).toContain('knowledge-generation-single/v1'); expect(html).toContain('json-schema');
  expect(html).toContain('omk.extraction-quality/v3'); expect(html).toContain('完整政策身份');
  expect(html).toContain('初始调用超时（毫秒）：300000'); expect(html).toContain('初始输出 token 上限：4096');
  for (const value of ['wire', 'producer', 'revision']) { expect(html).toContain(`&lt;${value}&gt;`); expect(html).not.toContain(`<${value}>`); }
  const promptOnly = renderQuality({ lang: 'en', quality: { ...extractionQuality([]), runCount: 1,
    groups: [{ ...group, identity: { ...group.identity, outputMode: 'prompt-json' as const, wireId: null } }] } });
  expect(promptOnly).toContain('Structural wire: Not used');
  expect(renderQuality({ lang: 'en' })).toContain('no records is not a quality pass');
});
