import { describe, expect, it } from 'vitest';
import {
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinDecisionPolicies,
  BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BUILTIN_SCALAR_RESULT_SCHEMA,
  type AnalysisMetricRow,
  type AnalysisNodeExecutionContext,
  type DecisionPolicyContext,
} from '../../../src/eval-core/analysis/index.js';
import {
  countAnalysisResamplingUnits,
  digestCanonicalJson,
  schemaIdentityKey,
  type JsonValue,
  type Sha256Digest,
} from '../../../src/eval-core/contracts/index.js';

function row(input: {
  sampleId: string;
  targetId?: string;
  trialIndex?: number;
  value: number;
  evaluatorId?: string;
  instrumentId?: string;
  ensembleMemberId?: string;
  replicateGroupId?: string;
  replicateIndex?: number;
  pairingBlockId?: Sha256Digest;
  clusterId?: Sha256Digest;
  stratumId?: Sha256Digest;
}): AnalysisMetricRow {
  const targetId = input.targetId ?? 'target';
  const trialIndex = input.trialIndex ?? 0;
  const evaluatorId = input.evaluatorId ?? 'score-evaluator';
  const trialId = digestCanonicalJson({ targetId, sampleId: input.sampleId, trialIndex });
  return {
    rowId: digestCanonicalJson({ trialId, metricId: 'score', evaluatorId }),
    targetId,
    sampleId: input.sampleId,
    trialIndex,
    trialId,
    evaluatorId,
    measurement: {
      instrumentId: input.instrumentId ?? 'score-instrument',
      ensembleMemberId: input.ensembleMemberId ?? 'score-member',
      replicateGroupId: input.replicateGroupId ?? 'score-primary',
      replicateIndex: input.replicateIndex ?? 0,
    },
    cohortIds: [],
    metricId: 'score',
    valueType: 'numeric',
    samplingUnitIds: {
      ...(input.pairingBlockId !== undefined
        ? { pairingBlockId: input.pairingBlockId }
        : {}),
      ...(input.clusterId !== undefined ? { clusterId: input.clusterId } : {}),
      ...(input.stratumId !== undefined ? { stratumId: input.stratumId } : {}),
    },
    censored: false,
    rowStatus: 'observed',
    value: input.value,
  };
}

function missingRow(input: Parameters<typeof row>[0]): AnalysisMetricRow {
  const observed = row(input) as Extract<AnalysisMetricRow, { rowStatus: 'observed' }>;
  const { value: _value, ...base } = observed;
  void _value;
  return { ...base, rowStatus: 'missing', reasonCode: 'missing-output' };
}

function context(input: {
  implementationId: string;
  rows: AnalysisMetricRow[];
  resamplingUnit: 'sample' | 'paired-block' | 'cluster' | 'run';
  comparison?: boolean;
  parameters?: JsonValue;
}): AnalysisNodeExecutionContext {
  return {
    node: {
      analysisNodeKind: 'estimator',
      nodeId: 'estimate',
      implementationId: input.implementationId,
      inputs: [
        { inputKind: 'metric-observations', referenceId: 'score' },
        ...(input.comparison
          ? [{
            inputKind: 'comparison' as const,
            referenceId: 'comparison-1',
            treatmentTargetId: 'treatment',
            metricId: 'score',
          }]
          : []),
      ],
      outputResultId: 'estimate-result',
      parameters: input.parameters ?? { resamples: 64, alpha: 0.1 },
    },
    inputs: [{
      inputKind: 'metric-observations',
      referenceId: 'score',
      metric: {
        metricId: 'score',
        valueType: 'numeric',
        scope: 'sample',
        direction: 'higher-is-better',
        missingPolicyId: 'exclude/v1',
      },
      rows: input.rows,
    }, ...(input.comparison ? [{
      inputKind: 'comparison' as const,
      referenceId: 'comparison-1',
      contrast: {
        comparisonId: 'comparison-1',
        controlTargetId: 'control',
        treatmentTargetId: 'treatment',
        metricId: 'score',
      },
    }] : [])],
    analysisPlanDigest: digestCanonicalJson({ analysisPlan: 1 }),
    sampling: {
      experimentalUnit: input.resamplingUnit === 'cluster' ? 'cluster' : 'sample',
      repeatedMeasures: true,
      resamplingUnit: input.resamplingUnit,
      estimatorId: input.implementationId,
      seedCoupling: 'shared-within-block',
      ...(input.resamplingUnit === 'paired-block' ? { pairingKey: '/input/pair' } : {}),
      ...(input.resamplingUnit === 'cluster' ? { clusterKey: '/input/cluster' } : {}),
    },
    rootSeed: 'stable-seed',
    samples: [],
    cohorts: [],
    signal: new AbortController().signal,
  };
}

