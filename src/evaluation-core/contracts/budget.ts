import { z } from 'zod';
import {
  IdentifierSchema,
  Sha256DigestSchema,
  TimestampSchema,
} from './common.js';
import { canonicalizeJson, digestCanonicalJson } from './json.js';
const LedgerProviderCostSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reportedByProvider: z.literal(true),
}).strict();

const ProviderCostFactSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const BudgetScopeLimitSnapshotSchema = z.object({
  maxInvocations: z.number().int().positive().optional(),
  maxProviderCost: ProviderCostFactSchema.optional(),
  maxActiveDurationMs: z.number().int().positive().optional(),
}).strict();

export const BUDGET_SUMMARY_SCHEMA_VERSION = 'omk.budget-summary/v1' as const;

export const BudgetTerminationSchema = z.object({
  terminationKind: z.enum([
    'budget-censored',
    'active-budget-exhausted',
    'wall-clock-exhausted',
    'attempt-timeout',
    'cancelled',
    'failed',
  ]),
  resourceKind: z.enum([
    'invocations',
    'provider-cost',
    'active-duration',
    'wall-clock',
  ]).optional(),
  scopeKind: z.enum(['run', 'stage', 'coordinate', 'attempt']).optional(),
  scopeId: IdentifierSchema.optional(),
  reasonCode: IdentifierSchema,
}).strict();

export const BudgetLedgerEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  stage: z.enum(['execution', 'evaluation']),
  coordinateId: Sha256DigestSchema,
  attemptId: Sha256DigestSchema,
  invocationCount: z.literal(1),
  activeDurationMs: z.number().nonnegative(),
  providerCostStatus: z.enum(['reported', 'unreported']),
  providerCost: LedgerProviderCostSchema.optional(),
  providerCostReservation: ProviderCostFactSchema.extend({
    boundSource: z.literal('verified-runtime-capability'),
    boundStatus: z.enum(['honored', 'violated', 'not-assessable']),
  }).strict().optional(),
  admissionKind: z.enum(['strict-reservation', 'bounded-overshoot']),
  outcomeKind: z.enum(['completed', 'failed', 'cancelled', 'attempt-timeout']),
}).strict().superRefine((entry, context) => {
  if ((entry.providerCostStatus === 'reported') !== (entry.providerCost !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['providerCost'],
      message: 'Reported provider cost status must carry exactly one provider cost fact.',
    });
  }
  if (entry.admissionKind === 'bounded-overshoot'
      && entry.providerCostReservation !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['providerCostReservation'],
      message: 'Bounded-overshoot entries cannot claim a strict provider-cost reservation.',
    });
  }
  if (entry.providerCostReservation !== undefined) {
    const expectedStatus = entry.providerCost === undefined
      ? 'not-assessable'
      : entry.providerCost.currency === entry.providerCostReservation.currency
          && entry.providerCost.amount <= entry.providerCostReservation.amount
        ? 'honored'
        : 'violated';
    if (entry.providerCostReservation.boundStatus === expectedStatus) return;
    context.addIssue({
      code: 'custom',
      path: ['providerCostReservation', 'boundStatus'],
      message: 'Provider-cost reservation status must match the reported cost fact.',
    });
  }
});

export const BudgetUsageTotalsSchema = z.object({
  invocations: z.number().int().nonnegative(),
  activeDurationMs: z.number().nonnegative(),
  reportedProviderCosts: z.array(ProviderCostFactSchema).optional(),
  unreportedProviderCostInvocations: z.number().int().nonnegative(),
}).strict();

export const BudgetOvershootSchema = z.object({
  invocations: z.number().int().nonnegative(),
  activeDurationMs: z.number().nonnegative(),
  providerCost: ProviderCostFactSchema.optional(),
}).strict();

export const BudgetScopeSummarySchema = z.object({
  scopeKind: z.enum(['run', 'stage', 'coordinate']),
  scopeId: IdentifierSchema,
  limits: BudgetScopeLimitSnapshotSchema,
  totals: BudgetUsageTotalsSchema,
  overshoot: BudgetOvershootSchema,
}).strict();

export const BudgetReservationSummarySchema = z.object({
  outstandingInvocations: z.number().int().nonnegative(),
  outstandingProviderCosts: z.array(ProviderCostFactSchema).optional(),
}).strict();

