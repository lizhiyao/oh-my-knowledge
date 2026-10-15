import { describe, expect, it } from "vitest";
import { evaluate, type Executor } from "../../../src/eval-runtime/index.js";
import { type Config, type Input, comparisonAnalysis, executor, fixedClock, numericCustomEvaluator, pairedInput } from '../fixtures/evaluation.js';

describe('canonical eval-runtime policies', () => {
it('enforces a stage provider-cost budget and exposes auditable bounded overshoot', async () => {
    let calls = 0;
    const base = executor(async ({ input, config, signal }) => {
      signal.throwIfAborted();
      calls += 1;
      return {
        output: config.answers[input.prompt],
        usage: {
          providerCost: { amount: 0.6, currency: 'USD', reportedByProvider: true },
        },
      };
    });
    const metered: Executor<Input, Config, string> = {
      ...base,
      capabilities: {
        ...base.capabilities!,
        telemetry: {
          ...base.capabilities!.telemetry,
          providerCost: { reporting: 'optional' },
        },
      },
    };
    const result = await evaluate({
      ...pairedInput(metered),
      policy: {
        execution: { maxConcurrency: 2 },
        evaluation: { maxConcurrency: 1 },
        budget: {
          execution: { maxProviderCost: { amount: 1, currency: 'USD' } },
        },
      },
      decision: undefined
    }, {
      runId: 'canonical-provider-cost-budget',
      clock: fixedClock
    });

    expect(result.status).toBe('budget-exhausted');
    if (result.status === 'failed') return;
    expect(calls).toBe(4);
    expect(result.report.budgetSummary.admissionMode).toBe('bounded-overshoot');
    expect(result.report.budgetSummary.summaryStatus).toBe('exhausted');
    expect(result.report.budgetSummary.entries).toHaveLength(4);
    expect(result.report.budgetSummary.entries.every((entry) => (
      entry.stage === 'execution'
      && entry.providerCostStatus === 'reported'
      && entry.admissionKind === 'bounded-overshoot'
    ))).toBe(true);
    expect(result.report.budgetSummary.termination).toEqual({
      terminationKind: 'active-budget-exhausted',
      resourceKind: 'provider-cost',
      scopeKind: 'stage',
      scopeId: 'execution',
      reasonCode: 'stage-provider-cost-budget-exhausted',
    });
    expect(result.report.budgetSummary.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeKind: 'stage',
        scopeId: 'execution',
        limits: { maxProviderCost: { amount: 1, currency: 'USD' } },
        totals: expect.objectContaining({
          reportedProviderCosts: [{ amount: 2.4, currency: 'USD' }],
        }),
        overshoot: expect.objectContaining({
          providerCost: { amount: expect.closeTo(1.4), currency: 'USD' },
        }),
      }),
    ]));
  });

it('makes unreported provider cost explicitly unverifiable or fail-closed', async () => {
    let calls = 0;
    const base = executor(async ({ input, config }) => {
      calls += 1;
      return { output: config.answers[input.prompt] };
    });
    const unmetered: Executor<Input, Config, string> = {
      ...base,
      capabilities: {
        ...base.capabilities!,
        telemetry: {
          ...base.capabilities!.telemetry,
          providerCost: { reporting: 'optional' },
        },
      },
    };
    const common = pairedInput(unmetered);
    const unverifiable = await evaluate({
      ...common,
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: {
          execution: { maxProviderCost: { amount: 1, currency: 'USD' } },
          onUnreportedProviderCost: 'mark-unverifiable',
        },
      },
      decision: undefined
    }, {
      runId: 'canonical-unreported-cost-unverifiable',
      clock: fixedClock
    });
    expect(unverifiable.status).toBe('completed');
    if (unverifiable.status === 'failed') return;
    expect(unverifiable.report.budgetSummary.summaryStatus).toBe('unverifiable');
    expect(unverifiable.report.budgetSummary.scopes.find(
      (scope) => scope.scopeKind === 'stage' && scope.scopeId === 'execution',
    )?.totals.unreportedProviderCostInvocations).toBe(4);

    calls = 0;
    const failed = await evaluate({
      ...common,
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: {
          execution: { maxProviderCost: { amount: 1, currency: 'USD' } },
          onUnreportedProviderCost: 'fail-run',
        },
      },
      decision: undefined
    }, {
      runId: 'canonical-unreported-cost-failed',
      clock: fixedClock
    });
    expect(failed.status).toBe('failed');
    if (failed.status !== 'failed') return;
    expect(failed.error).toMatchObject({ code: 'provider-cost-unreported' });
    expect(calls).toBe(1);
  });

