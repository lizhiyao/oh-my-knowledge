import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { createBuiltinAnalysisSchemaValidators } from '../../src/evaluation-core/analysis/index.js';
import type { SealedRunPlan } from '../../src/evaluation-core/compiler/index.js';
import type {
  EvaluationDefinition,
  MeasurementPolicy,
  Sha256Digest,
} from '../../src/evaluation-core/contracts/index.js';
import {
  createNodeCoreRunArtifactStore,
} from '../../src/eval-workflows/artifact-store/index.js';
import {
  CoreResumeAdmissionError,
  createCoreResumeAdmissionAdapter,
  type CoreResumeAdmissionPolicy,
  type CoreResumeVerificationContexts,
} from '../../src/eval-workflows/resume-admission/index.js';
import {
  InMemoryConformanceExecutionCache,
  InMemoryConformanceArtifactStore,
  prepareConformancePlan,
  runConformanceScenario,
  type ConformanceResult,
} from '../evaluation-core/conformance/harness.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'omk-core-resume-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

const strictPolicy: CoreResumeAdmissionPolicy = {
  rejectionMode: 'fail-closed',
  minimumSourceTrust: 'declared',
  cacheReceiptMode: 'require-verified',
  budgetVerificationMode: 'require-verified',
};

function trustedVerification(
  result: ConformanceResult,
  executionCacheRecordDigests: readonly Sha256Digest[] = [],
): CoreResumeVerificationContexts {
  return {
    execution: {
      verifiedCacheRecordDigests: new Set(executionCacheRecordDigests),
      verifiedProvenanceBundleDigests: new Set([
        result.execution.bundleDigest as Sha256Digest,
      ]),
    },
    evaluation: {
      verifiedProvenanceBundleDigests: new Set([
        result.evaluation.bundleDigest as Sha256Digest,
      ]),
      executionSourceTrust: 'verified',
    },
    analysis: {
      verifiedProvenanceBundleDigests: new Set([
        result.analysis.bundleDigest as Sha256Digest,
      ]),
      evaluationSourceTrust: 'verified',
    },
    ...(result.decision === undefined ? {} : {
      decision: {
        verifiedPolicyExecutionDigests: new Set([
          result.decision.decisionDigest as Sha256Digest,
        ]),
        analysisSourceTrust: 'verified' as const,
      },
    }),
  };
}

function saveRequest(
  result: ConformanceResult,
  runId: string,
) {
  return {
    runId,
    createdAt: '2026-08-31T13:00:00.000Z',
    plan: result.plan,
    execution: result.execution,
    evaluation: result.evaluation,
    analysis: result.analysis,
    report: result.report,
  };
}

async function saveResult(
  result: ConformanceResult,
  root: string,
  runId: string,
) {
  const store = createNodeCoreRunArtifactStore(root);
  await store.save(saveRequest(result, runId));
  return store;
}

