import { ExtractionRunSchema } from '../../src/knowledge/extraction/runs.js';
import { FileExtractionRunStore } from '../../src/knowledge/adapters/run-store.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync, cpSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserSettingsStore } from '../../src/evidence/storage/user-settings.js';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import ObserveEntityLinks from '../../src/cli/commands/observe/entity-links.js';
import { createEntityLinkCliPlan, formatEntityLinkInvocation } from '../../src/cli/lib/entity-link-output.js';
import { runCommand } from '../helpers/run-command.js';
import { CLI_ENTRY, runCli, runCliFailing } from '../helpers/cli-process.js';
import { createLocalKnowledgeApplication, createLocalEntityLinks, createLocalKnowledgeLibrary, parseEntityLinkPreview } from '../../src/knowledge/application/local.js';
import { createOpenAiArchiveProducer } from '../../src/executors/openai/archive.js';
import { KnowledgeApplication } from '../../src/knowledge/application/application.js';
import { EntityAnalysisWriteCapacityError } from '../../src/knowledge/entities/contracts.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { authoredKnowledgeResponse, authoredSourceDecision, seedKnowledgeWorkspace } from './knowledge-fixtures.js';
import { formatKnowledgeResult } from '../../src/cli/lib/knowledge-output.js';
import { SOURCE_LEDGER_GENERATION_PROFILE, SOURCE_COVERAGE_GENERATION_PROFILE } from '../../src/knowledge/extraction/source-review-wire.js';
import { BODY_GENERATION_PROFILE, ASSOCIATION_GENERATION_PROFILE } from '../../src/knowledge/extraction/body-generation-wire.js';