const panelAggregation = {
  method: 'weighted-mean',
  missing: 'require-complete',
  replicateGroupId: 'quality-panel',
  members: [{
    ensembleMemberId: 'judge-a',
    weight: 0.25,
    replicates: [0, 1].map((replicateIndex) => ({
      evaluatorId: `quality-panel/judge-a/replicate-${replicateIndex}`,
      instrumentId: 'quality-rubric-v1',
      replicateIndex,
    })),
  }, {
    ensembleMemberId: 'judge-b',
    weight: 0.75,
    replicates: [0, 1].map((replicateIndex) => ({
      evaluatorId: `quality-panel/judge-b/replicate-${replicateIndex}`,
      instrumentId: 'quality-rubric-v1',
      replicateIndex,
    })),
  }],
} as const;

function panelRows(input: {
  sampleId: string;
  targetId?: string;
  trialIndex?: number;
  values: readonly [number, number, number, number];
  pairingBlockId?: Sha256Digest;
  stratumId?: Sha256Digest;
}): AnalysisMetricRow[] {
  return panelAggregation.members.flatMap((member, memberIndex) => (
    member.replicates.map((replicate, replicateIndex) => row({
      sampleId: input.sampleId,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.trialIndex === undefined ? {} : { trialIndex: input.trialIndex }),
      value: input.values[memberIndex * 2 + replicateIndex],
      evaluatorId: replicate.evaluatorId,
      instrumentId: replicate.instrumentId,
      ensembleMemberId: member.ensembleMemberId,
      replicateGroupId: panelAggregation.replicateGroupId,
      replicateIndex: replicate.replicateIndex,
      ...(input.pairingBlockId === undefined ? {} : { pairingBlockId: input.pairingBlockId }),
      ...(input.stratumId === undefined ? {} : { stratumId: input.stratumId }),
    }))
  ));
}

const panelParameters = {
  resamples: 64,
  alpha: 0.1,
  measurementAggregation: panelAggregation,
} as unknown as JsonValue;

async function execute(input: AnalysisNodeExecutionContext) {
  const implementation = createBuiltinAnalysisNodes().get(input.node.implementationId);
  if (implementation === undefined) throw new Error('missing builtin');
  const run = await implementation.openRun({
    runId: 'run-1',
    analysisPlanDigest: digestCanonicalJson({ plan: 1 }),
    evaluationBundleDigest: digestCanonicalJson({ evaluation: 1 }),
    analysisMode: 'preregistered',
  });
  return run.execute(input);
}

