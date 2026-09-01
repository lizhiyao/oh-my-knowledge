import { describe, expect, it } from 'vitest';
import {
  ExecutionFactsSchema,
  ExecutionRecordSchema,
  digestCanonicalJson,
  projectExecutionFacts,
  type ExecutionRecord,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as Sha256Digest;

function activeRecord(
  executionStatus: 'completed' | 'failed' | 'cancelled' = 'completed',
): ExecutionRecord {
  const terminalAttempt = executionStatus === 'completed'
    ? {
        attemptId: digest('b'),
        attemptNumber: 2,
        attemptStatus: 'completed' as const,
        timing: {
          startedAt: '2026-08-31T00:00:00.200Z',
          completedAt: '2026-08-31T00:00:00.400Z',
        },
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          providerCost: { amount: 0.2, currency: 'USD', reportedByProvider: true as const },
        },
      }
    : {
        attemptId: digest('b'),
        attemptNumber: 2,
        attemptStatus: executionStatus,
        timing: {
          startedAt: '2026-08-31T00:00:00.200Z',
          completedAt: '2026-08-31T00:00:00.400Z',
          durationMs: 200,
        },
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          providerCost: { amount: 0.2, currency: 'USD', reportedByProvider: true as const },
        },
        error: { code: 'provider-failed', stage: 'execution' as const, message: 'private failure' },
      };
  return ExecutionRecordSchema.parse({
    targetId: 'target-a',
    randomizationSlotId: 'slot-a',
    sampleId: 'sample-a',
    trialIndex: 3,
    executionCoordinateDigest: digest('0'),
    trialId: digest('1'),
    trialSeed: digest('2'),
    schedulingBlockId: digest('3'),
    samplingUnitIds: {},
    runtime: {
      implementationId: 'executor-a/v1',
      fingerprint: 'executor-a-fingerprint',
      fingerprintBasis: 'content-derived',
      assuranceLevel: 'verified',
      capabilities: {},
      implementationManifest: { coverageKind: 'fingerprint-complete' },
    },
    provenance: {
      provenanceKind: 'native',
      trust: 'verified',
      parentDigests: [digest('4')],
    },
    attempts: [{
      attemptId: digest('a'),
      attemptNumber: 1,
      attemptStatus: 'failed',
      timing: {
        startedAt: '2026-08-31T00:00:00.000Z',
        completedAt: '2026-08-31T00:00:00.100Z',
        durationMs: 100,
      },
      usage: {
        inputTokens: 10,
        totalTokens: 11,
        providerCost: { amount: 0.1, currency: 'USD', reportedByProvider: true },
      },
      error: { code: 'timeout', stage: 'execution', message: 'secret retry detail' },
    }, terminalAttempt],
    timing: {
      startedAt: '2026-08-31T00:00:00.000Z',
      completedAt: '2026-08-31T00:00:00.500Z',
      durationMs: 500,
    },
    usage: {
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 36,
      providerCost: { amount: 0.3, currency: 'USD', reportedByProvider: true },
    },
    trace: {
      contentKind: 'inline',
      classification: 'secret',
      value: { privateTrace: 'must not escape' },
    },
    cache: { cacheStatus: 'miss', cacheKeyDigest: digest('5') },
    executionStatus,
    ...(executionStatus === 'completed' ? {
      output: {
        contentKind: 'inline',
        classification: 'sensitive',
        value: { privateAnswer: 'must not escape' },
      },
    } : {
      error: { code: 'provider-failed', stage: 'execution', message: 'private terminal failure' },
    }),
  });
}

