import assert from 'node:assert/strict';
import { z } from 'zod';
import { evaluate } from 'oh-my-knowledge/eval-runtime';

const executor = {
  executorId: 'example.faas-target/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ prompt: z.string() }).strict(),
    config: z.object({ retrievalRevision: z.string() }).strict(),
    output: z.string(),
  },
  outputClassification: 'public',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'required' },
  },
  fingerprintFacets: { deploymentRevision: 'target-1' },
  async execute({ signal }) {
    signal.throwIfAborted();
    return {
      output: 'Paris',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  },
};

const requests = [];
const judge = {
  judgeId: 'example.internal-model-gateway/v1',
  version: '1.0.0',
  providerCost: { reporting: 'optional' },
  fingerprintFacets: { gatewayRevision: 'judge-1' },
  async invoke(request) {
    requests.push(request);
    request.signal.throwIfAborted();
    return {
      invocationStatus: 'completed',
      output: '{"reasoning":"matched rubric","score":5,"reason":"Paris is stated"}',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        providerCost: { amount: 0.001, currency: 'USD', reportedByProvider: true },
      },
    };
  },
};

const base = {
  dataset: {
    datasetId: 'faas-rubric-example',
    samples: [{
      sampleId: 'capital',
      input: { prompt: 'What is the capital of France?' },
      expected: 'Paris',
    }],
  },
  variants: [{
    variantId: 'control',
    artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
    execution: { executor, config: { retrievalRevision: 'baseline' } },
  }, {
    variantId: 'treatment',
    artifact: {
      name: 'candidate',
      kind: 'prompt',
      source: 'inline',
      content: 'Answer using retrieved knowledge.',
    },
    execution: { executor, config: { retrievalRevision: 'candidate' } },
  }],
  comparisons: [{
    comparisonId: 'control-vs-treatment',
    controlVariantId: 'control',
    treatmentVariantIds: ['treatment'],
    metricIds: ['rubric-score'],
  }],
  analyses: [{
    analysisId: 'control-vs-treatment-rubric',
    analysisKind: 'comparison-interval', statistic: 'mean-difference',
    comparisonId: 'control-vs-treatment', treatmentVariantId: 'treatment',
    metricId: 'rubric-score',
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
  }],
  decision: {
    decisionKind: 'analysis',
    analysisId: 'control-vs-treatment-rubric',
  },
  experiment: { seed: 'explicit-seed', sampling: { samplingKind: 'paired' } },
  policy: {},
};

const evaluator = {
  evaluatorKind: 'rubric-judge',
  evaluatorId: 'rubric-judge',
  metricId: 'rubric-score',
  judges: [{
    memberId: 'primary',
    model: 'internal-judge-model',
    effort: 'low',
    replicateCount: 2,
    judge,
  }, {
    memberId: 'secondary',
    model: 'internal-judge-model-secondary',
    judge,
  }],
  aggregation: {
    method: 'weighted-mean',
    missing: 'require-complete',
    weights: { primary: 0.75, secondary: 0.25 },
  },
  rubric: {
    criterionId: 'correctness',
    prompt: 'What is the capital of France?',
    rubric: 'The output must state Paris.',
  },
  lengthDebias: true,
  tracePolicy: 'none',
};

const pending = evaluate({ ...base, evaluators: [evaluator], runId: 'embedded-faas-rubric' });
judge.invoke = async () => {
  throw new Error('evaluate must retain the Judge method captured at construction.');
};
const result = await pending;

assert.equal(result.status, 'completed', JSON.stringify(result));
assert.equal(result.definition.metrics[0].metricId, 'rubric-score');
assert.equal(requests.length, 6);
assert.equal(requests[0].model, 'internal-judge-model');
assert.equal(requests.filter((request) => request.model === 'internal-judge-model').length, 4);
assert.equal(requests.filter((request) => (
  request.model === 'internal-judge-model-secondary'
)).length, 2);
assert.ok(requests.every((request) => request.promptId === requests[0].promptId));
assert.ok(requests.every((request) => request.promptHash === requests[0].promptHash));
const observations = result.artifacts.evaluation.records.flatMap((record) => (
  record.evaluationStatus === 'completed' ? record.observations : []
));
assert.equal(observations.length, 6);
assert.ok(observations.every((observation) => (
  observation.observationStatus === 'observed' && observation.value === 5
)));

const failureResult = await evaluate({
  ...base,
  evaluators: [{
    ...evaluator,
    judges: evaluator.judges.map((member) => ({
      ...member,
      judge: {
        ...judge,
        async invoke() {
          return {
            invocationStatus: 'failed',
            reasonCode: 'gateway-private-failure',
            usage: {
              inputTokens: 7,
              providerCost: { amount: 0.002, currency: 'USD', reportedByProvider: true },
              details: { privateTenant: 'must-not-be-persisted' },
            },
          };
        },
      },
    })),
  }],
  runId: 'embedded-faas-rubric-failure',
});
assert.equal(failureResult.status, 'completed');
assert.ok(failureResult.artifacts.evaluation.records.every((record) => (
  record.evaluationStatus === 'failed'
  && record.error.code === 'judge-provider-failure'
  && record.usage.inputTokens === 7
  && record.usage.providerCost.amount === 0.002
)));
assert.ok(!JSON.stringify(failureResult).includes('privateTenant'));
assert.ok(!JSON.stringify(failureResult).includes('gateway-private-failure'));
