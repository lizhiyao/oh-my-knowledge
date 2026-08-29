import { describe, expect, it } from 'vitest';
import {
  digestCanonicalJson,
  parseEvaluationBundle,
  type RuntimeIdentity,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';
import { prepareEvaluationPlan } from '../../../src/evaluation-core/compiler/index.js';
import {
  executeRunPlan,
  type ExecutionClock,
  type ExecutionExecutor,
} from '../../../src/evaluation-core/execution/index.js';
import {
  EvaluationPortFailure,
  EvaluationRuntimeConfigurationError,
  evaluateExecutionBundle,
  startEvaluation,
  type EvaluationCache,
  type EvaluationCacheEntry,
  type EvaluationEvaluator,
  type EvaluationRuntimePorts,
  type EvaluatorAttemptContext,
  type EvaluatorRecordContext,
} from '../../../src/evaluation-core/evaluation/index.js';
import { testRuntime, validDefinition, validPolicy } from '../compiler/fixtures.js';

type Plan = Awaited<ReturnType<typeof prepareEvaluationPlan>>;

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

class FakeClock implements ExecutionClock {
  now = 0;

  monotonicNow(): number { return this.now; }

  timestamp(): string {
    return new Date(Date.UTC(2026, 7, 29) + this.now).toISOString();
  }

  async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    this.now += delayMs;
    await Promise.resolve();
    if (signal.aborted) throw abortError();
  }
}

async function makePlan(
  mutate?: (
    definition: ReturnType<typeof validDefinition>,
    policy: ReturnType<typeof validPolicy>,
  ) => void,
): Promise<Plan> {
  const definition = validDefinition();
  const policy = validPolicy();
  delete policy.execution.timeoutMs;
  delete policy.evaluation.timeoutMs;
  mutate?.(definition, policy);
  return prepareEvaluationPlan(definition, policy, testRuntime());
}

function identity(
  plan: Plan,
  runtimeKind: 'executor' | 'evaluator',
  referenceId: string,
): RuntimeIdentity {
  const runtime = (runtimeKind === 'executor'
    ? plan.execution.runtimes
    : plan.evaluation.runtimes).find((candidate) => (
    candidate.runtimeKind === runtimeKind && candidate.referenceId === referenceId
  ));
  if (runtime === undefined) throw new Error('missing runtime');
  return structuredClone(runtime.identity) as RuntimeIdentity;
}

function executor(plan: Plan, fail = false): ExecutionExecutor {
  return {
    identity: identity(plan, 'executor', 'control'),
    async openRun() {
      return {
        async openTrial(context) {
          return {
            async execute() {
              if (fail) throw new Error('execution failed');
              return {
                output: {
                  value: { answer: context.targetId === 'control' ? 'A' : 'B' },
                  classification: 'public' as const,
                },
              };
            },
            dispose() {},
          };
        },
        dispose() {},
      };
    },
  };
}

async function sourceBundle(plan: Plan, fail = false) {
  return executeRunPlan(plan, {
    executors: new Map([['executor-alias', executor(plan, fail)]]),
    clock: new FakeClock(),
    contentStore: {
      async put(request) {
        return {
          mediaType: request.mediaType,
          digest: request.digest,
          uri: `memory:${request.digest}`,
        };
      },
    },
  }, {
    runId: 'source-run',
    bundleId: 'source-bundle',
  });
}

interface EvaluatorState {
  attempts: number;
  recordContexts: EvaluatorRecordContext[];
  recordDisposals: number;
  runDisposals: number;
}

function evaluator(
  plan: Plan,
  evaluate: (
    state: EvaluatorState,
    attempt: Readonly<EvaluatorAttemptContext>,
  ) => unknown = () => ({
    observations: [{
      metricId: 'correct',
      observationStatus: 'observed',
      valueType: 'boolean',
      value: true,
    }],
  }),
  disposeFailure = false,
): { port: EvaluationEvaluator; state: EvaluatorState } {
  const state: EvaluatorState = {
    attempts: 0,
    recordContexts: [],
    recordDisposals: 0,
    runDisposals: 0,
  };
  return {
    state,
    port: {
      identity: identity(plan, 'evaluator', 'exact'),
      async openRun() {
        return {
          async openRecord(context) {
            state.recordContexts.push(context as EvaluatorRecordContext);
            return {
              async evaluate(attempt) {
                state.attempts += 1;
                return evaluate(state, attempt) as never;
              },
              dispose() {
                state.recordDisposals += 1;
                if (disposeFailure) throw new Error('dispose failed');
              },
            };
          },
          dispose() { state.runDisposals += 1; },
        };
      },
    },
  };
}

