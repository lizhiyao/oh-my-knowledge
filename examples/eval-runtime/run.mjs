import { z } from 'zod';
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createInvokeExecutorIdentity,
  createJsonExecutorAdapter,
  createMeasurementPolicy,
  runEvaluation,
} from 'oh-my-knowledge/eval-runtime';

const identity = createInvokeExecutorIdentity({
  implementationId: 'example.answer-service/v1',
  version: '1.0.0',
  determinism: 'deterministic',
  cancellation: 'cooperative',
  concurrency: { safety: 'parallel-safe' },
  seedControl: 'unsupported',
  telemetry: { trace: 'unsupported', usage: 'required' },
  fingerprintFacets: { deploymentRevision: 'example-1' },
});

const answers = {
  baseline: { one: 'A', two: 'incorrect', three: 'incorrect' },
  candidate: { one: 'A', two: 'B', three: 'C' },
};
const createExecutor = () => createJsonExecutorAdapter({
  identity,
  inputParser: z.object({ prompt: z.string() }).strict(),
  targetConfigParser: z.object({ deployment: z.string() }).strict(),
  outputParser: z.string(),
  outputClassification: 'public',
  async invoke({ input, targetConfig, signal }) {
    signal.throwIfAborted();
    return {
      invocationStatus: 'completed',
      output: answers[targetConfig.deployment][input.prompt],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  },
});

const runtime = createEvaluationRuntime({
  executors: [{ implementationId: identity.implementationId, createPort: createExecutor }],
  evaluators: [{ port: createExactMatchEvaluator() }],
});
const definition = createExactMatchDefinition({
  datasetId: 'embedded-service-example',
  seed: 'explicit-example-seed',
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

const result = await runEvaluation({
  runtime,
  definition,
  policy: createMeasurementPolicy({ maxConcurrency: 2 }),
  runId: 'eval-runtime-example',
});
if (result.status !== 'completed') throw new Error(result.error.code);

process.stdout.write(`${JSON.stringify({
  runStatus: result.status,
  estimate: result.artifacts.analysis.records[0].value.estimate,
  decisionStatus: result.artifacts.decision.decisionStatus,
  reportId: result.report.reportId,
})}\n`);