it('enforces active, wall-clock, coordinate, and attempt budget scopes in Core', async () => {
    let activeNow = 0;
    let activeCalls = 0;
    const activeExecutor = executor(async ({ input, config }) => {
      activeCalls += 1;
      activeNow += 5;
      return { output: config.answers[input.prompt] };
    });
    const active = await evaluate({
      ...pairedInput(activeExecutor),
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: { execution: { maxActiveDurationMs: 5 } },
      },
      decision: undefined
    }, {
      runId: 'canonical-active-duration-budget',
      clock: {
        monotonicNow: () => activeNow,
        timestamp: fixedClock.timestamp,
        sleep: fixedClock.sleep,
      }
    });
    expect(active.status).toBe('budget-exhausted');
    expect(activeCalls).toBe(2);

    let wallNow = 0;
    let wallCalls = 0;
    const wallExecutor = executor(async ({ input, config }) => {
      wallCalls += 1;
      wallNow += 1_000;
      return { output: config.answers[input.prompt] };
    });
    const wall = await evaluate({
      ...pairedInput(wallExecutor),
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: { run: { maxWallClockMs: 1000 } },
      },
      decision: undefined
    }, {
      runId: 'canonical-wall-clock-budget',
      clock: {
        monotonicNow: () => wallNow,
        timestamp: fixedClock.timestamp,
        sleep(_delayMs, signal) {
          return new Promise((_resolve, reject) => {
            const abort = () => reject(signal?.reason);
            if (signal?.aborted)
              abort();
            else
              signal?.addEventListener('abort', abort, { once: true });
          });
        },
      }
    });
    expect(wall.status).toBe('budget-exhausted');
    expect(wallCalls).toBe(2);

    let stageCalls = 0;
    const stageExecutor = executor(async ({ input, config }) => {
      stageCalls += 1;
      return { output: config.answers[input.prompt] };
    });
    const stage = await evaluate({
      ...pairedInput(stageExecutor),
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: { execution: { maxInvocations: 2 } },
      },
      decision: undefined
    }, {
      runId: 'canonical-stage-invocation-budget',
      clock: fixedClock
    });
    expect(stage.status).toBe('budget-exhausted');
    expect(stageCalls).toBe(2);
    expect(stage.artifacts?.execution?.coverage).toMatchObject({
      started: 2,
      budgetCensored: 2,
    });

    let retryCalls = 0;
    const retrying = executor(async () => {
      retryCalls += 1;
      return { errorCode: 'retry-me' };
    });
    const coordinate = await evaluate({
      ...pairedInput(retrying),
      policy: {
        execution: {
          maxConcurrency: 1,
          retry: {
            maxAttempts: 2,
            retryableErrorCodes: ['retry-me'],
            backoff: { backoffKind: 'none' },
          },
        },
        evaluation: { maxConcurrency: 1 },
        budget: { coordinate: { maxInvocations: 1 } },
      },
      decision: undefined
    }, {
      runId: 'canonical-coordinate-budget',
      clock: fixedClock
    });
    expect(coordinate.status).toBe('budget-exhausted');
    expect(retryCalls).toBe(2);

    let attemptCalls = 0;
    const attemptBase = executor(async ({ input, config }) => {
      attemptCalls += 1;
      return {
        output: config.answers[input.prompt],
        usage: {
          providerCost: { amount: 0.25, currency: 'USD', reportedByProvider: true },
        },
      };
    });
    const attemptExecutor: Executor<Input, Config, string> = {
      ...attemptBase,
      capabilities: {
        ...attemptBase.capabilities!,
        telemetry: {
          ...attemptBase.capabilities!.telemetry,
          providerCost: { reporting: 'optional' },
        },
      },
    };
    const attempt = await evaluate({
      ...pairedInput(attemptExecutor),
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: { attempt: { maxProviderCost: { amount: 0.2, currency: 'USD' } } },
      },
      decision: undefined
    }, {
      runId: 'canonical-attempt-budget',
      clock: fixedClock
    });
    expect(attempt.status).toBe('budget-exhausted');
    expect(attemptCalls).toBe(2);
  });

