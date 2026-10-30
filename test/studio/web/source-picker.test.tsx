// @vitest-environment jsdom
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigProvider } from 'antd';
import type { PropsWithChildren } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceOriginalContext } from '../../../src/studio/web/components/knowledge/source-locator';
import { fileSourceFixture } from './source-fixture';
import { SourceExtractionDialog } from '../../../src/studio/web/components/knowledge/source-picker';
import { KnowledgeReader } from '../../../src/studio/web/components/knowledge/reader';
import { SourceUpdates } from '../../../src/studio/web/components/knowledge/source-updates';
import { executeSourcePickerAction } from '../../../src/studio/application/knowledge/source-picker';
import { executeKnowledgeCandidateAction } from '../../../src/studio/application/knowledge/knowledge-candidates';
import { executeKnowledgeReviewAction } from '../../../src/studio/application/knowledge/knowledge-reviews';
import type { KnowledgeGenerationModel } from '../../../src/knowledge/adapters/generation-executor';
import type { LocalSourceScope } from '../../../src/knowledge/application/local-source-host';
import type { ConversationCatalog } from '../../../src/observability/conversation/catalog';
import { authoredKnowledgeResponse } from '../../cli/knowledge-fixtures';
import { bodyActor, bodyWrite } from '../../knowledge/body-fixtures';
import { knowledgeBodyDigest } from '../../../src/knowledge/adapters/body-digest';
import { FileKnowledgeStore } from '../../../src/knowledge/adapters/knowledge-store';
import { FileEntityAnalysisStore } from '../../../src/knowledge/adapters/entity-store';
import { createLocalKnowledgeApplication } from '../../../src/knowledge/application/local';
import type { KnowledgeCandidateDetail, KnowledgeSourceCapture, KnowledgeSourceUpdates } from '../../../src/studio/view-models/knowledge/knowledge-candidates';

const native = vi.hoisted(() => ({ model: null as KnowledgeGenerationModel | null }));
vi.mock('../../../src/knowledge/adapters/generation-executor', () => ({ configuredKnowledgeGenerationModel: () => {
  if (!native.model) throw Error('Authored adapter not configured.'); return native.model;
} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {} }) }));
const roots: string[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('TextEncoder', TextEncoder); vi.stubGlobal('TextDecoder', TextDecoder);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const style = window.getComputedStyle.bind(window); vi.spyOn(window, 'getComputedStyle').mockImplementation(element => style(element));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); native.model = null; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const wrapper = ({ children }: PropsWithChildren) => <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const workspaceFiles = (path: string): [string, string][] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? workspaceFiles(join(path, entry.name)) : [[join(path, entry.name), readFileSync(join(path, entry.name), 'utf8')]]);

