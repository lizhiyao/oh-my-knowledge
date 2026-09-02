import {
  BUDGET_SUMMARY_SCHEMA_VERSION,
  BudgetSummarySchema,
  budgetSummaryMatchesPolicy,
  digestCanonicalJson,
  type BudgetLedgerEntry,
  type BudgetScopeLimitSnapshot,
  type BudgetScopeSummary,
  type BudgetSummary,
  type BudgetTermination,
  type EvaluationError,
  type Sha256Digest,
  type UsageRecord,
} from '../contracts/index.js';
import { snapshotJson } from '../compiler/immutability.js';
import type { SealedRunPlan } from '../compiler/index.js';

export type BudgetStage = 'execution' | 'evaluation';

export interface RunBudgetClock {
  monotonicNow(): number;
  timestamp(): string;
}

export interface ProviderCostUpperBound {
  amount: number;
  currency: string;
}

export interface BudgetReservationRequest {
  stage: BudgetStage;
  coordinateId: Sha256Digest;
  attemptId: Sha256Digest;
  providerCostUpperBound?: ProviderCostUpperBound;
}

export type BudgetAdmission = {
  admitted: true;
  reservationIds: readonly string[];
} | {
  admitted: false;
  termination: BudgetTermination;
};

declare const runBudgetSourceBrand: unique symbol;

/** Opaque, immutable capability handle. Mutable ledger authority remains Core-private. */
export interface RunBudgetSource {
  readonly runId: string;
  readonly runContractDigest: Sha256Digest;
  readonly [runBudgetSourceBrand]: true;
}

export interface RunBudgetController {
  reserve(requests: readonly BudgetReservationRequest[]): BudgetAdmission;
  consume(reservationId: string): void;
  release(reservationId: string): void;
  settle(
    reservationId: string,
    activeDurationMs: number,
    usage: UsageRecord | undefined,
    outcomeKind: BudgetLedgerEntry['outcomeKind'],
  ): EvaluationError | undefined;
  noteTermination(termination: BudgetTermination): void;
  wallClockRemainingMs(): number | undefined;
  snapshot(): BudgetSummary;
}

interface Reservation extends BudgetReservationRequest {
  reservationId: string;
  consumed: boolean;
}

interface MutableTotals {
  invocations: number;
  activeDurationMs: number;
  providerCosts: Map<string, number>;
  unreportedProviderCostInvocations: number;
}

const runBudgetSources = new WeakMap<object, RunBudgetAuthority>();

function emptyTotals(): MutableTotals {
  return {
    invocations: 0,
    activeDurationMs: 0,
    providerCosts: new Map(),
    unreportedProviderCostInvocations: 0,
  };
}

function configurationFailure(code: string, message: string): EvaluationError {
  return { code, stage: 'configuration', message };
}

function costCurrency(plan: SealedRunPlan, stage: BudgetStage): string | undefined {
  const policy = plan.measurementPolicy.budget;
  return policy.run.maxProviderCost?.currency
    ?? policy.stages[stage].maxProviderCost?.currency
    ?? policy.coordinate.maxProviderCost?.currency
    ?? policy.attempt.maxProviderCost?.currency;
}

function scopeKey(kind: 'run' | 'stage' | 'coordinate', id: string): string {
  return `${kind}:${id}`;
}

class RunBudgetAuthority implements RunBudgetController {
  readonly runId: string;
  readonly runContractDigest: Sha256Digest;
  readonly #plan: SealedRunPlan;
  readonly #clock: RunBudgetClock;
  readonly #reservations = new Map<string, Reservation>();
  readonly #entries: BudgetLedgerEntry[] = [];
  readonly #totals = new Map<string, MutableTotals>();
  readonly #startedMonotonic: number;
  readonly #initialWallClockElapsedMs: number;
  #reservationSequence = 0;
  #termination?: BudgetTermination;
  #failed = false;
  #unverifiable = false;
  #unreservedInFlight = 0;
  #maximumUnreservedInFlight = 0;

