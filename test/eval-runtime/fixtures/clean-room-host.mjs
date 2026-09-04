import assert from 'node:assert/strict';
import { setImmediate as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  EvaluationEventConsumptionError,
  checkExecutor,
  evaluate,
} from 'oh-my-knowledge/eval-runtime';

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
  async execute({ input, signal }) {
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

const evaluation = (overrides = {}) => evaluate({
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
    comparisonKind: 'paired',
    controlVariantId: 'baseline',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correct'],
  }],
  analysis: { bootstrap: { resamples: 100 } },
  decision: {
    decisionKind: 'comparison',
    comparisonId: 'baseline-vs-prompt-v2',
    treatmentVariantId: 'prompt-v2',
    metricId: 'correct',
  },
  experiment: { seed: 'clean-room-seed', sampling: { samplingKind: 'paired' } },
  policy: { maxConcurrency: 1 },
  runId: 'clean-room-evaluate',
  ...overrides,
});

const withoutObserver = await evaluation();
assert.equal(withoutObserver.status, 'completed');
assert.equal(withoutObserver.definition.dataset.datasetId, 'clean-room-runner');

const customEvaluation = await evaluation({
  evaluators: [{
    evaluatorKind: 'custom',
    evaluatorId: 'clean-room-length',
    instrumentId: 'clean-room-length-v1',
    metric: {
      metricId: 'output-length',
      valueType: 'numeric',
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
  }],
  comparisons: [{
    comparisonId: 'baseline-vs-prompt-v2',
    comparisonKind: 'paired',
    controlVariantId: 'baseline',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['output-length'],
  }],
  decision: undefined,
  runId: 'clean-room-custom-evaluator',
});
assert.equal(customEvaluation.status, 'completed');
assert.equal(customEvaluation.artifacts.analysis.records.length, 1);
assert.ok(customEvaluation.artifacts.evaluation.records.every((record) => (
  record.evaluationStatus === 'completed'
  && record.observations[0]?.observationStatus === 'observed'
)));

const independent = await evaluation({
  dataset: {
    datasetId: 'clean-room-independent',
    samples: ['one', 'two', 'three', 'four'].map((sampleId) => ({
      sampleId,
      input: 'success',
      expected: 'expected',
    })),
  },
  comparisons: [{
    comparisonId: 'baseline-vs-prompt-v2',
    comparisonKind: 'independent',
    controlVariantId: 'baseline',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correct'],
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
  runId: 'clean-room-independent',
});
assert.equal(independent.status, 'completed');
assert.equal(independent.artifacts.execution.records.length, 4);
assert.equal(
  new Set(independent.artifacts.execution.records.map((record) => record.sampleId)).size,
  4,
);
assert.equal(independent.artifacts.analysis.records[0].analysisStatus, 'completed');

const sequences = [];
const withSlowObserver = await evaluation({
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
  await evaluation({
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
