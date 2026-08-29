import { describe, expect, it } from 'vitest';
import {
  digestArtifactPayload,
  digestCanonicalJson,
  parseEvaluationBundle,
  type EvaluationEvent,
  type ExecutionBundle,
  type RuntimeIdentity,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';
import { prepareEvaluationPlan } from '../../../src/evaluation-core/compiler/index.js';
import {
  executeRunPlan,
  InMemoryRuntimeEventSequencer,
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
  runtime = testRuntime(),
): Promise<Plan> {
  const definition = validDefinition();
  const policy = validPolicy();
  delete policy.execution.timeoutMs;
  delete policy.evaluation.timeoutMs;
  mutate?.(definition, policy);
  return prepareEvaluationPlan(definition, policy, runtime);
}

function resealExecutionBundle(
  source: ExecutionBundle,
  mutate: (draft: ExecutionBundle) => void,
): ExecutionBundle {
  const draft = structuredClone(source);
  mutate(draft);
  draft.bundleDigest = `sha256:${'0'.repeat(64)}`;
  draft.bundleDigest = digestArtifactPayload(draft, 'bundleDigest');
  return draft;
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
    eventSequencer: new InMemoryRuntimeEventSequencer(),
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
    eventSequencer: new InMemoryRuntimeEventSequencer(),
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
    expect(fake.state.recordContexts[0].metrics).toEqual([
      expect.objectContaining({ metricId: 'correct', valueType: 'boolean' }),
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
      eventSequencer: new InMemoryRuntimeEventSequencer(),
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

  it('evaluates failed execution records when every sealed trace binding is materializable', async () => {
    const plan = await makePlan((definition) => {
      definition.evaluators[0].inputs = [{
        bindingId: 'trace',
        sourceKind: 'trace',
        pointer: '/message',
      }];
    }, testRuntime({ traceCapability: 'optional' }));
    const completed = await sourceBundle(plan);
    const source = resealExecutionBundle(completed, (draft) => {
      draft.records = draft.records.map((record, recordIndex) => {
        if (record.executionStatus !== 'completed') throw new Error('unexpected source');
        if (recordIndex > 0) return {
          ...record,
          trace: {
            contentKind: 'inline',
            classification: 'public',
            value: { message: 'trace remains available' },
          },
        };
        const base = structuredClone(record);
        delete base.output;
        return {
          ...base,
          executionStatus: 'failed',
          attempts: record.attempts.map((attempt, index) => index === record.attempts.length - 1
            ? {
              ...attempt,
              attemptStatus: 'failed',
              error: { code: 'target-failed', stage: 'execution', message: 'Target failed.' },
            }
            : attempt),
          error: { code: 'target-failed', stage: 'execution', message: 'Target failed.' },
          trace: {
            contentKind: 'inline',
            classification: 'public',
            value: { message: 'trace remains available' },
          },
        };
      });
      draft.coverage = {
        ...draft.coverage,
        succeeded: draft.records.length - 1,
        failed: 1,
      };
      draft.executionBundleStatus = 'failed';
      draft.terminationReasonCode = 'target-failed';
    });
    const fake = evaluator(plan);
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'trace-only-run',
      bundleId: 'trace-only-bundle',
    });

    expect(bundle.coverage).toMatchObject({ eligible: 2, completed: 2, sourceUnavailable: 0 });
    expect(fake.state.recordContexts[0].bindings[0]).toMatchObject({
      sourceKind: 'trace',
      value: 'trace remains available',
    });
  });

  it('freezes binding closure before fail-fast admission', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.failure.failureMode = 'fail-fast';
      policy.evaluation.maxConcurrency = 1;
    });
    const completed = await sourceBundle(plan);
    const source = resealExecutionBundle(completed, (draft) => {
      const record = draft.records[1];
      if (record.executionStatus !== 'completed') throw new Error('unexpected source');
      delete record.output;
      draft.replayability = 'summary-only';
    });
    const fake = evaluator(plan, () => {
      throw new EvaluationPortFailure({
        code: 'terminal-evaluator-error',
        stage: 'evaluation',
        message: 'Do not retry.',
      });
    });
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'closure-run',
      bundleId: 'closure-bundle',
    });

    expect(bundle.coverage).toMatchObject({
      planned: 2,
      eligible: 1,
      sourceUnavailable: 1,
      started: 1,
      notStarted: 0,
    });
  });

  it('accepts a partial ExecutionBundle and preserves source-less not-evaluated facts', async () => {
    const plan = await makePlan();
    const completed = await sourceBundle(plan);
    const source = resealExecutionBundle(completed, (draft) => {
      draft.records = [draft.records[0]];
      draft.coverage = {
        ...draft.coverage,
        started: 1,
        succeeded: 1,
        notStarted: 1,
      };
      draft.executionBundleStatus = 'cancelled';
      draft.terminationReasonCode = 'partial-source';
    });
    const fake = evaluator(plan);
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'partial-run',
      bundleId: 'partial-bundle',
    });

    expect(parseEvaluationBundle(bundle, plan, source)).toEqual(bundle);
    expect(bundle.coverage).toMatchObject({ eligible: 1, sourceUnavailable: 1 });
    expect(bundle.records.find((record) => record.evaluationStatus === 'not-evaluated'))
      .not.toHaveProperty('sourceRecordDigest');
  });

  it('charges failed attempts and stops retries at the provider-cost boundary', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.evaluation.maxConcurrency = 1;
      policy.evaluation.budget.maxProviderCost = { amount: 1, currency: 'USD' };
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan, () => {
      throw new EvaluationPortFailure({
        code: 'timeout',
        stage: 'evaluation',
        message: 'Retryable but already paid.',
      }, {
        providerCost: { amount: 1, currency: 'USD', reportedByProvider: true },
      });
    });
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'failed-cost-run',
      bundleId: 'failed-cost-bundle',
    });
    const record = bundle.records[0];
    if (record.evaluationStatus === 'not-evaluated') throw new Error('unexpected status');

    expect(bundle.evaluationBundleStatus).toBe('budget-exhausted');
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0].usage?.providerCost?.amount).toBe(1);
  });

  it('waits for a timed-out evaluator to settle before disposal and retry', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.evaluation.timeoutMs = 5;
      policy.evaluation.maxConcurrency = 1;
    });
    const source = await sourceBundle(plan);
    let settled = false;
    let disposedBeforeSettlement = false;
    const fake = evaluator(plan, (_state, attempt) => new Promise((resolve) => {
      attempt.signal.addEventListener('abort', () => {
        setTimeout(() => {
          settled = true;
          resolve({ observations: [] });
        }, 0);
      }, { once: true });
    }));
    const originalOpenRun = fake.port.openRun.bind(fake.port);
    fake.port.openRun = async (context) => {
      const run = await originalOpenRun(context);
      return {
        ...run,
        async openRecord(recordContext) {
          const record = await run.openRecord(recordContext);
          return {
            ...record,
            async dispose() {
              if (!settled) disposedBeforeSettlement = true;
              await record.dispose();
            },
          };
        },
      };
    };
    await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'late-timeout-run',
      bundleId: 'late-timeout-bundle',
    });

    expect(settled).toBe(true);
    expect(disposedBeforeSettlement).toBe(false);
  });

  it('rejects cache records that violate the sealed metric contract', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
    });
    const source = await sourceBundle(plan);
    const cache = new MemoryCache();
    const first = evaluator(plan);
    await evaluateExecutionBundle(plan, source, ports(plan, first.port, { cache }), {
      runId: 'poison-cache-seed',
      bundleId: 'poison-cache-seed-bundle',
    });
    const entry = cache.entries.values().next().value;
    if (entry === undefined) throw new Error('missing cache entry');
    entry.record.observations[0].metricId = 'wrong-metric';
    entry.cachedRecordDigest = digestCanonicalJson(entry.record);
    const second = evaluator(plan);
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, second.port, { cache }), {
      runId: 'poison-cache-run',
      bundleId: 'poison-cache-bundle',
    });

    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluation-cache-read-failed',
    });
    expect(second.state.attempts).toBe(0);
  });

  it('does not upgrade imported source trust in native or replayed evaluation facts', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
    });
    const completed = await sourceBundle(plan);
    const source = resealExecutionBundle(completed, (draft) => {
      draft.provenance = { ...draft.provenance, provenanceKind: 'imported', trust: 'declared' };
      draft.records = draft.records.map((record) => ({
        ...record,
        provenance: { ...record.provenance, provenanceKind: 'imported', trust: 'declared' },
      }));
    });
    const cache = new MemoryCache();
    const first = evaluator(plan);
    const native = await evaluateExecutionBundle(plan, source, ports(plan, first.port, { cache }), {
      runId: 'declared-native-run',
      bundleId: 'declared-native-bundle',
    });
    const second = evaluator(plan);
    const replay = await evaluateExecutionBundle(plan, source, ports(plan, second.port, { cache }), {
      runId: 'declared-replay-run',
      bundleId: 'declared-replay-bundle',
    });

    expect(native.provenance.trust).toBe('declared');
    expect(native.records.every((record) => record.provenance.trust === 'declared')).toBe(true);
    expect(replay.records.every((record) => record.provenance.trust === 'declared')).toBe(true);
  });

  it('captures observation metadata under the same classification policy as evidence', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.evidence.maximumClassification = 'public';
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan, () => ({
      observations: [{
        metricId: 'correct',
        observationStatus: 'observed',
        valueType: 'boolean',
        value: true,
        metadata: {
          value: { credential: 'must-not-leak' },
          classification: 'secret',
        },
      }],
    }));
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'classified-metadata-run',
      bundleId: 'classified-metadata-bundle',
    });

    expect(bundle.records.every((record) => record.evaluationStatus === 'failed')).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain('must-not-leak');
  });

  it('uses one injected event sequence across execution and evaluation stages', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.eventDelivery.writerMode = 'optional';
    });
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const events: EvaluationEvent[] = [];
    const eventWriter = { async write(event: Readonly<EvaluationEvent>) { events.push(event); } };
    const source = await executeRunPlan(plan, {
      executors: new Map([['executor-alias', executor(plan)]]),
      clock: new FakeClock(),
      eventSequencer,
      eventWriter,
      contentStore: {
        async put(request) {
          return {
            mediaType: request.mediaType,
            digest: request.digest,
            uri: `memory:${request.digest}`,
          };
        },
      },
    }, { runId: 'joined-run', bundleId: 'joined-source-bundle' });
    const fake = evaluator(plan);
    await evaluateExecutionBundle(plan, source, ports(plan, fake.port, {
      eventSequencer,
      eventWriter,
    }), { runId: 'joined-run', bundleId: 'joined-evaluation-bundle' });

    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_event, index) => index),
    );
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
    expect(events.find((event) => event.eventKind === 'evaluation.run.started')?.sequence)
      .toBeGreaterThan(events.find((event) => event.eventKind === 'execution.run.completed')?.sequence ?? -1);
  });
});
