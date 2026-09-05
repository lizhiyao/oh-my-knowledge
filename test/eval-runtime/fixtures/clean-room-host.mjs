import assert from 'node:assert/strict';
import { setImmediate as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  EvaluationEventConsumptionError,
  checkExecutor,
  evaluate,
  prepareEvaluation,
} from 'oh-my-knowledge/eval-runtime';

const retryAttempts = [];
const executor = {
  executorId: 'clean-room.json-host/v1',
  version: '1.0.0',
  schemas: { input: z.string(), config: z.undefined(), output: z.string() },
  outputClassification: 'public',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: {
      trace: 'unsupported',
      usage: 'required',
      providerCost: { reporting: 'optional' },
    },
  },
  fingerprintFacets: { revision: 'clean-room-one' },
  async execute({ input, attemptNumber, signal }) {
    if (input === 'retry') {
      retryAttempts.push(attemptNumber);
      if (attemptNumber === 1) {
        return { errorCode: 'clean-room-retryable', usage: { inputTokens: 1 } };
      }
    }
    if (input === 'failure') {
      return { errorCode: 'clean-room-expected-failure', usage: { inputTokens: 1 } };
    }
    if (input === 'cancellation') {
      await new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
    return {
      output: 'expected',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        providerCost: { amount: 0.001, currency: 'USD', reportedByProvider: true },
      },
    };
  },
};

const variant = {
  variantId: 'prompt-v2',
  artifact: {
    name: 'prompt-v2',
    kind: 'prompt',
    source: 'inline',
    content: 'Return expected.',
  },
  execution: { executor },
};

const evaluationInput = (overrides = {}) => ({
  dataset: {
    datasetId: 'clean-room-runner',
    samples: ['one', 'two'].map((sampleId) => ({
      sampleId,
      input: 'success',
      expected: 'expected',
    })),
  },
  variants: [{
    variantId: 'baseline',
    artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
    execution: { executor },
  }, variant],
  evaluators: [{ evaluatorKind: 'exact-match' }],
  comparisons: [{
    comparisonId: 'baseline-vs-prompt-v2',
    controlVariantId: 'baseline',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correct'],
  }],
  analyses: [{
    analysisId: 'baseline-vs-prompt-v2-correct',
    analysisKind: 'comparison-interval', statistic: 'mean-difference',
    comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
    metricId: 'correct',
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
  }],
  decision: {
    decisionKind: 'analysis',
    analysisId: 'baseline-vs-prompt-v2-correct',
  },
  experiment: { seed: 'clean-room-seed', sampling: { samplingKind: 'paired' } },
  policy: {
    execution: { maxConcurrency: 1 },
    evaluation: { maxConcurrency: 1 },
    budget: {
      run: { maxInvocations: 50, maxWallClockMs: 60_000 },
      execution: {
        maxActiveDurationMs: 30_000,
        maxProviderCost: { amount: 0.01, currency: 'USD' },
      },
      coordinate: { maxInvocations: 4 },
      onUnreportedProviderCost: 'fail-run',
    },
  },
  ...overrides,
});

const evaluation = (overrides = {}, options = {}) => evaluate(
  evaluationInput(overrides),
  { runId: 'clean-room-evaluate', ...options },
);

let preparedTargetCalls = 0;
const preparationInput = evaluationInput({
  variants: evaluationInput().variants.map((candidate) => ({
    ...candidate,
    execution: {
      executor: {
        ...candidate.execution.executor,
        async execute(invocation) {
          preparedTargetCalls += 1;
          return candidate.execution.executor.execute(invocation);
        },
      },
    },
  })),
});
const prepared = await prepareEvaluation(preparationInput);
assert.equal(preparedTargetCalls, 0);
assert.ok(Object.isFrozen(prepared.plan));
assert.equal(prepared.planDigest, prepared.plan.digests.runContractDigest);
assert.equal(prepared.estimatedWork.executionCoordinates, 4);
assert.equal(prepared.estimatedWork.evaluationCoordinates, 4);
assert.equal(prepared.estimatedWork.plannedInvocations, 8);
assert.deepEqual(
  new Set(prepared.resolvedRuntimes.map(({ runtimeKind }) => runtimeKind)),
  new Set(['executor', 'evaluator', 'analysis-node', 'missing-policy', 'decision-policy']),
);

preparationInput.dataset.samples[0].input = 'changed-after-prepare';
const preparedResult = await prepared.run({ runId: 'clean-room-prepared' });
assert.equal(preparedResult.status, 'completed');
assert.equal(preparedResult.runId, 'clean-room-prepared');
assert.equal(preparedTargetCalls, 4);
assert.equal(preparedResult.definition.dataset.samples[0].input, 'success');

