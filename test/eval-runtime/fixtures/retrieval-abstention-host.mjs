import assert from 'node:assert/strict';
// Import runs the single-file example through the installed public entry.
import { forbiddenIdEvaluator, prepareRecommendationDataset } from './retrieval-abstention.mjs';

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
assert.deepEqual(prepared.dataset.samples[0].analysis.memberships, [{ cohortId: 'answerable' }]);

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
