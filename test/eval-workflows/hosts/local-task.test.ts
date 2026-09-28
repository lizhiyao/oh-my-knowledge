import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { prepareLocalTask } from '../../../src/eval-workflows/hosts/local-task/application.js';
import { LocalTaskDefinitionSchema, LocalTaskPathSchema } from '../../../src/eval-workflows/inputs/contracts/local-task.js';
import { captureTaskFiles, collectTaskArtifacts, taskTreeDigest } from '../../../src/eval-workflows/hosts/local-task/files.js';
import { projectCoreStudioRunDetail } from '../../../src/studio/application/measure/core-run-projection.js';

const cleanupFailure = vi.hoisted(() => ({ prefix: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (cleanupFailure.prefix && String(args[0]).includes(cleanupFailure.prefix)) throw new Error('injected cleanup failure');
    return actual.rm(...args);
  } };
});

let root: string;
let definitionPath: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omk-task-test-'));
  await cp(resolve('examples/local-task'), join(root, 'task'), { recursive: true });
  await mkdir(join(root, 'temporary'));
  definitionPath = join(root, 'task/task.yaml');
});
afterEach(async () => { cleanupFailure.prefix = ''; await rm(root, { recursive: true, force: true }); });

async function load() { return LocalTaskDefinitionSchema.parse(yaml.load(await readFile(definitionPath, 'utf8'))); }
async function application() { return prepareLocalTask({ definitionPath, temporaryRoot: join(root, 'temporary'), outputDirectory: join(root, 'reports') }); }

