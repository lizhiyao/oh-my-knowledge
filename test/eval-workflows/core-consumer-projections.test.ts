import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  CORE_BATCH_MANIFEST_SCHEMA_VERSION,
  createNodeCoreRunArtifactStore,
  materializeCoreBatchManifest,
  type StoredCoreRunArtifacts,
} from '../../src/eval-workflows/artifact-store/index.js';
import {
  CoreDownstreamProjectionError,
  projectCoreArtifactGraph,
  projectCoreCliBatchOutcome,
  projectCoreCliDryRun,
  projectCoreCliRunOutcome,
  projectCoreManagedEvidence,
} from '../../src/eval-workflows/downstream-projections/index.js';
import { projectCoreStudioRunDetail } from '../../src/eval-workflows/studio-catalog/index.js';
import { digestCanonicalJson } from '../../src/evaluation-core/contracts/index.js';
import {
  prepareConformancePlan,
  runConformanceScenario,
  type ConformanceTarget,
} from '../evaluation-core/conformance/harness.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

function bindArtifactDescriptors(
  definition: Parameters<NonNullable<Parameters<typeof prepareConformancePlan>[1]>>[0],
): void {
  for (const target of definition.targets) {
    target.targetKind = target.targetId === 'control' ? 'baseline' : 'skill';
    target.config = {
      behavior: {
        artifact: {
          resourceId: `artifact-${target.targetId}`,
          digest: digestCanonicalJson({ targetId: target.targetId, body: 'fixture' }),
          mediaType: 'text/markdown',
          classification: 'sensitive',
          size: 7,
        },
      },
    };
  }
}

async function storedScenario(
  target: ConformanceTarget,
  runId: string,
  options: { readonly cancelled?: boolean; readonly withArtifacts?: boolean } = {},
): Promise<StoredCoreRunArtifacts> {
  const plan = await prepareConformancePlan(
    target,
    options.withArtifacts === false ? undefined : bindArtifactDescriptors,
  );
  const cancellation = new AbortController();
  if (options.cancelled === true) cancellation.abort('fixture-cancelled');
  const result = await runConformanceScenario(target, {
    runId,
    plan,
    ...(options.cancelled === true ? { executionSignal: cancellation.signal } : {}),
  });
  const root = await mkdtemp(join(tmpdir(), 'omk-core-consumer-'));
  temporaryDirectories.push(root);
  return createNodeCoreRunArtifactStore(root).save({
    runId,
    createdAt: '2026-09-01T08:00:00.000Z',
    plan: result.plan,
    execution: result.execution,
    evaluation: result.evaluation,
    analysis: result.analysis,
    report: result.report,
  });
}

function projectionError(code: CoreDownstreamProjectionError['code']) {
  return (error: unknown): boolean => (
    error instanceof CoreDownstreamProjectionError && error.code === code
  );
}

