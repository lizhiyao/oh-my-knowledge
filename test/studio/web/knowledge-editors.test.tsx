// @vitest-environment jsdom
import { act, useState, type PropsWithChildren } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryEditor } from '../../../src/studio/web/components/knowledge/library-editor';
import { ArtifactAuthoringDialog } from '../../../src/studio/web/components/knowledge/artifact-authoring';
import { KnowledgeRevisionDrawer } from '../../../src/studio/web/components/knowledge/revision-editor';
import { AssociationMappingDrawer } from '../../../src/studio/web/components/knowledge/association-mapping';
import { KnowledgeReader } from '../../../src/studio/web/components/knowledge/reader';
import { BodyEvidenceEditor, initialBodyCitations } from '../../../src/studio/web/components/knowledge/body-evidence-editor';
import { bodyDraft } from '../../knowledge/body-fixtures';
import { knowledgeBodyDigest } from '../../../src/knowledge/adapters/body-digest';
import { AutoExtractConversation } from '../../../src/studio/web/components/knowledge/auto-extraction';
import { KnowledgeInbox } from '../../../src/studio/web/components/knowledge/inbox';
import type { KnowledgeLibraryDetail } from '../../../src/studio/view-models/knowledge/knowledge-library';
import type { KnowledgeReaderSelection } from '../../../src/studio/web/components/knowledge/reader';
import type { AutoExtractionPreview, AutoExtractionState, KnowledgeAssociationCatalogs, KnowledgeEntityAnalysisDetail, KnowledgeEntityCatalog, KnowledgeEntityLibraryDetail, KnowledgeCandidateRow, KnowledgeCandidateDetail, KnowledgeCandidateQueue } from '../../../src/studio/view-models/knowledge/knowledge-candidates';
import type { ReviewedCarrierDraft, ReviewedCarrierDetail } from '../../../src/studio/view-models/knowledge/artifact-authoring';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-15T00:00:00Z';
const digest = `sha256:${'a'.repeat(64)}`;
const candidate: KnowledgeCandidateRow = { bodyDigest: digest, knowledgeId: uuid(50), revisionId: uuid(51), generation: 1,
  title: 'Confirmed knowledge', knowledgeKind: 'fact', reviewStatus: 'pending', choice: 'retain' };
function entity(name = 'Alpha', n = 1): KnowledgeEntityLibraryDetail {
  const value = { entityId: uuid(n), label: name, description: `${name} description`, qualifiers: [], identityStatus: 'proposed' as const,
    possibleEntityIds: [], uncertainties: [], referentKind: 'object' as const, componentRef: null, collection: null };
  const revision = { revisionId: uuid(100 + n), revisedAt: now, revisedBy: { actorKind: 'human' as const, actorId: 'reviewer' },
    revisionReason: 'Review evidence', limitations: [], entities: [value], mentions: [{ mentionId: uuid(200 + n), entityId: value.entityId,
      selection: { evidenceRef: 'record-1', start: 0, end: name.length, quote: name }, basis: 'explicit' as const, rationale: 'Name in original' }] };
  return { entity: value, revision,
    history: { storeKind: 'entity-analysis-history', schemaVersion: 2, analysisId: uuid(300 + n), snapshotId: uuid(400 + n), sourceVersion: digest,
      generation: 1, writeHeadRevisionId: revision.revisionId, revisions: [revision], receipts: [{ requestId: uuid(500 + n), commandDigest: digest, committedGeneration: 1, revisionId: revision.revisionId }] },
    source: { status: 'available', excerpts: [{ evidenceRef: 'record-1', text: name, recordIndex: 0, eventKind: 'message', role: 'user' }], limitations: [] },
    mentionChecks: [{ mentionId: uuid(200 + n), positionStatus: 'matched' }], knowledge: [], knowledgeStatus: 'available' };
}
function catalog(): KnowledgeEntityCatalog {
  const rows = [entity(), entity('Beta', 2)].map(value => ({ ...value.entity, analysisId: value.history.analysisId,
    revisionId: value.revision.revisionId, generation: 1, revisedAt: now, mentionCount: 1, surfaces: [value.entity.label],
    sourceStatus: 'available' as const, knowledgeCount: 0, outdatedKnowledgeCount: 0 }));
  return { rows, page: 1, pageSize: 10, total: rows.length, entityCount: rows.length, analysisCount: 2, unavailableAnalyses: 0, knowledgeStatus: 'available' };
}
function library(): KnowledgeLibraryDetail {
  const revision = { revisionId: uuid(60), draft: { label: 'Original name', description: 'Original description', referentKind: 'object' as const, members: [] },
    revisedAt: now, revisedBy: { actorKind: 'human' as const, actorId: 'reviewer' }, reason: 'Review' };
  return { history: { storeKind: 'knowledge-library-object-history', schemaVersion: 1, objectId: uuid(61), generation: 1,
    writeHeadRevisionId: revision.revisionId, revisions: [revision], receipts: [{ requestId: uuid(62), commandDigest: digest, committedGeneration: 1, revisionId: revision.revisionId }] },
    revision, members: [], knowledge: [], relatedEntities: [], knowledgeStatus: 'available', counts: { retained: 0, pending: 0, discarded: 0, needsReview: 0 } };
}
function carrierDraft(): ReviewedCarrierDraft {
  const refs = [{ knowledgeId: candidate.knowledgeId, revisionId: candidate.revisionId, generation: 1 }];
  return { artifactId: uuid(70), artifactKind: 'prompt', name: 'Reviewed prompt', directoryName: 'reviewed-prompt', source: { sourceKind: 'new' },
    baselineRevisionId: null, baselineHash: null, baseContent: '', content: 'Prepared content', knowledgeRefs: refs, selectedRefs: refs,
    tagSelections: [{ knowledgeId: candidate.knowledgeId, generation: 0 }], selectionChanges: [] };
}
function carrier(): ReviewedCarrierDetail {
  const draft = carrierDraft();
  return { schemaVersion: 'omk-carrier-v1', artifactId: draft.artifactId, artifactKind: draft.artifactKind, name: draft.name,
    directoryName: draft.directoryName, revisionId: uuid(71), version: 1, savedAt: now, knowledgeRefs: draft.selectedRefs,
    contentHash: digest, baseline: null, content: draft.content, locator: '/isolated/artifacts/prompt', artifactPath: '/isolated/artifacts/prompt.md',
    drifted: false, versions: [{ version: 1, revisionId: uuid(71), savedAt: now }],
    knowledgeReview: { referenceCount: 1, needsReviewCount: 0, unavailableCount: 0, checkedAt: now, checks: [] } };
}
interface Call { resource: string; operation: string; body: Record<string, unknown>; signal?: AbortSignal }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function api(override?: (call: Call) => Response | undefined | Promise<Response | undefined>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const call = { resource: url.split('/').at(-1)!, operation: String(body.operation), body, signal: init.signal ?? undefined };
    calls.push(call);
    const result = await override?.(call);
    if (result) return result;
    if (call.operation === 'entity-catalog') return json(catalog());
    if (call.operation === 'entity-detail') return json(body.entityId === uuid(2) ? entity('Beta', 2) : entity());
    if (call.operation === 'owners') return json([]);
    if (call.operation === 'list') return json(call.resource === 'candidates' ? [candidate] : []);
    if (call.operation === 'preview') { expect(call.body.artifactKind).toBe('prompt'); return json(carrierDraft()); }
    if (call.operation === 'show' || call.operation === 'save') return json(call.resource === 'library' ? library() : carrier());
    throw new Error(`Unexpected fixture request: ${call.resource}/${call.operation}`);
  }));
  return calls;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function wrapper({ children }: PropsWithChildren) { return <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>; }
