import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOOTSTRAP_SEED,
  bootstrapDiffCI,
  bootstrapMeanCI,
  bootstrapPairedDiffCI,
} from '../../../../src/eval-workflows/analysis/bootstrap.js';
import {
  digestCanonicalJson,
  schemaIdentityKey,
} from '../../../../src/eval-core/contracts/index.js';
import {
  BOOTSTRAP_FAMILY_TABLE_SCHEMA,
  buildBootstrapFamilyTable,
  createBootstrapFamilyTableSchemaValidators,
  parseBootstrapFamilyTableEnvelope,
  type BootstrapObservation,
} from '../../../../src/eval-workflows/measurement/analysis/bootstrap-family-table.js';
import {
  BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
  BOOTSTRAP_MONTE_CARLO_METHOD_ID,
  buildBootstrapFamilyTableV2,
  bootstrapSignificanceEvidence,
  createBootstrapFamilyTableV2SchemaValidators,
  parseBootstrapFamilyTableV2Envelope,
} from '../../../../src/eval-workflows/measurement/analysis/bootstrap-family-table-v2.js';
import {
  type BootstrapFamilyParameters,
} from '../../../../src/eval-workflows/measurement/analysis/bootstrap-family-parameters.js';

const sampleIds = ['sample-1', 'sample-2', 'sample-3', 'sample-4'];
const controlScores = [1, 2, 3, 4];
const treatmentScores = [2, 4, 4, 5];
const secondTreatmentScores = [1, 3, 5, 5];

function parameters(overrides: Partial<BootstrapFamilyParameters> = {}): BootstrapFamilyParameters {
  return {
    source: {
      analysisResultId: 'composite-table',
      sourceKind: 'composite',
      selector: 'aggregate',
    },
    targetIds: ['control', 'treatment', 'treatment-2', 'empty'],
    sampleIds,
    comparisons: [{
      comparisonId: 'paired-1',
      controlTargetId: 'control',
      treatmentTargetId: 'treatment',
      comparisonDesign: 'paired',
    }, {
      comparisonId: 'paired-2',
      controlTargetId: 'control',
      treatmentTargetId: 'treatment-2',
      comparisonDesign: 'paired',
    }, {
      comparisonId: 'missing',
      controlTargetId: 'control',
      treatmentTargetId: 'empty',
      comparisonDesign: 'paired',
    }],
    resamples: 1_000,
    alpha: 0.05,
    seed: DEFAULT_BOOTSTRAP_SEED,
    ...overrides,
  };
}

function observation(input: Readonly<{
  targetId: string;
  sampleId: string;
  score?: number;
  trialIndex?: number;
  paired?: boolean;
}>): BootstrapObservation {
  const trialIndex = input.trialIndex ?? 0;
  const trialId = digestCanonicalJson({
    targetId: input.targetId,
    sampleId: input.sampleId,
    trialIndex,
  });
  const base = {
    sourceGroupId: digestCanonicalJson({ source: 'composite', trialId }),
    targetId: input.targetId,
    sampleId: input.sampleId,
    trialIndex,
    trialId,
    samplingUnitIds: input.paired === false ? {} : {
      pairingBlockId: digestCanonicalJson({ pair: input.sampleId }),
    },
  };
  return input.score === undefined
    ? { ...base, observationStatus: 'missing', reasonCode: 'composite-unobserved' }
    : { ...base, observationStatus: 'observed', score: input.score };
}

function observations(): BootstrapObservation[] {
  return sampleIds.flatMap((sampleId, index) => [
    observation({ targetId: 'control', sampleId, score: controlScores[index] }),
    observation({ targetId: 'treatment', sampleId, score: treatmentScores[index] }),
    observation({
      targetId: 'treatment-2', sampleId, score: secondTreatmentScores[index],
    }),
    observation({ targetId: 'empty', sampleId }),
  ]).reverse();
}