  constructor(
    plan: SealedRunPlan,
    runId: string,
    clock: RunBudgetClock,
    seed?: BudgetSummary,
    seedBindingMode: 'exact' | 'authenticated-stage-handoff' = 'exact',
  ) {
    this.#plan = plan;
    this.runId = runId;
    this.runContractDigest = plan.digests.runContractDigest as Sha256Digest;
    this.#clock = clock;
    this.#startedMonotonic = clock.monotonicNow();
    this.#initialWallClockElapsedMs = seed?.wallClock.elapsedMs ?? 0;
    this.#totals.set(scopeKey('run', runId), emptyTotals());
    this.#totals.set(scopeKey('stage', 'execution'), emptyTotals());
    this.#totals.set(scopeKey('stage', 'evaluation'), emptyTotals());
    if (seed !== undefined) {
      const parsedSeed = BudgetSummarySchema.parse(seed);
      if ((seedBindingMode === 'exact'
            && parsedSeed.runContractDigest !== this.runContractDigest)
          || !budgetSummaryMatchesPolicy(parsedSeed, plan.measurementPolicy.budget)
          || parsedSeed.reservations.outstandingInvocations !== 0) {
        throw new TypeError(
          'A budget handoff snapshot must be quiescent and bound to the same Run contract.',
        );
      }
      for (const entry of parsedSeed.entries) {
        this.#entries.push(snapshotJson(entry));
        for (const [scopeKind, scopeId] of [
          ['run', runId],
          ['stage', entry.stage],
          ['coordinate', entry.coordinateId],
        ] as const) {
          const key = scopeKey(scopeKind, scopeId);
          const totals = this.#totals.get(key) ?? emptyTotals();
          totals.invocations += 1;
          totals.activeDurationMs += entry.activeDurationMs;
          if (entry.providerCost === undefined) totals.unreportedProviderCostInvocations += 1;
          else {
            totals.providerCosts.set(
              entry.providerCost.currency,
              (totals.providerCosts.get(entry.providerCost.currency) ?? 0)
                + entry.providerCost.amount,
            );
          }
          this.#totals.set(key, totals);
        }
      }
      this.#maximumUnreservedInFlight = seed.maximumUnreservedInFlightInvocations;
      this.#termination = seed.termination === undefined
        ? undefined
        : snapshotJson(seed.termination);
      this.#failed = seed.summaryStatus === 'failed';
      this.#unverifiable = seed.summaryStatus === 'unverifiable';
    }
  }

  assertBinding(plan: SealedRunPlan, runId: string): void {
    if (runId !== this.runId
        || plan.digests.runContractDigest !== this.runContractDigest) {
      throw new TypeError(
        'Run budget capability is not authentic or is bound to another runContractDigest.',
      );
    }
  }