export const BudgetWallClockSummarySchema = z.object({
  elapsedMs: z.number().nonnegative(),
  limitMs: z.number().int().positive().optional(),
  overshootMs: z.number().nonnegative(),
}).strict();

export const BudgetSummarySchema = z.object({
  schemaVersion: z.literal(BUDGET_SUMMARY_SCHEMA_VERSION),
  runId: IdentifierSchema,
  runContractDigest: Sha256DigestSchema,
  capturedAt: TimestampSchema,
  summaryStatus: z.enum([
    'within-budget',
    'exhausted',
    'unverifiable',
    'cancelled',
    'failed',
  ]),
  admissionMode: z.enum(['strict-reservation', 'bounded-overshoot']),
  maximumUnreservedInFlightInvocations: z.number().int().nonnegative(),
  reservations: BudgetReservationSummarySchema,
  wallClock: BudgetWallClockSummarySchema,
  entries: z.array(BudgetLedgerEntrySchema),
  scopes: z.array(BudgetScopeSummarySchema),
  termination: BudgetTerminationSchema.optional(),
  ledgerDigest: Sha256DigestSchema,
}).strict().superRefine((summary, context) => {
  if (summary.entries.some((entry, index) => entry.sequence !== index)) {
    context.addIssue({
      code: 'custom',
      path: ['entries'],
      message: 'Budget ledger entries must use contiguous canonical sequence numbers.',
    });
  }
  if (new Set(summary.entries.map((entry) => entry.attemptId)).size
      !== summary.entries.length) {
    context.addIssue({
      code: 'custom',
      path: ['entries'],
      message: 'A budget ledger cannot charge one attempt more than once.',
    });
  }
  if (summary.admissionMode === 'strict-reservation'
      && summary.maximumUnreservedInFlightInvocations !== 0) {
    context.addIssue({
      code: 'custom',
      path: ['maximumUnreservedInFlightInvocations'],
      message: 'Strict reservation cannot report unreserved cost-bearing invocations.',
    });
  }
  if (summary.reservations.outstandingInvocations === 0
      && summary.reservations.outstandingProviderCosts !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['reservations', 'outstandingProviderCosts'],
      message: 'A quiescent budget snapshot cannot retain provider-cost reservations.',
    });
  }
  const expectedWallClockOvershoot = summary.wallClock.limitMs === undefined
    ? 0
    : Math.max(0, summary.wallClock.elapsedMs - summary.wallClock.limitMs);
  if (summary.wallClock.overshootMs !== expectedWallClockOvershoot) {
    context.addIssue({
      code: 'custom',
      path: ['wallClock', 'overshootMs'],
      message: 'Wall-clock overshoot must be derived from elapsed time and the sealed limit.',
    });
  }
  const totals = new Map<string, {
    invocations: number;
    activeDurationMs: number;
    costs: Map<string, number>;
    unreported: number;
  }>();
  const add = (scopeKind: 'run' | 'stage' | 'coordinate', scopeId: string,
    entry: z.infer<typeof BudgetLedgerEntrySchema>): void => {
    const key = `${scopeKind}:${scopeId}`;
    const current = totals.get(key) ?? {
      invocations: 0,
      activeDurationMs: 0,
      costs: new Map(),
      unreported: 0,
    };
    current.invocations += 1;
    current.activeDurationMs += entry.activeDurationMs;
    if (entry.providerCost === undefined) current.unreported += 1;
    else {
      current.costs.set(
        entry.providerCost.currency,
        (current.costs.get(entry.providerCost.currency) ?? 0) + entry.providerCost.amount,
      );
    }
    totals.set(key, current);
  };
  for (const entry of summary.entries) {
    add('run', summary.runId, entry);
    add('stage', entry.stage, entry);
    add('coordinate', entry.coordinateId, entry);
  }
  if (summary.entries.length === 0) {
    totals.set(`run:${summary.runId}`, {
      invocations: 0,
      activeDurationMs: 0,
      costs: new Map(),
      unreported: 0,
    });
  }
  for (const stage of ['execution', 'evaluation'] as const) {
    const key = `stage:${stage}`;
    if (!totals.has(key)) totals.set(key, {
      invocations: 0,
      activeDurationMs: 0,
      costs: new Map(),
      unreported: 0,
    });
  }
  const suppliedScopes = new Map(summary.scopes.map((scope) => [
    `${scope.scopeKind}:${scope.scopeId}`,
    scope,
  ]));
  const recomputedScopes = [...totals.entries()].map(([key, value]) => {
    const separator = key.indexOf(':');
    const supplied = suppliedScopes.get(key);
    const limits = supplied?.limits ?? {};
    const providerCostAmount = limits.maxProviderCost === undefined
      ? undefined
      : value.costs.get(limits.maxProviderCost.currency) ?? 0;
    return {
      scopeKind: key.slice(0, separator) as 'run' | 'stage' | 'coordinate',
      scopeId: key.slice(separator + 1),
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
  }).sort((left, right) => `${left.scopeKind}:${left.scopeId}`
    .localeCompare(`${right.scopeKind}:${right.scopeId}`));
  if (canonicalizeJson(summary.scopes) !== canonicalizeJson(recomputedScopes)) {
    context.addIssue({
      code: 'custom',
      path: ['scopes'],
      message: 'Budget scope totals must be exactly recomputable from ledger entries.',
    });
  }
  const { ledgerDigest: _ledgerDigest, ...payload } = summary;
  void _ledgerDigest;
  if (summary.ledgerDigest !== digestCanonicalJson(payload)) {
    context.addIssue({
      code: 'custom',
      path: ['ledgerDigest'],
      message: 'Budget ledger digest does not match its canonical payload.',
    });
  }
});

