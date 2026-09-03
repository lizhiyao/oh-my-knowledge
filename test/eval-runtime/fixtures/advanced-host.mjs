import assert from 'node:assert/strict';
import { createEvaluationEngine } from 'oh-my-knowledge/eval-core';
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createInvokeExecutorIdentity,
  createMeasurementPolicy,
} from 'oh-my-knowledge/eval-runtime';
import { createExecutorFnAdapter } from 'oh-my-knowledge/eval-runtime/advanced';

const identity = createInvokeExecutorIdentity({
  implementationId: 'example.staged-service/v1',
  version: '1.0.0',
  determinism: 'deterministic',
  cancellation: 'cooperative',
  concurrency: { safety: 'parallel-safe' },
  seedControl: 'unsupported',
  telemetry: { trace: 'unsupported', usage: 'required' },
  fingerprintFacets: { deploymentRevision: 'staged-example-1' },
});

const answers = {
  baseline: { one: 'A', two: 'incorrect', three: 'incorrect' },
  candidate: { one: 'A', two: 'B', three: 'C' },
};
const createExecutor = () => createExecutorFnAdapter({
  identity,
  outputClassification: 'public',
  mapInput: ({ targetConfig, input }) => ({
    model: targetConfig.deployment,
    prompt: input.prompt,
  }),
  executor: async ({ model, prompt, abortSignal }) => {
    abortSignal?.throwIfAborted();
    return {
      ok: true,
      output: answers[model][prompt],
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
});
const runtime = createEvaluationRuntime({
  executors: [{ implementationId: identity.implementationId, createPort: createExecutor }],
  evaluators: [{ port: createExactMatchEvaluator() }],
});
const definition = createExactMatchDefinition({
  datasetId: 'advanced-staged-host',
  seed: 'explicit-staged-seed',
  samples: [
    { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
    { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
    { sampleId: 'three', input: { prompt: 'three' }, expected: 'C' },
  ],
  control: {
    targetId: 'control',
    executorId: identity.implementationId,
    config: { deployment: 'baseline' },
  },
  treatment: {
    targetId: 'treatment',
    executorId: identity.implementationId,
    config: { deployment: 'candidate' },
  },
  bootstrap: { resamples: 100 },
});

const prepared = await createEvaluationEngine(runtime).prepare(
  definition,
  createMeasurementPolicy({ maxConcurrency: 2 }),
);
const stages = prepared.stages({ runId: 'advanced-staged-host', eventBufferCapacity: 128 });
try {
  const execution = await stages.execute().source;
  const evaluation = await stages.evaluate({ execution }).source;
  const analysis = await stages.analyze({ execution, evaluation }).source;
  const decision = await stages.decide({ execution, evaluation, analysis }).source;
  assert.notEqual(decision, undefined);
  const report = await stages.materializeReport({
    execution,
    evaluation,
    analysis,
    decision,
  }).result;

  assert.equal(execution.bundle.records.length, 6);
  assert.equal(evaluation.bundle.records.length, 6);
  assert.equal(analysis.bundle.records[0].analysisStatus, 'completed');
  assert.equal(analysis.bundle.records[0].value.estimate, 2 / 3);
  assert.equal(decision.result.decisionStatus, 'decided');
  assert.equal(report.status.runStatus, 'completed');
  assert.equal(report.bundles.length, 3);
} finally {
  await stages.close();
}
