import { z } from 'zod';
import { evaluate } from 'oh-my-knowledge';
import { forbiddenIdEvaluator, prepareRecommendationDataset } from './retrieval-abstention-support.mjs';

// Synthetic, host-owned input. Gold and review status are never passed to the Target.
const source = [
  { sampleId: 'positive', input: { query: 'known' }, expected: {
    shouldAbstain: false, acceptableSolutionIds: ['solution-good'], forbiddenSolutionIds: ['solution-wrong'],
  }, quality: { reviewStatus: 'reviewed' } },
  { sampleId: 'negative', input: { query: 'unknown' }, expected: {
    shouldAbstain: true, acceptableSolutionIds: [], forbiddenSolutionIds: ['solution-wrong'],
  }, quality: { reviewStatus: 'reviewed' } },
  { sampleId: 'pending', input: { query: 'needs-human-review' }, expected: {
    shouldAbstain: true, acceptableSolutionIds: [], forbiddenSolutionIds: [],
  }, quality: { reviewStatus: 'pending_human_annotation' } },
];
const { dataset, audit } = prepareRecommendationDataset(source, {
  sourceRevision: 'synthetic/v1', pendingPolicy: 'exclude', // Default is error; exclusion is explicit.
});
const retrievalMetricIds = {
  recallAtK: 'recall-at-3', precisionAtK: 'precision-at-3', reciprocalRankAtK: 'rr-at-3', ndcgAtK: 'ndcg-at-3',
};
const evaluators = [{
  evaluatorKind: 'retrieval', evaluatorId: 'retrieval-quality', cutoff: 3,
  ranking: { source: 'output', pointer: '/solutionIds' },
  relevantDocumentIdsPointer: '/relevantDocumentIds', metricIds: retrievalMetricIds,
}, {
  evaluatorKind: 'abstention', evaluatorId: 'abstention',
  ranking: { source: 'output', pointer: '/solutionIds' },
  shouldAbstainPointer: '/shouldAbstain',
  metricIds: { abstentionCorrect: 'correct-abstention', falseAbstention: 'false-abstention' },
}, forbiddenIdEvaluator(3)];

const executor = {
  executorId: 'example.abstention-retriever/v1', version: '1.0.0',
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
  dataset, evaluators,
  variants: [{
    variantId: 'candidate',
    artifact: { name: 'retriever', kind: 'workflow', source: 'inline', content: 'Retrieve applicable solutions.' },
    execution: { executor },
  }],
  comparisons: [],
  analyses: [
    ...Object.values(retrievalMetricIds).map((metricId) => ({
      analysisId: metricId, analysisKind: 'summary', statistic: 'mean', variantId: 'candidate', metricId,
      cohortFilter: { includeCohortIds: ['answerable'] },
    })),
    ...['correct-abstention', 'false-abstention', 'forbidden-hit'].map((metricId) => ({
      analysisId: metricId, analysisKind: 'summary', statistic: 'rate', variantId: 'candidate', metricId,
    })),
  ],
  experiment: { seed: 'synthetic-abstention-v1', sampling: { samplingKind: 'solo' } },
  policy: { execution: { maxConcurrency: 1 }, evaluation: { maxConcurrency: 1 } },
});
if (result.status !== 'completed') throw new Error(result.error.code);
console.log(JSON.stringify({
  audit,
  metrics: Object.fromEntries(Object.entries(result.analysisResults).map(([id, record]) => [id, {
    status: record.analysisStatus,
    value: record.analysisStatus === 'completed' ? record.value : null,
    coverage: record.coverage,
  }])),
  executionCoverage: result.artifacts.execution.coverage,
}, null, 2));
