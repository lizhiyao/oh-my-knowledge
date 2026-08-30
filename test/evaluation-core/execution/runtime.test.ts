import { describe, expect, it } from 'vitest';
import {
  digestCanonicalJson,
  parseExecutionBundleDocument,
  verifyExecutionBundle,
  type EvaluationEvent,
  type RuntimeIdentity,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';
import { prepareEvaluationPlan } from '../../../src/evaluation-core/compiler/index.js';
import {
  ExecutionPortFailure,
  ExecutionRuntimeConfigurationError,
  InMemoryRuntimeEventSequencer,
  deriveExecutionSchedule,
  executeRunPlan,
  startExecution,
  type ExecutionCache,
  type ExecutionCacheEntry,
  type ExecutionClock,
  type ExecutionContentStore,
  type ExecutionExecutor,
  type ExecutionExecutorRun,
  type ExecutionExecutorTrial,
  type ExecutionRuntimePorts,
  type ExecutorAttemptContext,
  type ExecutorAttemptResult,
  type ExecutorRunContext,
  type ExecutorTrialContext,
} from '../../../src/evaluation-core/execution/index.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
  type TestRuntime,
} from '../compiler/fixtures.js';

type Plan = Awaited<ReturnType<typeof prepareEvaluationPlan>>;

class FakeClock implements ExecutionClock {
  now = 0;

  monotonicNow(): number {
    return this.now;
  }

  timestamp(): string {
    return new Date(Date.UTC(2026, 7, 29) + this.now).toISOString();
  }

  async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortFailure();
    this.now += delayMs;
    await Promise.resolve();
    if (signal.aborted) throw abortFailure();
  }
}

class ManualClock implements ExecutionClock {
  now = 0;
  readonly sleepers: Array<{
    due: number;
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
  }> = [];

  monotonicNow(): number {
    return this.now;
  }

  timestamp(): string {
    return new Date(Date.UTC(2026, 7, 29) + this.now).toISOString();
  }

  sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortFailure());
    return new Promise<void>((resolve, reject) => {
      const sleeper = { due: this.now + delayMs, resolve, reject, signal };
      this.sleepers.push(sleeper);
      signal.addEventListener('abort', () => {
        const index = this.sleepers.indexOf(sleeper);
        if (index >= 0) this.sleepers.splice(index, 1);
        reject(abortFailure());
      }, { once: true });
    });
  }

  advance(delayMs: number): void {
    this.now += delayMs;
    const ready = this.sleepers.filter((sleeper) => sleeper.due <= this.now);
    for (const sleeper of ready) {
      const index = this.sleepers.indexOf(sleeper);
      if (index >= 0) this.sleepers.splice(index, 1);
      if (!sleeper.signal.aborted) sleeper.resolve();
    }
  }
}

