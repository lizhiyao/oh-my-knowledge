import { describe, expect, it } from 'vitest';
import {
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  type AnalysisMetricRow,
  type AnalysisNodeExecutionContext,
  type AnalysisNodeExecutionResult,
} from '../../../src/eval-core/analysis/index.js';
import {
  digestCanonicalJson,
  schemaIdentityKey,
  type JsonValue,
  type SchemaIdentity,
} from '../../../src/eval-core/contracts/index.js';

type MetricContract = Extract<
  AnalysisNodeExecutionContext['inputs'][number],
  { inputKind: 'metric-observations' }
>['metric'];

function metric(input: {
  metricId: string;
  valueType: 'numeric' | 'boolean';
  direction?: 'higher-is-better' | 'lower-is-better';
  min?: number;
  max?: number;
}): MetricContract {
  return {
    metricId: input.metricId,
    valueType: input.valueType,
    scope: 'sample',
    ...(input.valueType === 'numeric' && input.min !== undefined && input.max !== undefined
      ? { scale: { min: input.min, max: input.max } }
      : {}),
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    missingPolicyId: 'exclude/v1',
  };
}

function row(input: {
  metric: MetricContract;
  sampleId: string;
  targetId?: string;
  trialIndex?: number;
  value?: number | boolean;
  missing?: boolean;
  evaluatorId?: string;
  instrumentId?: string;
  ensembleMemberId?: string;
  replicateGroupId?: string;
  replicateIndex?: number;
  pairingBlockId?: string;
  clusterId?: string;
  stratumId?: string;
}): AnalysisMetricRow {
  const targetId = input.targetId ?? 'candidate';
  const trialIndex = input.trialIndex ?? 0;
  const evaluatorId = input.evaluatorId ?? `${input.metric.metricId}-evaluator`;
  const trialId = digestCanonicalJson({ targetId, sampleId: input.sampleId, trialIndex });
  const base = {
    rowId: digestCanonicalJson({ trialId, metricId: input.metric.metricId, evaluatorId }),
    targetId,
    sampleId: input.sampleId,
    trialIndex,
    trialId,
    evaluatorId,
    measurement: {
      instrumentId: input.instrumentId ?? `${input.metric.metricId}-instrument`,
      ensembleMemberId: input.ensembleMemberId ?? `${input.metric.metricId}-member`,
      replicateGroupId: input.replicateGroupId ?? `${input.metric.metricId}-primary`,
      replicateIndex: input.replicateIndex ?? 0,
    },
    cohortIds: [],
    metricId: input.metric.metricId,
    valueType: input.metric.valueType,
    samplingUnitIds: {
      ...(input.pairingBlockId === undefined ? {} : {
        pairingBlockId: input.pairingBlockId,
      }),
      ...(input.clusterId === undefined ? {} : { clusterId: input.clusterId }),
      ...(input.stratumId === undefined ? {} : { stratumId: input.stratumId }),
    },
    censored: false,
  } as const;
  return input.missing === true
    ? { ...base, rowStatus: 'missing', reasonCode: 'missing-output' }
    : { ...base, rowStatus: 'observed', value: input.value as number | boolean };
}

interface ComponentInput {
  metric: MetricContract;
  weight: number;
  rows: AnalysisMetricRow[];
  measurementAggregation?: JsonValue;
}

