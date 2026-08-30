import { describe, expect, it } from 'vitest';
import {
  EXECUTION_BUNDLE_SCHEMA_VERSION,
  CensoredExecutionRecordSchema,
  CompletedExecutionRecordSchema,
  ExecutionAttemptSchema,
  ExecutionBundleValidationError,
  deriveAttemptId,
  deriveTrialId,
  digestArtifactPayload,
  parseExecutionBundleDocument,
  type CapturedContent,
  type ExecutionBundle,
  type ExecutionRecord,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';

const runContractDigest = `sha256:${'1'.repeat(64)}` as Sha256Digest;
const executionPlanDigest = `sha256:${'2'.repeat(64)}` as Sha256Digest;
const datasetRevisionDigest = `sha256:${'3'.repeat(64)}` as Sha256Digest;
const executionInputDigest = `sha256:${'4'.repeat(64)}` as Sha256Digest;
const trialSeed = `sha256:${'5'.repeat(64)}` as Sha256Digest;
const schedulingBlockId = `sha256:${'6'.repeat(64)}` as Sha256Digest;
const contentDigest = `sha256:${'7'.repeat(64)}` as Sha256Digest;
const placeholderDigest = `sha256:${'0'.repeat(64)}` as Sha256Digest;

const provenance = {
  provenanceKind: 'native' as const,
  trust: 'verified' as const,
  parentDigests: [executionPlanDigest],
};

const bundleProvenance = {
  provenanceKind: 'native' as const,
  trust: 'verified' as const,
  parentDigests: [runContractDigest, executionPlanDigest],
};

const runtime = {
  implementationId: 'executor-a',
  fingerprint: 'executor-a@1',
  fingerprintBasis: 'content-derived' as const,
  assuranceLevel: 'verified' as const,
  capabilities: {},
  implementationManifest: { coverageKind: 'fingerprint-complete' as const },
};

function makeCompletedRecord(
  targetId = 'target-a',
  sampleId = 'sample-a',
  output: CapturedContent | undefined = {
      contentKind: 'inline',
      classification: 'public',
      value: { answer: 42 },
    },
): ExecutionRecord {
  const trialId = deriveTrialId({
    executionPlanDigest,
    targetId,
    sampleId,
    trialIndex: 0,
  });
  return {
    targetId,
    randomizationSlotId: `slot-${targetId}`,
    sampleId,
    trialIndex: 0,
    trialId,
    trialSeed,
    schedulingBlockId,
    samplingUnitIds: {},
    runtime,
    provenance,
    attempts: [{
      attemptId: deriveAttemptId({ trialId, attemptNumber: 1 }),
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
    cache: { cacheStatus: 'not-used' },
    executionStatus: 'completed',
    ...(output === undefined ? {} : { output }),
  };
}

function finalizeBundle(
  overrides: Partial<ExecutionBundle> = {},
): ExecutionBundle {
  const bundle: ExecutionBundle = {
    schemaVersion: EXECUTION_BUNDLE_SCHEMA_VERSION,
    bundleId: 'bundle-a',
    runContractDigest,
    executionPlanDigest,
    datasetRevisionDigest,
    executionInputDigest,
    executionBundleStatus: 'completed',
    coverage: {
      planned: 1,
      started: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      budgetCensored: 0,
      notStarted: 0,
    },
    replayability: 'self-contained',
    records: [makeCompletedRecord()],
    provenance: bundleProvenance,
    bundleDigest: placeholderDigest,
    ...overrides,
  };
  bundle.bundleDigest = digestArtifactPayload(bundle, 'bundleDigest');
  return bundle;
}

function resign(bundle: ExecutionBundle): ExecutionBundle {
  bundle.bundleDigest = digestArtifactPayload(bundle, 'bundleDigest');
  return bundle;
}

describe('ExecutionBundle contract', () => {
  it('accepts a canonical self-contained completed bundle', () => {
    const bundle = finalizeBundle();
    expect(parseExecutionBundleDocument(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
  });

  it('requires a one-to-one Target and randomization slot mapping within the Bundle', () => {
    const first = makeCompletedRecord('target-a', 'sample-a');
    const conflictingTarget = makeCompletedRecord('target-a', 'sample-b');
    conflictingTarget.randomizationSlotId = 'slot-forged';
    const duplicateSlot = makeCompletedRecord('target-b', 'sample-a');
    duplicateSlot.randomizationSlotId = first.randomizationSlotId;

    for (const records of [[first, conflictingTarget], [first, duplicateSlot]]) {
      const bundle = finalizeBundle({
        coverage: {
          planned: 2,
          started: 2,
          succeeded: 2,
          failed: 0,
          cancelled: 0,
          budgetCensored: 0,
          notStarted: 0,
        },
        records,
      });
      expect(() => parseExecutionBundleDocument(bundle)).toThrowError(
        expect.objectContaining({ code: 'EXECUTION_BUNDLE_RANDOMIZATION_SLOT_INVALID' }),
      );
    }
  });

  it('keeps summary-only output omission distinct from execution failure', () => {
    const record = makeCompletedRecord();
    if (record.executionStatus !== 'completed') throw new Error('unexpected record');
    delete record.output;
    const bundle = finalizeBundle({
      replayability: 'summary-only',
      records: [record],
    });
    expect(parseExecutionBundleDocument(bundle).records[0]).not.toHaveProperty('output');
  });

  it('requires replayable output to be inline or resolvable as declared', () => {
    const digestOnly = finalizeBundle({
      records: [makeCompletedRecord('target-a', 'sample-a', {
        contentKind: 'digest-only',
        classification: 'public',
        digest: contentDigest,
      })],
    });
    expect(() => parseExecutionBundleDocument(digestOnly)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_REPLAYABILITY_INVALID' }),
    );

    const resolvable = finalizeBundle({
      replayability: 'resolvable',
      records: [makeCompletedRecord('target-a', 'sample-a', {
        contentKind: 'descriptor',
        classification: 'public',
        descriptor: {
          mediaType: 'application/json',
          digest: contentDigest,
          uri: 'https://example.com/content/7',
        },
      })],
    });
    expect(parseExecutionBundleDocument(resolvable)).toEqual(resolvable);
  });

  it('applies replayability to traces from failed and cancelled executions', () => {
    const completed = makeCompletedRecord('target-a', 'sample-a');
    const trialId = deriveTrialId({
      executionPlanDigest,
      targetId: 'target-b',
      sampleId: 'sample-a',
      trialIndex: 0,
    });
    const error = { code: 'provider-error', stage: 'execution' as const, message: 'failed' };
    const failed: ExecutionRecord = {
      targetId: 'target-b',
      randomizationSlotId: 'slot-target-b',
      sampleId: 'sample-a',
      trialIndex: 0,
      trialId,
      trialSeed,
      schedulingBlockId,
      samplingUnitIds: {},
      runtime,
      provenance,
      attempts: [{
        attemptId: deriveAttemptId({ trialId, attemptNumber: 1 }),
        attemptNumber: 1,
        attemptStatus: 'failed',
        timing: { startedAt: '2026-08-28T00:00:00Z' },
        error,
      }],
      timing: { startedAt: '2026-08-28T00:00:00Z' },
      trace: {
        contentKind: 'digest-only',
        classification: 'public',
        digest: contentDigest,
      },
      cache: { cacheStatus: 'not-used' },
      executionStatus: 'failed',
      error,
    };
    const bundle = finalizeBundle({
      coverage: {
        planned: 2,
        started: 2,
        succeeded: 1,
        failed: 1,
        cancelled: 0,
        budgetCensored: 0,
        notStarted: 0,
      },
      records: [completed, failed],
    });
    expect(() => parseExecutionBundleDocument(bundle)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_REPLAYABILITY_INVALID' }),
    );
  });

  it('models budget censoring without pretending an attempt started', () => {
    const trialId = deriveTrialId({
      executionPlanDigest,
      targetId: 'target-a',
      sampleId: 'sample-a',
      trialIndex: 0,
    });
    const censored: ExecutionRecord = {
      targetId: 'target-a',
      randomizationSlotId: 'slot-target-a',
      sampleId: 'sample-a',
      trialIndex: 0,
      trialId,
      trialSeed,
      schedulingBlockId,
      samplingUnitIds: {},
      runtime,
      provenance,
      executionStatus: 'budget-censored',
      censorReasonCode: 'paired-block-budget-insufficient',
      censoredAt: '2026-08-28T00:00:00Z',
    };
    const bundle = finalizeBundle({
      executionBundleStatus: 'budget-exhausted',
      terminationReasonCode: 'target-invocation-limit',
      coverage: {
        planned: 1,
        started: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        budgetCensored: 1,
        notStarted: 0,
      },
      replayability: 'summary-only',
      records: [censored],
    });
    expect(parseExecutionBundleDocument(bundle)).toEqual(bundle);
    expect(CensoredExecutionRecordSchema.safeParse({
      ...censored,
      attempts: [],
    }).success).toBe(false);
    const completed = makeCompletedRecord();
    expect(CompletedExecutionRecordSchema.safeParse({
      ...completed,
      attempts: [],
    }).success).toBe(false);
    const attempt = completed.executionStatus === 'completed'
      ? completed.attempts[0]
      : undefined;
    expect(ExecutionAttemptSchema.safeParse({
      ...attempt,
      attemptStatus: 'completed',
      error: { code: 'stale-error', stage: 'execution', message: 'stale' },
    }).success).toBe(false);
    expect(ExecutionAttemptSchema.safeParse({
      ...attempt,
      attemptStatus: 'failed',
    }).success).toBe(false);
    expect(ExecutionAttemptSchema.safeParse({
      ...attempt,
      usage: {
        inputTokens: 1,
        providerCost: { amount: 0.01, currency: 'USD', reportedByProvider: true },
      },
    }).success).toBe(true);
  });

  it('rejects a scheduling block split between active and budget-censored records', () => {
    const active = makeCompletedRecord('target-a', 'sample-a');
    const trialId = deriveTrialId({
      executionPlanDigest,
      targetId: 'target-b',
      sampleId: 'sample-a',
      trialIndex: 0,
    });
    const censored: ExecutionRecord = {
      targetId: 'target-b',
      randomizationSlotId: 'slot-target-b',
      sampleId: 'sample-a',
      trialIndex: 0,
      trialId,
      trialSeed,
      schedulingBlockId,
      samplingUnitIds: {},
      runtime,
      provenance,
      executionStatus: 'budget-censored',
      censorReasonCode: 'paired-block-budget-insufficient',
      censoredAt: '2026-08-28T00:00:00Z',
    };
    const bundle = finalizeBundle({
      executionBundleStatus: 'budget-exhausted',
      terminationReasonCode: 'target-invocation-limit',
      coverage: {
        planned: 2,
        started: 1,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        budgetCensored: 1,
        notStarted: 0,
      },
      replayability: 'summary-only',
      records: [active, censored],
    });
    expect(() => parseExecutionBundleDocument(bundle)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_BLOCK_ATOMICITY_INVALID' }),
    );
  });

  it('allows budget exhaustion during the final started trial without synthetic censoring', () => {
    const bundle = finalizeBundle({
      executionBundleStatus: 'budget-exhausted',
      terminationReasonCode: 'provider-cost-budget-exhausted',
    });
    expect(parseExecutionBundleDocument(bundle)).toEqual(bundle);
  });

  it('rejects coverage and terminal-state contradictions', () => {
    const bundle = finalizeBundle({
      coverage: {
        planned: 2,
        started: 1,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        budgetCensored: 0,
        notStarted: 1,
      },
    });
    expect(() => parseExecutionBundleDocument(bundle)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_STATUS_INVALID' }),
    );
  });

  it('rejects non-canonical coordinates and duplicate trials', () => {
    const records = [
      makeCompletedRecord('target-b', 'sample-a'),
      makeCompletedRecord('target-a', 'sample-a'),
    ];
    const bundle = finalizeBundle({
      coverage: {
        planned: 2,
        started: 2,
        succeeded: 2,
        failed: 0,
        cancelled: 0,
        budgetCensored: 0,
        notStarted: 0,
      },
      records,
    });
    expect(() => parseExecutionBundleDocument(bundle)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_RECORD_ORDER_INVALID' }),
    );

    const duplicate = resign(structuredClone(bundle));
    duplicate.records = [records[1], records[1]];
    resign(duplicate);
    expect(() => parseExecutionBundleDocument(duplicate)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_DUPLICATE_COORDINATE' }),
    );
  });

  it('verifies derived trial and attempt identities and attempt order', () => {
    const bundle = structuredClone(finalizeBundle());
    const record = bundle.records[0];
    if (record.executionStatus === 'budget-censored') throw new Error('unexpected record');
    record.attempts[0].attemptNumber = 2;
    resign(bundle);
    expect(() => parseExecutionBundleDocument(bundle)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID' }),
    );

    const repeatedSuccess = structuredClone(finalizeBundle());
    const repeatedRecord = repeatedSuccess.records[0];
    if (repeatedRecord.executionStatus !== 'completed') throw new Error('unexpected record');
    repeatedRecord.attempts.push({
      attemptId: deriveAttemptId({ trialId: repeatedRecord.trialId as Sha256Digest, attemptNumber: 2 }),
      attemptNumber: 2,
      attemptStatus: 'completed',
      timing: { startedAt: '2026-08-28T00:00:02Z' },
    });
    resign(repeatedSuccess);
    expect(() => parseExecutionBundleDocument(repeatedSuccess)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID' }),
    );
  });

  it('rejects aggregate usage that contradicts attempt facts', () => {
    const bundle = structuredClone(finalizeBundle());
    const record = bundle.records[0];
    if (record.executionStatus === 'budget-censored') throw new Error('unexpected record');
    record.usage = {
      inputTokens: 999,
      details: { aggregationKind: 'forged' },
    };
    resign(bundle);

    expect(() => parseExecutionBundleDocument(bundle)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_USAGE_INVALID' }),
    );
  });

  it('rejects a stale artifact digest after payload mutation', () => {
    const bundle = finalizeBundle();
    bundle.bundleId = 'mutated-bundle';
    expect(() => parseExecutionBundleDocument(bundle)).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_BUNDLE_DIGEST_MISMATCH' }),
    );
    expect(() => parseExecutionBundleDocument(bundle)).toThrow(ExecutionBundleValidationError);
  });
});
