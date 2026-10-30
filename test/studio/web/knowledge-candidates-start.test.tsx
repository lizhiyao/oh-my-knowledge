import { ExtractionQualityView } from '../../../src/studio/web/components/knowledge/extraction-quality.js';
import { SourcePreviewContent, PreparedGenerationConfirmation } from '../../../src/studio/web/components/knowledge/source-picker.js';
import { fileSourceFixture } from './source-fixture.js';
import type { KnowledgeSourcePreview } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
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
    expect(render({ latest: { ...latest, status: 'failed' } })).toContain('上次提炼：生成阶段失败');
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
    expect(header).toContain('需逐阶段确认，不再自动提炼。'); expect(header).not.toContain('开启自动提炼');
    expect(header).toContain('提炼整条对话'); expect(header).toContain('知识待办');
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
    expect(scoped()).not.toContain('自动提炼');
    expect(scoped({ lang: 'en' })).not.toContain('Enable auto extraction');
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

const source = fileSourceFixture({ snapshotId: '00000000-0000-4000-8000-000000000001', sourceVersion: `sha256:${'a'.repeat(64)}` }, '<script>选定原文</script>');
const preview: KnowledgeSourcePreview = {
  previewId: '00000000-0000-4000-8000-000000000002', previewDigest: `sha256:${'b'.repeat(64)}`, scopeRevision: 'trusted-scope',
  items: [{ sourceOrdinal: 0, resolvedSelection: { sourceKind: 'project_file', projectId: 'project-alpha', relativePath: 'docs/knowledge.md', lineRanges: [{ startLine: 3, endLine: 3 }] },
    sourceVersion: source.sourceVersion, material: source.material, retainedUnits: source.rawUnits, excerpts: source.excerpts, limitations: source.limitations }],
  readManifest: { totalBytes: 200, selectedTextBytes: 80, items: [{ sourceOrdinal: 0, actual: { contentBytes: 200, metadataBytes: 0, totalBytes: 200, selectedTextBytes: 80 } }] },
  sendDraft: { authorization: 'not_granted', json: '{"material":"<script>选定原文</script>"}', materialDigest: `sha256:${'c'.repeat(64)}`, materialJsonBytes: 90,
    excerpts: [], neutralMetadataJsonBytes: 30, scope: 'Selected material, not a complete network request.' },
  savePlan: { afterDeletion: 'reject', projections: [{ sourceOrdinal: 0, sourceVersion: source.sourceVersion, projectionJsonBytes: 500, selectedRawBytes: 80, rawUnitCount: 1, excerptCount: 1 }], actualSnapshotsWritten: 0, actualWrittenBytes: 0 },
};
it('shows complete literal local material and separate read/send/save boundaries without granting transmission', () => {
  const html = renderToStaticMarkup(createElement(SourcePreviewContent, { preview, lang: 'zh' }));
  for (const text of ['本次预览实际读取', '选定原件', '模型材料草稿', '本次捕获实际写入', '捕获只保存选定来源', '完整模型材料草稿', '固定来源身份与选区', 'project-alpha', 'docs/knowledge.md']) expect(html).toContain(text);
  expect(html).toContain('200 bytes'); expect(html).toContain('0 bytes'); expect(html).toContain('&lt;script&gt;选定原文&lt;/script&gt;'); expect(html).not.toContain('<script>');
  const en = renderToStaticMarkup(createElement(SourcePreviewContent, { preview, lang: 'en' }));
  expect(en).toContain('does not authorize a model request'); expect(en).toContain('excludes final system, complete input and transport envelope');
});
it('shows the exact complete prepared stage and target rather than treating capture as send permission', () => {
  const digest = `sha256:${'d'.repeat(64)}`;
  const run: KnowledgeCandidateRun = { ...latest, status: 'active', nextAction: 'continue_stage', journalGeneration: 1, executor: 'codex', model: 'authored-target',
    workflowId: 'knowledge-body-first/v4', inputVersion: 'knowledge-source-generation-input/v2', preparedStage: { stageKind: 'body', invocationId: '00000000-0000-4000-8000-000000000003',
      state: 'prepared', profileId: digest, promptVersion: 'authored-profile', wireId: digest, wireSchema: { type: 'object' }, system: '<script>complete system</script>',
      input: '{"material":"complete input","tail":"<script>final tail</script>"}', inputDigest: digest, requestDigest: digest,
      producer: { producerId: 'authored-ui', producerRevision: 'v1', sourceChannels: [], maxOutcomeJsonBytes: 1000, proof: { nativeObserved: false } }, committed: 0, issues: [] } };
  const html = renderToStaticMarkup(createElement(PreparedGenerationConfirmation, { run, lang: 'en', confirmed: false, onConfirmed() {} }));
  for (const text of ['Complete actual model input', 'Complete system', 'invocationId', 'requestDigest', 'codex', 'authored-target', 'complete input', 'final tail', 'Confirm every stage separately', 'internal context']) expect(html).toContain(text);
  expect(html).toContain('&lt;script&gt;complete system&lt;/script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('checked=""');
  const association = renderToStaticMarkup(createElement(PreparedGenerationConfirmation, { run: { ...run, preparedStage: { ...run.preparedStage!, stageKind: 'association' } }, lang: 'zh', confirmed: false, onConfirmed() {} }));
  expect(association).toContain('确认实体关联请求');
  const unsupported = renderToStaticMarkup(createElement(PreparedGenerationConfirmation, { run: { ...run, nextAction: 'unsupported' }, lang: 'en', confirmed: true, onConfirmed() {} }));
  expect(unsupported).toContain('No prepared stage is sendable'); expect(unsupported).not.toContain('Approve sending this exact request');
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
