import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { createLocalSourceCapture, LocalSourceScopeSchema, readLocalSourceScope, type LocalSourceScope } from '../../src/knowledge/application/local-source-host.js';
import { executeKnowledgeOperation, KnowledgeOperationSchema, knowledgeFailureCode } from '../../src/knowledge/application/operations.js';
import { SourceCaptureError } from '../../src/knowledge/application/source-capture.js';
import { SourceStoreError } from '../../src/knowledge/adapters/source-store.js';
import { EvidenceWindowSchema } from '../../src/knowledge/extraction/evidence.js';
import type { SourceSelection } from '../../src/knowledge/sources.js';
import * as generationHost from '../../src/knowledge/adapters/generation-host.js';
import type { KnowledgeGenerationModel } from '../../src/knowledge/adapters/generation-executor.js';
import { createExtractionArchiveProducer } from '../../src/executors/archive.js';
import { runCommand } from '../helpers/run-command.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-source-cli-')); roots.push(root);
  const workspace = join(root, 'knowledge'), project = join(root, 'project'); mkdirSync(project);
  const source = join(project, 'guide.txt'); writeFileSync(source, '\ufeff先决条件\r\nAlpha 使用 Beta😀');
  const trace = join(root, 'trace.jsonl'); writeFileSync(trace, JSON.stringify({ type: 'response_item', privateMetadata: 'RAW_ONLY', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '协作原文😀' }] } }) + '\r\n');
  const scope: LocalSourceScope = { scopeVersion: 'knowledge-source-scope/v1', projects: [{ projectId: 'project', root: project,
    materials: [{ relativePath: 'guide.txt', materialType: 'design', reason: 'Explicit authored host declaration.' }] }],
    traces: [{ sourceId: 'thread', traceKind: 'codex', path: trace, origin: { threadId: 'original-thread', turnId: 'original-turn', title: '原始标题' } }] };
  const scopePath = join(root, 'scope.json'); writeFileSync(scopePath, JSON.stringify(scope));
  const input = join(root, 'selections.json'), previewPath = join(root, 'preview.json');
  const selections: [Extract<SourceSelection, { sourceKind: 'project_file' }>, Extract<SourceSelection, { sourceKind: 'agent_trace' }>] = [
    { sourceKind: 'project_file', projectId: 'project', relativePath: 'guide.txt', lineRanges: [{ startLine: 2, endLine: 2 }] },
    { sourceKind: 'agent_trace', sourceId: 'thread', traceKind: 'codex', recordRanges: [{ startRecord: 0, endRecord: 0 }] }];
  writeFileSync(input, JSON.stringify({ selections }));
  const base = ['--workspace', workspace, '--scope', scopePath, '--json'];
  return { root, workspace, project, source, trace, scope, scopePath, input, previewPath, selections, base,
    preview: async () => { const output = await runCommand(ObserveKnowledge, ['preview-sources', ...base, '--input', input], { cwd: root }); writeFileSync(previewPath, output.stdout); return JSON.parse(output.stdout); },
    capture: () => runCommand(ObserveKnowledge, ['capture', ...base, '--input', previewPath], { cwd: root }) };
}