describe('Source3 manual transmission boundary', () => {
  it.each([false, true])('previews and captures without calling a model, then confirms body and association requests separately through production application ports (conversation list unavailable: %s)', async unavailable => {
    const root = mkdtempSync(join(tmpdir(), 'omk-source-picker-')); roots.push(root);
    const project = join(root, 'project'), workspace = join(root, 'workspace'); mkdirSync(project);
    writeFileSync(join(project, 'notes.md'), 'Alpha 使用 Beta。<script>authored literal</script>');
    const scope: LocalSourceScope = { scopeVersion: 'knowledge-source-scope/v1', projects: [{ projectId: 'project-alpha', root: project }], traces: [] };
    const catalog: ConversationCatalog = { async listConversations() { return { conversations: [], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 }; }, async getConversation() { return undefined; }, async loadTaskTrajectory() { return undefined; } };
    const invocations: string[] = [], requests: { resource: string; body: Record<string, unknown> }[] = [];
    let conversationListUnavailable = unavailable;
    native.model = { executor: 'codex', model: 'authored-no-model', timeoutMs: 300_000,
      inspect: () => ({ producerId: 'authored-ui-adapter', producerRevision: 'v1', sourceChannels: [], maxOutcomeJsonBytes: 1024 * 1024, proof: { nativeObserved: false } }),
      async invoke(profile, input, _signal, gate) { gate?.(); invocations.push(profile.stageKind); return { outcomeKind: 'result', result: { ok: true, output: JSON.stringify(authoredKnowledgeResponse(input, profile.stageKind)), authoredFixture: true } }; } };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/settings') return json({ effective: { workspace, executor: 'codex', model: 'authored-no-model' } });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>, resource = url.split('/').at(-1)!;
      requests.push({ resource, body });
      const signal = init.signal instanceof AbortSignal ? init.signal : undefined;
      if (resource === 'sources') return json(await executeSourcePickerAction(body, scope, signal));
      if (resource === 'candidates' && body.operation === 'conversations' && conversationListUnavailable) return new Response(JSON.stringify({ error: 'knowledge_request_failed' }), { status: 400, headers: { 'content-type': 'application/json' } });
      if (resource === 'candidates') return json(await executeKnowledgeCandidateAction(body, signal, undefined, catalog));
      throw Error('Unexpected authored test resource.');
    }));
    render(<SourceExtractionDialog lang="en" initialWorkspace={workspace} onClose={() => {}}/>, { wrapper });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add to this source batch' }) as HTMLButtonElement).disabled).toBe(false));
    if (unavailable) {
      expect(screen.getByText('Conversation list unavailable')).toBeTruthy();
      expect(screen.queryByText(/The host has no configured projects or traces/)).toBeNull();
    }
    fireEvent.change(screen.getByLabelText('Project relative path'), { target: { value: 'notes.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to this source batch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read and preview without saving or sending' }));
    await screen.findByText('Review local read and capture scope');
    expect(invocations).toEqual([]); expect(existsSync(join(workspace, 'sources'))).toBe(false);
    expect(document.querySelector('script')).toBeNull();
    const preview = requests.find(item => item.body.operation === 'preview-sources')!;
    expect(preview.body.selections).toEqual([{ sourceKind: 'project_file', projectId: 'project-alpha', relativePath: 'notes.md', lineRanges: null }]);
    expect(JSON.stringify(preview.body)).not.toContain(project);
    fireEvent.click(screen.getByRole('button', { name: 'Capture selected sources only' }));
    await screen.findByRole('button', { name: 'Prepare and review complete model request' });
    expect(existsSync(join(workspace, 'sources'))).toBe(true); expect(invocations).toEqual([]);
    expect(screen.queryByRole('textbox', { name: 'Compare Git commit or branch' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare and review complete model request' }));
    await screen.findByText('Confirm content request');
    const sendBody = screen.getByRole('button', { name: 'Send this content request' }) as HTMLButtonElement;
    expect(sendBody.disabled).toBe(true); expect(invocations).toEqual([]);
    if (unavailable) {
      // Recovery rereads only the failed list; the already prepared request remains unchanged.
      conversationListUnavailable = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry conversation list' }));
      await waitFor(() => expect(screen.queryByText('Conversation list unavailable')).toBeNull());
      expect(requests.filter(item => item.resource === 'sources' && item.body.operation === 'catalog')).toHaveLength(1);
      expect(requests.filter(item => item.body.operation === 'conversations')).toHaveLength(2);
      expect(invocations).toEqual([]); expect(sendBody.disabled).toBe(true);
    }
    const approval = () => screen.getByRole('checkbox', { name: 'Approve sending this exact request to the executor/model shown above.' }) as HTMLInputElement;
    fireEvent.click(approval()); fireEvent.click(sendBody);
    await screen.findByText('Confirm entity association request');
    expect(invocations).toEqual(['body']); expect(approval().checked).toBe(false);
    const sendAssociation = screen.getByRole('button', { name: 'Send this association request' }) as HTMLButtonElement;
    expect(sendAssociation.disabled).toBe(true);
    const body = requests.find(item => item.body.operation === 'generate')!.body;
    expect(body.sources).toEqual([expect.objectContaining({ snapshotId: expect.any(String), sourceVersion: expect.stringMatching(/^sha256:/) })]);
    expect(body.confirmedRequestDigest).toMatch(/^sha256:/);
    fireEvent.click(approval()); fireEvent.click(sendAssociation);
    await screen.findByText('This run ended. Review the candidate content.');
    expect(invocations).toEqual(['body', 'association']);
    const association = requests.find(item => item.body.operation === 'continue-stage')!.body;
    expect(association.id).toBe(body.runId); expect(association.confirmedRequestDigest).not.toBe(body.confirmedRequestDigest);
    expect(requests.filter(item => ['generate', 'continue-stage'].includes(String(item.body.operation)))).toHaveLength(2);
  });
  it('distinguishes an unreadable project catalog from unconfigured sources and retries only the failed catalog', async () => {
    let available = false;
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/settings') return json({ effective: { workspace: '/explicit-source-workspace', executor: 'codex', model: 'authored-no-model' } });
      const body = JSON.parse(String(init.body)) as { operation: string }; requests.push(body.operation);
      if (body.operation === 'catalog') return available ? json({ projects: [{ projectId: 'project-alpha' }], traces: [] })
        : new Response(JSON.stringify({ error: 'knowledge_request_failed' }), { status: 400, headers: { 'content-type': 'application/json' } });
      if (body.operation === 'conversations') return json([]);
      throw Error('Unexpected catalog recovery request.');
    }));
    render(<SourceExtractionDialog lang="en" onClose={() => {}}/>, { wrapper });
    await screen.findByText('Project and trace source list unavailable');
    expect(screen.queryByText(/The host has no configured projects or traces/)).toBeNull();
    available = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry project and trace list' }));
    await waitFor(() => expect(screen.queryByText('Project and trace source list unavailable')).toBeNull());
    expect(screen.getByText('project-alpha')).toBeTruthy();
    expect(requests.filter(operation => operation === 'catalog')).toHaveLength(2);
    expect(requests.filter(operation => operation === 'conversations')).toHaveLength(1);
  });
  it('compares an explicit Git revision against the saved source and its exact dependencies without changing capture or model approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-git-source-picker-')); roots.push(root);
    const project = join(root, 'project'), workspace = join(root, 'workspace'); mkdirSync(project);
    const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=Authored Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${join(root, 'hooks')}`, ...args], { encoding: 'utf8', stdio: 'pipe',
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), NODE_ENV: process.env.NODE_ENV, GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(root, 'no-global-config'), GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_DATE: '2026-10-30T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-30T00:00:01Z' } }).trim();
    mkdirSync(join(root, 'hooks')); mkdirSync(join(root, 'template')); git('init', '--template', join(root, 'template'));
    writeFileSync(join(project, 'notes.md'), 'first\nAlpha\nlast\n'); git('add', '--', 'notes.md'); git('commit', '-m', 'authored old source');
    const oldRevision = git('rev-parse', 'HEAD');
    writeFileSync(join(project, 'notes.md'), 'first\nBeta\nlast\n'); git('add', '--', 'notes.md'); git('commit', '-m', 'authored changed source');
    const newRevision = git('rev-parse', 'HEAD'), comparisonRevision = 'compare-version'; git('branch', comparisonRevision);
    const scope: LocalSourceScope = { scopeVersion: 'knowledge-source-scope/v1', projects: [{ projectId: 'project-alpha', root: project }], traces: [] };
    const requests: Record<string, unknown>[] = [], invoke = vi.fn(async () => { throw new Error('No model request authorized.'); });
    native.model = { executor: 'codex', model: 'authored-no-model', timeoutMs: 300_000, invoke,
      inspect: () => ({ producerId: 'authored-ui-adapter', producerRevision: 'v1', sourceChannels: [], maxOutcomeJsonBytes: 1024 * 1024, proof: { nativeObserved: false } }) };
    let captured: KnowledgeSourceCapture | undefined, rejectCheck = false, holdCheck = false;
    const held: { signal: AbortSignal; resolve(value: Response): void }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/settings') return json({ effective: { workspace, executor: 'codex', model: 'authored-no-model' } });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; requests.push(body);
      if (body.operation === 'conversations') return json([]);
      if (url.endsWith('/reviews')) return json(executeKnowledgeReviewAction(body, bodyActor));
      if (url.endsWith('/sources')) {
        if (body.operation === 'source-updates' && holdCheck) return await new Promise<Response>(resolve => held.push({ signal: init.signal!, resolve }));
        if (body.operation === 'source-updates' && rejectCheck) throw new Error('Authored read failure.');
        const result = await executeSourcePickerAction(body, scope, init.signal ?? undefined);
        if (body.operation === 'capture') {
          captured = result as KnowledgeSourceCapture;
          const snapshot = captured.sources[0].snapshot, source = { snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion };
          const command = bodyWrite(), excerpt = snapshot.excerpts[0];
          command.revision.content.segments[0].evidence = [{ source, selection: { evidenceRef: excerpt.evidenceRef, start: 0, end: 5, quote: 'Alpha' }, basis: 'source_assertion' }];
          command.revision.bodyDigest = knowledgeBodyDigest(command.revision);
          new FileKnowledgeStore(join(workspace, 'items'), 'local', workspace).write(command, bodyActor);
          const analysisId = randomUUID(), entityRevisionId = randomUUID(), entityId = randomUUID(), mentionId = randomUUID();
          new FileEntityAnalysisStore(join(workspace, 'entities'), workspace).write({ requestId: randomUUID(), analysisId, ...source, expectedGeneration: 0, expectedHeadRevisionId: null,
            revision: { revisionId: entityRevisionId, revisedAt: command.revision.revisedAt, revisedBy: bodyActor, revisionReason: 'Authored old-window dependency.',
              entities: [{ entityId, label: 'Alpha', description: 'Authored old-window object.', qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentRef: null, collection: null }],
              mentions: [{ mentionId, entityId, selection: { evidenceRef: excerpt.evidenceRef, start: 0, end: 5, quote: 'Alpha' }, basis: 'explicit', rationale: 'Authored exact mention.' }], limitations: [] } }, bodyActor);
          createLocalKnowledgeApplication(workspace, { actor: bodyActor, sourceScope: scope }).applyAssociations(command.knowledgeId, command.revision.revisionId, command.revision.bodyDigest, 0,
            { catalogRefs: [{ analysisId, entityRevisionId }], segmentEntityRefs: [{ analysisId, entityRevisionId, entityId, segmentId: 's1', mentionIds: [mentionId] }], typedRelations: [], issues: [] }, 'Authored pending mapping.');
        }
        return json(result);
      }
      return json(await executeKnowledgeCandidateAction(body, init.signal ?? undefined));
    }));
    const view = render(<SourceExtractionDialog lang="en" initialMode="git_blob" initialWorkspace={workspace} onClose={() => {}}/>, { wrapper });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add to this source batch' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Project relative path'), { target: { value: 'notes.md' } });
    fireEvent.change(screen.getByLabelText('Git commit or branch (pinned after preview)'), { target: { value: oldRevision } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Explicitly select the whole file' }));
    fireEvent.change(screen.getByLabelText('Line ranges (one-based, inclusive)'), { target: { value: '2-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to this source batch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read and preview without saving or sending' }));
    await screen.findByText('Review local read and capture scope');
    fireEvent.click(screen.getByRole('button', { name: 'Capture selected sources only' }));
    const comparison = await screen.findByRole('textbox', { name: 'Compare Git commit or branch' });
    const compare = screen.getByRole('button', { name: 'Compare revision and check impact' });
    expect((comparison as HTMLInputElement).value).toBe(''); expect((compare as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Comparing does not replace this capture or model input/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare and review complete model request' }));
    const approval = await screen.findByRole('checkbox', { name: 'Approve sending this exact request to the executor/model shown above.' });
    fireEvent.click(approval);
    const modelInput = () => screen.getByText('Complete actual model input').parentElement!.querySelector('pre')!.textContent;
    const originalModelInput = modelInput();
    const saved = workspaceFiles(workspace);
    fireEvent.click(screen.getByRole('button', { name: 'Check changes affecting this source' }));
    await screen.findByText(/Source state: Unchanged/);
    expect(screen.getByText(/Resolved comparison commit:/).textContent).toBe(`Resolved comparison commit: ${oldRevision}`);
    fireEvent.change(comparison, { target: { value: `  ${comparisonRevision}  ` } });
    expect(screen.queryByText(/Source state:/)).toBeNull();
    fireEvent.click(compare);
    await screen.findByText(/Source state: Source content changed/);
    expect(screen.getByText('Known references: 1 body versions · 1 entity catalog versions · 1 association versions.')).toBeTruthy();
    expect(screen.getByText(/Review needed: 1 body versions · 1 entity catalog versions · 1 association versions/)).toBeTruthy();
    expect(screen.getByText(`Compared Git revision: ${comparisonRevision}`)).toBeTruthy();
    expect(screen.getByText(/Resolved comparison commit:/).textContent).toBe(`Resolved comparison commit: ${newRevision}`);
    view.rerender(<SourceExtractionDialog lang="zh" initialMode="git_blob" initialWorkspace={workspace} onClose={() => {}}/>);
    expect(screen.getByText(/来源状态：来源内容有变化/)).toBeTruthy();
    expect(screen.getByText('已知引用：正文版本 1 个 · 实体目录版本 1 个 · 关联版本 1 个。')).toBeTruthy();
    view.rerender(<SourceExtractionDialog lang="en" initialMode="git_blob" initialWorkspace={workspace} onClose={() => {}}/>);
    const checks = requests.filter(request => request.operation === 'source-updates'), snapshot = captured!.sources[0].snapshot;
    expect(checks).toEqual([{ operation: 'source-updates', workspace, source: { snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion } },
      { operation: 'source-updates', workspace, source: { snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion }, replacementSelection: { sourceKind: 'git_blob', projectId: 'project-alpha', relativePath: 'notes.md', revision: comparisonRevision, lineRanges: [{ startLine: 2, endLine: 2 }] } }]);
    expect((approval as HTMLInputElement).checked).toBe(true); expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(comparison, { target: { value: 'missing-revision' } }); fireEvent.click(compare);
    await screen.findByText(/Source state: Current source cannot be checked/);
    expect(screen.getByText('The impact inventory is incomplete; absence of impact cannot be inferred.')).toBeTruthy();
    expect((approval as HTMLInputElement).checked).toBe(true); expect(invoke).not.toHaveBeenCalled();
    rejectCheck = true; fireEvent.change(comparison, { target: { value: newRevision } }); fireEvent.click(compare);
    await screen.findByText('Could not check source changes. Check the revision and source configuration, then retry.');
    expect(screen.queryByText(/Source state:/)).toBeNull(); expect((approval as HTMLInputElement).checked).toBe(true);
    expect(modelInput()).toBe(originalModelInput);
    rejectCheck = false; holdCheck = true; fireEvent.click(compare);
    await waitFor(() => expect(held).toHaveLength(1));
    expect((screen.getByRole('button', { name: 'Send this content request' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' })); expect(held[0].signal.aborted).toBe(true);
    await act(async () => held[0].resolve(json({})));
    await waitFor(() => expect((compare as HTMLButtonElement).disabled).toBe(false));
    expect((approval as HTMLInputElement).checked).toBe(true); expect(modelInput()).toBe(originalModelInput);
    fireEvent.click(compare); await waitFor(() => expect(held).toHaveLength(2));
    fireEvent.click(document.querySelector<HTMLButtonElement>('.ant-modal-close')!); expect(held[1].signal.aborted).toBe(true);
    view.unmount(); await act(async () => held[1].resolve(json({}))); holdCheck = false;
    expect(workspaceFiles(workspace)).toEqual(saved);
    expect(requests.filter(request => request.operation === 'capture')).toHaveLength(1);
    const detail = await executeKnowledgeCandidateAction({ operation: 'show', workspace, id: 'knowledge-1' }) as KnowledgeCandidateDetail;
    render(<KnowledgeReader detail={detail} lang="en" workspace={workspace} selection={{ tab: 'evidence', segmentId: 's1' }} onRevision={() => {}} onRetry={() => {}}/>, { wrapper });
    fireEvent.click(screen.getByText('Check changes affecting the saved source', { exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Compare Git commit or branch' }), { target: { value: comparisonRevision } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare revision and check impact' }));
    await screen.findByText(/Source state: Source content changed/);
    expect(requests.filter(request => request.operation === 'source-updates').at(-1)).toEqual(checks[1]);
    expect(workspaceFiles(workspace)).toEqual(saved); expect(invoke).not.toHaveBeenCalled();
    expect(requests.filter(request => request.operation === 'capture')).toHaveLength(1);
  });
  it('checks a saved source after its upstream file is deleted and keeps a deleted historical snapshot distinct', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-saved-source-picker-')); roots.push(root);
    const project = join(root, 'project'), workspace = join(root, 'workspace'); mkdirSync(project);
    const path = join(project, 'notes.md'); writeFileSync(path, 'Alpha remains historical.\n');
    const scope: LocalSourceScope = { scopeVersion: 'knowledge-source-scope/v1', projects: [{ projectId: 'project-alpha', root: project }], traces: [] };
    const app = createLocalKnowledgeApplication(workspace, { actor: bodyActor, sourceScope: scope });
    const snapshot = app.captureSources(app.previewSources([{ sourceKind: 'project_file', projectId: 'project-alpha', relativePath: 'notes.md', lineRanges: [{ startLine: 1, endLine: 1 }] }])).sources[0].snapshot;
    const source = { snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion }, command = bodyWrite();
    command.revision.content.segments[0].evidence = [{ source, selection: { evidenceRef: snapshot.excerpts[0].evidenceRef, start: 0, end: 5, quote: 'Alpha' }, basis: 'source_assertion' }];
    command.revision.bodyDigest = knowledgeBodyDigest(command.revision);
    new FileKnowledgeStore(join(workspace, 'items'), 'local', workspace).write(command, bodyActor);
    const detail = await executeKnowledgeCandidateAction({ operation: 'show', workspace, id: command.knowledgeId }) as KnowledgeCandidateDetail;
    const requests: Record<string, unknown>[] = [], reports: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; requests.push(body);
      if (url.endsWith('/reviews')) return json(executeKnowledgeReviewAction(body, bodyActor));
      if (url.endsWith('/sources')) { const result = await executeSourcePickerAction(body, scope, init.signal ?? undefined); reports.push(result); return json(result); }
      throw new Error('No capture or model operation is authorized by this saved-source read.');
    }));
    unlinkSync(path); const before = workspaceFiles(workspace);
    const props = { lang: 'en' as const, workspace, selection: { tab: 'evidence' as const, segmentId: 's1' }, onRevision() {}, onRetry() {} };
    const view = render(<KnowledgeReader detail={detail} {...props}/>, { wrapper });
    const mark = view.container.querySelector('mark')!, summary = screen.getByText('Check changes affecting the saved source', { exact: true });
    expect(mark.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(requests.filter(request => request.operation === 'source-updates')).toHaveLength(0);
    fireEvent.click(summary); fireEvent.click(screen.getByRole('button', { name: 'Check changes affecting this source' }));
    await screen.findByText(/Source state: File deleted/);
    expect(reports[0]).toMatchObject({ current: { sourceRef: source, state: 'deleted' }, historicalSource: { status: 'available' } });
    expect(view.container.querySelector('mark')).toBe(mark); expect(mark.textContent).toBe('Alpha');
    expect(workspaceFiles(workspace)).toEqual(before);
    app.deleteSource(source);
    const unavailable = await executeKnowledgeCandidateAction({ operation: 'show', workspace, id: command.knowledgeId }) as KnowledgeCandidateDetail;
    view.rerender(<KnowledgeReader detail={unavailable} {...props}/>);
    expect(screen.queryByText(/Source state:/)).toBeNull();
    expect(screen.getByText(/Saved quotations remain readable/)).toBeTruthy();
    const afterDeletion = workspaceFiles(workspace);
    fireEvent.click(screen.getByRole('button', { name: 'Check changes affecting this source' }));
    await screen.findByText(/Source state: Current source cannot be checked/);
    expect(screen.queryByText(/Source state: File deleted/)).toBeNull();
    expect(reports[1]).toMatchObject({ current: { sourceRef: source, state: 'unavailable' }, historicalSource: { status: 'unavailable', reason: 'deleted' }, impactCompleteness: 'partial' });
    expect(workspaceFiles(workspace)).toEqual(afterDeletion);
    expect(requests.filter(request => request.operation === 'source-updates')).toEqual(Array.from({ length: 2 }, () => ({ operation: 'source-updates', workspace, source })));
  });
  it('isolates saved-source checks across refreshes, workspace or exact-ref changes, and unmount', async () => {
    const first = { snapshotId: '00000000-0000-4000-8000-000000000061', sourceVersion: `sha256:${'a'.repeat(64)}` }, second = { ...first, sourceVersion: `sha256:${'b'.repeat(64)}` };
    const snapshot = fileSourceFixture(first, 'Alpha', { sourceKind: 'git_blob' });
    const pending: { body: Record<string, unknown>; signal: AbortSignal; resolve(value: Response): void }[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>(resolve => pending.push({ body: JSON.parse(String(init.body)), signal: init.signal!, resolve }))));
    const report = (source: typeof first): KnowledgeSourceUpdates => ({ current: { sourceRef: source, checkedAt: '2026-10-30T00:00:00Z', state: 'unchanged', limitations: [] }, historicalSource: { status: 'available' },
      changes: { comparisonScope: 'fixed_git_objects', contentChanged: false, metadataChanged: false, selectedBytesChanged: false, projectionTextChanged: false },
      inventoryCompleteness: 'complete', impactCompleteness: 'complete', impactLimitations: [], affectedExactBodyRefs: [], catalogRefs: [], projectionRefs: [], reviewSuggestions: [] });
    const view = render(<SourceUpdates source={first} snapshot={snapshot} workspace="/first" lang="en"/>, { wrapper });
    fireEvent.change(screen.getByRole('textbox', { name: 'Compare Git commit or branch' }), { target: { value: 'explicit-branch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare revision and check impact' }));
    view.rerender(<SourceUpdates source={{ ...first }} snapshot={structuredClone(snapshot)} workspace="/first" lang="en"/>);
    expect(pending[0].signal.aborted).toBe(false); expect((screen.getByRole('textbox', { name: 'Compare Git commit or branch' }) as HTMLInputElement).value).toBe('explicit-branch');
    view.rerender(<SourceUpdates source={first} snapshot={snapshot} workspace="/second" lang="en"/>);
    expect(pending[0].signal.aborted).toBe(true); expect((screen.getByRole('textbox', { name: 'Compare Git commit or branch' }) as HTMLInputElement).value).toBe('');
    await act(async () => pending[0].resolve(json(report(first)))); expect(screen.queryByText(/Source state:/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check changes affecting this source' }));
    view.rerender(<SourceUpdates source={second} snapshot={snapshot} workspace="/second" lang="en"/>);
    expect(pending[1].signal.aborted).toBe(true); expect(screen.queryByRole('textbox', { name: 'Compare Git commit or branch' })).toBeNull();
    await act(async () => pending[1].resolve(json(report(first)))); expect(screen.queryByText(/Source state:/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check changes affecting this source' }));
    await act(async () => pending[2].resolve(json(report(first))));
    expect(screen.getByText('Could not check source changes. Check the revision and source configuration, then retry.')).toBeTruthy();
    expect(screen.queryByText(/Source state:/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check changes affecting this source' }));
    expect(pending.slice(1).map(read => read.body)).toEqual([{ operation: 'source-updates', workspace: '/second', source: first },
      { operation: 'source-updates', workspace: '/second', source: second }, { operation: 'source-updates', workspace: '/second', source: second }]);
    view.unmount(); expect(pending[3].signal.aborted).toBe(true); await act(async () => pending[3].resolve(json(report(second))));
  });
  it('reads raw originals only on explicit demand with an exact workspace/source pair, and preserves content after read failure', async () => {
    const snapshot = fileSourceFixture({ snapshotId: '00000000-0000-4000-8000-000000000051', sourceVersion: `sha256:${'a'.repeat(64)}` }, 'Alpha original context');
    const { rawUnits, ...view } = snapshot; void rawUnits;
    const fetch = vi.fn(async (_url: string, _init: RequestInit = {}) => json({ status: 'unavailable', reason: 'missing', detail: 'Authored missing original.' })); vi.stubGlobal('fetch', fetch);
    render(<><p>Saved body and quote stay readable.</p><SourceOriginalContext snapshot={view} excerpt={snapshot.excerpts[0]} lang="en" workspace="/explicit-source-workspace"/></>, { wrapper });
    expect(fetch).toHaveBeenCalledTimes(0);
    fireEvent.click(screen.getByText('Original file excerpt'));
    fireEvent.click(await screen.findByRole('button', { name: 'Read complete originals' }));
    await screen.findByText(/Complete originals are unavailable/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ operation: 'source', workspace: '/explicit-source-workspace', source: { snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion } });
    expect(screen.getByText('Saved body and quote stay readable.')).toBeTruthy();
  });
  it('does not fall back to a default workspace when original context has no explicit workspace', async () => {
    const snapshot = fileSourceFixture({ snapshotId: '00000000-0000-4000-8000-000000000052', sourceVersion: `sha256:${'b'.repeat(64)}` }, 'Alpha');
    const { rawUnits, ...view } = snapshot; void rawUnits;
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<SourceOriginalContext snapshot={view} excerpt={snapshot.excerpts[0]} lang="en"/>, { wrapper });
    fireEvent.click(screen.getByText('Original file excerpt'));
    expect((await screen.findByRole('button', { name: 'Read complete originals' }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(0);
  });

});