it('canonicalizes equivalent budgets and seals budget changes into run identity', async () => {
    const common = pairedInput();
    const first = await evaluate({
      ...common,
      policy: {
        ...common.policy,
        budget: {
          run: { maxInvocations: 100, maxActiveDurationMs: 5000 },
          execution: { maxInvocations: 80 },
          evaluation: { maxInvocations: 20 },
          coordinate: { maxInvocations: 3 },
        },
      }
    }, {
      runId: 'canonical-budget-identity-first',
      clock: fixedClock
    });
    const reordered = await evaluate({
      ...common,
      policy: {
        ...common.policy,
        budget: {
          coordinate: { maxInvocations: 3 },
          evaluation: { maxInvocations: 20 },
          execution: { maxInvocations: 80 },
          run: { maxActiveDurationMs: 5000, maxInvocations: 100 },
        },
      }
    }, {
      runId: 'canonical-budget-identity-reordered',
      clock: fixedClock
    });
    const changed = await evaluate({
      ...common,
      policy: {
        ...common.policy,
        budget: {
          run: { maxInvocations: 101, maxActiveDurationMs: 5000 },
          execution: { maxInvocations: 80 },
          evaluation: { maxInvocations: 20 },
          coordinate: { maxInvocations: 3 },
        },
      }
    }, {
      runId: 'canonical-budget-identity-changed',
      clock: fixedClock
    });

    expect(first.status).toBe('completed');
    expect(reordered.status).toBe('completed');
    expect(changed.status).toBe('completed');
    if (first.status !== 'completed'
      || reordered.status !== 'completed'
      || changed.status !== 'completed') return;
    expect(reordered.policy).toEqual(first.policy);
    expect(reordered.artifacts.execution.runContractDigest)
      .toBe(first.artifacts.execution.runContractDigest);
    expect(changed.artifacts.execution.runContractDigest)
      .not.toBe(first.artifacts.execution.runContractDigest);
  });

