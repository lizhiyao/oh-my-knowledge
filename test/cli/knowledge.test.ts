import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync, cpSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserSettingsStore } from '../../src/evidence/storage/user-settings.js';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import ObserveEntityLinks from '../../src/cli/commands/observe/entity-links.js';
import { createEntityLinkCliPlan } from '../../src/cli/lib/entity-link-output.js';
import { runCommand } from '../helpers/run-command.js';
import { CLI_ENTRY, runCli, runCliFailing } from '../helpers/cli-process.js';
import { createLocalKnowledgeApplication, createLocalEntityLinks, parseEntityLinkPreview } from '../../src/observability/knowledge-extraction/local.js';
import { createOpenAiArchiveProducer } from '../../src/executors/openai/archive.js';
import { modelWindow } from '../knowledge/fixtures.js';
import { boundedExtractionPolicy } from '../../src/observability/knowledge-extraction/extraction/generation-policy.js';
import { formatKnowledgeResult } from '../../src/cli/lib/knowledge-output.js';

const roots: string[] = [];
const linkServers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const server of linkServers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('observe knowledge command wiring', () => {
  it('formats the selected or pending final attempt without promoting a previous failure to current status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-output-')); roots.push(root);
    const source = join(root, 'source.jsonl'), workspace = join(root, 'workspace');
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
    const app = createLocalKnowledgeApplication(workspace), snapshot = app.capture({ path: source });
    const original = await app.generate(snapshot.snapshotId, { executor: 'fixture', model: 'fixture', generate: async () => ({ output: JSON.stringify(modelWindow()).replaceAll('record-1', snapshot.excerpts[0].evidenceRef), durationMs: 1 }) });
    const policy = boundedExtractionPolicy({ maxInvocations: 3, maxReasks: 2, profileId: 'loopback-test/v1', maxTotalTokens: 3264, maxOutputTokens: 64 });
    const budget = { profileId: 'loopback-test/v1', authority: 'loopback-test-only' as const, evidenceDigest: `sha256:${'0'.repeat(64)}`, inputUpperBound: 1024, outputUpperBound: 64, tokensReserved: 1088 };
    const first = { ...original.attempts[0], budget, failure: { failureKind: 'parse_error', diagnostic: 'earlier invalid output' } };
    const last = { ...original.attempts[0], attemptId: randomUUID(), budget };
    const run = { ...original, policy, attempts: [first, last], selectedAttemptId: last.attemptId };
    const command = { operation: 'resume' as const, id: run.runId };
    const completed = formatKnowledgeResult(run, 'zh', command, workspace);
    expect(completed).toContain('completed'); expect(completed).toContain('结果已归档'); expect(completed).not.toContain('失败类别');
    expect(completed).toContain('累计 token 预约 2176/3264'); expect(completed).toContain('已预约 2 次尝试');
    const pending = { ...run, status: 'generating' as const, selectedAttemptId: undefined, entityAnalysis: undefined, intents: [], committed: [], rawOutput: undefined,
      attempts: [first, { ...last, outcome: undefined }] };
    const waiting = formatKnowledgeResult(pending, 'zh', command, workspace);
    expect(waiting).toContain('归档待确认'); expect(waiting).not.toContain('结果已归档'); expect(waiting).not.toContain('失败类别');
    expect(waiting).not.toContain('本次调用已终止'); expect(waiting).toContain('尚无可恢复的模型结果');
    expect(waiting).toContain(`--workspace ${workspace}`);
  });
  it('exports the exact wire schema and identity before reading settings or creating a workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-schema-cli-')); roots.push(root);
    vi.stubEnv('OMK_HOME', root);
    const settings = join(root, 'settings.json'); writeFileSync(settings, '{invalid');
    const workspace = join(root, 'unused-workspace');
    const base = ['schema', '--workspace', workspace];
    const raw = (await runCommand(ObserveKnowledge, base, { cwd: root })).stdout;
    const bundle = JSON.parse((await runCommand(ObserveKnowledge, [...base, '--json'], { cwd: root })).stdout);
    expect(bundle).toMatchObject({ responseKind: 'knowledge-extraction-wire-contract',
      identity: { domainSchemaVersion: 4, profile: 'omk-strict-structural/v1' } });
    expect(bundle.schema).toEqual(JSON.parse(raw));
    expect(bundle.identity.wireSchemaDigest).toBe(`sha256:${createHash('sha256').update(raw).digest('hex')}`);
    expect(bundle.hostOnly.nullableOptionals.map((value: { property: string }) => value.property).sort()).toEqual(['object', 'occurrence']);
    expect(readFileSync(settings, 'utf8')).toBe('{invalid');
    expect(existsSync(workspace)).toBe(false);
  });
  it('captures one selected source, inspects it and deletes its snapshot through shared operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-cli-')); roots.push(root);
    const path = join(root, 'trace.jsonl ');
    const workspace = join(root, 'knowledge');
    writeFileSync(path, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请记住项目规则' }] } }));
    const output = await runCommand(ObserveKnowledge, ['capture', '--workspace', workspace, '--source', path, '--json'], { cwd: root });
    const captured = JSON.parse(output.stdout);
    expect(captured.records).toHaveLength(1);
    const read = await runCommand(ObserveKnowledge, ['source', '--workspace', workspace, '--snapshot', captured.snapshotId, '--json'], { cwd: root });
    expect(JSON.parse(read.stdout).status).toBe('available');
    await runCommand(ObserveKnowledge, ['delete-source', '--workspace', workspace, '--snapshot', captured.snapshotId], { cwd: root });
    const deleted = await runCommand(ObserveKnowledge, ['source', '--workspace', workspace, '--snapshot', captured.snapshotId, '--json'], { cwd: root });
    expect(JSON.parse(deleted.stdout)).toMatchObject({ status: 'unavailable', reason: 'deleted' });
  });
  it('reads the same saved workspace as Studio when the flag is omitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-settings-cli-')); roots.push(root);
    vi.stubEnv('OMK_HOME', root);
    const workspace = join(root, 'chosen');
    new UserSettingsStore(root).save({ schemaVersion: 2, knowledge: { workspace } }, 'missing');
    const source = join(root, 'source.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fixture' }] } }));
    const captured = JSON.parse((await runCommand(ObserveKnowledge, ['capture', '--source', source, '--json'], { cwd: root })).stdout);
    const result = await runCommand(ObserveKnowledge, ['source', '--workspace', workspace, '--snapshot', captured.snapshotId, '--json'], { cwd: root });
    expect(JSON.parse(result.stdout).status).toBe('available');
  });
  it('rejects missing operation-specific parameters before accessing storage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-cli-')); roots.push(root);
    vi.stubEnv('OMK_HOME', root); writeFileSync(join(root, 'settings.json'), '{invalid');
    await expect(runCommand(ObserveKnowledge, ['retain', '--workspace', root], { cwd: root })).rejects.toMatchObject({ code: 2 });
    for (const args of [['list', '--generation-policy', '{}'], ['schema', '--generation-policy', '{}'],
      ['generate', '--snapshot', 'fixture', '--generation-policy', '{invalid'], ['generate', '--snapshot', 'fixture', '--generation-policy', '{}']]) {
      await expect(runCommand(ObserveKnowledge, args, { cwd: root })).rejects.toMatchObject({ code: 2 });
    }
  });
  it('passes explicit bounded policy and its output cap through the command and shared operations, reusing a run without another dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-bounded-knowledge-cli-')); roots.push(root);
    vi.stubEnv('OMK_HOME', root); vi.stubEnv('OPENAI_API_KEY', 'isolated-loopback-fixture-key'); vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:9321');
    const workspace = join(root, 'knowledge'), source = join(root, 'source.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
    const captured = JSON.parse((await runCommand(ObserveKnowledge, ['capture', '--workspace', workspace, '--source', source, '--json'], { cwd: root })).stdout);
    const policy = boundedExtractionPolicy({ maxInvocations: 1, maxReasks: 0, profileId: 'loopback-test/v1', maxTotalTokens: 1088, maxOutputTokens: 64 });
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(_url).toBe('http://127.0.0.1:9321/v1/chat/completions'); expect(init?.redirect).toBe('error');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'authored-loopback-test', max_completion_tokens: 64, n: 1, stream: false });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ responseKind: 'knowledge-extraction', schemaVersion: 4,
        entities: [], mentions: [], proposals: [] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }));
    }); vi.stubGlobal('fetch', fetch);
    const args = ['generate', '--workspace', workspace, '--snapshot', captured.snapshotId, '--executor', 'openai-api', '--model', 'authored-loopback-test',
      '--run-id', randomUUID(), '--generation-policy', JSON.stringify(policy), '--json'];
    const run = JSON.parse((await runCommand(ObserveKnowledge, args, { cwd: root })).stdout);
    expect(run).toMatchObject({ status: 'completed', policy, attempts: [{ request: { maxOutputTokens: 64 },
      budget: { tokensReserved: 1088 }, accounting: { chargedTokens: 1088, status: 'reported' } }] });
    expect(JSON.parse((await runCommand(ObserveKnowledge, args, { cwd: root })).stdout)).toEqual(run);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps text next steps in the selected workspace and leaves JSON as a single machine result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-cli-loop-')); roots.push(root);
    const workspace = join(root, 'chosen workspace'); const source = join(root, 'source.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
    const text = await runCommand(ObserveKnowledge, ['capture', '--workspace', workspace, '--source', source, '--lang', 'zh'], { cwd: root });
    expect(text.stdout).toContain('下一步'); expect(text.stdout).toContain('observe knowledge source');
    expect(text.stdout).toContain(`--workspace '${workspace}'`); expect(text.stdout).toContain('不会调用模型');
    const empty = await runCommand(ObserveKnowledge, ['list', '--workspace', join(root, 'empty'), '--lang', 'en'], { cwd: root });
    expect(empty.stdout).toContain('No knowledge'); expect(empty.stdout).toContain('observe knowledge capture');
    expect(existsSync(join(root, 'empty'))).toBe(false);
    const json = await runCommand(ObserveKnowledge, ['list', '--workspace', join(root, 'empty'), '--json'], { cwd: root });
    expect(JSON.parse(json.stdout)).toEqual([]); expect(json.stdout).not.toContain('Next');
  });
  it('inspects and corrects an independent entity result, then explicitly binds a new knowledge revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-entities-cli-')); roots.push(root);
    const workspace = join(root, 'knowledge'); const source = join(root, 'trace.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
    const app = createLocalKnowledgeApplication(workspace); const snapshot = app.capture({ path: source });
    const run = await app.generate(snapshot.snapshotId, { executor: 'fixture', model: 'fixture',
      generate: async (_system, input) => ({ output: JSON.stringify(modelWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 1 }) });
    const base = ['--workspace', workspace, '--lang', 'zh'];
    const found = JSON.parse((await runCommand(ObserveKnowledge, ['entities', ...base, '--query', 'Alpha', '--page-size', '1', '--json'], { cwd: root })).stdout);
    expect(found).toMatchObject({ total: 1, pageSize: 1, rows: [{ label: 'Alpha', knowledgeCount: 1 }] });
    expect((await runCommand(ObserveKnowledge, ['entities', ...base, '--query', 'Alpha'], { cwd: root })).stdout).toContain('1 个匹配对象');
    await expect(runCommand(ObserveKnowledge, ['entities', ...base, '--entity-revision', 'orphan'], { cwd: root })).rejects.toMatchObject({ code: 2 });
    const inspect = await runCommand(ObserveKnowledge, ['entities', ...base, '--analysis', run.runId], { cwd: root });
    expect(inspect.stdout).toContain('实体分析'); expect(inspect.stdout).toContain('Alpha');
    const quality = await runCommand(ObserveKnowledge, ['quality', ...base, '--json'], { cwd: root });
    expect(JSON.parse(quality.stdout)).toEqual(app.quality());
    const statistics = await runCommand(ObserveKnowledge, ['quality', ...base], { cwd: root });
    expect(statistics.stdout).toContain('提炼接纳统计'); expect(statistics.stdout).toContain('位置匹配不证明语义准确');
    expect(statistics.stdout).toContain('当前 v5 运行'); expect(statistics.stdout).toContain('knowledge-generation-single/v1');
    expect(statistics.stdout).toContain('authored-model-port/v1');
    expect(statistics.stdout).toContain(`--workspace ${workspace}`);
    const before = app.entities(run.runId);
    const edit = { entities: structuredClone(before.revision.entities), mentions: before.revision.mentions };
    edit.entities[0].label = '项目 Alpha';
    const path = join(root, 'correction.json'); writeFileSync(path, JSON.stringify(edit));
    const args = ['correct-entities', ...base, '--analysis', run.runId, '--entity-revision', before.revision.revisionId,
      '--generation', '1', '--input', path, '--reason', '核对项目名称', '--json'];
    const corrected = JSON.parse((await runCommand(ObserveKnowledge, args, { cwd: root })).stdout);
    expect(corrected.history.generation).toBe(2);
    const old = app.detail(run.committed[0].knowledgeId);
    expect(old.revision.entities[0].label).toBe('Alpha');
    await expect(runCommand(ObserveKnowledge, args, { cwd: root })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('observe knowledge entities') });
    const draft = { title: old.revision.title, entities: corrected.revision.entities.map(({ entityId, label, description }: { entityId: string; label: string; description: string }) => ({ entityId, label, description })),
      content: old.revision.content, evidence: old.revision.evidence };
    const draftPath = join(root, 'knowledge.json'); writeFileSync(draftPath, JSON.stringify(draft));
    const applied = JSON.parse((await runCommand(ObserveKnowledge, ['apply-entities', ...base, '--id', old.revision.knowledgeId,
      '--revision', old.revision.revisionId, '--generation', '1', '--analysis', run.runId,
      '--entity-revision', corrected.revision.revisionId, '--input', draftPath, '--identity-uncertainties', '[]', '--reason', '明确知识主体', '--json'], { cwd: root })).stdout);
    expect(applied.revision.entities[0].label).toBe('项目 Alpha');
    expect(applied.grounding.entityAnalysisRef.revisionId).toBe(corrected.revision.revisionId);
    expect(applied.history.revisions[0]).toEqual(old.revision);
    await runCommand(ObserveKnowledge, ['retain', ...base, '--id', old.revision.knowledgeId, '--revision', applied.revision.revisionId,
      '--generation', '2', '--reason', '核对条件后保留'], { cwd: root });
    const kept = await runCommand(ObserveKnowledge, ['show', ...base, '--id', old.revision.knowledgeId], { cwd: root });
    expect(kept.stdout).toContain('维护决定：已保留'); expect(kept.stdout).toContain('效果尚未验证');
    expect(kept.stdout).toContain('--generation 3');
    await expect(runCommand(ObserveKnowledge, ['correct-entities', ...base, '--analysis', run.runId], { cwd: root })).rejects.toMatchObject({ code: 2 });
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
  async function window(workspace: string, name: string) {
    const app = createLocalKnowledgeApplication(workspace);
    const source = app.capture({ path: join(workspace, `${name}.jsonl`), origin: { threadId: name, title: name }, records: [{ recordIndex: 1,
      raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }) }] });
    const run = await app.generate(source.snapshotId, { executor: 'recorded-fixture', model: 'no-model-call', generate: async (_system, input) => ({
      output: JSON.stringify(modelWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 0 }) });
    const analysis = app.entities(run.runId);
    return { run, analysis, ref: (index = 0) => ({ analysisId: run.runId, entityId: analysis.revision.entities[index].entityId }) };
  }
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
    const entityPaths = [a, b].map(value => join(workspace, 'entities', `${value.run.runId}.json`)), originalEntities = entityPaths.map(path => readFileSync(path));
    const originalKnowledge = [a, b].map(value => createLocalKnowledgeApplication(workspace).detail(value.run.committed[0].knowledgeId));
    expect(api.requests).toHaveLength(0); expect(existsSync(join(workspace, 'entity-links'))).toBe(false);
    expect(JSON.stringify(saved.plan)).not.toContain(env.OPENAI_API_KEY);
    const inspected = await runCli(command('preview', '--input', saved.path, '--lang', 'zh'), { cwd: root, env: environment(root, 'http://127.0.0.1:1') });
    expect(inspected.stdout).toContain(saved.plan.confirmedDigest); expect(inspected.stdout).toContain(saved.plan.preview.plan.request.prompt);
    expect(inspected.stdout).toContain(api.endpoint); expect(api.requests).toHaveLength(0);
    const pending = JSON.parse((await runCli(saved.args, { cwd: root, env })).stdout);
    expect(pending.projection).toMatchObject({ status: 'awaiting_review', invocationBudget: { reserved: 0, consumed: 1 }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, costUSD: null } });
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
    expect([a, b].map(value => createLocalKnowledgeApplication(workspace).detail(value.run.committed[0].knowledgeId))).toEqual(originalKnowledge);
    expect(a.ref().entityId).not.toBe(b.ref().entityId); expect(api.requests).toHaveLength(1);
    const listed = JSON.parse((await runCli(command('list', '--workspace', workspace, '--json'), { cwd: root, env })).stdout);
    expect(listed.rows).toHaveLength(1); expect(listed.rows[0].status).toBe('applied');
    await runCli(command('resume', '--workspace', workspace, '--id', pending.history.reviewId, '--json'), { cwd: root, env }); expect(api.requests).toHaveLength(1);
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
