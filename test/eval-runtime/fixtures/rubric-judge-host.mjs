import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  createEvaluationRuntime,
  createInvokeExecutorIdentity,
  createJsonExecutorAdapter,
  createMeasurementPolicy,
  createPairedComparisonDefinition,
  createRubricJudgeKit,
  createRuntimeIdentity,
  runEvaluation,
} from 'oh-my-knowledge/eval-runtime';

const targetIdentity = createInvokeExecutorIdentity({
  implementationId: 'example.faas-target/v1',
  version: '1.0.0',
  determinism: 'deterministic',
  cancellation: 'cooperative',
  concurrency: { safety: 'parallel-safe' },
  seedControl: 'unsupported',
  telemetry: { trace: 'unsupported', usage: 'required' },
  fingerprintFacets: { deploymentRevision: 'target-1' },
});
const judgeIdentity = createRuntimeIdentity({
  implementationId: 'example.internal-model-gateway/v1',
  version: '1.0.0',
  capabilities: { invocation: 'single-call', cancellation: 'cooperative' },
  fingerprintFacets: { gatewayRevision: 'judge-1' },
});

const requests = [];
const invocation = {
  identity: judgeIdentity,
  providerCost: { reporting: 'optional' },
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
const judge = createRubricJudgeKit({
  evaluatorId: 'rubric-judge',
  metricId: 'rubric-score',
  model: 'internal-judge-model',
  effort: 'low',
  invocation,
  lengthDebias: true,
  tracePolicy: 'none',
});
const criterion = judge.createCriterion({
  criterionId: 'correctness',
  prompt: 'What is the capital of France?',
  rubric: 'The output must state Paris.',
});
const definition = createPairedComparisonDefinition({
  datasetId: 'faas-rubric-example',
  seed: 'explicit-seed',
  samples: [{
    sampleId: 'capital',
    input: { prompt: 'What is the capital of France?' },
    expected: 'Paris',
    evaluationContext: judge.createEvaluationContext(criterion),
  }],
  control: {
    targetId: 'control',
    targetKind: 'rag',
    executorId: targetIdentity.implementationId,
    config: { retrievalRevision: 'baseline' },
  },
  treatment: {
    targetId: 'treatment',
    targetKind: 'rag',
    executorId: targetIdentity.implementationId,
    config: { retrievalRevision: 'candidate' },
  },
  evaluator: judge.evaluatorDefinition,
  metric: judge.metricDefinition,
  bootstrap: { resamples: 100 },
});

invocation.invoke = async () => {
  throw new Error('The kit must retain the invocation method captured at construction.');
};
const createTarget = () => createJsonExecutorAdapter({
  identity: targetIdentity,
  inputParser: z.object({ prompt: z.string() }).strict(),
  targetConfigParser: z.object({ retrievalRevision: z.string() }).strict(),
  outputParser: z.string(),
  outputClassification: 'public',
  async invoke({ signal }) {
    signal.throwIfAborted();
    return {
      invocationStatus: 'completed',
      output: 'Paris',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  },
});
const runtime = createEvaluationRuntime({
  executors: [{ implementationId: targetIdentity.implementationId, createPort: createTarget }],
  evaluators: [judge.evaluatorRegistration],
});

const result = await runEvaluation({
  runtime,
  definition,
  policy: createMeasurementPolicy(),
  runId: 'embedded-faas-rubric',
});

assert.equal(result.status, 'completed', JSON.stringify(result));
assert.equal(requests.length, 2);
assert.equal(requests[0].promptId, judge.instrument.promptId);
assert.equal(requests[0].promptHash, judge.instrument.promptHash);
assert.equal(requests[0].model, judge.runtime.model);
const observations = result.artifacts.evaluation.records.flatMap((record) => (
  record.evaluationStatus === 'completed' ? record.observations : []
));
assert.equal(observations.length, 2);
assert.ok(observations.every((observation) => (
  observation.observationStatus === 'observed'
  && observation.value === 5
  && observation.evidence.value.promptHash === judge.instrument.promptHash
)));
assert.ok(result.artifacts.evaluation.records.every((record) => (
  record.evaluationStatus === 'completed' && record.usage.totalTokens === 15
)));

const failingJudge = createRubricJudgeKit({
  evaluatorId: 'rubric-judge',
  metricId: 'rubric-score',
  model: 'internal-judge-model',
  effort: 'low',
  invocation: {
    identity: judgeIdentity,
    providerCost: { reporting: 'optional' },
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
  lengthDebias: true,
  tracePolicy: 'none',
});
const failureResult = await runEvaluation({
  runtime: createEvaluationRuntime({
    executors: [{ implementationId: targetIdentity.implementationId, createPort: createTarget }],
    evaluators: [failingJudge.evaluatorRegistration],
  }),
  definition,
  policy: createMeasurementPolicy(),
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
