import { describe, expect, it } from 'vitest';
import {
  digestArtifactPayload,
  digestCanonicalJson,
  parseAnalysisBundle,
  parseEvaluationBundle,
  parseEvaluationReport,
  verifyDecisionResult,
  verifyExecutionBundle,
} from '../../../src/evaluation-core/contracts/index.js';
import { createBuiltinAnalysisSchemaValidators } from '../../../src/evaluation-core/analysis/index.js';
import { ConformanceFaultInjector } from './fault-injector.js';
import {
  InMemoryConformanceArtifactStore,
  InMemoryConformanceEvaluationCache,
  InMemoryConformanceExecutionCache,
  runConformanceScenario,
} from './harness.js';

describe('Evaluation Core artifact and replay conformance', () => {
  it('replays RAG output captured by reference through a digest-checking ContentResolver', async () => {
    const faults = new ConformanceFaultInjector();
    const store = new InMemoryConformanceArtifactStore(faults);
    const result = await runConformanceScenario('rag', {
      suffix: 'rag-reference',
      faults,
      artifactStore: store,
      mutate(_definition, policy) {
        policy.evidence.output = 'reference';
      },
    });

    expect(result.execution.replayability).toBe('resolvable');
    expect(result.execution.records.every((record) => (
      record.executionStatus === 'completed'
      && record.output !== undefined
      && record.output.contentKind === 'descriptor'
    ))).toBe(true);
    expect(result.evaluation.evaluationBundleStatus).toBe('completed');
    expect(faults.count('content-put')).toBe(4);
    expect(faults.count('content-resolve')).toBe(4);
  });

  it('reports unavailable evidence honestly when reference resolution is not injected', async () => {
    const result = await runConformanceScenario('rag', {
      suffix: 'rag-reference-unresolved',
      provideContentResolver: false,
      mutate(_definition, policy) {
        policy.evidence.output = 'reference';
      },
    });

    expect(result.execution.replayability).toBe('resolvable');
    expect(result.evaluation.coverage).toMatchObject({
      eligible: 0,
      sourceUnavailable: 4,
      started: 0,
    });
    expect(result.decision?.decisionStatus).toBe('not-decided');
  });

  it('rejects digest-only capture when an Evaluator requires the output value', async () => {
    await expect(runConformanceScenario('rag', {
      suffix: 'rag-digest-only',
      mutate(_definition, policy) {
        policy.evidence.output = 'digest';
      },
    })).rejects.toMatchObject({
      code: 'EVAL_DEFINITION_POLICY_INVALID',
      stage: 'configuration',
    });
  });

  it('contains ContentResolver failure without leaking provider errors', async () => {
    const marker = 'artifact-store-secret';
    const faults = new ConformanceFaultInjector().fail('content-resolve', marker);
    const result = await runConformanceScenario('rag', {
      suffix: 'resolver-fault',
      faults,
      mutate(_definition, policy) {
        policy.evidence.output = 'reference';
      },
    });

    expect(result.evaluation.evaluationBundleStatus).toBe('failed');
    expect(JSON.stringify(result.evaluation)).not.toContain(marker);
    expect(JSON.stringify(result.report)).not.toContain(marker);
  });

  it('fails the stage atomically when ContentResolver stops midway through binding closure', async () => {
    const marker = 'midstream-resolver-secret';
    const faults = new ConformanceFaultInjector();
    const store = new InMemoryConformanceArtifactStore(faults);
    const source = await runConformanceScenario('rag', {
      suffix: 'midstream-resolver-source',
      faults,
      artifactStore: store,
      mutate(_definition, policy) { policy.evidence.output = 'reference'; },
    });
    faults.fail('content-resolve', marker, faults.count('content-resolve') + 2);

    const result = await runConformanceScenario('rag', {
      suffix: 'midstream-resolver-failure',
      execution: source.execution,
      faults,
      artifactStore: store,
      mutate(_definition, policy) { policy.evidence.output = 'reference'; },
    });

    expect(result.evaluation.evaluationBundleStatus).toBe('failed');
    expect(result.state.evaluatorAttempts).toBe(0);
    expect(result.decision?.decisionStatus).toBe('not-decided');
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it.each(['digest', 'classification'] as const)(
    'rejects ContentResolver %s mismatch before invoking an Evaluator',
    async (mismatch) => {
      const store = new InMemoryConformanceArtifactStore();
      const source = await runConformanceScenario('rag', {
        suffix: `resolver-${mismatch}-source`,
        artifactStore: store,
        mutate(_definition, policy) { policy.evidence.output = 'reference'; },
      });
      const descriptor = source.execution.records.find((record) => (
        record.executionStatus === 'completed'
        && record.output?.contentKind === 'descriptor'
      ));
      if (descriptor?.executionStatus !== 'completed'
          || descriptor.output?.contentKind !== 'descriptor') {
        throw new Error('Expected a referenced execution output.');
      }
      const original = await store.resolve(descriptor.output.descriptor);
      store.tamper(descriptor.output.descriptor.digest, mismatch === 'digest'
        ? {
          value: { documents: ['forged-document'] },
          classification: descriptor.output.classification,
          mediaType: descriptor.output.descriptor.mediaType,
        }
        : {
          ...original,
          classification: 'secret',
        });

      const result = await runConformanceScenario('rag', {
        suffix: `resolver-${mismatch}-rejected`,
        execution: source.execution,
        artifactStore: store,
        mutate(_definition, policy) { policy.evidence.output = 'reference'; },
      });

      expect(result.evaluation.evaluationBundleStatus).toBe('failed');
      expect(result.state.evaluatorAttempts).toBe(0);
      expect(result.decision?.decisionStatus).toBe('not-decided');
      expect(JSON.stringify(result.report)).not.toContain('forged-document');
    },
  );

  it('contains ContentStore failure and does not cache an unmaterialized output', async () => {
    const faults = new ConformanceFaultInjector().fail('content-put');
    const cache = new InMemoryConformanceExecutionCache(faults);
    const result = await runConformanceScenario('rag', {
      suffix: 'content-put-failure',
      faults,
      executionCache: cache,
      mutate(_definition, policy) {
        policy.evidence.output = 'reference';
        policy.cache.executionMode = 'transparent-deterministic';
      },
    });

    expect(result.execution).toMatchObject({
      executionBundleStatus: 'failed',
      terminationReasonCode: 'content-materialization-failed',
    });
    expect(cache.size).toBe(0);
    expect(result.decision?.decisionStatus).toBe('not-decided');
  });

  it.each(['cache-get', 'cache-put'] as const)(
    'contains Execution %s failure at the cache boundary',
    async (boundary) => {
      const faults = new ConformanceFaultInjector().fail(boundary);
      const cache = new InMemoryConformanceExecutionCache(faults);
      const result = await runConformanceScenario('function', {
        suffix: `execution-${boundary}`,
        faults,
        executionCache: cache,
        mutate(_definition, policy) {
          policy.cache.executionMode = 'transparent-deterministic';
        },
      });

      expect(result.execution).toMatchObject({
        executionBundleStatus: 'failed',
        terminationReasonCode: boundary === 'cache-get'
          ? 'execution-cache-read-failed'
          : 'execution-cache-write-failed',
      });
      expect(result.decision?.decisionStatus).toBe('not-decided');
      expect(faults.count(boundary)).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(['cache-get', 'cache-put'] as const)(
    'contains Evaluation %s failure at the cache boundary',
    async (boundary) => {
      const source = await runConformanceScenario('function', {
        suffix: `evaluation-${boundary}-source`,
      });
      const faults = new ConformanceFaultInjector().fail(boundary);
      const cache = new InMemoryConformanceEvaluationCache(faults);
      const result = await runConformanceScenario('function', {
        suffix: `evaluation-${boundary}`,
        execution: source.execution,
        faults,
        evaluationCache: cache,
        mutate(_definition, policy) { policy.cache.evaluationMode = 'reuse'; },
      });

      expect(result.evaluation).toMatchObject({
        evaluationBundleStatus: 'failed',
        terminationReasonCode: boundary === 'cache-get'
          ? 'evaluation-cache-read-failed'
          : 'evaluation-cache-write-failed',
      });
      expect(result.decision?.decisionStatus).toBe('not-decided');
      expect(faults.count(boundary)).toBeGreaterThanOrEqual(1);
    },
  );

  it('reuses Execution cache without increasing Target invocation count', async () => {
    const cache = new InMemoryConformanceExecutionCache();
    const first = await runConformanceScenario('function', {
      suffix: 'execution-cache-first',
      executionCache: cache,
      mutate(_definition, policy) {
        policy.cache.executionMode = 'transparent-deterministic';
      },
    });
    const replay = await runConformanceScenario('function', {
      suffix: 'execution-cache-replay',
      executionCache: cache,
      mutate(_definition, policy) {
        policy.cache.executionMode = 'transparent-deterministic';
      },
    });

    expect(first.state.executorAttempts).toBe(4);
    expect(replay.state.executorAttempts).toBe(0);
    expect(replay.execution.records.every((record) => (
      record.executionStatus === 'completed'
      && record.cache.cacheStatus === 'transparent-hit'
    ))).toBe(true);
    const transportedExecutionSource = verifyExecutionBundle(replay.execution, replay.plan);
    expect(transportedExecutionSource.planVerification).toMatchObject({
      provenanceTrustStatus: 'indeterminate',
      cacheReceiptStatus: 'indeterminate',
      minimumTargetInvocations: 0,
      maximumTargetInvocations: 4,
    });
    expect(replay.executionSource.planVerification).toMatchObject({
      provenanceTrustStatus: 'verified',
      cacheReceiptStatus: 'verified',
      minimumTargetInvocations: 0,
      maximumTargetInvocations: 0,
    });
    expect(replay.analysis.records[0]).toMatchObject({
      analysisStatus: 'completed',
      coverage: { planned: 4, included: 4 },
    });

    const transported = await runConformanceScenario('function', {
      suffix: 'execution-cache-transported',
      plan: replay.plan,
      execution: structuredClone(replay.execution),
    });
    expect(transported.decision).toMatchObject({
      decisionStatus: 'not-decided',
      reasonCodes: expect.arrayContaining([
        'decision-execution-cache-receipt-indeterminate',
        'decision-execution-provenance-indeterminate',
      ]),
    });
    expect(transported.report).toMatchObject({
      status: { conclusionStatus: 'inconclusive' },
      provenance: { trust: 'unknown' },
    });
    const forgedTransportedReport = structuredClone(transported.report);
    forgedTransportedReport.provenance.trust = 'verified';
    forgedTransportedReport.reportDigest = digestArtifactPayload(
      forgedTransportedReport,
      'reportDigest',
    );
    expect(() => parseEvaluationReport(
      forgedTransportedReport,
      transported.plan,
      transported.executionSource,
      transported.evaluationSource,
      transported.analysisSource,
      transported.decisionSource,
    )).toThrowError(expect.objectContaining({
      code: 'EVALUATION_REPORT_PROVENANCE_INVALID',
    }));

    const transportedEvaluationSource = parseEvaluationBundle(
      structuredClone(replay.evaluation),
      replay.plan,
      transportedExecutionSource,
    );
    const transportedAnalysisSource = parseAnalysisBundle(
      structuredClone(replay.analysis),
      replay.plan,
      transportedExecutionSource,
      transportedEvaluationSource,
      { schemaValidators: createBuiltinAnalysisSchemaValidators() },
    );
    expect(() => verifyDecisionResult(
      structuredClone(replay.decision),
      replay.plan,
      transportedExecutionSource,
      transportedEvaluationSource,
      transportedAnalysisSource,
    )).toThrowError(expect.objectContaining({
      code: 'DECISION_RESULT_VERIFICATION_GATE_FAILED',
    }));
  });

  it('invalidates Execution cache when sealed output capture policy changes', async () => {
    const cache = new InMemoryConformanceExecutionCache();
    const full = await runConformanceScenario('function', {
      suffix: 'execution-cache-full-policy',
      executionCache: cache,
      mutate(_definition, policy) {
        policy.cache.executionMode = 'transparent-deterministic';
        policy.evidence.output = 'full';
      },
    });
    const reference = await runConformanceScenario('function', {
      suffix: 'execution-cache-reference-policy',
      executionCache: cache,
      mutate(_definition, policy) {
        policy.cache.executionMode = 'transparent-deterministic';
        policy.evidence.output = 'reference';
      },
    });

    expect(reference.plan.digests.executionPlanDigest).not.toBe(
      full.plan.digests.executionPlanDigest,
    );
    expect(reference.state.executorAttempts).toBe(4);
    expect(reference.execution.records.every((record) => (
      record.executionStatus === 'completed'
      && record.output?.contentKind === 'descriptor'
      && record.cache.cacheStatus === 'miss'
    ))).toBe(true);
    expect(cache.size).toBe(8);
  });

  it('fails closed on an Execution replay-only cache miss', async () => {
    const cache = new InMemoryConformanceExecutionCache();
    const result = await runConformanceScenario('function', {
      suffix: 'execution-replay-only-miss',
      executionCache: cache,
      mutate(_definition, policy) { policy.cache.executionMode = 'replay-only'; },
    });

    expect(result.execution).toMatchObject({
      executionBundleStatus: 'failed',
      terminationReasonCode: 'execution-cache-miss',
      coverage: { started: 0, notStarted: 4 },
    });
    expect(result.state.executorAttempts).toBe(0);
    expect(result.decision?.decisionStatus).toBe('not-decided');
  });

  it('reuses Evaluation cache against the same ExecutionBundle without invoking Evaluators', async () => {
    const source = await runConformanceScenario('function', { suffix: 'evaluation-cache-source' });
    const cache = new InMemoryConformanceEvaluationCache();
    const first = await runConformanceScenario('function', {
      suffix: 'evaluation-cache-first',
      execution: source.execution,
      evaluationCache: cache,
      mutate(_definition, policy) { policy.cache.evaluationMode = 'reuse'; },
    });
    const replay = await runConformanceScenario('function', {
      suffix: 'evaluation-cache-replay',
      execution: source.execution,
      evaluationCache: cache,
      mutate(_definition, policy) { policy.cache.evaluationMode = 'reuse'; },
    });

    expect(first.state.evaluatorAttempts).toBe(4);
    expect(replay.state.evaluatorAttempts).toBe(0);
    expect(replay.evaluation.records.every((record) => (
      record.evaluationStatus === 'completed'
      && record.cache.cacheStatus === 'transparent-hit'
      && record.provenance.provenanceKind === 'replay'
    ))).toBe(true);
  });

  it.each(['stale-digest', 'forged-provenance'] as const)(
    'fails closed on an Execution cache entry with %s',
    async (poison) => {
      const cache = new InMemoryConformanceExecutionCache();
      await runConformanceScenario('function', {
        suffix: `execution-cache-${poison}-seed`,
        executionCache: cache,
        mutate(_definition, policy) {
          policy.cache.executionMode = 'transparent-deterministic';
        },
      });
      cache.tamperFirst((entry) => {
        if (poison === 'stale-digest') {
          entry.sourceRecordDigest = `sha256:${'0'.repeat(64)}`;
          return;
        }
        entry.record.provenance = {
          provenanceKind: 'replay',
          trust: entry.record.provenance.trust,
          parentDigests: [entry.sourceRecordDigest],
        };
        entry.sourceRecordDigest = digestCanonicalJson(entry.record);
      });

      const result = await runConformanceScenario('function', {
        suffix: `execution-cache-${poison}-rejected`,
        executionCache: cache,
        mutate(_definition, policy) {
          policy.cache.executionMode = 'transparent-deterministic';
        },
      });
      expect(result.execution).toMatchObject({
        executionBundleStatus: 'failed',
        terminationReasonCode: 'execution-cache-read-failed',
      });
      expect(result.state.executorAttempts).toBe(0);
    },
  );

  it.each(['classification', 'capture-mode', 'usage', 'attempt-chain'] as const)(
    'fails closed on an Execution cache entry violating sealed %s semantics',
    async (poison) => {
      const marker = 'cache-secret-marker';
      const cache = new InMemoryConformanceExecutionCache();
      await runConformanceScenario('function', {
        suffix: `execution-cache-${poison}-policy-seed`,
        executionCache: cache,
        mutate(_definition, policy) {
          policy.cache.executionMode = 'transparent-deterministic';
          policy.evidence.output = 'full';
          policy.evidence.maximumClassification = 'public';
        },
      });
      cache.tamperFirst((entry) => {
        if (entry.record.executionStatus !== 'completed') {
          throw new Error('Expected a completed cached ExecutionRecord.');
        }
        if (poison === 'classification') {
          entry.record.output = {
            contentKind: 'inline',
            classification: 'secret',
            value: { answer: marker },
          };
        } else if (poison === 'capture-mode') {
          entry.record.output = {
            contentKind: 'digest-only',
            classification: 'public',
            digest: digestCanonicalJson({ answer: marker }),
          };
        } else if (poison === 'usage') {
          entry.record.usage = {
            inputTokens: 999,
            details: { aggregationKind: 'forged' },
          };
        } else {
          entry.record.attempts[0].attemptNumber = 2;
        }
        entry.sourceRecordDigest = digestCanonicalJson(entry.record);
      });

      const result = await runConformanceScenario('function', {
        suffix: `execution-cache-${poison}-policy-rejected`,
        executionCache: cache,
        mutate(_definition, policy) {
          policy.cache.executionMode = 'transparent-deterministic';
          policy.evidence.output = 'full';
          policy.evidence.maximumClassification = 'public';
        },
      });

      expect(result.execution).toMatchObject({
        executionBundleStatus: 'failed',
        terminationReasonCode: 'execution-cache-read-failed',
      });
      expect(result.state.executorAttempts).toBe(0);
      expect(JSON.stringify(result)).not.toContain(marker);
    },
  );

  it('fails closed on forged Evaluation cache provenance', async () => {
    const source = await runConformanceScenario('function', {
      suffix: 'evaluation-forged-cache-source',
    });
    const cache = new InMemoryConformanceEvaluationCache();
    await runConformanceScenario('function', {
      suffix: 'evaluation-forged-cache-seed',
      execution: source.execution,
      evaluationCache: cache,
      mutate(_definition, policy) { policy.cache.evaluationMode = 'reuse'; },
    });
    cache.tamperFirst((entry) => {
      entry.record.provenance = {
        provenanceKind: 'replay',
        trust: entry.record.provenance.trust,
        parentDigests: [entry.cachedRecordDigest],
      };
      entry.cachedRecordDigest = digestCanonicalJson(entry.record);
    });

    const result = await runConformanceScenario('function', {
      suffix: 'evaluation-forged-cache-rejected',
      execution: source.execution,
      evaluationCache: cache,
      mutate(_definition, policy) { policy.cache.evaluationMode = 'reuse'; },
    });
    expect(result.evaluation).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluation-cache-read-failed',
    });
    expect(result.state.evaluatorAttempts).toBe(0);
  });
});
