import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { diagnoseSamples, formatSampleDiagnostics } from '../../src/analysis/sample-diagnostics.js';
import type { Report, ResultEntry, Sample, VariantResult } from '../../src/types.js';

const variantResult = (overrides: Partial<VariantResult> = {}): VariantResult => ({
  ok: true, durationMs: 1000, durationApiMs: 1000,
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  cacheReadTokens: 0, cacheCreationTokens: 0,
  execCostUSD: 0, judgeCostUSD: 0, costUSD: 0.001, numTurns: 1,
  outputPreview: null,
  ...overrides,
});

const buildReport = (entries: Array<{ id: string; perVariant: Record<string, Partial<VariantResult>> }>, variants: string[]): Report => ({
  id: 'r',
  meta: {
    variants, model: 'm', judgeModel: 'j', executor: 'claude',
    sampleCount: entries.length, taskCount: entries.length, totalCostUSD: 0,
    timestamp: '2026-04-25T00:00:00Z', cliVersion: 'test', nodeVersion: 'test',
    artifactHashes: Object.fromEntries(variants.map((v) => [v, 'h'])),
  },
  summary: {},
  results: entries.map((e) => ({
    sample_id: e.id,
    variants: Object.fromEntries(Object.entries(e.perVariant).map(([v, ovr]) => [v, variantResult(ovr)])),
  } as ResultEntry)),
});

