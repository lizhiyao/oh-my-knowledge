import { describe, expect, it } from 'vitest';
import {
  bootstrapWithMetric,
  drawBootstrapMetric,
  summarizeBootstrapMetric,
} from '../../../src/eval-workflows/analysis/bootstrap.js';
import {
  computeAgreementWithCI,
  computeKrippendorffAlpha,
} from '../../../src/eval-workflows/gold/human.js';
import {
  digestCanonicalJson,
  schemaIdentityKey,
} from '../../../src/eval-core/contracts/index.js';
import {
  AGREEMENT_TABLE_SCHEMA,
  AGREEMENT_TABLE_V1_SCHEMA,
  buildAgreementTable,
  buildAgreementTableV1,
  createAgreementTableSchemaValidators,
  parseAgreementTableEnvelope,
  type AgreementPair,
} from '../../../src/eval-workflows/measurement/analysis/agreement-table.js';
import {
  type AgreementParameters,
} from '../../../src/eval-workflows/measurement/analysis/agreement-parameters.js';

function parameters(
  sampleIds: string[],
  overrides: Partial<AgreementParameters> = {},
): AgreementParameters {
  return {
    source: {
      analysisResultId: 'dimension-table',
      sourceKind: 'dimension',
      selector: 'aggregate',
      targetId: 'treatment',
    },
    gold: {
      contextPointer: '/goldScore',
      annotatorId: 'human-a',
      annotationVersion: 'v1',
      scale: { min: 1, max: 5 },
    },
    sampleIds,
    resamples: 1_000,
    alpha: 0.05,
    seed: 7,
    ...overrides,
  };
}

function comparable(sampleId: string, gold: number, judge: number): AgreementPair {
  return {
    sampleId,
    gold: { ratingStatus: 'observed', score: gold },
    judge: {
      ratingStatus: 'observed',
      score: judge,
      sourceGroupIds: [digestCanonicalJson({ sampleId, source: 'dimension' })],
      coverage: { plannedGroups: 1, observedGroups: 1, missingGroups: 0 },
    },
  };
}

function comparablePairs(values: Array<[number, number]>): AgreementPair[] {
  return values.map(([gold, judge], index) => comparable(`sample-${index}`, gold, judge));
}

