import assert from 'node:assert/strict';
import { z } from 'zod';
import { evaluate } from 'oh-my-knowledge';

const answers = {
  control: { one: 'A', two: 'B', three: 'incorrect' },
  treatment: { one: 'A', two: 'B', three: 'C' },
};

const result = await evaluate({
  executor: {
    executorId: 'example.faas/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ prompt: z.string() }).strict(),
      config: z.object({ role: z.enum(['control', 'treatment']) }).strict(),
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
    fingerprintFacets: { deploymentRevision: 'example-1' },
    async execute({ input, config, signal }) {
      signal.throwIfAborted();
      return {
        output: answers[config.role][input.prompt],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  },
  dataset: {
    datasetId: 'faas-example',
    samples: [
      { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
      { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
      { sampleId: 'three', input: { prompt: 'three' }, expected: 'C' },
    ],
  },
  control: {
    variantId: 'control',
    artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
    config: { role: 'control' },
  },
  treatment: {
    variantId: 'treatment',
    artifact: {
      name: 'candidate',
      kind: 'prompt',
      source: 'inline',
      content: 'Answer exactly.',
    },
    config: { role: 'treatment' },
  },
  evaluator: { evaluatorKind: 'exact-match' },
  experiment: { seed: 'explicit-seed', bootstrap: { resamples: 100 } },
  policy: {},
  runId: 'embedded-faas',
});

assert.equal(result.status, 'completed', JSON.stringify(result));
assert.equal(result.definition.dataset.datasetId, 'faas-example');
assert.equal(Object.isFrozen(result.definition), true);
assert.equal(Object.isFrozen(result.policy), true);
assert.equal(result.artifacts.execution.records.length, 6);
assert.equal(result.definition.decisionPolicy.implementationId, 'progress/v2');
assert.equal(result.artifacts.analysis.records[0].value.estimate, 1 / 3);
assert.equal(result.artifacts.decision.decisionStatus, 'decided');
assert.equal(result.artifacts.decision.verdict, 'NOISE');
assert.equal(result.report.bundles.length, 3);
