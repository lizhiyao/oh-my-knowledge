import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  assessComparability,
  evaluate,
  loadEvaluationResult,
  prepareEvaluation,
  reanalyze,
  redecide,
  rescore,
  saveEvaluationResult,
} from 'oh-my-knowledge';

let targetInvocations = 0;
const executor = {
  executorId: 'clean-room.stage-reuse/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ prompt: z.string() }).strict(),
    config: z.object({ answers: z.record(z.string(), z.string()) }).strict(),
    output: z.string(),
  },
  outputClassification: 'public',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  fingerprintFacets: { deploymentRevision: 'clean-room-one' },
  async execute({ input, config, signal }) {
    targetInvocations += 1;
    signal.throwIfAborted();
    return { output: config.answers[input.prompt] };
  },
};

function declaration() {
  return {
    dataset: {
      datasetId: 'stage-reuse-dataset',
      samples: [
        { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
        { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
      ],
    },
    variants: [{
      variantId: 'baseline',
      artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
      execution: { executor, config: { answers: { one: 'A', two: 'wrong' } } },
    }, {
      variantId: 'candidate',
      artifact: { name: 'candidate', kind: 'prompt', source: 'inline', content: 'Answer.' },
      execution: { executor, config: { answers: { one: 'A', two: 'B' } } },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' }],
    comparisons: [{
      comparisonId: 'baseline-vs-candidate',
      controlVariantId: 'baseline',
      treatmentVariantIds: ['candidate'],
      metricIds: ['correct'],
    }],
    analyses: [{
      analysisId: 'correct-difference',
      analysisKind: 'comparison-interval',
      statistic: 'mean-difference',
      comparisonId: 'baseline-vs-candidate',
      treatmentVariantId: 'candidate',
      metricId: 'correct',
      confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
    }],
    decision: { decisionKind: 'analysis', analysisId: 'correct-difference' },
    experiment: { seed: 'stage-reuse-seed', sampling: { samplingKind: 'paired' } },
    policy: {
      execution: { maxConcurrency: 2 },
      evaluation: { maxConcurrency: 2 },
    },
  };
}

const sourceInput = declaration();
const source = await evaluate(sourceInput, { runId: 'stage-reuse-source' });
assert.equal(source.status, 'completed');
assert.equal(targetInvocations, 4);

const storedResults = new Map();
const resultStore = {
  async put(request) {
    storedResults.set(request.digest, JSON.stringify({
      value: request.value,
      classification: request.classification,
      mediaType: request.mediaType,
    }));
    return { digest: request.digest, mediaType: request.mediaType };
  },
};
const resultReference = await saveEvaluationResult({ result: source, store: resultStore });
const trustedReceipt = Object.freeze({
  verifiedProvenanceBundleDigests: Object.freeze([
    source.artifacts.execution.bundleDigest,
    source.artifacts.evaluation.bundleDigest,
    source.artifacts.analysis.bundleDigest,
  ]),
  verifiedCacheRecordDigests: Object.freeze([]),
  verifiedPolicyExecutionDigests: Object.freeze([
    source.artifacts.decision.decisionDigest,
  ]),
});
await assert.rejects(
  loadEvaluationResult({
    prepared: await prepareEvaluation(declaration()),
    reference: JSON.parse(JSON.stringify(resultReference)),
    resolver: {
      async resolve(reference) {
        return JSON.parse(storedResults.get(reference.digest));
      },
    },
    verifier: {
      verifierId: 'clean-room.incomplete-result-authority/v1',
      async verify({ reference }) {
        return {
          verifiedResultDigest: reference.digest,
          attestationDigest: `sha256:${createHash('sha256')
            .update(`incomplete-result:${reference.digest}`)
            .digest('hex')}`,
          verifiedProvenanceBundleDigests: [],
          verifiedCacheRecordDigests: [],
          verifiedPolicyExecutionDigests: [],
        };
      },
    },
  }),
  (error) => error?.code === 'EVAL_RUNTIME_RESULT_CONTENT_INVALID',
);
const restoredSource = await loadEvaluationResult({
  prepared: await prepareEvaluation(declaration()),
  reference: JSON.parse(JSON.stringify(resultReference)),
  resolver: {
    async resolve(reference) {
      return JSON.parse(storedResults.get(reference.digest));
    },
  },
  verifier: {
    verifierId: 'clean-room.result-authority/v1',
    async verify({ reference }) {
      assert.ok(storedResults.has(reference.digest));
      return {
        verifiedResultDigest: reference.digest,
        attestationDigest: `sha256:${createHash('sha256')
          .update(`trusted-result:${reference.digest}`)
          .digest('hex')}`,
        ...trustedReceipt,
      };
    },
  },
});
assert.deepEqual(restoredSource, source);
assert.notEqual(restoredSource, source);
assert.equal(assessComparability({
  comparisonScope: 'decision',
  subjects: [{
    subjectId: 'restored-candidate',
    leftVariantId: 'candidate',
    rightVariantId: 'candidate',
  }],
  left: source,
  right: restoredSource,
}).designStatus, 'compatible');

const rescoreInput = declaration();
rescoreInput.dataset.samples[0].expected = 'wrong';
const rescored = await rescore(rescoreInput, restoredSource, { runId: 'stage-reuse-rescored' });
assert.equal(targetInvocations, 4);
assert.equal(rescored.artifacts.execution, restoredSource.artifacts.execution);
assert.notEqual(
  rescored.artifacts.evaluation.bundleDigest,
  restoredSource.artifacts.evaluation.bundleDigest,
);

const reanalyzeInput = declaration();
reanalyzeInput.dataset.samples[0].expected = 'wrong';
reanalyzeInput.analyses[0].confidence.resamples = 200;
const reanalyzed = await reanalyze(reanalyzeInput, rescored, {
  runId: 'stage-reuse-reanalyzed',
});
assert.equal(targetInvocations, 4);
assert.equal(reanalyzed.artifacts.execution, rescored.artifacts.execution);
assert.equal(reanalyzed.artifacts.evaluation, rescored.artifacts.evaluation);
assert.notEqual(reanalyzed.artifacts.analysis.bundleDigest, rescored.artifacts.analysis.bundleDigest);

const redecideInput = declaration();
redecideInput.dataset.samples[0].expected = 'wrong';
redecideInput.analyses[0].confidence.resamples = 200;
redecideInput.decision.threshold = 0.75;
const redecided = await redecide(redecideInput, reanalyzed, {
  runId: 'stage-reuse-redecided',
});
assert.equal(targetInvocations, 4);
assert.equal(redecided.artifacts.execution, reanalyzed.artifacts.execution);
assert.equal(redecided.artifacts.evaluation, reanalyzed.artifacts.evaluation);
assert.equal(redecided.artifacts.analysis, reanalyzed.artifacts.analysis);
assert.notEqual(
  redecided.artifacts.decision.decisionDigest,
  reanalyzed.artifacts.decision.decisionDigest,
);

await assert.rejects(
  rescore(rescoreInput, structuredClone(source), { runId: 'stage-reuse-clone' }),
  (error) => error?.code === 'EVAL_RUNTIME_REUSE_INVALID',
);