const withoutObserver = await evaluation();
assert.equal(withoutObserver.status, 'completed');
assert.equal(withoutObserver.runId, 'clean-room-evaluate');
assert.equal(withoutObserver.definition.dataset.datasetId, 'clean-room-runner');
assert.deepEqual(withoutObserver.policy.budget.run, {
  maxInvocations: 50,
  maxWallClockMs: 60_000,
});
assert.deepEqual(withoutObserver.policy.budget.stages.execution, {
  maxActiveDurationMs: 30_000,
  maxProviderCost: { amount: 0.01, currency: 'USD' },
});
assert.equal(withoutObserver.policy.budget.providerCostAdmission.admissionMode, 'bounded-overshoot');
assert.equal(withoutObserver.policy.budget.providerCostAdmission.unknownCostMode, 'fail-run');
assert.equal(withoutObserver.report.budgetSummary.summaryStatus, 'within-budget');

const withRetry = await evaluation({
  dataset: {
    datasetId: 'clean-room-retry',
    samples: [{ sampleId: 'retry', input: 'retry', expected: 'expected' }],
  },
  policy: {
    execution: {
      maxConcurrency: 1,
      retry: {
        maxAttempts: 2,
        retryableErrorCodes: ['clean-room-retryable'],
        backoff: { backoffKind: 'none' },
      },
    },
    evaluation: { maxConcurrency: 1 },
    failure: { failureMode: 'fail-fast' },
  },
}, { runId: 'clean-room-retry' });
assert.equal(withRetry.status, 'completed');
assert.deepEqual(retryAttempts, [1, 2, 1, 2]);
assert.ok(withRetry.artifacts.execution.records.every((record) => record.attempts.length === 2));

const lengthEvaluator = {
  evaluatorKind: 'custom',
  evaluatorId: 'clean-room-length',
  instrumentId: 'clean-room-length-v1',
  metric: {
    metricId: 'output-length',
    valueType: 'numeric',
    scale: { min: 0, max: 20 },
    direction: 'lower-is-better',
    missingPolicyId: 'exclude/v1',
  },
  bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
  implementation: {
    implementationId: 'clean-room.length/v1',
    version: '1.0.0',
    schemas: {
      bindings: z.object({ actual: z.string() }).strict(),
      value: z.number(),
      fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
    },
    fingerprintFacets: { revision: 'clean-room-one' },
    evaluate({ bindings }) {
      return { resultKind: 'score', value: bindings.actual.length };
    },
  },
};

