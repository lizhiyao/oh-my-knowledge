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
import { EntityAnalysisEditor } from '../../../src/studio/web/components/knowledge/entity-analysis';
import { bodyDraft } from '../../knowledge/body-fixtures';
import { fileSourceFixture, traceSourceFixture, sourceSummaryFixture } from './source-fixture';
import { knowledgeBodyDigest } from '../../../src/knowledge/adapters/body-digest';
import { AutoExtractConversation } from '../../../src/studio/web/components/knowledge/auto-extraction';
import { KnowledgeInbox } from '../../../src/studio/web/components/knowledge/inbox';
import type { KnowledgeLibraryDetail } from '../../../src/studio/view-models/knowledge/knowledge-library';
import type { KnowledgeReaderSelection } from '../../../src/studio/web/components/knowledge/reader';
import type { KnowledgeAssociationCatalogs, KnowledgeEntityAnalysisDetail, KnowledgeEntityCatalog, KnowledgeEntityLibraryDetail, KnowledgeCandidateRow, KnowledgeCandidateDetail, KnowledgeCandidateQueue } from '../../../src/studio/view-models/knowledge/knowledge-candidates';
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
    source: { status: 'available', snapshot: traceSourceFixture({ snapshotId: uuid(400 + n), sourceVersion: digest }, [{ evidenceRef: 'record-1', text: name, recordIndex: 0, eventKind: 'message', role: 'user' }]) },
    mentionChecks: [{ mentionId: uuid(200 + n), positionStatus: 'matched' }], knowledge: [], knowledgeStatus: 'available' };
}
function catalog(): KnowledgeEntityCatalog {
  const rows = [entity(), entity('Beta', 2)].map(value => ({ ...value.entity, analysisId: value.history.analysisId,
    revisionId: value.revision.revisionId, generation: 1, revisedAt: now, mentionCount: 1, surfaces: [value.entity.label],
    sourceStatus: 'available' as const, source: value.source.status === 'available' ? sourceSummaryFixture(value.source.snapshot) : undefined, knowledgeCount: 0, outdatedKnowledgeCount: 0 }));
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

it('maps textarea LF selections back to original CRLF offsets and locates saved mentions after emoji without changing source text', async () => {
  const value = entity(), text = '😀 Alpha\r\nBeta Alpha', start = text.lastIndexOf('Alpha');
  const snapshot = fileSourceFixture({ snapshotId: value.history.snapshotId, sourceVersion: value.history.sourceVersion }, text);
  const revised = { ...value.revision, mentions: [{ ...value.revision.mentions[0], selection: { evidenceRef: snapshot.excerpts[0].evidenceRef, start, end: start + 5, quote: 'Alpha' } }] };
  const changed = vi.fn();
  render(<EntityAnalysisEditor detail={{ ...value, revision: revised, source: { status: 'available', snapshot } }} draft={revised} editable lang="en" onChange={changed}/>, { wrapper });
  fireEvent.click(screen.getByRole('button', { name: 'Locate source' }));
  const field = await screen.findByRole('textbox', { name: 'Source text; select text to add a mention' }) as HTMLTextAreaElement;
  expect(field.value).toBe(text.replace(/\r\n/gu, '\n')); expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe('Alpha');
  expect(field.selectionStart).toBe(start - 1);
  const betaStart = field.value.indexOf('Beta'); field.setSelectionRange(betaStart, betaStart + 4); fireEvent.select(field);
  fireEvent.click(screen.getByRole('button', { name: 'Add selected text as a mention' }));
  const saved = changed.mock.calls.at(-1)![0] as Pick<KnowledgeEntityAnalysisDetail['revision'], 'entities' | 'mentions'>;
  expect(saved.mentions.at(-1)?.selection).toEqual({ evidenceRef: snapshot.excerpts[0].evidenceRef, start: text.indexOf('Beta'), end: text.indexOf('Beta') + 4, quote: 'Beta' });
  expect(snapshot.excerpts[0].text).toBe(text); expect(value.revision.mentions[0].selection.start).toBe(0);
});

describe('explicit conversation extraction and knowledge inbox', () => {
  it('shows stage confirmation guidance without automatic grants, model controls, polling or background reads', () => {
    const fetch = vi.fn(), intervals = vi.spyOn(globalThis, 'setInterval'), changed = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const view = render(<AutoExtractConversation threadId="old-thread" lang="en" onChanged={changed}/>);
    expect(screen.getByRole('status').textContent).toBe('Extraction requires confirmation at each stage; automatic extraction is disabled.');
    expect(screen.queryByRole('button')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull();
    view.rerender(<AutoExtractConversation threadId="new-thread" lang="zh" onChanged={changed}/>);
    expect(screen.getByRole('status').textContent).toBe('需逐阶段确认，不再自动提炼。');
    view.unmount();
    expect(fetch).not.toHaveBeenCalled(); expect(intervals).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });

  it('refreshes the inbox after explicit extraction or scoped maintenance without an automation poll', async () => {
    let queues = 0, queue: KnowledgeCandidateQueue = { rows: [], runs: [] };
    const changed = vi.fn(), calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push(url);
      if (url === '/api/settings') return json({ effective: { workspace: '/explicit-inbox', executor: 'openai-api', model: 'fixture' } });
      const body = JSON.parse(String(init.body)) as { operation: string };
      if (url === '/api/knowledge/candidates' && body.operation === 'queue') { queues++; return json(queue); }
      throw new Error(`Unexpected inbox request: ${url}/${body.operation}`);
    }));
    const content = (refreshKey: number) => <><AutoExtractConversation threadId="explicit-thread" lang="en" onChanged={changed}/>
      <KnowledgeInbox threadId="explicit-thread" lang="en" refreshKey={refreshKey}/></>;
    const view = render(content(0), { wrapper });
    await screen.findByRole('button', { name: 'Knowledge inbox · 0 pending' });
    const initial = queues;
    await act(async () => { window.dispatchEvent(new CustomEvent('omk-knowledge-changed', { detail: '/another-workspace' })); });
    expect(queues).toBe(initial);
    queue = { rows: [{ ...candidate, choice: null }], runs: [] };
    await act(async () => { window.dispatchEvent(new CustomEvent('omk-knowledge-changed', { detail: '/explicit-inbox' })); });
    await screen.findByRole('button', { name: 'Knowledge inbox · 1 pending' });
    expect(queues).toBe(initial + 1);
    queue = { rows: [], runs: [] }; view.rerender(content(1));
    await screen.findByRole('button', { name: 'Knowledge inbox · 0 pending' });
    expect(queues).toBe(initial + 2);
    expect(calls).not.toContain('/api/knowledge/auto-extraction'); expect(changed).not.toHaveBeenCalled();
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
    fireEvent.click(await screen.findByRole('button', { name: /Alpha · Agent trace/ }));
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
    fireEvent.click(await screen.findByRole('button', { name: /Alpha · Agent trace/ }));
    fireEvent.click(screen.getByRole('button', { name: /Beta · Agent trace/ }));
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
    sources: [{ status: 'available', snapshot: traceSourceFixture(source, excerpts) }] } };
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

/** JSDOM has no layout: keep source positions relative to the reader's own viewport. */
function mockReaderLayout() {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('.knowledge-reader-scroll')) return new DOMRect(0, 100, 640, 200);
    const pane = this.closest<HTMLElement>('.knowledge-reader-scroll');
    if (pane && this.matches('.knowledge-source mark')) {
      return new DOMRect(0, 600 + (this.previousSibling?.textContent?.length ?? 0) * 4 - pane.scrollTop, 640, 360);
    }
    return original.call(this);
  });
  return vi.spyOn(window, 'scrollTo');
}
function expectSourceStartVisible(container: HTMLElement, quote: string) {
  const pane = container.querySelector<HTMLElement>('.knowledge-reader-scroll')!;
  const mark = pane.querySelector('mark')!;
  expect(mark.textContent).toBe(quote);
  expect(mark.getBoundingClientRect().top).toBeGreaterThanOrEqual(pane.getBoundingClientRect().top);
  expect(mark.getBoundingClientRect().top).toBeLessThan(pane.getBoundingClientRect().bottom);
  expect(pane.scrollTop).toBeGreaterThan(0);
  return pane;
}
function matchingCatalogs(detail: KnowledgeCandidateDetail, analysis: KnowledgeEntityAnalysisDetail): KnowledgeAssociationCatalogs {
  return { bodyRef: detail.derivedAssociations.bodyRef, unavailableAnalyses: 0,
    sources: [{ snapshotId: analysis.history.snapshotId, sourceVersion: analysis.history.sourceVersion, status: 'available' }],
    catalogs: [{ analysisId: analysis.history.analysisId, snapshotId: analysis.history.snapshotId, sourceVersion: analysis.history.sourceVersion,
      sourceSummary: sourceSummaryFixture(traceSourceFixture({ snapshotId: analysis.history.snapshotId, sourceVersion: analysis.history.sourceVersion }, [{ evidenceRef: 'record-1', text: 'Alpha', recordIndex: 0, eventKind: 'message' }], { origin: { threadId: 'thread', title: 'Selected conversation' } })),
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
  source.snapshot.snapshotId = second.history.snapshotId; if (source.snapshot.sourceKind === 'agent_trace') source.snapshot.origin = { threadId: 'second-thread', title: 'Second source' };
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
  async function chooseRelationOption(name: string, label: string | RegExp) {
    const input = screen.getByRole('combobox', { name });
    fireEvent.mouseDown(input);
    fireEvent.click(await screen.findByText(label, { selector: '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content' }));
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    fireEvent.blur(input);
  }
  function confirmMapping() {
    change('Mapping reason', 'Checked exact entities, relation meaning and source evidence');
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save mappings and the relations/ }));
  }

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
    expect(screen.getAllByText(new RegExp(second.history.snapshotId)).length).toBeGreaterThan(0);
    detail.derivedCatalogs[1] = { status: 'unavailable', analysisId: second.history.analysisId, entityRevisionId: second.revision.revisionId, reason: 'catalog_unavailable' };
    view.rerender(<KnowledgeReader detail={detail} lang="en" workspace="/multi-catalog" onEntity={inspectEntity} onRevision={vi.fn()} onRetry={vi.fn()} selection={{ tab: 'associations' }}/ >);
    expect(screen.getByText(/Catalog unavailable; other catalogs and content remain inspectable/)).toBeTruthy();
    expect(within(view.container.querySelector<HTMLElement>('[data-segment-id="s1"]')!).getByRole('button', { name: 'Inspect this mention in its source' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(original.revision.mentions[0].selection.quote, { selector: 'blockquote' })).toBeTruthy();
  });

  it('explicitly removes the last catalog and saves empty pending mappings with the frozen body and projection baseline', async () => {
    const { detail, original } = associationFixture();
    const saved = structuredClone(detail); saved.derivedAssociations.reviewStatus = 'pending';
    saved.derivedAssociations.revision!.catalogRefs = []; saved.derivedAssociations.revision!.segmentEntityRefs = []; saved.derivedAssociations.revision!.typedRelations = []; saved.derivedCatalogs = [];
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
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save mappings and the relations/ }));
    expect(submit.hasAttribute('disabled')).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Description for relation 1' }) as HTMLTextAreaElement).value).toBe('uses the selected test configuration');
    fireEvent.click(screen.getByRole('button', { name: 'Remove relation 1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save mappings and the relations/ }));
    fireEvent.click(submit);
    await waitFor(() => expect(received).toHaveBeenCalledOnce());
    expect(calls.find(call => call.operation === 'apply-associations')!.body).toMatchObject({ id: detail.revision.knowledgeId,
      revision: detail.revision.revisionId, bodyDigest: detail.revision.bodyDigest, generation: 3, draft: { catalogRefs: [], segmentEntityRefs: [], typedRelations: [], issues: [] } });
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
    fireEvent.click(screen.getByRole('button', { name: 'Remove relation 1' }));
    change('Mapping reason', 'Keep only the explicitly checked second source catalog');
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save mappings and the relations/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save pending mappings' }));
    await waitFor(() => expect(calls.filter(call => call.operation === 'apply-associations')).toHaveLength(1));
    expect(calls.find(call => call.operation === 'apply-associations')!.body).toMatchObject({ generation: 3,
      draft: { catalogRefs: [{ analysisId: second.history.analysisId, entityRevisionId: second.revision.revisionId }], segmentEntityRefs: [{ segmentId: 's2', analysisId: second.history.analysisId, entityRevisionId: second.revision.revisionId, entityId: second.revision.entities[0].entityId, mentionIds: [second.revision.mentions[0].mentionId] }], issues: [] } });
    expect(detail.derivedAssociations.revision!.catalogRefs).toHaveLength(2);
  });

  it('edits a relation while preserving its exact subset quote, inference and both levels of issues', async () => {
    const { detail, original } = associationFixture(), received = vi.fn();
    const relation = detail.derivedAssociations.revision!.typedRelations![0], citation = detail.revision.content.segments[0].evidence[0];
    relation.evidence = [{ ...citation, basis: 'inference', interpretation: 'The relation is inferred from this specific mention.',
      selection: { ...citation.selection, end: citation.selection.start + 5, quote: 'Alpha' } }];
    detail.derivedAssociations.revision!.issues = ['The source only reports this historical configuration.'];
    const unchanged = structuredClone(detail), saved = structuredClone(detail);
    saved.derivedAssociations.reviewStatus = 'pending'; saved.derivedAssociations.generation = 4;
    saved.derivedAssociations.revision!.typedRelations![0] = { ...structuredClone(relation), relation: 'does not permit using Beta', modality: 'permission', polarity: 'negative' };
    const calls = api(call => call.operation === 'association-catalogs' ? json(matchingCatalogs(detail, original))
      : call.operation === 'apply-associations' ? json(saved) : undefined);
    render(<AssociationMappingDrawer detail={detail} workspace="/relations" lang="en" onClose={vi.fn()} onSaved={received} onReadback={vi.fn()}/>, { wrapper });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load current entity revision' }).hasAttribute('disabled')).toBe(false));
    expect(screen.getByText(/Inference · The relation is inferred/)).toBeTruthy();
    change('Description for relation 1', 'does not permit using Beta');
    await chooseRelationOption('Modality for relation 1', 'Permission');
    await chooseRelationOption('Polarity for relation 1', 'Negative');
    confirmMapping();
    fireEvent.click(screen.getByRole('button', { name: 'Save pending mappings' }));
    await waitFor(() => expect(received).toHaveBeenCalledWith(saved));
    const draft = calls.find(call => call.operation === 'apply-associations')!.body.draft;
    expect(draft).toMatchObject({ typedRelations: saved.derivedAssociations.revision!.typedRelations, issues: unchanged.derivedAssociations.revision!.issues });
    expect(detail).toEqual(unchanged);
    expect(saved.revision).toEqual(unchanged.revision); expect(saved.maintenance).toEqual(unchanged.maintenance);
  });

  it('adds a relation across catalog-qualified entities only after explicit segment, endpoint and evidence choices', async () => {
    const { detail, original, second, catalogs } = multiCatalogFixture(), received = vi.fn();
    const calls = api(call => call.operation === 'association-catalogs' ? json(catalogs)
      : call.operation === 'apply-associations' ? json(detail) : undefined);
    render(<AssociationMappingDrawer detail={detail} workspace="/multi-relations" lang="en" onClose={vi.fn()} onSaved={received} onReadback={vi.fn()}/>, { wrapper });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load current entity revision' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add an entity relation' }));
    change('Description for relation 2', 'is compared with'); confirmMapping();
    expect(screen.getByRole('button', { name: 'Save pending mappings' }).hasAttribute('disabled')).toBe(true);
    await chooseRelationOption('Segments for relation 2', /^1 · /);
    await chooseRelationOption('Segments for relation 2', /^2 · /);
    await chooseRelationOption('Subject for relation 2', /^Alpha · Catalog 1/);
    await chooseRelationOption('Object for relation 2', /^Alpha from another source · Catalog 2/);
    await chooseRelationOption('Evidence for relation 2', /^Source 1 · Agent trace · Source record 0/);
    await chooseRelationOption('Evidence for relation 2', /^Source 2 · Second source · Source record 0/);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save mappings and the relations/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save pending mappings' }));
    await waitFor(() => expect(received).toHaveBeenCalledOnce());
    const draft = calls.find(call => call.operation === 'apply-associations')!.body.draft as { typedRelations: NonNullable<NonNullable<KnowledgeCandidateDetail['derivedAssociations']['revision']>['typedRelations']> };
    expect(draft.typedRelations).toHaveLength(2);
    expect(draft.typedRelations[0]).toEqual(detail.derivedAssociations.revision!.typedRelations![0]);
    expect(draft.typedRelations[1]).toMatchObject({ segmentIds: ['s1', 's2'], relation: 'is compared with', modality: 'descriptive', polarity: 'positive',
      subject: { analysisId: original.history.analysisId, entityRevisionId: original.revision.revisionId, entityId: original.revision.entities[0].entityId },
      object: { analysisId: second.history.analysisId, entityRevisionId: second.revision.revisionId, entityId: second.revision.entities[0].entityId },
      evidence: detail.revision.content.segments.flatMap(segment => segment.evidence), issues: [] });
    expect(draft.typedRelations[1].relationId).toMatch(/^[\da-f-]{36}$/);
    expect(calls.some(call => call.operation === 'rebuild-associations')).toBe(false);
  });

  it.each([undefined, []])('preserves untouched relationship request intent %j while saving mappings', async typedRelations => {
    const { detail, original } = associationFixture();
    detail.derivedAssociations.revision!.typedRelations = typedRelations;
    const calls = api(call => call.operation === 'association-catalogs' ? json(matchingCatalogs(detail, original))
      : call.operation === 'apply-associations' ? json(detail) : undefined);
    render(<AssociationMappingDrawer detail={detail} workspace="/relation-intent" lang="en" onClose={vi.fn()} onSaved={vi.fn()} onReadback={vi.fn()}/>, { wrapper });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load current entity revision' }).hasAttribute('disabled')).toBe(false));
    confirmMapping(); fireEvent.click(screen.getByRole('button', { name: 'Save pending mappings' }));
    await waitFor(() => expect(calls.filter(call => call.operation === 'apply-associations')).toHaveLength(1));
    const draft = calls.find(call => call.operation === 'apply-associations')!.body.draft;
    if (typedRelations === undefined) expect(draft).not.toHaveProperty('typedRelations');
    else expect(draft).toHaveProperty('typedRelations', []);
  });

  it('does not inherit a stale body relation or its issues into a new projection', async () => {
    const { detail, original } = associationFixture();
    detail.derivedAssociations.status = 'stale';
    detail.derivedAssociations.revision!.bodyRef = { ...detail.derivedAssociations.bodyRef, revisionId: uuid(702) };
    detail.derivedAssociations.revision!.issues = ['Only applies to the old body.'];
    const calls = api(call => call.operation === 'association-catalogs' ? json(matchingCatalogs(detail, original))
      : call.operation === 'apply-associations' ? json(detail) : undefined);
    render(<AssociationMappingDrawer detail={detail} workspace="/stale-relations" lang="en" onClose={vi.fn()} onSaved={vi.fn()} onReadback={vi.fn()}/>, { wrapper });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load current entity revision' }).hasAttribute('disabled')).toBe(false));
    expect(screen.queryByRole('textbox', { name: 'Description for relation 1' })).toBeNull();
    expect(screen.queryByText('Only applies to the old body.')).toBeNull();
    confirmMapping(); fireEvent.click(screen.getByRole('button', { name: 'Save pending mappings' }));
    await waitFor(() => expect(calls.filter(call => call.operation === 'apply-associations')).toHaveLength(1));
    const draft = calls.find(call => call.operation === 'apply-associations')!.body.draft;
    expect(draft).toMatchObject({ catalogRefs: [], segmentEntityRefs: [], issues: [] });
    expect(draft).not.toHaveProperty('typedRelations');
    expect(detail.derivedAssociations.revision!.typedRelations).toHaveLength(1);
  });

  it('follows a controlled segment and mention into the exact original span and back without replacing the bound entity revision', () => {
    const pageScroll = mockReaderLayout();
    const { detail, original } = associationFixture(), onEntity = vi.fn();
    function View() {
      const [selection, setSelection] = useState<KnowledgeReaderSelection>({ tab: 'associations', segmentId: 's1', mentionId: original.revision.mentions[0].mentionId });
      return <KnowledgeReader detail={detail} lang="en" workspace="/reader-fixture" selection={structuredClone(selection)} onSelectionChange={setSelection}
        onEntity={onEntity} onRevision={vi.fn()} onRetry={vi.fn()}/>;
    }
    const view = render(<View/>, { wrapper });
    expect(view.container.querySelector(`[data-mention-id="${original.revision.mentions[0].mentionId}"]`)?.getAttribute('data-focused')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect this entity' }));
    expect(onEntity).toHaveBeenCalledWith({ analysisId: original.history.analysisId, entityRevisionId: original.revision.revisionId, entityId: original.revision.entities[0].entityId });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect this mention in its source' }));
    expect(screen.getByRole('button', { name: 'Evidence' }).getAttribute('aria-pressed')).toBe('true');
    const pane = expectSourceStartVisible(view.container, 'Alpha');
    pane.scrollTop = 0;
    view.rerender(<View/>);
    expect(pane.scrollTop).toBe(0);
    expect(pageScroll).not.toHaveBeenCalled();
    expect(screen.getAllByText(/00000000-0000-4000-8000-000000000401/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Return to this content segment' }));
    expect(view.container.querySelector('[data-segment-id="s1"]')?.getAttribute('data-focused')).toBe('true');
    expect(screen.getByText(detail.revision.content.segments[0].text)).toBeTruthy();
  });

  it('reveals content citations and same-source span changes while preserving manual scroll through equivalent URL selections and data refreshes', () => {
    const pageScroll = mockReaderLayout(), { detail } = citationFixture();
    const citation = detail.revision.content.segments[0].evidence[0];
    detail.revision.content.segments[0].evidence.push({ ...citation, selection: { ...citation.selection, start: 0, end: citation.selection.quote.length } });
    const props = { detail, lang: 'en' as const, onRevision: vi.fn(), onRetry: vi.fn() };
    const view = render(<KnowledgeReader {...props}/>, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect sources' }));
    const pane = expectSourceStartVisible(view.container, citation.selection.quote);
    expect(view.container.querySelector('mark')?.previousSibling?.textContent).toBe(`${citation.selection.quote}；`);
    const selection: KnowledgeReaderSelection = { tab: 'evidence', segmentId: 's1', evidence: { ...citation.source,
      evidenceRef: citation.selection.evidenceRef, start: citation.selection.start, end: citation.selection.end } };
    pane.scrollTop = 0;
    view.rerender(<KnowledgeReader {...props} detail={structuredClone(detail)} selection={structuredClone(selection)}/>);
    expect(pane.scrollTop).toBe(0);
    view.rerender(<KnowledgeReader {...props} selection={{ ...selection, evidence: { ...selection.evidence!, start: 0, end: citation.selection.quote.length } }}/>);
    expectSourceStartVisible(view.container, citation.selection.quote);
    expect(view.container.querySelector('mark')?.previousSibling?.textContent ?? '').toBe('');
    expect(pageScroll).not.toHaveBeenCalled();
  });

  it('reveals an exact URL target after its source becomes readable and leaves mismatched original text unhighlighted', () => {
    const pageScroll = mockReaderLayout(), { detail } = citationFixture();
    const citation = detail.revision.content.segments[0].evidence[0];
    const selection: KnowledgeReaderSelection = { tab: 'evidence', evidence: { ...citation.source,
      evidenceRef: citation.selection.evidenceRef, start: citation.selection.start, end: citation.selection.end } };
    const unavailable = structuredClone(detail); unavailable.sources = [{ status: 'unavailable', reason: 'missing', detail: 'The exact snapshot is temporarily unreadable.' }];
    const props = { lang: 'en' as const, onRevision: vi.fn(), onRetry: vi.fn(), selection };
    const view = render(<KnowledgeReader {...props} detail={unavailable}/>, { wrapper });
    expect(view.container.querySelector('mark')).toBeNull();
    expect(view.container.querySelector<HTMLElement>('.knowledge-reader-scroll')?.scrollTop).toBe(0);
    view.rerender(<KnowledgeReader {...props} detail={detail}/>);
    const pane = expectSourceStartVisible(view.container, citation.selection.quote);
    pane.scrollTop = 0;
    const mismatched = structuredClone(detail);
    if (mismatched.sources[0].status !== 'available') throw new Error('Expected a source fixture');
    mismatched.sources[0].snapshot.excerpts[0].text = 'An unrelated original record';
    view.rerender(<KnowledgeReader {...props} detail={mismatched}/>);
    expect(screen.getByText(/saved quotation does not match/)).toBeTruthy();
    expect(view.container.querySelector('.knowledge-source')?.textContent).toBe('An unrelated original record');
    expect(view.container.querySelector('mark')).toBeNull();
    expect(pane.scrollTop).toBe(0);
    expect(pageScroll).not.toHaveBeenCalled();
  });

  it('does not substitute a nearby quotation when a graph selection names a different exact evidence identity', () => {
    mockReaderLayout();
    const { detail } = associationFixture();
    const view = render(<KnowledgeReader detail={detail} lang="en" onRevision={vi.fn()} onRetry={vi.fn()} selection={{ tab: 'evidence',
      evidence: { snapshotId: uuid(999), sourceVersion: digest, evidenceRef: 'record-1', start: 0, end: 5 } }}/>, { wrapper });
    expect(screen.getByText(/requested exact evidence is absent/)).toBeTruthy();
    expect(view.container.querySelector('mark')).toBeNull();
    expect(view.container.querySelector<HTMLElement>('.knowledge-reader-scroll')?.scrollTop).toBe(0);
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
    const pageScroll = mockReaderLayout();
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
    const pane = expectSourceStartVisible(view.container, 'Alpha');
    pane.scrollTop = 0;
    view.rerender(<View/>);
    expect(pane.scrollTop).toBe(0);
    expect(pageScroll).not.toHaveBeenCalled();
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
        catalogRefs: [{ analysisId: current.history.analysisId, entityRevisionId: current.revision.revisionId }], segmentEntityRefs: [{ segmentId: 's1', analysisId: current.history.analysisId, entityRevisionId: current.revision.revisionId, entityId: current.revision.entities[0].entityId, mentionIds: [current.revision.mentions[0].mentionId] }], typedRelations: [{ ...detail.derivedAssociations.revision!.typedRelations![0], subject: { analysisId: current.history.analysisId, entityRevisionId: current.revision.revisionId, entityId: current.revision.entities[0].entityId } }] } };
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
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Subject for relation 1' }));
    fireEvent.click(await screen.findByText(/Alpha corrected · Catalog 1/, { selector: '.ant-select-item-option-content' }));
    change('Mapping reason', 'Checked corrected entity and exact mention');
    const saveButton = screen.getByRole('button', { name: 'Save pending mappings' });
    expect(saveButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save mappings and the relations/ }));
    const refreshed = structuredClone(detail); refreshed.derivedAssociations.generation = 99;
    view.rerender(<View value={refreshed}/>);
    fireEvent.click(saveButton);
    await waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    const requests = calls.filter(call => call.operation === 'apply-associations');
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({ revision: detail.revision.revisionId, bodyDigest: detail.revision.bodyDigest, generation: 3,
      draft: { catalogRefs: [{ analysisId: current.history.analysisId, entityRevisionId: current.revision.revisionId }], segmentEntityRefs: [{ segmentId: 's1', analysisId: current.history.analysisId, entityRevisionId: current.revision.revisionId, entityId: current.revision.entities[0].entityId, mentionIds: [current.revision.mentions[0].mentionId] }], issues: [] } });
    expect(requests[0].body.draft).toMatchObject({ typedRelations: saved.derivedAssociations.revision!.typedRelations });
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
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save mappings and the relations/ }));
    expect(screen.getByRole('button', { name: 'Save pending mappings' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reload analysis catalog' }));
    await screen.findByText(/catalog coverage is incomplete/);
    expect(screen.getAllByText(/Selected conversation · Discussion material · 1 source excerpt · 2 entities/).length).toBeGreaterThan(0);
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
    fireEvent.click(screen.getByRole('checkbox', { name: /^Save mappings and the relations/ }));
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
function citationEditor(_entry: typeof revisionEntries[number], detail: KnowledgeCandidateDetail, onSaved = vi.fn(), onReadback = vi.fn(), initialReason?: string) {
  const props = { workspace: '/citation-fixture', detail, lang: 'en' as const, onClose: vi.fn(), onSaved, onReadback, initialReason };
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
  it('maps multiline textarea quotations and repeated occurrences back to untouched CRLF source ranges before saving', async () => {
    const { detail } = citationFixture(), text = '😀 header\r\nAlpha\nBeta\r\nseparator\r\nAlpha\r\nBeta\r\ntail';
    const source = detail.revision.content.segments[0].evidence[0].source, snapshot = fileSourceFixture(source, text);
    const excerpt = snapshot.excerpts[0], repeated = 'Alpha\r\nBeta', start = text.lastIndexOf(repeated);
    detail.sources = [{ status: 'available', snapshot }];
    detail.revision.content.segments[0].evidence = [{ source, basis: 'source_assertion',
      selection: { evidenceRef: excerpt.evidenceRef, quote: repeated, start, end: start + repeated.length } }];
    // The first displayed occurrence has LF; an already saved CRLF quote still refers to occurrence 1.
    expect(initialBodyCitations(detail)[0].selection.occurrence).toBe(1);
    const saved = vi.fn(), calls = api(call => call.operation === 'revise' ? json(detail) : undefined);
    render(citationEditor('revise', detail, saved, vi.fn(), 'Keep exact original line endings.'), { wrapper });
    const original = await screen.findByRole('textbox', { name: 'Original file excerpt (read-only)' }) as HTMLTextAreaElement;
    expect(original.value).toBe(text.replace(/\r\n/gu, '\n'));
    change('Citation 1', ''); change('Citation 1', 'Alpha\nBeta');
    fireEvent.click(screen.getByText('Choose an occurrence for repeated quotations', { exact: true }));
    const occurrence = screen.getByRole('spinbutton', { name: /^Occurrence \(starting at 0\)/ });
    fireEvent.change(occurrence, { target: { value: '' } }); fireEvent.blur(occurrence);
    expect(revisionSaveButton('revise').hasAttribute('disabled')).toBe(true);
    fireEvent.change(occurrence, { target: { value: '1' } }); fireEvent.blur(occurrence);
    expect(revisionSaveButton('revise').hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add a citation to segment 1' }));
    change('Citation 2', 'separator\nAlpha\nBeta');
    fireEvent.click(revisionSaveButton('revise'));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(detail));
    const writes = calls.filter(call => call.operation === 'revise'); expect(writes).toHaveLength(1);
    const evidence = (writes[0].body.draft as KnowledgeCandidateDetail['revision']).content.segments[0].evidence;
    const unique = 'separator\r\nAlpha\r\nBeta', uniqueStart = text.indexOf(unique);
    expect(evidence).toEqual([
      { source, basis: 'source_assertion', selection: { evidenceRef: excerpt.evidenceRef, quote: repeated, start, end: start + repeated.length } },
      { source, basis: 'source_assertion', selection: { evidenceRef: excerpt.evidenceRef, quote: unique, start: uniqueStart, end: uniqueStart + unique.length } },
    ]);
    for (const { selection } of evidence) expect(text.slice(selection.start, selection.end)).toBe(selection.quote);
    expect(snapshot.excerpts[0].text).toBe(text); expect(snapshot.rawUnits[0].text).toBe(text);
  });
  it('prefills a review reason and adds a missing segment only after exact evidence is supplied, preserving the original body CAS and segments', async () => {
    const { detail } = citationFixture(), original = structuredClone(detail.revision), saved = vi.fn(), pending = deferred<Response>();
    const reason = 'Address content review: the source correction block was missing.';
    const calls = api(call => call.operation === 'revise' ? pending.promise : undefined);
    const mounted = render(citationEditor('revise', detail, saved, vi.fn(), reason), { wrapper });
    expect((await screen.findByRole('textbox', { name: 'Revision reason' }) as HTMLInputElement).value).toBe(reason);
    expect(revisionSaveButton('revise').hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add a missing segment' }));
    change('Knowledge segment 2', 'The source subsequently corrected that Alpha did not use Beta.');
    expect(revisionSaveButton('revise').hasAttribute('disabled')).toBe(true);
    fireEvent.click(revisionSaveButton('revise')); expect(calls.filter(call => call.operation === 'revise')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Add a citation to segment 2' }));
    expect(revisionSaveButton('revise').hasAttribute('disabled')).toBe(true);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Source excerpt for citation 2' }));
    fireEvent.click(await screen.findByText('Agent trace · Source record 1 · user · Discussion material · 纠正：Alpha 未使用 Beta'));
    change('Citation 2', 'Alpha 未使用 Beta');
    expect(revisionSaveButton('revise').hasAttribute('disabled')).toBe(false);
    const refreshed = structuredClone(detail); refreshed.revision.revisionId = uuid(902); refreshed.history.generation = 9; refreshed.history.writeHeadRevisionId = uuid(902);
    mounted.rerender(citationEditor('revise', refreshed, saved, vi.fn(), 'A later prop must not replace the draft reason.'));
    expect((screen.getByRole('textbox', { name: 'Revision reason' }) as HTMLInputElement).value).toBe(reason);
    fireEvent.click(revisionSaveButton('revise'));
    await waitFor(() => expect(calls.filter(call => call.operation === 'revise')).toHaveLength(1));
    const command = calls.find(call => call.operation === 'revise')!.body;
    expect(command).toMatchObject({ workspace: '/citation-fixture', id: original.knowledgeId, revision: original.revisionId, generation: 1, reason });
    const draft = command.draft as Pick<KnowledgeCandidateDetail['revision'], 'title' | 'content' | 'reuseRationale'>;
    expect(draft.content.segments).toHaveLength(2); expect(draft.content.segments[0]).toEqual(original.content.segments[0]);
    expect(draft.content.segments[1].segmentId).not.toBe(original.content.segments[0].segmentId);
    expect(draft.content.segments[1]).toMatchObject({ text: 'The source subsequently corrected that Alpha did not use Beta.',
      evidence: [{ source: original.content.segments[0].evidence[0].source, basis: 'source_assertion',
        selection: { evidenceRef: 'record-2', quote: 'Alpha 未使用 Beta', start: 3, end: 17 } }] });
    expect(detail.revision).toEqual(original); expect(saved).not.toHaveBeenCalled();
    const persisted = structuredClone(detail); persisted.revision = { ...original, ...draft, revisionId: uuid(903), bodyDigest: knowledgeBodyDigest(draft),
      parentRevision: { knowledgeId: original.knowledgeId, revisionId: original.revisionId }, revisionReason: reason };
    persisted.history = { ...persisted.history, generation: 2, writeHeadRevisionId: persisted.revision.revisionId, revisions: [original, persisted.revision],
      receipts: [...persisted.history.receipts, { requestId: uuid(904), commandDigest: digest, committedGeneration: 2, revisionId: persisted.revision.revisionId }] };
    await act(async () => pending.resolve(json(persisted)));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(persisted));
    expect(calls.filter(call => call.operation === 'revise')).toHaveLength(1);
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
