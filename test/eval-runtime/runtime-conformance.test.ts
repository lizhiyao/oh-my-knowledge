import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_CHECK_RESULT_SCHEMA_VERSION,
  checkContentStore,
  checkExecutor,
  checkRuntime,
  type ContentResolver,
  type ContentStore,
  type ContentValue,
  type CustomEvaluator,
  type EvaluationCache,
  type EvaluationCacheEntry,
  type ExecutionCache,
  type ExecutionCacheEntry,
  type Executor,
  type Judge,
  type RuntimeCheckInput,
  type WorkspaceProvider,
} from '../../src/eval-runtime/index.js';
import { canonicalizeJsonBytes } from '../../src/eval-core/contracts/index.js';

function executor(): Executor<string, undefined, string> {
  return {
    executorId: 'test.runtime-check-executor/v1',
    version: '1.0.0',
    schemas: { input: z.string(), output: z.string() },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'serialized' },
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    fingerprintFacets: { revision: 'runtime-check-one' },
    async execute({ input, signal }) {
      if (input === 'failure') return { errorCode: 'expected-failure' };
      if (input === 'cancellation') {
        await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return { output: input };
    },
  };
}

function executorProbe() {
  return {
    variant: {
      variantId: 'candidate',
      artifact: { name: 'candidate', kind: 'baseline' as const, source: 'baseline' as const, content: null },
      execution: { executor: executor() },
    },
    success: { input: 'success', expected: 'success' },
    failure: { input: 'failure', expectedErrorCode: 'expected-failure' },
    cancellation: { input: 'cancellation' },
  };
}

function contentPorts() {
  const values = new Map<string, ContentValue>();
  const contentStore: ContentStore = {
    async put(request) {
      values.set(request.digest, {
        value: structuredClone(request.value),
        classification: request.classification,
        mediaType: request.mediaType,
      });
      return {
        digest: request.digest,
        mediaType: request.mediaType,
        size: canonicalizeJsonBytes(request.value).byteLength,
      };
    },
  };
  const contentResolver: ContentResolver = {
    async resolve(descriptor) {
      const value = values.get(descriptor.digest);
      if (value === undefined) throw new Error('not found');
      return value;
    },
  };
  return { contentStore, contentResolver };
}

class MemoryExecutionCache implements ExecutionCache {
  readonly entries = new Map<string, ExecutionCacheEntry>();
  async get(key: ExecutionCacheEntry['cacheKeyDigest']) { return this.entries.get(key); }
  async put(entry: Readonly<ExecutionCacheEntry>) { this.entries.set(entry.cacheKeyDigest, entry); }
}

class MemoryEvaluationCache implements EvaluationCache {
  readonly entries = new Map<string, EvaluationCacheEntry>();
  async get(key: EvaluationCacheEntry['cacheKeyDigest']) { return this.entries.get(key); }
  async put(entry: Readonly<EvaluationCacheEntry>) { this.entries.set(entry.cacheKeyDigest, entry); }
}