class MemoryCache implements EvaluationCache {
  readonly entries = new Map<Sha256Digest, EvaluationCacheEntry>();
  puts = 0;

  async get(key: Sha256Digest): Promise<EvaluationCacheEntry | undefined> {
    return this.entries.get(key);
  }

  async put(entry: Readonly<EvaluationCacheEntry>): Promise<void> {
    this.puts += 1;
    this.entries.set(entry.cacheKeyDigest, structuredClone(entry));
  }
}

function ports(
  plan: Plan,
  port: EvaluationEvaluator,
  overrides: Partial<EvaluationRuntimePorts> = {},
): EvaluationRuntimePorts {
  return {
    evaluators: new Map([['exact/v1', port]]),
    clock: new FakeClock(),
    ...overrides,
  };
}

describe('Evaluation Core Evaluation runtime', () => {
  it('re-scores an ExecutionBundle through evaluator-only ports and seals bindings', async () => {
    const plan = await makePlan();
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const run = startEvaluation(plan, source, ports(plan, fake.port), {
      runId: 'evaluation-run',
      bundleId: 'evaluation-bundle',
      eventBufferCapacity: 1,
    });
    const bundle = await run.result;

    expect(bundle.evaluationBundleStatus).toBe('completed');
    expect(bundle.coverage).toEqual({
      planned: 2,
      eligible: 2,
      sourceUnavailable: 0,
      started: 2,
      completed: 2,
      failed: 0,
      cancelled: 0,
      notStarted: 0,
    });
    expect(parseEvaluationBundle(bundle, plan, source)).toEqual(bundle);
    expect(fake.state.recordContexts[0].bindings).toEqual([
      expect.objectContaining({ bindingId: 'actual', sourceKind: 'output' }),
      expect.objectContaining({ bindingId: 'gold', sourceKind: 'expected', value: 'A' }),
    ]);
    expect(fake.state.recordContexts.every(Object.isFrozen)).toBe(true);
    expect(fake.state.recordDisposals).toBe(2);
    expect(fake.state.runDisposals).toBe(1);
    expect(bundle.records[0]).not.toHaveProperty('executor');
  });

  it('keeps unavailable execution evidence distinct from evaluator failure', async () => {
    const plan = await makePlan();
    const source = await sourceBundle(plan, true);
    const fake = evaluator(plan);
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'unavailable-run',
      bundleId: 'unavailable-bundle',
    });

    expect(bundle.coverage).toMatchObject({
      planned: 2,
      eligible: 0,
      sourceUnavailable: 2,
      started: 0,
      failed: 0,
    });
    expect(bundle.records.every((record) => record.evaluationStatus === 'not-evaluated')).toBe(true);
    expect(fake.state.attempts).toBe(0);
  });

  it('fills omitted metrics as missing and never fabricates a default score', async () => {
    const plan = await makePlan();
    const source = await sourceBundle(plan);
    const fake = evaluator(plan, () => ({ observations: [] }));
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'missing-run',
      bundleId: 'missing-bundle',
    });
    const record = bundle.records[0];
    if (record.evaluationStatus !== 'completed') throw new Error('unexpected status');
    expect(record.observations).toEqual([expect.objectContaining({
      observationStatus: 'missing',
      reasonCode: 'evaluator-omitted-metric',
    })]);
    expect(record.observations[0]).not.toHaveProperty('value');
  });

  it('retries only sealed error codes and preserves each attempt usage', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.evaluation.maxConcurrency = 1;
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan, (state) => {
      if (state.attempts % 2 === 1) {
        throw new EvaluationPortFailure({
          code: 'timeout',
          stage: 'evaluation',
          message: 'retry me',
        }, { totalTokens: 3 });
      }
      return {
        observations: [{
          metricId: 'correct',
          observationStatus: 'observed',
          valueType: 'boolean',
          value: true,
        }],
        usage: { totalTokens: 5 },
      };
    });
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'retry-run',
      bundleId: 'retry-bundle',
    });
    const record = bundle.records[0];
    if (record.evaluationStatus === 'not-evaluated') throw new Error('unexpected status');
    expect(record.attempts).toHaveLength(2);
    expect(record.attempts.map((attempt) => attempt.usage?.totalTokens)).toEqual([3, 5]);
    expect(record.usage?.totalTokens).toBe(8);
  });

  it('turns the sealed timeout into a retryable attempt fact', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.evaluation.timeoutMs = 5;
      policy.evaluation.maxConcurrency = 1;
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan, (_state, attempt) => new Promise((_resolve, reject) => {
      attempt.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    }));
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'timeout-run',
      bundleId: 'timeout-bundle',
    });
    const record = bundle.records[0];
    if (record.evaluationStatus === 'not-evaluated') throw new Error('unexpected status');
    expect(record.evaluationStatus).toBe('failed');
    expect(record.attempts).toHaveLength(2);
    expect(record.attempts.every((attempt) => (
      attempt.attemptStatus === 'failed' && attempt.error.code === 'timeout'
    ))).toBe(true);
  });

  it('reuses cache by source digest and commits only after clean resource teardown', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
    });
    const source = await sourceBundle(plan);
    const cache = new MemoryCache();
    const first = evaluator(plan);
    await evaluateExecutionBundle(plan, source, ports(plan, first.port, { cache }), {
      runId: 'cache-first',
      bundleId: 'cache-first-bundle',
    });
    expect(cache.puts).toBe(2);

    const second = evaluator(plan);
    const replay = await evaluateExecutionBundle(plan, source, ports(plan, second.port, { cache }), {
      runId: 'cache-second',
      bundleId: 'cache-second-bundle',
    });
    expect(second.state.attempts).toBe(0);
    expect(replay.records.every((record) => (
      record.evaluationStatus === 'completed'
      && record.cache.cacheStatus === 'transparent-hit'
    ))).toBe(true);

    const dirtyCache = new MemoryCache();
    const dirty = evaluator(plan, undefined, true);
    await expect(evaluateExecutionBundle(
      plan,
      source,
      ports(plan, dirty.port, { cache: dirtyCache }),
      { runId: 'cache-dirty', bundleId: 'cache-dirty-bundle' },
    )).resolves.toMatchObject({ evaluationBundleStatus: 'failed' });
    expect(dirtyCache.puts).toBe(0);
  });

  it('rejects missing evaluator bindings synchronously', async () => {
    const plan = await makePlan();
    const source = await sourceBundle(plan);
    expect(() => startEvaluation(plan, source, {
      evaluators: new Map(),
      clock: new FakeClock(),
    }, {
      runId: 'invalid-run',
      bundleId: 'invalid-bundle',
    })).toThrowError(EvaluationRuntimeConfigurationError);
  });

  it('re-seals terminal status when EventWriter fails on terminal delivery', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.eventDelivery.writerMode = 'optional';
      policy.eventDelivery.writerFailureMode = 'fail-run';
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port, {
      eventWriter: {
        async write(event) {
          if (event.eventKind === 'evaluation.run.completed') throw new Error('writer failed');
        },
      },
    }), {
      runId: 'writer-run',
      bundleId: 'writer-bundle',
    });
    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluation-event-writer-failed',
    });
    expect(parseEvaluationBundle(bundle, plan, source)).toEqual(bundle);
  });

  it('binds cache identity to the exact source ExecutionRecord digest', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
    });
    const source = await sourceBundle(plan);
    const cache = new MemoryCache();
    const fake = evaluator(plan);
    await evaluateExecutionBundle(plan, source, ports(plan, fake.port, { cache }), {
      runId: 'digest-run',
      bundleId: 'digest-bundle',
    });
    const sourceDigests = new Set<string>(
      source.records.map((record) => digestCanonicalJson(record)),
    );
    expect([...cache.entries.values()].every((entry) => (
      sourceDigests.has(entry.record.sourceRecordDigest)
    ))).toBe(true);
  });
});