describe('Evaluation Core consumer cutover projections', () => {
  it('projects dry-run only from the sealed plan and redacted preflight records', async () => {
    const plan = await prepareConformancePlan('function', bindArtifactDescriptors);
    const projection = projectCoreCliDryRun({
      plan,
      preflight: {
        records: [{
          runtimeKind: 'executor',
          bindingId: 'executor-control',
          referenceId: 'control',
          implementationId: 'conformance-executor/v1',
          preflightKind: 'connectivity',
          checkId: 'provider-ready',
          preflightStatus: 'passed',
        }, {
          runtimeKind: 'evaluator',
          bindingId: 'evaluator-exact',
          referenceId: 'exact',
          implementationId: 'exact/v1',
          preflightKind: 'credential',
          checkId: 'credential-not-required',
          preflightStatus: 'not-required',
          reasonCode: 'local-evaluator',
        }],
      },
    });

    assert.equal(projection.projectionKind, 'core-cli-dry-run');
    assert.equal(projection.runContractDigest, plan.digests.runContractDigest);
    assert.equal(projection.dataset.sampleCount, plan.execution.samples.length);
    assert.equal(projection.preflight.passed, 1);
    assert.equal(projection.preflight.notRequired, 1);
    assert.equal(Object.isFrozen(projection), true);
    assert.ok(!JSON.stringify(projection).includes('evaluationContext'));
    assert.throws(
      () => projectCoreCliDryRun({
        plan: structuredClone(plan),
        preflight: { records: [] },
      }),
      projectionError('CORE_CLI_PLAN_INVALID'),
    );
    assert.throws(
      () => projectCoreCliDryRun({
        plan,
        preflight: {
          records: [{
            runtimeKind: 'executor',
            bindingId: 'executor-control',
            referenceId: 'control',
            implementationId: 'executor/v1',
            preflightKind: 'credential',
            checkId: 'unsafe-check',
            preflightStatus: 'passed',
            reasonCode: '',
          }],
        },
      }),
      projectionError('CORE_CLI_PLAN_INVALID'),
    );
    assert.throws(
      () => projectCoreCliDryRun({
        plan,
        preflight: {
          records: [{
            runtimeKind: 'executor',
            bindingId: 'executor-control',
            referenceId: 'control',
            implementationId: 'executor/v1',
            preflightKind: 'credential',
            checkId: 'unsafe\ncheck',
            preflightStatus: 'passed',
          }],
        },
      }),
      projectionError('CORE_CLI_PLAN_INVALID'),
    );
  });

  it.each(['function', 'rag', 'agent'] as const)(
    'keeps CLI, Studio, graph, and managed views on one authenticated %s chain',
    async (target) => {
      const source = await storedScenario(target, `cutover-${target}`);
      const cli = projectCoreCliRunOutcome(source, { exitMode: 'gate' });
      const studio = projectCoreStudioRunDetail(source);
      const graph = projectCoreArtifactGraph({
        source,
        cwd: '/workspace/project',
        generatedAt: '2026-09-01T08:01:00.000Z',
      });
      const managed = projectCoreManagedEvidence(source);

      assert.equal(cli.reportDigest, source.report.reportDigest);
      assert.equal(cli.gate.gateStatus, 'passed');
      assert.equal(cli.gate.exitCode, 0);
      assert.equal(studio.run.reportDigest, cli.reportDigest);
      assert.equal(managed.reportDigest, cli.reportDigest);
      assert.equal(managed.runCreatedAt, source.manifest.createdAt);
      assert.equal(managed.comparability.runContractDigest, cli.runContractDigest);
      assert.ok(graph.nodes.some((node) => (
        node.nodeKind === 'evaluation_run'
        && node.binding?.keys.reportDigest === cli.reportDigest
      )));
      assert.deepEqual(managed.targets.map((entry) => ({
        targetId: entry.targetId,
        role: entry.experimentRole,
        eligible: entry.managedEvidenceEligible,
      })), [{
        targetId: 'control', role: 'control', eligible: false,
      }, {
        targetId: 'treatment', role: 'treatment', eligible: true,
      }]);
      assert.match(managed.targets[1].artifact.digest, /^sha256:[0-9a-f]{64}$/);
      const encodedManaged = JSON.stringify(managed);
      assert.ok(!encodedManaged.includes('/workspace/project'));
      assert.ok(!encodedManaged.includes('capabilities'));
      assert.ok(!encodedManaged.includes('implementationManifest'));
      assert.equal(Object.isFrozen(managed), true);
    },
  );

  it('separates report-only gate skipping from operational failure', async () => {
    const completed = await storedScenario('function', 'report-only-completed');
    const skipped = projectCoreCliRunOutcome(completed, { exitMode: 'report-only' });
    assert.deepEqual(skipped.gate, {
      gateStatus: 'skipped',
      exitCode: 0,
      reasonCodes: ['core-report-only'],
    });
    assert.throws(
      () => projectCoreCliRunOutcome(completed, { exitMode: 'invalid' as 'gate' }),
      projectionError('CORE_CLI_OPTIONS_INVALID'),
    );

    const cancelled = await storedScenario('function', 'report-only-cancelled', {
      cancelled: true,
    });
    const blocked = projectCoreCliRunOutcome(cancelled, { exitMode: 'report-only' });
    assert.equal(blocked.status.runStatus, 'cancelled');
    assert.deepEqual(blocked.gate, {
      gateStatus: 'blocked',
      exitCode: 1,
      reasonCodes: ['core-run-cancelled'],
    });
  });

  it('projects Batch children without pooling their identities or conclusions', async () => {
    const [first, second] = await Promise.all([
      storedScenario('function', 'batch-function'),
      storedScenario('rag', 'batch-rag'),
    ]);
    const sources = [first, second];
    const manifest = materializeCoreBatchManifest({
      schemaVersion: CORE_BATCH_MANIFEST_SCHEMA_VERSION,
      batchManifestKind: 'evaluation-core-child-runs',
      batchId: 'consumer-batch',
      createdAt: '2026-09-01T08:02:00.000Z',
      children: sources.map((source, ordinal) => ({
        batchItemKind: 'core-run',
        itemId: `item-${ordinal}`,
        ordinal,
        locator: { locatorKind: 'core-run', runId: source.manifest.runId },
        reportId: source.report.reportId,
        runContractDigest: source.plan.digests.runContractDigest,
        reportDigest: source.report.reportDigest,
        artifactSetDigest: digestCanonicalJson(source.manifest.documents),
        status: source.report.status,
        maximumCapturedClassification: source.manifest.maximumCapturedClassification,
      })),
    });
    const projected = projectCoreCliBatchOutcome({
      batch: { manifest },
      children: sources,
      exitMode: 'report-only',
    });

    assert.deepEqual(projected.children.map(({ itemId, runId, outcome }) => ({
      itemId,
      runId,
      reportDigest: outcome.reportDigest,
    })), sources.map((source, ordinal) => ({
      itemId: `item-${ordinal}`,
      runId: source.manifest.runId,
      reportDigest: source.report.reportDigest,
    })));
    assert.deepEqual(projected.gate, {
      gateStatus: 'skipped',
      exitCode: 0,
      reasonCodes: ['core-report-only'],
    });
    assert.throws(
      () => projectCoreCliBatchOutcome({
        batch: { manifest },
        children: [first],
        exitMode: 'gate',
      }),
      projectionError('CORE_CLI_BATCH_SOURCE_INVALID'),
    );
    const tampered = structuredClone(manifest);
    tampered.batchId = 'different-batch';
    assert.throws(
      () => projectCoreCliBatchOutcome({
        batch: { manifest: tampered },
        children: sources,
        exitMode: 'gate',
      }),
      projectionError('CORE_CLI_BATCH_SOURCE_INVALID'),
    );
  });

  it('refuses to invent managed identity when the sealed Target lacks an artifact descriptor', async () => {
    const source = await storedScenario('function', 'managed-missing-artifact', {
      withArtifacts: false,
    });
    assert.throws(
      () => projectCoreManagedEvidence(source),
      projectionError('CORE_MANAGED_EVIDENCE_SOURCE_INVALID'),
    );
  });
});
