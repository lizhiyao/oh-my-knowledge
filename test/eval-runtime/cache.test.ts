import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  evaluate,
  prepareEvaluation,
  type EvaluationCache,
  type EvaluationCacheEntry,
  type Clock,
  type CustomEvaluator,
  type ExecutionCache,
  type ExecutionCacheEntry,
  type Executor,
  type ExecutorIdentityVerifier,
} from '../../src/eval-runtime/index.js';
import { digestCanonicalJson } from '../../src/eval-core/contracts/index.js';

type Input = { prompt: string };
type Config = { answer: string };

function clockAt(timestamp: string): Clock {
  return {
    monotonicNow: () => 0,
    timestamp: () => timestamp,
    sleep: () => Promise.resolve(),
  };
}

class MemoryExecutionCache implements ExecutionCache {
  readonly entries = new Map<string, ExecutionCacheEntry>();

  async get(key: ExecutionCacheEntry['cacheKeyDigest']) {
    return this.entries.get(key);
  }

  async put(entry: Readonly<ExecutionCacheEntry>) {
    this.entries.set(entry.cacheKeyDigest, entry);
  }
}

class MemoryEvaluationCache implements EvaluationCache {
  readonly entries = new Map<string, EvaluationCacheEntry>();

  async get(key: EvaluationCacheEntry['cacheKeyDigest']) {
    return this.entries.get(key);
  }

  async put(entry: Readonly<EvaluationCacheEntry>) {
    this.entries.set(entry.cacheKeyDigest, entry);
  }
}

function declaration(onCall: () => void): Executor<Input, Config, string> {
  return {
    executorId: 'test.cache-executor/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ prompt: z.string() }).strict(),
      config: z.object({ answer: z.string() }).strict(),
      output: z.string(),
    },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    fingerprintFacets: { deploymentRevision: 'cache-test-one' },
    async execute({ config, signal }) {
      onCall();
      signal.throwIfAborted();
      return { output: config.answer };
    },
  };
}

