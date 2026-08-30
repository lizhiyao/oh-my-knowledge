import { describe, expect, it } from 'vitest';
import { prepareEvaluationPlan } from '../../../src/evaluation-core/compiler/index.js';
import {
  BudgetSummarySchema,
  digestCanonicalJson,
  type MeasurementPolicy,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  createRunBudgetSource,
  assertRunBudgetSource,
  type BudgetReservationRequest,
  type RunBudgetSource,
} from '../../../src/evaluation-core/budget/index.js';
import { testRuntime, validDefinition, validPolicy } from '../compiler/fixtures.js';

class Clock {
  now = 0;

  monotonicNow(): number { return this.now; }

  timestamp(): string {
    return new Date(Date.UTC(2026, 7, 30) + this.now).toISOString();
  }
}

async function planWith(
  mutate: (policy: MeasurementPolicy) => void = () => undefined,
) {
  const policy = validPolicy();
  mutate(policy);
  return prepareEvaluationPlan(validDefinition(), policy, testRuntime());
}

function request(
  stage: 'execution' | 'evaluation',
  coordinate: string,
  attempt: number,
  providerCostUpperBound?: { amount: number; currency: string },
): BudgetReservationRequest {
  return {
    stage,
    coordinateId: digestCanonicalJson({ coordinate }) as Sha256Digest,
    attemptId: digestCanonicalJson({ coordinate, stage, attempt }) as Sha256Digest,
    ...(providerCostUpperBound === undefined ? {} : { providerCostUpperBound }),
  };
}

