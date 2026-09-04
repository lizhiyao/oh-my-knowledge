import { describe, expect, it } from 'vitest';
import {
  createBuiltinAnalysisNodes,
  type AnalysisMetricRow,
  type AnalysisNodeExecutionContext,
} from '../../../src/eval-core/analysis/index.js';
import { digestCanonicalJson, type Sha256Digest } from '../../../src/eval-core/contracts/index.js';

const ANALYSIS_NODES = createBuiltinAnalysisNodes();

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

function categorical(next: () => number, probabilities: readonly number[]): number {
  const draw = next();
  let cumulative = 0;
  for (const [index, probability] of probabilities.entries()) {
    cumulative += probability;
    if (draw < cumulative) return index + 1;
  }
  return probabilities.length;
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
    | 'bootstrap.paired-difference-percentile/v1'
    | 'bootstrap.unpaired-difference-percentile/v1';
  rows: AnalysisMetricRow[];
  simulation: number;
}): Promise<{ lower: number; upper: number; estimate: number; unitCount: number }> {
  const comparison = input.implementationId !== 'bootstrap.mean-percentile/v1';
  const paired = input.implementationId === 'bootstrap.paired-difference-percentile/v1';
  const implementation = ANALYSIS_NODES.get(input.implementationId);
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
        ...(comparison ? [{
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
    }, ...(comparison ? [{
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
      resamplingUnit: paired ? 'paired-block' : 'sample',
      estimatorId: input.implementationId,
      seedCoupling: 'shared-within-block',
      ...(paired ? { pairingKey: '/input/pair' } : {}),
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
  it('matches known mean, paired, and unpaired reference vectors', async () => {
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
    });
    const unpaired = await interval({
      implementationId: 'bootstrap.unpaired-difference-percentile/v1',
      simulation: 0,
      rows: [1, 2, 3, 4].map((value, index) => metricRow({
        sampleId: `control-${index}`,
        targetId: 'control',
        value,
      })).concat([3, 4, 5, 6].map((value, index) => metricRow({
        sampleId: `treatment-${index}`,
        targetId: 'treatment',
        value,
      }))),
    });

    expect(mean).toEqual({ lower: 1.5, upper: 3.25, estimate: 2.5, unitCount: 4 });
    expect(paired).toEqual({ lower: 1.5, upper: 3.5, estimate: 2.5, unitCount: 4 });
    expect(unpaired).toEqual({ lower: 0.75, upper: 3.5, estimate: 2, unitCount: 8 });
  });

  it('pins the deterministic continuous 90% mean-interval coverage profile', async () => {
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

    expect({ covered, simulations }).toEqual({ covered: 69, simulations: 80 });
  });

  it('pins the deterministic continuous null paired-effect profile', async () => {
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
      });
      if (result.lower > 0 || result.upper < 0) falseDirections += 1;
    }

    expect({ falseDirections, simulations }).toEqual({ falseDirections: 8, simulations: 80 });
  });

  it('pins the deterministic continuous null unpaired-effect profile', async () => {
    let falseDirections = 0;
    const simulations = 80;
    for (let simulation = 201; simulation < 201 + simulations; simulation += 1) {
      const next = generator(simulation);
      const rows = Array.from({ length: 24 }, (_, index) => metricRow({
        sampleId: `control-${index}`,
        targetId: 'control',
        value: normal(next),
      })).concat(Array.from({ length: 24 }, (_, index) => metricRow({
        sampleId: `treatment-${index}`,
        targetId: 'treatment',
        value: normal(next),
      })));
      const result = await interval({
        implementationId: 'bootstrap.unpaired-difference-percentile/v1',
        rows,
        simulation,
      });
      if (result.lower > 0 || result.upper < 0) falseDirections += 1;
    }

    expect({ falseDirections, simulations }).toEqual({ falseDirections: 12, simulations: 80 });
  });

  it('pins discrete 1-5 frequency profiles at N=8 and N=20 without claiming nominal calibration', async () => {
    const simulations = 60;
    const profiles = [
      {
        distribution: 'balanced',
        probabilities: [0.1, 0.2, 0.4, 0.2, 0.1],
        seedNamespace: 800_000,
      },
      {
        distribution: 'skewed',
        probabilities: [0.5, 0.25, 0.15, 0.07, 0.03],
        seedNamespace: 600_000,
      },
      {
        distribution: 'ceiling',
        probabilities: [0.02, 0.03, 0.1, 0.25, 0.6],
        seedNamespace: 700_000,
      },
    ] as const;
    const results: Array<{
      distribution: string;
      sampleSize: number;
      meanCovered: number;
      pairedFalseDirections: number;
    }> = [];

    for (const profile of profiles) {
      const populationMean = profile.probabilities.reduce((sum, probability, index) => (
        sum + probability * (index + 1)
      ), 0);
      for (const sampleSize of [8, 20]) {
        let meanCovered = 0;
        let pairedFalseDirections = 0;
        for (let simulation = 1; simulation <= simulations; simulation += 1) {
          const simulationId = profile.seedNamespace + sampleSize * 1_000 + simulation;
          const next = generator(simulationId);
          const scores = Array.from(
            { length: sampleSize },
            () => categorical(next, profile.probabilities),
          );
          const meanResult = await interval({
            implementationId: 'bootstrap.mean-percentile/v1',
            rows: scores.map((value, index) => metricRow({
              sampleId: `sample-${index}`,
              value,
            })),
            simulation: simulationId,
          });
          if (meanResult.lower <= populationMean && meanResult.upper >= populationMean) {
            meanCovered += 1;
          }

          const pairedRows = Array.from({ length: sampleSize }, (_, index) => {
            const pairingBlockId = digestCanonicalJson({
              simulation: simulationId,
              pair: index,
            });
            return [
              metricRow({
                sampleId: `sample-${index}`,
                targetId: 'control',
                value: categorical(next, profile.probabilities),
                pairingBlockId,
              }),
              metricRow({
                sampleId: `sample-${index}`,
                targetId: 'treatment',
                value: categorical(next, profile.probabilities),
                pairingBlockId,
              }),
            ];
          }).flat();
          const pairedResult = await interval({
            implementationId: 'bootstrap.paired-difference-percentile/v1',
            rows: pairedRows,
            simulation: simulationId,
          });
          if (pairedResult.lower > 0 || pairedResult.upper < 0) {
            pairedFalseDirections += 1;
          }
        }
        results.push({
          distribution: profile.distribution,
          sampleSize,
          meanCovered,
          pairedFalseDirections,
        });
      }
    }

    expect(results).toEqual([
      {
        distribution: 'balanced',
        sampleSize: 8,
        meanCovered: 48,
        pairedFalseDirections: 7,
      },
      {
        distribution: 'balanced',
        sampleSize: 20,
        meanCovered: 54,
        pairedFalseDirections: 5,
      },
      {
        distribution: 'skewed',
        sampleSize: 8,
        meanCovered: 52,
        pairedFalseDirections: 6,
      },
      {
        distribution: 'skewed',
        sampleSize: 20,
        meanCovered: 54,
        pairedFalseDirections: 13,
      },
      {
        distribution: 'ceiling',
        sampleSize: 8,
        meanCovered: 43,
        pairedFalseDirections: 8,
      },
      {
        distribution: 'ceiling',
        sampleSize: 20,
        meanCovered: 46,
        pairedFalseDirections: 9,
      },
    ]);
  });
});
