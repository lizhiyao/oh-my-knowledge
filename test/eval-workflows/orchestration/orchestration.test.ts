import { executeProductEvaluation } from '../../../src/eval-workflows/orchestration/evaluation-service.js';
import { parseCliEvaluationRequest } from '../../../src/eval-workflows/input-compilation/index.js';
import { prepareRuntimeSeries } from '../../../src/eval-runtime/provider.js';
import { EvaluationRuntimeLifecycleError } from '../../../src/eval-runtime/execution.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEvaluationSeriesDefinition,
  digestCanonicalJson,
  schemaIdentityKey,
  type EvaluationSeriesDefinition,
  type RuntimeIdentity,
} from '../../../src/eval-core/contracts/index.js';
import type { EvaluationRunResult } from '../../../src/eval-core/engine/index.js';
import {
  createNodeCoreBatchArtifactStore,
  createNodeCoreRunArtifactStore,
} from '../../../src/eval-workflows/artifact-store/index.js';
import {
  bindProductionPreparedEvaluation,
  type ProductionEvaluationWorkflowInput,
} from '../../../src/eval-workflows/orchestration/workflow.js';
import {
  executeProductionEvaluationBatch,
  executeProductionEvaluationSeries,
} from '../../../src/eval-workflows/orchestration/orchestration.js';
import {
  createOmkEvaluationSchemaValidators,
  type OmkEvaluationRuntime,
} from '../../../src/eval-workflows/hosts/composition/runtime.js';
import {
  prepareConformancePlan,
  runConformanceScenario,
  type ConformanceResult,
} from '../../eval-core/conformance/harness.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
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

function preparedFixture(
  fixture: ConformanceResult,
  store: ReturnType<typeof createNodeCoreRunArtifactStore>,
) {
  return bindProductionPreparedEvaluation({
    artifactStore: store,
    schemaValidators: createOmkEvaluationSchemaValidators(undefined),
    prepared: {
      plan: fixture.plan,
      preflight: { records: [] },
      async start() {
        return {
          events: (async function* emptyEvents() {})(),
          result: Promise.resolve(completedResult(fixture)),
        };
      },
    },
  });
}

describe('production Batch orchestration', () => {
  it('runs independent children and persists a locator-only manifest after every child', async () => {
    const runRoot = await temporaryRoot('omk-host-batch-runs-');
    const batchRoot = await temporaryRoot('omk-host-batches-');
    const runStore = createNodeCoreRunArtifactStore(runRoot);
    const batchStore = createNodeCoreBatchArtifactStore(batchRoot, runStore);
    const [first, second] = await Promise.all([
      runConformanceScenario('function', { runId: 'batch-first-fixture' }),
      runConformanceScenario('rag', { runId: 'batch-second-fixture' }),
    ]);

    const batch = await executeProductionEvaluationBatch({
      batchId: 'host-batch',
      createdAt: '2026-09-01T01:00:00.000Z',
      batchStore,
      children: [
        {
          itemId: 'first',
          prepared: preparedFixture(first, runStore),
          options: {
            runId: 'host-batch-first',
            createdAt: '2026-09-01T01:00:01.000Z',
          },
        },
        {
          itemId: 'second',
          prepared: preparedFixture(second, runStore),
          options: {
            runId: 'host-batch-second',
            createdAt: '2026-09-01T01:00:02.000Z',
          },
        },
      ],
    });

    assert.deepEqual(batch.children.map(({ itemId, runId }) => ({ itemId, runId })), [
      { itemId: 'first', runId: 'host-batch-first' },
      { itemId: 'second', runId: 'host-batch-second' },
    ]);
    const persistence = await batch.persistence;
    assert.equal(persistence.persistenceStatus, 'stored');
    if (persistence.persistenceStatus !== 'stored') throw new Error('expected stored Batch');
    assert.deepEqual(persistence.batch.manifest.children.map((child) => ({
      itemId: child.itemId,
      runId: child.locator.runId,
    })), [
      { itemId: 'first', runId: 'host-batch-first' },
      { itemId: 'second', runId: 'host-batch-second' },
    ]);
    expect('report' in persistence.batch).toBe(false);
  });

  it('retains started child handles and skips the manifest when another child cannot start', async () => {
    const runRoot = await temporaryRoot('omk-host-partial-batch-runs-');
    const batchRoot = await temporaryRoot('omk-host-partial-batches-');
    const runStore = createNodeCoreRunArtifactStore(runRoot);
    const batchStore = createNodeCoreBatchArtifactStore(batchRoot, runStore);
    const fixture = await runConformanceScenario('function', {
      runId: 'partial-batch-fixture',
    });
    const started = preparedFixture(fixture, runStore);
    const failed = {
      ...preparedFixture(fixture, runStore),
      async execute() { throw new Error('lease acquisition failed'); },
    };

    const batch = await executeProductionEvaluationBatch({
      batchId: 'partial-host-batch',
      createdAt: '2026-09-01T01:10:00.000Z',
      batchStore,
      children: [{
        itemId: 'started',
        prepared: started,
        options: {
          runId: 'partial-host-started',
          createdAt: '2026-09-01T01:10:01.000Z',
        },
      }, {
        itemId: 'failed',
        prepared: failed,
        options: {
          runId: 'partial-host-failed',
          createdAt: '2026-09-01T01:10:02.000Z',
        },
      }],
    });

    assert.deepEqual(batch.children.map(({ executionStatus }) => executionStatus), [
      'started',
      'start-failed',
    ]);
    const persistence = await batch.persistence;
    assert.deepEqual(persistence, {
      persistenceStatus: 'skipped',
      reasonCode: 'BATCH_CHILD_ARTIFACTS_INCOMPLETE',
      childRunIds: ['partial-host-failed'],
    });
    assert.equal(await runStore.exists('partial-host-started'), true);
    assert.equal(await batchStore.exists('partial-host-batch'), false);
  });
});

