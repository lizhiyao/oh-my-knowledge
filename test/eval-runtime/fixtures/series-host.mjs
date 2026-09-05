import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  evaluateSeries as evaluateSeriesFromRoot,
  prepareEvaluationSeries,
} from 'oh-my-knowledge';
import {
  evaluateSeries as evaluateSeriesFromSubpath,
} from 'oh-my-knowledge/eval-runtime';

assert.equal(evaluateSeriesFromRoot, evaluateSeriesFromSubpath);

const outputs = ['A', 'B', 'A'];
let targetInvocations = 0;
const executor = {
  executorId: 'clean-room.series/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ question: z.string() }).strict(),
    config: z.object({}).strict(),
    output: z.string(),
  },
  outputClassification: 'public',
  capabilities: {
    determinism: 'stochastic',
    cancellation: 'cooperative',
    concurrency: { safety: 'serialized' },
    seedControl: 'optional',
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  fingerprintFacets: { deploymentRevision: 'clean-room-series-one' },
  async execute({ signal }) {
    signal.throwIfAborted();
    const output = outputs[targetInvocations];
    targetInvocations += 1;
    return { output };
  },
};

const prepared = await prepareEvaluationSeries({
  evaluation: {
    dataset: {
      datasetId: 'series-dataset',
      samples: [{ sampleId: 'one', input: { question: 'one' }, expected: 'A' }],
    },
    variants: [{
      variantId: 'candidate',
      artifact: {
        name: 'candidate',
        kind: 'prompt',
        source: 'inline',
        content: 'Answer exactly.',
      },
      execution: { executor, config: {} },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' }],
    comparisons: [],
    analyses: [{
      analysisId: 'candidate-correct-rate',
      analysisKind: 'summary',
      statistic: 'rate',
      variantId: 'candidate',
      metricId: 'correct',
    }],
    experiment: {
      seed: 'series-fixed-seed',
      sampling: { samplingKind: 'solo' },
    },
    policy: {
      cache: { execution: 'disabled', evaluation: 'disabled' },
    },
  },
  seriesInstanceId: 'clean-room-repeatability',
  repeatCount: 3,
  stability: {
    sourceAnalysisId: 'candidate-correct-rate',
    projection: 'scalar',
  },
});

assert.equal(targetInvocations, 0);
assert.equal(prepared.memberPlans.length, 3);
assert.equal(new Set(prepared.memberPlans.map(
  (plan) => plan.digests.runContractDigest,
)).size, 3);
const result = await prepared.run();
assert.equal(result.status, 'completed', JSON.stringify(result));
assert.equal(targetInvocations, 3);
assert.equal(result.analysis.coverage.planned, 3);
assert.equal(result.analysis.coverage.comparable, 3);
assert.equal(result.stability.analysisStatus, 'completed');
assert.equal(result.stability.value.experimentalUnit, 'run');
assert.equal(result.stability.value.runCount, 3);
assert.equal(result.stability.value.mean, 2 / 3);
assert.ok(Math.abs(result.stability.value.sampleVariance - (1 / 3)) < 1e-12);
assert.equal(result.decision, undefined);