const roots: string[] = [];
const linkServers: Server[] = [];
async function captureTrace(root: string, workspace: string | undefined, path: string, json = true) {
  const scope = join(root, `${randomUUID()}-scope.json`), input = join(root, `${randomUUID()}-selection.json`), previewPath = join(root, `${randomUUID()}-preview.json`);
  writeFileSync(scope, JSON.stringify({ scopeVersion: 'knowledge-source-scope/v1', projects: [], traces: [{ sourceId: 'cli-trace', traceKind: 'codex', path }] }));
  writeFileSync(input, JSON.stringify({ selections: [{ sourceKind: 'agent_trace', sourceId: 'cli-trace', traceKind: 'codex', recordRanges: [{ startRecord: 0, endRecord: 0 }] }] }));
  const common = [...(workspace ? ['--workspace', workspace] : []), '--scope', scope];
  writeFileSync(previewPath, (await runCommand(ObserveKnowledge, ['preview-sources', ...common, '--input', input, '--json'], { cwd: root })).stdout);
  return runCommand(ObserveKnowledge, ['capture', ...common, '--input', previewPath, ...(json ? ['--json'] : ['--lang', 'zh'])], { cwd: root });
}
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const server of linkServers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('observe knowledge command wiring', () => {
  it('seals/query old-wire runs through the real CLI with explicit workspace, no usable settings/producer, and exact replay identities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omk-run-seal-cli-')); roots.push(directory);
    const workspace = join(directory, 'workspace'), home = join(directory, 'home'); mkdirSync(home);
    writeFileSync(join(home, 'settings.json'), '{invalid');
    const env = { ...process.env, HOME: home, OMK_HOME: home, NODE_ENV: 'test', OMK_SKIP_UPDATE_CHECK: '1',
      OPENAI_API_KEY: '', OPENAI_BASE_URL: 'not a valid endpoint', CODEX_HOME: join(directory, 'missing-codex-home') };
    const digest = `sha256:${'a'.repeat(64)}`, runId = randomUUID(), attemptId = randomUUID(), at = '2026-10-21T00:00:00Z';
    const run = ExtractionRunSchema.parse({ runKind: 'knowledge-extraction-run', schemaVersion: 5, runId, requestDigest: digest, generation: 1,
      snapshotId: randomUUID(), sourceVersion: digest, executor: 'codex', model: 'authored-local-fixture', promptVersion: 'knowledge-extraction-v18',
      promptHash: digest, inputDigest: digest, actor: { actorKind: 'human', actorId: 'fixture' }, startedAt: at, status: 'generating',
      policy: { policyId: 'knowledge-generation-single/v1', maxInvocations: 1, retry: 'none', fallback: 'none' },
      attempts: [{ attemptId, startedAt: at, requestDigest: digest, request: { systemDigest: digest, inputDigest: digest, outputMode: 'json-schema',
        wireId: digest, timeoutMs: 300_000 }, producer: { producerId: 'authored-local-fixture', producerRevision: digest,
        sourceChannels: [{ channel: 'fixture', maxBytes: 1024 }], maxOutcomeJsonBytes: 1024, proof: { scope: 'authored-not-real-execution' } } }],
      intents: [], committed: [], rejections: [] });
    const store = new FileExtractionRunStore(join(workspace, 'extraction-runs'), workspace); store.create(run);
    const outcome = { outcomeKind: 'model-port-projection' as const, scope: 'authored-model-port/v1' as const, result: { output: 'opaque old wire output', durationMs: 0 } };
    const ref = store.writeOutcome(runId, attemptId, outcome, 1024); store.save({ ...run, generation: 2, attempts: [{ ...run.attempts[0], outcome: ref }] }, 1);
    const path = join(workspace, 'extraction-runs', `${runId}.json`), original = readFileSync(path), options = { cwd: directory, env, timeout: 30_000 };
    const base = ['--workspace', workspace, '--id', runId, '--json', '--lang', 'en'];
    const preview = JSON.parse((await runCli(['observe', 'knowledge', 'sealed-runs', ...base], options)).stdout);
    expect(preview).toMatchObject({ state: 'unsealed', evidenceScope: 'current-old-wire', executionStatus: 'unknown' });
    const operation = randomUUID(), seal = ['observe', 'knowledge', 'seal-run', ...base, '--operation-id', operation, '--operator', 'human-fixture', '--reason', 'Explicit fixture disposition',
      '--manifest-digest', preview.expectedManifestDigest, '--inventory-digest', preview.expectedInventoryDigest];
    const first = JSON.parse((await runCli(seal, options)).stdout);
    expect(first).toMatchObject({ state: 'sealed', disposition: 'human_sealed', executionStatus: 'unknown', request: { operationId: operation } });
    expect(first).not.toHaveProperty('originalRun');
    const marker = readFileSync(path); expect(JSON.parse((await runCli(seal, options)).stdout)).toEqual(first); expect(readFileSync(path)).toEqual(marker);
    const conflict = [...seal]; conflict[conflict.indexOf('--operator') + 1] = 'different-human';
    expect((await runCliFailing(conflict, 1, options)).stderr).toContain('run_seal_conflict'); expect(readFileSync(path)).toEqual(marker);
    await runCliFailing(['observe', 'knowledge', 'seal-run', '--id', runId], 2, options);
    const list = JSON.parse((await runCli(['observe', 'knowledge', 'sealed-runs', '--workspace', workspace, '--json'], options)).stdout);
    expect(list).toMatchObject([{ state: 'sealed', executionStatus: 'unknown' }]);
    expect(readFileSync(join(workspace, 'extraction-runs', 'seals', 'current', runId, 'evidence', 'manifest.json'))).toEqual(original);
    expect(createLocalKnowledgeApplication(workspace).quality()).toMatchObject({ projectionKind: 'knowledge-body-admission', current: [], unsupported: [{ runId, schemaStatus: 'unsupported' }], semanticQuality: 'not_assessed' });
    expect(() => createLocalKnowledgeApplication(workspace).resume(runId)).toThrow('knowledge_storage_unsupported');
    expect(existsSync(join(workspace, 'entities'))).toBe(false); expect(existsSync(join(workspace, 'items'))).toBe(false);
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{invalid');
    const legacy = join(workspace, 'runs'); mkdirSync(legacy); const oldId = randomUUID(), oldPath = join(legacy, `${oldId}.json`);
    writeFileSync(oldPath, `{ "runKind":"knowledge-extraction-run", "schemaVersion":4, "runId":"${oldId}", "uninterpreted":"legacy bytes" }\n`);
    const oldFlags = ['--workspace', workspace, '--id', oldId, '--storage-namespace', 'legacy', '--json'];
    const old = JSON.parse((await runCli(['observe', 'knowledge', 'sealed-runs', ...oldFlags], options)).stdout);
    const opaque = ['observe', 'knowledge', 'seal-run', ...oldFlags, '--operation-id', randomUUID(), '--operator', 'human-fixture', '--reason', 'Fixture old writer declared offline',
      '--manifest-digest', old.expectedManifestDigest, '--inventory-digest', old.expectedInventoryDigest];
    await runCliFailing(opaque, 1, options);
    expect(JSON.parse((await runCli([...opaque, '--offline'], options)).stdout)).toMatchObject({ state: 'sealed', evidenceScope: 'opaque-unsupported-schema',
      executionStatus: 'unknown', request: { offlineDeclared: true } });
  }, 120_000);
  it('confirms four stages and an actual source decision through the actual CLI producer, persists both originals and resumes without dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-body-cli-')); roots.push(root); vi.stubEnv('OMK_HOME', root);
    const threadId = randomUUID(); vi.stubEnv('CODEX_THREAD_ID', threadId); vi.stubEnv('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'Codex Desktop');
    vi.stubEnv('OPENAI_API_KEY', 'isolated-loopback-fixture-key'); vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:9321');
    const workspace = join(root, 'knowledge'), source = join(root, 'source.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
    const captured = JSON.parse((await captureTrace(root, workspace, source)).stdout).sources[0].snapshot;
    const requests: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(_url).toBe('http://127.0.0.1:9321/v1/chat/completions'); expect(init?.redirect).toBe('error');
      const request = JSON.parse(String(init?.body)); requests.push(request);
      expect(request).toMatchObject({ model: 'authored-loopback-test', n: 1, stream: false }); expect(request.max_completion_tokens).toBeUndefined();
      const name = request.response_format.json_schema.name as string, stage = name.includes('source_ledger') ? 'source_ledger' : name.includes('source_coverage') ? 'source_coverage' : name.includes('association') ? 'association' : 'body';
      const output = authoredKnowledgeResponse(request.messages.at(-1).content, stage);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }));
    }); vi.stubGlobal('fetch', fetch);
    const runId = randomUUID(), input = join(root, 'sources.json'); writeFileSync(input, JSON.stringify({ sources: [{ snapshotId: captured.snapshotId, sourceVersion: captured.sourceVersion }] }));
    const base = ['--workspace', workspace, '--input', input, '--executor', 'openai-api', '--model', 'authored-loopback-test', '--run-id', runId, '--json'];
    const prepared = JSON.parse((await runCommand(ObserveKnowledge, ['prepare-generation', ...base], { cwd: root })).stdout); expect(fetch).not.toHaveBeenCalled();
    expect(prepared.journal.actor).toEqual({ actorKind: 'human', actorId: 'local-user' });
    const args = ['generate', ...base, '--confirm-request', prepared.journal.stages[0].requestDigest];
    let run = JSON.parse((await runCommand(ObserveKnowledge, args, { cwd: root })).stdout); expect(fetch).toHaveBeenCalledTimes(1);
    const dispatch = async (prepared: typeof run) => JSON.parse((await runCommand(ObserveKnowledge, ['continue-stage', '--workspace', workspace, '--id', runId, '--generation', String(prepared.journal.generation),
      '--executor', 'openai-api', '--model', 'authored-loopback-test', '--confirm-request', prepared.journal.stages.at(-1).requestDigest, '--json'], { cwd: root })).stdout);
    for (const expected of ['body', 'source_coverage']) {
      expect(run.nextAction).toBe('prepare_next_stage');
      const next = JSON.parse((await runCommand(ObserveKnowledge, ['prepare-generation', ...base], { cwd: root })).stdout);
      expect(next.journal.stages.at(-1).stageKind).toBe(expected); run = await dispatch(next);
    }
    expect(run.nextAction).toBe('review_source_coverage'); expect(fetch).toHaveBeenCalledTimes(3);
    const status = JSON.parse((await runCommand(ObserveKnowledge, ['source-coverage-status', '--workspace', workspace, '--id', run.journal.coverageRef.coverageId, '--json'], { cwd: root })).stdout);
    const decision = authoredSourceDecision(status), decisionPath = join(root, 'decision.json'); writeFileSync(decisionPath, JSON.stringify(decision));
    vi.stubEnv('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'unknown');
    await expect(runCommand(ObserveKnowledge, ['review-source-coverage', '--workspace', workspace, '--input', decisionPath, '--json'], { cwd: root })).rejects.toMatchObject({ code: 2 });
    vi.stubEnv('CODEX_THREAD_ID', threadId); vi.stubEnv('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'Codex Desktop');
    const receipt = JSON.parse((await runCommand(ObserveKnowledge, ['review-source-coverage', '--workspace', workspace, '--input', decisionPath, '--json'], { cwd: root })).stdout);
    expect(JSON.parse((await runCommand(ObserveKnowledge, ['review-source-coverage', '--workspace', workspace, '--input', decisionPath, '--json'], { cwd: root })).stdout)).toEqual(receipt);
    const { coverageRef, sourceSetId, ledgerRef, bodyRefs } = decision.decision;
    writeFileSync(input, JSON.stringify({ sources: [{ snapshotId: captured.snapshotId, sourceVersion: captured.sourceVersion }], sourceCoverageDecisionRef: { coverageRef, sourceSetId, ledgerRef, bodyRefs, eventId: decision.requestId } }));
    run = await dispatch(JSON.parse((await runCommand(ObserveKnowledge, ['prepare-generation', ...base], { cwd: root })).stdout));
    expect(run.journal).toMatchObject({ workflowId: 'knowledge-body-first/v4', status: 'completed', bodies: [expect.anything()],
      stages: ['source_ledger', 'body', 'source_coverage', 'association'].map(stageKind => ({ stageKind, state: 'completed', outcomeRef: expect.any(Object) })) });
    expect(fetch).toHaveBeenCalledTimes(4); expect(requests[0].messages).not.toEqual(requests[1].messages);
    const app = createLocalKnowledgeApplication(workspace); expect(app.inspect(runId).nativeOutcomes).toHaveLength(4);
    expect(app.inspect(runId).journal.actor).toEqual({ actorKind: 'human', actorId: 'local-user' });
    expect(app.detail(run.journal.bodies[0].knowledgeId)).toMatchObject({ maintenance: null, derivedAssociations: { status: 'available', reviewStatus: 'pending' } });
    writeFileSync(input, JSON.stringify({ sources: [{ snapshotId: captured.snapshotId, sourceVersion: captured.sourceVersion }] }));
    expect(JSON.parse((await runCommand(ObserveKnowledge, args, { cwd: root })).stdout)).toEqual(run);
    expect(JSON.parse((await runCommand(ObserveKnowledge, ['resume', '--workspace', workspace, '--id', runId, '--json'], { cwd: root })).stdout)).toEqual(run); expect(fetch).toHaveBeenCalledTimes(4);
    const quality = JSON.parse((await runCommand(ObserveKnowledge, ['quality', '--workspace', workspace, '--json'], { cwd: root })).stdout);
    expect(quality).toMatchObject({ current: [{ runId, savedBodies: 1 }], unsupported: [], semanticQuality: 'not_assessed' });
    const completed = formatKnowledgeResult(run, 'zh', { operation: 'resume', id: runId }, workspace);
    expect(completed).toContain('body: completed'); expect(completed).toContain('association: completed'); expect(completed).toContain('--workspace'); expect(completed).not.toContain('重问');
    const waiting = formatKnowledgeResult({ ...run, nextAction: 'continue_stage', journal: { ...run.journal, status: 'active',
      stages: [...run.journal.stages.slice(0, 3), { ...run.journal.stages[3], state: 'prepared', outcomeRef: undefined }] } }, 'zh', { operation: 'resume', id: runId }, workspace);
    expect(waiting).toContain('association: prepared'); expect(waiting).toContain('resume 永不调用模型'); expect(waiting).toContain('continue-stage');
  });
  it('exports the exact wire schema and identity before reading settings or creating a workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-schema-cli-')); roots.push(root);
    vi.stubEnv('OMK_HOME', root);
    const settings = join(root, 'settings.json'); writeFileSync(settings, '{invalid');
    const workspace = join(root, 'unused-workspace');
    for (const profile of [SOURCE_LEDGER_GENERATION_PROFILE, BODY_GENERATION_PROFILE, SOURCE_COVERAGE_GENERATION_PROFILE, ASSOCIATION_GENERATION_PROFILE]) {
      const args = ['schema', '--workspace', workspace, '--stage', profile.stageKind];
      const raw = JSON.parse((await runCommand(ObserveKnowledge, args, { cwd: root })).stdout);
      const bundle = JSON.parse((await runCommand(ObserveKnowledge, [...args, '--json'], { cwd: root })).stdout);
      expect(bundle).toEqual(raw); expect(bundle).toEqual({ profileId: profile.profileId, promptVersion: profile.promptVersion, wireId: profile.wireId, schema: profile.wireSchema });
    }
    expect(readFileSync(settings, 'utf8')).toBe('{invalid');
    expect(existsSync(workspace)).toBe(false);
  });
  it('captures one selected source, inspects it and deletes its snapshot through shared operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-cli-')); roots.push(root);
    const path = join(root, 'trace.jsonl ');
    const workspace = join(root, 'knowledge');
    writeFileSync(path, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请记住项目规则' }] } }));
    const output = await captureTrace(root, workspace, path);
    const captured = JSON.parse(output.stdout).sources[0].snapshot;
    expect(captured.rawUnits).toHaveLength(1);
    const read = await runCommand(ObserveKnowledge, ['source', '--workspace', workspace, '--snapshot', captured.snapshotId, '--source-version', captured.sourceVersion, '--json'], { cwd: root });
    expect(JSON.parse(read.stdout).status).toBe('available');
    await runCommand(ObserveKnowledge, ['delete-source', '--workspace', workspace, '--snapshot', captured.snapshotId, '--source-version', captured.sourceVersion], { cwd: root });
    const deleted = await runCommand(ObserveKnowledge, ['source', '--workspace', workspace, '--snapshot', captured.snapshotId, '--source-version', captured.sourceVersion, '--json'], { cwd: root });
    expect(JSON.parse(deleted.stdout)).toMatchObject({ status: 'unavailable', reason: 'deleted' });
  });
  it('reads the same saved workspace as Studio when the flag is omitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-settings-cli-')); roots.push(root);
    vi.stubEnv('OMK_HOME', root);
    const workspace = join(root, 'chosen');
    new UserSettingsStore(root).save({ schemaVersion: 2, knowledge: { workspace } }, 'missing');
    const source = join(root, 'source.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fixture' }] } }));
    const captured = JSON.parse((await captureTrace(root, undefined, source)).stdout).sources[0].snapshot;
    const result = await runCommand(ObserveKnowledge, ['source', '--workspace', workspace, '--snapshot', captured.snapshotId, '--source-version', captured.sourceVersion, '--json'], { cwd: root });
    expect(JSON.parse(result.stdout).status).toBe('available');
  });
  it('rejects missing operation-specific parameters before accessing storage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-cli-')); roots.push(root);
    vi.stubEnv('OMK_HOME', root); writeFileSync(join(root, 'settings.json'), '{invalid');
    await expect(runCommand(ObserveKnowledge, ['retain', '--workspace', root], { cwd: root })).rejects.toMatchObject({ code: 2 });
    for (const args of [['list', '--generation-policy', '{}'], ['schema', '--generation-policy', '{}'],
      ['list', '--citations', 'missing.json'], ['schema', '--citations', 'missing.json'], ['correct-entities', '--citations', 'missing.json'],
      ['generate', '--snapshot', 'fixture', '--generation-policy', '{invalid'], ['generate', '--snapshot', 'fixture', '--generation-policy', '{}']]) {
      await expect(runCommand(ObserveKnowledge, args, { cwd: root })).rejects.toMatchObject({ code: 2 });
    }
  });
  it('validates complete body JSON input files before settings/storage and rejects retired citation or bounded flags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-body-input-cli-')); roots.push(root); vi.stubEnv('OMK_HOME', root);
    writeFileSync(join(root, 'settings.json'), '{invalid'); const workspace = join(root, 'unused'), bad = join(root, 'bad.json'), linked = join(root, 'linked.json');
    writeFileSync(bad, '{invalid'); symlinkSync(bad, linked);
    for (const input of [join(root, 'missing.json'), bad, linked]) {
      await expect(runCommand(ObserveKnowledge, ['revise', '--workspace', workspace, '--id', 'knowledge', '--revision', 'revision', '--generation', '1', '--input', input, '--reason', '核对正文'], { cwd: root })).rejects.toMatchObject({ code: 2 });
    }
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{invalid'); expect(existsSync(workspace)).toBe(false);
  });
  it('keeps text next steps in the selected workspace and leaves JSON as a single machine result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-cli-loop-')); roots.push(root);
    const workspace = join(root, 'chosen workspace'); const source = join(root, 'source.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
    const text = await captureTrace(root, workspace, source, false);
    expect(text.stdout).toContain('observe knowledge source');
    expect(text.stdout).toContain(`--workspace '${workspace}'`);
    const empty = await runCommand(ObserveKnowledge, ['list', '--workspace', join(root, 'empty'), '--lang', 'en'], { cwd: root });
    expect(empty.stdout).toContain('[]'); expect(empty.stdout).toContain(workspace.split('/').slice(0, -1).join('/'));
    expect(existsSync(join(root, 'empty'))).toBe(false);
    const json = await runCommand(ObserveKnowledge, ['list', '--workspace', join(root, 'empty'), '--json'], { cwd: root });
    expect(JSON.parse(json.stdout)).toEqual([]); expect(json.stdout).not.toContain('Next');
  });
  it.each(['desktop', 'ordinary'] as const)('attributes all six maintenance commands in %s context without rewriting history or creation identity', async context => {
    const root = mkdtempSync(join(tmpdir(), 'omk-current-entity-cli-')); roots.push(root);
    vi.stubEnv('OMK_HOME', root);
    const threadId = randomUUID();
    vi.stubEnv('CODEX_THREAD_ID', context === 'desktop' ? threadId : undefined);
    vi.stubEnv('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', context === 'desktop' ? 'Codex Desktop' : undefined);
    const actor = context === 'desktop' ? { actorKind: 'agent', actorId: `codex:${threadId}`, executionRef: `codex-thread:${threadId}` }
      : { actorKind: 'human', actorId: 'local-user' };
    const workspace = join(root, 'knowledge'), seeded = seedKnowledgeWorkspace(workspace, 'cli');
    const app = createLocalKnowledgeApplication(workspace), analysisId = seeded.ref().analysisId, base = ['--workspace', workspace, '--lang', 'zh'];
    const knowledge = new FileKnowledgeStore(join(workspace, 'items'), 'local', workspace), entities = new FileEntityAnalysisStore(join(workspace, 'entities'), workspace);
    const associations = new FileKnowledgeAssociationStore(join(workspace, 'associations'), 'local', knowledge, entities, workspace);
    const oldBody = knowledge.read(seeded.body.knowledgeId), oldCatalog = entities.read(analysisId), oldAssociation = associations.read(seeded.body.knowledgeId);
    const found = JSON.parse((await runCommand(ObserveKnowledge, ['entities', ...base, '--query', 'Alpha', '--page-size', '1', '--json'], { cwd: root })).stdout);
    expect(found).toMatchObject({ total: 1, pageSize: 1, rows: [{ label: 'Alpha', knowledgeCount: 1 }] });
    const before = app.entities(analysisId), edit = structuredClone({ entities: before.revision.entities, mentions: before.revision.mentions }); edit.entities[0].label = '项目 Alpha';
    const input = join(root, 'correction.json'); writeFileSync(input, JSON.stringify(edit));
    const correction = ['correct-entities', ...base, '--analysis', analysisId, '--entity-revision', before.revision.revisionId, '--generation', '1', '--input', input, '--reason', '核对名称', '--json'];
    const corrected = JSON.parse((await runCommand(ObserveKnowledge, correction, { cwd: root })).stdout); expect(corrected.history.generation).toBe(2);
    expect(entities.read(analysisId).revisions.at(-1)?.revisedBy).toEqual(actor);
    const correctedHistory = entities.read(analysisId);
    await expect(runCommand(ObserveKnowledge, correction, { cwd: root })).rejects.toMatchObject({ code: 1 });
    expect(entities.read(analysisId)).toEqual(correctedHistory);
    const draft = { catalogRefs: [{ analysisId, entityRevisionId: corrected.revision.revisionId }], segmentEntityRefs: [{ segmentId: 's1', analysisId, entityRevisionId: corrected.revision.revisionId, entityId: edit.entities[0].entityId, mentionIds: [edit.mentions[0].mentionId] }], typedRelations: [], issues: [] };
    writeFileSync(input, JSON.stringify(draft));
    const applied = JSON.parse((await runCommand(ObserveKnowledge, ['apply-associations', ...base, '--id', seeded.body.knowledgeId, '--revision', seeded.body.revisionId,
      '--body-digest', seeded.body.bodyDigest, '--generation', '1', '--input', input, '--reason', '明确修订关联', '--json'], { cwd: root })).stdout);
    expect(applied.revision).toEqual(seeded.body); expect(applied.derivedAssociations).toMatchObject({ reviewStatus: 'pending', revision: { catalogRefs: [{ analysisId, entityRevisionId: corrected.revision.revisionId }] } });
    expect(associations.read(seeded.body.knowledgeId).revisions.at(-1)?.revisedBy).toEqual(actor);
    const reviewed = JSON.parse((await runCommand(ObserveKnowledge, ['review-associations', ...base, '--id', seeded.body.knowledgeId,
      '--revision', applied.derivedAssociations.revision.revisionId, '--generation', '2', '--choice', 'accept', '--reason', '逐项核对', '--json'], { cwd: root })).stdout);
    expect(reviewed.derivedAssociations.reviewStatus).toBe('accepted'); expect(reviewed.maintenance).toBeNull();
    expect(associations.read(seeded.body.knowledgeId).reviews.at(-1)?.actor).toEqual(actor);
    await runCommand(ObserveKnowledge, ['retain', ...base, '--id', seeded.body.knowledgeId, '--revision', seeded.body.revisionId, '--generation', '1', '--reason', '保留正文'], { cwd: root });
    expect(knowledge.read(seeded.body.knowledgeId).maintenance.at(-1)).toMatchObject({ choice: 'retain', actor });
    const bodyDraft = { title: '新的正文限定', content: seeded.body.content, reuseRationale: seeded.body.reuseRationale }; writeFileSync(input, JSON.stringify(bodyDraft));
    const revise = ['revise', ...base, '--id', seeded.body.knowledgeId, '--revision', seeded.body.revisionId, '--generation', '2', '--input', input, '--reason', '核对正文', '--json'];
    const revised = JSON.parse((await runCommand(ObserveKnowledge, revise, { cwd: root })).stdout);
    expect(revised.maintenance).toBeNull(); expect(revised.derivedAssociations.status).toBe('stale'); expect(revised.revision.content).toEqual(seeded.body.content);
    expect(knowledge.read(seeded.body.knowledgeId).revisions.at(-1)).toMatchObject({ revisedBy: actor, createdBy: seeded.body.createdBy, createdAt: seeded.body.createdAt });
    const revisedHistory = knowledge.read(seeded.body.knowledgeId);
    await expect(runCommand(ObserveKnowledge, revise, { cwd: root })).rejects.toMatchObject({ code: 1 });
    expect(knowledge.read(seeded.body.knowledgeId)).toEqual(revisedHistory);
    await runCommand(ObserveKnowledge, ['discard', ...base, '--id', seeded.body.knowledgeId, '--revision', revised.revision.revisionId,
      '--generation', '3', '--reason', '该修订暂不复用'], { cwd: root });
    expect(knowledge.read(seeded.body.knowledgeId).maintenance.at(-1)).toMatchObject({ revisionId: revised.revision.revisionId, choice: 'discard', actor });
    expect(app.detail(seeded.body.knowledgeId, seeded.body.revisionId).revision).toEqual(seeded.body);
    expect(app.detail(seeded.body.knowledgeId, seeded.body.revisionId).maintenance?.choice).toBe('retain');
    for (const { before, after } of [{ before: oldBody, after: knowledge.read(seeded.body.knowledgeId) },
      { before: oldCatalog, after: entities.read(analysisId) }, { before: oldAssociation, after: associations.read(seeded.body.knowledgeId) }]) {
      expect(after.revisions.slice(0, before.revisions.length)).toEqual(before.revisions);
      expect(after.receipts.slice(0, before.receipts.length)).toEqual(before.receipts);
    }
  });
  it.each(['history', 'file'] as const)('reports a known entity %s capacity refusal instead of invalid draft fields', async scope => {
    const root = mkdtempSync(join(tmpdir(), 'omk-entity-capacity-cli-')); roots.push(root); vi.stubEnv('OMK_HOME', root);
    const input = join(root, 'draft.json'); writeFileSync(input, JSON.stringify({ entities: [], mentions: [] }));
    const correction = vi.spyOn(KnowledgeApplication.prototype, 'correctEntities').mockImplementation(() => { throw new EntityAnalysisWriteCapacityError(scope); });
    try {
      const failure = await runCommand(ObserveKnowledge, ['correct-entities', '--workspace', join(root, 'knowledge'), '--analysis', randomUUID(),
        '--entity-revision', randomUUID(), '--generation', '1024', '--input', input, '--reason', '核对容量诊断', '--lang', 'zh'], { cwd: root })
        .then(() => undefined, cause => cause);
      expect(failure).toMatchObject({ code: 1, stderr: expect.stringContaining('knowledge_capacity_exceeded') });
      expect(failure.stderr).not.toContain('草稿内容未通过校验');
      expect(correction).toHaveBeenCalledOnce();
    } finally { correction.mockRestore(); }
  });
  it('rejects unknown operations, invalid filter values and flags before touching the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-current-cli-')); roots.push(root);
    for (const args of [['unknown'], ['entities', '--source-status', 'invalid'], ['list', '--unexpected'], ['capture', '--start-record', '-1']]) {
      await expect(runCommand(ObserveKnowledge, [...args, '--workspace', join(root, 'knowledge')], { cwd: root })).rejects.toMatchObject({ code: 2 });
    }
    expect(existsSync(join(root, 'knowledge'))).toBe(false);
  });
});

