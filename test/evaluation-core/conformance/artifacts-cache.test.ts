import { describe, expect, it } from 'vitest';
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
    expect(replay.analysis.records[0]).toMatchObject({
      analysisStatus: 'completed',
      coverage: { planned: 4, included: 4 },
    });
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
});