it('delegates execution and evaluation retries to the sealed Core stage policies', async () => {
    const executionAttempts: number[] = [];
    const executionSleeps: number[] = [];
    const flakyExecutor = executor(async ({ attemptNumber, input, config, signal }) => {
      signal.throwIfAborted();
      executionAttempts.push(attemptNumber);
      return attemptNumber === 1
        ? { errorCode: 'temporary-executor-failure' }
        : { output: config.answers[input.prompt] };
    });
    const executionResult = await evaluate({
      ...pairedInput(flakyExecutor),
      policy: {
        execution: {
          maxConcurrency: 1,
          retry: {
            maxAttempts: 2,
            retryableErrorCodes: ['temporary-executor-failure'],
            backoff: { backoffKind: 'fixed', initialDelayMs: 7 },
          },
        },
        evaluation: { maxConcurrency: 1 },
      }
    }, {
      runId: 'execution-retry',
      clock: {
        ...fixedClock,
        sleep(delayMs) {
          executionSleeps.push(delayMs);
          return Promise.resolve();
        },
      }
    });
    expect(executionResult.status).toBe('completed');
    expect(executionAttempts.filter((attempt) => attempt === 1)).toHaveLength(4);
    expect(executionAttempts.filter((attempt) => attempt === 2)).toHaveLength(4);
    expect(executionSleeps).toEqual([7, 7, 7, 7]);
    expect(executionResult.artifacts?.execution?.records.every((record) => (
      record.executionStatus === 'completed' && record.attempts.length === 2
    ))).toBe(true);

    const evaluationAttempts: number[] = [];
    const retryingEvaluator = numericCustomEvaluator(
      'retrying-evaluator',
      ({ attemptNumber }) => {
        evaluationAttempts.push(attemptNumber);
        return attemptNumber === 1
          ? { resultKind: 'failed', errorCode: 'temporary-evaluator-failure' }
          : {
            resultKind: 'completed',
            results: [{ metricId: 'retrying-evaluator-score', resultKind: 'score', value: 1 }],
          };
      },
    );
    const evaluationResult = await evaluate({
      ...pairedInput(),
      evaluators: [retryingEvaluator],
      comparisons: [{
        ...pairedInput().comparisons[0],
        metricIds: ['retrying-evaluator-score'],
      }],
      analyses: comparisonAnalysis('retrying-evaluator-score'),
      decision: undefined,
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: {
          maxConcurrency: 1,
          retry: {
            maxAttempts: 2,
            retryableErrorCodes: ['temporary-evaluator-failure'],
            backoff: { backoffKind: 'none' },
          },
        },
      }
    }, {
      runId: 'evaluation-retry',
      clock: fixedClock
    });
    expect(evaluationResult.status).toBe('completed');
    expect(evaluationAttempts.filter((attempt) => attempt === 1)).toHaveLength(4);
    expect(evaluationAttempts.filter((attempt) => attempt === 2)).toHaveLength(4);
    expect(evaluationResult.artifacts?.evaluation?.records.every((record) => (
      record.evaluationStatus === 'completed' && record.attempts.length === 2
    ))).toBe(true);

    let nonRetryableCalls = 0;
    const nonRetryable = await evaluate({
      ...pairedInput(),
      evaluators: [numericCustomEvaluator('non-retryable', () => {
        nonRetryableCalls += 1;
        return { resultKind: 'failed', errorCode: 'permanent-evaluator-failure' };
      })],
      comparisons: [{
        ...pairedInput().comparisons[0],
        metricIds: ['non-retryable-score'],
      }],
      analyses: comparisonAnalysis('non-retryable-score'),
      decision: undefined,
      policy: {
        evaluation: {
          maxConcurrency: 1,
          retry: {
            maxAttempts: 3,
            retryableErrorCodes: ['temporary-evaluator-failure'],
            backoff: { backoffKind: 'none' },
          },
        },
      }
    }, {
      runId: 'non-retryable-evaluation',
      clock: fixedClock
    });
    expect(nonRetryable.status).toBe('completed');
    expect(nonRetryableCalls).toBe(4);
    expect(nonRetryable.artifacts?.evaluation?.records.every((record) => (
      record.evaluationStatus === 'failed' && record.attempts.length === 1
    ))).toBe(true);
  });

it('applies the canonical failure threshold before admitting a later paired block', async () => {
    let calls = 0;
    const failingExecutor = executor(async () => {
      calls += 1;
      return { errorCode: 'permanent-executor-failure' };
    });
    const result = await evaluate({
      ...pairedInput(failingExecutor),
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        failure: { failureMode: 'failure-threshold', maxFailures: 0 },
      }
    }, {
      runId: 'failure-threshold',
      clock: fixedClock
    });

    expect(result.status).toBe('failed');
    expect(calls).toBe(2);
    expect(result.artifacts?.execution).toMatchObject({
      executionBundleStatus: 'failed',
      terminationReasonCode: 'failure-policy-threshold',
      coverage: { started: 2, failed: 2, notStarted: 2 },
    });
  });

it('rejects invalid or legacy policy shapes before the first Target invocation', async () => {
    let calls = 0;
    const countedExecutor = executor(async () => {
      calls += 1;
      return { output: 'A' };
    });
    const invalidPolicies: unknown[] = [
      { maxConcurrency: 2 },
      {
        execution: {
          retry: {
            maxAttempts: 2,
            retryableErrorCodes: ['timeout', 'timeout'],
            backoff: { backoffKind: 'none' },
          },
        },
      },
      { failure: { failureMode: 'continue', maxFailures: 1 } },
      { budget: { maxInvocations: 1 } },
      { budget: { execution: { maxWallClockMs: 1 } } },
      { budget: { attempt: { maxInvocations: 1 } } },
      {
        budget: {
          run: { maxProviderCost: { amount: 1, currency: 'USD' } },
          evaluation: { maxProviderCost: { amount: 1, currency: 'CNY' } },
        },
      },
    ];

    for (const policy of invalidPolicies) {
      await expect(evaluate({
        ...pairedInput(countedExecutor),
        policy,
        runId: 'invalid-policy-before-target',
      } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    }
    expect(calls).toBe(0);
  });
});