describe('Agreement Analysis table', () => {
  it('matches the frozen finite alpha, kappa, Pearson, and bootstrap vector', () => {
    const values: Array<[number, number]> = [
      [1, 2], [2, 2], [3, 3], [4, 4], [5, 4],
      [1, 1], [2, 3], [3, 3], [4, 5], [5, 5],
    ];
    const pairs = comparablePairs(values).reverse();
    const sealed = parameters(values.map((_, index) => `sample-${index}`));
    const value = buildAgreementTable(sealed, pairs);

    expect(AGREEMENT_TABLE_SCHEMA).toEqual({
      schemaVersion: 'omk.agreement-table/v2',
      schemaUri: 'urn:omk:analysis-result:agreement-table:v2',
      schemaDigest: 'sha256:ab4c54b0ad48ff57b609bc7b86de155e79d027c20da2f4bd43afa010149e7cef',
    });

    expect(value.pairs.map((pair) => pair.sampleId)).toEqual(sealed.sampleIds);
    expect(value.coverage).toEqual({
      plannedPairs: 10,
      comparablePairs: 10,
      goldObservedPairs: 10,
      goldUnavailablePairs: 0,
      judgeObservedPairs: 10,
      judgeMissingPairs: 0,
      judgeUnavailablePairs: 0,
    });
    expect(value.statistics).toEqual({
      krippendorffAlpha: { statisticStatus: 'observed', value: 0.8939 },
      alphaInterval: {
        intervalStatus: 'observed',
        lower: 0.8142,
        upper: 0.9735,
        estimate: 0.8939,
        samples: 1_000,
        confidenceLevel: 0.95,
        drawCoverage: { plannedDraws: 1_000, observedDraws: 1_000, missingDraws: 0 },
      },
      weightedKappa: { statisticStatus: 'observed', value: 0.8889 },
      pearson: { statisticStatus: 'observed', value: 0.9058 },
    });

    const legacy = computeAgreementWithCI(values.map(([coderA, coderB], index) => ({
      unitId: `sample-${index}`, coderA, coderB,
    })), { samples: 1_000, seed: 7, alpha: 0.05 });
    expect(value.statistics).toMatchObject({
      krippendorffAlpha: { value: legacy.alpha },
      weightedKappa: { value: legacy.weightedKappa },
      pearson: { value: legacy.pearson },
    });
    expect(value.statistics.alphaInterval).not.toMatchObject({
      lower: legacy.alphaCI.low,
      upper: legacy.alphaCI.high,
    });
  });

  it('reports the interval as not applicable for perfect agreement', () => {
    const pairs = comparablePairs([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    const sealed = parameters(pairs.map((pair) => pair.sampleId), {
      resamples: 100,
      seed: 42,
    });
    const value = buildAgreementTable(sealed, pairs);
    expect(value.statistics).toEqual({
      krippendorffAlpha: { statisticStatus: 'observed', value: 1 },
      alphaInterval: {
        intervalStatus: 'missing',
        reasonCode: 'agreement-bootstrap-not-applicable-perfect',
        confidenceLevel: 0.95,
        drawCoverage: { plannedDraws: 100, observedDraws: 0, missingDraws: 100 },
      },
      weightedKappa: { statisticStatus: 'observed', value: 1 },
      pearson: { statisticStatus: 'observed', value: 1 },
    });
    expect(JSON.stringify(value)).not.toContain('NaN');
  });

  it('keeps the v1 conditional-finite-draw contract available for exact replay', () => {
    const pairs = comparablePairs([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    const sealed = parameters(pairs.map((pair) => pair.sampleId), {
      resamples: 100,
      seed: 42,
    });
    const value = buildAgreementTableV1(sealed, pairs);
    expect(AGREEMENT_TABLE_V1_SCHEMA).toEqual({
      schemaVersion: 'omk.agreement-table/v1',
      schemaUri: 'urn:omk:analysis-result:agreement-table:v1',
      schemaDigest: 'sha256:ba2a45e25c820d71d04538ce971e20c9491e4ba792623508c77d7c195b69a972',
    });
    expect(value.statistics.alphaInterval).toEqual({
      intervalStatus: 'observed',
      lower: 1,
      upper: 1,
      estimate: 1,
      samples: 99,
      confidenceLevel: 0.95,
      drawCoverage: { plannedDraws: 100, observedDraws: 99, missingDraws: 1 },
    });
    const validator = createAgreementTableSchemaValidators().get(
      schemaIdentityKey(AGREEMENT_TABLE_V1_SCHEMA),
    );
    expect(validator?.parse({ resultType: 'table', value }, {
      validationKind: 'analysis-output',
      parameters: sealed,
      inputFacts: { resamplingUnitCount: 5 },
    })).toEqual({ resultType: 'table', value });
  });

  it('maps insufficient, zero-disagreement, and unavailable evidence to structured missing', () => {
    const singleton = buildAgreementTable(parameters(['sample-0'], { resamples: 100 }), [
      comparable('sample-0', 1, 2),
    ]);
    expect(singleton.statistics).toEqual({
      krippendorffAlpha: {
        statisticStatus: 'missing', reasonCode: 'agreement-insufficient-pairs',
      },
      alphaInterval: {
        intervalStatus: 'missing',
        reasonCode: 'agreement-point-unobserved',
        confidenceLevel: 0.95,
        drawCoverage: { plannedDraws: 100, observedDraws: 0, missingDraws: 100 },
      },
      weightedKappa: {
        statisticStatus: 'missing', reasonCode: 'agreement-insufficient-pairs',
      },
      pearson: {
        statisticStatus: 'missing', reasonCode: 'agreement-insufficient-pairs',
      },
    });

    const constant = buildAgreementTable(parameters(['sample-0', 'sample-1'], {
      resamples: 100,
    }), [
      comparable('sample-0', 3, 3),
      comparable('sample-1', 3, 3),
    ]);
    expect(constant.statistics.krippendorffAlpha).toEqual({
      statisticStatus: 'missing', reasonCode: 'agreement-zero-expected-disagreement',
    });
    expect(constant.statistics.alphaInterval).toMatchObject({
      intervalStatus: 'missing', reasonCode: 'agreement-point-unobserved',
    });

    const unavailablePairs: AgreementPair[] = [{
      sampleId: 'sample-0',
      gold: { ratingStatus: 'unavailable', reasonCode: 'gold-rating-unavailable' },
      judge: {
        ratingStatus: 'missing',
        reasonCode: 'dimension-unobserved',
        sourceGroupIds: [
          digestCanonicalJson('missing-dimension-0'),
          digestCanonicalJson('missing-dimension-1'),
        ],
        coverage: { plannedGroups: 2, observedGroups: 0, missingGroups: 2 },
      },
    }, {
      sampleId: 'sample-1',
      gold: { ratingStatus: 'observed', score: 4 },
      judge: {
        ratingStatus: 'unavailable',
        reasonCode: 'dimension-group-unavailable',
        sourceGroupIds: [],
        coverage: { plannedGroups: 0, observedGroups: 0, missingGroups: 0 },
      },
    }];
    const unavailable = buildAgreementTable(
      parameters(['sample-0', 'sample-1'], { resamples: 100 }),
      unavailablePairs,
    );
    expect(unavailable.coverage).toEqual({
      plannedPairs: 2,
      comparablePairs: 0,
      goldObservedPairs: 1,
      goldUnavailablePairs: 1,
      judgeObservedPairs: 0,
      judgeMissingPairs: 1,
      judgeUnavailablePairs: 1,
    });
    expect(JSON.stringify(unavailable)).not.toContain('NaN');
  });

  it('preserves the existing generic bootstrap API byte-for-byte after draw extraction', () => {
    const scores = [0, 1, 2, 3, 4];
    const metric = (values: number[]) => computeKrippendorffAlpha(values.map((value, index) => ({
      unitId: String(index), coderA: value, coderB: 4 - value,
    })));
    const legacy = bootstrapWithMetric(scores, metric, 0.1, 128, 9);
    const distribution = drawBootstrapMetric(scores, metric, 128, 9);
    expect(summarizeBootstrapMetric(
      distribution.estimate,
      distribution.draws,
      0.1,
      128,
    )).toEqual(legacy);
  });

  it('recomputes transported results and binds them to sealed configuration', () => {
    const pairs = comparablePairs([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    const sealed = parameters(pairs.map((pair) => pair.sampleId), {
      resamples: 100,
      seed: 42,
    });
    const value = buildAgreementTable(sealed, pairs);
    const envelope = { resultType: 'table' as const, value };
    expect(parseAgreementTableEnvelope(envelope)).toEqual(envelope);
    const validator = createAgreementTableSchemaValidators().get(
      schemaIdentityKey(AGREEMENT_TABLE_SCHEMA),
    );
    const context = {
      validationKind: 'analysis-output' as const,
      parameters: sealed,
      inputFacts: { resamplingUnitCount: 5 },
    };
    expect(validator?.parse(envelope, context)).toEqual(envelope);

    const altered = structuredClone(envelope);
    if (altered.value.statistics.alphaInterval.intervalStatus === 'observed') {
      altered.value.statistics.alphaInterval.lower = 0.5;
    } else {
      altered.value.statistics.alphaInterval.drawCoverage.observedDraws -= 1;
    }
    expect(() => validator?.parse(altered, context)).toThrow(/recomputable/);
    expect(() => validator?.parse(envelope, {
      ...context,
      parameters: { ...sealed, seed: 99 },
    })).toThrow(/sealed node parameters/);
  });

  it('rejects duplicate samples, source lineage, scale drift, and invalid judge coverage', () => {
    const pairs = comparablePairs([[1, 1], [2, 2]]);
    expect(() => buildAgreementTable(parameters(['sample-0', 'sample-0']), pairs)).toThrow();
    expect(() => buildAgreementTable(parameters(['sample-0', 'sample-1']), [
      pairs[0], { ...pairs[1], judge: { ...pairs[0].judge } },
    ])).toThrow(/globally unique/);
    expect(() => buildAgreementTable(parameters(['sample-0', 'sample-1']), [
      pairs[0], comparable('sample-1', 2, 6),
    ])).toThrow(/sealed scale/);
    expect(() => buildAgreementTable(parameters(['sample-0', 'sample-1']), [
      pairs[0], {
        ...pairs[1],
        judge: {
          ratingStatus: 'observed',
          score: 2,
          sourceGroupIds: [digestCanonicalJson('invalid-coverage')],
          coverage: { plannedGroups: 2, observedGroups: 1, missingGroups: 0 },
        },
      },
    ])).toThrow(/coverage/);
  });
});