describe('eval-runtime unified conformance entry', () => {
  it('wraps the existing Executor check without changing its evidence', async () => {
    const legacy = await checkExecutor(executorProbe());
    const unified = await checkRuntime({ runtimeKind: 'executor', ...executorProbe() });

    expect(unified).toMatchObject({
      schemaVersion: RUNTIME_CHECK_RESULT_SCHEMA_VERSION,
      runtimeKind: 'executor',
      checkStandardId: 'omk.runtime-check.executor/v1',
      evidenceLevel: 'behavioral-probe',
      conformant: legacy.conformant,
      checks: legacy.checks,
    });
    expect('run' in unified).toBe(false);
    expect(JSON.stringify(unified)).not.toContain('success');
  });

  it('wraps the existing ContentStore check without retaining probe content', async () => {
    const legacyPorts = contentPorts();
    const unifiedPorts = contentPorts();
    const probe = {
      value: { publicMarker: 'runtime-check-public-probe' },
      classification: 'public' as const,
    };
    const legacy = await checkContentStore({ ...legacyPorts, probe });
    const unified = await checkRuntime({
      runtimeKind: 'content-store',
      ...unifiedPorts,
      probe,
    });

    expect(unified).toEqual({
      schemaVersion: RUNTIME_CHECK_RESULT_SCHEMA_VERSION,
      runtimeKind: 'content-store',
      checkStandardId: 'omk.runtime-check.content-store/v1',
      evidenceLevel: 'behavioral-probe',
      ...legacy,
    });
    expect(JSON.stringify(unified)).not.toContain('runtime-check-public-probe');
  });

  it.each([
    ['execution', () => new MemoryExecutionCache()],
    ['evaluation', () => new MemoryEvaluationCache()],
  ] as const)('checks a disposable %s cache through Core miss, hit, and isolation', async (
    cacheKind,
    createCache,
  ) => {
    const result = await checkRuntime({
      runtimeKind: 'cache',
      cacheKind,
      cache: createCache() as never,
      probeNamespace: `test-${cacheKind}-cache`,
    });

    expect(result.conformant, JSON.stringify(result)).toBe(true);
    expect(result.checks.every((candidate) => candidate.checkStatus === 'passed')).toBe(true);
    expect(result.checkStandardId).toBe(`omk.runtime-check.${cacheKind}-cache/v1`);
  });

  it('reduces cache host failures to stable reason codes', async () => {
    const secret = 'private-cache-credential';
    const get = vi.fn(async () => { throw new Error(secret); });
    const result = await checkRuntime({
      runtimeKind: 'cache',
      cacheKind: 'execution',
      cache: { get, async put() {} },
      probeNamespace: 'test-failing-execution-cache',
    });

    expect(result.conformant).toBe(false);
    expect(result.checks.some((candidate) => candidate.checkStatus === 'failed')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(get).toHaveBeenCalled();
  });

  it('captures cache methods exactly once with their original receiver', async () => {
    const entries = new Map<string, ExecutionCacheEntry>();
    let getReads = 0;
    let putReads = 0;
    const cache = Object.defineProperties({ entries }, {
      get: {
        get() {
          getReads += 1;
          if (getReads > 1) throw new Error('get was captured more than once');
          return async function get(this: { entries: Map<string, ExecutionCacheEntry> }, key: string) {
            return this.entries.get(key);
          };
        },
      },
      put: {
        get() {
          putReads += 1;
          if (putReads > 1) throw new Error('put was captured more than once');
          return async function put(
            this: { entries: Map<string, ExecutionCacheEntry> },
            entry: Readonly<ExecutionCacheEntry>,
          ) {
            this.entries.set(entry.cacheKeyDigest, entry);
          };
        },
      },
    }) as unknown as ExecutionCache;

    const result = await checkRuntime({
      runtimeKind: 'cache',
      cacheKind: 'execution',
      cache,
      probeNamespace: 'test-one-shot-cache-methods',
    });

    expect(result.conformant, JSON.stringify(result)).toBe(true);
    expect({ getReads, putReads }).toEqual({ getReads: 1, putReads: 1 });
  });

  it('rejects a cache missing a required method as invalid configuration', async () => {
    await expect(checkRuntime({
      runtimeKind: 'cache',
      cacheKind: 'execution',
      cache: { async get() { return undefined; } } as unknown as ExecutionCache,
      probeNamespace: 'test-cache-missing-put',
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
  });

  it('does not certify an Evaluation cache that fails under concurrent reads', async () => {
    const entries = new Map<string, EvaluationCacheEntry>();
    let readsInFlight = 0;
    const result = await checkRuntime({
      runtimeKind: 'cache',
      cacheKind: 'evaluation',
      cache: {
        async get(key) {
          readsInFlight += 1;
          try {
            await Promise.resolve();
            if (readsInFlight > 1) throw new Error('concurrent read unsupported');
            return entries.get(key);
          } finally {
            readsInFlight -= 1;
          }
        },
        async put(entry) { entries.set(entry.cacheKeyDigest, entry); },
      },
      probeNamespace: 'test-evaluation-cache-concurrency',
    });

    expect(result.conformant).toBe(false);
    expect(result.checks).toContainEqual({
      checkId: 'concurrency-contract',
      checkStatus: 'failed',
      reasonCode: 'runtime-evaluation-cache-concurrency-invalid',
    });
  });

  it('checks a WorkspaceProvider through success, failure, cancellation, and cleanup', async () => {
    let sequence = 0;
    const roots: string[] = [];
    const closes = new Map<string, number>();
    const provider: WorkspaceProvider = {
      providerId: 'test.runtime-check-workspace/v1',
      version: '1.0.0',
      fingerprintFacets: { revision: 'workspace-one' },
      async open({ signal }) {
        expect(signal).toBeInstanceOf(AbortSignal);
        const root = `/virtual/runtime-check-workspace-${sequence += 1}`;
        roots.push(root);
        return {
          root,
          close() { closes.set(root, (closes.get(root) ?? 0) + 1); },
        };
      },
    };
    const result = await checkRuntime({
      runtimeKind: 'workspace-provider',
      provider,
      descriptor: {
        resourceId: 'runtime-check-workspace',
        digest: `sha256:${'a'.repeat(64)}`,
        mediaType: 'application/vnd.omk.workspace-tree',
        classification: 'sensitive',
        size: 1,
      },
      probeNamespace: 'test-workspace-provider',
    });

    expect(result.conformant, JSON.stringify(result)).toBe(true);
    expect(result.checks.every((candidate) => candidate.checkStatus === 'passed')).toBe(true);
    expect(roots).toHaveLength(5);
    expect([...closes.values()]).toEqual([1, 1, 1, 1, 1]);
    expect(roots.every((root) => !JSON.stringify(result).includes(root))).toBe(true);
  });

  it('allows a WorkspaceProvider to reuse a released physical path sequentially', async () => {
    let sequence = 0;
    const result = await checkRuntime({
      runtimeKind: 'workspace-provider',
      provider: {
        providerId: 'test.runtime-check-reused-workspace/v1',
        version: '1.0.0',
        async open() {
          sequence += 1;
          return {
            root: sequence === 2 ? '/virtual/runtime-check-secondary' : '/virtual/runtime-check-reused',
            close() {},
          };
        },
      },
      descriptor: {
        resourceId: 'runtime-check-reused-workspace',
        digest: `sha256:${'b'.repeat(64)}`,
        mediaType: 'application/vnd.omk.workspace-tree',
        classification: 'sensitive',
        size: 1,
      },
      probeNamespace: 'test-reused-workspace-provider',
    });

    expect(result.conformant, JSON.stringify(result)).toBe(true);
  });

  it('bounds a WorkspaceProvider close that never settles', async () => {
    const result = await Promise.race([
      checkRuntime({
        runtimeKind: 'workspace-provider',
        provider: {
          providerId: 'test.runtime-check-hanging-workspace/v1',
          version: '1.0.0',
          async open({ sampleId }) {
            return {
              root: `/virtual/runtime-check-hanging-${sampleId}`,
              close: () => new Promise<void>(() => undefined),
            };
          },
        },
        descriptor: {
          resourceId: 'runtime-check-hanging-workspace',
          digest: `sha256:${'c'.repeat(64)}`,
          mediaType: 'application/vnd.omk.workspace-tree',
          classification: 'sensitive',
          size: 1,
        },
        probeNamespace: 'test-hanging-workspace-provider',
        timeoutMs: 5,
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('workspace check did not return')), 1_000);
      }),
    ]);

    expect(result.conformant).toBe(false);
  });

  it('checks a Custom Evaluator through bindings, result, failure, and cancellation', async () => {
    type Actual = {
      mode: 'score' | 'missing' | 'invalid' | 'failure' | 'cancellation';
      value?: number;
    };
    let failOnConcurrentScore = false;
    let scoreCallsInFlight = 0;
    const evaluator: CustomEvaluator<{ actual: Actual }> = {
      evaluatorKind: 'custom',
      evaluatorId: 'test-runtime-check-evaluator',
      instrumentId: 'test.runtime-check-evaluator/v1',
      metric: {
        metricId: 'test-runtime-check-score',
        valueType: 'numeric',
        direction: 'higher-is-better',
        missingPolicyId: 'exclude/v1',
      },
      bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
      implementation: {
        implementationId: 'test.runtime-check-evaluator/v1',
        version: '1.0.0',
        schemas: {
          bindings: z.object({
            actual: z.object({
              mode: z.enum(['score', 'missing', 'invalid', 'failure', 'cancellation']),
              value: z.number().optional(),
            }).strict(),
          }).strict(),
          value: z.number(),
          fingerprintFacets: { bindings: 'actual/v1', value: 'number/v1' },
        },
        fingerprintFacets: { revision: 'evaluator-one' },
        async evaluate({ bindings, signal }) {
          if (bindings.actual.mode === 'failure') {
            return { resultKind: 'failed', errorCode: 'expected-evaluator-failure' };
          }
          if (bindings.actual.mode === 'missing') {
            return { resultKind: 'missing', reasonCode: 'expected-evaluator-missing' };
          }
          if (bindings.actual.mode === 'invalid') {
            return { resultKind: 'invalid', reasonCode: 'expected-evaluator-invalid' };
          }
          if (bindings.actual.mode === 'cancellation') {
            await new Promise((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          }
          if (failOnConcurrentScore && bindings.actual.mode === 'score') {
            scoreCallsInFlight += 1;
            await Promise.resolve();
            const overlapped = scoreCallsInFlight > 1;
            scoreCallsInFlight -= 1;
            if (overlapped) {
              return { resultKind: 'failed', errorCode: 'concurrent-score-unsupported' };
            }
          }
          return {
            resultKind: 'score',
            value: bindings.actual.value ?? 0,
            usage: { totalTokens: 1 },
          };
        },
      },
    };

    const result = await checkRuntime({
      runtimeKind: 'evaluator',
      evaluator,
      probeNamespace: 'test-custom-evaluator',
      score: {
        output: { mode: 'score', value: 3 },
        expectedValue: 3,
      },
      missing: {
        output: { mode: 'missing' },
        expectedReasonCode: 'expected-evaluator-missing',
      },
      invalid: {
        output: { mode: 'invalid' },
        expectedReasonCode: 'expected-evaluator-invalid',
      },
      failure: {
        output: { mode: 'failure' },
        expectedErrorCode: 'expected-evaluator-failure',
      },
      cancellation: { output: { mode: 'cancellation' } },
    });

    expect(result.conformant, JSON.stringify(result)).toBe(true);
    expect(result.checks.every((candidate) => candidate.checkStatus === 'passed')).toBe(true);

    failOnConcurrentScore = true;
    const concurrencyFailure = await checkRuntime({
      runtimeKind: 'evaluator',
      evaluator,
      probeNamespace: 'test-custom-evaluator-concurrency-failure',
      score: { output: { mode: 'score', value: 3 }, expectedValue: 3 },
      missing: {
        output: { mode: 'missing' },
        expectedReasonCode: 'expected-evaluator-missing',
      },
      invalid: {
        output: { mode: 'invalid' },
        expectedReasonCode: 'expected-evaluator-invalid',
      },
      failure: {
        output: { mode: 'failure' },
        expectedErrorCode: 'expected-evaluator-failure',
      },
      cancellation: { output: { mode: 'cancellation' } },
    });
    expect(concurrencyFailure.conformant).toBe(false);
    expect(concurrencyFailure.checks).toContainEqual({
      checkId: 'concurrency-contract',
      checkStatus: 'failed',
      reasonCode: 'runtime-evaluator-concurrency-invalid',
    });
  });

  it('rejects an invalid later Custom Evaluator probe before invoking the callback', async () => {
    const evaluateProbe = vi.fn(async () => ({ resultKind: 'score' as const, value: 1 }));
    const invalidInput = {
      runtimeKind: 'evaluator',
      evaluator: {
        evaluatorKind: 'custom',
        evaluatorId: 'test-runtime-check-invalid-evaluator',
        instrumentId: 'test.runtime-check-invalid-evaluator/v1',
        metric: {
          metricId: 'test-runtime-check-invalid-score',
          valueType: 'numeric',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        },
        bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
        implementation: {
          implementationId: 'test.runtime-check-invalid-evaluator/v1',
          version: '1.0.0',
          schemas: {
            bindings: z.object({ actual: z.number() }).strict(),
            value: z.number(),
            fingerprintFacets: { bindings: 'actual-number/v1', value: 'number/v1' },
          },
          fingerprintFacets: { revision: 'invalid-probe-test' },
          evaluate: evaluateProbe,
        },
      },
      probeNamespace: 'test-invalid-later-evaluator-probe',
      score: { output: 1, expectedValue: 1 },
      missing: { output: 1, expectedReasonCode: 'expected-missing' },
      invalid: { output: 1, expectedReasonCode: 'expected-invalid' },
      failure: { output: 1, expectedErrorCode: 'expected-failure' },
      cancellation: { output: undefined },
    } as unknown as RuntimeCheckInput;

    await expect(checkRuntime(invalidInput)).rejects.toMatchObject({
      code: 'EVAL_RUNTIME_INPUT_INVALID',
    });
    expect(evaluateProbe).not.toHaveBeenCalled();
  });

  it('does not certify a Custom Evaluator that ignores cancellation', async () => {
    const result = await checkRuntime({
      runtimeKind: 'evaluator',
      evaluator: {
        evaluatorKind: 'custom',
        evaluatorId: 'test-runtime-check-ignores-cancellation',
        instrumentId: 'test.runtime-check-ignores-cancellation/v1',
        metric: {
          metricId: 'test-runtime-check-cancellation-score',
          valueType: 'numeric',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        },
        bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
        implementation: {
          implementationId: 'test.runtime-check-ignores-cancellation/v1',
          version: '1.0.0',
          schemas: {
            bindings: z.object({ actual: z.string() }).strict(),
            value: z.number(),
            fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
          },
          fingerprintFacets: { revision: 'ignores-cancellation' },
          async evaluate({ bindings, signal }) {
            if (bindings.actual === 'missing') {
              return { resultKind: 'missing', reasonCode: 'expected-missing' };
            }
            if (bindings.actual === 'invalid') {
              return { resultKind: 'invalid', reasonCode: 'expected-invalid' };
            }
            if (bindings.actual === 'failure') {
              return { resultKind: 'failed', errorCode: 'expected-failure' };
            }
            if (bindings.actual === 'cancellation') {
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener('abort', () => resolve(), { once: true });
              });
            }
            return { resultKind: 'score', value: 3 };
          },
        },
      },
      probeNamespace: 'test-evaluator-ignores-cancellation',
      score: { output: 'score', expectedValue: 3 },
      missing: { output: 'missing', expectedReasonCode: 'expected-missing' },
      invalid: { output: 'invalid', expectedReasonCode: 'expected-invalid' },
      failure: { output: 'failure', expectedErrorCode: 'expected-failure' },
      cancellation: { output: 'cancellation' },
    });

    expect(result.conformant).toBe(false);
    expect(result.checks).toContainEqual({
      checkId: 'cancellation-contract',
      checkStatus: 'failed',
      reasonCode: 'runtime-evaluator-cancellation-ignored',
    });
  });

  it('checks a Judge through the canonical Rubric evaluator with explicit external-call consent', async () => {
    const secret = 'private-judge-credential';
    let failOnConcurrentInvoke = false;
    let judgeCallsInFlight = 0;
    const judge: Judge = {
      judgeId: 'test.runtime-check-judge/v1',
      version: '1.0.0',
      providerCost: { reporting: 'optional' },
      fingerprintFacets: { revision: 'judge-one' },
      async invoke(request) {
        if (request.prompt.includes('RUNTIME_CHECK_FAILURE')) throw new Error(secret);
        if (request.prompt.includes('RUNTIME_CHECK_CANCELLATION')) {
          await new Promise((_resolve, reject) => {
            if (request.signal.aborted) reject(request.signal.reason);
            else request.signal.addEventListener(
              'abort',
              () => reject(request.signal.reason),
              { once: true },
            );
          });
        }
        if (failOnConcurrentInvoke) {
          judgeCallsInFlight += 1;
          await Promise.resolve();
          const overlapped = judgeCallsInFlight > 1;
          judgeCallsInFlight -= 1;
          if (overlapped) throw new Error('concurrent invoke unsupported');
        }
        if (request.prompt.includes('RUNTIME_CHECK_INVALID')) {
          return { invocationStatus: 'completed', output: 'not JSON' };
        }
        return {
          invocationStatus: 'completed',
          output: '{"score":4,"reason":"controlled probe"}',
          usage: {
            totalTokens: 3,
            providerCost: { amount: 0.01, currency: 'USD', reportedByProvider: true },
          },
        };
      },
    };

    const result = await checkRuntime({
      runtimeKind: 'judge',
      judge,
      model: 'test-judge-model',
      probeNamespace: 'test-judge',
      allowExternalCalls: true,
      success: { publicProbeText: 'RUNTIME_CHECK_SUCCESS', expectedScore: 4 },
      invalidResponse: {
        publicProbeText: 'RUNTIME_CHECK_INVALID',
        expectedReasonCode: 'judge-response-non-json',
      },
      failure: { publicProbeText: 'RUNTIME_CHECK_FAILURE' },
      cancellation: { publicProbeText: 'RUNTIME_CHECK_CANCELLATION' },
    });

    expect(result.conformant, JSON.stringify(result)).toBe(true);
    expect(result.checks.every((candidate) => candidate.checkStatus === 'passed')).toBe(true);
    expect(result.externalCalls).toEqual({
      invocationCount: 4,
      maximumInvocations: 4,
      providerCostReporting: 'optional',
      measuredProviderCosts: [{ amount: 0.01, currency: 'USD' }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('RUNTIME_CHECK_SUCCESS');

    failOnConcurrentInvoke = true;
    const concurrencyFailure = await checkRuntime({
      runtimeKind: 'judge',
      judge,
      model: 'test-judge-model',
      probeNamespace: 'test-judge-concurrency-failure',
      allowExternalCalls: true,
      success: { publicProbeText: 'RUNTIME_CHECK_SUCCESS', expectedScore: 4 },
      invalidResponse: {
        publicProbeText: 'RUNTIME_CHECK_INVALID',
        expectedReasonCode: 'judge-response-non-json',
      },
      failure: { publicProbeText: 'RUNTIME_CHECK_FAILURE' },
      cancellation: { publicProbeText: 'RUNTIME_CHECK_CANCELLATION' },
    });
    expect(concurrencyFailure.conformant).toBe(false);
    expect(concurrencyFailure.checks).toContainEqual({
      checkId: 'concurrency-contract',
      checkStatus: 'failed',
      reasonCode: 'runtime-judge-concurrency-invalid',
    });
  });

  it('does not invoke a Judge without explicit external-call consent', async () => {
    const invoke = vi.fn(async () => ({
      invocationStatus: 'completed' as const,
      output: '{"score":4,"reason":"unused"}',
    }));
    const unsafeInput = {
      runtimeKind: 'judge',
      judge: {
        judgeId: 'test.runtime-check-judge/v1',
        version: '1.0.0',
        providerCost: { reporting: 'unsupported' as const },
        invoke,
      },
      model: 'test-judge-model',
      probeNamespace: 'test-judge-no-consent',
      allowExternalCalls: false,
      success: { publicProbeText: 'success', expectedScore: 4 },
      invalidResponse: {
        publicProbeText: 'invalid',
        expectedReasonCode: 'judge-response-non-json',
      },
      failure: { publicProbeText: 'failure' },
      cancellation: { publicProbeText: 'cancellation' },
    } as unknown as RuntimeCheckInput;

    await expect(checkRuntime(unsafeInput)).rejects.toMatchObject({
      code: 'EVAL_RUNTIME_INPUT_INVALID',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not certify a Judge that ignores cancellation', async () => {
    const result = await checkRuntime({
      runtimeKind: 'judge',
      judge: {
        judgeId: 'test.runtime-check-judge-ignores-cancellation/v1',
        version: '1.0.0',
        providerCost: { reporting: 'unsupported' },
        async invoke(request) {
          if (request.prompt.includes('invalid')) {
            return { invocationStatus: 'completed', output: 'not JSON' };
          }
          if (request.prompt.includes('failure')) throw new Error('expected provider failure');
          if (request.prompt.includes('cancellation')) {
            await new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else request.signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }
          return { invocationStatus: 'completed', output: '{"score":4,"reason":"probe"}' };
        },
      },
      model: 'test-judge-model',
      probeNamespace: 'test-judge-ignores-cancellation',
      allowExternalCalls: true,
      success: { publicProbeText: 'success', expectedScore: 4 },
      invalidResponse: {
        publicProbeText: 'invalid',
        expectedReasonCode: 'judge-response-non-json',
      },
      failure: { publicProbeText: 'failure' },
      cancellation: { publicProbeText: 'cancellation' },
    });

    expect(result.conformant).toBe(false);
    expect(result.checks).toContainEqual({
      checkId: 'cancellation-contract',
      checkStatus: 'failed',
      reasonCode: 'runtime-judge-cancellation-ignored',
    });
  });

  it('rejects an invalid later Judge probe before making a paid call', async () => {
    const invoke = vi.fn(async () => ({
      invocationStatus: 'completed' as const,
      output: '{"score":4,"reason":"unused"}',
    }));
    const invalidInput = {
      runtimeKind: 'judge',
      judge: {
        judgeId: 'test.runtime-check-invalid-judge/v1',
        version: '1.0.0',
        providerCost: { reporting: 'unsupported' as const },
        invoke,
      },
      model: 'test-judge-model',
      probeNamespace: 'test-invalid-later-judge-probe',
      allowExternalCalls: true,
      success: { publicProbeText: 'success', expectedScore: 4 },
      invalidResponse: {
        publicProbeText: 'invalid',
        expectedReasonCode: 'judge-response-non-json',
      },
      failure: { publicProbeText: 'failure' },
      cancellation: { publicProbeText: '' },
    } as unknown as RuntimeCheckInput;

    await expect(checkRuntime(invalidInput)).rejects.toMatchObject({
      code: 'EVAL_RUNTIME_INPUT_INVALID',
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