describe('local task outcomes', () => {
  it('isolates A/B trials, persists original evidence and independently rejects a claimed fix', async () => {
    const task = await load();
    task.trials = 2;
    task.samples.samples[0].annotations = { provenance: 'human' };
    await writeFile(definitionPath, JSON.stringify(task));
    const app = await application();
    expect(app.preview.estimatedCostUSD).toBeNull();
    expect(app.preview.samples[0].annotations).toEqual({ provenance: 'human' });
    expect(await readdir(join(root, 'temporary'))).toEqual([]);
    const { result, artifacts } = await app.run();
    expect(result.status).toBe('completed');
    const records = artifacts.evaluation.records;
    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(record.evaluationStatus).toBe('completed');
      if (record.evaluationStatus === 'completed') {
        expect(record.observations[0]).toMatchObject({ observationStatus: 'observed', value: record.targetId === 'treatment' });
      }
    }
    expect(await readFile(join(root, 'task/snapshot/math.mjs'), 'utf8')).toContain('return value;');
    expect(await readdir(join(root, 'temporary'))).toEqual([]);
    expect((await readdir(join(root, 'reports'))).length).toBeGreaterThan(0);
    const view = projectCoreStudioRunDetail(artifacts);
    expect(view.stages.execution.records[0].taskArtifacts?.files[0].path).toBe('math.mjs');
    expect(view.stages.evaluation.records[0].observations[0].taskAcceptance?.checks).toHaveLength(3);
    expect(JSON.stringify(view)).not.toContain('contentBase64');
  });

  it('runs a Node Codex launcher with private runtime state and independently verifies its files', async () => {
    const task = await load();
    const launcher = join(root, 'codex.mjs');
    const authenticationFile = join(root, 'test-auth.json');
    await writeFile(authenticationFile, '{"fixture":"non-secret-test"}');
    await writeFile(launcher, `#!/usr/bin/env node
import {readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
assert.ok(process.env.HOME.startsWith(${JSON.stringify(join(root, 'temporary'))}));
assert.equal(process.env.TMPDIR, process.env.HOME);
assert.equal(process.env.LANG, 'C');
if (process.argv.includes('--version')) { console.log('codex-cli fixture-1'); process.exit(0); }
assert.equal(process.env.CODEX_HOME, join(process.env.HOME, 'codex'));
assert.deepEqual(await readdir(process.env.CODEX_HOME), ['auth.json']);
assert.equal((await stat(join(process.env.CODEX_HOME, 'auth.json'))).mode & 0o777, 0o600);
assert.equal(await readFile(join(process.env.CODEX_HOME, 'auth.json'), 'utf8'), '{"fixture":"non-secret-test"}');
assert.deepEqual(await readdir(process.cwd()), ['math.mjs']);
assert.ok(process.argv.includes('--ignore-rules'));
assert.ok(process.argv.includes('--ignore-user-config'));
assert.ok(process.argv.includes('--strict-config'));
assert.equal(process.argv[process.argv.indexOf('--model') + 1], 'fixture-model');
assert.ok(process.argv.includes('model_reasoning_effort="low"'));
await writeFile('math.mjs', 'export function absolute(value) { return Math.abs(value); }');
for (const event of [
  {type:'thread.started',thread_id:'fixture-thread'}, {type:'turn.started'},
  {type:'item.completed',item:{id:'answer',type:'agent_message',text:'fixed'}},
  {type:'turn.completed',usage:{input_tokens:5,output_tokens:2}}
]) console.log(JSON.stringify(event));
`);
    await chmod(launcher, 0o700);
    task.execution = { runtimeKind: 'codex', executable: launcher, model: 'fixture-model', effort: 'low', timeoutMs: 5000, identityFiles: [] };
    await writeFile(definitionPath, JSON.stringify(task));
    const verifier = join(root, 'task/acceptance/verify.mjs');
    await writeFile(verifier, `import assert from 'node:assert/strict';
assert.ok(process.env.HOME.startsWith(${JSON.stringify(join(root, 'temporary', 'acceptance-'))}));
assert.equal(process.env.TMPDIR, process.env.HOME);
${await readFile(verifier, 'utf8')}`);
    const app = await prepareLocalTask({ definitionPath, authenticationFile,
      temporaryRoot: join(root, 'temporary'), outputDirectory: join(root, 'reports') });
    const { artifacts } = await app.run();
    expect(artifacts.execution.records.every((record) => record.executionStatus === 'completed')).toBe(true);
    for (const record of artifacts.evaluation.records) {
      expect(record.evaluationStatus).toBe('completed');
      if (record.evaluationStatus === 'completed') expect(record.observations[0]).toMatchObject({ observationStatus: 'observed', value: true });
    }
    expect(await readdir(join(root, 'temporary'))).toEqual([]);
    expect(await readFile(authenticationFile, 'utf8')).toBe('{"fixture":"non-secret-test"}');
  });

  it('rejects a repair introducing a regression and rescores without executing again', async () => {
    const task = await load();
    task.variants.treatment = 'regression.md';
    await writeFile(definitionPath, JSON.stringify(task));
    const app = await application();
    const first = await app.run();
    for (const record of first.artifacts.evaluation.records) {
      if (record.evaluationStatus === 'completed') expect(record.observations[0]).toMatchObject({ value: false });
    }
    await writeFile(join(root, 'task/fixture.mjs'), 'throw new Error("must not execute again");');
    await writeFile(join(root, 'task/acceptance/verify.mjs'), 'console.log(JSON.stringify({schemaVersion:"omk.local-task-acceptance/v1",passed:true,checks:[{checkId:"changed-rule",passed:true,detail:"post hoc"}]}));');
    const second = await app.rescore(first.result, task.acceptance, join(root, 'task'));
    expect(second.result.runId).not.toBe(first.result.runId);
    expect(second.result.artifacts?.execution?.records).toEqual(first.artifacts.execution.records);
    expect(second.reference.digest).not.toBe(first.reference.digest);
    for (const record of second.result.artifacts?.evaluation?.records ?? []) {
      if (record.evaluationStatus === 'completed') expect(record.observations[0]).toMatchObject({ value: true });
    }
    expect(first.artifacts.evaluation.records).not.toEqual(second.result.artifacts?.evaluation?.records);
  });

  it.each(['../secret', '/absolute', 'nested/../file', '.env', 'nested/auth.json', 'C:\\file'])('rejects unsafe file path %s', (path) => {
    expect(LocalTaskPathSchema.safeParse(path).success).toBe(false);
  });

  it('has path-independent snapshot identity and distinguishes missing, links and size limits', async () => {
    const source = join(root, 'task/snapshot');
    const files = await captureTaskFiles(source, ['math.mjs'], 65536);
    await cp(source, join(root, 'elsewhere'), { recursive: true });
    expect(taskTreeDigest(await captureTaskFiles(join(root, 'elsewhere'), ['math.mjs'], 65536))).toBe(taskTreeDigest(files));
    await symlink(join(source, 'math.mjs'), join(source, 'linked.mjs'));
    const captured = await collectTaskArtifacts({ root: source, paths: ['missing.mjs', 'linked.mjs', 'math.mjs'], maxBytes: 1, snapshot: files });
    expect(captured.missing).toEqual(['missing.mjs']);
    expect(captured.collectionErrors).toEqual([
      { path: 'linked.mjs', code: 'TASK_COLLECTION_FAILED' }, { path: 'math.mjs', code: 'TASK_FILE_LIMIT' },
    ]);
  });

  it.each([
    ['throw new Error("verifier infrastructure failure")', 'TASK_ACCEPTANCE_FAILED'],
    ['console.log("invalid json")', 'TASK_ACCEPTANCE_INVALID'],
    ['setTimeout(() => {}, 60000)', 'TASK_ACCEPTANCE_TIMEOUT'],
  ])('preserves acceptance infrastructure failure %s as missing rather than a score', async (script, reasonCode) => {
    const task = await load();
    task.acceptance.timeoutMs = reasonCode === 'TASK_ACCEPTANCE_TIMEOUT' ? 150 : 5000;
    await writeFile(definitionPath, JSON.stringify(task));
    await writeFile(join(root, 'task/acceptance/verify.mjs'), script);
    const { artifacts } = await (await application()).run();
    expect(artifacts.evaluation.records).toHaveLength(2);
    for (const record of artifacts.evaluation.records) {
      expect(record.evaluationStatus).toBe('completed');
      if (record.evaluationStatus === 'completed') expect(record.observations[0]).toMatchObject({ observationStatus: 'missing', reasonCode });
    }
    expect(await readdir(join(root, 'temporary'))).toEqual([]);
  });

  it('refuses rescore when required artifacts were missing', async () => {
    await writeFile(join(root, 'task/fixture.mjs'), 'import {unlink} from "node:fs/promises"; await unlink("math.mjs"); console.log("fixed");');
    const task = await load();
    const app = await application();
    const first = await app.run();
    for (const record of first.artifacts.evaluation.records) {
      if (record.evaluationStatus === 'completed') expect(record.observations[0]).toMatchObject({ observationStatus: 'missing', reasonCode: 'TASK_ARTIFACTS_MISSING' });
    }
    await expect(app.rescore(first.result, task.acceptance, join(root, 'task'))).rejects.toThrow('TASK_RESCORE_EVIDENCE_MISSING');
  });

  it('reports execution timeout and releases all workspaces', async () => {
    const task = await load();
    task.execution.timeoutMs = 100;
    await writeFile(definitionPath, JSON.stringify(task));
    await writeFile(join(root, 'task/fixture.mjs'), 'setTimeout(() => {}, 60000);');
    const { artifacts } = await (await application()).run();
    expect(artifacts.execution.records.every((record) => record.executionStatus === 'failed')).toBe(true);
    expect(artifacts.evaluation.records.every((record) => record.evaluationStatus === 'not-evaluated')).toBe(true);
    expect(await readdir(join(root, 'temporary'))).toEqual([]);
  });

  it('cancels a running task and persists its partial outcome', async () => {
    await writeFile(join(root, 'task/fixture.mjs'), 'setTimeout(() => {}, 60000);');
    const app = await application();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 100);
    try {
      const { result } = await app.run(controller.signal);
      expect(result.status).toBe('cancelled');
    } finally { clearTimeout(timeout); }
    expect(await readdir(join(root, 'temporary'))).toEqual([]);
  });

  it('preserves verifier cleanup failure as missing evidence', async () => {
    cleanupFailure.prefix = '/acceptance-';
    const { artifacts } = await (await application()).run();
    for (const record of artifacts.evaluation.records) {
      if (record.evaluationStatus === 'completed') expect(record.observations[0]).toMatchObject({ observationStatus: 'missing', reasonCode: 'TASK_ACCEPTANCE_CLEANUP_FAILED' });
    }
  });

  it('archives a workspace cleanup failure without reporting task success', async () => {
    cleanupFailure.prefix = '/trial-';
    await expect((await application()).run()).rejects.toThrow('TASK_RUN_FAILED:');
    const content = await readdir(join(root, 'reports/content/content'));
    const values = await Promise.all(content.map((file) => readFile(join(root, 'reports/content/content', file), 'utf8')));
    expect(values.some((value) => value.includes('"status": "failed"'))).toBe(true);
  });
});