const seriesOutputSchema = {
  schemaVersion: 'omk.test-production-series-scalar/v1',
  schemaUri: 'urn:omk:test-production-series-scalar:v1',
  schemaDigest: digestCanonicalJson({ schema: 'test-production-series-scalar', version: 1 }),
};

function seriesIdentity(): RuntimeIdentity {
  return {
    implementationId: 'test.production-series/v1',
    version: '1.0.0',
    fingerprint: digestCanonicalJson({ implementation: 'test.production-series', version: 1 }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'verified',
    capabilities: { experimentalUnit: 'run' },
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  };
}

function seriesDefinition(): EvaluationSeriesDefinition {
  return createEvaluationSeriesDefinition({
    schemaVersion: 'omk.evaluation-series-definition/v1',
    seriesId: 'host-repeat-series',
    analysisMode: 'preregistered',
    experimentalUnit: 'run',
    members: [
      { memberId: 'host-repeat-member-0', replicateIndex: 0 },
      { memberId: 'host-repeat-member-1', replicateIndex: 1 },
    ],
    comparabilityPolicy: {
      designMode: 'exact-measurement-design',
      comparisonScope: 'analysis',
      minimumStatus: 'conditional',
    },
    analysisGraph: {
      nodes: [{
        nodeId: 'host-run-variance',
        implementationId: 'test.production-series/v1',
        analysisStandardId: 'test.production-series/v1',
        minimumMemberEvidenceStatus: 'complete',
        inputs: [{ seriesInputKind: 'members', referenceId: 'host-repeat-series' }],
        outputResultId: 'host-run-variance-result',
      }],
    },
  });
}

describe('production independent Series orchestration', () => {
  it('seals each member before execution, verifies persisted facts, and projects evolution', async () => {
    const definition = seriesDefinition();
    const plans = await Promise.all(definition.members.map((member) => prepareConformancePlan(
      'function',
      (runDefinition) => { runDefinition.seriesMembership = {
        seriesDesignDigest: definition.seriesDesignDigest,
        memberId: member.memberId,
        replicateIndex: member.replicateIndex,
      }; },
    )));
    const fixtures = await Promise.all(plans.map((plan, index) => runConformanceScenario(
      'function',
      { runId: `host-series-fixture-${index}`, plan },
    )));
    const identity = seriesIdentity();
    const validator = {
      schema: seriesOutputSchema,
      parse(value: unknown) { return value as never; },
    };
    const runtimeSeries: NonNullable<OmkEvaluationRuntime['series']> = {
      entries: [],
      runtimes: [{
        runtimeKind: 'series-analysis-node',
        referenceId: 'host-run-variance',
        identity,
        outputSchema: seriesOutputSchema,
      }],
      ports: {
        analysisNodesByNodeId: new Map([['host-run-variance', {
          identity,
          outputSchema: seriesOutputSchema,
          async openRun() {
            return {
              async analyze(context) {
                return {
                  analysisStatus: 'completed' as const,
                  resultType: 'scalar' as const,
                  value: context.coverage.comparable,
                };
              },
              dispose() {},
            };
          },
        }]]),
        decisionPoliciesByDecisionPolicyId: new Map(),
      },
    };
    const fixtureByMember = new Map(definition.members.map((member, index) => [
      member.memberId,
      fixtures[index]!,
    ]));
    const basePlan = await prepareConformancePlan('function');
    const runStore = createNodeCoreRunArtifactStore(
      await temporaryRoot('omk-host-series-runs-'),
    );
    let cleanupFails = false;
    const host = {
      compiled: {
        definition: basePlan.definition,
        policy: basePlan.measurementPolicy,
        runtimeBinding: { schemaVersion: 'omk.runtime-binding-request/v1', bindings: [] },
        hostResources: { resources: [] },
        orchestration: {
          dryRun: false,
          batch: false,
          preflight: { doctor: 'skip', connectivity: 'skip' },
          diagnostic: 'disabled',
          managedEvidence: 'skip',
          independentSeries: {
            definition,
            memberships: definition.members.map((member) => ({
              seriesDesignDigest: definition.seriesDesignDigest,
              memberId: member.memberId,
              replicateIndex: member.replicateIndex,
            })),
          },
        },
        presentation: {},
        runOptions: {},
        canonicalDigests: {
          definition: digestCanonicalJson(basePlan.definition),
          policy: digestCanonicalJson(basePlan.measurementPolicy),
        },
      } as unknown as ProductionEvaluationWorkflowInput['compiled'],
      schemaValidators: createOmkEvaluationSchemaValidators(new Map([[schemaIdentityKey(seriesOutputSchema), validator]])),
      artifactStore: runStore,
      runtime: {
        async prepare(runtimeInput) {
          const membership = runtimeInput.definition.seriesMembership;
          const fixture = membership === undefined ? undefined : fixtureByMember.get(membership.memberId);
          if (fixture === undefined) throw new Error('missing fixture member');
          return {
            plan: fixture.plan,
            preflight: { records: [] },
            async start() {
              return {
                events: (async function* emptyEvents() {})(),
                result: cleanupFails
                  ? Promise.reject(new EvaluationRuntimeLifecycleError({
                      code: 'EVAL_RUNTIME_RUN_CLEANUP_FAILED', runId: 'host-cleanup-fixture',
                      message: 'fixture cleanup failed', runResult: completedResult(fixture),
                    }))
                  : Promise.resolve(completedResult(fixture)),
              };
            },
          };
        },
        async prepareSeries(definition) {
          return prepareRuntimeSeries({
            definition, runtimes: runtimeSeries.runtimes,
            ports: {
              ...runtimeSeries.ports,
              clock: { timestamp: () => '2026-09-01T03:00:00.000Z' },
              schemaValidators: createOmkEvaluationSchemaValidators(new Map([[schemaIdentityKey(seriesOutputSchema), validator]])),
            },
          });
        },
      },
    } satisfies ProductionEvaluationWorkflowInput;

    const series = await executeProductionEvaluationSeries({
      host,
      members: [
        { runId: 'host-repeat-run-0', createdAt: '2026-09-01T02:00:00.000Z' },
        { runId: 'host-repeat-run-1', createdAt: '2026-09-01T02:00:01.000Z' },
      ],
      bundleId: 'host-repeat-bundle',
      reportId: 'host-repeat-report',
    });

    assert.deepEqual(series.members.map(({ membership, prepared }) => ({
      membership,
      sealedMembership: prepared.plan.definition.seriesMembership,
    })), definition.members.map((member) => ({
      membership: {
        seriesDesignDigest: definition.seriesDesignDigest,
        memberId: member.memberId,
        replicateIndex: member.replicateIndex,
      },
      sealedMembership: {
        seriesDesignDigest: definition.seriesDesignDigest,
        memberId: member.memberId,
        replicateIndex: member.replicateIndex,
      },
    })));
    const result = await series.result;
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') throw new Error('Expected completed Series result.');
    assert.equal(result.analysis.coverage.planned, 2);
    assert.equal(result.analysis.coverage.completed, 2);
    assert.equal(result.analysis.coverage.comparable, 2);
    assert.equal(result.analysis.records[0]?.analysisStatus, 'completed');
    const evolution = await series.evolution;
    assert.ok(evolution);
    assert.equal(evolution.experimentalUnit, 'run');
    assert.deepEqual(evolution.members.map(({ memberId }) => memberId), [
      'host-repeat-member-0',
      'host-repeat-member-1',
    ]);

    const controller = new AbortController();
    controller.abort('cancel Series projection');
    const cancelled = await executeProductionEvaluationSeries({
      host,
      members: [
        { runId: 'host-cancelled-repeat-0', createdAt: '2026-09-01T04:00:00.000Z' },
        { runId: 'host-cancelled-repeat-1', createdAt: '2026-09-01T04:00:01.000Z' },
      ],
      bundleId: 'host-cancelled-bundle',
      reportId: 'host-cancelled-report',
      seriesSignal: controller.signal,
    });
    await expect(cancelled.result).resolves.toMatchObject({ status: 'cancelled' });
    await expect(cancelled.evolution).resolves.toBeUndefined();

    // Exercise the product entry as well: abort must reach aggregate analysis,
    // even when a host has already completed and persisted all member runs.
    const request = parseCliEvaluationRequest({
      explicitCliFlags: { 'no-judge': true, control: 'baseline', treatment: 'fixture' },
      defaults: {
        samplesLocator: 'samples.json', skillDirectoryLocator: 'skills',
        targetRuntime: { executorId: 'fixture', model: 'fixture', effort: 'low' },
        judgeMembers: [],
        presentation: {
          projectOutputDirectoryLocator: '.omk/eval', globalOutputDirectoryLocator: '.omk/eval',
          language: 'zh', languageDefaultSource: 'derived',
        },
      },
    });
    // Preparation is a separate cancellation boundary from member execution and aggregation.
    for (const alreadyAborted of [true, false]) {
      const preparationController = new AbortController();
      const reason = new Error('cancel member preflight');
      if (alreadyAborted) preparationController.abort(reason);
      let aggregatePrepared = false;
      const cancellableHost: ProductionEvaluationWorkflowInput = {
        ...host,
        runtime: {
          async prepare(_input, options) {
            assert.equal(options?.signal, preparationController.signal);
            if (!alreadyAborted) preparationController.abort(reason);
            options.signal.throwIfAborted();
            throw new Error('cancelled preparation must not return a runnable member');
          },
          async prepareSeries(definition) {
            aggregatePrepared = true;
            return host.runtime.prepareSeries(definition);
          },
        },
      };
      await expect(executeProductEvaluation({
        host: cancellableHost, request, signal: preparationController.signal,
      })).rejects.toBe(reason);
      expect(aggregatePrepared).toBe(false);
    }

    await expect(executeProductEvaluation({ host, request, signal: controller.signal }))
      .rejects.toThrow('Core Series 未完成');

    cleanupFails = true;
    const failed = await executeProductionEvaluationSeries({
      host,
      members: [
        { runId: 'host-cleanup-repeat-0', createdAt: '2026-09-01T05:00:00.000Z' },
        { runId: 'host-cleanup-repeat-1', createdAt: '2026-09-01T05:00:01.000Z' },
      ],
      bundleId: 'host-cleanup-bundle', reportId: 'host-cleanup-report',
    });
    await Promise.all([
      expect(failed.result).rejects.toMatchObject({ code: 'PRODUCTION_EVALUATION_SERIES_MEMBER_RUNTIME_FAILED' }),
      expect(failed.evolution).rejects.toMatchObject({ code: 'PRODUCTION_EVALUATION_SERIES_MEMBER_RUNTIME_FAILED' }),
    ]);
    expect((await runStore.get('host-cleanup-repeat-0'))?.report).toEqual(fixtures[0].report);
    expect((await runStore.get('host-cleanup-repeat-1'))?.report).toEqual(fixtures[1].report);
  });
});