function change(name: string, value: string) { fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } }); }
function confirmOrganization() {
  change('Reason for this revision', 'Checked original evidence');
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed evidence/ }));
}
const writes = (calls: Call[], resource: string) => calls.filter(call => call.resource === resource && call.operation === 'save');
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  push.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('conversation automation consent lifecycle', () => {
  it('requires fresh reviewed consent, ignores cancelled previews, and disposes an in-flight status poll on unmount', async () => {
    const calls: Call[] = [], previews = [deferred<Response>(), deferred<Response>(), deferred<Response>()], settings = deferred<Response>();
    const poll = deferred<Response>(), onChanged = vi.fn();
    const intervals = vi.spyOn(globalThis, 'setInterval'), clear = vi.spyOn(globalThis, 'clearInterval');
    let previewIndex = 0;
    const preview = (token: string, text: string): AutoExtractionPreview => ({ token, title: 'Synthetic conversation', turnCount: 1,
      messages: [{ evidenceRef: `preview-${token}`, recordIndex: 0, eventKind: 'message', role: 'user', text }], limitations: [] });
    const enabled: AutoExtractionState = { schemaVersion: 2, schemaStatus: 'current', workflowId: 'knowledge-body-first/v2', ledgerVersion: 'conversation-phase-invocations/v2', automationKind: 'conversation-knowledge-extraction', threadId: 'thread/a',
      owner: uuid(500), pid: 1, hostname: 'fixture', permissionId: uuid(501), executor: 'openai-api', model: 'reviewed-model',
      maxCalls: 2, callsUsed: 0, enabledAt: now, expiresAt: '2026-10-16T00:00:00Z', enabled: true, reason: 'waiting',
      checkedTurns: [], initialTurns: ['turn-0'], attemptedVersions: [] };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/settings') return settings.promise;
      expect(url).toBe('/api/knowledge/auto-extraction');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const call = { resource: 'auto-extraction', operation: String(body.operation), body, signal: init.signal ?? undefined };
      calls.push(call);
      if (call.operation === 'status') return calls.filter(item => item.operation === 'status').length === 1 ? json(null) : poll.promise;
      if (call.operation === 'preview') return previews[previewIndex++].promise;
      if (call.operation === 'enable') return json(enabled);
      throw new Error(`Unexpected automation operation: ${call.operation}`);
    }));
    const requests = (operation: string) => calls.filter(call => call.operation === operation);
    const dialog = () => screen.getByRole('dialog', { name: 'Confirm auto extraction for this conversation' });
    const approve = () => within(dialog()).getByRole('button', { name: /Approve and enable$/ });
    const consent = () => within(dialog()).getByRole('checkbox', { name: /Approve sending the initial and future windows/ }) as HTMLInputElement;
    const cancel = () => fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    const view = render(<AutoExtractConversation threadId="thread/a" lang="en" onChanged={onChanged}/>, { wrapper });
    expect(screen.getByRole('button', { name: 'Enable auto extraction' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Enable auto extraction' })); expect(requests('preview')).toHaveLength(0);
    await act(async () => settings.resolve(json({ effective: { workspace: '/initial', executor: 'openai-api', model: 'initial-model' } })));
    await waitFor(() => expect(requests('status')).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable auto extraction' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Enable auto extraction' }));
    await waitFor(() => expect(requests('preview')).toHaveLength(1));
    expect(approve().hasAttribute('disabled')).toBe(true); expect(consent().disabled).toBe(true);
    expect(requests('enable')).toHaveLength(0);
    cancel(); expect(requests('preview')[0].signal?.aborted).toBe(true);
    await act(async () => previews[0].resolve(json(preview('cancelled-token', 'Late cancelled preview'))));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Late cancelled preview')).toBeNull(); expect(requests('enable')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Enable auto extraction' }));
    await waitFor(() => expect(requests('preview')).toHaveLength(2));
    const unsafe = '<script>window.__omkAutoExecuted = true</script><img src=x onerror=alert(1)>';
    await act(async () => previews[1].resolve(json(preview('reviewed-but-cancelled-token', unsafe))));
    fireEvent.click(within(dialog()).getByText('Review initial content: 1 turns, 1 messages'));
    expect(within(dialog()).getByText(unsafe, { exact: false }).tagName).toBe('PRE');
    expect(dialog().querySelector('script, img')).toBeNull();
    expect(consent().checked).toBe(false); expect(approve().hasAttribute('disabled')).toBe(true);
    fireEvent.click(consent()); expect(approve().hasAttribute('disabled')).toBe(false);
    change('Candidate folder', ''); expect(approve().hasAttribute('disabled')).toBe(true);
    change('Candidate folder', ' /reviewed '); expect(approve().hasAttribute('disabled')).toBe(true);
    expect(consent().checked).toBe(false); fireEvent.click(consent());
    change('Model', ''); expect(approve().hasAttribute('disabled')).toBe(true);
    change('Model', ' reviewed-model '); expect(approve().hasAttribute('disabled')).toBe(true);
    expect(consent().checked).toBe(false); fireEvent.click(consent());
    fireEvent.change(within(dialog()).getByRole('spinbutton', { name: 'Maximum OMK invocations for this conversation permission' }), { target: { value: '2' } });
    fireEvent.blur(within(dialog()).getByRole('spinbutton', { name: 'Maximum OMK invocations for this conversation permission' }));
    expect(consent().checked).toBe(false); expect(approve().hasAttribute('disabled')).toBe(true);
    cancel(); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests('enable')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Enable auto extraction' }));
    await waitFor(() => expect(requests('preview')).toHaveLength(3));
    expect(consent().checked).toBe(false); expect(consent().disabled).toBe(true);
    expect(approve().hasAttribute('disabled')).toBe(true);
    await act(async () => previews[2].resolve(json(preview('fresh-token', 'Fresh reviewed preview'))));
    expect(consent().checked).toBe(false); expect(approve().hasAttribute('disabled')).toBe(true);
    expect(within(dialog()).getByText(/up to two model calls/)).toBeTruthy();
    fireEvent.click(consent()); fireEvent.click(approve()); fireEvent.click(approve());
    await screen.findByRole('button', { name: 'Stop auto extraction' });
    expect(requests('enable').map(call => call.body)).toEqual([{ operation: 'enable', workspace: '/reviewed', threadId: 'thread/a',
      token: 'fresh-token', executor: 'openai-api', model: 'reviewed-model', maxCalls: 2, workflowId: 'knowledge-body-first/v2' }]);
    expect(onChanged).toHaveBeenCalledTimes(2);
    const index = intervals.mock.calls.map(([, delay], index) => delay === 5000 ? index : -1).filter(index => index >= 0).at(-1)!;
    expect(index).toBeGreaterThanOrEqual(0);
    const callback = intervals.mock.calls[index][0], timer = intervals.mock.results[index].value;
    if (typeof callback !== 'function') throw new Error('Expected an automation polling callback');
    await act(async () => { callback(); });
    await waitFor(() => expect(requests('status')).toHaveLength(2));
    view.unmount();
    expect(clear).toHaveBeenCalledWith(timer); expect(requests('status')[1].signal?.aborted).toBe(true);
    await act(async () => poll.resolve(json({ ...enabled, callsUsed: 1 })));
    await act(async () => { callback(); });
    expect(requests('status')).toHaveLength(2); expect(requests('enable')).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
  it('skips inbox projections for unchanged status tags while preserving cooldown, stopped-state and maintenance visibility', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    let tag: string | null = 'W/"heads-1"', status: AutoExtractionState | null = null, statuses = 0, queues = 0;
    const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: tag ? { etag: tag } : {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/settings') return json({ effective: { workspace: '/poll-scope', executor: 'openai-api', model: 'fixture' } });
      const body = JSON.parse(String(init.body)) as { operation: string };
      if (url === '/api/knowledge/auto-extraction' && body.operation === 'status') { statuses++; return reply(status); }
      if (url === '/api/knowledge/candidates' && body.operation === 'queue') { queues++; return json({ rows: [], runs: [] }); }
      throw new Error(`Unexpected polling request: ${url}/${body.operation}`);
    }));
    function Inbox() {
      const [epoch, setEpoch] = useState(0);
      return <><AutoExtractConversation threadId="poll-thread" lang="en" onChanged={() => setEpoch(value => value + 1)}/>
        <KnowledgeInbox threadId="poll-thread" lang="en" refreshKey={epoch}/></>;
    }
    render(<Inbox/>, { wrapper });
    await screen.findByRole('button', { name: 'Knowledge inbox · 0 pending' });
    await waitFor(() => expect(intervals.mock.calls.some(([, delay]) => delay === 5000)).toBe(true));
    const callback = intervals.mock.calls.find(([, delay]) => delay === 5000)![0];
    if (typeof callback !== 'function') throw new Error('Expected polling callback');
    const poll = async () => { const before = statuses; await act(async () => { callback(); }); await waitFor(() => expect(statuses).toBe(before + 1)); };
    const initialProjections = queues;
    await poll(); await poll(); await poll();
    expect(queues).toBe(initialProjections); // Three unchanged five-second polls perform no queue projection.
    status = { schemaVersion: 2, schemaStatus: 'current', workflowId: 'knowledge-body-first/v2', ledgerVersion: 'conversation-phase-invocations/v2', automationKind: 'conversation-knowledge-extraction', threadId: 'poll-thread',
      owner: uuid(700), pid: 1, hostname: 'fixture', permissionId: uuid(701), executor: 'openai-api', model: 'fixture',
      maxCalls: 2, callsUsed: 1, enabledAt: now, expiresAt: '2026-10-16T00:00:00Z', enabled: true, reason: 'generating',
      checkedTurns: [], initialTurns: ['turn-0'], attemptedVersions: [] };
    tag = 'W/"heads-2"'; await poll(); await waitFor(() => expect(queues).toBe(initialProjections + 1));
    expect(screen.getByRole('status').textContent).toContain('Extracting · 1／2');
    status = { ...status, reason: 'waiting', notBefore: '2026-10-15T01:00:00Z' }; tag = 'W/"heads-3"'; await poll();
    await waitFor(() => expect(queues).toBe(initialProjections + 2));
    expect(screen.getByRole('status').textContent).toContain('Server cooldown until');
    status = { ...status, enabled: false, reason: 'stopped' }; tag = 'W/"heads-4"'; await poll();
    await waitFor(() => expect(queues).toBe(initialProjections + 3));
    await screen.findByRole('button', { name: 'Enable auto extraction' });
    await poll(); expect(queues).toBe(initialProjections + 3);
    // The JSON automation state is identical; an externally published knowledge head still invalidates the inbox.
    tag = 'W/"heads-5"'; await poll(); await waitFor(() => expect(queues).toBe(initialProjections + 4));
    const beforeEvent = statuses;
    await act(async () => { window.dispatchEvent(new CustomEvent('omk-knowledge-changed', { detail: '/poll-scope' })); });
    await waitFor(() => expect(queues).toBe(initialProjections + 5)); expect(statuses).toBe(beforeEvent);
    tag = null; await poll(); await waitFor(() => expect(queues).toBe(initialProjections + 6));
    await poll(); await waitFor(() => expect(queues).toBe(initialProjections + 7));
  });

  it('keeps incomplete inbox counts unknown through initial and embedded refreshes, then restores confirmed counts', async () => {
    const { detail } = citationFixture();
    let queue: KnowledgeCandidateQueue = { rows: [], runs: [{ runId: uuid(720), schemaStatus: 'unavailable', status: 'unavailable',
      unavailableReason: 'unreadable', nextAction: 'unavailable', bodies: [], phases: [], archiveChecks: [], archiveVerification: 'not_verified' }] };
    let requests = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/settings') return json({ effective: { workspace: '/partial-inbox', executor: 'openai-api', model: 'fixture' } });
      const body = JSON.parse(String(init.body)) as { operation: string };
      if (url === '/api/knowledge/candidates' && body.operation === 'queue') { requests++; return json(queue); }
      if (url === '/api/knowledge/candidates' && body.operation === 'show') return json(detail);
      throw new Error(`Unexpected inbox request: ${url}/${body.operation}`);
    }));
    render(<KnowledgeInbox threadId="partial-thread" lang="en"/>, { wrapper });
    const open = await screen.findByRole('button', { name: 'Knowledge inbox · Count unknown' });
    expect(screen.queryByRole('button', { name: /0 pending/ })).toBeNull();
    const beforeOpen = requests; fireEvent.click(open);
    await waitFor(() => expect(requests).toBeGreaterThanOrEqual(beforeOpen + 2));
    await screen.findByText(/This candidate list may be incomplete/);
    expect(screen.getByRole('button', { name: 'Knowledge inbox · Count unknown' })).toBeTruthy();
    expect(screen.getByText(/counts cannot be confirmed/)).toBeTruthy();
    expect(screen.queryByText(/0 candidates grouped by source/)).toBeNull();
    queue = { rows: [{ ...candidate, choice: null }], runs: [] };
    fireEvent.click(screen.getByRole('button', { name: 'Reload candidates' }));
    await screen.findByRole('button', { name: 'Knowledge inbox · 1 pending' });
    expect(screen.getByText(/1 candidates grouped by source/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Confirmed knowledge/ })).toBeTruthy();
    expect(screen.queryByText(/counts cannot be confirmed/)).toBeNull();
  });

  it('does not let an older status reply undo an explicit stop', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval'), poll = deferred<Response>(), changed = vi.fn();
    const enabled: AutoExtractionState = { schemaVersion: 2, schemaStatus: 'current', workflowId: 'knowledge-body-first/v2', ledgerVersion: 'conversation-phase-invocations/v2', automationKind: 'conversation-knowledge-extraction', threadId: 'stop-thread',
      owner: uuid(710), pid: 1, hostname: 'fixture', permissionId: uuid(711), executor: 'openai-api', model: 'fixture',
      maxCalls: 2, callsUsed: 0, enabledAt: now, expiresAt: '2026-10-16T00:00:00Z', enabled: true, reason: 'waiting',
      checkedTurns: [], initialTurns: [], attemptedVersions: [] };
    let statuses = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/settings') return json({ effective: { workspace: '/stop-scope', executor: 'openai-api', model: 'fixture' } });
      const body = JSON.parse(String(init.body)) as { operation: string };
      if (body.operation === 'status') return ++statuses === 1 ? new Response(JSON.stringify(enabled), { headers: { etag: 'W/"before-stop"' } }) : poll.promise;
      if (body.operation === 'stop') return json({ ...enabled, enabled: false, reason: 'stopped' });
      throw new Error(`Unexpected action: ${body.operation}`);
    }));
    render(<AutoExtractConversation threadId="stop-thread" lang="en" onChanged={changed}/>, { wrapper });
    await screen.findByRole('button', { name: 'Stop auto extraction' });
    await waitFor(() => expect(intervals.mock.calls.some(([, delay]) => delay === 5000)).toBe(true));
    const callback = intervals.mock.calls.find(([, delay]) => delay === 5000)![0];
    if (typeof callback !== 'function') throw new Error('Expected polling callback');
    await act(async () => { callback(); }); await waitFor(() => expect(statuses).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Stop auto extraction' }));
    await screen.findByRole('button', { name: 'Enable auto extraction' });
    await act(async () => poll.resolve(new Response(JSON.stringify(enabled), { headers: { etag: 'W/"old-running-head"' } })));
    expect(screen.getByRole('button', { name: 'Enable auto extraction' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Stopped'); expect(changed).toHaveBeenCalledTimes(1);
  });

  it('keeps one status poll in flight and ignores late replies from the previous conversation scope', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval'), old = deferred<Response>(), changed = vi.fn();
    const calls: Call[] = []; let firstOldStatus = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/settings') return json({ effective: { workspace: '/scope-isolation', executor: 'openai-api', model: 'fixture' } });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ resource: 'auto-extraction', operation: String(body.operation), body, signal: init.signal ?? undefined });
      if (body.threadId === 'old-thread' && !firstOldStatus) return old.promise;
      if (body.threadId === 'old-thread') firstOldStatus = false;
      return new Response('null', { headers: { etag: `W/"${String(body.threadId)}"` } });
    }));
    const view = render(<AutoExtractConversation threadId="old-thread" lang="en" onChanged={changed}/>, { wrapper });
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    // The initial status callback precedes the effect that installs polling.
    await waitFor(() => expect(intervals.mock.calls.some(([, delay]) => delay === 5000)).toBe(true));
    const callback = intervals.mock.calls.find(([, delay]) => delay === 5000)![0];
    if (typeof callback !== 'function') throw new Error('Expected polling callback');
    await act(async () => { callback(); callback(); });
    expect(calls.filter(call => call.body.threadId === 'old-thread')).toHaveLength(2);
    view.rerender(<AutoExtractConversation threadId="new-thread" lang="en" onChanged={changed}/>);
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(calls.filter(call => call.body.threadId === 'old-thread')[1].signal?.aborted).toBe(true);
    await act(async () => old.resolve(new Response('null', { headers: { etag: 'W/"late-old-head"' } })));
    expect(changed).toHaveBeenCalledTimes(2);
    await act(async () => { callback(); });
    expect(calls.filter(call => call.body.threadId === 'old-thread')).toHaveLength(2);
  });

});