describe('shared Run budget ledger', () => {
  it('binds an unforgeable capability to one run and RunContract', async () => {
    const plan = await planWith();
    const source = createRunBudgetSource(plan, 'run-a', new Clock());

    expect(() => source.assertBinding(plan, 'run-b')).toThrow(/another runContractDigest/);
    const otherPlan = await planWith((policy) => {
      policy.budget.run.maxInvocations = 199;
    });
    expect(() => source.assertBinding(otherPlan, 'run-a')).toThrow(/another runContractDigest/);
    expect(() => source.assertBinding(plan, 'run-a')).not.toThrow();
    expect(() => assertRunBudgetSource({
      assertBinding() {},
    } as unknown as RunBudgetSource, plan, 'run-a')).toThrow(/not authentic/);
  });

  it('admits a scheduling block atomically and leaves no partial reservation', async () => {
    const plan = await planWith((policy) => {
      policy.budget.stages.execution.maxInvocations = 1;
    });
    const source = createRunBudgetSource(plan, 'run-atomic', new Clock());
    const admission = source.reserve([
      request('execution', 'pair-a', 1),
      request('execution', 'pair-b', 1),
    ]);

    expect(admission).toMatchObject({
      admitted: false,
      termination: {
        terminationKind: 'budget-censored',
        resourceKind: 'invocations',
        scopeKind: 'stage',
      },
    });
    expect(source.snapshot().entries).toEqual([]);
  });

  it('charges Execution and every Evaluator retry to the same coordinate and Run', async () => {
    const plan = await planWith((policy) => {
      policy.budget.run.maxInvocations = 3;
      policy.budget.coordinate.maxInvocations = 2;
    });
    const source = createRunBudgetSource(plan, 'run-shared', new Clock());
    const first = source.reserve([request('execution', 'trial-a', 1)]);
    if (!first.admitted) throw new Error('unexpected denial');
    source.consume(first.reservationIds[0]);
    source.settle(first.reservationIds[0], 4, undefined, 'completed');
    const second = source.reserve([request('evaluation', 'trial-a', 1)]);
    if (!second.admitted) throw new Error('unexpected denial');
    source.consume(second.reservationIds[0]);
    source.settle(second.reservationIds[0], 6, undefined, 'attempt-timeout');

    expect(source.reserve([request('evaluation', 'trial-a', 2)])).toMatchObject({
      admitted: false,
      termination: {
        scopeKind: 'coordinate',
        resourceKind: 'invocations',
      },
    });
    expect(source.snapshot()).toMatchObject({
      entries: [
        { stage: 'execution', outcomeKind: 'completed' },
        { stage: 'evaluation', outcomeKind: 'attempt-timeout' },
      ],
      scopes: expect.arrayContaining([
        expect.objectContaining({
          scopeKind: 'run',
          totals: expect.objectContaining({ invocations: 2, activeDurationMs: 10 }),
        }),
        expect.objectContaining({
          scopeKind: 'coordinate',
          totals: expect.objectContaining({ invocations: 2, activeDurationMs: 10 }),
        }),
      ]),
    });
  });

  it('requires trusted monetary bounds for strict reservation', async () => {
    const plan = await planWith((policy) => {
      policy.budget.stages.execution.maxProviderCost = { amount: 1, currency: 'USD' };
      policy.budget.providerCostAdmission.admissionMode = 'strict-reservation';
    });
    const source = createRunBudgetSource(plan, 'run-strict', new Clock());

    expect(source.reserve([request('execution', 'trial-a', 1)])).toMatchObject({
      admitted: false,
      termination: {
        terminationKind: 'failed',
        reasonCode: 'provider-cost-bound-unavailable',
      },
    });
    expect(source.reserve([
      request('execution', 'trial-a', 1, { amount: 0.6, currency: 'USD' }),
      request('execution', 'trial-b', 1, { amount: 0.6, currency: 'USD' }),
    ])).toMatchObject({
      admitted: false,
      termination: {
        terminationKind: 'budget-censored',
        resourceKind: 'provider-cost',
      },
    });
    const admitted = source.reserve([
      request('execution', 'trial-c', 1, { amount: 0.5, currency: 'USD' }),
    ]);
    if (!admitted.admitted) throw new Error('unexpected denial');
    source.consume(admitted.reservationIds[0]);
    source.settle(admitted.reservationIds[0], 2, {
      providerCost: { amount: 0.4, currency: 'USD', reportedByProvider: true },
    }, 'completed');
    expect(source.snapshot()).toMatchObject({
      reservations: { outstandingInvocations: 0 },
      maximumUnreservedInFlightInvocations: 0,
      entries: [expect.objectContaining({
        providerCostReservation: {
          amount: 0.5,
          currency: 'USD',
          boundSource: 'verified-runtime-capability',
          boundStatus: 'honored',
        },
      })],
    });
  });

  it('exposes bounded overshoot and never treats unknown cost as zero', async () => {
    const plan = await planWith((policy) => {
      policy.budget.stages.evaluation.maxProviderCost = { amount: 1, currency: 'USD' };
      policy.budget.providerCostAdmission.unknownCostMode = 'mark-unverifiable';
    });
    const source = createRunBudgetSource(plan, 'run-overshoot', new Clock());
    const admission = source.reserve([
      request('evaluation', 'trial-a', 1),
      request('evaluation', 'trial-b', 1),
    ]);
    if (!admission.admitted) throw new Error('unexpected denial');
    admission.reservationIds.forEach((id) => source.consume(id));
    source.settle(admission.reservationIds[0], 2, {
      providerCost: { amount: 1.25, currency: 'USD', reportedByProvider: true },
    }, 'completed');
    source.settle(admission.reservationIds[1], 3, undefined, 'failed');

    const summary = source.snapshot();
    expect(summary).toMatchObject({
      summaryStatus: 'unverifiable',
      maximumUnreservedInFlightInvocations: 2,
    });
    expect(summary.scopes.find((scope) => (
      scope.scopeKind === 'stage' && scope.scopeId === 'evaluation'
    ))).toMatchObject({
      totals: {
        reportedProviderCosts: [{ amount: 1.25, currency: 'USD' }],
        unreportedProviderCostInvocations: 1,
      },
      limits: { maxProviderCost: { amount: 1, currency: 'USD' } },
      overshoot: {
        invocations: 0,
        activeDurationMs: 0,
        providerCost: { amount: 0.25, currency: 'USD' },
      },
    });
  });

  it('carries one monotonic wall-clock deadline across a detached stage handoff', async () => {
    const plan = await planWith((policy) => {
      policy.budget.run.maxWallClockMs = 10;
    });
    const executionClock = new Clock();
    const execution = createRunBudgetSource(plan, 'run-deadline', executionClock);
    executionClock.now = 3;
    const evaluationClock = new Clock();
    const evaluation = createRunBudgetSource(
      plan,
      'run-deadline',
      evaluationClock,
      execution.snapshot(),
    );
    evaluationClock.now = 4;

    expect(evaluation.wallClockRemainingMs()).toBe(3);
    expect(evaluation.snapshot().wallClock).toEqual({
      elapsedMs: 7,
      limitMs: 10,
      overshootMs: 0,
    });
  });

  it('fails closed on currency mismatch and trusted-bound violation', async () => {
    const plan = await planWith((policy) => {
      policy.budget.run.maxProviderCost = { amount: 10, currency: 'USD' };
    });
    const source = createRunBudgetSource(plan, 'run-currency', new Clock());
    const admission = source.reserve([
      request('execution', 'trial-a', 1, { amount: 1, currency: 'USD' }),
    ]);
    if (!admission.admitted) throw new Error('unexpected denial');
    source.consume(admission.reservationIds[0]);

    expect(source.settle(admission.reservationIds[0], 1, {
      providerCost: { amount: 1, currency: 'EUR', reportedByProvider: true },
    }, 'completed')).toMatchObject({ code: 'provider-cost-currency-mismatch' });
    expect(source.snapshot().summaryStatus).toBe('failed');
  });

  it('rejects tampered summaries whose totals or digest are not recomputable', async () => {
    const plan = await planWith();
    const source = createRunBudgetSource(plan, 'run-audit', new Clock());
    const admission = source.reserve([request('execution', 'trial-a', 1)]);
    if (!admission.admitted) throw new Error('unexpected denial');
    source.consume(admission.reservationIds[0]);
    source.settle(admission.reservationIds[0], 5, undefined, 'cancelled');
    const summary = structuredClone(source.snapshot());
    summary.scopes[0].totals.invocations += 1;

    expect(() => BudgetSummarySchema.parse(summary)).toThrow(/recomputable/);
  });
});