describe('Execution facts projection', () => {
  it('projects complete source-bound facts without exposing output, trace, or errors', () => {
    const record = activeRecord();
    const projection = projectExecutionFacts(record, 'verified');

    expect(projection).toMatchObject({
      classification: 'secret',
      mediaType: 'application/vnd.omk.execution-facts+json',
      value: {
        sourceRecordDigest: digestCanonicalJson(record),
        coordinate: { trialIndex: 3 },
        terminal: { executionStatus: 'completed' },
        attemptCount: 2,
        retryCount: 1,
        timing: {
          activeDurationMs: { reportingStatus: 'partial', value: 100, reportedAttemptCount: 1 },
          wallClockDurationMs: { reportingStatus: 'reported', value: 500 },
        },
        usage: {
          usageRecordStatus: 'complete',
          inputTokens: { reportingStatus: 'reported', value: 30 },
          outputTokens: { reportingStatus: 'partial', value: 5, reportedAttemptCount: 1 },
          totalTokens: { reportingStatus: 'reported', value: 36 },
          providerCost: expect.objectContaining({
            reportingStatus: 'reported',
            currency: 'USD',
            reportedByProvider: true,
          }),
        },
        content: {
          output: { captureStatus: 'inline', classification: 'sensitive' },
          trace: { captureStatus: 'inline', classification: 'secret' },
        },
      },
    });
    expect(projection.value.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        attemptStatus: 'failed',
        activeDurationMs: { reportingStatus: 'reported', value: 100 },
      }),
      expect.objectContaining({
        attemptNumber: 2,
        attemptStatus: 'completed',
        activeDurationMs: { reportingStatus: 'unreported' },
      }),
    ]);
    const cost = projection.value.usage.providerCost;
    if (cost.reportingStatus !== 'reported') throw new Error('expected reported cost');
    expect(cost.amount).toBeCloseTo(0.3);
    expect(JSON.stringify(projection)).not.toContain('must not escape');
    expect(JSON.stringify(projection)).not.toContain('private failure');
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.value.usage)).toBe(true);
    expect(projectExecutionFacts(structuredClone(record), 'verified')).toEqual(projection);
  });

  it('distinguishes partial, mixed-currency, and unreported provider cost', () => {
    const partial = activeRecord();
    if (partial.executionStatus === 'budget-censored') throw new Error('unexpected record');
    delete partial.attempts[1].usage?.providerCost;
    expect(projectExecutionFacts(partial, 'verified').value.usage.providerCost).toEqual({
      reportingStatus: 'partial',
      reportedAttemptCount: 1,
    });

    const mixed = activeRecord();
    if (mixed.executionStatus === 'budget-censored') throw new Error('unexpected record');
    const mixedCost = mixed.attempts[1].usage?.providerCost;
    if (mixedCost === undefined) throw new Error('missing cost');
    mixedCost.currency = 'EUR';
    expect(projectExecutionFacts(mixed, 'verified').value.usage.providerCost).toEqual({
      reportingStatus: 'mixed-currency',
      currencies: ['EUR', 'USD'],
    });

    const unreported = activeRecord();
    if (unreported.executionStatus === 'budget-censored') throw new Error('unexpected record');
    for (const attempt of unreported.attempts) delete attempt.usage?.providerCost;
    expect(projectExecutionFacts(unreported, 'verified').value.usage.providerCost).toEqual({
      reportingStatus: 'unreported',
    });
  });

  it('reports referenced, digest-only, and missing captures without opening content', () => {
    const captured = activeRecord();
    if (captured.executionStatus !== 'completed') throw new Error('unexpected record');
    captured.output = {
      contentKind: 'descriptor',
      classification: 'sensitive',
      descriptor: {
        mediaType: 'application/json',
        digest: digest('6'),
        uri: 'https://example.com/output/6',
      },
    };
    captured.trace = {
      contentKind: 'digest-only',
      classification: 'gold',
      digest: digest('7'),
    };
    captured.provenance.trust = 'declared';

    expect(projectExecutionFacts(captured, 'unknown')).toMatchObject({
      classification: 'gold',
      value: {
        content: {
          output: { captureStatus: 'descriptor', classification: 'sensitive' },
          trace: { captureStatus: 'digest-only', classification: 'gold' },
        },
        sourceProvenance: { provenanceKind: 'native', effectiveTrust: 'unknown' },
      },
    });

    const missing = activeRecord();
    if (missing.executionStatus !== 'completed') throw new Error('unexpected record');
    delete missing.output;
    delete missing.trace;
    expect(projectExecutionFacts(missing, 'verified').value.content).toEqual({
      output: { captureStatus: 'absent' },
      trace: { captureStatus: 'absent' },
    });
  });

  it.each(['failed', 'cancelled'] as const)(
    'retains %s terminal facts while excluding failure details',
    (executionStatus) => {
      const projection = projectExecutionFacts(activeRecord(executionStatus), 'verified');
      expect(projection.value.terminal).toEqual({ executionStatus });
      expect(projection.value.content.output).toEqual({ captureStatus: 'absent' });
      expect(JSON.stringify(projection)).not.toContain('private terminal failure');
    },
  );

  it('projects budget censorship as a public, zero-attempt terminal fact', () => {
    const record = ExecutionRecordSchema.parse({
      targetId: 'target-a',
      randomizationSlotId: 'slot-a',
      sampleId: 'sample-a',
      trialIndex: 0,
      executionCoordinateDigest: digest('0'),
      trialId: digest('1'),
      trialSeed: digest('2'),
      schedulingBlockId: digest('3'),
      samplingUnitIds: {},
      runtime: {
        implementationId: 'executor-a/v1',
        fingerprint: 'executor-a-fingerprint',
        fingerprintBasis: 'content-derived',
        assuranceLevel: 'verified',
        capabilities: {},
        implementationManifest: { coverageKind: 'fingerprint-complete' },
      },
      provenance: {
        provenanceKind: 'native',
        trust: 'verified',
        parentDigests: [digest('4')],
      },
      executionStatus: 'budget-censored',
      censorReasonCode: 'run-budget-exhausted',
      censoredAt: '2026-08-31T00:00:00Z',
    });

    expect(projectExecutionFacts(record, 'verified')).toMatchObject({
      classification: 'public',
      value: {
        terminal: {
          executionStatus: 'budget-censored',
          censorReasonCode: 'run-budget-exhausted',
        },
        attemptCount: 0,
        retryCount: 0,
        attempts: [],
        cacheStatus: 'not-applicable',
      },
    });
  });

  it('rejects inconsistent censor, attempt-count, numbering, and terminal facts', () => {
    const valid = projectExecutionFacts(activeRecord(), 'verified').value;
    const cases = [
      { ...structuredClone(valid), attemptCount: 0 },
      { ...structuredClone(valid), retryCount: 0 },
      {
        ...structuredClone(valid),
        attempts: valid.attempts.map((attempt, index) => (
          index === 0 ? { ...attempt, attemptNumber: 2 } : attempt
        )),
      },
      {
        ...structuredClone(valid),
        terminal: { executionStatus: 'failed' as const },
      },
      {
        ...structuredClone(valid),
        terminal: {
          executionStatus: 'completed' as const,
          censorReasonCode: 'unexpected-censor',
        },
      },
      {
        ...structuredClone(valid),
        attempts: valid.attempts.map((attempt, index) => (
          index === 0 ? { ...attempt, attemptStatus: 'completed' as const } : attempt
        )),
      },
      {
        ...structuredClone(valid),
        attempts: valid.attempts.map((attempt, index) => (
          index === 0
            ? {
                ...attempt,
                usageReportingStatus: 'unreported' as const,
                providerCostReportingStatus: 'reported' as const,
              }
            : attempt
        )),
      },
      {
        ...structuredClone(valid),
        usage: { ...valid.usage, usageRecordStatus: 'absent' as const },
      },
      {
        ...structuredClone(valid),
        usage: {
          ...valid.usage,
          providerCost: { reportingStatus: 'unreported' as const },
        },
      },
      {
        ...structuredClone(valid),
        usage: {
          ...valid.usage,
          outputTokens: {
            reportingStatus: 'partial' as const,
            value: 5,
            reportedAttemptCount: 2,
          },
        },
      },
    ];

    for (const facts of cases) expect(ExecutionFactsSchema.safeParse(facts).success).toBe(false);
  });

  it('rejects an effective trust level above the source record ceiling', () => {
    const record = activeRecord();
    record.provenance.trust = 'declared';

    expect(() => projectExecutionFacts(record, 'verified')).toThrow(/exceeds its source record trust/);
    expect(projectExecutionFacts(record, 'unknown').value.sourceProvenance).toEqual({
      provenanceKind: 'native',
      effectiveTrust: 'unknown',
    });
  });
});
