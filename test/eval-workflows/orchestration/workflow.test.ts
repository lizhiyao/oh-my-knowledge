import { createOmkEvaluationSchemaValidators } from '../../../src/eval-hosts/runtime-adapter/composition.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sha256Digest } from '../../../src/eval-core/contracts/index.js';
import type { EvaluationRunResult } from '../../../src/eval-core/engine/index.js';
import {
  createNodeCoreRunArtifactStore,
  type CoreRunArtifactStore,
} from '../../../src/eval-workflows/artifact-store/index.js';
import {
  createProductionEvaluationWorkflow,
  type ProductionEvaluationWorkflowInput,
} from '../../../src/eval-workflows/orchestration/index.js';
import type {
  OmkEvaluationRuntime,
  OmkPreparedEvaluation,
} from '../../../src/eval-hosts/runtime-adapter/composition.js';
import {
  runConformanceScenario,
  type ConformanceResult,
  type ConformanceTarget,
} from '../../eval-core/conformance/harness.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryStore(): Promise<CoreRunArtifactStore> {
  const root = await mkdtemp(join(tmpdir(), 'omk-orchestration-'));
  roots.push(root);
  return createNodeCoreRunArtifactStore(root);
}

function completedResult(fixture: ConformanceResult): EvaluationRunResult {
  return {
    status: 'completed',
    artifacts: {
      execution: fixture.execution,
      evaluation: fixture.evaluation,
      analysis: fixture.analysis,
      ...(fixture.decision === undefined ? {} : { decision: fixture.decision }),
    },
    report: fixture.report,
  };
}

function fakeRuntime(
  fixture: ConformanceResult,
  result: Promise<EvaluationRunResult>,
  onStart: () => void = () => undefined,
): OmkEvaluationRuntime {
  const prepared: OmkPreparedEvaluation = {
    plan: fixture.plan,
    preflight: { records: [] },
    async start() {
      onStart();
      return {
        events: (async function* emptyEvents() {})(),
        result,
      };
    },
  };
  return { async prepare() { return prepared; } };
}

function hostInput(input: {
  fixture: ConformanceResult;
  result: Promise<EvaluationRunResult>;
  store: CoreRunArtifactStore;
  onStart?: () => void;
  dryRun?: boolean;
}): ProductionEvaluationWorkflowInput {
  return {
    compiled: {
      definition: input.fixture.plan.definition, policy: input.fixture.plan.measurementPolicy,
      runOptions: {}, orchestration: { dryRun: input.dryRun ?? false },
    } as ProductionEvaluationWorkflowInput['compiled'],
    schemaValidators: createOmkEvaluationSchemaValidators(undefined),
    artifactStore: input.store,
    runtime: {
      async prepare() { return fakeRuntime(input.fixture, input.result, input.onStart).prepare(); },
      async prepareSeries() { throw new Error('unexpected Series preparation'); },
    },
  };
}

function recordingStore(input: {
  save?: CoreRunArtifactStore['save'];
  get?: CoreRunArtifactStore['get'];
} = {}): CoreRunArtifactStore {
  return {
    save: input.save ?? vi.fn(async () => { throw new Error('unexpected save'); }),
    get: input.get ?? vi.fn(async () => undefined),
    inspect: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    exists: vi.fn(async () => false),
  };
}

