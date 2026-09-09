import { z } from 'zod';
import { evaluate } from 'oh-my-knowledge';

const answers = {
  baseline: { '法国的首都是哪里？': '巴黎', '英国的首都是哪里？': '伦敦', '日本的首都是哪里？': '京都' },
  candidate: { '法国的首都是哪里？': '巴黎', '英国的首都是哪里？': '伦敦', '日本的首都是哪里？': '东京' },
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
      { sampleId: 'one', input: { prompt: '法国的首都是哪里？' }, expected: '巴黎' },
      { sampleId: 'two', input: { prompt: '英国的首都是哪里？' }, expected: '伦敦' },
      { sampleId: 'three', input: { prompt: '日本的首都是哪里？' }, expected: '东京' },
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
    controlVariantId: 'baseline',
    treatmentVariantIds: ['candidate'],
    metricIds: ['correct'],
  }],
  analyses: [{
    analysisId: 'baseline-vs-candidate-correct',
    analysisKind: 'comparison-interval',
    statistic: 'mean-difference',
    comparisonId: 'baseline-vs-candidate',
    treatmentVariantId: 'candidate',
    metricId: 'correct',
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
  }],
  decision: {
    decisionKind: 'analysis',
    analysisId: 'baseline-vs-candidate-correct',
  },
  experiment: { seed: 'explicit-example-seed', sampling: { samplingKind: 'paired' } },
  policy: {
    execution: { maxConcurrency: 2 },
    evaluation: { maxConcurrency: 2 },
  },
}, {
  runId: 'eval-runtime-example',
});

if (result.status !== 'completed') throw new Error(result.error.code);

process.stdout.write(`${JSON.stringify({
  runId: result.runId,
  runStatus: result.status,
  estimate: result.artifacts.analysis.records[0].value.estimate,
  decisionStatus: result.artifacts.decision.decisionStatus,
  verdict: result.artifacts.decision.verdict,
  datasetId: result.definition.dataset.datasetId,
  reportId: result.report.reportId,
})}\n`);
