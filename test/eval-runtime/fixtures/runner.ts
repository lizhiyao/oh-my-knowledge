import { createEvaluationRuntime, createInvokeExecutorIdentity, createExecutorFnAdapter,
  createExactMatchDefinition, createExactMatchEvaluator, createMeasurementPolicy,
  type ExecResult } from '../../../src/eval-runtime/index.js';

function executionResult(output: string): ExecResult {
  return {
    ok: true,
    output,
    durationMs: 1,
    durationApiMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    tokenUsageReportedByExecutor: true,
    costUSD: 0,
    costReportedByExecutor: false,
    stopReason: 'completed',
    numTurns: 1,
  };
}

export function runnerFixture() {
  const identity = createInvokeExecutorIdentity({
    implementationId: 'test.runner/v1',
    version: '1.0.0',
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'required' },
    fingerprintFacets: { revision: 'runner-test' },
  });
  const createExecutor = () => createExecutorFnAdapter({
    identity,
    outputClassification: 'public',
    mapInput: ({ input }) => ({ model: 'fixture', prompt: String(input) }),
    executor: async ({ prompt, abortSignal }) => {
      abortSignal?.throwIfAborted();
      return executionResult(prompt);
    },
  });
  const runtime = () => createEvaluationRuntime({
    executors: [{ implementationId: identity.implementationId, createPort: createExecutor }],
    evaluators: [{ port: createExactMatchEvaluator() }],
    clock: {
      monotonicNow: () => 1,
      timestamp: () => '2026-09-04T00:00:00.000Z',
      sleep: () => Promise.resolve(),
    },
  });
  const definition = createExactMatchDefinition({
    datasetId: 'runner-dataset',
    seed: 'runner-seed',
    samples: [
      { sampleId: 'one', input: 'one', expected: 'one' },
      { sampleId: 'two', input: 'two', expected: 'two' },
    ],
    control: { targetId: 'control', executorId: identity.implementationId },
    treatment: { targetId: 'treatment', executorId: identity.implementationId },
    bootstrap: { resamples: 100 },
  });
  return {
    runtime,
    definition,
    policy: createMeasurementPolicy({
      execution: { maxConcurrency: 1 },
      evaluation: { maxConcurrency: 1 },
    }),
  };
}