describe('Bootstrap family Analysis table', () => {
  it('matches frozen mean, paired, independent, and alpha/K vectors', () => {
    const value = buildBootstrapFamilyTable(parameters(), observations());

    expect(value.configuration.comparisons.map((entry) => entry.comparisonId)).toEqual([
      'missing',
      'paired-1',
      'paired-2',
    ]);
    expect(value.observations.map((entry) => [entry.targetId, entry.sampleId])).toEqual([
      ...sampleIds.map((sampleId) => ['control', sampleId]),
      ...sampleIds.map((sampleId) => ['treatment', sampleId]),
      ...sampleIds.map((sampleId) => ['treatment-2', sampleId]),
      ...sampleIds.map((sampleId) => ['empty', sampleId]),
    ]);
    expect(value.targetIntervals).toMatchObject([{
      targetId: 'control',
      intervalStatus: 'observed',
      unitCount: 4,
      interval: {
        lower: 1.5,
        upper: 3.5,
        estimate: 2.5,
        samples: 1_000,
        confidenceLevel: 0.95,
      },
    }, {
      targetId: 'treatment',
      intervalStatus: 'observed',
      unitCount: 4,
      interval: {
        lower: 2.5,
        upper: 4.75,
        estimate: 3.75,
        samples: 1_000,
        confidenceLevel: 0.95,
      },
    }, {
      targetId: 'treatment-2',
      intervalStatus: 'observed',
      unitCount: 4,
      interval: {
        lower: 2,
        upper: 5,
        estimate: 3.5,
        samples: 1_000,
        confidenceLevel: 0.95,
      },
    }, {
      targetId: 'empty',
      intervalStatus: 'missing',
      reasonCode: 'bootstrap-no-observed-units',
      unitCount: 0,
    }]);
    expect(value.family).toEqual({
      plannedComparisons: 3,
      observedComparisons: 2,
      missingComparisons: 1,
      nominalAlpha: 0.05,
      effectiveAlpha: 0.025,
    });
    expect(value.comparisons).toMatchObject([{
      binding: { comparisonId: 'missing' },
      comparisonStatus: 'missing',
      reasonCode: 'bootstrap-no-complete-pairs',
    }, {
      binding: { comparisonId: 'paired-1' },
      comparisonStatus: 'observed',
      effectiveAlpha: 0.025,
      interval: {
        lower: 1,
        upper: 1.75,
        estimate: 1.25,
        samples: 1_000,
        confidenceLevel: 0.975,
        significant: true,
      },
    }, {
      binding: { comparisonId: 'paired-2' },
      comparisonStatus: 'observed',
      effectiveAlpha: 0.025,
      interval: {
        lower: 0.25,
        upper: 1.75,
        estimate: 1,
        samples: 1_000,
        confidenceLevel: 0.975,
        significant: true,
      },
    }]);
  });

  it('uses the existing legacy estimators as the exact algorithm source', () => {
    const value = buildBootstrapFamilyTable(parameters(), observations());
    const control = value.targetIntervals.find((entry) => entry.targetId === 'control');
    const paired = value.comparisons.find((entry) => entry.binding.comparisonId === 'paired-1');
    const independentValue = buildBootstrapFamilyTable(parameters({
      targetIds: ['control', 'treatment'],
      comparisons: [{
        comparisonId: 'independent',
        controlTargetId: 'control',
        treatmentTargetId: 'treatment',
        comparisonDesign: 'independent',
      }],
    }), observations().filter((entry) => (
      entry.targetId === 'control' || entry.targetId === 'treatment'
    )));
    const independent = independentValue.comparisons[0];
    expect(control?.intervalStatus).toBe('observed');
    expect(independent?.comparisonStatus).toBe('observed');
    expect(paired?.comparisonStatus).toBe('observed');
    if (control?.intervalStatus !== 'observed'
        || independent?.comparisonStatus !== 'observed'
        || paired?.comparisonStatus !== 'observed') return;
    expect({
      low: control.interval.lower,
      high: control.interval.upper,
      estimate: control.interval.estimate,
      samples: control.interval.samples,
    }).toEqual(bootstrapMeanCI(
      controlScores,
      0.05,
      1_000,
      DEFAULT_BOOTSTRAP_SEED,
    ));
    expect({
      low: independent.interval.lower,
      high: independent.interval.upper,
      estimate: independent.interval.estimate,
      samples: independent.interval.samples,
      significant: independent.interval.significant,
    }).toEqual(bootstrapDiffCI(
      controlScores,
      treatmentScores,
      0.05,
      1_000,
      DEFAULT_BOOTSTRAP_SEED,
    ));
    expect({
      low: paired.interval.lower,
      high: paired.interval.upper,
      estimate: paired.interval.estimate,
      samples: paired.interval.samples,
      significant: paired.interval.significant,
    }).toEqual(bootstrapPairedDiffCI(
      controlScores.map((a, index) => ({ a, b: treatmentScores[index] })),
      0.025,
      1_000,
      DEFAULT_BOOTSTRAP_SEED,
    ));
  });

  it('preserves degenerate authoritative Core semantics without zero sentinels', () => {
    const sealed = parameters({
      targetIds: ['control', 'treatment'],
      sampleIds: ['sample-1'],
      comparisons: [{
        comparisonId: 'paired',
        controlTargetId: 'control',
        treatmentTargetId: 'treatment',
        comparisonDesign: 'paired',
      }],
      resamples: 100,
    });
    const value = buildBootstrapFamilyTable(sealed, [
      observation({ targetId: 'control', sampleId: 'sample-1', score: 2 }),
      observation({ targetId: 'treatment', sampleId: 'sample-1', score: 3 }),
    ]);
    expect(value.targetIntervals).toMatchObject([{
      intervalStatus: 'observed',
      unitCount: 1,
      interval: { lower: 2, upper: 2, estimate: 2, samples: 0 },
    }, {
      intervalStatus: 'observed',
      unitCount: 1,
      interval: { lower: 3, upper: 3, estimate: 3, samples: 0 },
    }]);
    expect(value.comparisons).toMatchObject([{
      comparisonStatus: 'observed',
      counts: { controlUnits: 1, treatmentUnits: 1, comparableUnits: 1 },
      interval: { lower: 1, upper: 1, estimate: 1, samples: 100, significant: true },
    }]);

    const empty = buildBootstrapFamilyTable(sealed, [
      observation({ targetId: 'control', sampleId: 'sample-1' }),
      observation({ targetId: 'treatment', sampleId: 'sample-1' }),
    ]);
    expect(empty.targetIntervals.every((entry) => entry.intervalStatus === 'missing')).toBe(true);
    expect(empty.comparisons).toMatchObject([{
      comparisonStatus: 'missing',
      reasonCode: 'bootstrap-no-complete-pairs',
    }]);
    expect(empty.family.effectiveAlpha).toBeNull();
  });

  it('averages repeated trials within units and never guesses a missing pair identity', () => {
    const sealed = parameters({
      targetIds: ['control', 'treatment'],
      sampleIds: ['sample-1'],
      comparisons: [{
        comparisonId: 'paired',
        controlTargetId: 'control',
        treatmentTargetId: 'treatment',
        comparisonDesign: 'paired',
      }],
      resamples: 100,
    });
    const repeated = buildBootstrapFamilyTable(sealed, [
      observation({ targetId: 'control', sampleId: 'sample-1', trialIndex: 0, score: 2 }),
      observation({ targetId: 'control', sampleId: 'sample-1', trialIndex: 1, score: 4 }),
      observation({ targetId: 'treatment', sampleId: 'sample-1', trialIndex: 0, score: 4 }),
      observation({ targetId: 'treatment', sampleId: 'sample-1', trialIndex: 1, score: 4 }),
    ]);
    expect(repeated.targetIntervals).toMatchObject([{
      unitCount: 1,
      interval: { estimate: 3 },
    }, {
      unitCount: 1,
      interval: { estimate: 4 },
    }]);
    expect(repeated.comparisons).toMatchObject([{
      comparisonStatus: 'observed',
      counts: { controlUnits: 1, treatmentUnits: 1, comparableUnits: 1 },
      interval: { estimate: 1 },
    }]);

    const unpaired = buildBootstrapFamilyTable(sealed, [
      observation({
        targetId: 'control', sampleId: 'sample-1', score: 2, paired: false,
      }),
      observation({
        targetId: 'treatment', sampleId: 'sample-1', score: 3, paired: false,
      }),
    ]);
    expect(unpaired.targetIntervals.every((entry) => entry.intervalStatus === 'observed')).toBe(true);
    expect(unpaired.comparisons).toMatchObject([{
      comparisonStatus: 'missing',
      counts: { controlUnits: 0, treatmentUnits: 0, comparableUnits: 0 },
      reasonCode: 'bootstrap-no-complete-pairs',
    }]);
  });

  it('recomputes transported output and binds it to sealed parameters', () => {
    const sealed = parameters();
    const value = buildBootstrapFamilyTable(sealed, observations());
    const envelope = { resultType: 'table' as const, value };
    expect(parseBootstrapFamilyTableEnvelope(envelope)).toEqual(envelope);
    const validator = createBootstrapFamilyTableSchemaValidators().get(
      schemaIdentityKey(BOOTSTRAP_FAMILY_TABLE_SCHEMA),
    );
    const context = {
      validationKind: 'analysis-output' as const,
      parameters: sealed,
      inputFacts: { resamplingUnitCount: 4 },
    };
    expect(validator?.parse(envelope, context)).toEqual(envelope);

    const alteredInterval = structuredClone(envelope);
    const first = alteredInterval.value.targetIntervals[0];
    if (first.intervalStatus === 'observed') first.interval.lower += 0.1;
    expect(() => validator?.parse(alteredInterval, context)).toThrow(/recomputable/);

    expect(() => validator?.parse(envelope, {
      ...context,
      parameters: { ...sealed, resamples: 999 },
    })).toThrow(/sealed node parameters/);
  });

  it('rejects ambiguous designs, unknown coordinates, duplicate lineage, and seed drift', () => {
    expect(() => buildBootstrapFamilyTable({
      ...parameters(),
      targetIds: ['control', 'control'],
    }, observations())).toThrow(/unique/);
    expect(() => buildBootstrapFamilyTable({
      ...parameters(),
      comparisons: [{
        comparisonId: 'same',
        controlTargetId: 'control',
        treatmentTargetId: 'control',
        comparisonDesign: 'paired',
      }],
    }, observations())).toThrow(/distinct/);
    expect(() => buildBootstrapFamilyTable({
      ...parameters(),
      seed: 42,
    }, observations())).toThrow();
    expect(() => buildBootstrapFamilyTable({
      ...parameters(),
      comparisons: [{
        comparisonId: 'paired',
        controlTargetId: 'control',
        treatmentTargetId: 'treatment',
        comparisonDesign: 'paired',
      }, {
        comparisonId: 'independent',
        controlTargetId: 'control',
        treatmentTargetId: 'treatment-2',
        comparisonDesign: 'independent',
      }],
    }, observations())).toThrow(/one comparison design/i);
    expect(() => buildBootstrapFamilyTable(parameters(), [
      ...observations(),
      observation({ targetId: 'unknown', sampleId: 'sample-1', score: 3 }),
    ])).toThrow(/sealed targets and samples/);
    const duplicate = observations();
    duplicate.push({ ...duplicate[0] });
    expect(() => buildBootstrapFamilyTable(parameters(), duplicate)).toThrow(/globally unique/);
  });
});

