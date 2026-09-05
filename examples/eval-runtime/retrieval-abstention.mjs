import { z } from 'zod';
import { createRetrievalAbstentionEvaluation, evaluate } from 'oh-my-knowledge';

// Synthetic data only. A platform adapter must carry review status into expected.
const evaluation = createRetrievalAbstentionEvaluation({
  dataset: {
    datasetId: 'synthetic-retrieval-abstention',
    samples: [{
      sampleId: 'positive',
      input: { query: 'known' },
      expected: {
        shouldAbstain: false,
        acceptableSolutionIds: ['solution-good'],
        forbiddenSolutionIds: ['solution-wrong'],
        reviewStatus: 'reviewed',
      },
    }, {
      sampleId: 'negative',
      input: { query: 'unknown' },
      expected: {
        shouldAbstain: true,
        acceptableSolutionIds: [],
        forbiddenSolutionIds: ['solution-wrong'],
        reviewStatus: 'reviewed',
      },
    }, {
      sampleId: 'pending',
      input: { query: 'needs-human-review' },
      expected: {
        shouldAbstain: true,
        acceptableSolutionIds: [],
        forbiddenSolutionIds: [],
        reviewStatus: 'pending_human_annotation',
      },
    }],
  },
  cutoff: 3,
  ranking: { source: 'output', pointer: '/solutionIds' },
  pendingPolicy: 'exclude', // Default is 'error'; exclusion is an explicit decision.
});

const executor = {
  executorId: 'example.abstention-retriever/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ query: z.string() }).strict(),
    output: z.object({ solutionIds: z.array(z.string()) }).strict(),
  },
  outputClassification: 'public',
  capabilities: { determinism: 'deterministic', seedControl: 'unsupported' },
  fingerprintFacets: { fixture: 'synthetic-retrieval-abstention/v1' },
  async execute({ input, signal }) {
    signal.throwIfAborted();
    return { output: { solutionIds: input.query === 'known' ? ['solution-good'] : [] } };
  },
};

const result = await evaluate({
  dataset: evaluation.dataset,
  evaluators: evaluation.evaluators,
  variants: [{
    variantId: 'candidate',
    artifact: { name: 'retriever', kind: 'workflow', source: 'inline', content: 'Retrieve applicable solutions.' },
    execution: { executor },
  }],
  comparisons: [],
  analyses: evaluation.evaluators.map(({ metric }) => ({
    analysisId: metric.metricId,
    analysisKind: 'summary',
    statistic: metric.valueType === 'numeric' ? 'mean' : 'rate',
    variantId: 'candidate',
    metricId: metric.metricId,
  })),
  experiment: { seed: 'synthetic-abstention-v1', sampling: { samplingKind: 'solo' } },
  policy: { execution: { maxConcurrency: 1 }, evaluation: { maxConcurrency: 1 } },
});

if (result.status !== 'completed') throw new Error(result.error.code);
// Keep coverage next to scores: failed/missing observations must never disappear in reporting.
console.log(JSON.stringify({
  audit: result.definition.dataset.annotations,
  metrics: Object.fromEntries(Object.entries(result.analysisResults).map(([id, record]) => [id, {
    status: record.analysisStatus,
    value: record.analysisStatus === 'completed' ? record.value : null,
    coverage: record.coverage,
  }])),
  executionCoverage: result.artifacts.execution.coverage,
}, null, 2));
