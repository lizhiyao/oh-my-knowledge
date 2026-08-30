import { describe, expect, it } from 'vitest';
import {
  createBuiltinAnalysisNodes,
  type AnalysisMetricRow,
  type AnalysisNodeExecutionContext,
} from '../../../src/evaluation-core/analysis/index.js';
import { digestCanonicalJson, type Sha256Digest } from '../../../src/evaluation-core/contracts/index.js';

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function normal(next: () => number): number {
  const first = Math.max(next(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * next());
}

function metricRow(input: {
  sampleId: string;
  targetId?: string;
  value: number;
  pairingBlockId?: Sha256Digest;
}): AnalysisMetricRow {
  const targetId = input.targetId ?? 'target';
  const trialId = digestCanonicalJson({ targetId, sampleId: input.sampleId, trialIndex: 0 });
  return {
    rowId: digestCanonicalJson({ trialId, metricId: 'score' }),
    targetId,
    sampleId: input.sampleId,
    trialIndex: 0,
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
    samplingUnitIds: input.pairingBlockId === undefined
      ? {}
      : { pairingBlockId: input.pairingBlockId },
    censored: false,
    rowStatus: 'observed',
    value: input.value,
  };
}

async function interval(input: {
  implementationId: 'bootstrap.mean-percentile/v1'
    | 'bootstrap.paired-difference-percentile/v1';
  rows: AnalysisMetricRow[];
  simulation: number;
  paired?: boolean;
}): Promise<{ lower: number; upper: number; estimate: number; unitCount: number }> {
  const implementation = createBuiltinAnalysisNodes().get(input.implementationId);
  if (implementation === undefined) throw new Error('Missing bootstrap implementation.');
  const run = await implementation.openRun({
    runId: `simulation-${input.simulation}`,
    analysisPlanDigest: digestCanonicalJson({ plan: input.simulation }),
    evaluationBundleDigest: digestCanonicalJson({ evaluation: input.simulation }),
    analysisMode: 'preregistered',
  });
  const context: AnalysisNodeExecutionContext = {
    node: {
      analysisNodeKind: 'estimator',
      nodeId: 'estimate',
      implementationId: input.implementationId,
      inputs: [
        { inputKind: 'metric-observations', referenceId: 'score' },
        ...(input.paired ? [{
          inputKind: 'comparison' as const,
          referenceId: 'comparison',
          treatmentTargetId: 'treatment',
          metricId: 'score',
        }] : []),
      ],
      outputResultId: 'interval',
      parameters: { resamples: 256, alpha: 0.1 },
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
    }, ...(input.paired ? [{
      inputKind: 'comparison' as const,
      referenceId: 'comparison',
      contrast: {
        comparisonId: 'comparison',
        controlTargetId: 'control',
        treatmentTargetId: 'treatment',
        metricId: 'score',
      },
    }] : [])],
    analysisPlanDigest: digestCanonicalJson({ plan: input.simulation }),
    sampling: {
      experimentalUnit: 'sample',
      repeatedMeasures: false,
      resamplingUnit: input.paired ? 'paired-block' : 'sample',
      estimatorId: input.implementationId,
      seedCoupling: 'shared-within-block',
      ...(input.paired ? { pairingKey: '/input/pair' } : {}),
    },
    rootSeed: `simulation-seed-${input.simulation}`,
    samples: [],
    cohorts: [],
    signal: new AbortController().signal,
  };
  const result = await run.execute(context);
  await run.dispose();
  if (result.analysisStatus !== 'completed'
      || result.value === null
      || Array.isArray(result.value)
      || typeof result.value !== 'object') {
    throw new Error('Expected a completed bootstrap interval.');
  }
  const { lower, upper, estimate, unitCount } = result.value;
  if (typeof lower !== 'number' || typeof upper !== 'number'
      || typeof estimate !== 'number' || typeof unitCount !== 'number') {
    throw new Error('Expected numeric interval facts.');
  }
  return { lower, upper, estimate, unitCount };
}

describe('Evaluation Core deterministic statistical conformance', () => {
  it('matches known mean and paired-difference reference vectors', async () => {
    const mean = await interval({
      implementationId: 'bootstrap.mean-percentile/v1',
      simulation: 0,
      rows: [1, 2, 3, 4].map((value, index) => metricRow({
        sampleId: `sample-${index}`,
        value,
      })),
    });
    const pairedRows = [1, 2, 3, 4].flatMap((difference, index) => {
      const pairingBlockId = digestCanonicalJson({ pair: index });
      return [
        metricRow({
          sampleId: `sample-${index}`,
          targetId: 'control',
          value: 10,
          pairingBlockId,
        }),
        metricRow({
          sampleId: `sample-${index}`,
          targetId: 'treatment',
          value: 10 + difference,
          pairingBlockId,
        }),
      ];
    });
    const paired = await interval({
      implementationId: 'bootstrap.paired-difference-percentile/v1',
      simulation: 0,
      rows: pairedRows,
      paired: true,
    });

    expect(mean).toEqual({ lower: 1.5, upper: 3.25, estimate: 2.5, unitCount: 4 });
    expect(paired).toEqual({ lower: 1.5, upper: 3.5, estimate: 2.5, unitCount: 4 });
  });

  it('keeps deterministic 90% mean-interval coverage within a broad calibration band', async () => {
    let covered = 0;
    const simulations = 80;
    for (let simulation = 1; simulation <= simulations; simulation += 1) {
      const next = generator(simulation);
      const rows = Array.from({ length: 24 }, (_, index) => metricRow({
        sampleId: `sample-${index}`,
        value: normal(next),
      }));
      const result = await interval({
        implementationId: 'bootstrap.mean-percentile/v1',
        rows,
        simulation,
      });
      if (result.lower <= 0 && result.upper >= 0) covered += 1;
    }

    expect(covered / simulations).toBeGreaterThanOrEqual(0.8);
    expect(covered / simulations).toBeLessThanOrEqual(0.99);
  });

  it('keeps null paired effects from exceeding a broad type-I error bound', async () => {
    let falseDirections = 0;
    const simulations = 80;
    for (let simulation = 101; simulation < 101 + simulations; simulation += 1) {
      const next = generator(simulation);
      const rows = Array.from({ length: 24 }, (_, index) => {
        const baseline = normal(next);
        const difference = normal(next);
        const pairingBlockId = digestCanonicalJson({ simulation, pair: index });
        return [
          metricRow({
            sampleId: `sample-${index}`,
            targetId: 'control',
            value: baseline,
            pairingBlockId,
          }),
          metricRow({
            sampleId: `sample-${index}`,
            targetId: 'treatment',
            value: baseline + difference,
            pairingBlockId,
          }),
        ];
      }).flat();
      const result = await interval({
        implementationId: 'bootstrap.paired-difference-percentile/v1',
        rows,
        simulation,
        paired: true,
      });
      if (result.lower > 0 || result.upper < 0) falseDirections += 1;
    }

    expect(falseDirections / simulations).toBeLessThanOrEqual(0.2);
  });
});