function abortFailure(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

class MemoryCache implements ExecutionCache {
  readonly entries = new Map<Sha256Digest, ExecutionCacheEntry>();
  gets = 0;
  puts = 0;

  async get(key: Sha256Digest): Promise<ExecutionCacheEntry | undefined> {
    this.gets += 1;
    return this.entries.get(key);
  }

  async put(entry: Readonly<ExecutionCacheEntry>): Promise<void> {
    this.puts += 1;
    this.entries.set(entry.cacheKeyDigest, structuredClone(entry));
  }
}

const contentStore: ExecutionContentStore = {
  async put(request) {
    return {
      mediaType: request.mediaType,
      digest: request.digest,
      size: JSON.stringify(request.value).length,
      uri: `memory:${request.digest}`,
    };
  },
};

interface ExecutorState {
  runOpens: number;
  runDisposals: number;
  trialOpens: number;
  trialDisposals: number;
  attempts: number;
  active: number;
  maxActive: number;
  trialContexts: ExecutorTrialContext[];
}

type AttemptHandler = (
  trial: ExecutorTrialContext,
  attempt: Readonly<ExecutorAttemptContext>,
) => Promise<ExecutorAttemptResult> | ExecutorAttemptResult;

function fakeExecutor(
  identity: RuntimeIdentity,
  handler: AttemptHandler = (trial) => ({
    output: {
      value: { answer: trial.targetId },
      classification: 'public',
    },
  }),
): { executor: ExecutionExecutor; state: ExecutorState } {
  const state: ExecutorState = {
    runOpens: 0,
    runDisposals: 0,
    trialOpens: 0,
    trialDisposals: 0,
    attempts: 0,
    active: 0,
    maxActive: 0,
    trialContexts: [],
  };
  const executor: ExecutionExecutor = {
    identity,
    async openRun(_context: Readonly<ExecutorRunContext>): Promise<ExecutionExecutorRun> {
      state.runOpens += 1;
      return {
        async openTrial(context: Readonly<ExecutorTrialContext>): Promise<ExecutionExecutorTrial> {
          state.trialOpens += 1;
          state.trialContexts.push(context as ExecutorTrialContext);
          return {
            async execute(attempt): Promise<ExecutorAttemptResult> {
              state.attempts += 1;
              state.active += 1;
              state.maxActive = Math.max(state.maxActive, state.active);
              try {
                return await handler(context as ExecutorTrialContext, attempt);
              } finally {
                state.active -= 1;
              }
            },
            async dispose() {
              state.trialDisposals += 1;
            },
          };
        },
        async dispose() {
          state.runDisposals += 1;
        },
      };
    },
  };
  return { executor, state };
}

async function makePlan(
  mutate?: (definition: ReturnType<typeof validDefinition>, policy: ReturnType<typeof validPolicy>) => void,
  runtime: TestRuntime = testRuntime(),
): Promise<Plan> {
  const definition = validDefinition();
  const policy = validPolicy();
  delete policy.execution.timeoutMs;
  mutate?.(definition, policy);
  const targetIds = new Set(definition.targets.map((target) => target.targetId));
  const slotTargetIds = new Set(
    definition.experiment.randomizationSlots.map((slot) => slot.targetId),
  );
  if (targetIds.size !== slotTargetIds.size
      || [...targetIds].some((targetId) => !slotTargetIds.has(targetId))) {
    definition.experiment.randomizationSlots = definition.targets
      .map((target, index) => ({
        targetId: target.targetId,
        randomizationSlotId: `slot-${String(index).padStart(4, '0')}`,
      }));
  }
  return prepareEvaluationPlan(definition, policy, runtime);
}

function expectedExecutorIdentity(plan: Plan): RuntimeIdentity {
  const runtime = plan.execution.runtimes.find((candidate) => (
    candidate.runtimeKind === 'executor' && candidate.referenceId === 'control'
  ));
  if (runtime === undefined) throw new Error('missing Runtime identity');
  return structuredClone(runtime.identity) as RuntimeIdentity;
}

function targetExecutorBindings(
  plan: Plan,
  executor: ExecutionExecutor,
): ReadonlyMap<string, ExecutionExecutor> {
  return new Map(plan.execution.targets.map((target) => [target.targetId, executor]));
}

function portsFor(
  plan: Plan,
  handler?: AttemptHandler,
  overrides: Partial<ExecutionRuntimePorts> = {},
) {
  const { executor, state } = fakeExecutor(expectedExecutorIdentity(plan), handler);
  const ports: ExecutionRuntimePorts = {
    executorsByTargetId: targetExecutorBindings(plan, executor),
    clock: new FakeClock(),
    eventSequencer: new InMemoryRuntimeEventSequencer(),
    contentStore,
    ...overrides,
  };
  return { ports, state };
}

describe('Evaluation Core Execution runtime', () => {
  it('executes a sealed plan without exposing Gold and materializes a valid Bundle', async () => {
    const plan = await makePlan();
    const { ports, state } = portsFor(plan);
    const run = startExecution(plan, ports, {
      runId: 'run-success',
      bundleId: 'bundle-success',
      eventBufferCapacity: 1,
    });
    const bundle = await run.result;
    const retainedEvents: EvaluationEvent[] = [];
    for await (const event of run.events) retainedEvents.push(event);

    expect(bundle.executionBundleStatus).toBe('completed');
    expect(retainedEvents).toHaveLength(1);
    expect(retainedEvents[0].eventKind).toBe('execution.run.completed');
    expect(() => run.events[Symbol.asyncIterator]()).toThrow(TypeError);
    expect(bundle.coverage).toEqual({
      planned: 2,
      started: 2,
      succeeded: 2,
      failed: 0,
      cancelled: 0,
      budgetCensored: 0,
      notStarted: 0,
    });
    expect(bundle.replayability).toBe('self-contained');
    expect(state).toMatchObject({
      runOpens: 2,
      runDisposals: 2,
      trialOpens: 2,
      trialDisposals: 2,
      attempts: 2,
    });
    for (const context of state.trialContexts) {
      expect(Object.isFrozen(context)).toBe(true);
      expect(context).not.toHaveProperty('expected');
      expect(context).not.toHaveProperty('evaluationContext');
      expect(context).not.toHaveProperty('annotations');
      expect(context.trialSeed).toMatch(/^sha256:/);
    }
  });

  it('derives stable sequential, interleaved, and randomized admission schedules', async () => {
    const sequential = await makePlan((definition) => {
      definition.dataset.samples.push({
        ...structuredClone(definition.dataset.samples[0]),
        sampleId: 'sample-2',
      });
      definition.experiment.scheduling = { schedulingKind: 'sequential' };
    });
    const interleaved = await makePlan((definition) => {
      definition.dataset.samples.push({
        ...structuredClone(definition.dataset.samples[0]),
        sampleId: 'sample-2',
      });
      definition.experiment.scheduling = { schedulingKind: 'interleaved' };
    });
    const randomized = await makePlan((definition) => {
      definition.dataset.samples.push({
        ...structuredClone(definition.dataset.samples[0]),
        sampleId: 'sample-2',
      });
      definition.experiment.scheduling = {
        schedulingKind: 'randomized-block',
        blockSize: 2,
      };
    });

    expect(deriveExecutionSchedule(sequential).flatMap((block) => (
      block.coordinates.map((coordinate) => `${coordinate.targetId}/${coordinate.sampleId}`)
    ))).toEqual([
      'control/sample-1',
      'control/sample-2',
      'treatment/sample-1',
      'treatment/sample-2',
    ]);
    expect(deriveExecutionSchedule(interleaved).flatMap((block) => (
      block.coordinates.map((coordinate) => `${coordinate.targetId}/${coordinate.sampleId}`)
    ))).toEqual([
      'control/sample-1',
      'treatment/sample-1',
      'control/sample-2',
      'treatment/sample-2',
    ]);
    expect(deriveExecutionSchedule(randomized)).toEqual(deriveExecutionSchedule(randomized));
    expect(new Set(deriveExecutionSchedule(randomized).flatMap((block) => (
      block.coordinates.map((coordinate) => coordinate.trialId)
    ))).size).toBe(4);
  });

  it('keeps controlled seeds and admission order stable across a declared subject rename', async () => {
    const configure = (definition: ReturnType<typeof validDefinition>): void => {
      definition.dataset.samples.push({
        ...structuredClone(definition.dataset.samples[0]),
        sampleId: 'sample-2',
      });
      definition.experiment.scheduling = {
        schedulingKind: 'randomized-block',
        blockSize: 2,
      };
    };
    const original = await makePlan(configure);
    const renamed = await makePlan((definition) => {
      configure(definition);
      definition.targets[1] = {
        ...definition.targets[1],
        targetId: 'candidate-v2',
        config: { revision: 2 },
      };
      definition.comparisons[0] = {
        ...definition.comparisons[0],
        treatmentTargetIds: ['candidate-v2'],
      };
      definition.experiment.randomizationSlots[1] = {
        targetId: 'candidate-v2',
        randomizationSlotId: 'slot-treatment',
      };
    });
    const randomizationProjection = (plan: Plan) => deriveExecutionSchedule(plan).flatMap(
      (block) => block.coordinates.map((coordinate) => ({
        trialIndex: coordinate.trialIndex,
        sampleId: coordinate.sampleId,
        randomizationSlotId: coordinate.randomizationSlotId,
        trialSeed: coordinate.trialSeed,
      })),
    );

    expect(renamed.execution.executionPlanDigest).not.toBe(
      original.execution.executionPlanDigest,
    );
    expect(renamed.execution.randomizationDesignDigest).toBe(
      original.execution.randomizationDesignDigest,
    );
    expect(randomizationProjection(renamed)).toEqual(randomizationProjection(original));
  });

  it('retries only within one trial identity and disposes one trial session', async () => {
    const plan = await makePlan((definition) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
    });
    let calls = 0;
    const { ports, state } = portsFor(plan, () => {
      calls += 1;
      if (calls === 1) {
        throw new ExecutionPortFailure({
          code: 'timeout',
          stage: 'infrastructure',
          message: 'retry me',
        });
      }
      return {
        output: { value: { answer: 'ok' }, classification: 'public' },
      };
    });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-retry',
      bundleId: 'bundle-retry',
    });

    const record = bundle.records[0];
    if (record.executionStatus !== 'completed') throw new Error('expected completed record');
    expect(record.attempts).toHaveLength(2);
    expect(new Set(record.attempts.map((attempt) => attempt.attemptId)).size).toBe(2);
    expect(record.trialId).toBe(state.trialContexts[0].trialId);
    expect(state.trialOpens).toBe(1);
    expect(state.trialDisposals).toBe(1);
  });

  it('retains exact per-attempt usage when retry costs cannot be aggregated', async () => {
    const plan = await makePlan((definition) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
    });
    let calls = 0;
    const { ports } = portsFor(plan, () => {
      calls += 1;
      if (calls === 1) {
        throw new ExecutionPortFailure({
          code: 'timeout',
          stage: 'infrastructure',
          message: 'retry me',
        }, {
          inputTokens: 1,
          providerCost: { amount: 0.1, currency: 'EUR', reportedByProvider: true },
          details: { requestId: 'first' },
        });
      }
      return {
        output: { value: { answer: 'ok' }, classification: 'public' },
        usage: {
          outputTokens: 2,
          providerCost: { amount: 0.2, currency: 'USD', reportedByProvider: true },
          details: { requestId: 'second' },
        },
      };
    });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-mixed-currency',
      bundleId: 'bundle-mixed-currency',
    });

    const record = bundle.records[0];
    if (record.executionStatus !== 'completed') throw new Error('expected completed record');
    expect(record.attempts[0].usage).toMatchObject({
      providerCost: { amount: 0.1, currency: 'EUR' },
      details: { requestId: 'first' },
    });
    expect(record.attempts[1].usage).toMatchObject({
      providerCost: { amount: 0.2, currency: 'USD' },
      details: { requestId: 'second' },
    });
    expect(record.usage).toMatchObject({
      inputTokens: 1,
      outputTokens: 2,
      details: {
        aggregationKind: 'omk.execution-usage-summary/v1',
        attemptCount: 2,
        reportedAttemptCount: 2,
        providerCostAggregation: 'mixed-currency',
      },
    });
    expect(record.usage?.providerCost).toBeUndefined();
  });

  it('reuses one isolated omk.session/v1 trial across retry attempts', async () => {
    const plan = await makePlan((definition) => {
      definition.targets = [{
        ...definition.targets[0],
        protocolId: 'omk.session/v1',
      }];
      definition.comparisons = [];
    }, testRuntime({
      executorProtocols: ['omk.invoke/v1', 'omk.session/v1'],
      trialState: 'isolated',
      traceCapability: 'optional',
    }));
    let calls = 0;
    const { ports, state } = portsFor(plan, (trial) => {
      expect(trial.protocolId).toBe('omk.session/v1');
      calls += 1;
      if (calls === 1) {
        throw new ExecutionPortFailure({
          code: 'timeout',
          stage: 'infrastructure',
          message: 'retry session turn',
        });
      }
      return {
        output: {
          value: { messages: [{ role: 'assistant', content: 'done' }] },
          classification: 'public',
        },
        trace: {
          value: { toolCalls: [{ name: 'search', status: 'completed' }] },
          classification: 'public',
        },
      };
    });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-session-retry',
      bundleId: 'bundle-session-retry',
    });

    expect(bundle.executionBundleStatus).toBe('completed');
    expect(bundle.records[0].executionStatus).toBe('completed');
    expect(state).toMatchObject({ trialOpens: 1, attempts: 2, trialDisposals: 1 });
  });

  it('records timeout once even when an Executor returns success after observing abort', async () => {
    const events: EvaluationEvent[] = [];
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.execution.timeoutMs = 25;
      policy.retry.maxAttempts = 1;
      policy.eventDelivery.writerMode = 'optional';
    });
    const { ports, state } = portsFor(plan, async (_trial, attempt) => {
      await new Promise<void>((resolve) => {
        attempt.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        output: { value: { late: true }, classification: 'public' },
        usage: { inputTokens: 1 },
      };
    }, {
      eventWriter: {
        async write(event) {
          events.push(structuredClone(event));
        },
      },
    });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-timeout',
      bundleId: 'bundle-timeout',
    });

    const record = bundle.records[0];
    expect(record.executionStatus).toBe('failed');
    if (record.executionStatus !== 'failed') throw new Error('expected failed record');
    expect(record.error.code).toBe('timeout');
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]).toMatchObject({
      attemptStatus: 'failed',
      error: { code: 'timeout' },
    });
    expect('output' in record).toBe(false);
    expect(record.usage?.inputTokens).toBe(1);
    expect(state.attempts).toBe(1);
    expect(events.filter((event) => (
      event.eventKind === 'execution.attempt.completed'
    ))).toHaveLength(1);
  });

  it('censors the next whole paired block before opening an Executor when budget is insufficient', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.dataset.samples.push({
        ...structuredClone(definition.dataset.samples[0]),
        sampleId: 'sample-2',
      });
      definition.experiment.sampling.pairingKey = '/input/cohort';
      definition.experiment.sampling.resamplingUnit = 'paired-block';
      policy.budget.stages.execution.maxInvocations = 3;
    }, testRuntime({ samplingResamplingUnits: ['paired-block'] }));
    const { ports, state } = portsFor(plan);
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-budget',
      bundleId: 'bundle-budget',
    });

    expect(bundle.executionBundleStatus).toBe('budget-exhausted');
    expect(bundle.coverage).toMatchObject({
      planned: 4,
      started: 2,
      succeeded: 2,
      budgetCensored: 2,
    });
    const censored = bundle.records.filter((record) => (
      record.executionStatus === 'budget-censored'
    ));
    expect(new Set(censored.map((record) => record.schedulingBlockId)).size).toBe(1);
    expect(state.runOpens).toBe(2);
    expect(state.attempts).toBe(2);
  });

  it('returns an honest partial cancelled Bundle and isolates uncontrolled seed designs', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.experiment.sampling.seedCoupling = 'uncontrolled';
      policy.execution.maxConcurrency = 1;
    }, testRuntime({ deterministic: false, seedControl: 'unsupported' }));
    const controller = new AbortController();
    const { ports, state } = portsFor(plan, (_trial, attempt) => {
      controller.abort();
      if (attempt.signal.aborted) throw abortFailure();
      return {};
    });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-cancelled',
      bundleId: 'bundle-cancelled',
      signal: controller.signal,
    });

    expect(bundle.executionBundleStatus).toBe('cancelled');
    expect(bundle.coverage.cancelled).toBeGreaterThan(0);
    expect(bundle.coverage.notStarted).toBeGreaterThan(0);
    expect(state.trialContexts[0]).not.toHaveProperty('trialSeed');
    expect(plan.execution.experiment.sampling.seedCoupling).toBe('uncontrolled');
  });

  it('isolates cancellation and resource ownership across concurrent Runs', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.retry.maxAttempts = 1;
    });
    const identity = expectedExecutorIdentity(plan);
    let runCount = 0;
    let runDisposals = 0;
    let trialDisposals = 0;
    let resolveBothOpened: (() => void) | undefined;
    const bothOpened = new Promise<void>((resolve) => {
      resolveBothOpened = resolve;
    });
    const executor: ExecutionExecutor = {
      identity,
      async openRun(context) {
        runCount += 1;
        if (runCount === 2) resolveBothOpened?.();
        const shouldWaitForCancellation = context.runId === 'run-isolated-cancelled';
        return {
          async openTrial() {
            return {
              async execute(attempt) {
                if (shouldWaitForCancellation) {
                  await new Promise<void>((resolve) => {
                    attempt.signal.addEventListener('abort', () => resolve(), { once: true });
                  });
                  throw abortFailure();
                }
                return {
                  output: { value: { runId: context.runId }, classification: 'public' },
                };
              },
              async dispose() {
                trialDisposals += 1;
              },
            };
          },
          async dispose() {
            runDisposals += 1;
          },
        };
      },
    };
    const controller = new AbortController();
    const ports: ExecutionRuntimePorts = {
      executorsByTargetId: targetExecutorBindings(plan, executor),
      clock: new FakeClock(),
      eventSequencer: new InMemoryRuntimeEventSequencer(),
      contentStore,
    };
    const cancelledRun = startExecution(plan, ports, {
      runId: 'run-isolated-cancelled',
      bundleId: 'bundle-isolated-cancelled',
      signal: controller.signal,
    });
    const completedRun = startExecution(plan, ports, {
      runId: 'run-isolated-completed',
      bundleId: 'bundle-isolated-completed',
    });
    await bothOpened;
    controller.abort();
    const [cancelled, completed] = await Promise.all([
      cancelledRun.result,
      completedRun.result,
    ]);

    expect(cancelled.executionBundleStatus).toBe('cancelled');
    expect(completed.executionBundleStatus).toBe('completed');
    expect(runCount).toBe(2);
    expect(runDisposals).toBe(2);
    expect(trialDisposals).toBe(2);
  });

  it('honors serialized Runtime capability even when global concurrency is higher', async () => {
    const plan = await makePlan(undefined, testRuntime({
      concurrencySafety: 'serialized',
      maxInFlight: 1,
    }));
    const { ports, state } = portsFor(plan, async (trial) => {
      await Promise.resolve();
      return {
        output: { value: { answer: trial.targetId }, classification: 'public' },
      };
    });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-serialized',
      bundleId: 'bundle-serialized',
    });

    expect(bundle.executionBundleStatus).toBe('completed');
    expect(state.maxActive).toBe(1);
  });

  it('reuses deterministic cache records without a second Executor invocation', async () => {
    const cache = new MemoryCache();
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.cache.executionMode = 'transparent-deterministic';
    });
    const { ports, state } = portsFor(plan, undefined, { cache });
    const first = await executeRunPlan(plan, ports, {
      runId: 'run-cache-1',
      bundleId: 'bundle-cache-1',
    });
    const second = await executeRunPlan(plan, ports, {
      runId: 'run-cache-2',
      bundleId: 'bundle-cache-2',
    });

    expect(first.records[0].executionStatus).toBe('completed');
    expect(second.records[0].executionStatus).toBe('completed');
    if (second.records[0].executionStatus === 'budget-censored') throw new Error('unexpected');
    expect(second.records[0].cache.cacheStatus).toBe('transparent-hit');
    const sourceRecordDigest = second.records[0].cache.sourceRecordDigest;
    if (sourceRecordDigest === undefined) throw new Error('missing cache receipt');
    expect(verifyExecutionBundle(second, plan).planVerification).toMatchObject({
      cacheReceiptStatus: 'indeterminate',
      minimumTargetInvocations: 0,
      maximumTargetInvocations: 1,
      unverifiedCacheRecordDigests: [sourceRecordDigest],
    });
    expect(verifyExecutionBundle(second, plan, {
      verifiedCacheRecordDigests: new Set<Sha256Digest>([
        sourceRecordDigest as Sha256Digest,
      ]),
    }).planVerification).toMatchObject({
      cacheReceiptStatus: 'verified',
      minimumTargetInvocations: 0,
      maximumTargetInvocations: 0,
      unverifiedCacheRecordDigests: [],
    });
    expect(state.attempts).toBe(1);
    expect(cache.puts).toBe(1);
    expect(cache.gets).toBe(2);
  });

  it('fails closed when a cached record claims a different randomization slot', async () => {
    const cache = new MemoryCache();
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.cache.executionMode = 'transparent-deterministic';
    });
    const seeded = portsFor(plan, undefined, { cache });
    await executeRunPlan(plan, seeded.ports, {
      runId: 'run-cache-slot-seed',
      bundleId: 'bundle-cache-slot-seed',
    });
    const entry = cache.entries.values().next().value;
    if (entry === undefined) throw new Error('missing cache entry');
    entry.record.randomizationSlotId = 'slot-forged';
    entry.sourceRecordDigest = digestCanonicalJson(entry.record);

    const replayed = portsFor(plan, undefined, { cache });
    const bundle = await executeRunPlan(plan, replayed.ports, {
      runId: 'run-cache-slot-replay',
      bundleId: 'bundle-cache-slot-replay',
    });

    expect(bundle).toMatchObject({
      executionBundleStatus: 'failed',
      terminationReasonCode: 'execution-cache-read-failed',
    });
    expect(replayed.state.attempts).toBe(0);
  });

  it('fails closed on a cached attempt chain that violates the sealed retry policy', async () => {
    const cache = new MemoryCache();
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.cache.executionMode = 'transparent-deterministic';
    });
    const seeded = portsFor(plan, undefined, { cache });
    await executeRunPlan(plan, seeded.ports, {
      runId: 'run-cache-attempt-seed',
      bundleId: 'bundle-cache-attempt-seed',
    });
    const entry = cache.entries.values().next().value;
    if (entry === undefined) throw new Error('missing cache entry');
    entry.record.attempts[0].attemptNumber = 2;
    entry.sourceRecordDigest = digestCanonicalJson(entry.record);

    const replayed = portsFor(plan, undefined, { cache });
    const bundle = await executeRunPlan(plan, replayed.ports, {
      runId: 'run-cache-attempt-replay',
      bundleId: 'bundle-cache-attempt-replay',
    });

    expect(bundle).toMatchObject({
      executionBundleStatus: 'failed',
      terminationReasonCode: 'execution-cache-read-failed',
    });
    expect(replayed.state.attempts).toBe(0);
  });

  it.each(['missing', 'currency', 'exhausted'] as const)(
    'fails closed when cached %s cost facts violate the sealed provider budget',
    async (poison) => {
      const cache = new MemoryCache();
      const plan = await makePlan((definition, policy) => {
        definition.targets = [definition.targets[0]];
        definition.comparisons = [];
        policy.cache.executionMode = 'transparent-deterministic';
        policy.budget.stages.execution.maxProviderCost = { amount: 10, currency: 'USD' };
      });
      const seeded = portsFor(plan, () => ({
        output: { value: { answer: 'seed' }, classification: 'public' },
        usage: {
          providerCost: { amount: 0.25, currency: 'USD', reportedByProvider: true },
        },
      }), { cache });
      await executeRunPlan(plan, seeded.ports, {
        runId: 'run-cache-cost-seed',
        bundleId: 'bundle-cache-cost-seed',
      });
      const entry = cache.entries.values().next().value;
      if (entry === undefined) throw new Error('missing cache entry');
      if (poison === 'missing') {
        delete entry.record.attempts[0].usage;
        delete entry.record.usage;
      } else {
        const attemptCost = entry.record.attempts[0].usage?.providerCost;
        const aggregateCost = entry.record.usage?.providerCost;
        if (attemptCost === undefined || aggregateCost === undefined) {
          throw new Error('missing seeded provider cost');
        }
        if (poison === 'currency') {
          attemptCost.currency = 'EUR';
          aggregateCost.currency = 'EUR';
        } else {
          attemptCost.amount = 10;
          aggregateCost.amount = 10;
        }
      }
      entry.sourceRecordDigest = digestCanonicalJson(entry.record);

      const replayed = portsFor(plan, undefined, { cache });
      const bundle = await executeRunPlan(plan, replayed.ports, {
        runId: `run-cache-cost-${poison}-replay`,
        bundleId: `bundle-cache-cost-${poison}-replay`,
      });

      expect(bundle).toMatchObject({
        executionBundleStatus: 'failed',
        terminationReasonCode: 'execution-cache-read-failed',
      });
      expect(replayed.state.attempts).toBe(0);
    },
  );

  it('does not cache a completed record when sealed provider-cost auditing fails', async () => {
    const cache = new MemoryCache();
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.cache.executionMode = 'transparent-deterministic';
      policy.budget.stages.execution.maxProviderCost = { amount: 1, currency: 'USD' };
    });
    const { ports, state } = portsFor(plan, (trial) => ({
      output: { value: { answer: trial.targetId }, classification: 'public' },
      usage: { inputTokens: 1 },
    }), { cache });
    const first = await executeRunPlan(plan, ports, {
      runId: 'run-cache-ineligible-1',
      bundleId: 'bundle-cache-ineligible-1',
    });
    const second = await executeRunPlan(plan, ports, {
      runId: 'run-cache-ineligible-2',
      bundleId: 'bundle-cache-ineligible-2',
    });

    expect(first.executionBundleStatus).toBe('failed');
    expect(second.executionBundleStatus).toBe('failed');
    expect(first.terminationReasonCode).toBe('provider-cost-unreported');
    expect(second.terminationReasonCode).toBe('provider-cost-unreported');
    expect(cache.puts).toBe(0);
    expect(cache.entries.size).toBe(0);
    expect(state.attempts).toBe(2);
  });

  it('fails closed on a corrupt cache entry before opening an Executor', async () => {
    const cache: ExecutionCache = {
      async get(cacheKeyDigest) {
        return {
          cacheKeyDigest,
          sourceRecordDigest: `sha256:${'0'.repeat(64)}`,
          record: {} as ExecutionCacheEntry['record'],
        };
      },
      async put() {
        throw new Error('unexpected cache write');
      },
    };
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.cache.executionMode = 'transparent-deterministic';
    });
    const { ports, state } = portsFor(plan, undefined, { cache });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-corrupt-cache',
      bundleId: 'bundle-corrupt-cache',
    });

    expect(bundle.executionBundleStatus).toBe('failed');
    expect(bundle.terminationReasonCode).toBe('execution-cache-read-failed');
    expect(bundle.coverage).toMatchObject({ started: 0, notStarted: 1 });
    expect(state.runOpens).toBe(0);
  });

  it('fails closed on a replay-only cache miss without invoking an Executor', async () => {
    const cache = new MemoryCache();
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.cache.executionMode = 'replay-only';
    });
    const { ports, state } = portsFor(plan, undefined, { cache });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-replay-miss',
      bundleId: 'bundle-replay-miss',
    });

    expect(bundle.executionBundleStatus).toBe('failed');
    expect(bundle.terminationReasonCode).toBe('execution-cache-miss');
    expect(bundle.coverage).toMatchObject({ started: 0, notStarted: 1 });
    expect(state.attempts).toBe(0);
  });

  it('stops new admission after auditable provider-cost overshoot', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.dataset.samples.push({
        ...structuredClone(definition.dataset.samples[0]),
        sampleId: 'sample-2',
      });
      policy.budget.stages.execution.maxProviderCost = { amount: 1, currency: 'USD' };
      policy.execution.maxConcurrency = 2;
    });
    const { ports, state } = portsFor(plan, (trial) => ({
      output: { value: { answer: trial.targetId }, classification: 'public' },
      usage: {
        providerCost: { amount: 0.6, currency: 'USD', reportedByProvider: true },
      },
    }));
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-provider-budget',
      bundleId: 'bundle-provider-budget',
    });

    expect(bundle.executionBundleStatus).toBe('budget-exhausted');
    expect(bundle.coverage).toMatchObject({
      planned: 4,
      started: 2,
      succeeded: 2,
      budgetCensored: 2,
    });
    expect(verifyExecutionBundle(bundle, plan).planVerification).toMatchObject({
      providerCostBudgetStatus: 'verified',
      minimumProviderCost: { amount: 1.2, currency: 'USD' },
      maximumProviderCost: { amount: 1.2, currency: 'USD' },
    });
    expect(state.attempts).toBe(2);
  });

  it('uses the injected monotonic clock to stop admission at the duration budget', async () => {
    const clock = new ManualClock();
    const plan = await makePlan((definition, policy) => {
      definition.dataset.samples.push({
        ...structuredClone(definition.dataset.samples[0]),
        sampleId: 'sample-2',
      });
      policy.budget.stages.execution.maxActiveDurationMs = 50;
      policy.execution.maxConcurrency = 1;
    });
    let advanced = false;
    const { ports, state } = portsFor(plan, (trial) => {
      if (!advanced) {
        advanced = true;
        clock.advance(50);
      }
      return {
        output: { value: { answer: trial.targetId }, classification: 'public' },
      };
    }, { clock });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-duration-budget',
      bundleId: 'bundle-duration-budget',
    });

    expect(bundle.executionBundleStatus).toBe('budget-exhausted');
    expect(bundle.terminationReasonCode).toBe('stage-active-duration-budget-exhausted');
    expect(bundle.coverage).toMatchObject({ started: 1, budgetCensored: 3 });
    expect(state.attempts).toBe(1);
    expect(clock.sleepers).toHaveLength(0);
  });

  it('applies fail-fast only to future admission and tears down the failed trial', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.execution.maxConcurrency = 1;
      policy.retry.maxAttempts = 1;
      policy.failure.failureMode = 'fail-fast';
    });
    const { ports, state } = portsFor(plan, () => {
      throw new ExecutionPortFailure({
        code: 'non-retryable',
        stage: 'execution',
        message: 'stop after this admitted trial',
      });
    });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-fail-fast',
      bundleId: 'bundle-fail-fast',
    });

    expect(bundle.executionBundleStatus).toBe('failed');
    expect(bundle.terminationReasonCode).toBe('failure-policy-fail-fast');
    expect(bundle.coverage).toMatchObject({ started: 1, failed: 1, notStarted: 1 });
    expect(state).toMatchObject({
      attempts: 1,
      trialOpens: 1,
      trialDisposals: 1,
      runDisposals: 1,
    });
  });

  it('materializes reference evidence through a digest-bound ContentStore', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.evidence.output = 'reference';
      policy.evidence.trace = 'none';
    });
    const { ports } = portsFor(plan);
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-reference',
      bundleId: 'bundle-reference',
    });
    const record = bundle.records[0];
    if (record.executionStatus !== 'completed') throw new Error('expected completed record');

    expect(bundle.replayability).toBe('resolvable');
    expect(record.output?.contentKind).toBe('descriptor');
    if (record.output?.contentKind !== 'descriptor') throw new Error('expected descriptor');
    expect(record.output.descriptor.digest).toBe(digestCanonicalJson({ answer: 'control' }));
  });

  it('omits content above the sealed classification ceiling and strips raw port errors', async () => {
    const contentPlan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.evidence.maximumClassification = 'public';
      policy.evidence.trace = 'none';
    });
    const contentPorts = portsFor(contentPlan, () => ({
      output: { value: { password: 'do-not-leak' }, classification: 'secret' },
    })).ports;
    const contentBundle = await executeRunPlan(contentPlan, contentPorts, {
      runId: 'run-classification',
      bundleId: 'bundle-classification',
    });
    const contentRecord = contentBundle.records[0];
    if (contentRecord.executionStatus !== 'completed') throw new Error('expected completed');
    expect(contentRecord.output).toBeUndefined();
    expect(contentBundle.replayability).toBe('summary-only');
    expect(JSON.stringify(contentBundle)).not.toContain('do-not-leak');

    const errorPlan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.retry.maxAttempts = 1;
    });
    const errorPorts = portsFor(errorPlan, () => {
      throw new ExecutionPortFailure({
        code: 'provider-failed',
        stage: 'execution',
        message: 'credential do-not-leak',
        details: { credential: 'do-not-leak' },
      });
    }).ports;
    const errorBundle = await executeRunPlan(errorPlan, errorPorts, {
      runId: 'run-redacted-error',
      bundleId: 'bundle-redacted-error',
    });
    expect(JSON.stringify(errorBundle)).not.toContain('do-not-leak');
    expect(parseExecutionBundleDocument(errorBundle)).toEqual(errorBundle);
  });

  it('materializes digest-only and omitted output without retaining the raw value', async () => {
    for (const mode of ['digest', 'none'] as const) {
      const plan = await makePlan((definition, policy) => {
        definition.targets = [definition.targets[0]];
        definition.comparisons = [];
        definition.evaluators[0].inputs = [{
          bindingId: 'gold',
          sourceKind: 'expected',
          pointer: '/answer',
        }];
        policy.evidence.output = mode;
        policy.evidence.trace = 'none';
      });
      const { ports } = portsFor(plan, () => ({
        output: { value: { privateValue: 42 }, classification: 'sensitive' },
      }));
      const bundle = await executeRunPlan(plan, ports, {
        runId: `run-capture-${mode}`,
        bundleId: `bundle-capture-${mode}`,
      });
      const record = bundle.records[0];
      if (record.executionStatus !== 'completed') throw new Error('expected completed');
      if (mode === 'digest') {
        expect(record.output).toEqual({
          contentKind: 'digest-only',
          classification: 'sensitive',
          digest: digestCanonicalJson({ privateValue: 42 }),
        });
      } else {
        expect(record.output).toBeUndefined();
      }
      expect(JSON.stringify(bundle)).not.toContain('privateValue');
    }
  });

  it('makes a terminal EventWriter failure a run-level failed Bundle after all trials settle', async () => {
    const written: EvaluationEvent[] = [];
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.eventDelivery.writerMode = 'required';
      policy.eventDelivery.writerFailureMode = 'fail-run';
    });
    const { ports } = portsFor(plan, undefined, {
      eventWriter: {
        async write(event) {
          if (event.eventKind === 'execution.run.completed') throw new Error('writer down');
          written.push(structuredClone(event));
        },
      },
    });
    const run = startExecution(plan, ports, {
      runId: 'run-writer-failure',
      bundleId: 'bundle-writer-failure',
    });
    const bundle = await run.result;
    const journal: EvaluationEvent[] = [];
    for await (const event of run.events) journal.push(event);

    expect(bundle.executionBundleStatus).toBe('failed');
    expect(bundle.terminationReasonCode).toBe('event-writer-failed');
    expect(bundle.coverage.succeeded).toBe(1);
    expect(bundle.coverage.notStarted).toBe(0);
    expect(written.length).toBeGreaterThan(0);
    const terminals = journal.filter((event) => event.eventKind.startsWith('execution.run.')
      && event.eventKind !== 'execution.run.started');
    expect(terminals).toEqual([expect.objectContaining({
      eventKind: 'execution.run.failed',
      data: expect.objectContaining({ bundleDigest: bundle.bundleDigest }),
    })]);
  });

  it.each([
    ['cancelled', 'execution.run.cancelled'],
    ['budget-exhausted', 'execution.run.budget-exhausted'],
  ] as const)('lets terminal EventWriter failure override an existing %s execution stop', async (
    stopStatus,
    rejectedEventKind,
  ) => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.eventDelivery.writerMode = 'optional';
      policy.eventDelivery.writerFailureMode = 'fail-run';
      if (stopStatus === 'budget-exhausted') {
        policy.budget.run.maxWallClockMs = 1;
      }
    });
    const controller = new AbortController();
    if (stopStatus === 'cancelled') controller.abort();
    const { ports } = portsFor(plan, undefined, {
      eventWriter: {
        async write(event) {
          if (event.eventKind === rejectedEventKind) throw new Error('terminal writer failed');
        },
      },
    });
    const bundle = await executeRunPlan(plan, ports, {
      runId: `execution-terminal-precedence-${stopStatus}-run`,
      bundleId: `execution-terminal-precedence-${stopStatus}-bundle`,
      signal: controller.signal,
    });

    expect(bundle).toMatchObject({
      executionBundleStatus: 'failed',
      terminationReasonCode: 'event-writer-failed',
    });
  });

  it('does not open Target resources when the required EventWriter fails at run start', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.eventDelivery.writerMode = 'required';
      policy.eventDelivery.writerFailureMode = 'fail-run';
    });
    const { ports, state } = portsFor(plan, undefined, {
      eventWriter: {
        async write() {
          throw new Error('writer down');
        },
      },
    });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-writer-start-failure',
      bundleId: 'bundle-writer-start-failure',
    });

    expect(bundle.executionBundleStatus).toBe('failed');
    expect(bundle.coverage).toMatchObject({ started: 0, notStarted: 1 });
    expect(state.runOpens).toBe(0);
    expect(state.attempts).toBe(0);
  });

  it('does not invoke a Target when durable trial admission cannot be written', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.eventDelivery.writerMode = 'required';
      policy.eventDelivery.writerFailureMode = 'fail-run';
    });
    const { ports, state } = portsFor(plan, undefined, {
      eventWriter: {
        async write(event) {
          if (event.eventKind === 'execution.trial.started') {
            throw new Error('writer down');
          }
        },
      },
    });
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-writer-trial-failure',
      bundleId: 'bundle-writer-trial-failure',
    });

    expect(bundle.executionBundleStatus).toBe('failed');
    expect(bundle.coverage).toMatchObject({ started: 0, notStarted: 1 });
    expect(state).toMatchObject({ runOpens: 0, trialOpens: 0, attempts: 0 });
  });

  it('applies blocking EventWriter backpressure before Target admission', async () => {
    let releaseWriter: (() => void) | undefined;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.eventDelivery.writerMode = 'required';
      policy.eventDelivery.writerFailureMode = 'fail-run';
    });
    const { ports, state } = portsFor(plan, undefined, {
      eventWriter: {
        async write(event) {
          if (event.eventKind === 'execution.run.started') await writerGate;
        },
      },
    });
    const run = startExecution(plan, ports, {
      runId: 'run-writer-backpressure',
      bundleId: 'bundle-writer-backpressure',
    });
    await Promise.resolve();
    expect(state.runOpens).toBe(0);
    releaseWriter?.();
    const bundle = await run.result;

    expect(bundle.executionBundleStatus).toBe('completed');
    expect(state.attempts).toBe(1);
  });

  it('serializes concurrent EventWriter delivery in strict sequence order', async () => {
    let ready = 0;
    let releaseAttempts: (() => void) | undefined;
    const attemptsReady = new Promise<void>((resolve) => {
      releaseAttempts = resolve;
    });
    let releaseFirstCompletion: (() => void) | undefined;
    const firstCompletionGate = new Promise<void>((resolve) => {
      releaseFirstCompletion = resolve;
    });
    let observeFirstCompletion: (() => void) | undefined;
    const firstCompletionStarted = new Promise<void>((resolve) => {
      observeFirstCompletion = resolve;
    });
    let blockedFirstCompletion = false;
    let activeWriters = 0;
    let maxActiveWriters = 0;
    const writtenSequences: number[] = [];
    const plan = await makePlan((_definition, policy) => {
      policy.eventDelivery.writerMode = 'required';
      policy.eventDelivery.writerFailureMode = 'fail-run';
      policy.execution.maxConcurrency = 2;
    });
    const { ports } = portsFor(plan, async (trial) => {
      ready += 1;
      if (ready === 2) releaseAttempts?.();
      await attemptsReady;
      return {
        output: { value: { answer: trial.targetId }, classification: 'public' },
      };
    }, {
      eventWriter: {
        async write(event) {
          activeWriters += 1;
          maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
          try {
            if (event.eventKind === 'execution.attempt.completed'
                && !blockedFirstCompletion) {
              blockedFirstCompletion = true;
              observeFirstCompletion?.();
              await firstCompletionGate;
            }
            writtenSequences.push(event.sequence);
          } finally {
            activeWriters -= 1;
          }
        },
      },
    });
    const run = startExecution(plan, ports, {
      runId: 'run-writer-sequence',
      bundleId: 'bundle-writer-sequence',
    });
    await firstCompletionStarted;
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(maxActiveWriters).toBe(1);
    releaseFirstCompletion?.();
    const bundle = await run.result;

    expect(bundle.executionBundleStatus).toBe('completed');
    expect(writtenSequences).toEqual([...writtenSequences].sort((left, right) => left - right));
    expect(new Set(writtenSequences).size).toBe(writtenSequences.length);
  });

  it.each(['open-run', 'open-trial'] as const)(
    'reports %s failure without fabricating an attempt',
    async (failurePoint) => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.budget.stages.execution.maxInvocations = 1;
    });
    let runDisposals = 0;
    const executor: ExecutionExecutor = {
      identity: expectedExecutorIdentity(plan),
      async openRun() {
        if (failurePoint === 'open-run') throw new Error('run bootstrap failed');
        return {
          async openTrial(): Promise<ExecutionExecutorTrial> {
            throw new Error('session bootstrap failed');
          },
          async dispose() {
            runDisposals += 1;
          },
        };
      },
    };
    const ports: ExecutionRuntimePorts = {
      executorsByTargetId: targetExecutorBindings(plan, executor),
      clock: new FakeClock(),
      eventSequencer: new InMemoryRuntimeEventSequencer(),
      contentStore,
    };
    const bundle = await executeRunPlan(plan, ports, {
      runId: `run-resource-${failurePoint}-failure`,
      bundleId: `bundle-resource-${failurePoint}-failure`,
    });

    expect(bundle.executionBundleStatus).toBe('failed');
    expect(bundle.terminationReasonCode).toBe('executor-resource-open-failed');
    expect(bundle.coverage).toMatchObject({ started: 0, notStarted: 1 });
    expect(bundle.records).toHaveLength(0);
    expect(runDisposals).toBe(failurePoint === 'open-trial' ? 1 : 0);
    },
  );

  it('records one consumed attempt when an invoked Executor returns invalid usage', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.budget.stages.execution.maxInvocations = 1;
    });
    const { ports, state } = portsFor(plan, () => ({
      output: { value: { answer: 'invalid usage' }, classification: 'public' },
      usage: { inputTokens: -1 },
    }));
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-invalid-executor-result',
      bundleId: 'bundle-invalid-executor-result',
    });

    expect(bundle.executionBundleStatus).toBe('failed');
    expect(bundle.terminationReasonCode).toBe('executor-result-invalid');
    expect(bundle.coverage).toMatchObject({ started: 1, failed: 1, notStarted: 0 });
    expect(state.attempts).toBe(1);
    expect(bundle.records[0]).toMatchObject({
      executionStatus: 'failed',
      attempts: [{
        attemptNumber: 1,
        attemptStatus: 'failed',
        error: { code: 'executor-result-invalid' },
      }],
    });
  });

  it('reports disposer failure after exactly-once trial and run teardown', async () => {
    const cache = new MemoryCache();
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.cache.executionMode = 'transparent-deterministic';
    });
    const base = fakeExecutor(expectedExecutorIdentity(plan));
    const executor: ExecutionExecutor = {
      ...base.executor,
      async openRun(context) {
        const run = await base.executor.openRun(context);
        return {
          ...run,
          async dispose() {
            await run.dispose();
            throw new Error('dispose failed');
          },
        };
      },
    };
    const ports: ExecutionRuntimePorts = {
      executorsByTargetId: targetExecutorBindings(plan, executor),
      clock: new FakeClock(),
      eventSequencer: new InMemoryRuntimeEventSequencer(),
      contentStore,
      cache,
    };
    const bundle = await executeRunPlan(plan, ports, {
      runId: 'run-dispose-failure',
      bundleId: 'bundle-dispose-failure',
    });

    expect(bundle.executionBundleStatus).toBe('failed');
    expect(bundle.terminationReasonCode).toBe('executor-run-dispose-failed');
    expect(bundle.coverage.succeeded).toBe(1);
    expect(cache.puts).toBe(0);
    expect(base.state).toMatchObject({
      runOpens: 1,
      runDisposals: 1,
      trialOpens: 1,
      trialDisposals: 1,
    });
  });

  it('rejects missing ports and Runtime identity drift before any Target call', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.evidence.output = 'reference';
    });
    const { ports, state } = portsFor(plan);
    expect(() => startExecution(plan, { ...ports, contentStore: undefined }, {
      runId: 'run-missing-store',
      bundleId: 'bundle-missing-store',
    })).toThrow(ExecutionRuntimeConfigurationError);

    const executor = ports.executorsByTargetId.get('control');
    if (executor === undefined) throw new Error('missing test Executor binding');
    expect(() => startExecution(plan, {
      ...ports,
      executorsByTargetId: new Map([['executor-alias', executor]]),
    }, {
      runId: 'run-implementation-keyed',
      bundleId: 'bundle-implementation-keyed',
    })).toThrowError(expect.objectContaining({
      code: 'EXECUTION_RUNTIME_EXECUTOR_MISSING',
    }));

    const drifted = fakeExecutor({
      ...expectedExecutorIdentity(plan),
      fingerprint: 'different-fingerprint',
    });
    expect(() => startExecution(plan, {
      ...ports,
      executorsByTargetId: targetExecutorBindings(plan, drifted.executor),
    }, {
      runId: 'run-drifted',
      bundleId: 'bundle-drifted',
    })).toThrowError(expect.objectContaining({
      code: 'EXECUTION_RUNTIME_IDENTITY_MISMATCH',
    }));
    expect(state.runOpens).toBe(0);
  });

  it('closes the Event stream when terminal event sequencing throws', async () => {
    const plan = await makePlan();
    const { ports } = portsFor(plan, undefined, {
      eventSequencer: {
        next() { throw new Error('sequencer unavailable'); },
      },
    });
    const run = startExecution(plan, ports, {
      runId: 'run-sequencer-failure',
      bundleId: 'bundle-sequencer-failure',
    });
    const events = (async () => {
      const collected: EvaluationEvent[] = [];
      for await (const event of run.events) collected.push(event);
      return collected;
    })();

    await expect(run.source).rejects.toThrow('sequencer unavailable');
    await expect(events).resolves.toEqual([]);
  });

  it('keeps the preflight Executor binding when the host mutates its registry after start', async () => {
    const plan = await makePlan((definition) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
    });
    const identity = expectedExecutorIdentity(plan);
    const original = fakeExecutor(identity, () => ({
      output: { value: { source: 'sealed' }, classification: 'public' },
    }));
    const replacement = fakeExecutor(identity, () => ({
      output: { value: { source: 'replacement' }, classification: 'public' },
    }));
    const registry = new Map([['control', original.executor]]);
    const run = startExecution(plan, {
      executorsByTargetId: registry,
      clock: new FakeClock(),
      eventSequencer: new InMemoryRuntimeEventSequencer(),
      contentStore,
    }, {
      runId: 'run-registry-snapshot',
      bundleId: 'bundle-registry-snapshot',
    });
    registry.set('control', replacement.executor);
    const bundle = await run.result;

    const record = bundle.records[0];
    if (record.executionStatus !== 'completed'
        || record.output?.contentKind !== 'inline') throw new Error('expected inline output');
    expect(record.output.value).toEqual({ source: 'sealed' });
    expect(original.state.attempts).toBe(1);
    expect(replacement.state.attempts).toBe(0);
  });
});