  reserve(requests: readonly BudgetReservationRequest[]): BudgetAdmission {
    if (requests.length === 0) return { admitted: true, reservationIds: [] };
    if (this.#failed || this.#termination?.terminationKind === 'cancelled') {
      return {
        admitted: false,
        termination: this.#termination ?? {
          terminationKind: 'failed',
          reasonCode: 'run-budget-source-failed',
        },
      };
    }
    const existing = [...this.#reservations.values()];
    const policy = this.#plan.measurementPolicy.budget;
    if (policy.run.maxWallClockMs !== undefined
        && this.wallClockElapsedMs() >= policy.run.maxWallClockMs) {
      return {
        admitted: false,
        termination: {
          terminationKind: 'wall-clock-exhausted',
          resourceKind: 'wall-clock',
          scopeKind: 'run',
          scopeId: this.runId,
          reasonCode: 'run-wall-clock-budget-exhausted',
        },
      };
    }
    const admissionMode = policy.providerCostAdmission.admissionMode;
    const projected = [...existing, ...requests.map((request, index) => ({
      ...request,
      reservationId: `pending-${index}`,
      consumed: false,
    }))];
    const checks: Array<{
      scopeKind: 'run' | 'stage' | 'coordinate';
      scopeId: string;
      maxInvocations?: number;
      maxProviderCost?: { amount: number; currency: string };
      maxActiveDurationMs?: number;
      requestFilter: (request: BudgetReservationRequest) => boolean;
    }> = [{
      scopeKind: 'run',
      scopeId: this.runId,
      ...policy.run,
      requestFilter: () => true,
    }];
    for (const stage of ['execution', 'evaluation'] as const) {
      checks.push({
        scopeKind: 'stage',
        scopeId: stage,
        ...policy.stages[stage],
        requestFilter: (request) => request.stage === stage,
      });
    }
    for (const coordinateId of new Set(requests.map((request) => request.coordinateId))) {
      checks.push({
        scopeKind: 'coordinate',
        scopeId: coordinateId,
        ...policy.coordinate,
        requestFilter: (request) => request.coordinateId === coordinateId,
      });
    }
    for (const check of checks) {
      const totals = this.#totals.get(scopeKey(check.scopeKind, check.scopeId)) ?? emptyTotals();
      const reserved = projected.filter(check.requestFilter);
      if (check.maxActiveDurationMs !== undefined
          && totals.activeDurationMs >= check.maxActiveDurationMs) {
        return {
          admitted: false,
          termination: {
            terminationKind: 'budget-censored',
            resourceKind: 'active-duration',
            scopeKind: check.scopeKind,
            scopeId: check.scopeId,
            reasonCode: `${check.scopeKind}-active-duration-budget-exhausted`,
          },
        };
      }
      if (admissionMode === 'bounded-overshoot'
          && check.maxProviderCost !== undefined
          && (totals.providerCosts.get(check.maxProviderCost.currency) ?? 0)
            >= check.maxProviderCost.amount) {
        return {
          admitted: false,
          termination: {
            terminationKind: 'budget-censored',
            resourceKind: 'provider-cost',
            scopeKind: check.scopeKind,
            scopeId: check.scopeId,
            reasonCode: `${check.scopeKind}-provider-cost-budget-exhausted`,
          },
        };
      }
      if (check.maxInvocations !== undefined
          && totals.invocations + reserved.length > check.maxInvocations) {
        return {
          admitted: false,
          termination: {
            terminationKind: 'budget-censored',
            resourceKind: 'invocations',
            scopeKind: check.scopeKind,
            scopeId: check.scopeId,
            reasonCode: `${check.scopeKind}-invocation-budget-exhausted`,
          },
        };
      }
      if (admissionMode === 'strict-reservation' && check.maxProviderCost !== undefined) {
        let reservationAmount = 0;
        for (const reservation of reserved) {
          const bound = reservation.providerCostUpperBound;
          if (bound === undefined || bound.currency !== check.maxProviderCost.currency) {
            return {
              admitted: false,
              termination: {
                terminationKind: 'failed',
                resourceKind: 'provider-cost',
                scopeKind: check.scopeKind,
                scopeId: check.scopeId,
                reasonCode: 'provider-cost-bound-unavailable',
              },
            };
          }
          reservationAmount += bound.amount;
        }
        if ((totals.providerCosts.get(check.maxProviderCost.currency) ?? 0)
            + reservationAmount > check.maxProviderCost.amount) {
          return {
            admitted: false,
            termination: {
              terminationKind: 'budget-censored',
              resourceKind: 'provider-cost',
              scopeKind: check.scopeKind,
              scopeId: check.scopeId,
              reasonCode: `${check.scopeKind}-provider-cost-budget-exhausted`,
            },
          };
        }
      }
    }
    if (policy.attempt.maxProviderCost !== undefined) {
      for (const request of requests) {
        if (admissionMode === 'strict-reservation'
            && (request.providerCostUpperBound === undefined
              || request.providerCostUpperBound.currency
                !== policy.attempt.maxProviderCost.currency)) {
          return {
            admitted: false,
            termination: {
              terminationKind: 'failed',
              resourceKind: 'provider-cost',
              scopeKind: 'attempt',
              scopeId: request.attemptId,
              reasonCode: 'provider-cost-bound-unavailable',
            },
          };
        }
        if (request.providerCostUpperBound !== undefined
            && request.providerCostUpperBound.amount > policy.attempt.maxProviderCost.amount) {
          return {
            admitted: false,
            termination: {
              terminationKind: 'budget-censored',
              resourceKind: 'provider-cost',
              scopeKind: 'attempt',
              scopeId: request.attemptId,
              reasonCode: 'attempt-provider-cost-budget-exhausted',
            },
          };
        }
      }
    }
    const reservationIds = requests.map((request) => {
      const reservationId = `budget-reservation-${this.#reservationSequence}`;
      this.#reservationSequence += 1;
      this.#reservations.set(reservationId, {
        ...request,
        reservationId,
        consumed: false,
      });
      return reservationId;
    });
    if (admissionMode === 'bounded-overshoot') {
      const costTrackedCount = requests.filter(
        (request) => costCurrency(this.#plan, request.stage) !== undefined,
      ).length;
      this.#unreservedInFlight += costTrackedCount;
      this.#maximumUnreservedInFlight = Math.max(
        this.#maximumUnreservedInFlight,
        this.#unreservedInFlight,
      );
    }
    return { admitted: true, reservationIds };
  }

  consume(reservationId: string): void {
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined || reservation.consumed) {
      throw new TypeError('Budget reservation is missing or already consumed.');
    }
    reservation.consumed = true;
  }

  release(reservationId: string): void {
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined) return;
    this.#reservations.delete(reservationId);
    if (this.#plan.measurementPolicy.budget.providerCostAdmission.admissionMode
        === 'bounded-overshoot'
        && costCurrency(this.#plan, reservation.stage) !== undefined) {
      this.#unreservedInFlight = Math.max(0, this.#unreservedInFlight - 1);
    }
  }

  settle(
    reservationId: string,
    activeDurationMs: number,
    usage: UsageRecord | undefined,
    outcomeKind: BudgetLedgerEntry['outcomeKind'],
  ): EvaluationError | undefined {
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined || !reservation.consumed) {
      throw new TypeError('Only a consumed budget reservation can be settled.');
    }
    this.#reservations.delete(reservationId);
    if (this.#plan.measurementPolicy.budget.providerCostAdmission.admissionMode
        === 'bounded-overshoot'
        && costCurrency(this.#plan, reservation.stage) !== undefined) {
      this.#unreservedInFlight = Math.max(0, this.#unreservedInFlight - 1);
    }
    const providerCost = usage?.providerCost;
    const expectedCurrency = costCurrency(this.#plan, reservation.stage);
    let settlementError: EvaluationError | undefined;
    if (providerCost !== undefined && expectedCurrency !== undefined
        && providerCost.currency !== expectedCurrency) {
      this.#failed = true;
      settlementError = configurationFailure(
        'provider-cost-currency-mismatch',
        'Provider-reported cost currency differs from the sealed Run budget currency.',
      );
    }
    if (providerCost === undefined && expectedCurrency !== undefined) {
      if (this.#plan.measurementPolicy.budget.providerCostAdmission.unknownCostMode
          === 'fail-run') {
        this.#failed = true;
        settlementError = configurationFailure(
          'provider-cost-unreported',
          'A provider-cost budget requires every native invocation to report cost.',
        );
      } else this.#unverifiable = true;
    }
    if (providerCost !== undefined && reservation.providerCostUpperBound !== undefined
        && providerCost.amount > reservation.providerCostUpperBound.amount) {
      this.#failed = true;
      settlementError ??= configurationFailure(
        'provider-cost-bound-violated',
        'Provider-reported cost exceeds the trusted reservation bound.',
      );
    }
    const entry: BudgetLedgerEntry = {
      sequence: this.#entries.length,
      stage: reservation.stage,
      coordinateId: reservation.coordinateId,
      attemptId: reservation.attemptId,
      invocationCount: 1,
      activeDurationMs: Math.max(0, activeDurationMs),
      providerCostStatus: providerCost === undefined ? 'unreported' : 'reported',
      ...(providerCost === undefined ? {} : { providerCost: snapshotJson(providerCost) }),
      ...(this.#plan.measurementPolicy.budget.providerCostAdmission.admissionMode
          !== 'strict-reservation' || reservation.providerCostUpperBound === undefined
        ? {}
        : {
          providerCostReservation: {
            ...snapshotJson(reservation.providerCostUpperBound),
            boundSource: 'verified-runtime-capability' as const,
            boundStatus: providerCost === undefined
              ? 'not-assessable' as const
              : providerCost.currency === reservation.providerCostUpperBound.currency
                  && providerCost.amount <= reservation.providerCostUpperBound.amount
                ? 'honored' as const
                : 'violated' as const,
          },
        }),
      admissionKind: this.#plan.measurementPolicy.budget.providerCostAdmission.admissionMode,
      outcomeKind,
    };
    this.#entries.push(entry);
    for (const [scopeKind, scopeId] of [
      ['run', this.runId],
      ['stage', reservation.stage],
      ['coordinate', reservation.coordinateId],
    ] as const) {
      const key = scopeKey(scopeKind, scopeId);
      const totals = this.#totals.get(key) ?? emptyTotals();
      totals.invocations += 1;
      totals.activeDurationMs += entry.activeDurationMs;
      if (providerCost === undefined) totals.unreportedProviderCostInvocations += 1;
      else {
        totals.providerCosts.set(
          providerCost.currency,
          (totals.providerCosts.get(providerCost.currency) ?? 0) + providerCost.amount,
        );
      }
      this.#totals.set(key, totals);
    }
    return settlementError ?? this.exhaustionAfter(entry);
  }

  noteTermination(termination: BudgetTermination): void {
    if (this.#termination === undefined || termination.terminationKind === 'failed') {
      this.#termination = snapshotJson(termination);
    }
    if (termination.terminationKind === 'failed') this.#failed = true;
  }

  wallClockRemainingMs(): number | undefined {
    const limit = this.#plan.measurementPolicy.budget.run.maxWallClockMs;
    if (limit === undefined) return undefined;
    return Math.max(0, limit - this.wallClockElapsedMs());
  }

  snapshot(): BudgetSummary {
    const policy = this.#plan.measurementPolicy.budget;
    const scopes: BudgetScopeSummary[] = [...this.#totals.entries()]
      .map(([key, totals]) => {
        const separator = key.indexOf(':');
        const scopeKind = key.slice(0, separator) as BudgetScopeSummary['scopeKind'];
        const scopeId = key.slice(separator + 1);
        const limits = this.scopeLimits(scopeKind, scopeId);
        const providerCostAmount = limits.maxProviderCost === undefined
          ? undefined
          : totals.providerCosts.get(limits.maxProviderCost.currency) ?? 0;
        return {
          scopeKind,
          scopeId,
          limits,
          totals: {
            invocations: totals.invocations,
            activeDurationMs: totals.activeDurationMs,
            ...(totals.providerCosts.size === 0
              ? {}
              : {
                reportedProviderCosts: [...totals.providerCosts.entries()]
                  .map(([currency, amount]) => ({ amount, currency }))
                  .sort((left, right) => left.currency.localeCompare(right.currency)),
              }),
            unreportedProviderCostInvocations: totals.unreportedProviderCostInvocations,
          },
          overshoot: {
            invocations: limits.maxInvocations === undefined
              ? 0
              : Math.max(0, totals.invocations - limits.maxInvocations),
            activeDurationMs: limits.maxActiveDurationMs === undefined
              ? 0
              : Math.max(0, totals.activeDurationMs - limits.maxActiveDurationMs),
            ...(limits.maxProviderCost === undefined
              ? {}
              : {
                providerCost: {
                  amount: Math.max(0, (providerCostAmount as number)
                    - limits.maxProviderCost.amount),
                  currency: limits.maxProviderCost.currency,
                },
              }),
          },
        };
      })
      .sort((left, right) => `${left.scopeKind}:${left.scopeId}`
        .localeCompare(`${right.scopeKind}:${right.scopeId}`));
    const outstandingProviderCosts = new Map<string, number>();
    for (const reservation of this.#reservations.values()) {
      const bound = reservation.providerCostUpperBound;
      if (bound !== undefined) {
        outstandingProviderCosts.set(
          bound.currency,
          (outstandingProviderCosts.get(bound.currency) ?? 0) + bound.amount,
        );
      }
    }
    const wallClockElapsedMs = this.wallClockElapsedMs();
    const payload = {
      schemaVersion: BUDGET_SUMMARY_SCHEMA_VERSION,
      runId: this.runId,
      runContractDigest: this.runContractDigest,
      capturedAt: this.#clock.timestamp(),
      summaryStatus: this.#failed
        ? 'failed' as const
        : this.#termination?.terminationKind === 'cancelled'
          ? 'cancelled' as const
          : this.#unverifiable
            ? 'unverifiable' as const
          : this.#termination === undefined
            ? 'within-budget' as const
            : 'exhausted' as const,
      admissionMode: this.#plan.measurementPolicy.budget.providerCostAdmission.admissionMode,
      maximumUnreservedInFlightInvocations: this.#maximumUnreservedInFlight,
      reservations: {
        outstandingInvocations: this.#reservations.size,
        ...(outstandingProviderCosts.size === 0
          ? {}
          : {
            outstandingProviderCosts: [...outstandingProviderCosts.entries()]
              .map(([currency, amount]) => ({ amount, currency }))
              .sort((left, right) => left.currency.localeCompare(right.currency)),
          }),
      },
      wallClock: {
        elapsedMs: wallClockElapsedMs,
        ...(policy.run.maxWallClockMs === undefined
          ? {}
          : { limitMs: policy.run.maxWallClockMs }),
        overshootMs: policy.run.maxWallClockMs === undefined
          ? 0
          : Math.max(0, wallClockElapsedMs - policy.run.maxWallClockMs),
      },
      entries: snapshotJson(this.#entries),
      scopes,
      ...(this.#termination === undefined ? {} : { termination: this.#termination }),
    };
    return BudgetSummarySchema.parse({
      ...payload,
      ledgerDigest: digestCanonicalJson(payload),
    });
  }

  private exhaustionAfter(entry: BudgetLedgerEntry): EvaluationError | undefined {
    const policy = this.#plan.measurementPolicy.budget;
    const checks = [
      { scopeKind: 'run' as const, scopeId: this.runId, limits: policy.run },
      { scopeKind: 'stage' as const, scopeId: entry.stage, limits: policy.stages[entry.stage] },
      { scopeKind: 'coordinate' as const, scopeId: entry.coordinateId, limits: policy.coordinate },
    ];
    for (const check of checks) {
      const totals = this.#totals.get(scopeKey(check.scopeKind, check.scopeId)) as MutableTotals;
      const resourceKind = check.limits.maxProviderCost !== undefined
          && (totals.providerCosts.get(check.limits.maxProviderCost.currency) ?? 0)
            >= check.limits.maxProviderCost.amount
        ? 'provider-cost' as const
        : check.limits.maxActiveDurationMs !== undefined
            && totals.activeDurationMs >= check.limits.maxActiveDurationMs
          ? 'active-duration' as const
          : undefined;
      if (resourceKind !== undefined) {
        const termination: BudgetTermination = {
          terminationKind: 'active-budget-exhausted',
          resourceKind,
          scopeKind: check.scopeKind,
          scopeId: check.scopeId,
          reasonCode: `${check.scopeKind}-${resourceKind}-budget-exhausted`,
        };
        this.noteTermination(termination);
        return {
          code: termination.reasonCode,
          stage: entry.stage,
          message: 'The sealed shared Run budget was exhausted.',
        };
      }
    }
    const attemptLimit = policy.attempt.maxProviderCost;
    if (attemptLimit !== undefined && entry.providerCost !== undefined
        && entry.providerCost.amount >= attemptLimit.amount) {
      const termination: BudgetTermination = {
        terminationKind: 'active-budget-exhausted',
        resourceKind: 'provider-cost',
        scopeKind: 'attempt',
        scopeId: entry.attemptId,
        reasonCode: 'attempt-provider-cost-budget-exhausted',
      };
      this.noteTermination(termination);
      return {
        code: termination.reasonCode,
        stage: entry.stage,
        message: 'The sealed attempt provider-cost budget was exhausted.',
      };
    }
    return undefined;
  }

  private wallClockElapsedMs(): number {
    return this.#initialWallClockElapsedMs
      + Math.max(0, this.#clock.monotonicNow() - this.#startedMonotonic);
  }

  private scopeLimits(
    scopeKind: BudgetScopeSummary['scopeKind'],
    scopeId: string,
  ): BudgetScopeLimitSnapshot {
    const policy = this.#plan.measurementPolicy.budget;
    if (scopeKind === 'run') {
      const { maxWallClockMs: _maxWallClockMs, ...limits } = policy.run;
      void _maxWallClockMs;
      return snapshotJson(limits);
    }
    if (scopeKind === 'stage') {
      if (scopeId !== 'execution' && scopeId !== 'evaluation') {
        throw new TypeError('Budget ledger contains an unknown stage scope.');
      }
      return snapshotJson(policy.stages[scopeId]);
    }
    return snapshotJson(policy.coordinate);
  }
}

export function createRunBudgetSource(
  plan: SealedRunPlan,
  runId: string,
  clock: RunBudgetClock,
  seed?: BudgetSummary,
  seedBindingMode: 'exact' | 'authenticated-stage-handoff' = 'exact',
): RunBudgetSource {
  const authority = new RunBudgetAuthority(
    plan,
    runId,
    clock,
    seed,
    seedBindingMode,
  );
  const source = Object.freeze({
    runId: authority.runId,
    runContractDigest: authority.runContractDigest,
  }) as RunBudgetSource;
  runBudgetSources.set(source, authority);
  return source;
}

export function assertRunBudgetSource(
  source: unknown,
  plan: SealedRunPlan,
  runId: string,
): asserts source is RunBudgetSource {
  if (source === null || typeof source !== 'object') {
    throw new TypeError('Run budget capability is not authentic.');
  }
  const authority = runBudgetSources.get(source);
  if (authority === undefined) throw new TypeError('Run budget capability is not authentic.');
  authority.assertBinding(plan, runId);
}

export function resolveRunBudgetSource(
  source: RunBudgetSource,
  plan: SealedRunPlan,
  runId: string,
): RunBudgetController {
  assertRunBudgetSource(source, plan, runId);
  return runBudgetSources.get(source) as RunBudgetAuthority;
}
