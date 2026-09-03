import assert from 'node:assert/strict';
import { setImmediate as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  EvaluationEventConsumptionError,
  assertExecutorConformance,
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createInvokeExecutorIdentity,
  createJsonExecutorAdapter,
  createMeasurementPolicy,
  runEvaluation,
  runExecutorConformance,
} from 'oh-my-knowledge/eval-runtime';

const identity = createInvokeExecutorIdentity({
  implementationId: 'clean-room.json-host/v1',
  version: '1.0.0',
  determinism: 'deterministic',
  cancellation: 'cooperative',
  concurrency: { safety: 'parallel-safe' },
  seedControl: 'unsupported',
  telemetry: {
    trace: 'unsupported',
    usage: 'required',
    providerCost: { reporting: 'optional' },
  },
  fingerprintFacets: { revision: 'clean-room-one' },
});

const createExecutor = () => createJsonExecutorAdapter({
  identity,
  inputParser: z.string(),
  targetConfigParser: z.undefined(),
  outputParser: z.string(),
  outputClassification: 'public',
  async invoke({ input, signal }) {
    if (input === 'failure') {
      return {
        invocationStatus: 'failed',
        errorCode: 'clean-room-expected-failure',
        usage: { inputTokens: 1 },
      };
    }
    if (input === 'cancellation') {
      await new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
    return {
      invocationStatus: 'completed',
      output: 'expected',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        providerCost: { amount: 0.001, currency: 'USD', reportedByProvider: true },
      },
    };
  },
});

const definition = createExactMatchDefinition({
  datasetId: 'clean-room-runner',
  seed: 'clean-room-seed',
  samples: ['one', 'two'].map((sampleId) => ({
    sampleId,
    input: 'success',
    expected: 'expected',
  })),
  control: { targetId: 'control', executorId: identity.implementationId },
  treatment: { targetId: 'treatment', executorId: identity.implementationId },
  bootstrap: { resamples: 100 },
});
const runtime = () => createEvaluationRuntime({
  executors: [{ implementationId: identity.implementationId, createPort: createExecutor }],
  evaluators: [{ port: createExactMatchEvaluator() }],
});
const policy = createMeasurementPolicy({ maxConcurrency: 1 });

const withoutObserver = await runEvaluation({
  runtime: runtime(),
  definition,
  policy,
  runId: 'clean-room-no-observer',
  eventBufferCapacity: 1,
});
assert.equal(withoutObserver.status, 'completed');

const sequences = [];
const withSlowObserver = await runEvaluation({
  runtime: runtime(),
  definition,
  policy,
  runId: 'clean-room-slow-observer',
  eventBufferCapacity: 1,
  async onEvent(event) {
    await delay();
    sequences.push(event.sequence);
  },
});
assert.equal(withSlowObserver.status, 'completed');
assert.deepEqual(sequences, sequences.map((_value, index) => index));

let observerFailure;
try {
  await runEvaluation({
    runtime: runtime(),
    definition,
    policy,
    runId: 'clean-room-observer-failure',
    eventBufferCapacity: 1,
    onEvent() {
      throw new Error('private progress sink failure');
    },
  });
} catch (error) {
  observerFailure = error;
}
assert.ok(observerFailure instanceof EvaluationEventConsumptionError);
assert.equal(observerFailure.runResult.status, 'completed');

const conformance = await runExecutorConformance({
  implementationId: identity.implementationId,
  createExecutor,
  success: { input: 'success', expected: 'expected' },
  failure: { input: 'failure', expectedErrorCode: 'clean-room-expected-failure' },
  cancellation: { input: 'cancellation' },
});
assertExecutorConformance(conformance);
assert.ok(conformance.checks.every((check) => check.checkStatus === 'passed'));