const customEvaluation = await evaluation({
  dataset: {
    datasetId: 'clean-room-analysis-presets',
    analysisCohorts: [{
      cohortId: 'smoke',
      cohortSetId: 'release-slice',
      cohortSetKind: 'cohort',
      classification: 'public',
      disclosure: 'identity-only',
    }],
    samples: ['one', 'two'].map((sampleId, index) => ({
      sampleId,
      input: 'success',
      expected: 'expected',
      ...(index === 0 ? { analysis: { memberships: [{ cohortId: 'smoke' }] } } : {}),
    })),
  },
  evaluators: [{ evaluatorKind: 'exact-match' }, lengthEvaluator],
  comparisons: [{
    comparisonId: 'baseline-vs-prompt-v2',
    controlVariantId: 'baseline',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correct', 'output-length'],
  }],
  analyses: [{
    analysisId: 'baseline-mean-length',
    analysisKind: 'summary', statistic: 'mean',
    variantId: 'baseline', metricId: 'output-length',
  }, {
    analysisId: 'prompt-v2-mean-length',
    analysisKind: 'summary', statistic: 'mean',
    variantId: 'prompt-v2', metricId: 'output-length',
  }, {
    analysisId: 'prompt-v2-smoke-p50-length',
    analysisKind: 'summary', statistic: 'quantile', probability: 0.5,
    variantId: 'prompt-v2', metricId: 'output-length',
    cohortFilter: { includeCohortIds: ['smoke'] },
  }, {
    analysisId: 'baseline-vs-prompt-v2-length',
    analysisKind: 'comparison-interval', statistic: 'mean-difference',
    comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
    metricId: 'output-length',
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
  }, {
    analysisId: 'paired-release-family',
    analysisKind: 'comparison-family', statistic: 'mean-difference',
    members: [{
      analysisId: 'paired-correct-member',
      comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
      metricId: 'correct',
    }, {
      analysisId: 'paired-length-member',
      comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
      metricId: 'output-length',
    }],
    confidence: {
      method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 100,
    },
  }, {
    analysisId: 'prompt-v2-overall-quality',
    analysisKind: 'composite-quality-interval',
    compositeMetricId: 'overall-quality',
    variantId: 'prompt-v2',
    components: [
      { metricId: 'correct', weight: 0.5 },
      { metricId: 'output-length', weight: 0.5 },
    ],
    aggregation: { method: 'weighted-mean', missing: 'require-complete' },
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
  }, {
    analysisId: 'paired-overall-quality-difference',
    analysisKind: 'composite-comparison-interval',
    compositeMetricId: 'overall-quality',
    comparisonId: 'baseline-vs-prompt-v2',
    treatmentVariantId: 'prompt-v2',
    components: [
      { metricId: 'correct', weight: 0.5 },
      { metricId: 'output-length', weight: 0.5 },
    ],
    aggregation: { method: 'weighted-mean', missing: 'require-complete' },
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
  }],
  decision: {
    decisionKind: 'comparison-family',
    analysisId: 'paired-release-family',
    rule: 'all',
    criteria: [{
      analysisId: 'paired-correct-member', minimumEffect: -100, maximumEffect: 100,
    }, {
      analysisId: 'paired-length-member', minimumEffect: -100, maximumEffect: 100,
    }],
  },
}, { runId: 'clean-room-custom-evaluator' });
assert.equal(customEvaluation.status, 'completed');
assert.equal(customEvaluation.artifacts.analysis.records.length, 9);
assert.equal(customEvaluation.analysisResults['baseline-mean-length'].value, 8);
assert.equal(customEvaluation.analysisResults['prompt-v2-mean-length'].value, 8);
assert.equal(customEvaluation.analysisResults['prompt-v2-smoke-p50-length'].value, 8);
assert.equal(customEvaluation.analysisResults['paired-correct-member'].value.confidenceLevel, 0.975);
assert.equal(customEvaluation.analysisResults['paired-release-family'].value.familySize, 2);
assert.equal(customEvaluation.analysisResults['prompt-v2-overall-quality'].value.estimate, 0.8);
assert.equal(customEvaluation.analysisResults['prompt-v2-overall-quality'].value.unitCount, 2);
assert.equal(
  customEvaluation.analysisResults['paired-overall-quality-difference'].value.estimate,
  0,
);
assert.equal(
  customEvaluation.analysisResults['paired-overall-quality-difference'].value.unitCount,
  2,
);
assert.equal(customEvaluation.artifacts.decision.decisionStatus, 'decided');
assert.equal(customEvaluation.artifacts.decision.verdict, 'RELEASE');
assert.ok(customEvaluation.artifacts.evaluation.records.every((record) => (
  record.evaluationStatus === 'completed'
  && record.observations[0]?.observationStatus === 'observed'
)));

const retrievalInvocations = [];
const retrievalExecutor = {
  executorId: 'clean-room.retriever/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ query: z.string() }).strict(),
    config: z.undefined(),
    output: z.object({ documents: z.array(z.string()) }).strict(),
  },
  outputClassification: 'public',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  fingerprintFacets: { revision: 'clean-room-retrieval-one' },
  async execute(invocation) {
    retrievalInvocations.push(structuredClone(invocation));
    return {
      output: {
        documents: invocation.input.query === 'one' ? ['doc-x', 'doc-a'] : ['doc-b'],
      },
    };
  },
};
const retrievalEvaluation = await evaluate({
  dataset: {
    datasetId: 'clean-room-retrieval',
    samples: [{
      sampleId: 'retrieval-one',
      input: { query: 'one' },
      expected: { relevantDocumentIds: ['doc-a'] },
    }, {
      sampleId: 'retrieval-two',
      input: { query: 'two' },
      expected: { relevantDocumentIds: ['doc-b'] },
    }],
  },
  variants: [{
    variantId: 'retriever-v1',
    artifact: {
      name: 'retriever-v1', kind: 'workflow', source: 'inline', content: 'Retrieve documents.',
    },
    execution: { executor: retrievalExecutor },
  }],
  evaluators: [{
    evaluatorKind: 'retrieval',
    evaluatorId: 'retrieval-quality',
    cutoff: 3,
    ranking: { source: 'output', pointer: '/documents' },
    relevantDocumentIdsPointer: '/relevantDocumentIds',
    metricIds: {
      recallAtK: 'recall-at-3',
      precisionAtK: 'precision-at-3',
      reciprocalRankAtK: 'reciprocal-rank-at-3',
      ndcgAtK: 'ndcg-at-3',
    },
  }],
  comparisons: [],
  analyses: [{
    analysisId: 'mean-reciprocal-rank-at-3',
    analysisKind: 'summary',
    statistic: 'mean',
    variantId: 'retriever-v1',
    metricId: 'reciprocal-rank-at-3',
  }],
  experiment: { seed: 'clean-room-retrieval', sampling: { samplingKind: 'solo' } },
  policy: {},
}, { runId: 'clean-room-retrieval' });
assert.equal(retrievalEvaluation.status, 'completed');
assert.equal(retrievalEvaluation.definition.metrics.length, 4);
assert.equal(retrievalEvaluation.analysisResults['mean-reciprocal-rank-at-3'].value, 0.75);
assert.equal(JSON.stringify(retrievalInvocations).includes('relevantDocumentIds'), false);

