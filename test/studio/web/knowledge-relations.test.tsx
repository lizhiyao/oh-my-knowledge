// @vitest-environment jsdom
import { ConfigProvider } from 'antd';
import { type PropsWithChildren } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KnowledgeReader } from '../../../src/studio/web/components/knowledge/reader';
import { RelatedKnowledge } from '../../../src/studio/web/components/knowledge/related-knowledge';
import { useRelationSave } from '../../../src/studio/web/components/knowledge/relation-request';
import type { KnowledgeCandidateDetail } from '../../../src/studio/view-models/knowledge/knowledge-candidates';
import type { KnowledgeRelationStatus, KnowledgeRelationProposeInput } from '../../../src/studio/view-models/knowledge/knowledge-relations';
import { bodyWrite } from '../../knowledge/body-fixtures';
import { traceSourceFixture } from './source-fixture';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = `sha256:${'a'.repeat(64)}`, at = '2026-10-30T00:00:00Z';
const bodyRef = (detail: KnowledgeCandidateDetail) => ({ knowledgeId: detail.revision.knowledgeId, revisionId: detail.revision.revisionId, bodyDigest: detail.revision.bodyDigest });
function detail(n: number): KnowledgeCandidateDetail {
  const quote = `Alpha 来源 ${n} <script>不执行</script>`;
  const ref = { snapshotId: uuid(n + 2), sourceVersion: digest };
  const snapshot = traceSourceFixture(ref, [{ evidenceRef: 'record-1', text: quote, recordIndex: 0, eventKind: 'message' }]);
  const revision = { ...bodyWrite().revision, knowledgeId: uuid(n), revisionId: uuid(n + 1), title: `知识 ${n}`,
    content: { segments: [{ segmentId: 's1', text: `😀 知识 ${n} 的完整说明；限定当前来源，未知版本。`, evidence: [{ source: ref, basis: 'source_assertion' as const,
      selection: { evidenceRef: 'record-1', start: 0, end: quote.length, quote } }] }] } };
  return { revision, history: { storeKind: 'knowledge-item-history', schemaVersion: 3, namespace: 'local', knowledgeId: revision.knowledgeId,
    generation: 1, writeHeadRevisionId: revision.revisionId, revisions: [revision], maintenance: [], receipts: [] }, maintenance: null,
    reviewStatus: 'pending', tagging: { generation: 0, tags: [] }, derivedAssociations: { status: 'absent', reviewStatus: 'pending', bodyRef: bodyRef({ revision } as KnowledgeCandidateDetail), generation: 0, headRevisionId: null }, derivedCatalogs: [], sources: [{ status: 'available', snapshot }] };
}
function proposal(a = detail(1), b = detail(11)): KnowledgeRelationProposeInput {
  return { relationId: uuid(100), requestId: uuid(101), expectedGeneration: 0, expectedHeadEventId: null, parentRelationRevisionId: null,
    relationType: 'conflicts_with', from: { bodyRef: bodyRef(a) }, to: { bodyRef: bodyRef(b) }, question: '两个说法能否同时成立？',
    conditions: ['仅当前来源'], comparisonScope: { status: 'unknown', subject: 'Alpha', modality: '来源中的说法', time: '未知', version: '未知', reason: '尚未建立可比性' },
    basis: 'inference', reason: '待进一步核对', limitations: ['没有裁决真值'], evidence: [a, b].map((value, i) => ({ ...value.revision.content.segments[0].evidence[0], side: i === 0 ? 'from' : 'to',
      bodySelection: { segmentId: 's1', start: 0, end: value.revision.content.segments[0].text.length, quote: value.revision.content.segments[0].text } })) };
}
function relation(input = proposal()): Extract<KnowledgeRelationStatus, { storageStatus: 'available' }> {
  const { relationId, requestId, expectedGeneration, expectedHeadEventId, ...fields } = input;
  if (expectedGeneration !== 0 || expectedHeadEventId !== null) throw new Error('This UI fixture begins with an initial proposal.');
  const revision = { ...fields, eventKind: 'relation_proposed' as const, eventId: requestId, parentEventId: null, actor: { actorKind: 'human' as const, actorId: 'other-author' }, at };
  return { relationId, storageStatus: 'available', generation: 1, headEventId: requestId, revision, isCurrentRevision: true,
    withdrawn: false, activeReviews: [], opinionStatus: 'pending', bodyStatus: 'current', sourceStatus: 'available', issues: [],
    endpoints: { from: { ...input.from, status: 'current', currentBodyRef: input.from.bodyRef }, to: { ...input.to, status: 'current', currentBodyRef: input.to.bodyRef } },
    sources: input.evidence.map(item => ({ ...item.source, status: 'available' })), permissions: { canReview: true, canWithdraw: false, canAccept: false, supersedableReviewEventIds: [] },
    history: { storeKind: 'knowledge-relation-history', schemaVersion: 1, namespace: 'local', relationId, generation: 1, writeHeadEventId: requestId, events: [revision],
      receipts: [{ requestId, eventId: requestId, committedGeneration: 1, commandDigest: digest }] } };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function wrapper({ children }: PropsWithChildren) { return <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const computed = window.getComputedStyle.bind(window); vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('opens relations lazily and builds both exact body/source selections without asking for IDs or an actor', async () => {
  const a = detail(1), b = detail(11), calls: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    const command = JSON.parse(String(options.body)); calls.push(command);
    if (url.endsWith('/reviews')) return json({ storageStatus: 'absent', bodyRef: bodyRef(a), generation: 0, headEventId: null, sources: [], history: null,
      content: { status: 'not_reviewed', events: [] }, coverage: { status: 'not_reviewed', projectionRevisionId: null, decisions: [], events: [] }, usage: [] });
    if (command.operation === 'relations') return json({ bodyRef: bodyRef(a), relations: [], unavailable: [], completeness: 'complete' });
    if (command.operation === 'knowledge') return json({ rows: [a, b].map(value => ({ ...bodyRef(value), title: value.revision.title })), objects: [] });
    if (command.operation === 'show') return json(b);
    if (command.operation === 'propose-relation') return json({ requestId: command.requestId, eventId: command.requestId, commandDigest: digest, committedGeneration: 1 });
    throw new Error(`Unexpected ${command.operation}`);
  }));
  render(<KnowledgeReader detail={a} lang="zh" workspace="/workspace" onRevision={() => {}} onRetry={() => {}}/>, { wrapper });
  expect(calls.some(value => value.operation === 'relations')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '相关知识' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '选择另一篇并提出关系' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '选择另一篇并提出关系' }));
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '另一篇知识' }));
  fireEvent.click(await screen.findByText('知识 11', { selector: '.ant-select-item-option-content' }));
  const left = await screen.findByRole('region', { name: '当前知识完整正文与来源' });
  const right = await screen.findByRole('region', { name: '另一篇知识完整正文与来源' });
  expect(left.textContent).toContain(a.revision.content.segments[0].text);
  expect(right.textContent).toContain(b.revision.content.segments[0].text);
  expect(right.querySelector('script')).toBeNull();
  fireEvent.click(within(left).getByRole('checkbox', { name: '将此段作为关系依据' }));
  fireEvent.click(within(right).getByRole('checkbox', { name: '将此段作为关系依据' }));
  fireEvent.change(screen.getByRole('textbox', { name: '关系问题' }), { target: { value: '如何补充适用限制？' } });
  fireEvent.change(screen.getByRole('textbox', { name: '关系适用条件' }), { target: { value: '当前来源\n未知版本' } });
  for (const key of ['subject', 'modality', 'time', 'version', 'reason']) fireEvent.change(screen.getByRole('textbox', { name: `comparison-${key}` }), { target: { value: `${key} 尚未完全确定` } });
  fireEvent.change(screen.getByRole('textbox', { name: '关系理由' }), { target: { value: '补充来源中的适用限制' } });
  fireEvent.click(screen.getByRole('checkbox', { name: '已核读两端完整正文、原来源、比较条件及所选段落；新提案仍待核对。' }));
  fireEvent.click(screen.getByRole('button', { name: '正文' }));
  fireEvent.click(screen.getByRole('button', { name: '相关知识' }));
  expect((screen.getByRole('textbox', { name: '关系问题' }) as HTMLInputElement).value).toBe('如何补充适用限制？');
  fireEvent.click(screen.getByRole('button', { name: '保存待核对提案' }));
  await screen.findByText(/提案已保存，仍待核对/);
  const saved = calls.find(value => value.operation === 'propose-relation') as unknown as KnowledgeRelationProposeInput;
  expect(saved).not.toHaveProperty('actor'); expect(saved.comparisonScope.status).toBe('unknown');
  expect(saved.from.bodyRef).toEqual(bodyRef(a)); expect(saved.to.bodyRef).toEqual(bodyRef(b));
  expect(saved.evidence).toEqual(proposal(a, b).evidence);
  expect(saved.evidence[0].bodySelection.end).toBe(a.revision.content.segments[0].text.length);
});