describe('diagnoseSamples — flat / all-pass / all-fail', () => {
  it('flags all_pass when all variants score 5', () => {
    const r = buildReport([
      { id: 's1', perVariant: { v1: { compositeScore: 5 }, v2: { compositeScore: 5 } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    assert.ok(d.byKind.all_pass?.includes('s1'));
  });

  it('flags all_fail (severity error) when all variants score 1', () => {
    const r = buildReport([
      { id: 's1', perVariant: { v1: { compositeScore: 1 }, v2: { compositeScore: 1 } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    assert.ok(d.byKind.all_fail?.includes('s1'));
    assert.ok(d.issues.some((i) => i.kind === 'all_fail' && i.severity === 'error'));
  });

  it('flags flat_scores when spread < threshold', () => {
    const r = buildReport([
      { id: 'flat', perVariant: { v1: { compositeScore: 3.0 }, v2: { compositeScore: 3.2 } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    assert.ok(d.byKind.flat_scores?.includes('flat'));
  });

  it('does NOT flag flat when spread >= threshold', () => {
    const r = buildReport([
      { id: 'discriminator', perVariant: { v1: { compositeScore: 3.0 }, v2: { compositeScore: 4.5 } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    assert.equal(d.byKind.flat_scores, undefined);
  });
});

describe('diagnoseSamples — error_prone', () => {
  it('flags samples that errored on any variant', () => {
    const r = buildReport([
      { id: 'broken', perVariant: { v1: { ok: false, compositeScore: 0 }, v2: { compositeScore: 4 } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    assert.ok(d.byKind.error_prone?.includes('broken'));
  });

  it('uses error severity when all variants errored', () => {
    const r = buildReport([
      { id: 'all-broken', perVariant: { v1: { ok: false }, v2: { ok: false } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    const issue = d.issues.find((i) => i.kind === 'error_prone');
    assert.equal(issue?.severity, 'error');
  });
});

describe('diagnoseSamples — ambiguous_rubric (judge stddev)', () => {
  it('flags when llmScoreStddev exceeds threshold', () => {
    const r = buildReport([
      { id: 'ambig', perVariant: { v1: { compositeScore: 3, llmScoreStddev: 1.5 }, v2: { compositeScore: 4, llmScoreStddev: 0.2 } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r, { ambiguousStddev: 1 });
    assert.ok(d.byKind.ambiguous_rubric?.includes('ambig'));
  });

  it('does not flag when stddev is small', () => {
    const r = buildReport([
      { id: 'stable', perVariant: { v1: { compositeScore: 3, llmScoreStddev: 0.2 }, v2: { compositeScore: 4, llmScoreStddev: 0.3 } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    assert.equal(d.byKind.ambiguous_rubric, undefined);
  });
});

describe('diagnoseSamples — cost / latency outliers', () => {
  it('flags samples ≥ k× median cost', () => {
    const r = buildReport([
      { id: 'cheap1', perVariant: { v1: { costUSD: 0.001, compositeScore: 4 } } },
      { id: 'cheap2', perVariant: { v1: { costUSD: 0.001, compositeScore: 4 } } },
      { id: 'cheap3', perVariant: { v1: { costUSD: 0.002, compositeScore: 4 } } },
      { id: 'spike',  perVariant: { v1: { costUSD: 0.05,  compositeScore: 4 } } },
    ], ['v1']);
    const d = diagnoseSamples(r, { costOutlierK: 3 });
    assert.ok(d.byKind.cost_outlier?.includes('spike'));
    assert.equal(d.byKind.cost_outlier?.includes('cheap1'), false);
  });

  it('flags samples ≥ k× median latency', () => {
    const r = buildReport([
      { id: 'fast1', perVariant: { v1: { compositeScore: 4, durationMs: 1000 } } },
      { id: 'fast2', perVariant: { v1: { compositeScore: 4, durationMs: 1000 } } },
      { id: 'slow', perVariant: { v1: { compositeScore: 4, durationMs: 10000 } } },
    ], ['v1']);
    const d = diagnoseSamples(r, { latencyOutlierK: 3 });
    assert.ok(d.byKind.latency_outlier?.includes('slow'));
  });
});

describe('diagnoseSamples — near_duplicate', () => {
  it('flags pairs with high prompt ROUGE-1 similarity', () => {
    const samples: Sample[] = [
      { sample_id: 'a', prompt: 'cat sat on the mat' },
      { sample_id: 'b', prompt: 'cat sat on a mat' }, // near-duplicate of a
      { sample_id: 'c', prompt: 'completely different topic about dogs' },
    ];
    const r = buildReport([
      { id: 'a', perVariant: { v1: { compositeScore: 4 } } },
      { id: 'b', perVariant: { v1: { compositeScore: 4 } } },
      { id: 'c', perVariant: { v1: { compositeScore: 4 } } },
    ], ['v1']);
    const d = diagnoseSamples(r, { samples, duplicateRouge: 0.6 });
    assert.ok(d.byKind.near_duplicate, 'expected near_duplicate kind');
    assert.equal(d.byKind.near_duplicate![0], 'a');
    const issue = d.issues.find((i) => i.kind === 'near_duplicate');
    assert.equal(issue?.evidence.duplicateOf, 'b');
  });

  it('skips duplicate detection when no samples passed', () => {
    const r = buildReport([
      { id: 'a', perVariant: { v1: { compositeScore: 4 } } },
      { id: 'b', perVariant: { v1: { compositeScore: 4 } } },
    ], ['v1']);
    const d = diagnoseSamples(r); // no samples option
    assert.equal(d.byKind.near_duplicate, undefined);
  });
});

describe('diagnoseSamples — health score', () => {
  it('returns 100 when no issues', () => {
    const r = buildReport([
      { id: 's1', perVariant: { v1: { compositeScore: 3 }, v2: { compositeScore: 4 } } },
      { id: 's2', perVariant: { v1: { compositeScore: 3.5 }, v2: { compositeScore: 4.5 } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    assert.equal(d.healthScore, 100);
  });

  it('drops below 100 when issues exist', () => {
    const r = buildReport([
      { id: 's1', perVariant: { v1: { compositeScore: 5 }, v2: { compositeScore: 5 } } }, // all_pass
      { id: 's2', perVariant: { v1: { compositeScore: 1 }, v2: { compositeScore: 1 } } }, // all_fail (error)
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    assert.ok(d.healthScore < 100, `expected < 100, got ${d.healthScore}`);
  });

  it('returns 100 for empty result list', () => {
    const r = buildReport([], ['v1']);
    const d = diagnoseSamples(r);
    assert.equal(d.healthScore, 100);
    assert.equal(d.totals.samples, 0);
  });
});

describe('diagnoseSamples — totals & sorting', () => {
  it('counts errors / warnings / infos correctly', () => {
    const r = buildReport([
      { id: 'err',   perVariant: { v1: { compositeScore: 1 }, v2: { compositeScore: 1 } } },     // all_fail (error)
      { id: 'warn',  perVariant: { v1: { compositeScore: 3.0 }, v2: { compositeScore: 3.2 } } }, // flat (warning)
      { id: 'info',  perVariant: { v1: { compositeScore: 5 }, v2: { compositeScore: 5 } } },     // all_pass (info)
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    assert.ok(d.totals.errors >= 1);
    assert.ok(d.totals.warnings >= 1);
    assert.ok(d.totals.infos >= 1);
  });

  it('sorts issues by severity (error first)', () => {
    const r = buildReport([
      { id: 'a', perVariant: { v1: { compositeScore: 5 }, v2: { compositeScore: 5 } } },     // info
      { id: 'b', perVariant: { v1: { compositeScore: 1 }, v2: { compositeScore: 1 } } },     // error
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    if (d.issues.length >= 2) {
      assert.equal(d.issues[0].severity, 'error');
    }
  });
});

describe('formatSampleDiagnostics', () => {
  it('includes health score in output', () => {
    const r = buildReport([
      { id: 's1', perVariant: { v1: { compositeScore: 4 }, v2: { compositeScore: 4.5 } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    const text = formatSampleDiagnostics(d);
    assert.match(text, /health score 100/);
  });

  it('reports "no issues" cleanly', () => {
    const r = buildReport([
      { id: 's1', perVariant: { v1: { compositeScore: 4 }, v2: { compositeScore: 4.5 } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    const text = formatSampleDiagnostics(d);
    assert.match(text, /未检测到样本质量问题/);
  });

  it('groups issues by kind in output', () => {
    const r = buildReport([
      { id: 'spam1', perVariant: { v1: { compositeScore: 5 }, v2: { compositeScore: 5 } } },
      { id: 'spam2', perVariant: { v1: { compositeScore: 5 }, v2: { compositeScore: 5 } } },
    ], ['v1', 'v2']);
    const d = diagnoseSamples(r);
    const text = formatSampleDiagnostics(d);
    assert.match(text, /\[all_pass\] 2 sample/);
  });
});