function context(input: {
  implementationId: string;
  components: ComponentInput[];
  resamplingUnit: 'sample' | 'paired-block' | 'cluster';
  comparison?: { controlTargetId: string; treatmentTargetId: string };
}): AnalysisNodeExecutionContext {
  const components = [...input.components].sort((left, right) => (
    left.metric.metricId < right.metric.metricId ? -1 : 1
  ));
  const compositeMetricId = 'overall-quality';
  return {
    node: {
      analysisNodeKind: 'estimator',
      nodeId: 'overall-quality-estimate',
      implementationId: input.implementationId,
      inputs: [
        ...components.map((component) => ({
          inputKind: 'metric-observations' as const,
          referenceId: component.metric.metricId,
        })),
        ...(input.comparison === undefined ? [] : [{
          inputKind: 'comparison' as const,
          referenceId: 'comparison-1',
          treatmentTargetId: input.comparison.treatmentTargetId,
          metricId: compositeMetricId,
        }]),
      ],
      outputResultId: 'overall-quality-result',
      parameters: {
        compositeMetricId,
        components: components.map((component) => ({
          metricId: component.metric.metricId,
          weight: component.weight,
          ...(component.measurementAggregation === undefined ? {} : {
            measurementAggregation: component.measurementAggregation,
          }),
        })),
        aggregation: { method: 'weighted-mean', missing: 'require-complete' },
        resamples: 64,
        alpha: 0.1,
      },
    },
    inputs: [
      ...components.map((component) => ({
        inputKind: 'metric-observations' as const,
        referenceId: component.metric.metricId,
        metric: component.metric,
        rows: component.rows,
      })),
      ...(input.comparison === undefined ? [] : [{
        inputKind: 'comparison' as const,
        referenceId: 'comparison-1',
        contrast: {
          comparisonId: 'comparison-1',
          controlTargetId: input.comparison.controlTargetId,
          treatmentTargetId: input.comparison.treatmentTargetId,
          metricId: compositeMetricId,
        },
      }]),
    ],
    analysisPlanDigest: digestCanonicalJson({ analysis: 'composite' }),
    sampling: {
      experimentalUnit: input.resamplingUnit === 'cluster' ? 'cluster' : 'sample',
      repeatedMeasures: true,
      resamplingUnit: input.resamplingUnit,
      estimatorId: input.implementationId,
      seedCoupling: input.resamplingUnit === 'sample'
        ? 'independent-by-target'
        : 'shared-within-block',
      ...(input.resamplingUnit === 'paired-block' ? { pairingKey: '/input/pair' } : {}),
      ...(input.resamplingUnit === 'cluster' ? { clusterKey: '/input/cluster' } : {}),
    },
    rootSeed: 'composite-seed',
    samples: [],
    cohorts: [],
    signal: new AbortController().signal,
  };
}

async function execute(input: AnalysisNodeExecutionContext): Promise<AnalysisNodeExecutionResult> {
  const implementation = createBuiltinAnalysisNodes().get(input.node.implementationId);
  if (implementation === undefined) throw new Error('Composite builtin is missing.');
  const run = await implementation.openRun({
    runId: 'run-1',
    analysisPlanDigest: input.analysisPlanDigest,
    evaluationBundleDigest: digestCanonicalJson({ evaluation: 1 }),
    analysisMode: 'preregistered',
  });
  return run.execute(input);
}

function interval(result: AnalysisNodeExecutionResult): {
  estimate: number;
  lower: number;
  upper: number;
  unitCount: number;
} {
  if (result.analysisStatus !== 'completed' || result.resultType !== 'interval'
      || result.value === null || Array.isArray(result.value)
      || typeof result.value !== 'object') {
    throw new Error('Expected completed interval.');
  }
  return result.value as unknown as ReturnType<typeof interval>;
}

