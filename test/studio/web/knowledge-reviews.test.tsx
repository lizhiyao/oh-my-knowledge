// @vitest-environment jsdom
import { ConfigProvider } from 'antd';
import type { PropsWithChildren } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeReviewDrawer } from '../../../src/studio/web/components/knowledge/review-drawer';
import { KnowledgeReader } from '../../../src/studio/web/components/knowledge/reader';
import type { KnowledgeCandidateDetail } from '../../../src/studio/view-models/knowledge/knowledge-candidates';
import type { KnowledgeReviewContentInput, KnowledgeReviewEvent, KnowledgeReviewReceipt, KnowledgeReviewStatus } from '../../../src/studio/view-models/knowledge/knowledge-reviews';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = `sha256:${'a'.repeat(64)}`;
const at = '2026-10-29T00:00:00Z';
const actor = { actorKind: 'human' as const, actorId: 'authored-review-fixture' };
const source = { snapshotId: uuid(3), sourceVersion: digest };

/** Authored view projections test UI interaction only; production admission is covered by HTTP tests. */
function fixture(historical = false) {
  const revision = { knowledgeId: uuid(1), revisionId: uuid(2), bodyDigest: digest, title: 'Source-local limits for Alpha', reuseRationale: 'Inspect the exact conditions before reuse.',
    content: { segments: ['Alpha requires these source-local conditions.', 'This segment has no safely identified object.', 'The expected subject is missing from the mappings.', 'This segment has not been assessed.'].map((text, index) => ({
      segmentId: `s${index + 1}`, text, evidence: [{ source, selection: { evidenceRef: 'record-1', quote: 'Alpha', start: 1, end: 6 }, basis: 'source_assertion' as const }],
    })) }, observationRefs: [], derivations: [], createdAt: at, revisedAt: at, createdBy: actor, revisedBy: actor, revisionReason: 'Authored UI fixture' };
  const bodyRef = { knowledgeId: revision.knowledgeId, revisionId: revision.revisionId, bodyDigest: revision.bodyDigest };
  const mapping = { segmentId: 's1', analysisId: uuid(7), entityRevisionId: uuid(8), entityId: uuid(4), mentionIds: [uuid(5)] };
  const projection = { revisionId: uuid(9), bodyRef, status: 'available' as const, reviewStatus: 'pending' as const,
    catalogRefs: [{ analysisId: mapping.analysisId, entityRevisionId: mapping.entityRevisionId }], segmentEntityRefs: [mapping],
    typedRelations: [], issues: [], revisedAt: at, revisedBy: actor, revisionReason: 'Authored source-local mapping' };
  const newer = { ...revision, revisionId: uuid(99), bodyDigest: `sha256:${'b'.repeat(64)}` };
  const detail: KnowledgeCandidateDetail = { revision, history: { storeKind: 'knowledge-item-history', schemaVersion: 3, namespace: 'fixture',
    knowledgeId: revision.knowledgeId, generation: historical ? 2 : 1, writeHeadRevisionId: historical ? newer.revisionId : revision.revisionId,
    revisions: historical ? [revision, newer] : [revision], maintenance: [], receipts: [] }, maintenance: null, reviewStatus: 'pending', tagging: { generation: 0, tags: [] },
    derivedAssociations: { status: 'available', reviewStatus: 'pending', bodyRef, generation: 1, headRevisionId: projection.revisionId, revision: projection },
    derivedCatalogs: [{ status: 'available', analysisId: mapping.analysisId, entityRevisionId: mapping.entityRevisionId, currentHeadRevisionId: mapping.entityRevisionId,
      ...source, entities: [{ entityId: mapping.entityId, label: 'Alpha', description: 'Only this source-local object', qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [],
        uncertainties: [], referentKind: 'object', componentRef: null, collection: null }],
      mentions: [{ mentionId: uuid(5), entityId: mapping.entityId, selection: { evidenceRef: 'record-1', quote: 'Alpha', start: 1, end: 6 }, basis: 'explicit', rationale: 'Exact fixture mention' }] }],
    sources: [{ status: 'available', window: { ...source, sourcePath: '/authored-ui-fixture', sourceKind: 'codex', projectionVersion: 'knowledge-window-v2', capturedAt: at,
      startRecord: 0, endRecord: 0, excerpts: [{ evidenceRef: 'record-1', text: ' Alpha project condition ', recordIndex: 0, eventKind: 'message', role: 'user' }],
      records: [{ recordIndex: 0, raw: 'Authored source fixture' }], limitations: ['Source-local fixture, not a quality observation'] } }] };
  const baseline: KnowledgeReviewStatus = { storageStatus: 'absent', bodyRef, generation: 0, headEventId: null, sources: [{ ...source, status: 'available' }], history: null,
    content: { status: 'not_reviewed', events: [] }, coverage: { status: 'not_reviewed', projectionRevisionId: projection.revisionId, events: [],
      decisions: revision.content.segments.map(segment => ({ segmentId: segment.segmentId, status: 'unknown', opinions: [] })) }, usage: [] };
  return { detail, baseline, bodyRef, mapping, projection };
}
const receiptFor = (command: Record<string, unknown>): KnowledgeReviewReceipt => ({ requestId: command.requestId as string, commandDigest: digest,
  eventId: command.requestId as string, committedGeneration: Number(command.expectedGeneration) + 1 });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function wrapper({ children }: PropsWithChildren) { return <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>; }
