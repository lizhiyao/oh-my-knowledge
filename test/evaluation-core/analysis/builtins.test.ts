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
} from '../../../src/evaluation-core/analysis/index.js';
import {
  countAnalysisResamplingUnits,
  digestCanonicalJson,
  schemaIdentityKey,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';

function row(input: {
  sampleId: string;
  targetId?: string;
  trialIndex?: number;
  value: number;
  pairingBlockId?: Sha256Digest;
  clusterId?: Sha256Digest;
  stratumId?: Sha256Digest;
}): AnalysisMetricRow {
  const targetId = input.targetId ?? 'target';
  const trialIndex = input.trialIndex ?? 0;
  const trialId = digestCanonicalJson({ targetId, sampleId: input.sampleId, trialIndex });
  return {
    rowId: digestCanonicalJson({ trialId, metricId: 'score' }),
    targetId,
    sampleId: input.sampleId,
    trialIndex,
    trialId,
    evaluatorId: 'score-evaluator',
    measurement: {
      instrumentId: 'score-instrument',
      ensembleMemberId: 'score-member',
      replicateGroupId: 'score-primary',
      replicateIndex: 0,
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

function context(input: {
  implementationId: string;
  rows: AnalysisMetricRow[];
  resamplingUnit: 'sample' | 'paired-block' | 'cluster' | 'run';
  comparison?: boolean;
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
      parameters: { resamples: 64, alpha: 0.1 },
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
});
