import assert from 'node:assert/strict';
import {
  createEvaluationEngine,
  createEvaluationRuntime,
  createExecutorFnAdapter,
  createInvokeExecutorIdentity,
  createMeasurementPolicy,
  createPairedComparisonDefinition,
  createRubricJudgeCriterion,
  createRubricJudgeEvaluatorDefinition,
  createRubricJudgeEvaluatorRegistration,
  createRubricJudgeInstrument,
  createRubricJudgeMetricDefinition,
  createRubricJudgeRuntimeConfig,
  createRuntimeIdentity,
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

const instrument = createRubricJudgeInstrument({ lengthDebias: true, tracePolicy: 'none' });
const judgeRuntime = createRubricJudgeRuntimeConfig({
  executorId: judgeIdentity.implementationId,
  model: 'internal-judge-model',
  effort: 'low',
  instrument,
});
const criterion = createRubricJudgeCriterion({
  criterionId: 'correctness',
  prompt: 'What is the capital of France?',
  rubric: 'The output must state Paris.',
});
const metricId = 'rubric-score';

const evaluator = createRubricJudgeEvaluatorDefinition({
  evaluatorId: 'rubric-judge',
  metricId,
  instrument,
  runtime: judgeRuntime,
  criterionPointer: '/rubricJudge',
});
const metric = createRubricJudgeMetricDefinition(metricId);
const definition = createPairedComparisonDefinition({
  datasetId: 'faas-rubric-example',
  seed: 'explicit-seed',
  samples: [{
    sampleId: 'capital',
    input: { prompt: 'What is the capital of France?' },
    expected: 'Paris',
    evaluationContext: { rubricJudge: criterion },
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
  evaluator,
  metric,
  bootstrap: { resamples: 100 },
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
const createTarget = () => createExecutorFnAdapter({
  identity: targetIdentity,
  executor: async ({ abortSignal }) => {
    abortSignal?.throwIfAborted();
    return {
      ok: true,
      output: 'Paris',
      durationMs: 1,
      durationApiMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      tokenUsageReportedByExecutor: true,
      costUSD: 0,
      costReportedByExecutor: false,
      stopReason: 'completed',
      numTurns: 1,
    };
  },
  outputClassification: 'public',
  mapInput: ({ input }) => ({ model: 'target-model', prompt: input.prompt }),
});
const runtime = createEvaluationRuntime({
  executors: [{ implementationId: targetIdentity.implementationId, createPort: createTarget }],
  evaluators: [createRubricJudgeEvaluatorRegistration([{
    evaluatorId: 'rubric-judge',
    instrument,
    runtime: judgeRuntime,
    invocation,
  }])],
});

const engine = createEvaluationEngine(runtime);
const prepared = await engine.prepare(definition, createMeasurementPolicy());
const run = prepared.start({ runId: 'embedded-faas-rubric', eventBufferCapacity: 128 });
const draining = (async () => {
  for await (const _event of run.events) { /* drain */ }
})();
const result = await run.result;
await draining;

assert.equal(result.status, 'completed', JSON.stringify(result));
assert.equal(requests.length, 2);
assert.equal(requests[0].promptId, instrument.promptId);
assert.equal(requests[0].promptHash, instrument.promptHash);
assert.equal(requests[0].model, judgeRuntime.model);
const observations = result.artifacts.evaluation.records.flatMap((record) => (
  record.evaluationStatus === 'completed' ? record.observations : []
));
assert.equal(observations.length, 2);
assert.ok(observations.every((observation) => (
  observation.observationStatus === 'observed'
  && observation.value === 5
  && observation.evidence.value.promptHash === instrument.promptHash
)));
assert.ok(result.artifacts.evaluation.records.every((record) => (
  record.evaluationStatus === 'completed' && record.usage.totalTokens === 15
)));