const independent = await evaluation({
  dataset: {
    datasetId: 'clean-room-independent',
    samples: ['one', 'two', 'three', 'four'].map((sampleId) => ({
      sampleId,
      input: 'success',
      expected: 'expected',
    })),
  },
  evaluators: [{ evaluatorKind: 'exact-match' }, lengthEvaluator],
  comparisons: [{
    comparisonId: 'baseline-vs-prompt-v2',
    controlVariantId: 'baseline',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correct', 'output-length'],
  }],
  analyses: [{
    analysisId: 'independent-release-family',
    analysisKind: 'comparison-family', statistic: 'mean-difference',
    members: [{
      analysisId: 'independent-correct-member',
      comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
      metricId: 'correct',
    }, {
      analysisId: 'independent-length-member',
      comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
      metricId: 'output-length',
    }],
    confidence: {
      method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 100,
    },
  }],
  decision: undefined,
  experiment: {
    seed: 'clean-room-independent-seed',
    sampling: {
      samplingKind: 'independent',
      allocations: [
        { variantId: 'baseline', weight: 1 },
        { variantId: 'prompt-v2', weight: 1 },
      ],
      minimumSamplesPerVariant: 2,
      minimumSamplesPerVariantPerStratum: 1,
    },
  },
}, { runId: 'clean-room-independent' });
assert.equal(independent.status, 'completed');
assert.equal(independent.artifacts.execution.records.length, 4);
assert.equal(
  new Set(independent.artifacts.execution.records.map((record) => record.sampleId)).size,
  4,
);
assert.equal(independent.artifacts.analysis.records[0].analysisStatus, 'completed');
assert.equal(
  independent.analysisResults['independent-correct-member'].implementation.implementationId,
  'bootstrap.unpaired-difference-percentile/v1',
);
assert.equal(independent.analysisResults['independent-release-family'].value.familySize, 2);

const clustered = await evaluate({
  dataset: {
    datasetId: 'clean-room-clustered',
    samples: ['a-1', 'a-2', 'b-1', 'b-2'].map((sampleId) => ({
      sampleId,
      input: 'success',
      expected: 'expected',
      executionContext: { cluster: sampleId.slice(0, 1) },
    })),
  },
  variants: [variant],
  evaluators: [{ evaluatorKind: 'exact-match' }],
  comparisons: [],
  analyses: [{
    analysisId: 'clustered-correctness',
    analysisKind: 'quality-interval', statistic: 'mean',
    variantId: 'prompt-v2', metricId: 'correct',
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 64 },
  }],
  experiment: {
    seed: 'clean-room-cluster-seed',
    sampling: { samplingKind: 'solo', clusterKey: '/executionContext/cluster' },
  },
  policy: {}
}, {
  runId: 'clean-room-clustered'
});
assert.equal(clustered.status, 'completed');
assert.equal(clustered.analysisResults['clustered-correctness'].value.unitCount, 2);

const sequences = [];
const withSlowObserver = await evaluation({}, {
  runId: 'clean-room-slow-observer',
  eventBufferCapacity: 1,
  async onEvent(event) {
    await delay();
    sequences.push(event.sequence);
  },
});
assert.equal(withSlowObserver.status, 'completed');
assert.ok(sequences.length > 0);
assert.ok(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]));

const observerSecret = 'private progress sink payload';
let observerFailure;
try {
  await evaluation({}, {
    runId: 'clean-room-observer-failure',
    eventBufferCapacity: 1,
    onEvent() {
      throw { secret: observerSecret };
    },
  });
} catch (error) {
  observerFailure = error;
}
assert.ok(observerFailure instanceof EvaluationEventConsumptionError);
assert.equal(observerFailure.runResult.status, 'completed');
assert.equal(observerFailure.runResult.definition.dataset.datasetId, 'clean-room-runner');
assert.equal(observerFailure.runResult.policy.execution.maxConcurrency, 1);
assert.equal(observerFailure.cause, undefined);
assert.equal(JSON.stringify(observerFailure).includes(observerSecret), false);

const conformance = await checkExecutor({
  variant,
  success: { input: 'success', expected: 'expected' },
  failure: { input: 'failure', expectedErrorCode: 'clean-room-expected-failure' },
  cancellation: { input: 'cancellation' },
});
assert.equal(conformance.conformant, true, JSON.stringify(conformance.checks));
assert.ok(conformance.checks.every((check) => check.checkStatus === 'passed'));
