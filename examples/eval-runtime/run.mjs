import { z } from 'zod';
import { evaluate } from 'oh-my-knowledge';

const answers = {
  baseline: { one: 'A', two: 'B', three: 'incorrect' },
  candidate: { one: 'A', two: 'B', three: 'C' },
};

const executor = {
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
};

const result = await evaluate({
  dataset: {
    datasetId: 'embedded-service-example',
    samples: [
      { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
      { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
      { sampleId: 'three', input: { prompt: 'three' }, expected: 'C' },
    ],
  },
  variants: [{
    variantId: 'baseline',
    artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
    execution: { executor, config: { deployment: 'baseline' } },
  }, {
    variantId: 'candidate',
    artifact: {
      name: 'answer-prompt',
      kind: 'prompt',
      source: 'inline',
      content: 'Answer with the expected label.',
    },
    execution: { executor, config: { deployment: 'candidate' } },
  }],
  evaluators: [{ evaluatorKind: 'exact-match' }],
  comparisons: [{
    comparisonId: 'baseline-vs-candidate',
    comparisonKind: 'paired',
    controlVariantId: 'baseline',
    treatmentVariantIds: ['candidate'],
    metricIds: ['correct'],
  }],
  analysis: { bootstrap: { resamples: 100 } },
  decision: {
    decisionKind: 'comparison',
    comparisonId: 'baseline-vs-candidate',
    treatmentVariantId: 'candidate',
    metricId: 'correct',
  },
  experiment: { seed: 'explicit-example-seed', sampling: { samplingKind: 'paired' } },
  policy: { maxConcurrency: 2 },
  runId: 'eval-runtime-example',
});

if (result.status !== 'completed') throw new Error(result.error.code);

process.stdout.write(`${JSON.stringify({
  runStatus: result.status,
  estimate: result.artifacts.analysis.records[0].value.estimate,
  decisionStatus: result.artifacts.decision.decisionStatus,
  verdict: result.artifacts.decision.verdict,
  datasetId: result.definition.dataset.datasetId,
  reportId: result.report.reportId,
})}\n`);
