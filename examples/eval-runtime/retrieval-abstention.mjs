import { z } from 'zod';
import { evaluate } from 'oh-my-knowledge';

const ids = z.array(z.string().refine((value) => value.trim().length > 0))
  .refine((values) => new Set(values).size === values.length);
const Row = z.object({
  sampleId: z.string().min(1),
  input: z.object({ query: z.string() }).strict(),
  expected: z.object({
    shouldAbstain: z.boolean().nullable(),
    acceptableSolutionIds: ids,
    forbiddenSolutionIds: ids,
  }).strict(),
  quality: z.object({ reviewStatus: z.enum(['reviewed', 'pending_human_annotation']) }).strict(),
}).strict();

// This example owns business labels and selection. It is not an OMK Runtime API.
export function prepareRecommendationDataset(source, { sourceRevision, pendingPolicy = 'error' }) {
  z.object({ sourceRevision: z.string().min(1), pendingPolicy: z.enum(['error', 'exclude']) })
    .parse({ sourceRevision, pendingPolicy });
  const rows = z.array(Row).parse(source);
  if (new Set(rows.map((row) => row.sampleId)).size !== rows.length) throw new Error('重复的样本 ID。');
  const excluded = [];
  const samples = [];
  for (const row of rows) {
    const { shouldAbstain, acceptableSolutionIds, forbiddenSolutionIds } = row.expected;
    if (row.quality.reviewStatus === 'pending_human_annotation' || shouldAbstain === null) {
      excluded.push({ sampleId: row.sampleId, reason: 'pending-human-annotation' });
      continue;
    }
    if ((shouldAbstain ? acceptableSolutionIds.length !== 0 : acceptableSolutionIds.length === 0)
        || acceptableSolutionIds.some((id) => forbiddenSolutionIds.includes(id))) {
      throw new Error(`样本 ${row.sampleId} 的标注冲突。`);
    }
    samples.push({
      sampleId: row.sampleId,
      input: row.input,
      expected: {
        shouldAbstain,
        // Empty Gold is invalid for retrieval v1; its analyses select only answerable samples.
        relevantDocumentIds: acceptableSolutionIds,
        forbiddenDocumentIds: forbiddenSolutionIds,
      },
      analysis: { memberships: [{ cohortId: shouldAbstain ? 'unanswerable' : 'answerable' }] },
    });
  }
  if (pendingPolicy === 'error' && excluded.length > 0) throw new Error('存在待人工标注样本；请完成标注或显式排除。');
  if (samples.length === 0) throw new Error('没有可评测的样本。');
  const audit = {
    sourceRevision, pendingPolicy, sourceSampleCount: rows.length,
    positiveCount: samples.filter((sample) => !sample.expected.shouldAbstain).length,
    abstentionCount: samples.filter((sample) => sample.expected.shouldAbstain).length,
    pendingCount: excluded.length, excluded,
  };
  return {
    dataset: {
      datasetId: 'synthetic-retrieval-abstention', samples,
      analysisCohorts: ['answerable', 'unanswerable'].map((cohortId) => ({
        cohortId, cohortSetId: 'answerability', cohortSetKind: 'cohort',
        classification: 'gold', disclosure: 'identity-only',
      })),
      annotations: { selection: audit },
    },
    audit,
  };
}

// An independent top-k constraint, composed through the existing CustomEvaluator contract.
export function forbiddenIdEvaluator(cutoff) {
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(cutoff);
  return {
    evaluatorKind: 'custom', evaluatorId: 'forbidden-hit', instrumentId: 'example.forbidden-hit/v1',
    metric: { metricId: 'forbidden-hit', valueType: 'boolean', direction: 'lower-is-better', missingPolicyId: 'exclude/v1' },
    bindings: [
      { bindingId: 'ranking', sourceKind: 'output', pointer: '/solutionIds' },
      { bindingId: 'forbidden', sourceKind: 'expected', pointer: '/forbiddenDocumentIds' },
      { bindingId: 'execution', sourceKind: 'execution-facts', pointer: '' },
    ],
    parameters: { cutoff },
    implementation: {
      implementationId: 'example.forbidden-id-hit/v1', version: '1.0.0',
      schemas: {
        bindings: z.object({ ranking: ids, forbidden: ids, execution: z.object({ terminal: z.object({ executionStatus: z.string() }).passthrough() }).passthrough() }).strict(),
        value: z.boolean(), fingerprintFacets: { protocol: 'unique-string-ids/v1' },
      },
      fingerprintFacets: { comparison: 'case-sensitive', emptyForbidden: 'not-applicable' },
      evaluate({ bindings, parameters, signal }) {
        signal.throwIfAborted();
        if (bindings.execution.terminal.executionStatus !== 'completed') return { resultKind: 'missing', reasonCode: 'execution-not-completed' };
        if (bindings.forbidden.length === 0) return { resultKind: 'missing', reasonCode: 'no-forbidden-annotation' };
        return {
          resultKind: 'score',
          value: bindings.ranking.slice(0, parameters.cutoff).some((id) => bindings.forbidden.includes(id)),
        };
      },
    },
  };
}

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