it('keeps an uncertain command frozen and checks the full event rather than trusting a matching request ID', async () => {
  const input = proposal(), expected = relation(input), calls: Record<string, unknown>[] = [];
  let readable: KnowledgeRelationStatus = { relationId: input.relationId, storageStatus: 'absent' };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const command = JSON.parse(String(options.body)); calls.push(command);
    if (command.operation === 'propose-relation') throw new TypeError('Connection lost after send');
    return json(readable);
  }));
  const { result } = renderHook(() => useRelationSave('/workspace', 'frozen-command', 'zh'));
  await act(async () => { await result.current.submit({ operation: 'propose-relation', ...input }); });
  expect(result.current.unknown).toBe(true); expect(result.current.locked).toBe(true);
  readable = structuredClone(expected); readable.history.events[0].reason = '不同的命令内容';
  await act(async () => { await result.current.inspect(); });
  expect(result.current.receipt).toBeUndefined(); expect(result.current.unknown).toBe(true);
  readable = expected;
  await act(async () => { await result.current.inspect(); });
  expect(result.current.receipt?.requestId).toBe(input.requestId);
  expect(calls.filter(value => value.operation === 'propose-relation')).toHaveLength(1);
  expect(calls.filter(value => value.operation === 'relation')).toHaveLength(3);
  expect(calls.filter(value => value.operation === 'relation').every(value => !('relationRevisionId' in value))).toBe(true);
});

