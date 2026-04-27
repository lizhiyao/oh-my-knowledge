import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { analyzeResults } from '../../src/analysis/report-diagnostics.js';
import type { Report } from '../../src/types/index.js';

function toReport(value: unknown): Report {
  return value as Report;
}

describe('analyzeResults', () => {
  it('returns empty insights for empty results', () => {
    const report = { meta: { variants: ['v1', 'v2'] }, results: [] };
    const analysis = analyzeResults(toReport(report));
    assert.equal(analysis.insights.length, 0);
    assert.equal(analysis.suggestions.length, 0);
  });

  it('detects low-discrimination assertions', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        {
          sample_id: 's001',
          variants: {
            v1: { assertions: { total: 1, passed: 1, score: 5, details: [{ type: 'contains', value: 'SQL', passed: true, weight: 1 }] } },
            v2: { assertions: { total: 1, passed: 1, score: 5, details: [{ type: 'contains', value: 'SQL', passed: true, weight: 1 }] } },
          },
        },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const lowDisc = analysis.insights.find((i) => i.type === 'low_discrimination_all_passed');
    assert.ok(lowDisc);
    assert.equal(lowDisc!.severity, 'info');
  });

  it('detects uniform scores', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        {
          sample_id: 's001',
          variants: {
            v1: { compositeScore: 4.0 },
            v2: { compositeScore: 4.2 },
          },
        },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const uniform = analysis.insights.find((i) => i.type === 'uniform_scores');
    assert.ok(uniform);
  });

  it('does not flag non-uniform scores', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        {
          sample_id: 's001',
          variants: {
            v1: { compositeScore: 2.0 },
            v2: { compositeScore: 4.5 },
          },
        },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const uniform = analysis.insights.find((i) => i.type === 'uniform_scores');
    assert.equal(uniform, undefined);
  });

  it('detects all-pass assertions', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        {
          sample_id: 's001',
          variants: {
            v1: { assertions: { total: 2, passed: 2, score: 5, details: [] } },
            v2: { assertions: { total: 2, passed: 2, score: 5, details: [] } },
          },
        },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const allPass = analysis.insights.find((i) => i.type === 'all_pass');
    assert.ok(allPass);
    assert.equal(allPass!.severity, 'warning');
  });

  it('detects all-fail assertions', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        {
          sample_id: 's001',
          variants: {
            v1: { assertions: { total: 2, passed: 0, score: 1, details: [] } },
            v2: { assertions: { total: 2, passed: 0, score: 1, details: [] } },
          },
        },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const allFail = analysis.insights.find((i) => i.type === 'all_fail');
    assert.ok(allFail);
    assert.equal(allFail!.severity, 'error');
  });

  it('detects high-cost samples', () => {
    const report = {
      meta: { variants: ['v1'] },
      results: [], // Need 2+ variants for analysis
    };
    // With < 2 variants, should return empty
    const analysis = analyzeResults(toReport(report));
    assert.equal(analysis.insights.length, 0);
  });

  it('detects high-cost samples with 2+ variants', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        { sample_id: 's001', variants: { v1: { costUSD: 0.001 }, v2: { costUSD: 0.001 } } },
        { sample_id: 's002', variants: { v1: { costUSD: 0.001 }, v2: { costUSD: 0.001 } } },
        { sample_id: 's003', variants: { v1: { costUSD: 0.05 }, v2: { costUSD: 0.05 } } },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const highCost = analysis.insights.find((i) => i.type === 'high_cost_sample');
    assert.ok(highCost);
    assert.ok((highCost!.details as Array<{ sample_id: string }>).some((d) => d.sample_id === 's003'));
  });
});
