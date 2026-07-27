import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  isAnalysisResult,
  isSampleSnapshotRecord,
  isVarianceData,
} from '../../src/eval-core/report-extensions.js';
import { buildVarianceData } from '../../src/eval-workflows/run-evaluation.js';
import type { Report, VariantSummary } from '../../src/types/index.js';

function varianceRun(id: string, control: number, treatment: number): Report {
  return {
    kind: 'evaluation',
    id,
    meta: {
      variants: ['control', 'treatment'],
      model: 'test',
      executor: 'script',
      sampleCount: 0,
      taskCount: 0,
      totalCostUSD: 0,
      timestamp: '2026-07-27T00:00:00Z',
      cliVersion: 'test',
      nodeVersion: process.version,
      artifactHashes: { control: 'a', treatment: 'b' },
      judgeModels: [{ executor: 'script', model: 'judge' }],
    },
    summary: {
      control: { avgCompositeScore: control } as VariantSummary,
      treatment: { avgCompositeScore: treatment } as VariantSummary,
    },
    results: [],
  };
}

describe('report extension persistence protocol', () => {
  it('validates sample snapshots against the result identity set', () => {
    const snapshots = {
      s1: {
        sample_id: 's1',
        prompt: 'test',
        assertions: [{ type: 'contains', value: 'ok' }],
        mocks: [{
          tool: 'Read',
          match: { file_path_endswith: 'README.md' },
          return: '# readme',
        }],
        capability: ['retrieval'],
        difficulty: 'medium',
        provenance: 'human',
        covers: [{ targetKind: 'reference', ref: 'references/a.md' }],
      },
    };
    assert.equal(isSampleSnapshotRecord(snapshots, ['s1']), true);
    assert.equal(isSampleSnapshotRecord(snapshots, ['s2']), false);

    const malformed = structuredClone(snapshots);
    (malformed.s1.assertions[0] as Record<string, unknown>).value = Number.NaN;
    assert.equal(isSampleSnapshotRecord(malformed, ['s1']), false);
  });

  it('validates analysis rates, count distributions and variant identities', () => {
    const analysis = {
      insights: [{ type: 'coverage_gap', severity: 'warning', details: { path: 'a.md' } }],
      gapReports: {
        treatment: {
          variant: 'treatment',
          sampleCount: 2,
          samplesWithGap: 1,
          gapRate: 0.5,
          weightedGapRate: 0.5,
          signals: [{
            sampleId: 's1',
            type: 'failed_search',
            context: 'not found',
            weight: 1,
          }],
          byType: {
            failed_search: 1,
            explicit_marker: 0,
            hedging: 0,
            repeated_failure: 0,
          },
        },
      },
      sampleQuality: {
        capabilityCoverage: { retrieval: 1 },
        difficultyDistribution: { easy: 0, medium: 1, hard: 0, unspecified: 1 },
        constructDistribution: { necessity: 1, unspecified: 1 },
        provenanceBreakdown: { human: 1, unspecified: 1 },
        avgRubricLength: 12,
        sampleCountWithCapability: 1,
        sampleCountWithDifficulty: 1,
        sampleCountWithConstruct: 1,
        sampleCountWithProvenance: 1,
        representativeness: {
          capabilityCount: 1,
          capabilityConcentration: 1,
          dominantCapability: 'retrieval',
          difficultyConcentration: 1,
          dominantDifficulty: 'medium',
          constructConcentration: 1,
          dominantConstruct: 'necessity',
        },
      },
      holdout: {
        ratio: 0.5,
        perVariant: {
          control: {
            trainScore: 3,
            holdoutScore: 3,
            trainCount: 1,
            holdoutCount: 1,
            trainScorable: 1,
            holdoutScorable: 1,
          },
          treatment: {
            trainScore: 4,
            holdoutScore: 4,
            trainCount: 1,
            holdoutCount: 1,
            trainScorable: 1,
            holdoutScorable: 1,
          },
        },
      },
    };
    const results = [
      {
        sample_id: 's1',
        variants: { control: { ok: true }, treatment: { ok: true } },
      },
      {
        sample_id: 's2',
        variants: { control: { ok: true }, treatment: { ok: true } },
      },
    ] as unknown as Report['results'];
    assert.equal(isAnalysisResult(analysis, ['control', 'treatment'], results), true);

    const malformed = structuredClone(analysis);
    malformed.gapReports.treatment.byType.failed_search = 2;
    assert.equal(isAnalysisResult(malformed, ['control', 'treatment'], results), false);

    const forgedQuality = structuredClone(analysis);
    forgedQuality.sampleQuality.representativeness.capabilityConcentration = 0.5;
    assert.equal(isAnalysisResult(forgedQuality, ['control', 'treatment'], results), false);
  });

  it('accepts rounded coverage aggregates and rejects inconsistent derived fields', () => {
    const coverage = {
      entries: [
        { path: 'a.md', type: 'principle', accessed: true, accessCount: 1 },
        { path: 'b.md', type: 'reference', accessed: false, accessCount: 0 },
        { path: 'c.md', type: 'other', accessed: false, accessCount: 0 },
      ],
      filesCovered: 1,
      filesTotal: 3,
      fileCoverageRate: 0.33,
      uncoveredFiles: ['b.md', 'c.md'],
      grepPatternsUsed: 0,
      overallRate: 0.2,
    };
    const results = [
      { sample_id: 's1', variants: { control: { ok: true } } },
    ] as unknown as Report['results'];

    // `reference` is not a persisted CoverageEntry type.
    assert.equal(
      isAnalysisResult(
        { insights: [], coverage: { control: coverage } },
        ['control'],
        results,
      ),
      false,
    );

    coverage.entries[1].type = 'other';
    assert.equal(
      isAnalysisResult(
        { insights: [], coverage: { control: coverage } },
        ['control'],
        results,
      ),
      true,
    );

    const malformed = structuredClone(coverage);
    malformed.filesCovered = 2;
    assert.equal(
      isAnalysisResult(
        { insights: [], coverage: { control: malformed } },
        ['control'],
        results,
      ),
      false,
    );
  });

  it('accepts generated variance and rejects forged derived statistics', () => {
    const variance = buildVarianceData([
      varianceRun('r1', 3, 4),
      varianceRun('r2', 3.5, 4.5),
      varianceRun('r3', 4, 5),
    ]);
    assert.ok(variance);
    assert.equal(isVarianceData(variance, ['control', 'treatment']), true);

    const malformed = structuredClone(variance);
    malformed.perVariant.control.mean = 5;
    assert.equal(isVarianceData(malformed, ['control', 'treatment']), false);
  });

  it('keeps prototype-shaped variant identities in variance output', () => {
    const variant = '__proto__';
    const runs = [3, 4].map((score, index) => {
      const report = varianceRun(`prototype-${index}`, score, score);
      report.meta.variants = [variant];
      report.summary = Object.fromEntries([
        [variant, { avgCompositeScore: score } as VariantSummary],
      ]);
      return report;
    });

    const variance = buildVarianceData(runs);
    assert.ok(variance);
    assert.equal(Object.hasOwn(variance.perVariant, variant), true);
    assert.deepEqual(variance.perVariant[variant].scores, [3, 4]);
    assert.equal(isVarianceData(variance, [variant]), true);
  });
});