describe('Source3 public source CLI and trusted local host', () => {
  it('previews zero writes/models, reconstructs fixed selections in a new command, deduplicates and uses exact source refs', async () => {
    const f = fixture(), fetch = vi.fn(() => { throw new Error('No model dispatch authorized.'); }); vi.stubGlobal('fetch', fetch);
    const preview = await f.preview(); expect(existsSync(f.workspace)).toBe(false); expect(preview.savePlan.actualSnapshotsWritten).toBe(0);
    expect(preview.items[0].excerpts[0]).toMatchObject({ text: 'Alpha 使用 Beta😀', material: { materialType: 'design', attributionBasis: 'host_declared' } });
    expect(preview.items[1].excerpts[0].text).toBe('协作原文😀'); expect(preview.sendDraft.authorization).toBe('not_granted');
    expect(preview.sendDraft.json).not.toContain(f.project); expect(preview.sendDraft.json).not.toContain('RAW_ONLY');
    expect(preview.items[1].retainedUnits[0].text).toContain('RAW_ONLY');
    const captured = JSON.parse((await f.capture()).stdout); expect(captured.sources).toHaveLength(2); expect(captured.sendAuthorization).toBe('not_granted');
    const retry = JSON.parse((await f.capture()).stdout); expect(retry.saveManifest.actualWrittenBytes).toBe(0); expect(retry.sources.every((value: { reused: boolean }) => value.reused)).toBe(true);
    expect(retry.saveManifest.items.map((value: { snapshotId: string }) => value.snapshotId)).toEqual(captured.saveManifest.items.map((value: { snapshotId: string }) => value.snapshotId));
    const ref = captured.saveManifest.items[0], args = ['--workspace', f.workspace, '--snapshot', ref.snapshotId, '--source-version', ref.sourceVersion, '--json'];
    expect(JSON.parse((await runCommand(ObserveKnowledge, ['source', ...args], { cwd: f.root })).stdout).status).toBe('available');
    await runCommand(ObserveKnowledge, ['delete-source', ...args], { cwd: f.root });
    expect(JSON.parse((await runCommand(ObserveKnowledge, ['source', ...args], { cwd: f.root })).stdout)).toMatchObject({ status: 'unavailable', reason: 'deleted' });
    await expect(f.capture()).rejects.toMatchObject({ code: 1 }); expect(readdirSync(join(f.workspace, 'sources'))).toHaveLength(2); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['content', 'binding', 'material'] as const)('refuses a changed %s before capture publication across command instances', async change => {
    const f = fixture(); await f.preview();
    if (change === 'content') writeFileSync(f.source, '先决条件\r\nchanged selected contents');
    else if (change === 'binding') { const old = join(f.root, 'old-project'); renameSync(f.project, old); mkdirSync(f.project); writeFileSync(f.source, readFileSync(join(old, 'guide.txt'))); }
    else { f.scope.projects[0].materials![0].materialType = 'test_expectation'; writeFileSync(f.scopePath, JSON.stringify(f.scope)); }
    await expect(f.capture()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('knowledge_conflict') }); expect(existsSync(f.workspace)).toBe(false);
  });

  it('binds scope identity and declared trace kind without accepting portable host paths or unknown bindings', async () => {
    const f = fixture(), app = createLocalKnowledgeApplication(f.workspace, { sourceScope: f.scope });
    expect(() => createLocalKnowledgeApplication(f.workspace, { sourceScope: f.scope, sourceCapture: createLocalSourceCapture(f.workspace, f.scope) })).toThrow('either');
    for (const selection of [{ ...f.selections[0], root: f.project }, { ...f.selections[0], relativePath: '../guide.txt' }, { ...f.selections[0], relativePath: f.source }]) {
      writeFileSync(f.input, JSON.stringify({ selections: [selection] }));
      await expect(f.preview()).rejects.toMatchObject({ code: 2 });
    }
    expect(() => app.previewSources([{ ...f.selections[0], projectId: 'unknown' }])).toThrow('trusted host binding');
    expect(() => app.previewSources([{ ...f.selections[1], traceKind: 'claude-code' }])).toThrow('trusted host binding');
    const linked = join(f.project, 'linked.txt'); symlinkSync(f.source, linked);
    expect(() => app.previewSources([{ ...f.selections[0], relativePath: 'linked.txt' }])).toThrow('symbolic'); expect(existsSync(f.workspace)).toBe(false);
    expect(LocalSourceScopeSchema.safeParse({ ...f.scope, projects: [...f.scope.projects, f.scope.projects[0]] }).success).toBe(false);
  });

  it('reads only bounded ordinary scope JSON and fails closed on missing trusted roots without exposing their paths', async () => {
    const f = fixture(), linked = join(f.root, 'linked-scope.json'); symlinkSync(f.scopePath, linked);
    expect(() => readLocalSourceScope(linked)).toThrow();
    const oversized = join(f.root, 'oversized.json'); writeFileSync(oversized, '{}'); truncateSync(oversized, 1024 * 1024 + 1); expect(() => readLocalSourceScope(oversized)).toThrow('1 MiB');
    writeFileSync(f.scopePath, Buffer.from([123, 34, 255, 34, 58, 49, 125])); expect(() => readLocalSourceScope(f.scopePath)).toThrow();
    const service = createLocalSourceCapture(f.workspace, f.scope); rmSync(f.project, { recursive: true });
    try { service.preview(f.selections); throw new Error('Expected unavailable trusted binding.'); }
    catch (error) { expect(error).toBeInstanceOf(SourceCaptureError); expect(String(error)).not.toContain(f.project); }
    expect(existsSync(f.workspace)).toBe(false);
  });

  it('rejects retired source/snapshot generation inputs and incomplete exact refs before settings/storage/model access', async () => {
    const f = fixture(); vi.stubEnv('OMK_HOME', f.root); writeFileSync(join(f.root, 'settings.json'), '{invalid');
    for (const args of [['capture', '--source', f.trace], ['generate', '--snapshot', randomUUID()], ['source', '--snapshot', randomUUID()],
      ['delete-source', '--snapshot', randomUUID()], ['retrieve', '--query', 'q', '--snapshot', randomUUID()], ['retrieve', '--query', 'q', '--source-version', sha('x')]]) {
      await expect(runCommand(ObserveKnowledge, [...args, '--workspace', f.workspace], { cwd: f.root })).rejects.toMatchObject({ code: 2 });
    }
    for (const operation of ['generate', 'prepare-generation']) {
      writeFileSync(f.input, JSON.stringify({ sources: [{ snapshotId: randomUUID() }] }));
      await expect(runCommand(ObserveKnowledge, [operation, '--input', f.input, '--workspace', f.workspace], { cwd: f.root })).rejects.toMatchObject({ code: 2 });
    }
    const ref = { snapshotId: randomUUID(), sourceVersion: sha('source') };
    expect(KnowledgeOperationSchema.safeParse({ operation: 'generate', sources: [ref], executor: 'openai-api', model: 'fixture' }).success).toBe(false);
    expect(KnowledgeOperationSchema.safeParse({ operation: 'source', snapshot: ref.snapshotId }).success).toBe(false);
    expect(KnowledgeOperationSchema.safeParse({ operation: 'retrieve', query: 'q', snapshot: ref.snapshotId }).success).toBe(false);
    expect(existsSync(f.workspace)).toBe(false); expect(readFileSync(join(f.root, 'settings.json'), 'utf8')).toBe('{invalid');
  });

  it('rebuilds exact shared capture input and reports conflict/capacity/busy using shared failure codes', async () => {
    const f = fixture(), preview = await executeKnowledgeOperation(createLocalKnowledgeApplication(f.workspace, { sourceScope: f.scope }), { operation: 'preview-sources', selections: f.selections });
    const request = { operation: 'capture' as const, selections: preview.items.map(item => item.resolvedSelection), previewDigest: preview.previewDigest };
    const saved = await executeKnowledgeOperation(createLocalKnowledgeApplication(f.workspace, { sourceScope: f.scope }), request); expect(saved.sources).toHaveLength(2);
    await expect(executeKnowledgeOperation(createLocalKnowledgeApplication(f.workspace, { sourceScope: f.scope }), { ...request, previewDigest: sha('forged') })).rejects.toThrow('semantic digest');
    for (const code of ['preview_mismatch', 'scope_changed', 'source_changed'] as const) expect(knowledgeFailureCode(new SourceCaptureError(code, 'authored refusal'))).toBe('knowledge_conflict');
    expect(knowledgeFailureCode(new SourceCaptureError('capacity_exceeded', 'authored refusal'))).toBe('knowledge_capacity_exceeded');
    expect(knowledgeFailureCode(new SourceStoreError('busy', 'authored lock'))).toBe('knowledge_workspace_busy');
  });

  it('uses the shared local generation host for default CLI preparation without dispatch', async () => {
    const f = fixture(); await f.preview(); const captured = JSON.parse((await f.capture()).stdout);
    const sources = captured.saveManifest.items.map(({ snapshotId, sourceVersion }: { snapshotId: string; sourceVersion: string }) => ({ snapshotId, sourceVersion }));
    const input = join(f.root, 'sources.json'); writeFileSync(input, JSON.stringify({ sources }));
    const invoke = vi.fn<KnowledgeGenerationModel['invoke']>(async () => { throw new Error('No model dispatch authorized by preparation.'); });
    const inspect = vi.fn<KnowledgeGenerationModel['inspect']>(() => ({ producerId: 'authored-cli-host', producerRevision: 'fixture-v1', sourceChannels: [],
      maxOutcomeJsonBytes: 1024 * 1024, proof: { synthetic: true } }));
    const model: KnowledgeGenerationModel = { executor: 'openai-api', model: 'authored-cli-model', timeoutMs: 300_000, inspect, invoke };
    const factory = vi.spyOn(generationHost, 'createLocalKnowledgeGenerationModel').mockReturnValue(model);
    const prepared = JSON.parse((await runCommand(ObserveKnowledge, ['prepare-generation', '--workspace', f.workspace, '--input', input,
      '--executor', 'openai-api', '--model', model.model, '--json'], { cwd: f.root })).stdout);
    expect(factory).toHaveBeenCalledExactlyOnceWith('openai-api', model.model, createExtractionArchiveProducer); expect(inspect).toHaveBeenCalledOnce(); expect(invoke).not.toHaveBeenCalled();
    expect(prepared.journal).toMatchObject({ executor: model.executor, model: model.model, stages: [{ state: 'prepared', producer: { producerId: 'authored-cli-host' } }] });
    expect(existsSync(join(f.workspace, 'generation-journals', 'outcomes'))).toBe(false);
  });

  it('exports and confirms a fixed Source2 migration plan without settings, models or original-byte changes', async () => {
    const f = fixture(), old = join(f.root, 'source2'), target = join(f.root, 'source3'); mkdirSync(join(old, 'sources'), { recursive: true });
    const records = [{ recordIndex: 0, raw: readFileSync(f.trace, 'utf8') }], snapshotId = randomUUID();
    const source = EvidenceWindowSchema.parse({ snapshotId, sourceVersion: sha(JSON.stringify(records)), sourceKind: 'codex', sourcePath: '/unavailable-original.jsonl', projectionVersion: 'knowledge-window-v2',
      capturedAt: '2026-10-30T00:00:00.000Z', startRecord: 0, endRecord: 0, records, excerpts: [{ evidenceRef: `${snapshotId}:0`, recordIndex: 0, eventKind: 'message', role: 'user', text: '协作原文😀' }], limitations: [] });
    const originalPath = join(old, 'sources', `${snapshotId}.json`), original = JSON.stringify({ ...source, windowDigest: sha(JSON.stringify(source, null, 2)) }); writeFileSync(originalPath, original);
    const build = join(f.root, 'matching-fixture.tgz'); writeFileSync(build, 'authored archive fixture; no installation claim');
    vi.stubEnv('OMK_HOME', f.root); writeFileSync(join(f.root, 'settings.json'), '{invalid'); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const plan = JSON.parse((await runCommand(ObserveKnowledge, ['migrate-sources', '--from-workspace', old, '--workspace', target, '--operation-id', randomUUID(),
      '--matching-build', build, '--matching-build-id', 'authored-fixture', '--plan-only', '--json'], { cwd: f.root })).stdout);
    expect(existsSync(target)).toBe(false); const input = join(f.root, 'plan.json'); writeFileSync(input, JSON.stringify(plan));
    await expect(runCommand(ObserveKnowledge, ['migrate-sources', '--input', input, '--confirm-plan', sha('forged')], { cwd: f.root })).rejects.toMatchObject({ code: 1 }); expect(existsSync(target)).toBe(false);
    const command = ['migrate-sources', '--input', input, '--confirm-plan', plan.planDigest, '--json'];
    const result = JSON.parse((await runCommand(ObserveKnowledge, command, { cwd: f.root })).stdout); expect(result).toMatchObject({ state: 'complete', modelCalls: 0, semanticAcceptance: false });
    expect(JSON.parse((await runCommand(ObserveKnowledge, command, { cwd: f.root })).stdout)).toEqual(result); expect(readFileSync(originalPath, 'utf8')).toBe(original);
    expect(readFileSync(join(plan.archiveRoot, 'matching-build', 'matching-fixture.tgz'), 'utf8')).toContain('no installation claim'); expect(fetch).not.toHaveBeenCalled();
  });
});
