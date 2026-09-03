import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  createEvaluationEngine,
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createInvokeExecutorIdentity,
  createJsonExecutorAdapter,
  createMeasurementPolicy,
} from 'oh-my-knowledge/eval-runtime';

const identity = createInvokeExecutorIdentity({
  implementationId: 'example.faas/v1',
  version: '1.0.0',
  determinism: 'deterministic',
  cancellation: 'cooperative',
  concurrency: { safety: 'parallel-safe' },
  seedControl: 'unsupported',
  telemetry: { trace: 'unsupported', usage: 'required' },
  fingerprintFacets: { deploymentRevision: 'example-1' },
});

const answers = {
  control: { one: 'A', two: 'incorrect', three: 'incorrect' },
  treatment: { one: 'A', two: 'B', three: 'C' },
};
const createExecutor = () => createJsonExecutorAdapter({
  identity,
  inputParser: z.object({ prompt: z.string() }).strict(),
  targetConfigParser: z.undefined(),
  outputParser: z.string(),
  outputClassification: 'public',
  async invoke({ targetId, input, signal }) {
    signal.throwIfAborted();
    return {
      invocationStatus: 'completed',
      output: answers[targetId][input.prompt],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  },
});
const runtime = createEvaluationRuntime({
  executors: [{ implementationId: identity.implementationId, createPort: createExecutor }],
  evaluators: [{ port: createExactMatchEvaluator() }],
});
const definition = createExactMatchDefinition({
  datasetId: 'faas-example',
  seed: 'explicit-seed',
  samples: [
    { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
    { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
    { sampleId: 'three', input: { prompt: 'three' }, expected: 'C' },
  ],
  control: { targetId: 'control', executorId: identity.implementationId },
  treatment: { targetId: 'treatment', executorId: identity.implementationId },
  bootstrap: { resamples: 100 },
});
const engine = createEvaluationEngine(runtime);
const prepared = await engine.prepare(definition, createMeasurementPolicy());
const repeated = await engine.prepare(
  structuredClone(definition),
  createMeasurementPolicy(),
);
assert.equal(
  prepared.plan.digests.runContractDigest,
  repeated.plan.digests.runContractDigest,
);

const run = prepared.start({ runId: 'embedded-faas', eventBufferCapacity: 128 });
const draining = (async () => {
  for await (const _event of run.events) { /* drain */ }
})();
const result = await run.result;
await draining;
assert.equal(result.status, 'completed', JSON.stringify(result));
assert.equal(result.artifacts.execution.records.length, 6);
assert.equal(result.artifacts.analysis.records[0].value.estimate, 2 / 3);
assert.equal(result.artifacts.decision.decisionStatus, 'decided');
assert.equal(result.report.bundles.length, 3);
