// @vitest-environment jsdom
import { ConfigProvider } from 'antd';
import { TextEncoder } from 'node:util';
import type { PropsWithChildren } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KnowledgeCandidates } from '../../../src/studio/web/components/knowledge/candidates';
import type { KnowledgeCandidateDetail, KnowledgeCandidateRun } from '../../../src/studio/view-models/knowledge/knowledge-candidates';
import type { KnowledgeReviewStatus } from '../../../src/studio/view-models/knowledge/knowledge-reviews';
import { bodyWrite } from '../../knowledge/body-fixtures';
import { traceSourceFixture } from './source-fixture';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));
function wrapper({ children }: PropsWithChildren) { return <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>; }
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('TextEncoder', TextEncoder);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const computed = window.getComputedStyle.bind(window); vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['zh', 'en'] as const)('keeps older-profile recovery disabled and prepares recovered content associations before explicit transmission (%s)', async lang => {
  const revision = bodyWrite().revision, sourceRef = revision.content.segments[0].evidence[0].source;
  const { rawUnits, ...snapshot } = traceSourceFixture(sourceRef, [{ evidenceRef: 'record-1', recordIndex: 0, eventKind: 'message', role: 'user', text: 'Alpha' }]); void rawUnits;
  const bodyRef = { knowledgeId: revision.knowledgeId, revisionId: revision.revisionId, bodyDigest: revision.bodyDigest };
  const detail: KnowledgeCandidateDetail = { revision, history: { storeKind: 'knowledge-item-history', schemaVersion: 3, namespace: 'fixture', knowledgeId: revision.knowledgeId,
    generation: 1, writeHeadRevisionId: revision.revisionId, revisions: [revision], maintenance: [], receipts: [] }, maintenance: null, reviewStatus: 'pending', tagging: { generation: 0, tags: [] },
    derivedCatalogs: [], derivedAssociations: { status: 'absent', reviewStatus: 'pending', bodyRef, generation: 0, headRevisionId: null }, sources: [{ status: 'available', snapshot }] };
  const reviews: KnowledgeReviewStatus = { storageStatus: 'absent', bodyRef, generation: 0, headEventId: null, sources: [{ ...sourceRef, status: 'available' }], history: null,
    content: { status: 'not_reviewed', events: [] }, coverage: { status: 'not_reviewed', projectionRevisionId: null, events: [], decisions: [{ segmentId: 's1', status: 'unknown', opinions: [] }] }, usage: [] };
  const old: KnowledgeCandidateRun = { runId: 'older-profile-run', schemaStatus: 'current', status: 'active', bodies: [], phases: [],
    nextAction: 'unsupported', unsupportedReason: 'generation_profile_changed_use_matching_build', archiveChecks: [], archiveVerification: 'not_verified' };
  const current: KnowledgeCandidateRun = { ...old, runId: '00000000-0000-4000-8000-000000000082', nextAction: 'resume_publication', unsupportedReason: undefined };
  const digest = (value: string) => `sha256:${value.repeat(64)}`;
  const recovered: KnowledgeCandidateRun = { ...current, mode: 'generate', nextAction: 'prepare_next_stage', journalGeneration: 5, executor: 'codex', model: 'authored-history-model', bodies: [bodyRef],
    sources: [{ ...sourceRef, sourceKind: 'agent_trace', origin: { threadId: 'authored-thread', title: 'Display metadata is not a source selector' } }],
    phases: [{ stageKind: 'body', state: 'completed', invocationId: '00000000-0000-4000-8000-000000000083', profileId: digest('a'), promptVersion: 'authored-body', wireId: digest('b'),
      committed: 1, issues: [], producerId: 'authored-history', producerRevision: 'v1', rejectedCount: 0 }] };
  const prepared: KnowledgeCandidateRun = { ...recovered, nextAction: 'continue_stage', journalGeneration: 6, phases: [...recovered.phases],
    preparedStage: { stageKind: 'association', state: 'prepared', invocationId: '00000000-0000-4000-8000-000000000084', profileId: digest('c'), promptVersion: 'authored-association', wireId: digest('d'),
      wireSchema: { type: 'object' }, system: 'Authored complete association system; this fixture is not a native result.',
      input: JSON.stringify({ sources: [sourceRef], bodies: [{ bodyRef, title: revision.title, content: revision.content }] }), inputDigest: digest('e'), requestDigest: digest('f'),
      producer: { producerId: 'authored-history', producerRevision: 'v1', sourceChannels: [], maxOutcomeJsonBytes: 1024 * 1024, proof: { nativeObserved: false } }, committed: 0, issues: [] } };
  const stage = prepared.preparedStage!;
  prepared.phases.push({ stageKind: stage.stageKind, state: stage.state, invocationId: stage.invocationId, profileId: stage.profileId, promptVersion: stage.promptVersion,
    wireId: stage.wireId, committed: 0, issues: [], producerId: stage.producer.producerId, producerRevision: stage.producer.producerRevision, rejectedCount: 0 });
  const completed: KnowledgeCandidateRun = { ...prepared, status: 'completed', nextAction: 'none', preparedStage: undefined,
    phases: prepared.phases.map(phase => ({ ...phase, state: 'completed' })) };
  const calls: Record<string, unknown>[] = [];
  let resumed = false, associationPrepared = false, transmitted = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/settings') return json({ effective: { workspace: '/history-fixture', executor: 'openai-api', model: 'fixture' } });
    const body = JSON.parse(String(init.body)); calls.push(body);
    if (url === '/api/knowledge/reviews' && body.operation === 'review-status') return json(reviews);
    if (url !== '/api/knowledge/candidates') throw new Error(`Unexpected URL: ${url}`);
    if (body.operation === 'list') return json(resumed ? [{ ...bodyRef, generation: 1, title: revision.title, knowledgeKind: 'fact', reviewStatus: 'pending', choice: null }] : []);
    if (body.operation === 'runs') return json([old, transmitted ? completed : associationPrepared ? prepared : resumed ? recovered : current]);
    if (body.operation === 'quality') return json({ projectionKind: 'knowledge-body-admission', schemaVersion: 1, current: [], unsupported: [], unavailable: [], archiveChecks: [], semanticQuality: 'not_assessed' });
    if (body.operation === 'resume' && body.id === current.runId) { resumed = true; return json(recovered); }
    if (body.operation === 'show' && body.id === bodyRef.knowledgeId) return json(detail);
    if (body.operation === 'inspect' && body.id === current.runId) return json(associationPrepared ? prepared : recovered);
    if (body.operation === 'prepare-generation') { associationPrepared = true; return json(prepared); }
    if (body.operation === 'continue-stage') { transmitted = true; return json(completed); }
    throw new Error(`Unexpected history operation: ${body.operation}`);
  }));
  render(<KnowledgeCandidates lang={lang}/>, { wrapper });
  fireEvent.click(await screen.findByRole('button', { name: lang === 'zh' ? '查看提炼记录' : 'View extraction history' }));
  const history = await screen.findByRole('dialog', { name: lang === 'zh' ? '提炼记录' : 'Extraction history' });
  const oldRow = within(history).getByText(old.runId).closest('section')!;
  const currentRow = within(history).getByText(current.runId).closest('section')!;
  expect(within(oldRow).getByRole('alert').textContent).toContain(lang === 'zh' ? '此任务使用旧生成协议' : 'This run uses an older generation protocol');
  expect(oldRow.textContent).toContain(lang === 'zh' ? '请使用保留的匹配构建恢复此任务' : 'Recover this run with the preserved matching build');
  expect(oldRow.textContent).toContain(lang === 'zh' ? '不重新解释输出或重新派发' : 'without reinterpreting output or redispatching');
  expect(oldRow.textContent).toContain(lang === 'zh' ? '已准备好的固定写入意图仍可恢复' : 'Already prepared write intents remain recoverable');
  expect(within(currentRow).queryByRole('alert')).toBeNull();
  const resumeName = lang === 'zh' ? '恢复归档或保存' : 'Resume archiving or saving';
  const blocked = within(oldRow).getByRole('button', { name: resumeName });
  expect(blocked.hasAttribute('disabled')).toBe(true); fireEvent.click(blocked);
  expect(calls.some(call => call.operation === 'resume')).toBe(false);
  const enabled = within(currentRow).getByRole('button', { name: resumeName });
  expect(enabled.hasAttribute('disabled')).toBe(false); fireEvent.click(enabled);
  await waitFor(() => expect(calls.filter(call => call.operation === 'resume')).toEqual([{ workspace: '/history-fixture', operation: 'resume', id: current.runId }]));
  const prepareName = lang === 'zh' ? '准备并核对下一阶段' : 'Prepare and review next stage';
  const prepareNext = await within(currentRow).findByRole('button', { name: prepareName });
  await waitFor(() => expect(prepareNext.hasAttribute('disabled')).toBe(false)); fireEvent.click(prepareNext);
  await waitFor(() => expect(calls.filter(call => call.operation === 'inspect')).toEqual([{ workspace: '/history-fixture', operation: 'inspect', id: current.runId }]));
  await waitFor(() => expect(calls.filter(call => call.operation === 'prepare-generation')).toEqual([{ workspace: '/history-fixture', operation: 'prepare-generation', runId: current.runId,
    executor: recovered.executor, model: recovered.model, sources: [sourceRef] }]));
  // rc-component's test-only useId returns "test-id" for both the Drawer and Modal.
  // Scope by this Modal's visible title, then verify its own ARIA binding instead of
  // letting duplicate fixture IDs resolve the Modal's name to the Drawer's title.
  const confirmationTitle = await screen.findByText(lang === 'zh' ? '核对完整模型请求' : 'Review complete model request');
  const confirmation = confirmationTitle.closest('[role="dialog"]') as HTMLElement;
  expect(confirmation).not.toBeNull();
  expect(confirmation.getAttribute('aria-labelledby')).toBe(confirmationTitle.id);
  expect(confirmationTitle.id).not.toBe('');
  expect(confirmation.textContent).toContain(revision.content.segments[0].text);
  expect(confirmation.textContent).toContain(prepared.preparedStage!.system);
  const send = within(confirmation).getByRole('button', { name: lang === 'zh' ? '发送此阶段' : 'Send this stage' });
  expect(send.hasAttribute('disabled')).toBe(true); fireEvent.click(send);
  expect(calls.some(call => ['generate', 'continue-stage'].includes(String(call.operation)))).toBe(false);
  fireEvent.click(within(confirmation).getByRole('checkbox', { name: lang === 'zh' ? '批准将此精确请求发送到上面显示的执行器／模型。' : 'Approve sending this exact request to the executor/model shown above.' }));
  fireEvent.click(send);
  await waitFor(() => expect(calls.filter(call => call.operation === 'continue-stage')).toEqual([{ workspace: '/history-fixture', operation: 'continue-stage', id: current.runId,
    generation: prepared.journalGeneration, executor: recovered.executor, model: recovered.model, confirmedRequestDigest: prepared.preparedStage!.requestDigest }]));
  await waitFor(() => expect(currentRow.textContent).toContain(lang === 'zh' ? '流程已结束' : 'Workflow ended'));
  expect(within(currentRow).getByRole('button', { name: resumeName }).hasAttribute('disabled')).toBe(true);
  expect(calls.some(call => ['generate', 'continue'].includes(String(call.operation)))).toBe(false);
});