describe('organization editor component lifecycle', () => {
  it('retries source reads, keeps the draft, and only links evidence after an explicit review', async () => {
    let catalogFailed = false; let sourceFailed = false;
    const calls = api(call => {
      if (call.operation === 'entity-catalog' && !catalogFailed) { catalogFailed = true; return json({}, 503); }
      if (call.operation === 'entity-detail' && !sourceFailed) { sourceFailed = true; return json({}, 503); }
    });
    render(<LibraryEditor workspace="/isolated" lang="en" onClose={vi.fn()} onSaved={vi.fn()}/>, { wrapper });
    const scope = screen.getByText(/Issue and PR concepts can be entities/);
    expect(scope.textContent).toContain('concrete Issue or PR records belong only in source or case context');
    expect(scope.textContent).toContain('identifiers and links in knowledge context');
    expect(scope.textContent).toContain('do not turn them into concepts by organizing or renaming them');
    expect(scope.textContent).toContain('Other source-supported concrete instances remain eligible');
    change('Object name', 'My draft');
    fireEvent.click(await screen.findByRole('button', { name: 'Reload source entities' }));
    fireEvent.click(await screen.findByRole('button', { name: /Alpha · Imported source/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload selected entity' }));
    await screen.findByRole('heading', { name: 'Alpha' });
    expect((screen.getByRole('textbox', { name: 'Object name' }) as HTMLInputElement).value).toBe('My draft');
    expect(screen.getByRole('button', { name: 'Save organization revision' }).hasAttribute('disabled')).toBe(true);
    expect(writes(calls, 'library')).toHaveLength(0);
    change('Rationale for this source link', 'Same named object in the source');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this source link' }));
    expect(screen.queryByRole('heading', { name: 'Alpha' })).toBeNull();
    expect(screen.getByText('Same named object in the source')).toBeTruthy();
    expect(writes(calls, 'library')).toHaveLength(0);
    confirmOrganization();
    fireEvent.click(screen.getByRole('button', { name: 'Save organization revision' }));
    await waitFor(() => expect(writes(calls, 'library')).toHaveLength(1));
    expect(writes(calls, 'library')[0].body.draft).toMatchObject({ label: 'My draft', members: [{
      analysisId: uuid(301), entityId: uuid(1), entityRevisionId: uuid(101), mentionIds: [uuid(201)], rationale: 'Same named object in the source',
    }] });
  });

  it('ignores a source response arriving after a different source was selected', async () => {
    const old = deferred<Response>(); let oldSignal: AbortSignal | undefined;
    api(call => { if (call.operation === 'entity-detail' && call.body.entityId === uuid(1)) { oldSignal = call.signal; return old.promise; } });
    render(<LibraryEditor workspace="/isolated" lang="en" onClose={vi.fn()} onSaved={vi.fn()}/>, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: /Alpha · Imported source/ }));
    fireEvent.click(screen.getByRole('button', { name: /Beta · Imported source/ }));
    await screen.findByRole('heading', { name: 'Beta' });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => old.resolve(json(entity())));
    expect(screen.queryByRole('heading', { name: 'Alpha' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Beta' })).toBeTruthy();
    change('Rationale for this source link', 'Use Beta only');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this source link' }));
    expect(screen.queryByText('Use Beta only')).not.toBeNull();
  });

  it('keeps edits and the original save baseline after a conflict and parent refresh', async () => {
    const calls = api(call => call.operation === 'save' ? json({ error: 'knowledge_conflict' }, 409) : undefined);
    const detail = library(); const onSaved = vi.fn();
    const props = { workspace: '/isolated', lang: 'en' as const, detail, onClose: vi.fn(), onSaved };
    const view = render(<LibraryEditor {...props}/>, { wrapper });
    change('Object name', 'Keep my edits'); confirmOrganization();
    fireEvent.click(screen.getByRole('button', { name: 'Save organization revision' }));
    await screen.findByText(/Object\/source changed/);
    const next = library(); next.history.generation = 2; next.history.writeHeadRevisionId = uuid(63); next.revision.draft.label = 'Background refresh';
    view.rerender(<LibraryEditor {...props} detail={next}/>);
    expect((screen.getByRole('textbox', { name: 'Object name' }) as HTMLInputElement).value).toBe('Keep my edits');
    expect(screen.getByRole('button', { name: 'Save organization revision' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed evidence/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save organization revision' }));
    await waitFor(() => expect(writes(calls, 'library')).toHaveLength(2));
    expect(writes(calls, 'library').map(call => [call.body.generation, call.body.headRevisionId])).toEqual([[1, uuid(60)], [1, uuid(60)]]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('freezes an unknown write and accepts only its original receipt, without a second write', async () => {
    const onSaved = vi.fn(); let receipt = '';
    const calls = api(call => {
      if (call.operation === 'save') return json({}, 502);
      if (call.operation === 'show') { const saved = library(); if (receipt) saved.history.receipts.push({ requestId: receipt, commandDigest: digest, committedGeneration: 2, revisionId: uuid(63) }); return json(saved); }
    });
    render(<LibraryEditor workspace="/isolated" lang="en" detail={library()} onClose={vi.fn()} onSaved={onSaved}/>, { wrapper });
    change('Object name', 'Frozen draft'); confirmOrganization();
    fireEvent.click(screen.getByRole('button', { name: 'Save organization revision' }));
    const inspect = await screen.findByRole('button', { name: 'Check saved version' });
    expect((screen.getByRole('textbox', { name: 'Object name' }) as HTMLInputElement).readOnly).toBe(true);
    fireEvent.click(inspect);
    await screen.findByText(/This save receipt was not found/);
    expect(onSaved).not.toHaveBeenCalled();
    receipt = String(writes(calls, 'library')[0].body.requestId);
    fireEvent.click(screen.getByRole('button', { name: 'Check saved version' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledExactlyOnceWith(uuid(61)));
    expect(writes(calls, 'library')).toHaveLength(1);
  });

  it('aborts a pending write on unmount and never calls back into a new workspace', async () => {
    const pending = deferred<Response>(); const onSaved = vi.fn();
    const calls = api(call => call.operation === 'save' ? pending.promise : undefined);
    const view = render(<LibraryEditor workspace="/old" lang="en" detail={library()} onClose={vi.fn()} onSaved={onSaved}/>, { wrapper });
    confirmOrganization(); fireEvent.click(screen.getByRole('button', { name: 'Save organization revision' }));
    await waitFor(() => expect(writes(calls, 'library')).toHaveLength(1));
    view.unmount();
    expect(writes(calls, 'library')[0].signal?.aborted).toBe(true);
    render(<LibraryEditor workspace="/new" lang="en" onClose={vi.fn()} onSaved={onSaved}/>, { wrapper });
    await act(async () => pending.resolve(json(library())));
    expect(onSaved).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'Object name' }) as HTMLInputElement).value).toBe('');
  });
});

describe('artifact editor component lifecycle', () => {
  function selectPrompt() {
    const input = screen.getByRole('combobox', { name: 'Artifact form' });
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40 });
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40 });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
  }

  async function preview() {
    change('Artifact name', 'Keep this name'); selectPrompt();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate and review' }));
    return screen.findByRole('textbox', { name: 'Artifact content' });
  }
  it('retries unreadable lists and preview without losing the name or selected knowledge', async () => {
    let loadFailed = false; let previewFailed = false;
    const calls = api(call => {
      if (call.operation === 'list' && call.resource === 'candidates' && !loadFailed) { loadFailed = true; return json({}, 503); }
      if (call.operation === 'preview' && !previewFailed) { previewFailed = true; return json({}, 503); }
    });
    render(<ArtifactAuthoringDialog workspace="/isolated" lang="en" ids={[candidate.knowledgeId]} onClose={vi.fn()}/>, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'Reload knowledge and artifacts' }));
    await screen.findByText('Confirmed knowledge');
    change('Artifact name', 'Keep this name'); selectPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Generate and review' }));
    await screen.findByText(/Operation failed/);
    expect((screen.getByRole('textbox', { name: 'Artifact name' }) as HTMLInputElement).value).toBe('Keep this name');
    fireEvent.click(screen.getByRole('button', { name: 'Generate and review' }));
    await screen.findByRole('textbox', { name: 'Artifact content' });
    expect(calls.filter(call => call.operation === 'preview').map(call => call.body.ids)).toEqual([[candidate.knowledgeId], [candidate.knowledgeId]]);
    expect(writes(calls, 'artifacts')).toHaveLength(0);
  });

  it('requires a readable saved baseline and explicitly retries it before generating', async () => {
    let failed = false;
    const calls = api(call => {
      if (call.operation === 'show' && !failed) { failed = true; return json({}, 503); }
      if (call.resource === 'artifacts' && call.operation === 'list') return json([carrier()]);
      if (call.operation === 'preview') {
        const draft = carrierDraft(); draft.source = { sourceKind: 'library', artifactId: uuid(70) };
        draft.baselineRevisionId = carrier().revisionId; draft.baselineHash = digest; draft.baseContent = carrier().content;
        return json(draft);
      }
    });
    render(<ArtifactAuthoringDialog workspace="/isolated" lang="en" existing={carrier()} onClose={vi.fn()}/>, { wrapper });
    const retry = await screen.findByRole('button', { name: 'Reload saved selection' });
    expect(screen.getByRole('button', { name: 'Generate and review' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate and review' }).hasAttribute('disabled')).toBe(false));
    expect((screen.getByRole('checkbox', { name: 'Confirmed knowledge' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Generate and review' }));
    await screen.findByRole('textbox', { name: 'Artifact content' });
    expect(calls.filter(call => call.operation === 'preview')[0].body.source).toEqual({ sourceKind: 'library', artifactId: uuid(70) });
    expect(writes(calls, 'artifacts')).toHaveLength(0);
  });

  it('aborts preview on unmount and ignores its late result in the next editor', async () => {
    const pending = deferred<Response>(); const onSaved = vi.fn();
    const calls = api(call => call.operation === 'preview' ? pending.promise : undefined);
    const view = render(<ArtifactAuthoringDialog workspace="/old" lang="en" ids={[candidate.knowledgeId]} onClose={vi.fn()} onSaved={onSaved}/>, { wrapper });
    await screen.findByText('Confirmed knowledge'); change('Artifact name', 'Old preview'); selectPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Generate and review' }));
    await waitFor(() => expect(calls.filter(call => call.operation === 'preview')).toHaveLength(1));
    view.unmount();
    expect(calls.find(call => call.operation === 'preview')?.signal?.aborted).toBe(true);
    render(<ArtifactAuthoringDialog workspace="/new" lang="en" onClose={vi.fn()} onSaved={onSaved}/>, { wrapper });
    await act(async () => pending.resolve(json(carrierDraft())));
    expect(screen.queryByRole('textbox', { name: 'Artifact content' })).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Artifact name' }) as HTMLInputElement).value).toBe('');
    expect(onSaved).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
  });

  it.each(['missing-ref', 'extra-ref', 'content', 'version', 'drifted'] as const)(
    'blocks duplicate saves and rejects %s acknowledgements until the original content and references match', async mismatch => {
    const onSaved = vi.fn(); const onClose = vi.fn(); let matches = false;
    const pending = deferred<Response>();
    const calls = api(call => {
      if (call.operation === 'save') return pending.promise;
      if (call.operation === 'show') {
        const saved = carrier(); saved.content = 'My reviewed content';
        if (!matches) {
          if (mismatch === 'missing-ref') saved.knowledgeRefs = [];
          if (mismatch === 'extra-ref') saved.knowledgeRefs.push({ knowledgeId: uuid(90), revisionId: uuid(91), generation: 1 });
          if (mismatch === 'content') saved.content = 'Different content';
          if (mismatch === 'version') saved.version = 2;
          if (mismatch === 'drifted') saved.drifted = true;
        }
        return json(saved);
      }
    });
    render(<ArtifactAuthoringDialog workspace="/isolated" lang="en" ids={[candidate.knowledgeId]} onClose={onClose} onSaved={onSaved}/>, { wrapper });
    await screen.findByText('Confirmed knowledge'); await preview();
    change('Artifact content', 'My reviewed content');
    const save = screen.getByRole('button', { name: 'Save artifact' });
    fireEvent.click(save); fireEvent.click(save);
    await waitFor(() => expect(writes(calls, 'artifacts')).toHaveLength(1));
    await act(async () => pending.resolve(json({}, 502)));
    const inspect = await screen.findByRole('button', { name: 'Check saved version' });
    const content = screen.getByRole('textbox', { name: 'Artifact content' }) as HTMLTextAreaElement;
    expect(content.value).toBe('My reviewed content'); expect(content.readOnly).toBe(true); expect(content.disabled).toBe(false);
    fireEvent.click(inspect);
    await screen.findByText(/Could not confirm this save/);
    expect(onSaved).not.toHaveBeenCalled();
    matches = true; fireEvent.click(screen.getByRole('button', { name: 'Check saved version' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1); expect(push).toHaveBeenCalledTimes(1);
    expect(writes(calls, 'artifacts')).toHaveLength(1);
    expect(writes(calls, 'artifacts')[0].body).toMatchObject({ workspace: '/isolated', content: 'My reviewed content', selectedRefs: carrierDraft().selectedRefs });
  });

  it('preserves conflicted content and requires a new preview before another save', async () => {
    const calls = api(call => call.operation === 'save' ? json({ error: 'carrier_conflict' }, 409) : undefined);
    render(<ArtifactAuthoringDialog workspace="/isolated" lang="en" ids={[candidate.knowledgeId]} onClose={vi.fn()}/>, { wrapper });
    await screen.findByText('Confirmed knowledge'); await preview(); change('Artifact content', 'Conflict draft');
    fireEvent.click(screen.getByRole('button', { name: 'Save artifact' }));
    await screen.findByText(/Knowledge or artifact changed/);
    expect((screen.getByRole('textbox', { name: 'Artifact content' }) as HTMLTextAreaElement).value).toBe('Conflict draft');
    expect(screen.getByRole('button', { name: 'Save artifact' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Back to selection' }));
    await screen.findByRole('textbox', { name: 'Artifact name' });
    expect(writes(calls, 'artifacts')).toHaveLength(1);
  });
});


function citationFixture(): { detail: KnowledgeCandidateDetail } {
  const base = bodyDraft();
  const quotation = 'Alpha 使用 Beta', text = `${quotation}；${quotation}\n<script>fixture only</script>`;
  const excerpts = [{ evidenceRef: 'record-1', text, recordIndex: 0, eventKind: 'message', role: 'user' },
    { evidenceRef: 'record-2', text: '纠正：Alpha 未使用 Beta', recordIndex: 1, eventKind: 'message', role: 'user' }];
  const source = { snapshotId: uuid(401), sourceVersion: digest };
  base.content.segments[0].evidence = [{ source, basis: 'source_assertion',
    selection: { evidenceRef: 'record-1', quote: quotation, start: quotation.length + 1, end: quotation.length * 2 + 1 } }];
  const revision: KnowledgeCandidateDetail['revision'] = { ...base, knowledgeId: candidate.knowledgeId, revisionId: candidate.revisionId,
    bodyDigest: knowledgeBodyDigest(base), observationRefs: [], derivations: [], createdAt: now, createdBy: { actorKind: 'human', actorId: 'reviewer' },
    revisedAt: now, revisedBy: { actorKind: 'human', actorId: 'reviewer' }, revisionReason: 'Original authored fixture' };
  return { detail: { revision, history: { storeKind: 'knowledge-item-history', schemaVersion: 3,
    namespace: 'fixture', knowledgeId: revision.knowledgeId, generation: 1, writeHeadRevisionId: revision.revisionId, revisions: [revision],
    maintenance: [], receipts: [{ requestId: uuid(900), commandDigest: digest, committedGeneration: 1, revisionId: revision.revisionId }] },
    reviewStatus: 'pending', maintenance: null, tagging: { generation: 0, tags: [] }, derivedCatalogs: [],
    derivedAssociations: { status: 'absent', reviewStatus: 'pending', bodyRef: { knowledgeId: revision.knowledgeId, revisionId: revision.revisionId, bodyDigest: revision.bodyDigest }, generation: 0, headRevisionId: null },
    sources: [{ status: 'available', window: { ...source, sourcePath: '/authored-fixture', sourceKind: 'codex',
      projectionVersion: 'knowledge-window-v2', capturedAt: now, startRecord: 0, endRecord: 1, excerpts,
      records: excerpts.map(excerpt => ({ recordIndex: excerpt.recordIndex, raw: JSON.stringify(excerpt) })), limitations: [] } }] } };
}

function associationFixture() {
  const { detail } = citationFixture(), analyzed = entity();
  const original: KnowledgeEntityAnalysisDetail = { history: analyzed.history, revision: analyzed.revision, source: analyzed.source };
  const current = structuredClone(original);
  current.revision = { ...current.revision, revisionId: uuid(1100), parentRevisionId: original.revision.revisionId,
    revisionReason: 'Corrected catalog', entities: [{ ...current.revision.entities[0], label: 'Alpha corrected' }, entity('Beta', 2).entity],
    mentions: [...current.revision.mentions, entity('Beta', 2).revision.mentions[0]] };
  current.history = { ...current.history, generation: 2, writeHeadRevisionId: current.revision.revisionId,
    revisions: [original.revision, current.revision], receipts: [...current.history.receipts, { requestId: uuid(1101), commandDigest: digest, committedGeneration: 2, revisionId: current.revision.revisionId }] };
  original.history = structuredClone(current.history);
  const bodyRef = detail.derivedAssociations.bodyRef;
  detail.derivedAssociations = { status: 'available', bodyRef, reviewStatus: 'accepted', generation: 3, headRevisionId: uuid(700), revision: {
    revisionId: uuid(700), bodyRef, status: 'available', reviewStatus: 'pending',
    catalogRefs: [{ analysisId: original.history.analysisId, entityRevisionId: original.revision.revisionId }],
    segmentEntityRefs: [{ segmentId: 's1', analysisId: original.history.analysisId, entityRevisionId: original.revision.revisionId, entityId: analyzed.entity.entityId, mentionIds: [original.revision.mentions[0].mentionId] }],
    typedRelations: [{ relationId: 'relation-1', segmentIds: ['s1'], subject: { analysisId: original.history.analysisId, entityRevisionId: original.revision.revisionId, entityId: analyzed.entity.entityId }, relation: 'uses the selected test configuration',
      modality: 'capability', polarity: 'positive', evidence: detail.revision.content.segments[0].evidence, issues: ['Not independently verified.'] }],
    issues: [], revisedAt: now, revisedBy: { actorKind: 'human', actorId: 'reviewer' }, revisionReason: 'Original mapping',
  } };
  detail.derivedCatalogs = [{ status: 'available', analysisId: original.history.analysisId, entityRevisionId: original.revision.revisionId,
    snapshotId: original.history.snapshotId, sourceVersion: original.history.sourceVersion,
    currentHeadRevisionId: current.revision.revisionId, entities: original.revision.entities, mentions: original.revision.mentions }];
  detail.maintenance = { revisionId: detail.revision.revisionId, choice: 'retain', reason: 'Maintain the body', actor: { actorKind: 'human', actorId: 'reviewer' }, at: now };
  detail.history.maintenance.push(detail.maintenance); detail.history.generation = 2;
  detail.history.receipts.push({ requestId: uuid(901), commandDigest: digest, committedGeneration: 2, revisionId: detail.revision.revisionId });
  return { detail, original, current };
}
function matchingCatalogs(detail: KnowledgeCandidateDetail, analysis: KnowledgeEntityAnalysisDetail): KnowledgeAssociationCatalogs {
  return { bodyRef: detail.derivedAssociations.bodyRef, unavailableAnalyses: 0,
    sources: [{ snapshotId: analysis.history.snapshotId, sourceVersion: analysis.history.sourceVersion, status: 'available' }],
    catalogs: [{ analysisId: analysis.history.analysisId, snapshotId: analysis.history.snapshotId, sourceVersion: analysis.history.sourceVersion,
      sourceSummary: { title: 'Selected conversation', sourceKind: 'codex', excerptCount: 2, firstRecordIndex: 0, lastRecordIndex: 1 },
      writeHeadRevisionId: analysis.history.writeHeadRevisionId, revisions: analysis.history.revisions.map(revision => ({ revisionId: revision.revisionId,
        revisionReason: revision.revisionReason, revisedAt: revision.revisedAt, entityCount: revision.entities.length, mentionCount: revision.mentions.length })) }] };
}

function multiCatalogFixture() {
  const { detail, original } = associationFixture();
  const second = structuredClone(original);
  second.history.analysisId = uuid(1201); second.history.snapshotId = uuid(1202);
  second.revision.entities[0].label = 'Alpha from another source';
  second.revision.mentions[0].rationale = 'The second source supplies this distinct catalog identity';
  const source = structuredClone(detail.sources[0]);
  if (source.status !== 'available') throw new Error('Expected a source fixture');
  source.window.snapshotId = second.history.snapshotId; source.window.origin = { threadId: 'second-thread', title: 'Second source' };
  detail.sources.push(source);
  const segment = structuredClone(detail.revision.content.segments[0]); segment.segmentId = 's2'; segment.text = 'A distinct source supports this second segment.';
  segment.evidence[0].source.snapshotId = second.history.snapshotId; detail.revision.content.segments.push(segment);
  detail.revision.bodyDigest = knowledgeBodyDigest(detail.revision); detail.derivedAssociations.bodyRef.bodyDigest = detail.revision.bodyDigest;
  const ref = { analysisId: second.history.analysisId, entityRevisionId: second.revision.revisionId };
  detail.derivedAssociations.revision!.catalogRefs.push(ref);
  detail.derivedAssociations.revision!.segmentEntityRefs.push({ segmentId: 's2', ...ref, entityId: second.revision.entities[0].entityId, mentionIds: [second.revision.mentions[0].mentionId] });
  detail.derivedCatalogs.push({ status: 'available', ...ref, currentHeadRevisionId: second.history.writeHeadRevisionId,
    snapshotId: second.history.snapshotId, sourceVersion: second.history.sourceVersion, entities: second.revision.entities, mentions: second.revision.mentions });
  const catalogs = matchingCatalogs(detail, original), other = matchingCatalogs(detail, second);
  catalogs.catalogs.push(...other.catalogs); catalogs.sources.push(...other.sources);
  return { detail, original, second, catalogs };
}

describe('independent entity mapping review', () => {
  it('keeps identical local entity and mention IDs separate across catalogs and degrades only the missing catalog', () => {
    const { detail, original, second } = multiCatalogFixture();
    const inspectEntity = vi.fn();
    const view = render(<KnowledgeReader detail={detail} lang="en" workspace="/multi-catalog" onEntity={inspectEntity} onRevision={vi.fn()} onRetry={vi.fn()}/>, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Entities and associations' }));
    expect(screen.getByText(/Associated entity: Alpha from another source/)).toBeTruthy();
    const secondSegment = view.container.querySelector<HTMLElement>('[data-segment-id="s2"]')!;
    fireEvent.click(within(secondSegment).getByRole('button', { name: 'Inspect this entity' }));
    expect(inspectEntity).toHaveBeenLastCalledWith({ analysisId: second.history.analysisId, entityRevisionId: second.revision.revisionId, entityId: second.revision.entities[0].entityId });
    fireEvent.click(within(secondSegment).getByRole('button', { name: 'Inspect this mention in its source' }));
    expect(screen.getByText(/The second source supplies this distinct catalog identity/)).toBeTruthy();
    expect(view.container.querySelector('mark')?.textContent).toBe('Alpha');
    expect(screen.getByText(new RegExp(second.history.snapshotId))).toBeTruthy();
    detail.derivedCatalogs[1] = { status: 'unavailable', analysisId: second.history.analysisId, entityRevisionId: second.revision.revisionId, reason: 'catalog_unavailable' };
    view.rerender(<KnowledgeReader detail={detail} lang="en" workspace="/multi-catalog" onEntity={inspectEntity} onRevision={vi.fn()} onRetry={vi.fn()} selection={{ tab: 'associations' }}/ >);
    expect(screen.getByText(/Catalog unavailable; other catalogs and content remain inspectable/)).toBeTruthy();
    expect(within(view.container.querySelector<HTMLElement>('[data-segment-id="s1"]')!).getByRole('button', { name: 'Inspect this mention in its source' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(original.revision.mentions[0].selection.quote, { selector: 'blockquote' })).toBeTruthy();
  });

  it('explicitly removes the last catalog and saves empty pending mappings with the frozen body and projection baseline', async () => {
    const { detail, original } = associationFixture();
    const saved = structuredClone(detail); saved.derivedAssociations.reviewStatus = 'pending';
    saved.derivedAssociations.revision!.catalogRefs = []; saved.derivedAssociations.revision!.segmentEntityRefs = []; saved.derivedCatalogs = [];
    const received = vi.fn();
    const calls = api(call => call.operation === 'association-catalogs' ? json(matchingCatalogs(detail, original))
      : call.operation === 'entities' ? json(original) : call.operation === 'apply-associations' ? json(saved) : undefined);
    render(<AssociationMappingDrawer detail={detail} workspace="/empty-catalog" lang="en" onClose={vi.fn()} onSaved={received} onReadback={vi.fn()}/>, { wrapper });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load current entity revision' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Load bound revision' }));
    await screen.findByRole('group', { name: `Segment 1 / ${original.revision.entities[0].entityId}` });
    fireEvent.click(screen.getByRole('button', { name: 'Remove catalog 1 and its mappings' }));
    expect(screen.queryByRole('combobox', { name: 'Entities for segment 1' })).toBeNull();
    const submit = screen.getByRole('button', { name: 'Save pending mappings' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    change('Mapping reason', 'Explicitly clear derived mappings while preserving canonical content');
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save entity mappings only/ }));
    fireEvent.click(submit);
    await waitFor(() => expect(received).toHaveBeenCalledOnce());
    expect(calls.find(call => call.operation === 'apply-associations')!.body).toMatchObject({ id: detail.revision.knowledgeId,
      revision: detail.revision.revisionId, bodyDigest: detail.revision.bodyDigest, generation: 3, draft: { catalogRefs: [], segmentEntityRefs: [], issues: [] } });
    expect(saved.revision).toEqual(detail.revision); expect(saved.maintenance).toEqual(detail.maintenance);
  });

  it('preserves selections from both source catalogs while switching and removes only the explicitly chosen catalog', async () => {
    const { detail, original, second, catalogs } = multiCatalogFixture();
    const received = vi.fn();
    const calls = api(call => call.operation === 'association-catalogs' ? json(catalogs)
      : call.operation === 'entities' ? json(call.body.analysisId === second.history.analysisId ? second : original)
        : call.operation === 'apply-associations' ? json(detail) : undefined);
    render(<AssociationMappingDrawer detail={detail} workspace="/multi-catalog" lang="en" onClose={vi.fn()} onSaved={received} onReadback={vi.fn()}/>, { wrapper });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load current entity revision' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Load bound revision 1' }));
    await screen.findByRole('group', { name: `Segment 1 / ${original.revision.entities[0].entityId}` });
    expect(screen.getByRole('combobox', { name: 'Entities for segment 2' }).closest('.ant-select')?.className).toContain('ant-select-disabled');
    fireEvent.click(screen.getByRole('button', { name: 'Load bound revision 2' }));
    await screen.findByRole('group', { name: `Segment 2 / ${second.revision.entities[0].entityId}` });
    expect((screen.getByRole('checkbox', { name: /^Alpha / }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByText(/1 mappings/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Load bound revision 1' }));
    await screen.findByRole('group', { name: `Segment 1 / ${original.revision.entities[0].entityId}` });
    fireEvent.click(screen.getByRole('button', { name: 'Remove catalog 1 and its mappings' }));
    change('Mapping reason', 'Keep only the explicitly checked second source catalog');
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save entity mappings only/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save pending mappings' }));
    await waitFor(() => expect(calls.filter(call => call.operation === 'apply-associations')).toHaveLength(1));
    expect(calls.find(call => call.operation === 'apply-associations')!.body).toMatchObject({ generation: 3,
      draft: { catalogRefs: [{ analysisId: second.history.analysisId, entityRevisionId: second.revision.revisionId }], segmentEntityRefs: [{ segmentId: 's2', analysisId: second.history.analysisId, entityRevisionId: second.revision.revisionId, entityId: second.revision.entities[0].entityId, mentionIds: [second.revision.mentions[0].mentionId] }], issues: [] } });
    expect(detail.derivedAssociations.revision!.catalogRefs).toHaveLength(2);
  });

  it('follows a controlled segment and mention into the exact original span and back without replacing the bound entity revision', () => {
    const { detail, original } = associationFixture(), onEntity = vi.fn();
    function View() {
      const [selection, setSelection] = useState<KnowledgeReaderSelection>({ tab: 'associations', segmentId: 's1', mentionId: original.revision.mentions[0].mentionId });
      return <KnowledgeReader detail={detail} lang="en" workspace="/reader-fixture" selection={selection} onSelectionChange={setSelection}
        onEntity={onEntity} onRevision={vi.fn()} onRetry={vi.fn()}/>;
    }
    const view = render(<View/>, { wrapper });
    expect(view.container.querySelector(`[data-mention-id="${original.revision.mentions[0].mentionId}"]`)?.getAttribute('data-focused')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect this entity' }));
    expect(onEntity).toHaveBeenCalledWith({ analysisId: original.history.analysisId, entityRevisionId: original.revision.revisionId, entityId: original.revision.entities[0].entityId });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect this mention in its source' }));
    expect(screen.getByRole('button', { name: 'Evidence' }).getAttribute('aria-pressed')).toBe('true');
    expect(view.container.querySelector('mark')?.textContent).toBe('Alpha');
    expect(screen.getByText(/00000000-0000-4000-8000-000000000401/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Return to this content segment' }));
    expect(view.container.querySelector('[data-segment-id="s1"]')?.getAttribute('data-focused')).toBe('true');
    expect(screen.getByText(detail.revision.content.segments[0].text)).toBeTruthy();
  });

  it('does not substitute a nearby quotation when a graph selection names a different exact evidence identity', () => {
    const { detail } = associationFixture();
    const view = render(<KnowledgeReader detail={detail} lang="en" onRevision={vi.fn()} onRetry={vi.fn()} selection={{ tab: 'evidence',
      evidence: { snapshotId: uuid(999), sourceVersion: digest, evidenceRef: 'record-1', start: 0, end: 5 } }}/>, { wrapper });
    expect(screen.getByText(/requested exact evidence is absent/)).toBeTruthy();
    expect(view.container.querySelector('mark')).toBeNull();
  });

  it('preserves the selected mention rationale and return segment when another segment cites the same source span', () => {
    const { detail, original } = associationFixture();
    const mention = { ...original.revision.mentions[0], basis: 'inference' as const, rationale: 'The second segment identifies the referent from this mention' };
    const second = { ...structuredClone(detail.revision.content.segments[0]), segmentId: 's2', text: 'A second claim uses the interpreted referent.' };
    detail.revision.content.segments[0].evidence = [{ source: { snapshotId: original.history.snapshotId, sourceVersion: original.history.sourceVersion },
      selection: mention.selection, basis: 'direct_observation', interpretation: 'The first segment directly quotes the same source span' }];
    detail.revision.content.segments.push(second);
    detail.revision.bodyDigest = knowledgeBodyDigest(detail.revision);
    detail.derivedAssociations.bodyRef.bodyDigest = detail.revision.bodyDigest;
    detail.derivedAssociations.revision!.segmentEntityRefs = [{ segmentId: 's2', analysisId: original.history.analysisId, entityRevisionId: original.revision.revisionId, entityId: mention.entityId, mentionIds: [mention.mentionId] }];
    if (detail.derivedCatalogs[0].status !== 'available') throw new Error('Expected an available fixture catalog');
    detail.derivedCatalogs[0].mentions = [mention];
    function View() {
      const [selection, setSelection] = useState<KnowledgeReaderSelection>({ tab: 'associations', segmentId: 's2', mentionId: mention.mentionId });
      return <KnowledgeReader detail={detail} lang="en" selection={selection} onSelectionChange={setSelection} onRevision={vi.fn()} onRetry={vi.fn()}/>;
    }
    const view = render(<View/>, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect this mention in its source' }));
    expect(screen.getByText(`Inference · ${mention.rationale}`)).toBeTruthy();
    expect(screen.queryByText(/Direct observation · The first segment/)).toBeNull();
    expect(view.container.querySelector('mark')?.textContent).toBe('Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Return to this content segment' }));
    expect(view.container.querySelector('[data-segment-id="s2"]')?.getAttribute('data-focused')).toBe('true');
    expect(view.container.querySelector('[data-segment-id="s1"]')?.getAttribute('data-focused')).toBe('false');
    expect(screen.getByText(second.text)).toBeTruthy();
  });

  it.each(['s1', 's2'])('keeps relation evidence semantics and returns to %s when canonical citations share its exact span', segmentId => {
    const { detail, original } = associationFixture();
    const shared = { source: { snapshotId: original.history.snapshotId, sourceVersion: original.history.sourceVersion }, selection: original.revision.mentions[0].selection };
    detail.revision.content.segments[0].evidence = [{ ...shared, basis: 'direct_observation', interpretation: 'Direct source citation for the first segment' }];
    detail.revision.content.segments.push({ segmentId: 's2', text: 'The second segment interprets a relation from the same quote.',
      evidence: [{ ...shared, basis: 'source_assertion', interpretation: 'Canonical assertion for the second segment' }] });
    detail.revision.bodyDigest = knowledgeBodyDigest(detail.revision);
    detail.derivedAssociations.bodyRef.bodyDigest = detail.revision.bodyDigest;
    const relation = { ...detail.derivedAssociations.revision!.typedRelations![0], segmentIds: ['s1', 's2'],
      evidence: [{ ...shared, basis: 'inference' as const, interpretation: 'The relationship is inferred independently from the quoted name' }] };
    detail.derivedAssociations.revision!.typedRelations = [relation];
    const changed = vi.fn();
    function View() {
      const [selection, setSelection] = useState<KnowledgeReaderSelection>({ tab: 'associations', segmentId, relationId: relation.relationId });
      return <KnowledgeReader detail={detail} lang="en" selection={selection} onSelectionChange={next => { changed(next); setSelection(next); }} onRevision={vi.fn()} onRetry={vi.fn()}/>;
    }
    const view = render(<View/>, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect this relation evidence in its source' }));
    expect(changed).toHaveBeenLastCalledWith({ tab: 'evidence', segmentId, mentionId: undefined, relationId: relation.relationId,
      evidence: { ...shared.source, evidenceRef: shared.selection.evidenceRef, start: shared.selection.start, end: shared.selection.end } });
    expect(screen.getByText(`Inference · ${relation.evidence[0].interpretation}`)).toBeTruthy();
    expect(screen.queryByText(/Direct observation · Direct source citation/)).toBeNull();
    expect(screen.queryByText(/Source assertion · Canonical assertion/)).toBeNull();
    expect(view.container.querySelector('mark')?.textContent).toBe('Alpha');
    expect(screen.getByText(relation.relationId, { selector: 'code' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Return to this content segment' }));
    expect(view.container.querySelector(`[data-segment-id="${segmentId}"]`)?.getAttribute('data-focused')).toBe('true');
    expect(view.container.querySelector(`[data-segment-id="${segmentId === 's1' ? 's2' : 's1'}"]`)?.getAttribute('data-focused')).toBe('false');
  });

  it.each(['segment', 'mention', 'relation'] as const)('does not fall back to a matching source span when the explicit %s target is missing', target => {
    const { detail } = associationFixture(), citation = detail.revision.content.segments[0].evidence[0];
    const view = render(<KnowledgeReader detail={detail} lang="en" onRevision={vi.fn()} onRetry={vi.fn()} selection={{ tab: 'evidence',
      segmentId: target === 'segment' ? 'missing-segment' : 's1', ...(target === 'mention' ? { mentionId: 'missing-mention' } : {}), ...(target === 'relation' ? { relationId: 'missing-relation' } : {}),
      evidence: { ...citation.source, evidenceRef: citation.selection.evidenceRef, start: citation.selection.start, end: citation.selection.end } }}/>, { wrapper });
    expect(screen.getByText(/requested exact evidence is absent/)).toBeTruthy();
    expect(view.container.querySelector('mark')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Return to this content segment' })).toBeNull();
  });

  it('shows the exact bound segment, entity, mention and typed evidence instead of substituting the current catalog', () => {
    const { detail } = associationFixture();
    render(<KnowledgeReader detail={detail} lang="en" onRevision={vi.fn()} onRetry={vi.fn()} onReviewAssociations={vi.fn()}/>, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Entities and associations' }));
    expect(screen.getByText(detail.revision.content.segments[0].text)).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByText('Alpha corrected')).toBeNull();
    expect(screen.getByText('Alpha 使用 Beta')).toBeTruthy();
    expect(screen.getByText(/uses the selected test configuration/)).toBeTruthy();
    expect(screen.getByText(/capability \/ positive/)).toBeTruthy();
    expect(screen.getByText(/The catalog has a newer revision/)).toBeTruthy();
    expect(screen.getByText('Not independently verified.')).toBeTruthy();
  });

  it('explicitly loads a corrected catalog and saves only selected owned mentions against the frozen projection generation', async () => {
    const { detail, current } = associationFixture(), received = vi.fn();
    const saved = structuredClone(detail);
    saved.derivedAssociations = { ...saved.derivedAssociations, reviewStatus: 'pending', generation: 4, headRevisionId: uuid(701),
      revision: { ...saved.derivedAssociations.revision!, revisionId: uuid(701), parentRevisionId: uuid(700),
        catalogRefs: [{ analysisId: current.history.analysisId, entityRevisionId: current.revision.revisionId }], segmentEntityRefs: [{ segmentId: 's1', analysisId: current.history.analysisId, entityRevisionId: current.revision.revisionId, entityId: current.revision.entities[0].entityId, mentionIds: [current.revision.mentions[0].mentionId] }], typedRelations: undefined } };
    saved.derivedCatalogs = [{ status: 'available', analysisId: current.history.analysisId, entityRevisionId: current.revision.revisionId,
      snapshotId: current.history.snapshotId, sourceVersion: current.history.sourceVersion,
      currentHeadRevisionId: current.revision.revisionId, entities: current.revision.entities, mentions: current.revision.mentions }];
    const calls = api(call => call.operation === 'association-catalogs' ? json(matchingCatalogs(detail, current))
      : call.operation === 'entities' ? json(current) : call.operation === 'apply-associations' ? json(saved) : undefined);
    function View({ value }: { value: KnowledgeCandidateDetail }) {
      const [editing, setEditing] = useState(false), [result, setResult] = useState<KnowledgeCandidateDetail>();
      return <><KnowledgeReader detail={result ?? value} lang="en" onRevision={vi.fn()} onRetry={vi.fn()} onMapAssociations={() => setEditing(true)}/>
        {editing && <AssociationMappingDrawer detail={value} workspace="/mapping-fixture" lang="en" onClose={() => setEditing(false)} onReadback={vi.fn()}
          onSaved={next => { received(next); setResult(next); setEditing(false); }}/>}</>;
    }
    const view = render(<View value={detail}/>, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Entities and associations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit entity mappings' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load current entity revision' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Remove catalog 1 and its mappings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load current entity revision' }));
    const select = await screen.findByRole('combobox', { name: 'Entities for segment 1' });
    expect(screen.queryByRole('checkbox', { name: /^Alpha / })).toBeNull();
    fireEvent.mouseDown(select);
    fireEvent.click(await screen.findByText('Alpha corrected · Alpha description'));
    const mentions = screen.getByRole('group', { name: `Segment 1 / ${current.revision.entities[0].entityId}` });
    expect(within(mentions).queryByRole('checkbox', { name: /^Beta/ })).toBeNull();
    fireEvent.click(within(mentions).getByRole('checkbox', { name: /^Alpha / }));
    change('Mapping reason', 'Checked corrected entity and exact mention');
    const saveButton = screen.getByRole('button', { name: 'Save pending mappings' });
    expect(saveButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save entity mappings only/ }));
    const refreshed = structuredClone(detail); refreshed.derivedAssociations.generation = 99;
    view.rerender(<View value={refreshed}/>);
    fireEvent.click(saveButton);
    await waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    const requests = calls.filter(call => call.operation === 'apply-associations');
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({ revision: detail.revision.revisionId, bodyDigest: detail.revision.bodyDigest, generation: 3,
      draft: { catalogRefs: [{ analysisId: current.history.analysisId, entityRevisionId: current.revision.revisionId }], segmentEntityRefs: [{ segmentId: 's1', analysisId: current.history.analysisId, entityRevisionId: current.revision.revisionId, entityId: current.revision.entities[0].entityId, mentionIds: [current.revision.mentions[0].mentionId] }], issues: [] } });
    expect(requests[0].body.draft).not.toHaveProperty('typedRelations');
    expect(received.mock.calls[0][0].revision).toEqual(detail.revision);
    expect(received.mock.calls[0][0].maintenance).toEqual(detail.maintenance);
    expect(screen.getByText('Association review: Pending')).toBeTruthy();
    expect(detail.derivedAssociations.revision?.typedRelations).toHaveLength(1);
    expect(calls.filter(call => call.operation === 'association-catalogs').map(call => call.body)).toEqual([
      { workspace: '/mapping-fixture', operation: 'association-catalogs', id: detail.revision.knowledgeId, revision: detail.revision.revisionId },
    ]);
    expect(calls.some(call => call.operation === 'rebuild-associations')).toBe(false);
    expect(screen.getByText(saved.derivedAssociations.revision!.revisionId, { selector: 'code' })).toBeTruthy();
  });

  it('keeps the original binding inspectable through an unreadable directory and preserves the draft while retrying exact-source candidates', async () => {
    const { detail, original } = associationFixture(); let attempts = 0;
    const available = matchingCatalogs(detail, original); available.unavailableAnalyses = 1;
    available.sources.push({ snapshotId: uuid(450), sourceVersion: digest, status: 'available' });
    const calls = api(call => call.operation === 'association-catalogs' ? ++attempts === 1 ? json({}, 503) : json(available)
      : call.operation === 'entities' ? json(original) : undefined);
    render(<AssociationMappingDrawer detail={detail} workspace="/mapping-fixture" lang="en" onClose={vi.fn()} onSaved={vi.fn()} onReadback={vi.fn()}/>, { wrapper });
    await screen.findByText(/Matching entity analyses could not be read/);
    expect(screen.queryByRole('textbox', { name: 'Entity analysis ID' })).toBeNull();
    change('Mapping reason', 'Preserve this checked reason');
    fireEvent.click(screen.getByRole('button', { name: 'Load bound revision' }));
    await screen.findByRole('group', { name: `Segment 1 / ${original.revision.entities[0].entityId}` });
    expect((screen.getByRole('checkbox', { name: /^Alpha / }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save entity mappings only/ }));
    expect(screen.getByRole('button', { name: 'Save pending mappings' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reload analysis catalog' }));
    await screen.findByText(/catalog coverage is incomplete/);
    expect(screen.getAllByText(/Selected conversation · codex · 2 source messages · 2 entities/).length).toBeGreaterThan(0);
    expect(screen.getByText(/No readable exact-source analysis/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Mapping reason' }) as HTMLTextAreaElement).value).toBe('Preserve this checked reason');
    expect(calls.find(call => call.operation === 'entities')!.body).toMatchObject({ analysisId: original.history.analysisId, revision: original.revision.revisionId });
    expect(calls.filter(call => call.operation === 'apply-associations')).toHaveLength(0);
  });

  it.each([409, 503])('preserves the mapping draft after %s and reads a new projection without resending the frozen command', async status => {
    const { detail, original } = associationFixture(), saved = vi.fn(), readback = vi.fn();
    const latest = structuredClone(detail); latest.derivedAssociations.generation = 4; latest.derivedAssociations.headRevisionId = uuid(705);
    latest.derivedAssociations.revision!.revisionId = uuid(705); latest.derivedAssociations.reviewStatus = 'pending';
    const calls = api(call => call.operation === 'association-catalogs' ? json(matchingCatalogs(detail, original))
      : call.operation === 'entities' ? json(original) : call.operation === 'apply-associations' ? json({ error: status === 409 ? 'knowledge_conflict' : 'internal_failure' }, status)
        : call.operation === 'show' ? json(latest) : undefined);
    const view = render(<AssociationMappingDrawer detail={detail} workspace="/mapping-fixture" lang="en" onClose={vi.fn()} onSaved={saved} onReadback={readback}/>, { wrapper });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load current entity revision' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Load bound revision' }));
    await screen.findByRole('combobox', { name: 'Entities for segment 1' });
    change('Mapping reason', 'Checked original binding');
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save entity mappings only/ }));
    const refreshed = structuredClone(detail); refreshed.derivedAssociations.generation = 99;
    view.rerender(<AssociationMappingDrawer detail={refreshed} workspace="/mapping-fixture" lang="en" onClose={vi.fn()} onSaved={saved} onReadback={readback}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Save pending mappings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check latest knowledge (read-only)' }));
    await screen.findByText('Latest revision loaded');
    expect((screen.getByRole('textbox', { name: 'Mapping reason' }) as HTMLTextAreaElement).value).toBe('Checked original binding');
    expect(screen.getByRole('button', { name: 'Save pending mappings' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save pending mappings' }));
    expect(calls.filter(call => call.operation === 'apply-associations')).toHaveLength(1);
    expect(calls.find(call => call.operation === 'apply-associations')!.body).toMatchObject({ generation: 3, revision: detail.revision.revisionId, bodyDigest: detail.revision.bodyDigest });
    expect(saved).not.toHaveBeenCalled(); expect(readback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close draft and inspect this revision' }));
    expect(readback).toHaveBeenCalledWith(latest);
  });
});

const revisionEntries = ['revise'] as const;
function citationEditor(_entry: typeof revisionEntries[number], detail: KnowledgeCandidateDetail, onSaved = vi.fn(), onReadback = vi.fn()) {
  const props = { workspace: '/citation-fixture', detail, lang: 'en' as const, onClose: vi.fn(), onSaved, onReadback };
  return <KnowledgeRevisionDrawer {...props}/>;
}
function revisionSaveButton(entry: typeof revisionEntries[number]) {
  return screen.getByRole('button', { name: entry === 'revise' ? /Save new revision$/ : /Review and save a new knowledge revision$/ });
}
function revisionReason(entry: typeof revisionEntries[number]) { change(entry === 'revise' ? 'Revision reason' : 'Reason for applying', 'Checked exact original quotations'); }

// Both entry points share one controlled locator form and the same conservative acknowledgement lifecycle.
describe('knowledge citation revision editors', () => {
  it('renders exact saved quotations and accessible source/occurrence fields in both languages without executing source markup', () => {
    const { detail } = citationFixture();
    expect(initialBodyCitations(detail)[0].selection).toEqual({ evidenceRef: 'record-1', quote: 'Alpha 使用 Beta', occurrence: 1 });
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToStaticMarkup(<BodyEvidenceEditor detail={detail} draft={detail.revision}
        value={initialBodyCitations(detail)} readOnly={false} lang={lang} onChange={() => {}}/>);
      expect(html).toContain(lang === 'zh' ? '来源与引文' : 'Sources and citations');
      expect(html).toContain(lang === 'zh' ? '出现序号（从 0 开始）' : 'Occurrence (starting at 0)');
      expect(html).toContain('&lt;script&gt;fixture only&lt;/script&gt;'); expect(html).not.toContain('<script>');
      expect(html).toContain(lang === 'zh' ? '原始消息（只读）' : 'Original message (read-only)');
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const original = parsed.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${lang === 'zh' ? '原始消息（只读）' : 'Original message (read-only)'}"]`);
      expect(original?.readOnly).toBe(true); expect(original?.disabled).toBe(false);
    }
  });
  it.each(revisionEntries)('%s preserves failed drafts, sends a complete locator replacement and freezes its original baseline', async entry => {
    const { detail } = citationFixture(), pending = deferred<Response>(), saved = vi.fn();
    const calls = api(call => call.operation === entry
      ? calls.filter(value => value.operation === entry).length === 1 ? pending.promise : json(detail) : undefined);
    const view = render(citationEditor(entry, detail, saved), { wrapper });
    await screen.findByRole('textbox', { name: 'Citation 1' });
    change('Citation 1', 'Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Add a citation to segment 1' }));
    change('Citation 2', '<script>fixture only</script>');
    fireEvent.click(screen.getByRole('button', { name: 'Add a citation to segment 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove citation 3' }));
    revisionReason(entry);
    const refreshed = structuredClone(detail); refreshed.history.generation = 7;
    view.rerender(citationEditor(entry, refreshed, saved));
    fireEvent.click(revisionSaveButton(entry));
    expect(revisionSaveButton(entry).hasAttribute('disabled')).toBe(true);
    fireEvent.click(revisionSaveButton(entry));
    await waitFor(() => expect(calls.filter(call => call.operation === entry)).toHaveLength(1));
    expect((screen.getByRole('textbox', { name: 'Citation 1' }) as HTMLTextAreaElement).readOnly).toBe(true);
    const command = calls.find(call => call.operation === entry)!.body;
    expect(command.generation).toBe(1);
    const evidence = (command.draft as KnowledgeCandidateDetail['revision']).content.segments[0].evidence;
    expect(evidence.map(item => item.selection)).toEqual([
      { evidenceRef: 'record-1', quote: 'Alpha', start: 14, end: 19 },
      { evidenceRef: 'record-1', quote: '<script>fixture only</script>', start: 28, end: 57 },
    ]);
    expect(command).not.toHaveProperty('citationLocators');
    await act(async () => pending.resolve(json({ error: 'knowledge_citations_invalid', detail: '/private/secret-source' }, 400)));
    await screen.findByText(/Invalid citations. Check the source, exact quotation and occurrence/);
    expect(document.body.textContent).not.toContain('/private/secret-source');
    expect((screen.getByRole('textbox', { name: 'Citation 1' }) as HTMLTextAreaElement).value).toBe('Alpha');
    expect((screen.getByRole('textbox', { name: 'Citation 1' }) as HTMLTextAreaElement).readOnly).toBe(false);
    expect(revisionSaveButton(entry).hasAttribute('disabled')).toBe(false);
    fireEvent.click(revisionSaveButton(entry));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(calls.filter(call => call.operation === entry)).toHaveLength(2);
  });
  it.each(revisionEntries.flatMap(entry => [409, 503].map(status => ({ entry, status }))))('$entry freezes $status outcomes and only reads current knowledge without another write', async ({ entry, status }) => {
    const { detail } = citationFixture(), saved = vi.fn(), readback = vi.fn();
    const latest = structuredClone(detail); latest.revision.revisionId = uuid(901); latest.revision.revisionReason = 'New persisted revision';
    const calls = api(call => call.operation === entry
      ? json({ error: status === 409 ? 'knowledge_conflict' : '/private/raw-server-error' }, status)
      : call.operation === 'show' ? json(latest) : undefined);
    render(citationEditor(entry, detail, saved, readback), { wrapper });
    await screen.findByRole('textbox', { name: 'Citation 1' });
    change('Knowledge segment 1', 'Preserved source draft'); revisionReason(entry);
    fireEvent.click(revisionSaveButton(entry));
    await screen.findByRole('button', { name: 'Check latest knowledge (read-only)' });
    expect(revisionSaveButton(entry).hasAttribute('disabled')).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Citation 1' }) as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Knowledge segment 1' }) as HTMLTextAreaElement).value).toBe('Preserved source draft');
    expect(document.body.textContent).not.toContain('/private/raw-server-error');
    fireEvent.click(revisionSaveButton(entry));
    fireEvent.click(screen.getByRole('button', { name: 'Check latest knowledge (read-only)' }));
    await screen.findByText('Latest revision loaded');
    expect(saved).not.toHaveBeenCalled(); expect(calls.filter(call => call.operation === entry)).toHaveLength(1);
    expect(calls.filter(call => call.operation === 'show').map(call => call.body)).toEqual([{ workspace: '/citation-fixture', operation: 'show', id: detail.revision.knowledgeId }]);
    fireEvent.click(screen.getByRole('button', { name: 'Close draft and inspect this revision' }));
    expect(readback).toHaveBeenCalledWith(latest); expect(saved).not.toHaveBeenCalled();
  });
  it.each(revisionEntries)('%s discards late write and readback responses after unmount without resending', async entry => {
    const { detail } = citationFixture(), saved = vi.fn(), readback = vi.fn(), pendingWrite = deferred<Response>();
    const first = api(call => call.operation === entry ? pendingWrite.promise : undefined);
    const writer = render(citationEditor(entry, detail, saved, readback), { wrapper });
    await screen.findByRole('textbox', { name: 'Citation 1' }); revisionReason(entry);
    fireEvent.click(revisionSaveButton(entry));
    await waitFor(() => expect(first.filter(call => call.operation === entry)).toHaveLength(1));
    expect(first.find(call => call.operation === entry)!.body).not.toHaveProperty('citationLocators');
    writer.unmount(); expect(first.find(call => call.operation === entry)!.signal?.aborted).toBe(true);
    await act(async () => pendingWrite.resolve(json(detail)));
    expect(saved).not.toHaveBeenCalled(); expect(readback).not.toHaveBeenCalled();

    const pendingRead = deferred<Response>();
    const second = api(call => call.operation === entry ? json({}, 503) : call.operation === 'show' ? pendingRead.promise : undefined);
    const reader = render(citationEditor(entry, detail, saved, readback), { wrapper });
    await screen.findByRole('textbox', { name: 'Citation 1' }); revisionReason(entry); fireEvent.click(revisionSaveButton(entry));
    fireEvent.click(await screen.findByRole('button', { name: 'Check latest knowledge (read-only)' }));
    await waitFor(() => expect(second.filter(call => call.operation === 'show')).toHaveLength(1));
    reader.unmount(); expect(second.find(call => call.operation === 'show')!.signal?.aborted).toBe(true);
    await act(async () => pendingRead.resolve(json(detail)));
    expect(saved).not.toHaveBeenCalled(); expect(readback).not.toHaveBeenCalled();
    expect(second.filter(call => call.operation === entry)).toHaveLength(1);
  });

});