function evaluationInput(executor: Executor<Input, Config, string>) {
  return {
    dataset: {
      datasetId: 'cache-dataset',
      samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
    },
    variants: [{
      variantId: 'candidate',
      artifact: {
        name: 'candidate',
        kind: 'prompt' as const,
        source: 'inline' as const,
        content: 'Answer exactly.',
      },
      execution: { executor, config: { answer: 'A' } },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' as const }],
    comparisons: [],
    analyses: [],
    experiment: { seed: 'cache-seed', sampling: { samplingKind: 'solo' as const } },
    policy: {},
  };
}

const verifier: ExecutorIdentityVerifier = {
  verifierId: 'test-cache-verifier',
  async verify({ executor, declaredIdentity }) {
    return {
      attestationDigest: digestCanonicalJson({
        verifier: 'test-cache-verifier/v1',
        executorId: executor.executorId,
        fingerprint: declaredIdentity.fingerprint,
      }),
    };
  },
};

describe('canonical eval-runtime cache façade', () => {
  it('reuses deterministic Execution only after independent identity verification', async () => {
    let targetCalls = 0;
    const executionCache = new MemoryExecutionCache();
    const input = {
      ...evaluationInput(declaration(() => { targetCalls += 1; })),
      policy: { cache: { execution: 'reuse' as const } },
      infrastructure: { executionCache, executorIdentityVerifier: verifier },
    };

    const prepared = await prepareEvaluation(input);
    const runtime = prepared.resolvedRuntimes.find((item) => item.runtimeKind === 'executor');
    expect(prepared.policy.cache).toEqual({
      executionMode: 'transparent-deterministic',
      evaluationMode: 'disabled',
    });
    expect(runtime?.identity).toMatchObject({
      assuranceLevel: 'verified',
      provenanceFacets: {
        attestation: { attestorId: 'test-cache-verifier' },
      },
    });

    const first = await prepared.run();
    expect(first.status).toBe('completed');
    if (first.status !== 'completed') throw new Error(`unexpected status: ${first.status}`);
    expect(targetCalls).toBe(1);
    expect(executionCache.entries.size).toBe(1);
    const firstRecord = first.artifacts.execution.records[0];
    expect(firstRecord?.executionStatus).toBe('completed');
    if (firstRecord?.executionStatus !== 'completed') throw new Error('missing completed record');
    expect(firstRecord.cache.cacheStatus).toBe('miss');

    const second = await prepareEvaluation(input).then((next) => next.run());
    expect(second.status).toBe('completed');
    if (second.status !== 'completed') throw new Error(`unexpected status: ${second.status}`);
    expect(targetCalls).toBe(1);
    const secondRecord = second.artifacts.execution.records[0];
    expect(secondRecord?.executionStatus).toBe('completed');
    if (secondRecord?.executionStatus !== 'completed') throw new Error('missing completed record');
    expect(secondRecord.cache.cacheStatus).toBe('transparent-hit');
  });

  it('reuses Evaluation independently without requiring Executor verification', async () => {
    let targetCalls = 0;
    let evaluatorCalls = 0;
    const evaluationCache = new MemoryEvaluationCache();
    const countingEvaluator: CustomEvaluator<{ actual: string }> = {
      evaluatorKind: 'custom',
      evaluatorId: 'cache-counting-evaluator',
      instrumentId: 'cache-counting-evaluator-v1',
      metric: {
        metricId: 'cache-correct',
        valueType: 'boolean',
        direction: 'higher-is-better',
        missingPolicyId: 'exclude/v1',
      },
      bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
      implementation: {
        implementationId: 'test.cache-counting-evaluator/v1',
        version: '1.0.0',
        schemas: {
          bindings: z.object({ actual: z.string() }).strict(),
          value: z.boolean(),
          fingerprintFacets: { bindings: 'actual-string/v1', value: 'boolean/v1' },
        },
        fingerprintFacets: { revision: 'cache-test-one' },
        async evaluate({ bindings }) {
          evaluatorCalls += 1;
          return { resultKind: 'score', value: bindings.actual === 'A' };
        },
      },
    };
    const input = {
      ...evaluationInput(declaration(() => { targetCalls += 1; })),
      evaluators: [countingEvaluator],
      policy: { cache: { evaluation: 'reuse' as const } },
      infrastructure: { evaluationCache },
    };

    const first = await evaluate(input, { clock: clockAt('2026-09-06T00:00:00.000Z') });
    expect(first.status).toBe('completed');
    if (first.status !== 'completed') throw new Error(`unexpected status: ${first.status}`);
    const firstRecord = first.artifacts.evaluation.records[0];
    expect(firstRecord?.evaluationStatus).toBe('completed');
    if (firstRecord?.evaluationStatus !== 'completed') throw new Error('missing completed record');
    expect(firstRecord.cache.cacheStatus).toBe('miss');
    expect(evaluationCache.entries.size).toBe(1);
    expect(evaluatorCalls).toBe(1);

    const second = await evaluate(input, { clock: clockAt('2026-09-07T00:00:00.000Z') });
    expect(second.status).toBe('completed');
    if (second.status !== 'completed') throw new Error(`unexpected status: ${second.status}`);
    expect(targetCalls).toBe(2);
    expect(evaluatorCalls).toBe(1);
    const secondRecord = second.artifacts.evaluation.records[0];
    expect(secondRecord?.evaluationStatus).toBe('completed');
    if (secondRecord?.evaluationStatus !== 'completed') throw new Error('missing completed record');
    expect(secondRecord.cache.cacheStatus).toBe('transparent-hit');
  });

  it('fails cache wiring before any Target call', async () => {
    let targetCalls = 0;
    const base = evaluationInput(declaration(() => { targetCalls += 1; }));

    await expect(prepareEvaluation({
      ...base,
      policy: { cache: { execution: 'reuse' } },
      infrastructure: { executionCache: new MemoryExecutionCache() },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    await expect(prepareEvaluation({
      ...base,
      policy: { cache: { execution: 'replay-only' } },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    await expect(prepareEvaluation({
      ...base,
      policy: { cache: { evaluation: 'reuse' } },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    expect(targetCalls).toBe(0);
  });

  it('keeps replay-only misses out of the Target', async () => {
    let targetCalls = 0;
    const result = await evaluate({
      ...evaluationInput(declaration(() => { targetCalls += 1; })),
      policy: { cache: { execution: 'replay-only' as const } },
      infrastructure: { executionCache: new MemoryExecutionCache() },
    });

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' ? result.error.code : undefined)
      .toBe('execution-cache-miss');
    expect(targetCalls).toBe(0);
  });

  it('redacts verifier failures and rejects malformed attestations', async () => {
    let targetCalls = 0;
    const base = {
      ...evaluationInput(declaration(() => { targetCalls += 1; })),
      policy: { cache: { execution: 'reuse' as const } },
      infrastructure: {
        executionCache: new MemoryExecutionCache(),
        executorIdentityVerifier: {
          verifierId: 'broken-verifier',
          async verify() {
            throw new Error('provider credential should remain private');
          },
        },
      },
    };
    await expect(prepareEvaluation(base)).rejects.toMatchObject({
      code: 'EVAL_RUNTIME_INPUT_INVALID',
      message: 'Executor identity verification failed。',
    });

    await expect(prepareEvaluation({
      ...base,
      infrastructure: {
        executionCache: new MemoryExecutionCache(),
        executorIdentityVerifier: {
          verifierId: 'broken-verifier',
          async verify() {
            return { attestationDigest: 'not-a-digest' as never };
          },
        },
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    expect(targetCalls).toBe(0);
  });
});
