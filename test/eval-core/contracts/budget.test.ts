import { describe, expect, it } from 'vitest';
import {
  accumulateBudgetScopeTotals,
  buildBudgetScopeSummary,
  compareBudgetScopeSummaries,
  recomputeBudgetScopeSummaries,
  type BudgetLedgerEntry,
} from '../../../src/eval-core/contracts/index.js';

const coordinateA = `sha256:${'a'.repeat(64)}`;
const coordinateB = `sha256:${'b'.repeat(64)}`;
const attemptA = `sha256:${'1'.repeat(64)}`;
const attemptB = `sha256:${'2'.repeat(64)}`;

const entry = (overrides: Partial<BudgetLedgerEntry>): BudgetLedgerEntry => ({
  sequence: 0,
  stage: 'execution',
  coordinateId: coordinateA,
  attemptId: attemptA,
  invocationCount: 1,
  activeDurationMs: 100,
  providerCostStatus: 'reported',
  providerCost: { amount: 0.5, currency: 'USD', reportedByProvider: true },
  admissionKind: 'bounded-overshoot',
  outcomeKind: 'completed',
  ...overrides,
});

describe('budget scope derivation', () => {
  it('recomputes canonical scope rows from ledger entries', () => {
    const entries = [
      entry({}),
      entry({ sequence: 1, stage: 'evaluation', coordinateId: coordinateB, attemptId: attemptB,
        activeDurationMs: 40, providerCostStatus: 'unreported', providerCost: undefined }),
    ];
    const scopes = recomputeBudgetScopeSummaries(entries, 'run-1', (scopeKind, scopeId) => (
      scopeKind === 'run' && scopeId === 'run-1' ? { maxInvocations: 3 } : {}
    ));
    expect(scopes.map((scope) => `${scope.scopeKind}:${scope.scopeId}`)).toEqual([
      `coordinate:${coordinateA}`,
      `coordinate:${coordinateB}`,
      'run:run-1',
      'stage:evaluation',
      'stage:execution',
    ]);
    const run = scopes.find((scope) => scope.scopeKind === 'run')!;
    expect(run).toEqual({
      scopeKind: 'run',
      scopeId: 'run-1',
      limits: { maxInvocations: 3 },
      totals: {
        invocations: 2,
        activeDurationMs: 140,
        reportedProviderCosts: [{ amount: 0.5, currency: 'USD' }],
        unreportedProviderCostInvocations: 1,
      },
      overshoot: { invocations: 0, activeDurationMs: 0 },
    });
    const evaluation = scopes.find((scope) => scope.scopeId === 'evaluation')!;
    expect(evaluation.totals.reportedProviderCosts).toBeUndefined();
    expect(evaluation.totals.unreportedProviderCostInvocations).toBe(1);
    const coordinate = scopes.find((scope) => scope.scopeId === coordinateA)!;
    expect(coordinate.limits).toEqual({});
  });

  it('keeps empty ledgers sealed with run and both stage scopes', () => {
    const scopes = recomputeBudgetScopeSummaries([], 'run-1', () => ({}));
    expect(scopes.map((scope) => scope.scopeKind)).toEqual(['run', 'stage', 'stage']);
    expect(scopes.every((scope) => scope.totals.invocations === 0)).toBe(true);
  });

  it('accumulates mixed currencies per scope', () => {
    const totals = accumulateBudgetScopeTotals([
      entry({ providerCost: { amount: 0.5, currency: 'USD', reportedByProvider: true } }),
      entry({ sequence: 1, attemptId: attemptB,
        providerCost: { amount: 200, currency: 'CNY', reportedByProvider: true } }),
    ], 'run-1');
    const run = totals.get('run:run-1')!;
    expect([...run.providerCosts.entries()]).toEqual([['USD', 0.5], ['CNY', 200]]);
  });

  it('orders currencies in host-independent UTF-16 order', () => {
    const row = buildBudgetScopeSummary('run', 'run-1', {}, {
      invocations: 2,
      activeDurationMs: 10,
      providerCosts: new Map([['USD', 1], ['CNY', 2]]),
      unreportedProviderCostInvocations: 0,
    });
    expect(row.totals.reportedProviderCosts).toEqual([
      { amount: 2, currency: 'CNY' },
      { amount: 1, currency: 'USD' },
    ]);
  });

  it('orders scopes by UTF-16 code units, not host locale collation', () => {
    const scope = (scopeId: string) => buildBudgetScopeSummary('run', scopeId, {}, {
      invocations: 0,
      activeDurationMs: 0,
      providerCosts: new Map(),
      unreportedProviderCostInvocations: 0,
    });
    // 'Z' (U+005A) precedes 'a' (U+0061) in UTF-16 order; ICU locale collation would flip it.
    expect(compareBudgetScopeSummaries(scope('Zulu'), scope('apple'))).toBeLessThan(0);
    expect(['apple', 'Zulu'].map(scope).sort(compareBudgetScopeSummaries)
      .map((value) => value.scopeId)).toEqual(['Zulu', 'apple']);
  });
});
