import { describe, expect, it } from 'vitest';
import {
  aggregateEvaluationAttemptUsage,
  digestArtifactPayload,
  digestCanonicalJson,
  deriveEvaluationAttemptId,
  parseExecutionBundle,
  parseEvaluationBundle,
  verifyEvaluationBundle,
  type BudgetLedgerEntry,
  type BudgetScopeSummary,
  type BudgetSummary,
  type EvaluationBundle,
  type EvaluationEvent,
  type ExecutionBundle,
  type RuntimeIdentity,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';
import { prepareEvaluationPlan } from '../../../src/evaluation-core/compiler/index.js';
import {
  executeRunPlanSource,
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

function reconcileBudgetSummary(
  summary: BudgetSummary,
  stage: 'execution' | 'evaluation',
  stageEntries: BudgetLedgerEntry[],
): void {
  summary.entries = [
    ...summary.entries.filter((entry) => entry.stage !== stage),
    ...stageEntries,
  ].map((entry, sequence) => ({ ...entry, sequence }));
  const previousLimits = new Map(summary.scopes.map((scope) => [
    `${scope.scopeKind}:${scope.scopeId}`,
    scope.limits,
  ]));
  const coordinateLimits = summary.scopes.find(
    (scope) => scope.scopeKind === 'coordinate',
  )?.limits ?? {};
  const totals = new Map<string, {
    invocations: number;
    activeDurationMs: number;
    costs: Map<string, number>;
    unreported: number;
  }>();
  for (const key of [
    `run:${summary.runId}`,
    'stage:evaluation',
    'stage:execution',
  ]) totals.set(key, {
    invocations: 0,
    activeDurationMs: 0,
    costs: new Map(),
    unreported: 0,
  });
  for (const entry of summary.entries) {
    for (const key of [
      `run:${summary.runId}`,
      `stage:${entry.stage}`,
      `coordinate:${entry.coordinateId}`,
    ]) {
      const value = totals.get(key) ?? {
        invocations: 0,
        activeDurationMs: 0,
        costs: new Map<string, number>(),
        unreported: 0,
      };
      value.invocations += 1;
      value.activeDurationMs += entry.activeDurationMs;
      if (entry.providerCost === undefined) value.unreported += 1;
      else value.costs.set(
        entry.providerCost.currency,
        (value.costs.get(entry.providerCost.currency) ?? 0) + entry.providerCost.amount,
      );
      totals.set(key, value);
    }
  }
  summary.scopes = [...totals.entries()].map(([key, value]): BudgetScopeSummary => {
    const separator = key.indexOf(':');
    const scopeKind = key.slice(0, separator) as BudgetScopeSummary['scopeKind'];
    const scopeId = key.slice(separator + 1);
    const limits = previousLimits.get(key)
      ?? (scopeKind === 'coordinate' ? coordinateLimits : {});
    const cost = limits.maxProviderCost === undefined
      ? undefined
      : value.costs.get(limits.maxProviderCost.currency) ?? 0;
    return {
      scopeKind,
      scopeId,
      limits,
      totals: {
        invocations: value.invocations,
        activeDurationMs: value.activeDurationMs,
        ...(value.costs.size === 0 ? {} : {
          reportedProviderCosts: [...value.costs.entries()]
            .map(([currency, amount]) => ({ amount, currency }))
            .sort((left, right) => left.currency.localeCompare(right.currency)),
        }),
        unreportedProviderCostInvocations: value.unreported,
      },
      overshoot: {
        invocations: limits.maxInvocations === undefined
          ? 0
          : Math.max(0, value.invocations - limits.maxInvocations),
        activeDurationMs: limits.maxActiveDurationMs === undefined
          ? 0
          : Math.max(0, value.activeDurationMs - limits.maxActiveDurationMs),
        ...(limits.maxProviderCost === undefined ? {} : {
          providerCost: {
            amount: Math.max(0, (cost as number) - limits.maxProviderCost.amount),
            currency: limits.maxProviderCost.currency,
          },
        }),
      },
    };
  }).sort((left, right) => `${left.scopeKind}:${left.scopeId}`
    .localeCompare(`${right.scopeKind}:${right.scopeId}`));
  const { ledgerDigest: _ledgerDigest, ...payload } = summary;
  void _ledgerDigest;
  summary.ledgerDigest = digestCanonicalJson(payload);
}

function reconcileExecutionBudget(bundle: ExecutionBundle): void {
  const oldEntries = new Map(bundle.budgetSummary.entries.map((entry) => [entry.attemptId, entry]));
  const entries = bundle.records.flatMap((record): BudgetLedgerEntry[] => {
    if (record.executionStatus === 'budget-censored'
        || (record.cache.cacheStatus !== 'miss'
          && record.cache.cacheStatus !== 'not-used')) return [];
    return record.attempts.map((attempt) => ({
      ...(oldEntries.get(attempt.attemptId) ?? {
        sequence: 0,
        stage: 'execution' as const,
        coordinateId: record.trialId,
        attemptId: attempt.attemptId,
        invocationCount: 1 as const,
        admissionKind: bundle.budgetSummary.admissionMode,
      }),
      activeDurationMs: attempt.timing.durationMs ?? 0,
      providerCostStatus: attempt.usage?.providerCost === undefined
        ? 'unreported' as const
        : 'reported' as const,
      ...(attempt.usage?.providerCost === undefined
        ? { providerCost: undefined }
        : { providerCost: attempt.usage.providerCost }),
      outcomeKind: attempt.attemptStatus === 'completed'
        ? 'completed' as const
        : attempt.attemptStatus === 'cancelled'
          ? 'cancelled' as const
          : attempt.error.code === 'timeout' ? 'attempt-timeout' as const : 'failed' as const,
    }));
  });
  for (const entry of entries) {
    if (entry.providerCost === undefined) delete entry.providerCost;
  }
  reconcileBudgetSummary(bundle.budgetSummary, 'execution', entries);
}

function reconcileEvaluationBudget(bundle: EvaluationBundle): void {
  const oldEntries = new Map(bundle.budgetSummary.entries.map((entry) => [entry.attemptId, entry]));
  const entries = bundle.records.flatMap((record): BudgetLedgerEntry[] => {
    if (record.evaluationStatus === 'not-evaluated'
        || (record.cache.cacheStatus !== 'miss'
          && record.cache.cacheStatus !== 'not-used')) return [];
    return record.attempts.map((attempt) => ({
      ...(oldEntries.get(attempt.attemptId) ?? {
        sequence: 0,
        stage: 'evaluation' as const,
        coordinateId: record.trialId,
        attemptId: attempt.attemptId,
        invocationCount: 1 as const,
        admissionKind: bundle.budgetSummary.admissionMode,
      }),
      activeDurationMs: attempt.timing.durationMs ?? 0,
      providerCostStatus: attempt.usage?.providerCost === undefined
        ? 'unreported' as const
        : 'reported' as const,
      ...(attempt.usage?.providerCost === undefined
        ? { providerCost: undefined }
        : { providerCost: attempt.usage.providerCost }),
      outcomeKind: attempt.attemptStatus === 'completed'
        ? 'completed' as const
        : attempt.attemptStatus === 'cancelled'
          ? 'cancelled' as const
          : attempt.error.code === 'timeout' ? 'attempt-timeout' as const : 'failed' as const,
    }));
  });
  for (const entry of entries) {
    if (entry.providerCost === undefined) delete entry.providerCost;
  }
  reconcileBudgetSummary(bundle.budgetSummary, 'evaluation', entries);
}

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

function resealExecutionBundle(
  source: ExecutionBundle,
  mutate: (draft: ExecutionBundle) => void,
): ExecutionBundle {
  const draft = structuredClone(source);
  mutate(draft);
  reconcileExecutionBudget(draft);
  draft.bundleDigest = `sha256:${'0'.repeat(64)}`;
  draft.bundleDigest = digestArtifactPayload(draft, 'bundleDigest');
  return draft;
}

function resealEvaluationBundle(
  bundle: EvaluationBundle,
  mutate: (draft: EvaluationBundle) => void,
): EvaluationBundle {
  const draft = structuredClone(bundle);
  mutate(draft);
  reconcileEvaluationBudget(draft);
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
  const clock = new FakeClock();
  clock.sleep = async (_delayMs, signal) => new Promise<void>((_resolve, reject) => {
    if (signal.aborted) reject(abortError());
    else signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
  return executeRunPlanSource(plan, {
    executors: new Map([['executor-alias', executor(plan, fail)]]),
    clock,
    eventSequencer: new InMemoryRuntimeEventSequencer(),
    eventWriter: { async write() {} },
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
    expect(parseEvaluationBundle(bundle, plan, source).bundle).toEqual(bundle);
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

  it('discards a late evaluator success after external cancellation', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.evaluation.maxConcurrency = 1;
      policy.evaluation.retry.maxAttempts = 1;
    });
    const source = await sourceBundle(plan);
    const controller = new AbortController();
    let started: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolve) => { started = resolve; });
    const allowSuccess = new Promise<void>((resolve) => { finish = resolve; });
    const fake = evaluator(plan, async () => {
      started?.();
      await allowSuccess;
      return {
        observations: [{
          metricId: 'correct',
          observationStatus: 'observed',
          valueType: 'boolean',
          value: true,
        }],
      };
    });
    const run = startEvaluation(plan, source, ports(plan, fake.port), {
      runId: 'late-cancel-run',
      bundleId: 'late-cancel-bundle',
      signal: controller.signal,
    });
    await attemptStarted;
    controller.abort();
    finish?.();
    const bundle = await run.result;

    expect(bundle.evaluationBundleStatus).toBe('cancelled');
    expect(bundle.records).toHaveLength(1);
    expect(bundle.records[0].evaluationStatus).toBe('cancelled');
    expect(bundle.coverage.completed).toBe(0);
  });

  it('reuses cache by source digest and commits only after clean resource teardown', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
    });
    const source = await sourceBundle(plan);
    const cache = new MemoryCache();
    const first = evaluator(plan);
    const firstBundle = await evaluateExecutionBundle(plan, source, ports(plan, first.port, { cache }), {
      runId: 'cache-first',
      bundleId: 'cache-first-bundle',
    });
    expect(cache.puts).toBe(2);
    const selfReportedHit = resealEvaluationBundle(firstBundle, (draft) => {
      const record = draft.records[0];
      if (record.evaluationStatus === 'not-evaluated') throw new Error('unexpected record');
      record.cache = {
        ...record.cache,
        cacheStatus: 'transparent-hit',
        sourceRecordDigest: digestCanonicalJson(record),
      };
    });
    expect(() => parseEvaluationBundle(selfReportedHit, plan, source))
      .toThrowError(/sealed reuse policy/);

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
    const forgedHit = resealEvaluationBundle(replay, (draft) => {
      const record = draft.records[0];
      if (record.evaluationStatus === 'not-evaluated') throw new Error('unexpected record');
      delete record.cache.sourceRecordDigest;
    });
    expect(() => parseEvaluationBundle(forgedHit, plan, source))
      .toThrowError(/sealed reuse policy/);

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

  it('does not exempt a structurally valid but externally unverified cache-hit claim', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
      policy.budget.stages.evaluation.maxInvocations = 2;
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const native = await evaluateExecutionBundle(plan, source, ports(plan, fake.port, {
      cache: new MemoryCache(),
    }), {
      runId: 'unverified-hit-seed',
      bundleId: 'unverified-hit-seed-bundle',
    });
    const evaluationId = native.records[0].evaluationId as Sha256Digest;
    const forged = resealEvaluationBundle(native, (draft) => {
      const record = draft.records[0];
      if (record.evaluationStatus !== 'completed') throw new Error('unexpected record');
      const first = record.attempts[0];
      record.attempts = [{
        ...first,
        attemptStatus: 'failed',
        error: {
          code: 'timeout',
          stage: 'evaluation',
          message: 'Forged retryable failure.',
        },
      }, {
        ...first,
        attemptId: deriveEvaluationAttemptId({
          evaluationId,
          attemptNumber: 2,
        }),
        attemptNumber: 2,
        attemptStatus: 'completed',
      }];
      const nativeRecordDigest = digestCanonicalJson(record);
      const cacheKeyDigest = record.cache.cacheKeyDigest;
      if (cacheKeyDigest === undefined) throw new Error('missing cache key');
      record.provenance = {
        provenanceKind: 'replay',
        trust: record.provenance.trust,
        parentDigests: [nativeRecordDigest],
      };
      record.cache = {
        cacheStatus: 'transparent-hit',
        cacheKeyDigest,
        sourceRecordDigest: nativeRecordDigest,
      };
    });

    expect(parseEvaluationBundle(forged, plan, source).bundle).toEqual(forged);
    expect(verifyEvaluationBundle(forged, plan, source).planVerification).toMatchObject({
      cacheReceiptStatus: 'indeterminate',
      invocationBudgetStatus: 'indeterminate',
      minimumEvaluatorInvocations: 1,
      maximumEvaluatorInvocations: 3,
    });
  });

  it('keeps a durable cache-hit Bundle valid while reporting an indeterminate budget proof', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
      policy.evaluation.maxConcurrency = 1;
      policy.budget.stages.evaluation.maxInvocations = 2;
    });
    const source = await sourceBundle(plan);
    const cache = new MemoryCache();
    const seed = evaluator(plan);
    await evaluateExecutionBundle(plan, source, ports(plan, seed.port, { cache }), {
      runId: 'durable-receipt-seed-run',
      bundleId: 'durable-receipt-seed-bundle',
    });
    const replaced = [...cache.entries].find(([, entry]) => (
      entry.record.targetId === 'treatment'
    ));
    if (replaced === undefined) throw new Error('missing treatment cache entry');
    cache.entries.delete(replaced[0]);
    const retry = evaluator(plan, (state) => {
      if (state.attempts === 1) {
        throw new EvaluationPortFailure({
          code: 'timeout',
          stage: 'evaluation',
          message: 'Retry before the replacement cache write.',
        });
      }
      return {
        observations: [{
          metricId: 'correct',
          observationStatus: 'observed',
          valueType: 'boolean',
          value: true,
        }],
      };
    });
    await evaluateExecutionBundle(plan, source, ports(plan, retry.port, { cache }), {
      runId: 'durable-receipt-replace-run',
      bundleId: 'durable-receipt-replace-bundle',
    });
    const replayEvaluator = evaluator(plan);
    const replay = await evaluateExecutionBundle(
      plan,
      source,
      ports(plan, replayEvaluator.port, { cache }),
      {
        runId: 'durable-receipt-replay-run',
        bundleId: 'durable-receipt-replay-bundle',
      },
    );
    const transported = structuredClone(replay);
    const verification = verifyEvaluationBundle(transported, plan, source);

    expect(parseEvaluationBundle(transported, plan, source).bundle).toEqual(transported);
    expect(replayEvaluator.state.attempts).toBe(0);
    expect(verification.planVerification).toMatchObject({
      cacheReceiptStatus: 'indeterminate',
      invocationBudgetStatus: 'indeterminate',
      minimumEvaluatorInvocations: 0,
      maximumEvaluatorInvocations: 3,
    });
    expect(verification.planVerification.unverifiedCacheRecordDigests).toHaveLength(2);
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

  it('does not resolve content or open evaluator resources when cancelled before start', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.evidence.output = 'reference';
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const controller = new AbortController();
    controller.abort();
    let resolves = 0;
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port, {
      contentResolver: {
        async resolve() {
          resolves += 1;
          throw new Error('resolver must not open');
        },
      },
    }), {
      runId: 'cancel-before-start-run',
      bundleId: 'cancel-before-start-bundle',
      signal: controller.signal,
    });

    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'cancelled',
      coverage: { started: 0, notStarted: 1 },
    });
    expect(resolves).toBe(0);
    expect(fake.state).toMatchObject({ attempts: 0, recordContexts: [], runDisposals: 0 });
  });

  it.each([
    'evaluation.run.started',
    'evaluation.record.started',
    'evaluation.cache.miss',
  ] as const)('does not open evaluator resources when %s cannot be written', async (eventKind) => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.eventDelivery.writerMode = 'required';
      policy.eventDelivery.writerFailureMode = 'fail-run';
      if (eventKind === 'evaluation.run.started') policy.evidence.output = 'reference';
      if (eventKind === 'evaluation.cache.miss') policy.cache.evaluationMode = 'reuse';
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const cache = eventKind === 'evaluation.cache.miss' ? new MemoryCache() : undefined;
    let resolves = 0;
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port, {
      ...(cache === undefined ? {} : { cache }),
      contentResolver: {
        async resolve() {
          resolves += 1;
          throw new Error('resolver must not open before durable run start');
        },
      },
      eventWriter: {
        async write(event) {
          if (event.eventKind === eventKind) throw new Error('writer failed');
        },
      },
    }), {
      runId: `writer-admission-${eventKind}`,
      bundleId: `writer-admission-bundle-${eventKind}`,
    });

    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'failed',
      coverage: { started: 0, notStarted: 1 },
    });
    expect(fake.state).toMatchObject({ attempts: 0, recordContexts: [], runDisposals: 0 });
    if (eventKind === 'evaluation.run.started') expect(resolves).toBe(0);
  });

  it('re-seals terminal status when EventWriter fails on terminal delivery', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.eventDelivery.writerMode = 'optional';
      policy.eventDelivery.writerFailureMode = 'fail-run';
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const run = startEvaluation(plan, source, ports(plan, fake.port, {
      eventWriter: {
        async write(event) {
          if (event.eventKind === 'evaluation.run.completed') throw new Error('writer failed');
        },
      },
    }), {
      runId: 'writer-run',
      bundleId: 'writer-bundle',
    });
    const bundle = await run.result;
    const journal: EvaluationEvent[] = [];
    for await (const event of run.events) journal.push(event);
    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluation-event-writer-failed',
    });
    expect(parseEvaluationBundle(bundle, plan, source).bundle).toEqual(bundle);
    const terminals = journal.filter((event) => event.eventKind.startsWith('evaluation.run.')
      && event.eventKind !== 'evaluation.run.started');
    expect(terminals).toEqual([expect.objectContaining({
      eventKind: 'evaluation.run.failed',
      data: expect.objectContaining({ bundleDigest: bundle.bundleDigest }),
    })]);
  });

  it.each([
    ['cancelled', 'evaluation.run.cancelled'],
    ['budget-exhausted', 'evaluation.run.budget-exhausted'],
  ] as const)('lets terminal EventWriter failure override an existing %s stop', async (
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
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const controller = new AbortController();
    if (stopStatus === 'cancelled') controller.abort();
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port, {
      eventWriter: {
        async write(event) {
          if (event.eventKind === rejectedEventKind) throw new Error('terminal writer failed');
        },
      },
    }), {
      runId: `terminal-precedence-${stopStatus}-run`,
      bundleId: `terminal-precedence-${stopStatus}-bundle`,
      signal: controller.signal,
    });

    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluation-event-writer-failed',
    });
  });

  it('lets run disposal failure override an in-flight external cancellation', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.evaluation.maxConcurrency = 1;
      policy.evaluation.retry.maxAttempts = 1;
    });
    const source = await sourceBundle(plan);
    const controller = new AbortController();
    let started: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolve) => { started = resolve; });
    const allowSettlement = new Promise<void>((resolve) => { finish = resolve; });
    const base = evaluator(plan, async () => {
      started?.();
      await allowSettlement;
      return { observations: [] };
    });
    const evaluatorWithFailingRunDispose: EvaluationEvaluator = {
      ...base.port,
      async openRun(context) {
        const run = await base.port.openRun(context);
        return {
          ...run,
          async dispose() {
            await run.dispose();
            throw new Error('run dispose failed');
          },
        };
      },
    };
    const running = startEvaluation(
      plan,
      source,
      ports(plan, evaluatorWithFailingRunDispose),
      {
        runId: 'cancel-dispose-precedence-run',
        bundleId: 'cancel-dispose-precedence-bundle',
        signal: controller.signal,
      },
    );
    await attemptStarted;
    controller.abort();
    finish?.();
    const bundle = await running.result;

    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluator-run-dispose-failed',
      coverage: { cancelled: 1 },
    });
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
      source.bundle.records.map((record) => digestCanonicalJson(record)),
    );
    expect([...cache.entries.values()].every((entry) => (
      sourceDigests.has(entry.record.sourceRecordDigest)
    ))).toBe(true);
  });

  it('evaluates failed execution records when every sealed trace binding is materializable', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.evaluators[0].inputs = [{
        bindingId: 'trace',
        sourceKind: 'trace',
        pointer: '/message',
      }];
      policy.evidence.trace = 'full';
    }, testRuntime({ traceCapability: 'optional' }));
    const completed = await sourceBundle(plan);
    const source = parseExecutionBundle(resealExecutionBundle(completed.bundle, (draft) => {
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
    }), plan);
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
    const source = parseExecutionBundle(resealExecutionBundle(completed.bundle, (draft) => {
      const record = draft.records[1];
      if (record.executionStatus !== 'completed') throw new Error('unexpected source');
      delete record.output;
      draft.replayability = 'summary-only';
    }), plan);
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
    const source = parseExecutionBundle(resealExecutionBundle(completed.bundle, (draft) => {
      draft.records = [draft.records[0]];
      draft.coverage = {
        ...draft.coverage,
        started: 1,
        succeeded: 1,
        notStarted: 1,
      };
      draft.executionBundleStatus = 'cancelled';
      draft.terminationReasonCode = 'partial-source';
    }), plan);
    const fake = evaluator(plan);
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'partial-run',
      bundleId: 'partial-bundle',
    });

    expect(parseEvaluationBundle(bundle, plan, source).bundle).toEqual(bundle);
    expect(bundle.coverage).toMatchObject({ eligible: 1, sourceUnavailable: 1 });
    expect(bundle.records.find((record) => record.evaluationStatus === 'not-evaluated'))
      .not.toHaveProperty('sourceRecordDigest');
  });

  it('rejects a forged not-evaluated record when sealed bindings are available', async () => {
    const plan = await makePlan();
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const valid = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'forge-not-evaluated-seed',
      bundleId: 'forge-not-evaluated-seed-bundle',
    });
    const forged = resealEvaluationBundle(valid, (draft) => {
      const record = draft.records[0];
      if (record.evaluationStatus !== 'completed') throw new Error('unexpected record');
      draft.records[0] = {
        targetId: record.targetId,
        sampleId: record.sampleId,
        trialIndex: record.trialIndex,
        trialId: record.trialId,
        evaluatorId: record.evaluatorId,
        measurement: record.measurement,
        evaluationId: record.evaluationId,
        runtime: record.runtime,
        provenance: record.provenance,
        evaluationStatus: 'not-evaluated',
        notEvaluatedReasonCode: 'evaluator-input-unavailable',
        notEvaluatedAt: record.timing.completedAt ?? record.timing.startedAt,
        sourceRecordDigest: record.sourceRecordDigest,
      };
      draft.coverage = {
        ...draft.coverage,
        eligible: draft.coverage.eligible - 1,
        sourceUnavailable: draft.coverage.sourceUnavailable + 1,
        started: draft.coverage.started - 1,
        completed: draft.coverage.completed - 1,
      };
    });

    expect(() => parseEvaluationBundle(forged, plan, source))
      .toThrowError(/unavailable evaluator bindings/);
  });

  it('rejects an active record when an output-only binding has no source output', async () => {
    const plan = await makePlan((definition) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      definition.evaluators[0].inputs = [{
        bindingId: 'actual',
        sourceKind: 'output',
        pointer: '/answer',
      }];
    });
    const completedSource = await sourceBundle(plan);
    const fake = evaluator(plan);
    const valid = await evaluateExecutionBundle(
      plan,
      completedSource,
      ports(plan, fake.port),
      { runId: 'active-binding-seed', bundleId: 'active-binding-seed-bundle' },
    );
    const failedSource = parseExecutionBundle(resealExecutionBundle(completedSource.bundle, (draft) => {
      const record = draft.records[0];
      if (record.executionStatus !== 'completed') throw new Error('unexpected source');
      const last = record.attempts.at(-1);
      if (last === undefined) throw new Error('missing attempt');
      const withoutOutput = structuredClone(record);
      delete withoutOutput.output;
      draft.records[0] = {
        ...withoutOutput,
        executionStatus: 'failed',
        attempts: [
          ...record.attempts.slice(0, -1),
          {
            ...last,
            attemptStatus: 'failed',
            error: { code: 'target-failed', stage: 'execution', message: 'Target failed.' },
          },
        ],
        error: { code: 'target-failed', stage: 'execution', message: 'Target failed.' },
      };
      draft.coverage = { ...draft.coverage, succeeded: 0, failed: 1 };
      draft.replayability = 'summary-only';
      draft.executionBundleStatus = 'failed';
      draft.terminationReasonCode = 'target-failed';
    }), plan);
    const forged = resealEvaluationBundle(valid, (draft) => {
      const record = draft.records[0];
      draft.executionBundleDigest = failedSource.bundle.bundleDigest;
      draft.budgetSummary.entries = [
        ...failedSource.bundle.budgetSummary.entries,
        ...draft.budgetSummary.entries.filter((entry) => entry.stage === 'evaluation'),
      ];
      if (record.evaluationStatus === 'not-evaluated') throw new Error('unexpected record');
      record.sourceRecordDigest = digestCanonicalJson(failedSource.bundle.records[0]);
    });

    expect(() => parseEvaluationBundle(forged, plan, failedSource))
      .toThrowError(/requires every statically checkable binding/);
  });

  it('rejects cache-hit claims when the sealed evaluation cache is disabled', async () => {
    const plan = await makePlan();
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const valid = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'forge-cache-seed',
      bundleId: 'forge-cache-seed-bundle',
    });
    const forged = resealEvaluationBundle(valid, (draft) => {
      const record = draft.records[0];
      if (record.evaluationStatus === 'not-evaluated') throw new Error('unexpected record');
      record.cache = {
        cacheStatus: 'transparent-hit',
        cacheKeyDigest: digestCanonicalJson({ forged: 'key' }),
        sourceRecordDigest: digestCanonicalJson(record),
      };
    });

    expect(() => parseEvaluationBundle(forged, plan, source))
      .toThrowError(/disabled cache policy/);
  });

  it('charges failed attempts and stops retries at the provider-cost boundary', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.evaluation.maxConcurrency = 1;
      policy.budget.stages.evaluation.maxProviderCost = { amount: 1, currency: 'USD' };
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

  it('rejects a resealed Bundle whose native evaluator cost exceeds the sealed budget', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.evaluation.maxConcurrency = 1;
      policy.budget.stages.evaluation.maxProviderCost = { amount: 1, currency: 'USD' };
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan, () => ({
      observations: [{
        metricId: 'correct',
        observationStatus: 'observed',
        valueType: 'boolean',
        value: true,
      }],
      usage: {
        providerCost: { amount: 0.25, currency: 'USD', reportedByProvider: true },
      },
    }));
    const valid = await evaluateExecutionBundle(plan, source, ports(plan, fake.port), {
      runId: 'forge-provider-cost-run',
      bundleId: 'forge-provider-cost-bundle',
    });
    const forged = resealEvaluationBundle(valid, (draft) => {
      for (const record of draft.records) {
        if (record.evaluationStatus === 'not-evaluated') throw new Error('unexpected status');
        for (const attempt of record.attempts) {
          attempt.usage = {
            providerCost: { amount: 0.75, currency: 'USD', reportedByProvider: true },
          };
        }
        record.usage = aggregateEvaluationAttemptUsage(record.attempts);
      }
    });

    expect(() => verifyEvaluationBundle(forged, plan, source))
      .toThrowError(expect.objectContaining({
        code: 'EVALUATION_BUNDLE_PROVIDER_COST_INVALID',
      }));
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

  it('waits for settlement when timeout and external cancellation become observable together', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.evaluation.timeoutMs = 5;
      policy.evaluation.maxConcurrency = 1;
      policy.evaluation.retry.maxAttempts = 1;
    });
    const source = await sourceBundle(plan);
    const controller = new AbortController();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const allowSettlement = new Promise<void>((resolve) => { release = resolve; });
    const attemptStarted = new Promise<void>((resolve) => { started = resolve; });
    let settled = false;
    let disposedBeforeSettlement = false;
    const fake = evaluator(plan, async () => {
      started?.();
      await allowSettlement;
      settled = true;
      return { observations: [] };
    });
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
    const clock = new FakeClock();
    clock.sleep = async (_delayMs, signal) => {
      if (signal.aborted) throw abortError();
      controller.abort();
      await Promise.resolve();
    };
    const run = startEvaluation(plan, source, ports(plan, fake.port, { clock }), {
      runId: 'cancel-timeout-race-run',
      bundleId: 'cancel-timeout-race-bundle',
      signal: controller.signal,
    });
    await attemptStarted;
    await Promise.resolve();
    expect(fake.state.recordDisposals).toBe(0);
    release?.();
    const bundle = await run.result;

    expect(bundle.evaluationBundleStatus).toBe('cancelled');
    expect(settled).toBe(true);
    expect(disposedBeforeSettlement).toBe(false);
  });

  it('stops binding resolution immediately when the evaluation duration budget expires', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.evidence.output = 'reference';
      policy.budget.run.maxWallClockMs = 5;
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    let expireBudget: (() => void) | undefined;
    const clock = new FakeClock();
    clock.sleep = async (_delayMs, signal) => new Promise<void>((resolve, reject) => {
      expireBudget = resolve;
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    let resolves = 0;
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port, {
      clock,
      contentResolver: {
        async resolve(descriptor) {
          resolves += 1;
          expireBudget?.();
          await Promise.resolve();
          const value = descriptor.digest === digestCanonicalJson({ answer: 'A' })
            ? { answer: 'A' }
            : { answer: 'B' };
          return { value, classification: 'public' };
        },
      },
    }), {
      runId: 'binding-duration-budget-run',
      bundleId: 'binding-duration-budget-bundle',
    });

    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'budget-exhausted',
      terminationReasonCode: 'run-wall-clock-budget-exhausted',
      coverage: { started: 0, notStarted: 2 },
    });
    expect(resolves).toBe(1);
    expect(fake.state).toMatchObject({ attempts: 0, recordContexts: [], runDisposals: 0 });
  });

  it('uses the sealed descriptor media type when a ContentResolver omits it', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.evidence.output = 'reference';
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port, {
      contentResolver: {
        async resolve() {
          return { value: { answer: 'A' }, classification: 'public' };
        },
      },
    }), {
      runId: 'sealed-media-type-run',
      bundleId: 'sealed-media-type-bundle',
    });

    expect(bundle.evaluationBundleStatus).toBe('completed');
    expect(fake.state.recordContexts[0].bindings.find((binding) => (
      binding.bindingId === 'actual'
    ))?.mediaType).toBe('application/json');
  });

  it('rejects a ContentResolver media type that contradicts the sealed descriptor', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.evidence.output = 'reference';
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port, {
      contentResolver: {
        async resolve() {
          return {
            value: { answer: 'A' },
            classification: 'public',
            mediaType: 'text/plain',
          };
        },
      },
    }), {
      runId: 'mismatched-media-type-run',
      bundleId: 'mismatched-media-type-bundle',
    });

    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluation-runtime-internal-failed',
      coverage: { started: 0, notStarted: 1 },
    });
    expect(fake.state.attempts).toBe(0);
  });

  it('rejects a ContentStore descriptor that rewrites evaluator evidence media type', async () => {
    const plan = await makePlan((definition, policy) => {
      definition.targets = [definition.targets[0]];
      definition.comparisons = [];
      policy.evidence.evidence = 'reference';
    });
    const source = await sourceBundle(plan);
    const fake = evaluator(plan, () => ({
      observations: [{
        metricId: 'correct',
        observationStatus: 'observed',
        valueType: 'boolean',
        value: true,
      }],
      evidence: {
        value: { rationale: 'sealed' },
        classification: 'public',
        mediaType: 'application/json',
      },
    }));
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, fake.port, {
      contentStore: {
        async put(request) {
          return {
            digest: request.digest,
            mediaType: 'text/plain',
            uri: `memory:${request.digest}`,
          };
        },
      },
    }), {
      runId: 'store-media-type-run',
      bundleId: 'store-media-type-bundle',
    });

    expect(bundle.records[0]).toMatchObject({
      evaluationStatus: 'failed',
      error: { code: 'content-store-invalid' },
    });
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

  it('rejects a cache record whose aggregate usage differs from its attempts', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
    });
    const source = await sourceBundle(plan);
    const cache = new MemoryCache();
    const first = evaluator(plan, () => ({
      observations: [{
        metricId: 'correct',
        observationStatus: 'observed',
        valueType: 'boolean',
        value: true,
      }],
      usage: { totalTokens: 1 },
    }));
    await evaluateExecutionBundle(plan, source, ports(plan, first.port, { cache }), {
      runId: 'poison-usage-seed-run',
      bundleId: 'poison-usage-seed-bundle',
    });
    const entry = cache.entries.values().next().value;
    if (entry === undefined || entry.record.usage === undefined) {
      throw new Error('missing cache usage');
    }
    entry.record.usage = { ...entry.record.usage, totalTokens: 999 };
    entry.cachedRecordDigest = digestCanonicalJson(entry.record);
    const second = evaluator(plan);
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, second.port, { cache }), {
      runId: 'poison-usage-run',
      bundleId: 'poison-usage-bundle',
    });

    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluation-cache-read-failed',
    });
    expect(second.state.attempts).toBe(0);
  });

  it('rejects a cache record that could not pass the sealed provider-cost audit', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
      policy.budget.stages.evaluation.maxProviderCost = { amount: 10, currency: 'USD' };
    });
    const source = await sourceBundle(plan);
    const cache = new MemoryCache();
    const first = evaluator(plan, () => ({
      observations: [{
        metricId: 'correct',
        observationStatus: 'observed',
        valueType: 'boolean',
        value: true,
      }],
      usage: {
        providerCost: { amount: 0.25, currency: 'USD', reportedByProvider: true },
      },
    }));
    await evaluateExecutionBundle(plan, source, ports(plan, first.port, { cache }), {
      runId: 'poison-cost-seed-run',
      bundleId: 'poison-cost-seed-bundle',
    });
    const entry = cache.entries.values().next().value;
    if (entry === undefined) throw new Error('missing cache entry');
    delete entry.record.attempts[0].usage;
    delete entry.record.usage;
    entry.cachedRecordDigest = digestCanonicalJson(entry.record);
    const second = evaluator(plan);
    const bundle = await evaluateExecutionBundle(plan, source, ports(plan, second.port, { cache }), {
      runId: 'poison-cost-run',
      bundleId: 'poison-cost-bundle',
    });

    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluation-cache-read-failed',
    });
    expect(second.state.attempts).toBe(0);
  });

  it('rejects cache entries whose native miss envelope was rewritten', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
    });
    const source = await sourceBundle(plan);
    const seeded = new MemoryCache();
    const first = evaluator(plan);
    await evaluateExecutionBundle(plan, source, ports(plan, first.port, { cache: seeded }), {
      runId: 'poison-envelope-seed',
      bundleId: 'poison-envelope-seed-bundle',
    });

    for (const scenario of ['cache-status', 'cache-key', 'provenance'] as const) {
      const poisoned = new MemoryCache();
      for (const [key, value] of seeded.entries) {
        poisoned.entries.set(key, structuredClone(value));
      }
      const entry = poisoned.entries.values().next().value;
      if (entry === undefined) throw new Error('missing cache entry');
      if (scenario === 'cache-status') {
        entry.record.cache = {
          cacheStatus: 'transparent-hit',
          cacheKeyDigest: entry.cacheKeyDigest,
          sourceRecordDigest: entry.cachedRecordDigest,
        };
      } else if (scenario === 'cache-key') {
        entry.record.cache = {
          cacheStatus: 'miss',
          cacheKeyDigest: digestCanonicalJson({ wrong: 'cache-key' }),
        };
      } else {
        entry.record.provenance = {
          provenanceKind: 'replay',
          trust: entry.record.provenance.trust,
          parentDigests: [entry.cachedRecordDigest],
        };
      }
      entry.cachedRecordDigest = digestCanonicalJson(entry.record);
      const second = evaluator(plan);
      const bundle = await evaluateExecutionBundle(
        plan,
        source,
        ports(plan, second.port, { cache: poisoned }),
        {
          runId: `poison-envelope-${scenario}`,
          bundleId: `poison-envelope-${scenario}-bundle`,
        },
      );

      expect(bundle).toMatchObject({
        evaluationBundleStatus: 'failed',
        terminationReasonCode: 'evaluation-cache-read-failed',
      });
      expect(second.state.attempts).toBe(0);
    }
  });

  it.each([
    ['secret metadata', 'secret'],
    ['wrong capture kind', 'public'],
  ] as const)('rejects cache records with poisoned %s', async (_label, classification) => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
      policy.evidence.evidence = 'none';
      policy.evidence.maximumClassification = 'public';
    });
    const source = await sourceBundle(plan);
    const seeded = new MemoryCache();
    const first = evaluator(plan);
    await evaluateExecutionBundle(plan, source, ports(plan, first.port, { cache: seeded }), {
      runId: `poison-evidence-seed-${classification}`,
      bundleId: `poison-evidence-seed-bundle-${classification}`,
    });
    const poisoned = new MemoryCache();
    for (const [key, value] of seeded.entries) poisoned.entries.set(key, structuredClone(value));
    const entry = poisoned.entries.values().next().value;
    if (entry === undefined) throw new Error('missing cache entry');
    entry.record.observations[0].metadata = {
      contentKind: 'inline',
      classification,
      value: { forged: true },
    };
    entry.cachedRecordDigest = digestCanonicalJson(entry.record);
    const second = evaluator(plan);
    const bundle = await evaluateExecutionBundle(
      plan,
      source,
      ports(plan, second.port, { cache: poisoned }),
      {
        runId: `poison-evidence-${classification}`,
        bundleId: `poison-evidence-bundle-${classification}`,
      },
    );

    expect(bundle).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluation-cache-read-failed',
    });
    expect(second.state.attempts).toBe(0);
  });

  it('downgrades unauthenticated imported source trust in native and replayed facts', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
    });
    const completed = await sourceBundle(plan);
    const source = parseExecutionBundle(resealExecutionBundle(completed.bundle, (draft) => {
      draft.provenance = { ...draft.provenance, provenanceKind: 'imported', trust: 'declared' };
      draft.records = draft.records.map((record) => ({
        ...record,
        provenance: { ...record.provenance, provenanceKind: 'imported', trust: 'declared' },
      }));
    }), plan);
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

    expect(native.provenance.trust).toBe('unknown');
    expect(native.records.every((record) => record.provenance.trust === 'unknown')).toBe(true);
    expect(replay.records.every((record) => record.provenance.trust === 'unknown')).toBe(true);

    const forged = resealEvaluationBundle(native, (draft) => {
      draft.provenance.trust = 'verified';
      for (const record of draft.records) record.provenance.trust = 'verified';
    });
    expect(() => parseEvaluationBundle(forged, plan, source))
      .toThrowError(/trust exceeds/);
  });

  it('uses effective source trust to isolate evaluation cache entries', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.cache.evaluationMode = 'reuse';
    });
    const source = await sourceBundle(plan);
    const cache = new MemoryCache();
    const first = evaluator(plan);
    await evaluateExecutionBundle(plan, source, ports(plan, first.port, { cache }), {
      runId: 'trust-key-verified-run',
      bundleId: 'trust-key-verified-bundle',
    });
    const downgradedSource = parseExecutionBundle(resealExecutionBundle(source.bundle, (draft) => {
      draft.provenance = {
        ...draft.provenance,
        provenanceKind: 'imported',
        trust: 'declared',
      };
    }), plan);
    const second = evaluator(plan);
    const downgraded = await evaluateExecutionBundle(
      plan,
      downgradedSource,
      ports(plan, second.port, { cache }),
      {
        runId: 'trust-key-declared-run',
        bundleId: 'trust-key-declared-bundle',
      },
    );

    expect(downgraded.evaluationBundleStatus).toBe('completed');
    expect(downgraded.provenance.trust).toBe('unknown');
    expect(downgraded.records.every((record) => (
      record.evaluationStatus === 'completed'
      && record.cache.cacheStatus === 'miss'
      && record.provenance.trust === 'unknown'
    ))).toBe(true);
    expect(second.state.attempts).toBe(2);
    expect(cache.puts).toBe(4);
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
    const source = await executeRunPlanSource(plan, {
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

  it('closes the Event stream when terminal event sequencing throws', async () => {
    const plan = await makePlan();
    const source = await sourceBundle(plan);
    const fake = evaluator(plan);
    const run = startEvaluation(plan, source, ports(plan, fake.port, {
      eventSequencer: {
        next() { throw new Error('sequencer unavailable'); },
      },
    }), {
      runId: 'evaluation-sequencer-failure',
      bundleId: 'evaluation-sequencer-failure-bundle',
    });
    const events = (async () => {
      const collected: EvaluationEvent[] = [];
      for await (const event of run.events) collected.push(event);
      return collected;
    })();

    await expect(run.source).rejects.toThrow('sequencer unavailable');
    await expect(events).resolves.toEqual([]);
  });
});