describe('Bootstrap family Analysis table v2', () => {
  it('uses the planned family size even when a comparison is missing', () => {
    const value = buildBootstrapFamilyTableV2(parameters(), observations());

    expect(value.family).toEqual({
      plannedComparisons: 3,
      observedComparisons: 2,
      missingComparisons: 1,
      nominalAlpha: 0.05,
      effectiveAlpha: 0.05 / 3,
      monteCarloFamilyConfidenceLevel: 0.99,
    });
    expect(value.comparisons.filter((entry) => entry.comparisonStatus === 'observed'))
      .toMatchObject([{
        effectiveAlpha: 0.05 / 3,
        significance: {
          significanceStatus: 'significant',
          evidenceKind: 'exact-resampling-support',
          supportMethodId: 'omk.exact-resampling-support/v1',
        },
      }, {
        effectiveAlpha: 0.05 / 3,
        significance: {
          monteCarloMethodId: BOOTSTRAP_MONTE_CARLO_METHOD_ID,
          familyConfidenceLevel: 0.99,
        },
      }]);
  });

  it('decides from unrounded tail evidence and exposes Monte Carlo uncertainty', () => {
    const belowDisplayPrecision = bootstrapSignificanceEvidence({
      distribution: {
        estimate: 0.00001,
        draws: Array.from({ length: 1_000 }, () => 0.00001),
        exactSign: null,
      },
      effectiveAlpha: 0.05,
      plannedComparisons: 1,
    });
    expect(belowDisplayPrecision).toMatchObject({
      significanceStatus: 'significant',
      evidenceKind: 'monte-carlo-tail',
      direction: 'positive',
      tailCount: 0,
      tailProbability: 0,
      monteCarloMethodId: BOOTSTRAP_MONTE_CARLO_METHOD_ID,
    });
    expect(belowDisplayPrecision.evidenceKind).toBe('monte-carlo-tail');
    if (belowDisplayPrecision.evidenceKind !== 'monte-carlo-tail') return;
    expect(belowDisplayPrecision.probabilityInterval.upper).toBeLessThan(0.025);

    const boundary = bootstrapSignificanceEvidence({
      distribution: {
        estimate: 0.1,
        draws: [
          ...Array.from({ length: 20 }, () => 0),
          ...Array.from({ length: 980 }, () => 0.1),
        ],
        exactSign: null,
      },
      effectiveAlpha: 0.05,
      plannedComparisons: 1,
    });
    expect(boundary.significanceStatus).toBe('indeterminate');
    expect(boundary.evidenceKind).toBe('monte-carlo-tail');
    if (boundary.evidenceKind !== 'monte-carlo-tail') return;
    expect(boundary.probabilityInterval.lower).toBeLessThan(0.025);
    expect(boundary.probabilityInterval.upper).toBeGreaterThan(0.025);
  });

  it('recomputes transported v2 evidence under sealed parameters', () => {
    const sealed = parameters();
    const value = buildBootstrapFamilyTableV2(sealed, observations());
    const envelope = { resultType: 'table' as const, value };
    expect(parseBootstrapFamilyTableV2Envelope(envelope)).toEqual(envelope);
    const validator = createBootstrapFamilyTableV2SchemaValidators().get(
      schemaIdentityKey(BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA),
    );
    const context = {
      validationKind: 'analysis-output' as const,
      parameters: sealed,
      inputFacts: { resamplingUnitCount: 4 },
    };
    expect(validator?.parse(envelope, context)).toEqual(envelope);

    const altered = structuredClone(envelope);
    const comparison = altered.value.comparisons.find(
      (entry) => entry.comparisonStatus === 'observed'
        && entry.significance.evidenceKind === 'monte-carlo-tail',
    );
    if (comparison?.comparisonStatus === 'observed'
        && comparison.significance.evidenceKind === 'monte-carlo-tail') {
      comparison.significance.tailCount += 1;
    }
    expect(() => validator?.parse(altered, context)).toThrow(/recomputable/);
  });
});