/** Actual dispatcher/process coverage for the new delivery route; all completions stay on loopback. */
describe('observe entity-links confirmed CLI flow', () => {
  const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'omk-entity-link-cli-')); roots.push(root); return root; };
  async function window(workspace: string, name: string) { return seedKnowledgeWorkspace(workspace, name); }
  function environment(root: string, endpoint: string): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, HOME: root, OMK_HOME: join(root, 'settings'), OMK_SKIP_UPDATE_CHECK: '1', LANG: 'C', LC_ALL: 'C',
      OPENAI_BASE_URL: endpoint, OPENAI_API_KEY: 'loopback-long-private-fixture-key' };
  }
  type Body = { messages: { content: string }[] };
  const completion = (body: Body) => {
    const input = JSON.parse(body.messages.at(-1)!.content);
    return { choices: [{ message: { content: JSON.stringify({ responseKind: 'entity-link-suggestion', schemaVersion: 1,
      leftEntityId: input.left.binding.entityId, rightEntityId: input.right.binding.entityId, assessment: 'insufficient_evidence',
      leftMentionIds: input.left.binding.mentionIds, rightMentionIds: input.right.binding.mentionIds, rationale: '同名不足以确认同一对象' }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 13, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } } };
  };
  async function transport(handler: (body: Body) => unknown | Promise<unknown> = completion) {
    const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw); requests.push(body); const output = await handler(body);
      if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(output)); }
    }); linkServers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address.');
    return { requests, endpoint: `http://127.0.0.1:${address.port}` };
  }
  const command = (operation: string, ...flags: string[]) => ['observe', 'entity-links', operation, ...flags];
  async function preview(root: string, workspace: string, left: { analysisId: string; entityId: string }, right: typeof left, env: NodeJS.ProcessEnv, extra: string[] = []) {
    const output = await runCli(command('preview', '--workspace', workspace, '--analysis', left.analysisId, '--entity', left.entityId,
      '--right-analysis', right.analysisId, '--right-entity', right.entityId, '--executor', 'openai-api', '--model', 'fixture-compatible-model', '--json', ...extra), { cwd: root, env });
    const plan = JSON.parse(output.stdout); const path = join(root, `${plan.preview.reviewId}.json`); writeFileSync(path, output.stdout);
    return { plan, path, args: command('propose', '--input', path, '--confirm-input', plan.confirmedDigest, '--json') };
  }
  it('rejects missing operation parameters before workspace access and retains parameter exit 2', async () => {
    const root = temporary(), workspace = join(root, 'unused'); vi.stubEnv('OMK_HOME', root); writeFileSync(join(root, 'settings.json'), '{invalid');
    for (const args of [['candidates'], ['show', '--id', 'not-a-uuid'], ['accept', '--id', randomUUID(), '--request-id', randomUUID(), '--generation', '1', '--reason', '核对'],
      ['resume', '--id', randomUUID(), '--recover-unknown', '--cancel-before-start'], ['unknown']]) {
      await expect(runCommand(ObserveEntityLinks, [...args, '--workspace', workspace], { cwd: root })).rejects.toMatchObject({ code: 2 });
    }
    const terminate = ['terminate', '--workspace', workspace, '--id', randomUUID(), '--request-id', randomUUID(),
      '--generation', '2', '--execution-id', randomUUID(), '--owner-id', randomUUID(), '--reason', '人工核对后终止'];
    for (const required of ['workspace', 'id', 'request-id', 'generation', 'execution-id', 'owner-id', 'reason']) {
      const args = [...terminate], index = args.indexOf(`--${required}`); args.splice(index, 2);
      await expect(runCommand(ObserveEntityLinks, args, { cwd: root })).rejects.toMatchObject({ code: 2 });
    }
    for (const name of ['id', 'request-id', 'execution-id', 'owner-id']) {
      const args = [...terminate]; args[args.indexOf(`--${name}`) + 1] = 'not-a-uuid';
      await expect(runCommand(ObserveEntityLinks, args, { cwd: root })).rejects.toMatchObject({ code: 2 });
    }
    const overlongReason = [...terminate]; overlongReason[overlongReason.indexOf('--reason') + 1] = 'x'.repeat(4097);
    await expect(runCommand(ObserveEntityLinks, overlongReason, { cwd: root })).rejects.toMatchObject({ code: 2 });
    for (const extra of [['--confirm-identity'], ['--model', 'ignored'], ['--input', '/must-not-read']]) {
      await expect(runCommand(ObserveEntityLinks, [...terminate, ...extra], { cwd: root })).rejects.toMatchObject({ code: 2 });
    }
    await expect(runCommand(ObserveEntityLinks, ['show', '--id', randomUUID(), '--owner-id', randomUUID(), '--workspace', workspace], { cwd: root }))
      .rejects.toMatchObject({ code: 2 });
    expect(existsSync(workspace)).toBe(false);
  });
  it('reads the shared link-quality projection without credentials or model dispatch, and reports unreadable rather than zero', async () => {
    const root = temporary(), workspace = join(root, 'knowledge'), a = await window(workspace, 'a'), b = await window(workspace, 'b');
    const app = createLocalEntityLinks(workspace, createOpenAiArchiveProducer({ OPENAI_API_KEY: 'fixture-prepare-only-key' }));
    const preview = app.preview(a.ref(), b.ref(), { executor: 'openai-api', model: 'fixture-only' });
    app.prepare({ ...preview, confirmDigest: preview.plan.confirmedDigest });
    vi.stubEnv('OMK_HOME', join(root, 'settings')); vi.stubEnv('OPENAI_API_KEY', '');
    const fetch = vi.fn(() => { throw new Error('Read must not dispatch.'); }); vi.stubGlobal('fetch', fetch);
    const output = await runCommand(ObserveEntityLinks, ['quality', '--workspace', workspace, '--json'], { cwd: root });
    expect(JSON.parse(output.stdout)).toEqual({ workspace, ...app.quality() }); expect(fetch).not.toHaveBeenCalled();
    const text = await runCommand(ObserveEntityLinks, ['quality', '--workspace', workspace, '--lang', 'zh'], { cwd: root });
    expect(text.stdout).toContain('人工决定分母'); expect(text.stdout).toContain('不代表准确率'); expect(text.stdout).toContain('未派发=1');
    writeFileSync(join(workspace, 'entity-links', `${preview.reviewId}.json`), '{broken');
    await expect(runCommand(ObserveEntityLinks, ['quality', '--workspace', workspace, '--json'], { cwd: root })).rejects.toMatchObject({ code: 1,
      stdout: expect.stringContaining('"readStatus": "unreadable"') });
    expect(app.quality()).toMatchObject({ readStatus: 'unreadable', reviewCount: null, groups: [] }); expect(fetch).not.toHaveBeenCalled();
  });
  it('dispatches a frozen saved plan once and explicitly organizes original UUIDs after human confirmation', async () => {
    const root = temporary(), workspace = join(root, 'knowledge'), a = await window(workspace, 'a'), b = await window(workspace, 'b');
    const api = await transport(), env = environment(root, api.endpoint), saved = await preview(root, workspace, a.ref(), b.ref(), env);
    const entityPaths = [a, b].map(value => join(workspace, 'entities', `${value.ref().analysisId}.json`)), originalEntities = entityPaths.map(path => readFileSync(path));
    const originalKnowledge = [a, b].map(value => createLocalKnowledgeApplication(workspace).detail(value.body.knowledgeId));
    expect(api.requests).toHaveLength(0); expect(existsSync(join(workspace, 'entity-links'))).toBe(false);
    expect(JSON.stringify(saved.plan)).not.toContain(env.OPENAI_API_KEY);
    const inspected = await runCli(command('preview', '--input', saved.path, '--lang', 'zh'), { cwd: root, env: environment(root, 'http://127.0.0.1:1') });
    expect(inspected.stdout).toContain(saved.plan.confirmedDigest); expect(inspected.stdout).toContain(saved.plan.preview.plan.request.prompt);
    expect(inspected.stdout).toContain(api.endpoint); expect(api.requests).toHaveLength(0);
    const pending = JSON.parse((await runCli(saved.args, { cwd: root, env })).stdout);
    expect(pending.projection).toMatchObject({ status: 'awaiting_review', invocationBudget: { reserved: 0, consumed: 1 }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, costUSD: null } });
    const reviewZh = formatEntityLinkInvocation(pending.history, pending.projection, workspace, 'zh');
    expect(reviewZh).toContain('Issue／PR 概念可以是实体，具体 Issue／PR 工作记录仅保留在来源或案例上下文');
    expect(reviewZh).toContain('先回到来源实体修订中纠正');
    expect(reviewZh).toContain('确认是同一对象，不代表应纳入实体目录');
    const reviewEn = formatEntityLinkInvocation(pending.history, pending.projection, workspace, 'en');
    expect(reviewEn).toContain('concrete Issue or PR records belong only in source or case context');
    expect(reviewEn).toContain('Other source-supported concrete instances remain eligible');
    expect(api.requests).toHaveLength(1); expect(api.requests[0]).toMatchObject({ n: 1, stream: false, response_format: { type: 'json_schema', json_schema: { strict: true } } });
    await runCli(saved.args, { cwd: root, env: environment(root, 'http://127.0.0.1:1') }); expect(api.requests).toHaveLength(1);
    const changedRequest = structuredClone(saved.plan.preview); changedRequest.requestId = randomUUID();
    const conflicting = createEntityLinkCliPlan(workspace, changedRequest), conflictPath = join(root, 'conflicting-request.json'); writeFileSync(conflictPath, JSON.stringify(conflicting));
    const conflict = await runCliFailing(command('propose', '--input', conflictPath, '--confirm-input', conflicting.confirmedDigest, '--json'), 1, { cwd: root, env });
    expect(conflict.stdout).toBe(''); expect(conflict.stderr).toContain('conflict'); expect(api.requests).toHaveLength(1);
    const show = command('show', '--workspace', workspace, '--id', pending.history.reviewId, '--json');
    expect(JSON.parse((await runCli(show, { cwd: root, env })).stdout).history).toEqual(pending.history);
    const accept = command('accept', '--workspace', workspace, '--id', pending.history.reviewId, '--request-id', randomUUID(), '--generation', String(pending.projection.generation),
      '--reason', '人工逐项核对两侧原文与对象身份', '--confirm-identity', '--object-label', 'Alpha 对象', '--json');
    const applied = JSON.parse((await runCli(accept, { cwd: root, env })).stdout); expect(applied.projection.status).toBe('applied');
    expect(JSON.parse((await runCli(accept, { cwd: root, env })).stdout).history).toEqual(applied.history);
    expect(entityPaths.map(path => readFileSync(path))).toEqual(originalEntities);
    expect([a, b].map(value => createLocalKnowledgeApplication(workspace).detail(value.body.knowledgeId))).toEqual(originalKnowledge);
    expect(a.ref().entityId).not.toBe(b.ref().entityId); expect(api.requests).toHaveLength(1);
    const listed = JSON.parse((await runCli(command('list', '--workspace', workspace, '--json'), { cwd: root, env })).stdout);
    expect(listed.rows).toHaveLength(1); expect(listed.rows[0].status).toBe('applied');
    await runCli(command('resume', '--workspace', workspace, '--id', pending.history.reviewId, '--json'), { cwd: root, env }); expect(api.requests).toHaveLength(1);
  });
  it('shows exact existing-member changes through accept-preview and requires its separate confirmation digest', async () => {
    const root = temporary(), workspace = join(root, 'knowledge'), a = await window(workspace, 'replace-a'), b = await window(workspace, 'replace-b');
    const app = createLocalKnowledgeApplication(workspace), left = a.ref(), detail = app.entities(left.analysisId);
    const member = { ...left, entityRevisionId: detail.revision.revisionId, mentionIds: detail.revision.mentions.filter(m => m.entityId === left.entityId).map(m => m.mentionId), rationale: '旧证据理由' };
    const library = createLocalKnowledgeLibrary(workspace), owner = library.save({ objectId: randomUUID(), requestId: randomUUID(), generation: 0, headRevisionId: null,
      identityConfirmed: true, reason: '旧组织', draft: { label: 'Alpha 对象', description: '旧范围', referentKind: 'object', members: [member] } });
    const api = await transport(), env = environment(root, api.endpoint), saved = await preview(root, workspace, a.ref(), b.ref(), env);
    const pending = JSON.parse((await runCli(saved.args, { cwd: root, env })).stdout), reason = '单独批准理由替换';
    const fields = ['--workspace', workspace, '--id', pending.history.reviewId, '--generation', String(pending.history.generation), '--reason', reason];
    const evidence = JSON.parse((await runCli(command('accept-preview', ...fields, '--json'), { cwd: root, env })).stdout);
    expect(evidence).toMatchObject({ previewVersion: 'omk.entity-link-accept-preview/v1', replacementRequired: true,
      changes: [{ before: member, after: { ...member, rationale: reason } }] });
    const acceptance = command('accept', ...fields, '--request-id', randomUUID(), '--confirm-identity', '--json');
    const refused = await runCliFailing(acceptance, 1, { cwd: root, env }); expect(refused.stderr).toContain('replacement confirmation');
    expect(library.detail(owner.objectId).history.generation).toBe(1);
    const confirmed = [...acceptance, '--confirm-replacement', evidence.confirmationDigest];
    expect(JSON.parse((await runCli(confirmed, { cwd: root, env })).stdout).projection.status).toBe('applied');
    expect(JSON.parse((await runCli(confirmed, { cwd: root, env })).stdout).projection.status).toBe('applied');
    expect(library.detail(owner.objectId).history.generation).toBe(2); expect(api.requests).toHaveLength(1);
  });
  it('preserves a refusal and usage, requires a new confirmed retry and durably suppresses a rejected pair', async () => {
    const root = temporary(), workspace = join(root, 'knowledge'), a = await window(workspace, 'a'), b = await window(workspace, 'b'); let refuse = true;
    const api = await transport(body => refuse ? { choices: [{ message: { content: '完整 content 原通道', refusal: '完整 refusal 原通道' }, finish_reason: 'stop' }], usage: { prompt_tokens: 13, completion_tokens: 5 } } : completion(body));
    const env = environment(root, api.endpoint), failed = await preview(root, workspace, a.ref(), b.ref(), env);
    const result = JSON.parse((await runCliFailing(failed.args, 1, { cwd: root, env })).stdout);
    expect(result.projection).toMatchObject({ status: 'execution_failed', invocationBudget: { consumed: 1 }, usage: { inputTokens: 13, outputTokens: 5, costUSD: null } });
    const recorded = result.history.events.find((event: { command: { commandKind: string } }) => event.command.commandKind === 'execution_recorded').command;
    expect(recorded.outcome.result).toMatchObject({ output: '完整 content 原通道', refusal: '完整 refusal 原通道', failure: { failureKind: 'refusal' } });
    const failedPath = join(workspace, 'entity-links', `${result.history.reviewId}.json`), failedBytes = readFileSync(failedPath);
    await runCliFailing(failed.args, 1, { cwd: root, env }); expect(api.requests).toHaveLength(1);
    await runCli(command('show', '--workspace', workspace, '--id', result.history.reviewId, '--json'), { cwd: root, env });
    await expect(preview(root, workspace, a.ref(), b.ref(), env)).rejects.toMatchObject({ code: 1 });
    refuse = false; const retry = await preview(root, workspace, a.ref(), b.ref(), env, ['--retry-of', result.history.reviewId]);
    expect(retry.plan.preview.reviewId).not.toBe(result.history.reviewId);
    const ready = JSON.parse((await runCli(retry.args, { cwd: root, env })).stdout); expect(api.requests).toHaveLength(2); expect(readFileSync(failedPath)).toEqual(failedBytes);
    const rejected = JSON.parse((await runCli(command('reject', '--workspace', workspace, '--id', ready.history.reviewId, '--request-id', randomUUID(), '--generation', String(ready.projection.generation), '--reason', '两侧同名但证据不足', '--json'), { cwd: root, env })).stdout);
    expect(rejected.projection.status).toBe('rejected');
    await expect(preview(root, workspace, b.ref(), a.ref(), env, ['--retry-of', ready.history.reviewId])).rejects.toMatchObject({ code: 1 });
    const candidates = JSON.parse((await runCli(command('candidates', '--workspace', workspace, '--analysis', a.ref().analysisId, '--entity', a.ref().entityId, '--json'), { cwd: root, env })).stdout);
    expect(candidates.rows).toEqual([]); expect(api.requests).toHaveLength(2);
  });
  it('rejects altered runtime/display/confirmation and an unproven Codex producer before persistence or process dispatch', async () => {
    const root = temporary(), workspace = join(root, "knowledge's $(printf substitution) `printf backtick`"), a = await window(workspace, 'a'), b = await window(workspace, 'b');
    const api = await transport(), env = environment(root, api.endpoint), saved = await preview(root, workspace, a.ref(), b.ref(), env);
    const drift = await runCliFailing(saved.args, 1, { cwd: root, env: environment(root, 'http://127.0.0.1:1') });
    const inspect = drift.stderr.split('\n').find(line => line.trimStart().startsWith('omk observe entity-links show'))!.trim();
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'omk'), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const shell = spawn('/bin/sh', ['-c', inspect], { cwd: root, env: { ...env, PATH: `${bin}:${env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let shellOutput = ''; shell.stdout.on('data', chunk => { shellOutput += chunk.toString(); });
    const [shellCode, shellSignal] = await once(shell, 'exit'); expect({ shellCode, shellSignal }).toEqual({ shellCode: 0, shellSignal: null });
    expect(JSON.parse(shellOutput)).toEqual(['observe', 'entity-links', 'show', '--id', saved.plan.preview.reviewId, '--workspace', workspace, '--json']);
    const clone = join(root, 'clone'); cpSync(workspace, clone, { recursive: true });
    const redirected = structuredClone(saved.plan); redirected.workspace = clone; const redirectPath = join(root, 'redirected.json'); writeFileSync(redirectPath, JSON.stringify(redirected));
    await runCliFailing(command('propose', '--input', redirectPath, '--confirm-input', saved.plan.confirmedDigest, '--json'), 2, { cwd: root, env });
    const rewrapped = createEntityLinkCliPlan(clone, saved.plan.preview); expect(rewrapped.confirmedDigest).not.toBe(saved.plan.confirmedDigest);
    writeFileSync(redirectPath, JSON.stringify(rewrapped));
    await runCliFailing(command('propose', '--input', redirectPath, '--confirm-input', saved.plan.confirmedDigest, '--json'), 2, { cwd: root, env });
    expect(existsSync(join(clone, 'entity-links'))).toBe(false);
    await runCliFailing(command('propose', '--input', saved.path, '--confirm-input', 'sha256:' + '0'.repeat(64)), 2, { cwd: root, env });
    await runCliFailing([...saved.args, '--workspace', join(root, 'other')], 2, { cwd: root, env });
    const forgedPreview = structuredClone(saved.plan.preview); forgedPreview.producerContext.proof.endpoint = 'https://unconfirmed.invalid/v1/chat/completions';
    const forged = createEntityLinkCliPlan(workspace, forgedPreview);
    const forgedPath = join(root, 'forged.json'); writeFileSync(forgedPath, JSON.stringify(forged));
    await runCliFailing(command('preview', '--input', forgedPath), 2, { cwd: root, env });
    const link = join(root, 'symlink.json'); symlinkSync(saved.path, link); await runCliFailing(command('preview', '--input', link), 2, { cwd: root, env });
    const marker = join(root, 'codex-started'); writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`, { mode: 0o755 });
    const args = command('preview', '--workspace', workspace, '--analysis', a.ref().analysisId, '--entity', a.ref().entityId,
      '--right-analysis', b.ref().analysisId, '--right-entity', b.ref().entityId, '--executor', 'codex', '--model', 'fixture', '--json');
    expect((await runCliFailing(args, 1, { cwd: root, env: { ...env, PATH: `${bin}:${env.PATH}` } })).stderr).toContain('not yet proven');
    expect(existsSync(marker)).toBe(false); expect(existsSync(join(workspace, 'entity-links'))).toBe(false); expect(api.requests).toHaveLength(0);
  });
  it('inspects an interrupted prepare before explicit continuation and cancels another unstarted reservation without dispatch', async () => {
    const root = temporary(), workspace = join(root, 'knowledge'), a = await window(workspace, 'a'), b = await window(workspace, 'b');
    const api = await transport(), env = environment(root, api.endpoint), saved = await preview(root, workspace, a.ref(), b.ref(), env);
    const app = createLocalEntityLinks(workspace, createOpenAiArchiveProducer(env));
    const prepare = (plan: typeof saved.plan) => { const value = parseEntityLinkPreview(plan.preview); return app.prepare({ reviewId: value.reviewId, requestId: value.requestId, plan: value.plan, confirmDigest: value.plan.confirmedDigest }); };
    prepare(saved.plan);
    const inspected = JSON.parse((await runCliFailing(saved.args, 1, { cwd: root, env })).stdout);
    expect(inspected.projection.status).toBe('prepared'); expect(api.requests).toHaveLength(0);
    const ready = JSON.parse((await runCli([...saved.args, '--start-prepared'], { cwd: root, env })).stdout);
    expect(ready.projection.status).toBe('awaiting_review'); expect(api.requests).toHaveLength(1);
    const unstarted = await preview(root, workspace, a.ref(1), b.ref(1), env), prepared = prepare(unstarted.plan);
    const cancel = command('resume', '--workspace', workspace, '--id', prepared.reviewId, '--cancel-before-start', '--request-id', randomUUID(), '--generation', String(prepared.generation), '--reason', '核对后取消未调用计划', '--json');
    const cancelled = JSON.parse((await runCli(cancel, { cwd: root, env })).stdout);
    expect(cancelled.projection).toMatchObject({ status: 'cancelled_before_start', invocationBudget: { consumed: 0 } });
    expect(JSON.parse((await runCli(cancel, { cwd: root, env })).stdout).history).toEqual(cancelled.history);
    await preview(root, workspace, a.ref(1), b.ref(1), env); expect(api.requests).toHaveLength(1);
  });
  it('terminates a live owner without configuration or sources and fences the late result through the real CLI', async () => {
    const root = temporary(), workspace = join(root, 'knowledge'), a = await window(workspace, 'a'), b = await window(workspace, 'b');
    let release!: () => void, arrived!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }), received = new Promise<void>(resolve => { arrived = resolve; });
    const api = await transport(async body => { arrived(); await pending; return completion(body); });
    const env = environment(root, api.endpoint), saved = await preview(root, workspace, a.ref(), b.ref(), env);
    const app = createLocalEntityLinks(workspace, createOpenAiArchiveProducer(env));
    const child = spawn(process.execPath, [CLI_ENTRY, ...saved.args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exited = once(child, 'exit');
    try {
      await Promise.race([received, exited.then(() => { throw new Error(`CLI exited before dispatch: ${stderr}`); })]);
      const show = command('show', '--workspace', workspace, '--id', saved.plan.preview.reviewId, '--json');
      const running = JSON.parse((await runCli(show, { cwd: root, env })).stdout);
      expect(running.projection).toMatchObject({ status: 'running', canTerminateExecution: true });
      expect(running.projection.execution.owner.pid).toBe(child.pid);
      const path = join(workspace, 'entity-links', `${saved.plan.preview.reviewId}.json`), original = readFileSync(path);
      const terminate = command('terminate', '--workspace', workspace, '--id', running.history.reviewId, '--request-id', randomUUID(),
        '--generation', String(running.projection.generation), '--execution-id', running.projection.execution.executionId,
        '--owner-id', running.projection.execution.owner.ownerId, '--reason', '人工核对该执行后终止，不推断远端取消', '--json');
      for (const [name, value] of [['execution-id', randomUUID()], ['owner-id', randomUUID()], ['generation', '1']]) {
        const args = [...terminate]; args[args.indexOf(`--${name}`) + 1] = value;
        await runCliFailing(args, 1, { cwd: root, env }); expect(readFileSync(path)).toEqual(original);
      }
      // Administrative recovery must depend only on the saved start, even when all sources and settings are unavailable.
      rmSync(join(workspace, 'sources'), { recursive: true }); rmSync(join(workspace, 'entities'), { recursive: true });
      mkdirSync(env.OMK_HOME!, { recursive: true }); const settings = join(env.OMK_HOME!, 'settings.json'); writeFileSync(settings, '{broken-settings');
      const unavailable = { ...env, OPENAI_API_KEY: '', OPENAI_BASE_URL: 'not-a-provider-url' };
      const terminated = JSON.parse((await runCli(terminate, { cwd: root, env: unavailable })).stdout);
      expect(terminated.projection).toMatchObject({ projectionVersion: 'omk.entity-link-invocation-projection/v3', status: 'execution_terminated',
        invocationBudget: { reserved: 0, consumed: 1 }, canTerminateExecution: false, canStart: false, canResumeOrganization: false, admission: null, decision: null,
        termination: { commandKind: 'execution_terminated', terminationVersion: 'omk.entity-link-termination/v1', actor: { actorKind: 'human' } },
        usage: { inputTokens: null, outputTokens: null, costUSD: null } });
      expect(terminated.history.events.slice(0, 2)).toEqual(running.history.events);
      expect(JSON.parse((await runCli(terminate, { cwd: root, env: unavailable })).stdout).history).toEqual(terminated.history);
      expect(readFileSync(settings, 'utf8')).toBe('{broken-settings');
      const changedReason = [...terminate]; changedReason[changedReason.indexOf('--reason') + 1] = '不能重写已有终止理由';
      await runCliFailing(changedReason, 1, { cwd: root, env: unavailable });
      expect(app.quality()).toMatchObject({ projectionVersion: 'omk.entity-link-quality/v3', groups: [{
        humanTerminations: { total: 1, outcomeUnrecorded: 1, lateOutcomeRecorded: 0 },
        admission: { recorded: 0, admitted: 0, rejected: 0, terminatedDispatched: 1 }, humanDecisions: { decided: 0 } }] });
      const zh = formatEntityLinkInvocation(terminated.history, terminated.projection, workspace, 'zh');
      const en = formatEntityLinkInvocation(terminated.history, terminated.projection, workspace, 'en');
      expect(zh).toContain('人工终止记录'); expect(zh).toContain('不证明远端请求已取消'); expect(zh).toContain(running.projection.execution.executionId);
      expect(en).toContain('Human termination'); expect(en).toContain('no invocation refund');
      release(); const [code, signal] = await exited;
      expect({ code, signal }).toEqual({ code: 1, signal: null });
      const late = JSON.parse(stdout);
      expect(late.projection).toMatchObject({ status: 'execution_terminated', admission: null, decision: null, canStart: false, canResumeOrganization: false,
        invocationBudget: { consumed: 1 }, usage: { inputTokens: 10, outputTokens: 5, costUSD: null } });
      expect(late.history.events).toHaveLength(4); expect(late.history.events.slice(0, 3)).toEqual(terminated.history.events);
      const raw = late.history.events[3]; expect(raw.command.commandKind).toBe('execution_recorded');
      expect(raw.command.outcome.result.output).toContain('insufficient_evidence'); expect(raw.facts.archiveDisposition).toBe('terminated');
      expect(JSON.parse((await runCli(terminate, { cwd: root, env: unavailable })).stdout).history).toEqual(late.history);
      rmSync(settings); // Normal reads may use saved preferences; they still must not dispatch or revisit removed source data.
      for (const args of [saved.args, [...saved.args, '--start-prepared'], command('resume', '--workspace', workspace, '--id', running.history.reviewId, '--json')]) {
        const result = JSON.parse((await runCliFailing(args, 1, { cwd: root, env })).stdout);
        expect(result.projection.status).toBe('execution_terminated'); expect(result.history.events).toHaveLength(4);
      }
      const quality = JSON.parse((await runCli(command('quality', '--workspace', workspace, '--json'), { cwd: root, env: unavailable })).stdout);
      expect(quality.groups[0]).toMatchObject({ humanTerminations: { total: 1, outcomeUnrecorded: 0, lateOutcomeRecorded: 1 },
        admission: { recorded: 0, terminatedDispatched: 1, unrecordedDispatched: 0 }, humanDecisions: { decided: 0 } });
      const report = await runCli(command('quality', '--workspace', workspace, '--lang', 'zh'), { cwd: root, env: unavailable });
      expect(report.stdout).toContain('人工终止: 1'); expect(report.stdout).toContain('迟到结果已归档=1'); expect(report.stdout).toContain('终止且不参与接纳=1');
      await runCliFailing(command('reject', '--workspace', workspace, '--id', running.history.reviewId, '--request-id', randomUUID(),
        '--generation', String(late.history.generation), '--reason', '终止不能变成人工拒绝', '--json'), 1, { cwd: root, env });
      expect(existsSync(join(workspace, 'library'))).toBe(false); expect(api.requests).toHaveLength(1);
    } finally {
      release(); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  });
  it.each(['SIGTERM', 'SIGKILL'] as const)('handles real process %s without retrying the started slot and resumes with zero model calls', async termination => {
    const root = temporary(), workspace = join(root, 'knowledge'), a = await window(workspace, 'a'), b = await window(workspace, 'b');
    let release!: () => void, arrived!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }), received = new Promise<void>(resolve => { arrived = resolve; });
    const api = await transport(async body => { arrived(); await pending; return completion(body); });
    const env = environment(root, api.endpoint), saved = await preview(root, workspace, a.ref(), b.ref(), env);
    const child = spawn(process.execPath, [CLI_ENTRY, ...saved.args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exited = once(child, 'exit');
    try {
      await Promise.race([received, exited.then(() => { throw new Error(`CLI exited before dispatch: ${stderr}`); })]);
      child.kill(termination); const [code, signal] = await exited;
      const show = command('show', '--workspace', workspace, '--id', saved.plan.preview.reviewId, '--json');
      if (termination === 'SIGTERM') {
        expect({ code, signal }).toEqual({ code: 1, signal: null });
        const result = JSON.parse(stdout); expect(result.projection).toMatchObject({ status: 'execution_failed', invocationBudget: { consumed: 1 }, usage: { inputTokens: null, outputTokens: null } });
        const recorded = result.history.events.find((event: { command: { commandKind: string } }) => event.command.commandKind === 'execution_recorded').command;
        expect(recorded.outcome.result.failure.failureKind).toBe('cancelled');
      } else {
        expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' });
        expect(JSON.parse((await runCli(show, { cwd: root, env })).stdout).projection.status).toBe('running');
        const resume = command('resume', '--workspace', workspace, '--id', saved.plan.preview.reviewId, '--json');
        expect(JSON.parse((await runCliFailing(resume, 1, { cwd: root, env })).stdout).projection.status).toBe('running');
        const unknown = JSON.parse((await runCliFailing([...resume, '--recover-unknown', '--request-id', randomUUID()], 1, { cwd: root, env })).stdout);
        expect(unknown.projection).toMatchObject({ status: 'execution_unknown', invocationBudget: { consumed: 1 } });
      }
      await runCliFailing(saved.args, 1, { cwd: root, env });
      await runCliFailing(command('resume', '--workspace', workspace, '--id', saved.plan.preview.reviewId, '--json'), 1, { cwd: root, env });
      await runCli(command('show', '--workspace', workspace, '--id', saved.plan.preview.reviewId, '--json'), { cwd: root, env }); expect(api.requests).toHaveLength(1);
    } finally { release(); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  });
});