describe('Evaluation Core built-in estimators', () => {
  it('declares the independent-group estimator capability without paired-block fallback', () => {
    const implementation = createBuiltinAnalysisNodes().get(
      'bootstrap.unpaired-difference-percentile/v1',
    );
    expect(implementation?.identity.capabilities).toMatchObject({
      capabilityKind: 'analysis-node',
      analysisNodeKinds: ['estimator'],
      inputCardinalities: {
        metricObservations: { min: 1, max: 1 },
        comparisons: { min: 1, max: 1 },
      },
      sampling: {
        assignmentKinds: ['independent-groups'],
        experimentalUnits: ['sample'],
        repeatedMeasures: [false, true],
        resamplingUnits: ['sample'],
      },
    });
  });

  it('counts only complete paired resampling units', () => {
    expect(countAnalysisResamplingUnits('paired-block', [
      {
        targetId: 'control',
        sampleId: 's1',
        samplingUnitIds: { pairingBlockId: 'pair-1' },
      },
      {
        targetId: 'treatment',
        sampleId: 's1',
        samplingUnitIds: { pairingBlockId: 'pair-1' },
      },
      {
        targetId: 'control',
        sampleId: 's2',
        samplingUnitIds: { pairingBlockId: 'pair-2' },
      },
    ], ['control', 'treatment'])).toBe(1);
  });

  it('validates the complete result envelope and Bonferroni invariants', () => {
    const validators = createBuiltinAnalysisSchemaValidators();
    const scalar = validators.get(schemaIdentityKey(BUILTIN_SCALAR_RESULT_SCHEMA));
    const interval = validators.get(schemaIdentityKey(BUILTIN_INTERVAL_RESULT_SCHEMA));
    const bonferroni = validators.get(schemaIdentityKey(BUILTIN_HYPOTHESIS_TABLE_SCHEMA));
    expect(() => scalar?.parse({ resultType: 'table', value: 1 })).toThrow();
    expect(() => scalar?.parse({ resultType: 'scalar', value: 1, extra: true })).toThrow();
    expect(() => bonferroni?.parse({
      resultType: 'table',
      value: {
        familySize: 1,
        alpha: 0.05,
        hypotheses: [{
          hypothesisId: 'h1',
          rawPValue: 0.01,
          adjustedPValue: 0.9,
          rejected: false,
        }],
      },
    })).toThrow();
    const intervalEnvelope = {
      resultType: 'interval',
      value: {
        estimate: 1,
        lower: 0,
        upper: 2,
        confidenceLevel: 0.9,
        resamples: 64,
        unitCount: 2,
        method: 'percentile',
      },
    };
    expect(interval?.parse(intervalEnvelope, {
      validationKind: 'analysis-output',
      parameters: { resamples: 64, alpha: 0.1 },
      inputFacts: { resamplingUnitCount: 2 },
    })).toEqual(intervalEnvelope);
    expect(() => interval?.parse(intervalEnvelope, {
      validationKind: 'analysis-output',
      parameters: { resamples: 1_000, alpha: 0.05 },
      inputFacts: { resamplingUnitCount: 2 },
    })).toThrow(/sealed Analysis facts/);
    expect(() => interval?.parse(intervalEnvelope, {
      validationKind: 'analysis-output',
      parameters: { resamples: 64, alpha: 0.1 },
      inputFacts: { resamplingUnitCount: 999 },
    })).toThrow(/sealed Analysis facts/);
    const intervalExcludingEstimate = {
      ...intervalEnvelope,
      value: { ...intervalEnvelope.value, estimate: 3 },
    };
    expect(interval?.parse(intervalExcludingEstimate, {
      validationKind: 'analysis-output',
      parameters: { resamples: 64, alpha: 0.1 },
      inputFacts: { resamplingUnitCount: 2 },
    })).toEqual(intervalExcludingEstimate);
    expect(() => interval?.parse({
      ...intervalEnvelope,
      value: { ...intervalEnvelope.value, lower: 2, upper: 0 },
    }, {
      validationKind: 'analysis-output',
      parameters: { resamples: 64, alpha: 0.1 },
      inputFacts: { resamplingUnitCount: 2 },
    })).toThrow(/lower <= upper/);

    const hypothesisEnvelope = {
      resultType: 'table',
      value: {
        familySize: 1,
        alpha: 0.05,
        hypotheses: [{
          hypothesisId: 'h1',
          rawPValue: 0.01,
          adjustedPValue: 0.01,
          rejected: true,
        }],
      },
    };
    expect(bonferroni?.parse(hypothesisEnvelope, {
      validationKind: 'analysis-output',
      parameters: { alpha: 0.05 },
      inputFacts: { resamplingUnitCount: 0 },
    })).toEqual(hypothesisEnvelope);
    expect(() => bonferroni?.parse(hypothesisEnvelope, {
      validationKind: 'analysis-output',
      parameters: { alpha: 0.1 },
      inputFacts: { resamplingUnitCount: 0 },
    })).toThrow(/sealed node parameters/);
  });

  it('resamples sample units rather than repeated trials', async () => {
    const input = context({
      implementationId: 'bootstrap.mean-percentile/v1',
      resamplingUnit: 'sample',
      rows: [
        row({ sampleId: 's1', trialIndex: 0, value: 0 }),
        row({ sampleId: 's1', trialIndex: 1, value: 1 }),
        row({ sampleId: 's2', trialIndex: 0, value: 1 }),
        row({ sampleId: 's2', trialIndex: 1, value: 1 }),
      ],
    });
    const first = await execute(input);
    const second = await execute(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 0.75, unitCount: 2, resamples: 64 },
    });
  });

  it('aggregates replicate, member, trial, and sample levels without inflating unitCount', async () => {
    const rows = [
      ...panelRows({ sampleId: 's1', trialIndex: 0, values: [1, 3, 5, 5] }),
      ...panelRows({ sampleId: 's1', trialIndex: 1, values: [2, 4, 6, 6] }),
      ...panelRows({ sampleId: 's2', trialIndex: 0, values: [1, 1, 1, 1] }),
      ...panelRows({ sampleId: 's2', trialIndex: 1, values: [1, 1, 1, 1] }),
    ];
    const result = await execute(context({
      implementationId: 'bootstrap.hierarchical-mean-percentile/v1',
      resamplingUnit: 'sample',
      rows,
      parameters: panelParameters,
    }));

    expect(result).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 2.875, unitCount: 2 },
    });
    expect(result.includedRowIds).toHaveLength(16);
  });

  it('fails a panel trial closed when one sealed replicate is unavailable', async () => {
    const complete = panelRows({ sampleId: 's1', values: [1, 3, 5, 5] });
    const incompleteTrial = panelRows({
      sampleId: 's1', trialIndex: 1, values: [100, 100, 100, 100],
    });
    incompleteTrial[3] = missingRow({
      sampleId: 's1',
      trialIndex: 1,
      value: 100,
      evaluatorId: 'quality-panel/judge-b/replicate-1',
      instrumentId: 'quality-rubric-v1',
      ensembleMemberId: 'judge-b',
      replicateGroupId: 'quality-panel',
      replicateIndex: 1,
    });
    const result = await execute(context({
      implementationId: 'bootstrap.hierarchical-mean-percentile/v1',
      resamplingUnit: 'sample',
      rows: [
        ...complete,
        ...incompleteTrial,
        ...panelRows({ sampleId: 's2', values: [1, 1, 1, 1] }),
      ],
      parameters: panelParameters,
    }));

    expect(result).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 2.625, unitCount: 2 },
    });
    expect(result.includedRowIds).toHaveLength(8);
    expect(result.includedRowIds).not.toContain(incompleteTrial[0].rowId);
  });

  it('keeps a one-member one-replicate panel mathematically equivalent to v1', async () => {
    const rows = [
      row({ sampleId: 's1', value: 1 }),
      row({ sampleId: 's2', value: 1 }),
    ];
    const legacy = await execute(context({
      implementationId: 'bootstrap.mean-percentile/v1',
      resamplingUnit: 'sample',
      rows,
    }));
    const hierarchical = await execute(context({
      implementationId: 'bootstrap.hierarchical-mean-percentile/v1',
      resamplingUnit: 'sample',
      rows,
      parameters: {
        resamples: 64,
        alpha: 0.1,
        measurementAggregation: {
          method: 'mean',
          missing: 'require-complete',
          replicateGroupId: 'score-primary',
          members: [{
            ensembleMemberId: 'score-member',
            replicates: [{
              evaluatorId: 'score-evaluator',
              instrumentId: 'score-instrument',
              replicateIndex: 0,
            }],
          }],
        },
      },
    }));

    expect(hierarchical).toEqual(legacy);
  });

  it('rejects rows that differ from sealed panel coordinates', async () => {
    const rows = panelRows({ sampleId: 's1', values: [1, 1, 1, 1] });
    rows[0] = row({
      sampleId: 's1',
      value: 1,
      evaluatorId: 'unexpected-evaluator',
      instrumentId: 'quality-rubric-v1',
      ensembleMemberId: 'judge-a',
      replicateGroupId: 'quality-panel',
      replicateIndex: 0,
    });
    await expect(execute(context({
      implementationId: 'bootstrap.hierarchical-mean-percentile/v1',
      resamplingUnit: 'sample',
      rows,
      parameters: panelParameters,
    }))).rejects.toThrow(/sealed panel coordinates/);

    const nonCanonical = structuredClone(panelParameters) as {
      measurementAggregation: { members: unknown[] };
    };
    nonCanonical.measurementAggregation.members.reverse();
    await expect(execute(context({
      implementationId: 'bootstrap.hierarchical-mean-percentile/v1',
      resamplingUnit: 'sample',
      rows: panelRows({ sampleId: 's1', values: [1, 1, 1, 1] }),
      parameters: nonCanonical as unknown as JsonValue,
    }))).rejects.toThrow(/ordered by ensembleMemberId/);
  });

  it('uses complete hierarchical panel units for paired and independent contrasts', async () => {
    const pair1 = digestCanonicalJson({ panelPair: 1 });
    const pair2 = digestCanonicalJson({ panelPair: 2 });
    const paired = await execute(context({
      implementationId: 'bootstrap.hierarchical-paired-difference-percentile/v1',
      resamplingUnit: 'paired-block',
      comparison: true,
      rows: [
        ...panelRows({ sampleId: 's1', targetId: 'control', values: [1, 1, 1, 1], pairingBlockId: pair1 }),
        ...panelRows({ sampleId: 's1', targetId: 'treatment', values: [3, 3, 3, 3], pairingBlockId: pair1 }),
        ...panelRows({ sampleId: 's2', targetId: 'control', values: [2, 2, 2, 2], pairingBlockId: pair2 }),
        ...panelRows({ sampleId: 's2', targetId: 'treatment', values: [5, 5, 5, 5], pairingBlockId: pair2 }),
      ],
      parameters: panelParameters,
    }));
    expect(paired).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 2.5, unitCount: 2 },
    });

    const independent = await execute(context({
      implementationId: 'bootstrap.hierarchical-unpaired-difference-percentile/v1',
      resamplingUnit: 'sample',
      comparison: true,
      rows: [
        ...panelRows({ sampleId: 'c1', targetId: 'control', values: [1, 1, 1, 1] }),
        ...panelRows({ sampleId: 'c2', targetId: 'control', values: [3, 3, 3, 3] }),
        ...panelRows({ sampleId: 't1', targetId: 'treatment', values: [4, 4, 4, 4] }),
        ...panelRows({ sampleId: 't2', targetId: 'treatment', values: [6, 6, 6, 6] }),
      ],
      parameters: panelParameters,
    }));
    expect(independent).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 3, unitCount: 4 },
    });
  });

  it('excludes incomplete pairing units from the paired estimand', async () => {
    const pair1 = digestCanonicalJson({ pair: 1 });
    const pair2 = digestCanonicalJson({ pair: 2 });
    const incomplete = digestCanonicalJson({ pair: 3 });
    const input = context({
      implementationId: 'bootstrap.paired-difference-percentile/v1',
      resamplingUnit: 'paired-block',
      comparison: true,
      rows: [
        row({ sampleId: 's1', targetId: 'control', value: 1, pairingBlockId: pair1 }),
        row({ sampleId: 's1', targetId: 'treatment', value: 2, pairingBlockId: pair1 }),
        row({ sampleId: 's2', targetId: 'control', value: 2, pairingBlockId: pair2 }),
        row({ sampleId: 's2', targetId: 'treatment', value: 4, pairingBlockId: pair2 }),
        row({ sampleId: 's3', targetId: 'control', value: 100, pairingBlockId: incomplete }),
      ],
    });
    const result = await execute(input);

    expect(result).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 1.5, unitCount: 2 },
    });
    expect(result.includedRowIds).toHaveLength(4);
  });

  it('resamples independent arms and rejects overlapping experimental units', async () => {
    const independent = context({
      implementationId: 'bootstrap.unpaired-difference-percentile/v1',
      resamplingUnit: 'sample',
      comparison: true,
      rows: [
        row({ sampleId: 'c1', targetId: 'control', value: 1 }),
        row({ sampleId: 'c2', targetId: 'control', value: 3 }),
        row({ sampleId: 't1', targetId: 'treatment', value: 4 }),
        row({ sampleId: 't2', targetId: 'treatment', value: 6 }),
      ],
    });
    const first = await execute(independent);
    const second = await execute(independent);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 3, unitCount: 4, resamples: 64 },
      assumptionChecks: [{
        assumptionId: 'independent-non-overlapping-samples',
        checkStatus: 'passed',
      }],
    });
    expect(first.includedRowIds).toHaveLength(4);

    const overlapping = await execute(context({
      implementationId: 'bootstrap.unpaired-difference-percentile/v1',
      resamplingUnit: 'sample',
      comparison: true,
      rows: [
        row({ sampleId: 'shared', targetId: 'control', value: 1 }),
        row({ sampleId: 'c2', targetId: 'control', value: 3 }),
        row({ sampleId: 'shared', targetId: 'treatment', value: 4 }),
        row({ sampleId: 't2', targetId: 'treatment', value: 6 }),
      ],
    }));
    expect(overlapping).toMatchObject({
      analysisStatus: 'inconclusive',
      reasonCodes: ['analysis-unpaired-bootstrap-overlapping-units'],
    });
  });

  it('estimates independent arms within strata using pooled stratum weights', async () => {
    const stratumA = digestCanonicalJson({ stratum: 'a' });
    const stratumB = digestCanonicalJson({ stratum: 'b' });
    const result = await execute(context({
      implementationId: 'bootstrap.unpaired-difference-percentile/v1',
      resamplingUnit: 'sample',
      comparison: true,
      rows: [
        row({ sampleId: 'c-a1', targetId: 'control', value: 0, stratumId: stratumA }),
        row({ sampleId: 'c-a2', targetId: 'control', value: 0, stratumId: stratumA }),
        row({ sampleId: 't-a1', targetId: 'treatment', value: 2, stratumId: stratumA }),
        row({ sampleId: 'c-b1', targetId: 'control', value: 100, stratumId: stratumB }),
        row({ sampleId: 't-b1', targetId: 'treatment', value: 102, stratumId: stratumB }),
        row({ sampleId: 't-b2', targetId: 'treatment', value: 102, stratumId: stratumB }),
      ],
    }));

    expect(result).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 2, unitCount: 6 },
    });

    const missingArm = await execute(context({
      implementationId: 'bootstrap.unpaired-difference-percentile/v1',
      resamplingUnit: 'sample',
      comparison: true,
      rows: [
        row({ sampleId: 'c-a1', targetId: 'control', value: 0, stratumId: stratumA }),
        row({ sampleId: 'c-b1', targetId: 'control', value: 100, stratumId: stratumB }),
        row({ sampleId: 't-a1', targetId: 'treatment', value: 2, stratumId: stratumA }),
        row({ sampleId: 't-a2', targetId: 'treatment', value: 2, stratumId: stratumA }),
      ],
    }));
    expect(missingArm).toMatchObject({
      analysisStatus: 'inconclusive',
      reasonCodes: ['analysis-unpaired-bootstrap-strata-not-shared'],
    });
  });

  it('keeps sealed stratum weights stable under differential missingness', async () => {
    const stratumA = digestCanonicalJson({ stratum: 'a' });
    const stratumB = digestCanonicalJson({ stratum: 'b' });
    const result = await execute(context({
      implementationId: 'bootstrap.unpaired-difference-percentile/v1',
      resamplingUnit: 'sample',
      comparison: true,
      rows: [
        row({ sampleId: 'c-a1', targetId: 'control', value: 0, stratumId: stratumA }),
        row({ sampleId: 'c-a2', targetId: 'control', value: 0, stratumId: stratumA }),
        row({ sampleId: 'c-a3', targetId: 'control', value: 0, stratumId: stratumA }),
        row({ sampleId: 't-a1', targetId: 'treatment', value: 0, stratumId: stratumA }),
        missingRow({ sampleId: 't-a2', targetId: 'treatment', value: 0, stratumId: stratumA }),
        missingRow({ sampleId: 't-a3', targetId: 'treatment', value: 0, stratumId: stratumA }),
        row({ sampleId: 'c-b1', targetId: 'control', value: 0, stratumId: stratumB }),
        row({ sampleId: 't-b1', targetId: 'treatment', value: 100, stratumId: stratumB }),
      ],
    }));

    expect(result).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 25, unitCount: 6 },
    });
  });

  it('weights a multi-arm contrast by the sealed experiment population', async () => {
    const stratumA = digestCanonicalJson({ stratum: 'a' });
    const stratumB = digestCanonicalJson({ stratum: 'b' });
    const result = await execute(context({
      implementationId: 'bootstrap.unpaired-difference-percentile/v1',
      resamplingUnit: 'sample',
      comparison: true,
      rows: [
        row({ sampleId: 'c-a', targetId: 'control', value: 0, stratumId: stratumA }),
        row({ sampleId: 't-a', targetId: 'treatment', value: 0, stratumId: stratumA }),
        ...Array.from({ length: 6 }, (_, index) => row({
          sampleId: `third-a-${index + 1}`,
          targetId: 'third',
          value: 0,
          stratumId: stratumA,
        })),
        row({ sampleId: 'c-b', targetId: 'control', value: 0, stratumId: stratumB }),
        row({ sampleId: 't-b', targetId: 'treatment', value: 100, stratumId: stratumB }),
      ],
    }));

    expect(result).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 20, unitCount: 4 },
    });
  });

  it('resamples whole clusters and rejects fewer than two units', async () => {
    const cluster = digestCanonicalJson({ cluster: 1 });
    const result = await execute(context({
      implementationId: 'bootstrap.cluster-percentile/v1',
      resamplingUnit: 'cluster',
      rows: [
        row({ sampleId: 's1', value: 1, clusterId: cluster }),
        row({ sampleId: 's2', value: 3, clusterId: cluster }),
      ],
    }));

    expect(result).toMatchObject({
      analysisStatus: 'inconclusive',
      reasonCodes: ['analysis-insufficient-resampling-units'],
    });
  });

  it('preserves sealed strata during bootstrap draws', async () => {
    const stratumA = digestCanonicalJson({ stratum: 'a' });
    const stratumB = digestCanonicalJson({ stratum: 'b' });
    const result = await execute(context({
      implementationId: 'bootstrap.mean-percentile/v1',
      resamplingUnit: 'sample',
      rows: [
        row({ sampleId: 's1', value: 0, stratumId: stratumA }),
        row({ sampleId: 's2', value: 0, stratumId: stratumA }),
        row({ sampleId: 's3', value: 10, stratumId: stratumB }),
        row({ sampleId: 's4', value: 10, stratumId: stratumB }),
      ],
    }));

    expect(result).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 5, lower: 5, upper: 5, unitCount: 4 },
    });
  });

  it('corrects exactly the declared Bonferroni family', async () => {
    const input = {
      node: {
        analysisNodeKind: 'correction',
        nodeId: 'correct-family',
        implementationId: 'bonferroni/v1',
        inputs: [{ inputKind: 'analysis-result', referenceId: 'raw-hypotheses' }],
        outputResultId: 'corrected-hypotheses',
        parameters: { alpha: 0.05 },
      },
      inputs: [{
        inputKind: 'analysis-result',
        referenceId: 'raw-hypotheses',
        record: {
          analysisStatus: 'completed',
          value: {
            hypotheses: [
              { hypothesisId: 'h2', pValue: 0.04 },
              { hypothesisId: 'h1', pValue: 0.01 },
            ],
          },
        },
      }],
      analysisPlanDigest: digestCanonicalJson({ analysisPlan: 1 }),
      sampling: {
        experimentalUnit: 'sample',
        repeatedMeasures: false,
        resamplingUnit: 'sample',
        estimatorId: 'bonferroni/v1',
        seedCoupling: 'shared-within-block',
      },
      rootSeed: 'stable-seed',
      cohorts: [],
      signal: new AbortController().signal,
    } as unknown as AnalysisNodeExecutionContext;
    const result = await execute(input);

    expect(result).toMatchObject({
      analysisStatus: 'completed',
      value: {
        familySize: 2,
        hypotheses: [
          {
            hypothesisId: 'h1',
            rawPValue: 0.01,
            adjustedPValue: 0.02,
            rejected: true,
          },
          {
            hypothesisId: 'h2',
            rawPValue: 0.04,
            adjustedPValue: 0.08,
            rejected: false,
          },
        ],
      },
    });
  });

  it('selects the exact bound effect for the progress decision', async () => {
    const progress = createBuiltinDecisionPolicies().get('progress/v1');
    if (progress === undefined) throw new Error('missing progress policy');
    expect(progress.identity.fingerprint).toBe(
      'sha256:422be979c929c5db1c49df13474ad92e95cff8c9b2428def371b6376503a0045',
    );
    expect(progress.identity.capabilities).toMatchObject({
      analysisResultSchemaUris: [
        BUILTIN_INTERVAL_RESULT_SCHEMA.schemaUri,
        BUILTIN_SCALAR_RESULT_SCHEMA.schemaUri,
      ].sort(),
      multipleComparisonPolicyIds: [],
    });
    const context = {
      policy: { parameters: { threshold: 0, equivalence: 0 } },
      results: [
        { resultId: 'unrelated-global', value: 1 },
        { resultId: 'bound-effect', value: -1 },
      ],
      contrasts: [{
        analysisResultId: 'bound-effect',
        comparisonId: 'comparison-1',
        controlTargetId: 'control',
        treatmentTargetId: 'treatment',
        metricId: 'score',
      }],
    } as unknown as DecisionPolicyContext;

    await expect(progress.decide(context)).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'REGRESSION',
      reasonCodes: ['effect-below-regression-threshold'],
    });
    await expect(progress.decide({
      ...context,
      contrasts: [
        ...context.contrasts,
        { ...context.contrasts[0], analysisResultId: 'another-effect' },
      ],
    })).resolves.toEqual({
      decisionStatus: 'not-decided',
      reasonCodes: ['decision-effect-unavailable'],
    });
  });

  it('requires an interval to exclude the decision boundary for progress/v2', async () => {
    const progress = createBuiltinDecisionPolicies().get('progress/v2');
    if (progress === undefined) throw new Error('missing interval progress policy');
    expect(progress.identity.fingerprint).toBe(
      'sha256:3075e7741fcd2fe463af8d7ec31ca0731c7c0838bad46a2bbdb0952f32ee434b',
    );
    expect(progress.identity.capabilities).toMatchObject({
      analysisResultSchemaUris: [BUILTIN_INTERVAL_RESULT_SCHEMA.schemaUri],
      multipleComparisonPolicyIds: [],
    });
    const decisionContext = (
      value: unknown,
      resultType: 'interval' | 'scalar' = 'interval',
    ) => ({
      policy: { parameters: { threshold: 0.1, equivalence: 0.05 } },
      results: [{ resultId: 'bound-effect', resultType, value }],
      contrasts: [{
        analysisResultId: 'bound-effect',
        comparisonId: 'comparison-1',
        controlTargetId: 'control',
        treatmentTargetId: 'treatment',
        metricId: 'score',
      }],
    }) as unknown as DecisionPolicyContext;
    const interval = (estimate: number, lower: number, upper: number) => ({
      estimate,
      lower,
      upper,
      confidenceLevel: 0.95,
      resamples: 1_000,
      unitCount: 20,
      method: 'percentile',
    });

    await expect(progress.decide(decisionContext(interval(0.25, 0.16, 0.4))))
      .resolves.toEqual({
        decisionStatus: 'decided',
        verdict: 'PROGRESS',
        reasonCodes: ['interval-above-progress-boundary'],
      });
    await expect(progress.decide(decisionContext(interval(-0.2, -0.4, 0.04))))
      .resolves.toEqual({
        decisionStatus: 'decided',
        verdict: 'REGRESSION',
        reasonCodes: ['interval-below-regression-boundary'],
      });
    await expect(progress.decide(decisionContext(interval(0.25, 0.14, 0.4))))
      .resolves.toEqual({
        decisionStatus: 'decided',
        verdict: 'NOISE',
        reasonCodes: ['interval-overlaps-decision-boundary'],
      });
    await expect(progress.decide(decisionContext(0.25, 'scalar'))).resolves.toEqual({
      decisionStatus: 'not-decided',
      reasonCodes: ['decision-interval-unavailable'],
    });
  });
});