it.each(['inference', 'source_assertion'] as const)('reopens the %s basis with exact selector and permissions without affirming an unknown conflict', async basis => {
  const a = detail(1), b = detail(11), stored = relation({ ...proposal(a, b), basis }), calls: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const command = JSON.parse(String(options.body)); calls.push(command);
    if (command.operation === 'relations') return json({ bodyRef: bodyRef(a), relations: [stored], unavailable: [], completeness: 'complete' });
    if (command.operation === 'knowledge') return json({ rows: [], objects: [] });
    if (command.operation === 'relation') return json(stored);
    if (command.operation === 'show') return json(command.id === a.revision.knowledgeId ? a : b);
    if (command.operation === 'review-relation') return json({ requestId: command.requestId, eventId: command.requestId, commandDigest: digest, committedGeneration: 2 });
    throw new Error('Unexpected operation');
  }));
  render(<RelatedKnowledge detail={a} workspace="/workspace" lang="zh" selectionId={stored.relationId} selectionRevisionId={stored.revision.eventId}/>, { wrapper });
  await screen.findByRole('textbox', { name: '关系复核理由' });
  expect(screen.queryByRole('button', { name: '撤回我提出的此修订' })).toBeNull();
  expect((screen.getByRole('button', { name: '有限接受' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(`关系依据：${basis === 'inference' ? '推断意见' : '来源明确提出'}`)).toBeTruthy();
  expect(screen.getByText('冲突意见', { selector: '.ant-tag' })).toBeTruthy();
  expect(screen.queryByText(/条件可比的冲突/)).toBeNull();
  expect(screen.getByText(/未知，尚未确认可比/)).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: '关系复核理由' }), { target: { value: '比较条件尚不成立，拒绝本轮意见' } });
  fireEvent.click(screen.getByRole('button', { name: '拒绝此关系' }));
  await waitFor(() => expect(calls.some(value => value.operation === 'review-relation')).toBe(true));
  expect(calls.find(value => value.operation === 'relation')).toMatchObject({ relationRevisionId: stored.revision.eventId });
  expect(calls.find(value => value.operation === 'review-relation')).toMatchObject({ relationRevisionId: stored.revision.eventId, expectedGeneration: 1, expectedHeadEventId: stored.headEventId, choice: 'reject', supersedesReviewEventIds: [] });
  expect(calls.find(value => value.operation === 'review-relation')).not.toHaveProperty('actor');
});

it('ignores late relation/directory responses after switching the reader workspace and body', async () => {
  const a = detail(1), b = detail(11), stored = relation(proposal(a, b));
  let resolveOld!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {
    const command = JSON.parse(String(options.body));
    if (command.operation === 'relations' && command.workspace === '/old') return new Promise<Response>(resolve => { resolveOld = resolve; });
    if (command.operation === 'relations') return Promise.resolve(json({ bodyRef: bodyRef(b), relations: [], unavailable: [], completeness: 'complete' }));
    return Promise.resolve(json({ rows: [], objects: [] }));
  }));
  const { rerender } = render(<RelatedKnowledge key="old" detail={a} workspace="/old" lang="zh"/>, { wrapper });
  rerender(<RelatedKnowledge key="new" detail={b} workspace="/new" lang="zh"/>);
  await screen.findByText('此精确正文尚无可读关系。可选另一篇核对后提出。');
  await act(async () => { resolveOld(json({ bodyRef: bodyRef(a), relations: [stored], unavailable: [], completeness: 'complete' })); });
  expect(screen.queryByRole('button', { name: /两个说法能否同时成立/ })).toBeNull();
});