describe('Core resume admission', () => {
  it('re-admits a complete run against a freshly sealed Plan and trusted evidence', async () => {
    const root = await temporaryDirectory();
    const sourceRunId = 'resume-source';
    const result = await runConformanceScenario('function', { runId: sourceRunId });
    const store = await saveResult(result, root, sourceRunId);
    const freshPlan = await prepareConformancePlan('function');
    assert.notEqual(freshPlan, result.plan);
    assert.equal(
      freshPlan.digests.runContractDigest,
      result.plan.digests.runContractDigest,
    );
    const adapter = createCoreResumeAdmissionAdapter({
      artifactStore: store,
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
    });

    const admitted = await adapter.admit({
      locator: { locatorKind: 'core-run', runId: sourceRunId },
      plan: freshPlan,
      policy: strictPolicy,
      verification: trustedVerification(result),
    });

    assert.equal(admitted.disposition, 'reuse');
    if (admitted.disposition !== 'reuse') return;
    assert.equal(admitted.report.reportDigest, result.report.reportDigest);
    assert.equal(admitted.verification.effectiveSourceTrust, 'declared');
    assert.match(admitted.admissionDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(admitted.executionSource.bundle, admitted.artifacts.execution);
  });

  it('returns a stable start-fresh reason when an explicit fallback policy rejects a source', async () => {
    const root = await temporaryDirectory();
    const adapter = createCoreResumeAdmissionAdapter({
      artifactStore: createNodeCoreRunArtifactStore(root),
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
    });
    const result = await adapter.admit({
      locator: { locatorKind: 'core-run', runId: 'missing-run' },
      plan: await prepareConformancePlan('function'),
      policy: { ...strictPolicy, rejectionMode: 'start-fresh' },
    });
    assert.deepEqual(result, {
      disposition: 'start-fresh',
      sourceRunId: 'missing-run',
      reasonCode: 'CORE_RESUME_SOURCE_NOT_FOUND',
    });
  });

  it('fails closed on a different freshly sealed RunContract', async () => {
    const root = await temporaryDirectory();
    const sourceRunId = 'contract-source';
    const result = await runConformanceScenario('function', { runId: sourceRunId });
    const store = await saveResult(result, root, sourceRunId);
    const adapter = createCoreResumeAdmissionAdapter({
      artifactStore: store,
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
    });
    await assert.rejects(adapter.admit({
      locator: { locatorKind: 'core-run', runId: sourceRunId },
      plan: await prepareConformancePlan('rag'),
      policy: strictPolicy,
    }), (error: unknown) => (
      error instanceof CoreResumeAdmissionError
      && error.code === 'CORE_RESUME_CONTRACT_MISMATCH'
    ));
  });

  it('does not grant sealed capability to a transported RunPlan document', async () => {
    const root = await temporaryDirectory();
    const sourceRunId = 'transported-plan-source';
    const result = await runConformanceScenario('function', { runId: sourceRunId });
    const store = await saveResult(result, root, sourceRunId);
    const adapter = createCoreResumeAdmissionAdapter({
      artifactStore: store,
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
    });
    const transportedPlan = structuredClone(result.plan) as unknown as SealedRunPlan;
    const admission = await adapter.admit({
      locator: { locatorKind: 'core-run', runId: sourceRunId },
      plan: transportedPlan,
      policy: { ...strictPolicy, rejectionMode: 'start-fresh' },
      verification: trustedVerification(result),
    });
    assert.deepEqual(admission, {
      disposition: 'start-fresh',
      sourceRunId,
      reasonCode: 'CORE_RESUME_REQUEST_INVALID',
    });
  });

  it('separates provenance policy rejection from indeterminate Decision verification', async () => {
    const root = await temporaryDirectory();
    const sourceRunId = 'unattested-source';
    const result = await runConformanceScenario('function', { runId: sourceRunId });
    const store = await saveResult(result, root, sourceRunId);
    const adapter = createCoreResumeAdmissionAdapter({
      artifactStore: store,
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
    });
    const provenanceRejected = await adapter.admit({
      locator: { locatorKind: 'core-run', runId: sourceRunId },
      plan: result.plan,
      policy: { ...strictPolicy, rejectionMode: 'start-fresh' },
    });
    assert.equal(provenanceRejected.disposition, 'start-fresh');
    if (provenanceRejected.disposition === 'start-fresh') {
      assert.equal(
        provenanceRejected.reasonCode,
        'CORE_RESUME_PROVENANCE_BELOW_POLICY',
      );
    }
    const verificationRejected = await adapter.admit({
      locator: { locatorKind: 'core-run', runId: sourceRunId },
      plan: result.plan,
      policy: {
        rejectionMode: 'start-fresh',
        minimumSourceTrust: 'unknown',
        cacheReceiptMode: 'allow-indeterminate',
        budgetVerificationMode: 'allow-indeterminate',
      },
    });
    assert.equal(verificationRejected.disposition, 'start-fresh');
    if (verificationRejected.disposition === 'start-fresh') {
      assert.equal(
        verificationRejected.reasonCode,
        'CORE_RESUME_VERIFICATION_INDETERMINATE',
      );
    }
  });

  it('rejects cancelled or partial Core facts instead of copying successful rows', async () => {
    const root = await temporaryDirectory();
    const controller = new AbortController();
    controller.abort('test cancellation');
    const sourceRunId = 'partial-source';
    const result = await runConformanceScenario('function', {
      runId: sourceRunId,
      executionSignal: controller.signal,
    });
    assert.notEqual(result.report.status.runStatus, 'completed');
    const store = await saveResult(result, root, sourceRunId);
    const adapter = createCoreResumeAdmissionAdapter({
      artifactStore: store,
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
    });
    const admission = await adapter.admit({
      locator: { locatorKind: 'core-run', runId: sourceRunId },
      plan: result.plan,
      policy: { ...strictPolicy, rejectionMode: 'start-fresh' },
    });
    assert.equal(admission.disposition, 'start-fresh');
    if (admission.disposition === 'start-fresh') {
      assert.equal(admission.reasonCode, 'CORE_RESUME_SOURCE_INCOMPLETE');
    }
  });

  it('distinguishes unavailable referenced evidence from a malformed source', async () => {
    const root = await temporaryDirectory();
    const sourceRunId = 'referenced-evidence-source';
    const contentStore = new InMemoryConformanceArtifactStore();
    const result = await runConformanceScenario('function', {
      runId: sourceRunId,
      artifactStore: contentStore,
      mutate(_definition, policy) {
        policy.evidence.output = 'reference';
      },
    });
    const writableStore = createNodeCoreRunArtifactStore(root, {
      contentResolver: contentStore,
    });
    await writableStore.save(saveRequest(result, sourceRunId));
    const adapter = createCoreResumeAdmissionAdapter({
      artifactStore: createNodeCoreRunArtifactStore(root),
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
    });
    const admission = await adapter.admit({
      locator: { locatorKind: 'core-run', runId: sourceRunId },
      plan: result.plan,
      policy: { ...strictPolicy, rejectionMode: 'start-fresh' },
      verification: trustedVerification(result),
    });
    assert.deepEqual(admission, {
      disposition: 'start-fresh',
      sourceRunId,
      reasonCode: 'CORE_RESUME_EVIDENCE_UNAVAILABLE',
    });
  });

  it('requires independent cache receipts for transported replay lineage', async () => {
    const root = await temporaryDirectory();
    const cache = new InMemoryConformanceExecutionCache();
    const mutate = (_definition: EvaluationDefinition, policy: MeasurementPolicy) => {
      policy.cache.executionMode = 'transparent-deterministic';
    };
    await runConformanceScenario('function', {
      suffix: 'cache-seed',
      executionCache: cache,
      mutate,
    });
    const sourceRunId = 'cache-replay-source';
    const replay = await runConformanceScenario('function', {
      runId: sourceRunId,
      suffix: 'cache-replay',
      executionCache: cache,
      mutate,
    });
    const store = await saveResult(replay, root, sourceRunId);
    const adapter = createCoreResumeAdmissionAdapter({
      artifactStore: store,
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
    });
    const withoutReceipts = await adapter.admit({
      locator: { locatorKind: 'core-run', runId: sourceRunId },
      plan: replay.plan,
      policy: {
        ...strictPolicy,
        rejectionMode: 'start-fresh',
        minimumSourceTrust: 'unknown',
      },
    });
    assert.equal(withoutReceipts.disposition, 'start-fresh');
    if (withoutReceipts.disposition === 'start-fresh') {
      assert.equal(
        withoutReceipts.reasonCode,
        'CORE_RESUME_CACHE_RECEIPT_INDETERMINATE',
      );
    }
    const sourceRecordDigests = replay.execution.records.flatMap((record) => (
      record.executionStatus === 'completed'
        && record.cache.cacheStatus !== 'not-used'
        && record.cache.sourceRecordDigest !== undefined
        ? [record.cache.sourceRecordDigest as Sha256Digest]
        : []
    ));
    const admitted = await adapter.admit({
      locator: { locatorKind: 'core-run', runId: sourceRunId },
      plan: replay.plan,
      policy: strictPolicy,
      verification: trustedVerification(replay, sourceRecordDigests),
    });
    assert.equal(admitted.disposition, 'reuse');
  });
});