async function choose(label: string, option: string) {
  const combobox = screen.getByRole('combobox', { name: label });
  const key = (key: string, code: number) => { const event = { key, code: key, keyCode: code, which: code }; fireEvent.keyDown(combobox, event); fireEvent.keyUp(combobox, event); };
  key('ArrowDown', 40);
  await waitFor(() => expect(combobox.getAttribute('aria-expanded')).toBe('true'));
  // Drive the real rc-select active option through the focused combobox. A closing popup
  // from another Select must never determine which segment receives the choice. rc-select
  // uses the same test-id in this environment, so cached hidden options cannot own the ID.
  let current: string | null = null;
  for (let index = 0; index < 20; index++) {
    const active = combobox.getAttribute('aria-activedescendant');
    current = active ? [...document.querySelectorAll('[role="option"]')].find(element => {
      const popup = element.closest<HTMLElement>('.ant-select-dropdown');
      return element.id === active && popup && !popup.classList.contains('ant-select-dropdown-hidden') && getComputedStyle(popup).display !== 'none' && getComputedStyle(popup).visibility !== 'hidden';
    })?.getAttribute('aria-label') ?? null : null;
    if (current === option) break;
    key('ArrowDown', 40);
  }
  expect(current, `Active option for ${label}`).toBe(option);
  key('Enter', 13);
  await waitFor(() => expect(combobox.getAttribute('aria-expanded')).toBe('false'));
}