describe('production evaluation host workflow', () => {
  it('requires an injected Runtime and passes only neutral measurement input to preparation', async () => {
    const fixture = await runConformanceScenario('function', { runId: 'injected-runtime-fixture' });
    const input = hostInput({ fixture, result: Promise.resolve(completedResult(fixture)), store: recordingStore() });
    expect(() => createProductionEvaluationWorkflow({ ...input, runtime: undefined } as unknown as ProductionEvaluationWorkflowInput))
      .toThrow(expect.objectContaining({ code: 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID', fieldPath: 'runtime' }));
    const prepare = vi.spyOn(input.runtime, 'prepare');
    const controller = new AbortController();
    const prepared = await createProductionEvaluationWorkflow(input).prepare({ signal: controller.signal });
    expect(prepare).toHaveBeenCalledOnce();
    const [request, options] = prepare.mock.calls[0];
    expect(Object.keys(request).sort()).toEqual(['definition', 'policy']);
    expect(request.definition).toEqual(fixture.plan.definition);
    expect(request.policy).toEqual(fixture.plan.measurementPolicy);
    expect(options?.signal).toBe(controller.signal);
    expect(prepared.plan).toBe(fixture.plan);
  });

  it.each(['function', 'rag', 'agent'] as const)(
    'keeps prepare side-effect free and publishes an exact completed %s five-document chain',
    async (target: ConformanceTarget) => {
    const fixture = await runConformanceScenario(target, { runId: `host-fixture-${target}` });
    const coreResult = completedResult(fixture);
    const resultPromise = Promise.resolve(coreResult);
    const store = await temporaryStore();
    const onStart = vi.fn();
    const prepared = await createProductionEvaluationWorkflow(hostInput({
      fixture,
      result: resultPromise,
      store,
      onStart,
    })).prepare();

    expect(onStart).not.toHaveBeenCalled();
    assert.equal(prepared.plan, fixture.plan);
    assert.deepEqual(prepared.preflight, { records: [] });

    const run = await prepared.execute({
      runId: `host-run-${target}`,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(onStart).toHaveBeenCalledOnce();
    assert.equal(run.result, resultPromise);
    assert.equal(await run.result, coreResult);
    const persistence = await run.persistence;
    assert.equal(persistence.persistenceStatus, 'stored');
    if (persistence.persistenceStatus !== 'stored') throw new Error('expected stored result');
    assert.deepEqual(await store.get(`host-run-${target}`), persistence.artifacts);
    assert.equal(persistence.artifacts.report.reportDigest, fixture.report.reportDigest);
    },
  );

  it.each(['cancelled', 'budget-exhausted'] as const)(
    'preserves and publishes an exact %s Core chain',
    async (status) => {
      const cancellation = new AbortController();
      if (status === 'cancelled') cancellation.abort('fixture cancellation');
      const fixture = await runConformanceScenario('rag', {
        runId: `host-${status}`,
        ...(status === 'cancelled'
          ? { executionSignal: cancellation.signal }
          : {
            mutate(_definition, policy) {
              policy.budget.stages.execution.maxInvocations = 1;
            },
          }),
      });
      assert.equal(fixture.report.status.runStatus, status);
      const result = { ...completedResult(fixture), status } as EvaluationRunResult;
      const store = await temporaryStore();
      const prepared = await createProductionEvaluationWorkflow(hostInput({
        fixture,
        result: Promise.resolve(result),
        store,
      })).prepare();
      const run = await prepared.execute({
        runId: `host-${status}`,
        createdAt: '2026-09-01T00:00:00.000Z',
      });

      assert.equal((await run.result).status, status);
      assert.equal((await run.persistence).persistenceStatus, 'stored');
      assert.equal((await store.get(`host-${status}`))?.report.status.runStatus, status);
    },
  );

  it('does not fabricate or publish a five-document chain after a partial failure', async () => {
    const fixture = await runConformanceScenario('agent', { runId: 'host-partial' });
    const result: EvaluationRunResult = {
      status: 'failed',
      error: { code: 'fixture-failed', stage: 'execution', message: 'fixture failure' },
      artifacts: { execution: fixture.execution },
    };
    const save = vi.fn(async () => { throw new Error('must not save'); });
    const prepared = await createProductionEvaluationWorkflow(hostInput({
      fixture,
      result: Promise.resolve(result),
      store: recordingStore({ save }),
    })).prepare();
    const run = await prepared.execute({
      runId: 'host-partial',
      createdAt: '2026-09-01T00:00:00.000Z',
    });

    assert.equal(await run.result, result);
    assert.deepEqual(await run.persistence, {
      persistenceStatus: 'skipped',
      reasonCode: 'CORE_RESULT_INCOMPLETE',
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('reports publication failure without rejecting or rewriting the Core result', async () => {
    const fixture = await runConformanceScenario('function', { runId: 'host-store-failure' });
    const result = completedResult(fixture);
    const prepared = await createProductionEvaluationWorkflow(hostInput({
      fixture,
      result: Promise.resolve(result),
      store: recordingStore({ save: vi.fn(async () => { throw new Error('disk full'); }) }),
    })).prepare();
    const run = await prepared.execute({
      runId: 'host-store-failure',
      createdAt: '2026-09-01T00:00:00.000Z',
    });

    assert.equal(await run.result, result);
    const persistence = await run.persistence;
    assert.equal(persistence.persistenceStatus, 'failed');
    if (persistence.persistenceStatus !== 'failed') throw new Error('expected failure');
    assert.equal(persistence.error.code, 'PRODUCTION_EVALUATION_ARTIFACT_PERSIST_FAILED');
  });

  it('admits resume only through the freshly sealed plan and persisted source', async () => {
    const fixture = await runConformanceScenario('function', { runId: 'resume-source' });
    const store = await temporaryStore();
    await store.save({
      runId: 'resume-source',
      createdAt: '2026-09-01T00:00:00.000Z',
      plan: fixture.plan,
      execution: fixture.execution,
      evaluation: fixture.evaluation,
      analysis: fixture.analysis,
      report: fixture.report,
    });
    const prepared = await createProductionEvaluationWorkflow(hostInput({
      fixture,
      result: Promise.resolve(completedResult(fixture)),
      store,
    })).prepare();
    const admitted = await prepared.admitResume({
      locator: { locatorKind: 'core-run', runId: 'resume-source' },
      policy: {
        rejectionMode: 'fail-closed',
        minimumSourceTrust: 'untrusted',
        cacheReceiptMode: 'allow-indeterminate',
        budgetVerificationMode: 'allow-indeterminate',
      },
      ...(fixture.decision === undefined ? {} : {
        verification: {
          execution: {
            verifiedProvenanceBundleDigests: new Set([
              fixture.execution.bundleDigest as Sha256Digest,
            ]),
          },
          evaluation: {
            verifiedProvenanceBundleDigests: new Set([
              fixture.evaluation.bundleDigest as Sha256Digest,
            ]),
            executionSourceTrust: 'verified' as const,
          },
          analysis: {
            verifiedProvenanceBundleDigests: new Set([
              fixture.analysis.bundleDigest as Sha256Digest,
            ]),
            evaluationSourceTrust: 'verified' as const,
          },
          decision: {
            verifiedPolicyExecutionDigests: new Set([
              fixture.decision.decisionDigest as Sha256Digest,
            ]),
            analysisSourceTrust: 'verified' as const,
          },
        },
      }),
    });

    assert.equal(admitted.disposition, 'reuse');
    if (admitted.disposition !== 'reuse') throw new Error('expected admitted source');
    assert.equal(admitted.sourceRunId, 'resume-source');
    assert.equal(admitted.report.reportDigest, fixture.report.reportDigest);
  });

  it('rejects an invalid publication timestamp before starting any Runtime effect', async () => {
    const fixture = await runConformanceScenario('function', { runId: 'host-invalid-time' });
    const onStart = vi.fn();
    const prepared = await createProductionEvaluationWorkflow(hostInput({
      fixture,
      result: Promise.resolve(completedResult(fixture)),
      store: recordingStore(),
      onStart,
    })).prepare();

    await expect(prepared.execute({ runId: 'host-invalid-time', createdAt: 'now' }))
      .rejects.toMatchObject({
        code: 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID',
        fieldPath: 'execute.createdAt',
      });
    expect(onStart).not.toHaveBeenCalled();
  });

  it('makes dry-run an enforced prepare-only mode', async () => {
    const fixture = await runConformanceScenario('function', { runId: 'host-dry-run' });
    const onStart = vi.fn();
    const prepared = await createProductionEvaluationWorkflow(hostInput({
      fixture,
      result: Promise.resolve(completedResult(fixture)),
      store: recordingStore(),
      onStart,
      dryRun: true,
    })).prepare();

    assert.equal(prepared.executionMode, 'dry-run');
    assert.equal(prepared.plan, fixture.plan);
    await expect(prepared.execute({
      runId: 'host-dry-run',
      createdAt: '2026-09-01T00:00:00.000Z',
    })).rejects.toMatchObject({
      code: 'PRODUCTION_EVALUATION_DRY_RUN_EXECUTION_FORBIDDEN',
    });
    expect(onStart).not.toHaveBeenCalled();
  });
});