interface BudgetPolicyForSummary {
  run: z.infer<typeof BudgetScopeLimitSnapshotSchema> & { maxWallClockMs?: number };
  stages: {
    execution: z.infer<typeof BudgetScopeLimitSnapshotSchema>;
    evaluation: z.infer<typeof BudgetScopeLimitSnapshotSchema>;
  };
  coordinate: z.infer<typeof BudgetScopeLimitSnapshotSchema>;
  attempt: { maxProviderCost?: z.infer<typeof ProviderCostFactSchema> };
  providerCostAdmission: {
    admissionMode: 'strict-reservation' | 'bounded-overshoot';
  };
}

export function budgetSummaryMatchesPolicy(
  summary: BudgetSummary,
  policy: BudgetPolicyForSummary,
): boolean {
  const { maxWallClockMs, ...runLimits } = policy.run;
  if (summary.admissionMode !== policy.providerCostAdmission.admissionMode
      || summary.wallClock.limitMs !== maxWallClockMs
      || summary.reservations.outstandingInvocations !== 0) return false;
  for (const scope of summary.scopes) {
    const expected = scope.scopeKind === 'run'
      ? runLimits
      : scope.scopeKind === 'stage'
        ? policy.stages[scope.scopeId as 'execution' | 'evaluation']
        : policy.coordinate;
    if (expected === undefined
        || canonicalizeJson(scope.limits) !== canonicalizeJson(expected)) return false;
  }
  if (policy.providerCostAdmission.admissionMode !== 'strict-reservation') return true;
  return summary.entries.every((entry) => {
    const costLimit = policy.run.maxProviderCost
      ?? policy.stages[entry.stage].maxProviderCost
      ?? policy.coordinate.maxProviderCost
      ?? policy.attempt.maxProviderCost;
    if (costLimit === undefined) return true;
    return entry.providerCostReservation?.currency === costLimit.currency;
  });
}

export type BudgetTermination = z.infer<typeof BudgetTerminationSchema>;
export type BudgetLedgerEntry = z.infer<typeof BudgetLedgerEntrySchema>;
export type BudgetUsageTotals = z.infer<typeof BudgetUsageTotalsSchema>;
export type BudgetScopeSummary = z.infer<typeof BudgetScopeSummarySchema>;
export type BudgetScopeLimitSnapshot = z.infer<typeof BudgetScopeLimitSnapshotSchema>;
export type BudgetReservationSummary = z.infer<typeof BudgetReservationSummarySchema>;
export type BudgetWallClockSummary = z.infer<typeof BudgetWallClockSummarySchema>;
export type BudgetSummary = z.infer<typeof BudgetSummarySchema>;
