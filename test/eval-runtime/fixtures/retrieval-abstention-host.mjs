import assert from 'node:assert/strict';
import { z } from 'zod';
import { evaluate } from 'oh-my-knowledge';
// Import runs the single-file example through the installed public entry.
import { analyses, evaluators, forbiddenIdEvaluator, prepareRecommendationDataset } from './retrieval-abstention.mjs';

const positive = {
  sampleId: 'positive', input: { query: 'known' },
  expected: { shouldAbstain: false, acceptableSolutionIds: ['good'], forbiddenSolutionIds: ['bad'] },
  quality: { reviewStatus: 'reviewed' },
};
const pending = { ...positive, sampleId: 'pending', quality: { reviewStatus: 'pending_human_annotation' } };
const options = { sourceRevision: 'fixture/v1' };
assert.throws(() => prepareRecommendationDataset([positive, pending], options));
assert.throws(() => prepareRecommendationDataset([pending], { ...options, pendingPolicy: 'exclude' }));
assert.throws(() => prepareRecommendationDataset([], options));
assert.throws(() => prepareRecommendationDataset([positive, positive], options));
for (const expected of [
  { ...positive.expected, shouldAbstain: true },
  { ...positive.expected, acceptableSolutionIds: [] },
  { ...positive.expected, forbiddenSolutionIds: ['good'] },
  { ...positive.expected, acceptableSolutionIds: ['good', 'good'] },
  { ...positive.expected, acceptableSolutionIds: ['  '] },
  { ...positive.expected, shouldAbstain: 'false' },
]) {
  assert.throws(() => prepareRecommendationDataset([{ ...positive, expected }], options));
}
const source = [positive, pending, {
  ...positive, sampleId: 'unknown-label', expected: { ...positive.expected, shouldAbstain: null },
}];
const snapshot = JSON.stringify(source);
const prepared = prepareRecommendationDataset(source, { ...options, pendingPolicy: 'exclude' });
assert.equal(JSON.stringify(source), snapshot);
assert.deepEqual(prepared.audit.excluded.map((item) => item.sampleId), ['pending', 'unknown-label']);
assert.equal(prepared.audit.sourceSampleCount, 3);
assert.equal(prepared.dataset.samples.length, 1);
assert.deepEqual(prepared.dataset.samples[0].input, { query: 'known' });
assert.deepEqual(prepared.dataset.samples[0].analysis.memberships, [{ cohortId: 'answerable' }, { cohortId: 'has-forbidden' }]);

// Check the independent constraint's cutoff and population, not only the happy-path example.
const custom = forbiddenIdEvaluator(2);
const score = (ranking, forbidden = ['bad'], executionStatus = 'completed') => custom.implementation.evaluate({
  bindings: { ranking, forbidden, execution: { terminal: { executionStatus } } },
  parameters: custom.parameters, signal: new AbortController().signal,
});
assert.deepEqual(score(['good', 'bad']), { resultKind: 'score', value: true });
assert.deepEqual(score(['good', 'other', 'bad']), { resultKind: 'score', value: false });
assert.deepEqual(score(['BAD']), { resultKind: 'score', value: false });
assert.deepEqual(score([]), { resultKind: 'score', value: false });
assert.equal(score([], []).resultKind, 'missing');
assert.equal(score([], ['bad'], 'failed').resultKind, 'missing');
assert.throws(() => forbiddenIdEvaluator(0));

// Failures in another population must not contaminate this metric's coverage.
for (const failingQuery of ['positive', 'negative', 'no-forbidden']) {
  const dataset = prepareRecommendationDataset([
    { ...positive, input: { query: 'positive' } },
    { ...positive, sampleId: 'negative', input: { query: 'negative' },
      expected: { shouldAbstain: true, acceptableSolutionIds: [], forbiddenSolutionIds: ['bad'] } },
    { ...positive, sampleId: 'no-forbidden', input: { query: 'no-forbidden' },
      expected: { ...positive.expected, forbiddenSolutionIds: [] } },
  ], options).dataset;
  const result = await evaluate({
    dataset, evaluators, analyses, comparisons: [],
    variants: [{ variantId: 'candidate',
      artifact: { kind: 'workflow', name: 'fixture', source: 'inline', content: 'Recommend IDs.' },
      execution: { executor: {
        executorId: 'fixture.population-failure/v1', version: '1.0.0',
        fingerprintFacets: { failingQuery },
        capabilities: { determinism: 'deterministic', seedControl: 'unsupported' },
        schemas: { input: z.object({ query: z.string() }), output: z.object({ solutionIds: z.array(z.string()) }) },
        outputClassification: 'public',
        async execute({ input }) {
          return input.query === failingQuery ? { errorCode: 'fixture-failure' }
            : { output: { solutionIds: input.query === 'negative' ? [] : ['good'] } };
        },
      } },
    }],
    experiment: { seed: 'coverage-fixture', sampling: { samplingKind: 'solo' } },
    policy: { execution: { maxConcurrency: 1 }, evaluation: { maxConcurrency: 1 } },
  });
  assert.equal(result.status, 'completed');
  for (const [metricId, planned, failed] of [
    ['correct-abstention', 1, Number(failingQuery === 'negative')],
    ['false-abstention', 2, Number(failingQuery !== 'negative')],
    ['forbidden-hit', 2, Number(failingQuery !== 'no-forbidden')],
    ['recall-at-3', 2, Number(failingQuery !== 'negative')],
  ]) {
    const metric = result.analysisResults[metricId];
    assert.equal(metric.coverage.planned, planned, metricId);
    assert.equal(metric.coverage.sourceUnavailable, failed, metricId);
    assert.equal(metric.coverage.included, planned - failed, metricId);
    if (planned === failed) assert.equal(metric.analysisStatus, 'inconclusive');
    else assert.equal(metric.value, metricId === 'correct-abstention' || metricId === 'recall-at-3' ? 1 : 0);
  }
}