const change = (label: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } });
const saveButton = () => screen.getByRole('button', { name: 'Save this record' }) as HTMLButtonElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const computed = window.getComputedStyle.bind(window); vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('independent knowledge review interactions', () => {
  it('keeps content readable when its ledger is unavailable and ignores the cancelled old-workspace response instead of calling it unreviewed', async () => {
    const data = fixture(), calls: Record<string, unknown>[] = []; let releaseOld!: (value: Response) => void, oldSignal: AbortSignal | undefined;
    const unavailable: KnowledgeReviewStatus = { storageStatus: 'unavailable', bodyRef: data.bodyRef, generation: null, headEventId: null, sources: data.baseline.sources,
      history: null, content: { status: 'unavailable', events: [] }, coverage: { status: 'unavailable', projectionRevisionId: data.projection.revisionId, events: [], decisions: [] }, usage: [], reason: 'Authored unreadable ledger fixture' };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)); calls.push(call); expect(call.operation).toBe('review-status');
      if (call.workspace === '/old-review-workspace') { oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { releaseOld = resolve; }); }
      return response(call.workspace === '/unavailable-review-workspace' ? unavailable : data.baseline);
    }));
    const reader = (workspace: string) => <KnowledgeReader detail={data.detail} workspace={workspace} lang="en" onRevision={vi.fn()} onRetry={vi.fn()}/>;
    const mounted = render(reader('/old-review-workspace'), { wrapper });
    await waitFor(() => expect(oldSignal).toBeDefined());
    expect(screen.getByText(data.detail.revision.content.segments[0].text)).toBeTruthy();
    mounted.rerender(reader('/unavailable-review-workspace'));
    await screen.findByText(/Ledger unavailable; state unknown/);
    expect(oldSignal?.aborted).toBe(true); expect(screen.queryByText(/Content review: Not reviewed/)).toBeNull();
    expect(screen.getByText(/Association coverage: projection or ledger unavailable; scope unknown/)).toBeTruthy();
    await act(async () => releaseOld(response(data.baseline)));
    expect(screen.getByText(/Ledger unavailable; state unknown/)).toBeTruthy();
    expect(screen.queryByText(/Content review: Not reviewed/)).toBeNull();
    expect(document.querySelectorAll('.knowledge-reader .knowledge-segment-text')).toHaveLength(4);
    mounted.rerender(reader('/absent-review-workspace'));
    await screen.findByText(/Content review: Not reviewed/);
    expect(screen.queryByText(/Ledger unavailable; state unknown/)).toBeNull();
    expect(screen.getByText(data.detail.revision.content.segments[0].text)).toBeTruthy();
    expect(calls.map(call => call.workspace)).toEqual(['/old-review-workspace', '/unavailable-review-workspace', '/absent-review-workspace']);
  });

  it('accepts a missing-block finding and requires limits without implicitly superseding an unresolved revision request', async () => {
    const data = fixture(), calls: Record<string, unknown>[] = [];
    const prior: KnowledgeReviewEvent = { eventKind: 'content_review', eventId: uuid(50), parentEventId: null, bodyRef: data.bodyRef, sources: [source], actor, at,
      supersedesEventIds: [], status: 'needs_revision', reason: 'Prior unresolved missing scope', limitations: [],
      findings: [{ problemKind: 'omission', description: 'The source conditions are incomplete.', segmentIds: [], evidence: [] }] };
    const baseline: KnowledgeReviewStatus = { ...data.baseline, storageStatus: 'available', generation: 1, headEventId: prior.eventId,
      history: { storeKind: 'knowledge-review-history', schemaVersion: 1, namespace: 'fixture', knowledgeId: data.bodyRef.knowledgeId, generation: 1, writeHeadEventId: prior.eventId,
        events: [prior], receipts: [{ requestId: prior.eventId, eventId: prior.eventId, committedGeneration: 1, commandDigest: digest }] }, content: { status: 'needs_revision', events: [prior] } };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)); calls.push(call); return response(call.operation === 'review-status' ? baseline : receiptFor(call));
    }));
    render(<KnowledgeReviewDrawer detail={data.detail} workspace="/review-copy" lang="en" onClose={vi.fn()}/>, { wrapper });
    await screen.findByRole('combobox', { name: 'Content review decision' });
    expect(screen.getByText(/This revision has unresolved revision requests/)).toBeTruthy();
    expect(screen.getByText(/they are not human Gold/)).toBeTruthy();
    change('Reason for this record', 'Inspect only this exact frozen body.');
    fireEvent.click(screen.getByRole('button', { name: 'Add a finding' }));
    change('Finding 1 description', 'An entire condition block is absent.');
    expect(saveButton().disabled).toBe(false);
    await choose('Content review decision', 'Reviewed with limits'); expect(saveButton().disabled).toBe(true);
    change('Review limits', 'Applies only to this frozen source.');
    fireEvent.click(screen.getByText('Explicitly supersede prior opinions (optional; retained by default)', { exact: true }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(saveButton());
    await screen.findByText(/A save receipt identifies this review event/);
    const writes = calls.filter(call => call.operation !== 'review-status'); expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ workspace: '/review-copy', operation: 'review-content', bodyRef: data.bodyRef,
      expectedGeneration: 1, expectedHeadEventId: prior.eventId, status: 'reviewed_with_limits', supersedesEventIds: [],
      findings: [{ problemKind: 'omission', description: 'An entire condition block is absent.', segmentIds: [], evidence: [] }], limitations: ['Applies only to this frozen source.'] });
    expect(writes[0]).not.toHaveProperty('actor');
    expect(screen.getByText(/This revision has unresolved revision requests/)).toBeTruthy();
  });

  it('records all four per-segment coverage states against the frozen projection and explicitly chosen exact mapping', async () => {
    const data = fixture(), calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { const call = JSON.parse(String(init.body)); calls.push(call); return response(call.operation === 'review-status' ? data.baseline : receiptFor(call)); }));
    const mounted = render(<KnowledgeReviewDrawer detail={data.detail} workspace="/coverage-copy" lang="en" initialMode="coverage" onClose={vi.fn()}/>, { wrapper });
    await screen.findByRole('combobox', { name: 'Coverage decision for segment 1' });
    const newer = structuredClone(data.detail); newer.derivedAssociations.revision!.revisionId = uuid(90); newer.derivedAssociations.headRevisionId = uuid(90);
    mounted.rerender(<KnowledgeReviewDrawer detail={newer} workspace="/coverage-copy" lang="en" initialMode="coverage" onClose={vi.fn()}/>);
    expect(screen.getByText(/Existing mappings do not establish assessed coverage/)).toBeTruthy();
    await choose('Coverage decision for segment 1', 'Links reviewed');
    const first = document.querySelectorAll('.knowledge-review-coverage-segment')[0]; fireEvent.click(within(first as HTMLElement).getByRole('checkbox'));
    await choose('Coverage decision for segment 2', 'No reliable object');
    await choose('Coverage decision for segment 3', 'Association gap');
    change('Coverage reason for segment 1', 'Exact Alpha source mention checked.');
    change('Coverage reason for segment 2', 'No reliably identified object in this segment.');
    change('Coverage reason for segment 3', 'The expected subject has no mapping.');
    fireEvent.click(screen.getByRole('button', { name: 'Explicitly mark remaining segments as not assessed' }));
    change('Reason for this record', 'Assess this exact body and projection.');
    fireEvent.click(saveButton()); await screen.findByText(/A save receipt identifies this review event/);
    const writes = calls.filter(call => call.operation !== 'review-status'); expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ operation: 'review-coverage', bodyRef: data.bodyRef, projectionRevisionId: data.projection.revisionId, expectedGeneration: 0, expectedHeadEventId: null });
    const decisions = writes[0].decisions as { segmentId: string; status: string; reason: string; entityRefs: unknown[] }[];
    expect(decisions.map(decision => decision.status)).toEqual(['linked', 'no_reliable_object', 'gap', 'unknown']);
    expect(decisions[0].entityRefs).toEqual([{ analysisId: data.mapping.analysisId, entityRevisionId: data.mapping.entityRevisionId, entityId: data.mapping.entityId, mentionIds: data.mapping.mentionIds }]);
    expect(decisions.slice(1).every(decision => decision.entityRefs.length === 0 && !!decision.reason)).toBe(true);
    expect(calls.filter(call => call.operation === 'review-status').every(call => call.projectionRevisionId === data.projection.revisionId)).toBe(true);
  });

  it('keeps five use signals independent, requires evidence for benefit signals and targets the consumed historical body', async () => {
    const data = fixture(true), calls: Record<string, unknown>[] = [], query = 'Which conditions did the delivered old revision actually provide?';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { const call = JSON.parse(String(init.body)); calls.push(call); return response(call.operation === 'review-status' ? data.baseline : receiptFor(call)); }));
    render(<KnowledgeReviewDrawer detail={data.detail} workspace="/use-copy" lang="en" initialMode="use" segmentId="s2" query={query} onClose={vi.fn()}/>, { wrapper });
    await screen.findByRole('textbox', { name: 'Actual task reference' });
    expect((screen.getByRole('textbox', { name: 'Question at consumption' }) as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByText(/The five signals are independent/)).toBeTruthy();
    change('Actual task reference', 'task://actual-consumer/42'); change('Reason for this record', 'Record only the observed task/comparison signal.');
    expect(saveButton().disabled).toBe(false);
    await choose('Use signal', 'Read'); expect(saveButton().disabled).toBe(false);
    await choose('Use signal', 'Reported use'); expect(saveButton().disabled).toBe(false);
    await choose('Use signal', 'Observed help (evidence required)'); expect(saveButton().disabled).toBe(true);
    await choose('Use signal', 'Controlled effect (evidence required)'); expect(saveButton().disabled).toBe(true);
    change('Use evidence references', 'comparison://controlled-run/42');
    await choose('Use issue category', 'Content missing');
    const edit = screen.getByRole('link', { name: 'Edit this content in a new page' });
    const editParams = new URL(edit.getAttribute('href')!, 'http://localhost').searchParams;
    expect(editParams.get('id')).toBe(data.bodyRef.knowledgeId); expect(editParams.get('revision')).toBe(data.bodyRef.revisionId); expect(editParams.get('segment')).toBe('s2');
    fireEvent.click(saveButton()); await screen.findByText(/A save receipt identifies this review event/);
    const writes = calls.filter(call => call.operation !== 'review-status'); expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ operation: 'record-use', bodyRef: data.bodyRef, segmentIds: ['s2'], query,
      signal: 'controlled_effect', evidenceRefs: ['comparison://controlled-run/42'], evidence: [], issueKind: 'content_missing' });
    expect(writes[0]).not.toHaveProperty('actor'); expect(data.detail.history.writeHeadRevisionId).not.toBe(data.bodyRef.revisionId);
    expect(screen.getByText(/It does not establish truth or benefit/)).toBeTruthy();
  });

  it('preserves an unknown draft, normalizes nested review text and recovers a matching receipt with read-only checks and no resubmission', async () => {
    const data = fixture(), calls: Record<string, unknown>[] = []; let saved: KnowledgeReviewStatus | undefined, lookupsAfterWrite = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)); calls.push(call);
      if (call.operation === 'review-status') {
        if (!saved) return response(data.baseline);
        if (++lookupsAfterWrite === 1) return response({ error: 'knowledge_request_failed' }, 503);
        return response(saved);
      }
      const command = call as KnowledgeReviewContentInput & { workspace: string; operation: string }, receipt = receiptFor(call);
      const event: KnowledgeReviewEvent = { eventKind: 'content_review', eventId: receipt.eventId, parentEventId: command.expectedHeadEventId,
        bodyRef: command.bodyRef, sources: command.sources, actor, at, supersedesEventIds: command.supersedesEventIds ?? [],
        status: command.status, reason: command.reason.trim(), limitations: command.limitations.map(value => value.trim()),
        findings: command.findings.map(finding => ({ ...finding, description: finding.description.trim(), evidence: finding.evidence ?? [] })) };
      saved = { ...data.baseline, storageStatus: 'available', generation: 1, headEventId: event.eventId,
        history: { storeKind: 'knowledge-review-history', schemaVersion: 1, namespace: 'fixture', knowledgeId: data.bodyRef.knowledgeId,
          generation: 1, writeHeadEventId: event.eventId, events: [event], receipts: [receipt] }, content: { status: 'needs_revision', events: [event] } };
      return response({ error: 'knowledge_request_failed' }, 500);
    }));
    render(<KnowledgeReviewDrawer detail={data.detail} workspace="/unknown-copy" lang="en" onClose={vi.fn()}/>, { wrapper });
    await screen.findByRole('combobox', { name: 'Content review decision' });
    change('Reason for this record', '  Preserve uncertainty  '); fireEvent.click(screen.getByRole('button', { name: 'Add a finding' }));
    change('Finding 1 description', '  Missing preserved limits  ');
    fireEvent.click(screen.getByText('Original-source evidence (optional, 0 selected)', { exact: true }));
    change('Exact review quotation', ' Alpha '); fireEvent.click(screen.getByRole('button', { name: 'Add this exact evidence' }));
    fireEvent.click(saveButton());
    await screen.findByText(/The receipt could not be read/);
    expect((screen.getByRole('textbox', { name: 'Finding 1 description' }) as HTMLTextAreaElement).value).toBe('  Missing preserved limits  ');
    expect(saveButton().disabled).toBe(true); expect(screen.getByText(/The draft remains in this panel/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check request receipt (read-only)' }));
    await screen.findByText(/A save receipt identifies this review event/);
    const writes = calls.filter(call => call.operation !== 'review-status'); expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ operation: 'review-content', reason: 'Preserve uncertainty', supersedesEventIds: [],
      findings: [{ description: 'Missing preserved limits', segmentIds: [], evidence: [{ source, selection: { evidenceRef: 'record-1', quote: ' Alpha ', start: 0, end: 7 } }] }] });
    expect(calls.filter(call => call.operation === 'review-status')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Check request receipt (read-only)' })).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });
  it('preserves different exact source identities, positions and interpretations for equal quotations after content and use records are saved and reopened', async () => {
    const data = fixture(), calls: Record<string, unknown>[] = [], events: KnowledgeReviewEvent[] = [], receipts: KnowledgeReviewReceipt[] = [];
    const secondSource = { snapshotId: uuid(30), sourceVersion: `sha256:${'b'.repeat(64)}` };
    const firstWindow = data.detail.sources[0]; if (firstWindow.status !== 'available') throw new Error('Missing authored source.');
    const secondWindow = structuredClone(firstWindow.window);
    Object.assign(secondWindow, secondSource); secondWindow.excerpts = [{ evidenceRef: 'record-2', text: 'Original: Alpha context.', recordIndex: 0, eventKind: 'message', role: 'user' }];
    data.detail.sources.push({ status: 'available', window: secondWindow });
    data.detail.revision.content.segments[0].evidence.push({ source: secondSource, basis: 'source_assertion', selection: { evidenceRef: 'record-2', quote: 'Alpha', start: 10, end: 15 } });
    const baseline: KnowledgeReviewStatus = { ...data.baseline, sources: [...data.baseline.sources, { ...secondSource, status: 'available' }] };
    const current = (): KnowledgeReviewStatus => ({ ...baseline, storageStatus: events.length ? 'available' : 'absent', generation: events.length, headEventId: events.at(-1)?.eventId ?? null,
      history: events.length ? { storeKind: 'knowledge-review-history', schemaVersion: 1, namespace: 'fixture', knowledgeId: data.bodyRef.knowledgeId, generation: events.length,
        writeHeadEventId: events.at(-1)!.eventId, events: structuredClone(events), receipts: structuredClone(receipts) } : null,
      content: { status: events.some(event => event.eventKind === 'content_review') ? 'needs_revision' : 'not_reviewed', events: events.filter((event): event is Extract<KnowledgeReviewEvent, { eventKind: 'content_review' }> => event.eventKind === 'content_review') },
      usage: events.filter((event): event is Extract<KnowledgeReviewEvent, { eventKind: 'task_use' }> => event.eventKind === 'task_use') });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)); calls.push(call); if (call.operation === 'review-status') return response(current());
      const receipt = { ...receiptFor(call), eventId: uuid(70 + events.length) };
      const common = { eventId: receipt.eventId, parentEventId: call.expectedHeadEventId, bodyRef: call.bodyRef, sources: call.sources, actor, at, supersedesEventIds: call.supersedesEventIds, reason: call.reason };
      if (call.operation === 'review-content') events.push({ ...common, eventKind: 'content_review', status: call.status, limitations: call.limitations, findings: call.findings });
      else if (call.operation === 'record-use') events.push({ ...common, eventKind: 'task_use', taskRef: call.taskRef, query: call.query, segmentIds: call.segmentIds, signal: call.signal, evidenceRefs: call.evidenceRefs, evidence: call.evidence });
      else throw new Error('Unexpected authored review operation.');
      receipts.push(receipt); return response(receipt);
    }));
    async function addTwoSources() {
      fireEvent.click(screen.getByText('Original-source evidence (optional, 0 selected)', { exact: true }));
      change('Exact review quotation', 'Alpha'); change('Evidence interpretation (optional)', 'First-source assertion only.');
      fireEvent.click(screen.getByRole('button', { name: 'Add this exact evidence' }));
      await choose('Original message for review evidence', `Source 2 · ${secondSource.snapshotId.slice(0, 8)} · 0 · user · Original: Alpha context.`);
      await choose('Review evidence basis', 'Inference'); change('Exact review quotation', 'Alpha'); change('Evidence interpretation (optional)', 'Second-source inference; identity is unconfirmed.');
      fireEvent.click(screen.getByRole('button', { name: 'Add this exact evidence' }));
    }
    const content = render(<KnowledgeReviewDrawer detail={data.detail} workspace="/same-quote-copy" lang="en" onClose={vi.fn()}/>, { wrapper });
    await screen.findByRole('button', { name: 'Add a finding' }); fireEvent.click(screen.getByRole('button', { name: 'Add a finding' }));
    change('Finding 1 description', 'Keep the two sources distinct.'); change('Reason for this record', 'Review the exact equal quotations.');
    await addTwoSources(); fireEvent.click(saveButton()); await screen.findByText(/A save receipt identifies this review event/); content.unmount();
    const usage = render(<KnowledgeReviewDrawer detail={data.detail} workspace="/same-quote-copy" lang="en" initialMode="use" segmentId="s1" query="How should Alpha be interpreted?" onClose={vi.fn()}/>, { wrapper });
    await screen.findByRole('textbox', { name: 'Actual task reference' }); change('Actual task reference', 'task://equal-quotations'); change('Reason for this record', 'Reading does not merge these sources.');
    await choose('Use signal', 'Read'); await addTwoSources(); fireEvent.click(saveButton()); await screen.findByText(/A save receipt identifies this review event/); usage.unmount();
    render(<KnowledgeReviewDrawer detail={data.detail} workspace="/same-quote-copy" lang="en" onClose={vi.fn()}/>, { wrapper });
    const historySummary = await screen.findByText('Review and use history (including other content revisions)', { exact: true }); fireEvent.click(historySummary);
    const history = historySummary.closest('details')!;
    const savedEvidence = [...history.querySelectorAll<HTMLElement>('.knowledge-review-history-evidence')]; expect(savedEvidence).toHaveLength(4);
    for (const [index, element] of savedEvidence.entries()) {
      expect(within(element).getByText('Alpha', { selector: 'blockquote' })).toBeTruthy();
      fireEvent.click(within(element).getByText('Inspect saved source and exact quotation position', { exact: true }));
      const second = index % 2 === 1;
      expect(within(element).getByText(second ? secondSource.snapshotId : source.snapshotId, { selector: 'code' })).toBeTruthy();
      expect(within(element).getByText(second ? secondSource.sourceVersion : source.sourceVersion, { selector: 'code' })).toBeTruthy();
      expect(within(element).getByText(second ? 'record-2' : 'record-1', { selector: 'code' })).toBeTruthy();
      expect(within(element).getByText(second ? '10–15' : '1–6', { selector: 'code' })).toBeTruthy();
      expect(within(element).getByText(second ? 'Evidence basis: Inference' : 'Evidence basis: Source assertion')).toBeTruthy();
      expect(within(element).getByText(second ? 'Interpretation: Second-source inference; identity is unconfirmed.' : 'Interpretation: First-source assertion only.')).toBeTruthy();
    }
    expect(calls.filter(call => call.operation !== 'review-status').map(call => call.operation)).toEqual(['review-content', 'record-use']);
    expect(events[0].eventKind).toBe('content_review'); expect(events[1].eventKind).toBe('task_use');
  });

});
