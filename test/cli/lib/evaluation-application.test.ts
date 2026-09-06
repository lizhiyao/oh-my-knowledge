import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeCoreRunArtifactStore, type CoreRunArtifactStore } from '../../../src/eval-workflows/artifact-store/index.js';
import * as managedEvidence from '../../../src/knowledge-artifacts/governance/evidence.js';
import { runCoreEvaluationCommand } from '../../../src/cli/lib/run-core-evaluation.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omk-eval-application-'));
  roots.push(root);
  vi.stubEnv('OMK_HOME', join(root, 'home'));
  vi.stubEnv('OMK_TREES_DIR', join(root, 'trees'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const skillDir = join(root, 'skills');
  const skill = join(skillDir, 'answer');
  await mkdir(join(skill, '.omk'), { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '# Answer\nAnswer directly.\n');
  const samplesPath = join(skill, '.omk', 'eval-samples.json');
  await writeFile(samplesPath, JSON.stringify({ schemaVersion: 'omk.eval-sample-set/v2', samples: [
    { sample_id: 'answer', prompt: 'Answer.', assertions: [{ type: 'contains', value: 'fixture' }] },
  ] }));
  const outputDirectory = join(root, 'reports');
  const config = { samplesPath, skillDir, executorName: resolve('test/fixtures/custom-executor/core-fixture-executor.sh'), model: 'fixture', judgeModels: [] };
  const flags = { control: 'baseline', treatment: skill, 'no-judge': true, 'skip-doctor': true, 'skip-connectivity': true, 'no-serve': true, 'output-dir': outputDirectory };
  return { root, outputDirectory, run: (extra: Record<string, unknown> = {}, store?: CoreRunArtifactStore) => runCoreEvaluationCommand({ projectRoot: root, config, flags: { ...flags, ...extra }, evalConfig: null, lang: 'zh', store }) };
}

describe('CLI product application', () => {
  it('persists sidecars and keeps resume fail-closed when verification facts are missing', async () => {
    const input = await fixture();
    const first = await input.run();
    expect(first.stored).toBeDefined();
    const runId = first.stored!.manifest.runId;
    await expect(input.run({ resume: runId })).rejects.toThrow('verification facts not established');
    const { coreRunArtifactDirectoryName } = await import('../../../src/eval-workflows/artifact-store/index.js');
    const card = await readFile(join(input.outputDirectory, coreRunArtifactDirectoryName(runId), 'derived', 'card.md'), 'utf8');
    expect(card).toContain(runId);
    await expect(input.run({ resume: '../report.json' })).rejects.toThrow('--resume 只接受 Core runId');
  });

  it('runs batch children through the same product path for preview and persisted output', async () => {
    const input = await fixture();
    const preview = await input.run({ batch: true, 'dry-run': true });
    expect(preview.output).toMatchObject({ projectionKind: 'core-cli-batch-dry-run', children: [{ itemId: 'answer' }] });
    const result = await input.run({ batch: true });
    expect(result.output).toMatchObject({ projectionKind: 'core-cli-batch-outcome' });
    await expect(input.run({ batch: true, resume: 'existing' })).rejects.toThrow('Batch resume');
  });

  it('rejects publication failure without announcing saved artifacts or appending managed evidence', async () => {
    const input = await fixture();
    const store = createNodeCoreRunArtifactStore(input.outputDirectory);
    const append = vi.spyOn(managedEvidence, 'recordCoreEvalEvidence');
    await expect(input.run({}, {
      ...store, async save() { throw new Error('fixture disk full'); },
    })).rejects.toMatchObject({ code: 'PRODUCTION_EVALUATION_ARTIFACT_PERSIST_FAILED' });
    expect(await store.list()).toEqual([]);
    expect(append).not.toHaveBeenCalled();
    expect(vi.mocked(process.stderr.write).mock.calls.flat().join('')).not.toContain('Core 评测产物已保存');
  });

  it('retains authenticated artifacts when managed evidence fails and emits a warning', async () => {
    const input = await fixture();
    vi.spyOn(managedEvidence, 'recordCoreEvalEvidence').mockImplementation(() => { throw new Error('fixture governance failure'); });
    const result = await input.run();
    expect(result.stored).toBeDefined();
    const store = createNodeCoreRunArtifactStore(input.outputDirectory);
    expect((await store.get(result.stored!.manifest.runId))?.report.reportDigest).toBe(result.stored!.report.reportDigest);
    expect(vi.mocked(process.stderr.write).mock.calls.flat().join('')).toContain('警告：Core 受管证据写入失败：fixture governance failure');
  });

  it('does not announce a complete Series or append member evidence after one publication fails', async () => {
    const input = await fixture();
    const store = createNodeCoreRunArtifactStore(input.outputDirectory);
    const append = vi.spyOn(managedEvidence, 'recordCoreEvalEvidence');
    let saves = 0;
    await expect(input.run({ repeat: 2, 'bootstrap-samples': 100 }, {
      ...store,
      async save(value) {
        saves += 1;
        if (saves === 2) throw new Error('fixture second publication failure');
        return store.save(value);
      },
    })).rejects.toMatchObject({ code: 'PRODUCTION_EVALUATION_ARTIFACT_PERSIST_FAILED' });
    expect(saves).toBe(2);
    expect(await store.list()).toHaveLength(1);
    expect(append).not.toHaveBeenCalled();
    expect(vi.mocked(process.stderr.write).mock.calls.flat().join('')).not.toContain('Core Series 已完成');
  });

});
