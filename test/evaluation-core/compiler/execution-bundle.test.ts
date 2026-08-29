import { describe, expect, it } from 'vitest';
import {
  EXECUTION_BUNDLE_SCHEMA_VERSION,
  deriveAttemptId,
  derivePlannedExecutionCoordinates,
  deriveTrialId,
  deriveTrialSeed,
  digestArtifactPayload,
  digestCanonicalJson,
  parseExecutionBundle,
  parseExecutionBundleDocument,
  verifyExecutionBundle,
  type ExecutionBundle,
  type ExecutionRecord,
  type RuntimeIdentity,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';
import { prepareEvaluationPlan } from '../../../src/evaluation-core/compiler/index.js';
import { testRuntime, validDefinition, validPolicy } from './fixtures.js';

type PreparedPlan = Awaited<ReturnType<typeof prepareEvaluationPlan>>;

const placeholderDigest = `sha256:${'0'.repeat(64)}` as Sha256Digest;

function mutableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeBundle(plan: PreparedPlan): ExecutionBundle {
  const coordinates = derivePlannedExecutionCoordinates(plan);
  const runtimes = new Map(plan.execution.runtimes
    .filter((runtime) => runtime.runtimeKind === 'executor')
    .map((runtime) => [runtime.referenceId, runtime.identity]));
  const records: ExecutionRecord[] = coordinates.map((coordinate) => {
    const runtime = runtimes.get(coordinate.targetId);
    if (runtime === undefined) throw new Error('missing test Runtime');
    return {
      ...coordinate,
      runtime: mutableJson(runtime) as RuntimeIdentity,
      provenance: {
        provenanceKind: 'native',
        trust: 'verified',
        parentDigests: [plan.execution.executionPlanDigest],
      },
      attempts: [{
        attemptId: deriveAttemptId({ trialId: coordinate.trialId, attemptNumber: 1 }),
        attemptNumber: 1,
        attemptStatus: 'completed',
        timing: {
          startedAt: '2026-08-28T00:00:00Z',
          completedAt: '2026-08-28T00:00:01Z',
          durationMs: 1000,
        },
      }],
      timing: {
        startedAt: '2026-08-28T00:00:00Z',
        completedAt: '2026-08-28T00:00:01Z',
        durationMs: 1000,
      },
      cache: plan.execution.policy.executionCacheMode === 'disabled'
        ? { cacheStatus: 'not-used' }
        : {
          cacheStatus: 'miss',
          cacheKeyDigest: digestCanonicalJson({
            derivation: 'omk.execution-cache-key/v1',
            executionPlanDigest: plan.execution.executionPlanDigest,
            trialId: coordinate.trialId,
          }),
        },
      executionStatus: 'completed',
      output: {
        contentKind: 'inline',
        classification: 'public',
        value: { answer: 42 },
      },
    };
  });
  const bundle: ExecutionBundle = {
    schemaVersion: EXECUTION_BUNDLE_SCHEMA_VERSION,
    bundleId: 'bundle-plan-aware',
    runContractDigest: plan.digests.runContractDigest,
    executionPlanDigest: plan.digests.executionPlanDigest,
    datasetRevisionDigest: plan.digests.datasetRevisionDigest,
    executionInputDigest: plan.digests.executionInputDigest,
    executionBundleStatus: 'completed',
    coverage: {
      planned: records.length,
      started: records.length,
      succeeded: records.length,
      failed: 0,
      cancelled: 0,
      budgetCensored: 0,
      notStarted: 0,
    },
    replayability: 'self-contained',
    records,
    provenance: {
      provenanceKind: 'native',
      trust: 'verified',
      parentDigests: [
        plan.digests.runContractDigest,
        plan.digests.executionPlanDigest,
      ],
    },
    bundleDigest: placeholderDigest,
  };
  bundle.bundleDigest = digestArtifactPayload(bundle, 'bundleDigest');
  return bundle;
}

function resign(bundle: ExecutionBundle): ExecutionBundle {
  bundle.bundleDigest = digestArtifactPayload(bundle, 'bundleDigest');
  return bundle;
}

function turnIntoCacheHit(
  record: Extract<ExecutionRecord, { executionStatus: 'completed' }>,
  status: 'replay' | 'transparent-hit' = 'transparent-hit',
): Sha256Digest {
  if (record.cache.cacheStatus !== 'miss' || record.cache.cacheKeyDigest === undefined) {
    throw new Error('expected a native cache miss');
  }
  const sourceRecordDigest = digestCanonicalJson(record);
  record.cache = {
    cacheStatus: status,
    cacheKeyDigest: record.cache.cacheKeyDigest,
    sourceRecordDigest,
  };
  record.provenance = {
    provenanceKind: 'replay',
    trust: record.provenance.trust,
    sourceId: record.trialId,
    parentDigests: [sourceRecordDigest],
  };
  return sourceRecordDigest;
}

function setAttemptCost(
  record: Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>,
  amount: number,
  currency = 'USD',
): void {
  const usage = {
    providerCost: { amount, currency, reportedByProvider: true as const },
  };
  for (const attempt of record.attempts) attempt.usage = mutableJson(usage);
  record.usage = record.attempts.length === 1
    ? mutableJson(usage)
    : {
      providerCost: {
        amount: amount * record.attempts.length,
        currency,
        reportedByProvider: true,
      },
      details: {
        aggregationKind: 'omk.execution-usage-summary/v1',
        attemptCount: record.attempts.length,
        reportedAttemptCount: record.attempts.length,
        providerCostAggregation: 'summed',
      },
    };
}

async function makePlan(
  paired = false,
  mutatePolicy?: (policy: ReturnType<typeof validPolicy>) => void,
): Promise<PreparedPlan> {
  const definition = validDefinition();
  const policy = validPolicy();
  if (paired) {
    definition.experiment.sampling.pairingKey = '/input/cohort';
    definition.experiment.sampling.resamplingUnit = 'paired-block';
  }
  mutatePolicy?.(policy);
  return prepareEvaluationPlan(
    definition,
    policy,
    testRuntime({
      samplingResamplingUnits: paired ? ['paired-block'] : ['sample'],
    }),
  );
}

describe('ExecutionBundle RunPlan binding', () => {
  it('accepts a Bundle derived from the sealed coordinate plan', async () => {
    const plan = await makePlan();
    const bundle = makeBundle(plan);
    expect(parseExecutionBundle(bundle, plan)).toEqual(bundle);
  });

  it('rejects captured content above the sealed Execution evidence policy', async () => {
    const plan = await makePlan(false, (policy) => {
      policy.evidence.maximumClassification = 'public';
    });
    const bundle = mutableJson(makeBundle(plan));
    const record = bundle.records[0];
    if (record.executionStatus !== 'completed') throw new Error('unexpected record');
    record.output = {
      contentKind: 'inline',
      classification: 'secret',
      value: { answer: 'must-not-cross-policy' },
    };
    resign(bundle);

    expect(parseExecutionBundleDocument(bundle)).toEqual(bundle);
    expect(() => parseExecutionBundle(bundle, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_EVIDENCE_POLICY_INVALID' }),
    );
  });

  it('rejects replayed records that could not pass the sealed provider-cost audit', async () => {
    const plan = await makePlan(false, (policy) => {
      policy.budget.maxProviderCost = { amount: 10, currency: 'USD' };
      policy.cache.executionMode = 'transparent-deterministic';
    });
    const bundle = mutableJson(makeBundle(plan));
    for (const candidate of bundle.records.slice(1)) {
      if (candidate.executionStatus !== 'completed') throw new Error('unexpected record');
      setAttemptCost(candidate, 0.25);
    }
    const record = bundle.records[0];
    if (record.executionStatus !== 'completed') throw new Error('unexpected record');
    turnIntoCacheHit(record);
    resign(bundle);

    expect(parseExecutionBundleDocument(bundle)).toEqual(bundle);
    expect(() => parseExecutionBundle(bundle, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_CACHE_POLICY_INVALID' }),
    );

    const valid = mutableJson(makeBundle(plan));
    for (const candidate of valid.records) {
      if (candidate.executionStatus !== 'completed') throw new Error('unexpected record');
      setAttemptCost(candidate, 0.25);
    }
    const validRecord = valid.records[0];
    if (validRecord.executionStatus !== 'completed') throw new Error('unexpected record');
    turnIntoCacheHit(validRecord);
    resign(valid);
    expect(parseExecutionBundle(valid, plan)).toEqual(valid);
  });

  it('keeps unverified cache receipts and invocation budgets indeterminate', async () => {
    const plan = await makePlan(false, (policy) => {
      policy.cache.executionMode = 'transparent-deterministic';
      policy.budget.maxTargetInvocations = 1;
    });
    const bundle = mutableJson(makeBundle(plan));
    const sourceDigests = new Set<Sha256Digest>();
    for (const record of bundle.records) {
      if (record.executionStatus !== 'completed') throw new Error('unexpected record');
      sourceDigests.add(turnIntoCacheHit(record));
    }
    resign(bundle);

    const transported = verifyExecutionBundle(bundle, plan);
    expect(transported.planVerification).toEqual({
      cacheReceiptStatus: 'indeterminate',
      invocationBudgetStatus: 'indeterminate',
      providerCostBudgetStatus: 'verified',
      minimumTargetInvocations: 0,
      maximumTargetInvocations: bundle.records.length,
      unverifiedCacheRecordDigests: [...sourceDigests],
    });
    expect(verifyExecutionBundle(bundle, plan, {
      verifiedCacheRecordDigests: sourceDigests,
    }).planVerification).toMatchObject({
      cacheReceiptStatus: 'verified',
      invocationBudgetStatus: 'verified',
      minimumTargetInvocations: 0,
      maximumTargetInvocations: 0,
      unverifiedCacheRecordDigests: [],
    });
  });

  it('rejects a resealed cache claim with contradictory provenance or key', async () => {
    const plan = await makePlan(false, (policy) => {
      policy.cache.executionMode = 'transparent-deterministic';
    });
    const contradictory = mutableJson(makeBundle(plan));
    const first = contradictory.records[0];
    if (first.executionStatus !== 'completed') throw new Error('unexpected record');
    turnIntoCacheHit(first);
    first.provenance = {
      provenanceKind: 'native',
      trust: 'verified',
      parentDigests: [plan.execution.executionPlanDigest],
    };
    resign(contradictory);
    expect(() => parseExecutionBundle(contradictory, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_CACHE_POLICY_INVALID' }),
    );

    const wrongKey = mutableJson(makeBundle(plan));
    const wrongKeyRecord = wrongKey.records[0];
    if (wrongKeyRecord.executionStatus !== 'completed') throw new Error('unexpected record');
    turnIntoCacheHit(wrongKeyRecord);
    wrongKeyRecord.cache.cacheKeyDigest = `sha256:${'b'.repeat(64)}`;
    resign(wrongKey);
    expect(() => parseExecutionBundle(wrongKey, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_CACHE_POLICY_INVALID' }),
    );
  });

  it('audits native provider cost across the completed Bundle', async () => {
    const plan = await makePlan(false, (policy) => {
      policy.budget.maxProviderCost = { amount: 10, currency: 'USD' };
    });
    const missing = mutableJson(makeBundle(plan));
    resign(missing);
    expect(() => parseExecutionBundle(missing, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_PROVIDER_COST_INVALID' }),
    );

    const mixedCurrency = mutableJson(makeBundle(plan));
    for (const [index, record] of mixedCurrency.records.entries()) {
      if (record.executionStatus !== 'completed') throw new Error('unexpected record');
      setAttemptCost(record, 1, index === 0 ? 'USD' : 'EUR');
    }
    resign(mixedCurrency);
    expect(() => parseExecutionBundle(mixedCurrency, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_PROVIDER_COST_INVALID' }),
    );

    const exhausted = mutableJson(makeBundle(plan));
    for (const record of exhausted.records) {
      if (record.executionStatus !== 'completed') throw new Error('unexpected record');
      setAttemptCost(record, 6);
    }
    resign(exhausted);
    expect(() => parseExecutionBundle(exhausted, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_PROVIDER_COST_INVALID' }),
    );

    const valid = mutableJson(makeBundle(plan));
    for (const record of valid.records) {
      if (record.executionStatus !== 'completed') throw new Error('unexpected record');
      setAttemptCost(record, 4);
    }
    resign(valid);
    expect(verifyExecutionBundle(valid, plan).planVerification).toMatchObject({
      providerCostBudgetStatus: 'verified',
      minimumProviderCost: { amount: 4 * valid.records.length, currency: 'USD' },
      maximumProviderCost: { amount: 4 * valid.records.length, currency: 'USD' },
    });
  });

  it('uses replayed historical cost as eligibility evidence, not current spend', async () => {
    const plan = await makePlan(false, (policy) => {
      policy.cache.executionMode = 'transparent-deterministic';
      policy.budget.maxProviderCost = { amount: 10, currency: 'USD' };
    });
    const bundle = mutableJson(makeBundle(plan));
    const sourceDigests = new Set<Sha256Digest>();
    for (const record of bundle.records) {
      if (record.executionStatus !== 'completed') throw new Error('unexpected record');
      setAttemptCost(record, 6);
      sourceDigests.add(turnIntoCacheHit(record));
    }
    resign(bundle);

    expect(verifyExecutionBundle(bundle, plan).planVerification).toMatchObject({
      providerCostBudgetStatus: 'indeterminate',
      minimumProviderCost: { amount: 0, currency: 'USD' },
      maximumProviderCost: {
        amount: 6 * bundle.records.length,
        currency: 'USD',
      },
    });
    expect(verifyExecutionBundle(bundle, plan, {
      verifiedCacheRecordDigests: sourceDigests,
    }).planVerification).toMatchObject({
      providerCostBudgetStatus: 'verified',
      minimumProviderCost: { amount: 0, currency: 'USD' },
      maximumProviderCost: { amount: 0, currency: 'USD' },
    });
  });

  it('accepts a foreign origin with the same ExecutionPlan but rejects foreign coordinates', async () => {
    const plan = await makePlan();
    const foreignParent = mutableJson(makeBundle(plan));
    foreignParent.runContractDigest = `sha256:${'f'.repeat(64)}`;
    foreignParent.provenance.parentDigests = [
      foreignParent.runContractDigest,
      foreignParent.executionPlanDigest,
    ];
    resign(foreignParent);
    expect(parseExecutionBundleDocument(foreignParent)).toEqual(foreignParent);
    expect(parseExecutionBundle(foreignParent, plan)).toEqual(foreignParent);

    const foreignCoordinate = mutableJson(makeBundle(plan));
    const record = foreignCoordinate.records[0];
    record.sampleId = 'foreign-sample';
    record.trialId = deriveTrialId({
      executionPlanDigest: foreignCoordinate.executionPlanDigest as Sha256Digest,
      targetId: record.targetId,
      sampleId: record.sampleId,
      trialIndex: record.trialIndex,
    });
    if (record.executionStatus === 'budget-censored') throw new Error('unexpected record');
    record.attempts[0].attemptId = deriveAttemptId({
      trialId: record.trialId as Sha256Digest,
      attemptNumber: 1,
    });
    resign(foreignCoordinate);
    expect(parseExecutionBundleDocument(foreignCoordinate)).toEqual(foreignCoordinate);
    expect(() => parseExecutionBundle(foreignCoordinate, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_PLAN_MISMATCH' }),
    );
  });

  it('rejects an origin claim that is not bound by provenance', async () => {
    const plan = await makePlan();
    const bundle = mutableJson(makeBundle(plan));
    bundle.runContractDigest = `sha256:${'f'.repeat(64)}`;
    resign(bundle);

    expect(() => parseExecutionBundleDocument(bundle)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_PLAN_MISMATCH' }),
    );
  });

  it('rejects a forged block split that passes document-local validation', async () => {
    const plan = await makePlan(true);
    const bundle = mutableJson(makeBundle(plan));
    expect(bundle.records[0].schedulingBlockId).toBe(bundle.records[1].schedulingBlockId);
    const record = bundle.records[1];
    record.schedulingBlockId = `sha256:${'e'.repeat(64)}`;
    record.trialSeed = deriveTrialSeed({
      rootSeed: plan.execution.experiment.seed,
      seedCoupling: 'independent-by-target',
      schedulingBlockId: record.schedulingBlockId as Sha256Digest,
      sampleId: record.sampleId,
      targetId: record.targetId,
    });
    resign(bundle);
    expect(parseExecutionBundleDocument(bundle)).toEqual(bundle);
    expect(() => parseExecutionBundle(bundle, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_PLAN_MISMATCH' }),
    );
  });

  it('enforces sealed retry limits and retryable error codes', async () => {
    const plan = await makePlan();
    const tooMany = mutableJson(makeBundle(plan));
    const record = tooMany.records[0];
    if (record.executionStatus !== 'completed') throw new Error('unexpected record');
    const finalAttempt = record.attempts[0];
    const retryError = { code: 'timeout', stage: 'infrastructure' as const, message: 'retry' };
    record.attempts = [1, 2].map((attemptNumber) => ({
      attemptId: deriveAttemptId({
        trialId: record.trialId as Sha256Digest,
        attemptNumber,
      }),
      attemptNumber,
      attemptStatus: 'failed' as const,
      timing: { startedAt: '2026-08-28T00:00:00Z' },
      error: retryError,
    }));
    record.attempts.push({
      ...finalAttempt,
      attemptId: deriveAttemptId({
        trialId: record.trialId as Sha256Digest,
        attemptNumber: 3,
      }),
      attemptNumber: 3,
    });
    resign(tooMany);
    expect(parseExecutionBundleDocument(tooMany)).toEqual(tooMany);
    expect(() => parseExecutionBundle(tooMany, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_RETRY_POLICY_INVALID' }),
    );

    const notRetryable = mutableJson(makeBundle(plan));
    const notRetryableRecord = notRetryable.records[0];
    if (notRetryableRecord.executionStatus !== 'completed') throw new Error('unexpected record');
    notRetryableRecord.attempts.unshift({
      attemptId: deriveAttemptId({
        trialId: notRetryableRecord.trialId as Sha256Digest,
        attemptNumber: 1,
      }),
      attemptNumber: 1,
      attemptStatus: 'failed',
      timing: { startedAt: '2026-08-28T00:00:00Z' },
      error: { code: 'not-retryable', stage: 'execution', message: 'stop' },
    });
    notRetryableRecord.attempts[1].attemptNumber = 2;
    notRetryableRecord.attempts[1].attemptId = deriveAttemptId({
      trialId: notRetryableRecord.trialId as Sha256Digest,
      attemptNumber: 2,
    });
    resign(notRetryable);
    expect(() => parseExecutionBundle(notRetryable, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_RETRY_POLICY_INVALID' }),
    );
  });

  it('requires every coordinate in a censored paired block to be censored', async () => {
    const plan = await makePlan(true);
    const original = makeBundle(plan);
    const first = original.records[0];
    const censored: ExecutionRecord = {
      targetId: first.targetId,
      sampleId: first.sampleId,
      trialIndex: first.trialIndex,
      trialId: first.trialId,
      trialSeed: first.trialSeed,
      schedulingBlockId: first.schedulingBlockId,
      samplingUnitIds: first.samplingUnitIds,
      runtime: first.runtime,
      provenance: first.provenance,
      executionStatus: 'budget-censored',
      censorReasonCode: 'paired-block-budget-insufficient',
      censoredAt: '2026-08-28T00:00:00Z',
    };
    const partial = mutableJson(original);
    partial.executionBundleStatus = 'failed';
    partial.terminationReasonCode = 'materialization-failed';
    partial.coverage = {
      planned: 2,
      started: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      budgetCensored: 1,
      notStarted: 1,
    };
    partial.replayability = 'summary-only';
    partial.records = [censored];
    resign(partial);
    expect(parseExecutionBundleDocument(partial)).toEqual(partial);
    expect(() => parseExecutionBundle(partial, plan)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_BLOCK_ATOMICITY_INVALID' }),
    );
  });
});
