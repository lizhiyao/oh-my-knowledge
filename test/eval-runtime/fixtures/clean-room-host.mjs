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
};

const evaluation = (overrides = {}) => evaluate({
  executor,
  dataset: {
    datasetId: 'clean-room-runner',
    samples: ['one', 'two'].map((sampleId) => ({
      sampleId,
      input: 'success',
      expected: 'expected',
    })),
  },
  control: {
    variantId: 'baseline',
    artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
  },
  treatment: variant,
  evaluator: { evaluatorKind: 'exact-match' },
  experiment: { seed: 'clean-room-seed', bootstrap: { resamples: 100 } },
  policy: { maxConcurrency: 1 },
  runId: 'clean-room-evaluate',
  ...overrides,
});

const withoutObserver = await evaluation();
assert.equal(withoutObserver.status, 'completed');
assert.equal(withoutObserver.definition.dataset.datasetId, 'clean-room-runner');

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
assert.deepEqual(sequences, sequences.map((_value, index) => index));

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
  executor,
  variant,
  success: { input: 'success', expected: 'expected' },
  failure: { input: 'failure', expectedErrorCode: 'clean-room-expected-failure' },
  cancellation: { input: 'cancellation' },
});
assert.equal(conformance.conformant, true, JSON.stringify(conformance.checks));
assert.ok(conformance.checks.every((check) => check.checkStatus === 'passed'));
