import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { computeRunTally } from '../../src/cli/run-tally.js';
import type {
  BatchEvaluationReport,
  EvaluationReport,
  VariantSummary,
} from '../../src/types/report.js';

function summary(successCount: number, errorCount: number): VariantSummary {
  return {
    totalSamples: successCount + errorCount,
    successCount,
    errorCount,
    errorRate: errorCount === 0 ? 0 : errorCount / (successCount + errorCount),
    avgDurationMs: 0,
    avgInputTokens: 0,
    avgOutputTokens: 0,
    avgTotalTokens: 0,
    totalCostUSD: 0,
    totalExecCostUSD: 0,
    totalJudgeCostUSD: 0,
    avgCostPerSample: 0,
    avgNumTurns: 0,
  } as VariantSummary;
}

describe('computeRunTally', () => {
  it('aggregates successCount / errorCount across variants in a single-skill report', () => {
    const report = {
      kind: 'evaluation',
      id: 'r1',
      meta: {} as EvaluationReport['meta'],
      summary: {
        baseline: summary(8, 2),
        v1: summary(9, 1),
      },
      results: [],
    } as unknown as EvaluationReport;
    const tally = computeRunTally(report);
    assert.deepEqual(tally, { passed: 17, failed: 3 });
  });

  it('aggregates across all batch items', () => {
    const report = {
      kind: 'batch-evaluation',
      id: 'b1',
      mode: 'skill',
      meta: {} as BatchEvaluationReport['meta'],
      items: [
        {
          name: 'skill-a',
          skillPath: '/p/a',
          samplesPath: '/p/s',
          reportId: 'r1',
          reportPath: null,
          status: 'completed',
          sampleCount: 10,
          totalCostUSD: 0,
          artifactHash: null,
          summary: { 'skill-a': summary(7, 3) },
        },
        {
          name: 'skill-b',
          skillPath: '/p/b',
          samplesPath: '/p/s',
          reportId: 'r2',
          reportPath: null,
          status: 'completed',
          sampleCount: 5,
          totalCostUSD: 0,
          artifactHash: null,
          summary: { 'skill-b': summary(5, 0) },
        },
      ],
    } as unknown as BatchEvaluationReport;
    const tally = computeRunTally(report);
    assert.deepEqual(tally, { passed: 12, failed: 3 });
  });

  it('returns zeros for an empty single report', () => {
    const report = {
      kind: 'evaluation',
      id: 'empty',
      meta: {} as EvaluationReport['meta'],
      summary: {},
      results: [],
    } as unknown as EvaluationReport;
    assert.deepEqual(computeRunTally(report), { passed: 0, failed: 0 });
  });
});
