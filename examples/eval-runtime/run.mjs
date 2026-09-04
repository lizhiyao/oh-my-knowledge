import { z } from 'zod';
import { evaluate } from 'oh-my-knowledge/eval-runtime';

const answers = {
  baseline: { one: 'A', two: 'incorrect', three: 'incorrect' },
  candidate: { one: 'A', two: 'B', three: 'C' },
};

const result = await evaluate({
  executor: {
    executorId: 'example.answer-service/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ prompt: z.string() }).strict(),
      config: z.object({ deployment: z.enum(['baseline', 'candidate']) }).strict(),
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
        output: answers[config.deployment][input.prompt],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  },
  dataset: {
    datasetId: 'embedded-service-example',
    samples: [
      { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
      { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
      { sampleId: 'three', input: { prompt: 'three' }, expected: 'C' },
    ],
  },
  control: {
    variantId: 'baseline',
    artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
    config: { deployment: 'baseline' },
  },
  treatment: {
    variantId: 'candidate',
    artifact: {
      name: 'answer-prompt',
      kind: 'prompt',
      source: 'inline',
      content: 'Answer with the expected label.',
    },
    config: { deployment: 'candidate' },
  },
  evaluator: { evaluatorKind: 'exact-match' },
  experiment: { seed: 'explicit-example-seed', bootstrap: { resamples: 100 } },
  policy: { maxConcurrency: 2 },
  runId: 'eval-runtime-example',
});

if (result.status !== 'completed') throw new Error(result.error.code);

process.stdout.write(`${JSON.stringify({
  runStatus: result.status,
  estimate: result.artifacts.analysis.records[0].value.estimate,
  decisionStatus: result.artifacts.decision.decisionStatus,
  datasetId: result.definition.dataset.datasetId,
  reportId: result.report.reportId,
})}\n`);