describe('Evaluation Core composite estimators', () => {
  it('seals canonical explicit components and rejects ambiguous weights', () => {
    const implementation = createBuiltinAnalysisNodes().get(
      'bootstrap.composite-mean-percentile/v1',
    );
    expect(implementation?.identity.capabilities).toMatchObject({
      inputCardinalities: {
        metricObservations: { min: 2 },
        comparisons: { min: 0, max: 0 },
      },
    });
    const capabilities = implementation?.identity.capabilities as {
      parameterSchema: SchemaIdentity;
    };
    const validator = createBuiltinAnalysisSchemaValidators().get(
      schemaIdentityKey(capabilities.parameterSchema),
    );
    const valid = {
      compositeMetricId: 'overall-quality',
      components: [
        { metricId: 'latency', weight: 0.4 },
        { metricId: 'correct', weight: 0.6 },
      ],
      aggregation: { method: 'weighted-mean', missing: 'require-complete' },
      resamples: 64,
      alpha: 0.1,
    };
    expect(validator?.parse(valid)).toMatchObject({
      components: [{ metricId: 'correct' }, { metricId: 'latency' }],
    });
    expect(() => validator?.parse({ ...valid, components: [{ metricId: 'correct', weight: 1 }] }))
      .toThrow();
    expect(() => validator?.parse({
      ...valid,
      components: [
        { metricId: 'correct', weight: 0.5 },
        { metricId: 'correct', weight: 0.5 },
      ],
    })).toThrow();
    expect(() => validator?.parse({
      ...valid,
      components: [
        { metricId: 'correct', weight: 0.4 },
        { metricId: 'latency', weight: 0.4 },
      ],
    })).toThrow();
    expect(() => validator?.parse({
      ...valid,
      components: [
        { metricId: 'correct', weight: 0.5 },
        { metricId: 'latency', weight: 0.5000000000005 },
      ],
    })).toThrow();
    expect(() => validator?.parse({
      ...valid,
      components: [
        { metricId: 'correct', weight: 0.5 },
        { metricId: 'latency', weight: 0.4999999999995 },
      ],
    })).toThrow();
  });

  it('maps sealed boolean and bounded numeric directions to unit utility', async () => {
    const correct = metric({
      metricId: 'correct', valueType: 'boolean', direction: 'higher-is-better',
    });
    const latency = metric({
      metricId: 'latency', valueType: 'numeric', direction: 'lower-is-better', min: 0, max: 100,
    });
    const result = await execute(context({
      implementationId: 'bootstrap.composite-mean-percentile/v1',
      resamplingUnit: 'sample',
      components: [{
        metric: correct,
        weight: 0.6,
        rows: [
          row({ metric: correct, sampleId: 's1', value: false }),
          row({ metric: correct, sampleId: 's2', value: true }),
        ],
      }, {
        metric: latency,
        weight: 0.4,
        rows: [
          row({ metric: latency, sampleId: 's1', value: 100 }),
          row({ metric: latency, sampleId: 's2', value: 0 }),
        ],
      }],
    }));
    expect(interval(result)).toMatchObject({ estimate: 0.5, unitCount: 2 });
  });

  it('combines within units before resampling and preserves cross-Metric covariance', async () => {
    const a = metric({
      metricId: 'a', valueType: 'numeric', direction: 'higher-is-better', min: 0, max: 1,
    });
    const b = metric({
      metricId: 'b', valueType: 'numeric', direction: 'higher-is-better', min: 0, max: 1,
    });
    const values = [0, 1, 0, 1];
    const result = await execute(context({
      implementationId: 'bootstrap.composite-mean-percentile/v1',
      resamplingUnit: 'sample',
      components: [{
        metric: a,
        weight: 0.5,
        rows: values.map((value, index) => row({ metric: a, sampleId: `s${index}`, value })),
      }, {
        metric: b,
        weight: 0.5,
        rows: values.map((value, index) => row({
          metric: b, sampleId: `s${index}`, value: 1 - value,
        })),
      }],
    }));
    expect(interval(result)).toMatchObject({ estimate: 0.5, lower: 0.5, upper: 0.5, unitCount: 4 });
  });

  it('requires complete component coordinates without renormalizing weights', async () => {
    const a = metric({
      metricId: 'a', valueType: 'numeric', direction: 'higher-is-better', min: 0, max: 1,
    });
    const b = metric({
      metricId: 'b', valueType: 'numeric', direction: 'higher-is-better', min: 0, max: 1,
    });
    const result = await execute(context({
      implementationId: 'bootstrap.composite-mean-percentile/v1',
      resamplingUnit: 'sample',
      components: [{
        metric: a,
        weight: 0.5,
        rows: ['s1', 's2', 's3'].map((sampleId) => row({ metric: a, sampleId, value: 1 })),
      }, {
        metric: b,
        weight: 0.5,
        rows: [
          row({ metric: b, sampleId: 's1', value: 0 }),
          row({ metric: b, sampleId: 's2', value: 0 }),
          row({ metric: b, sampleId: 's3', missing: true }),
        ],
      }],
    }));
    expect(interval(result)).toMatchObject({ estimate: 0.5, unitCount: 2 });
    expect(result.includedRowIds).toHaveLength(4);
    expect(result.assumptionChecks).toContainEqual({
      assumptionId: 'composite-require-complete',
      checkStatus: 'passed',
      details: {
        unitKind: 'target-sample-trial', planned: 3, complete: 2, missing: 1,
      },
    });
  });

  it('fails closed when observed evidence is outside the sealed scale', async () => {
    const a = metric({
      metricId: 'a', valueType: 'numeric', direction: 'higher-is-better', min: 0, max: 1,
    });
    const b = metric({
      metricId: 'b', valueType: 'numeric', direction: 'higher-is-better', min: 0, max: 1,
    });
    const result = await execute(context({
      implementationId: 'bootstrap.composite-mean-percentile/v1',
      resamplingUnit: 'sample',
      components: [{
        metric: a, weight: 0.5, rows: [row({ metric: a, sampleId: 's1', value: 2 })],
      }, {
        metric: b, weight: 0.5, rows: [row({ metric: b, sampleId: 's1', value: 1 })],
      }],
    }));
    expect(result).toMatchObject({
      analysisStatus: 'inconclusive',
      reasonCodes: ['analysis-composite-value-outside-scale'],
      includedRowIds: [],
      comparableRowIds: [],
      assumptionChecks: [{
        assumptionId: 'composite-source-domain',
        checkStatus: 'failed',
        reasonCode: 'analysis-composite-value-outside-scale',
      }, {
        assumptionId: 'composite-require-complete',
        checkStatus: 'not-evaluated',
        reasonCode: 'analysis-composite-value-outside-scale',
        details: {
          unitKind: 'target-sample-trial', planned: 1, complete: 0, missing: 1,
        },
      }],
    });
  });

  it('retains source lineage when complete composite evidence is insufficient to resample', async () => {
    const a = metric({
      metricId: 'a', valueType: 'numeric', direction: 'higher-is-better', min: 0, max: 1,
    });
    const b = metric({
      metricId: 'b', valueType: 'numeric', direction: 'higher-is-better', min: 0, max: 1,
    });
    const result = await execute(context({
      implementationId: 'bootstrap.composite-mean-percentile/v1',
      resamplingUnit: 'sample',
      components: [{
        metric: a, weight: 0.5, rows: [row({ metric: a, sampleId: 's1', value: 1 })],
      }, {
        metric: b, weight: 0.5, rows: [row({ metric: b, sampleId: 's1', value: 1 })],
      }],
    }));

    expect(result).toMatchObject({
      analysisStatus: 'inconclusive',
      reasonCodes: ['analysis-insufficient-resampling-units'],
    });
    expect(result.includedRowIds).toHaveLength(2);
    expect(result.comparableRowIds).toHaveLength(2);
  });

  it('aggregates sealed panel coordinates before composing and resampling', async () => {
    const rubric = metric({
      metricId: 'rubric', valueType: 'numeric', direction: 'higher-is-better', min: 0, max: 4,
    });
    const correct = metric({
      metricId: 'correct', valueType: 'boolean', direction: 'higher-is-better',
    });
    const panel = {
      method: 'weighted-mean',
      missing: 'require-complete',
      replicateGroupId: 'rubric-panel',
      members: [{
        ensembleMemberId: 'judge-a',
        weight: 0.25,
        replicates: [{ evaluatorId: 'judge-a-0', instrumentId: 'rubric-v1', replicateIndex: 0 }],
      }, {
        ensembleMemberId: 'judge-b',
        weight: 0.75,
        replicates: [{ evaluatorId: 'judge-b-0', instrumentId: 'rubric-v1', replicateIndex: 0 }],
      }],
    } as JsonValue;
    const rubricRows = (sampleId: string, values: [number, number]): AnalysisMetricRow[] => [
      row({
        metric: rubric, sampleId, value: values[0], evaluatorId: 'judge-a-0',
        instrumentId: 'rubric-v1', ensembleMemberId: 'judge-a',
        replicateGroupId: 'rubric-panel', replicateIndex: 0,
      }),
      row({
        metric: rubric, sampleId, value: values[1], evaluatorId: 'judge-b-0',
        instrumentId: 'rubric-v1', ensembleMemberId: 'judge-b',
        replicateGroupId: 'rubric-panel', replicateIndex: 0,
      }),
    ];
    const result = await execute(context({
      implementationId: 'bootstrap.composite-mean-percentile/v1',
      resamplingUnit: 'sample',
      components: [{
        metric: rubric,
        weight: 0.5,
        rows: [...rubricRows('s1', [0, 4]), ...rubricRows('s2', [4, 0])],
        measurementAggregation: panel,
      }, {
        metric: correct,
        weight: 0.5,
        rows: [
          row({ metric: correct, sampleId: 's1', value: true }),
          row({ metric: correct, sampleId: 's2', value: false }),
        ],
      }],
    }));
    expect(interval(result)).toMatchObject({ estimate: 0.5, unitCount: 2 });
    expect(result.includedRowIds).toHaveLength(6);
  });

  it('supports cluster, paired, and independent composite estimands', async () => {
    const a = metric({
      metricId: 'a', valueType: 'numeric', direction: 'higher-is-better', min: 0, max: 1,
    });
    const b = metric({
      metricId: 'b', valueType: 'numeric', direction: 'higher-is-better', min: 0, max: 1,
    });
    const components = (coordinates: Array<{
      sampleId: string;
      targetId?: string;
      value: number;
      pairingBlockId?: string;
      clusterId?: string;
    }>): ComponentInput[] => [a, b].map((contract) => ({
      metric: contract,
      weight: 0.5,
      rows: coordinates.map((coordinate) => row({ metric: contract, ...coordinate })),
    }));

    const clustered = await execute(context({
      implementationId: 'bootstrap.composite-cluster-percentile/v1',
      resamplingUnit: 'cluster',
      components: components([
        { sampleId: 's1', value: 0, clusterId: 'c1' },
        { sampleId: 's2', value: 0, clusterId: 'c1' },
        { sampleId: 's3', value: 1, clusterId: 'c2' },
        { sampleId: 's4', value: 1, clusterId: 'c2' },
      ]),
    }));
    expect(interval(clustered)).toMatchObject({ estimate: 0.5, unitCount: 2 });

    const paired = await execute(context({
      implementationId: 'bootstrap.composite-paired-difference-percentile/v1',
      resamplingUnit: 'paired-block',
      comparison: { controlTargetId: 'control', treatmentTargetId: 'treatment' },
      components: components([
        { sampleId: 's1', targetId: 'control', value: 0, pairingBlockId: 'p1' },
        { sampleId: 's1', targetId: 'treatment', value: 1, pairingBlockId: 'p1' },
        { sampleId: 's2', targetId: 'control', value: 0, pairingBlockId: 'p2' },
        { sampleId: 's2', targetId: 'treatment', value: 1, pairingBlockId: 'p2' },
      ]),
    }));
    expect(interval(paired)).toMatchObject({ estimate: 1, unitCount: 2 });

    const independent = await execute(context({
      implementationId: 'bootstrap.composite-unpaired-difference-percentile/v1',
      resamplingUnit: 'sample',
      comparison: { controlTargetId: 'control', treatmentTargetId: 'treatment' },
      components: components([
        { sampleId: 'c1', targetId: 'control', value: 0 },
        { sampleId: 'c2', targetId: 'control', value: 0 },
        { sampleId: 't1', targetId: 'treatment', value: 1 },
        { sampleId: 't2', targetId: 'treatment', value: 1 },
      ]),
    }));
    expect(interval(independent)).toMatchObject({ estimate: 1, unitCount: 4 });
  });
});
