import assert from 'node:assert/strict';
import { z } from 'zod';
import { evaluate, reanalyze, redecide, rescore } from 'oh-my-knowledge';

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

const rescoreInput = declaration();
rescoreInput.dataset.samples[0].expected = 'wrong';
const rescored = await rescore(rescoreInput, source, { runId: 'stage-reuse-rescored' });
assert.equal(targetInvocations, 4);
assert.equal(rescored.artifacts.execution, source.artifacts.execution);
assert.notEqual(rescored.artifacts.evaluation.bundleDigest, source.artifacts.evaluation.bundleDigest);

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
