import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createInvokeExecutorIdentity,
  createJsonExecutorAdapter,
  createMeasurementPolicy,
  runEvaluation,
} from '../../src/eval-runtime/advanced.js';

function identity(input: Readonly<{
  trace?: 'unsupported' | 'optional' | 'required';
  usage?: 'unsupported' | 'optional' | 'required';
  cost?: 'unsupported' | 'optional' | 'required';
}> = {}) {
  return createInvokeExecutorIdentity({
    implementationId: 'test.json-service/v1',
    version: '1.0.0',
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: {
      trace: input.trace ?? 'unsupported',
      usage: input.usage ?? 'optional',
      providerCost: { reporting: input.cost ?? 'unsupported' },
    },
    fingerprintFacets: { deployment: 'json-adapter-test' },
  });
}

async function execute(
  createExecutor: () => ReturnType<typeof createJsonExecutorAdapter>,
  runtimeIdentity: ReturnType<typeof identity>,
  sampleInput: unknown,
  expected: unknown,
  options: Readonly<{
    signal?: AbortSignal;
    onEvent?: Parameters<typeof runEvaluation>[0]['onEvent'];
  }> = {},
) {
  const runtime = createEvaluationRuntime({
    executors: [{ implementationId: runtimeIdentity.implementationId, createPort: createExecutor }],
    evaluators: [{ port: createExactMatchEvaluator() }],
  });
  const definition = createExactMatchDefinition({
    datasetId: 'json-adapter',
    seed: 'json-adapter-seed',
    samples: [
      { sampleId: 'one', input: sampleInput as never, expected: expected as never },
      { sampleId: 'two', input: sampleInput as never, expected: expected as never },
    ],
    control: {
      targetId: 'control',
      executorId: runtimeIdentity.implementationId,
      config: { deployment: 'baseline' },
    },
    treatment: {
      targetId: 'treatment',
      executorId: runtimeIdentity.implementationId,
      config: { deployment: 'candidate' },
    },
    bootstrap: { resamples: 100 },
  });
  return runEvaluation({
    runtime,
    definition,
    policy: createMeasurementPolicy({ maxConcurrency: 1 }),
    runId: 'json-adapter-run',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
}

describe('source-neutral JSON Executor adapter', () => {
  it('provides parsed generic values and accepts structured JSON output without legacy fields', async () => {
    const runtimeIdentity = identity({ usage: 'required' });
    const seenSignals: AbortSignal[] = [];
    const createExecutor = () => createJsonExecutorAdapter({
      identity: runtimeIdentity,
      inputParser: z.object({ question: z.string() }),
      targetConfigParser: z.object({ deployment: z.string() }),
      outputParser: z.object({ answer: z.string() }),
      outputClassification: 'sensitive',
      async invoke({ input, targetConfig, signal }) {
        seenSignals.push(signal);
        return {
          invocationStatus: 'completed',
          output: { answer: `${input.question}:${targetConfig.deployment}` },
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        };
      },
    });
    const result = await execute(
      createExecutor,
      runtimeIdentity,
      { question: 'answer' },
      { answer: 'answer:baseline' },
    );

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records).toHaveLength(4);
    expect(result.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'completed',
      output: { classification: 'sensitive' },
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    });
    expect(seenSignals).toHaveLength(4);
    expect(seenSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it('fails closed on invalid input without persisting the rejected payload', async () => {
    const runtimeIdentity = identity();
    const createExecutor = () => createJsonExecutorAdapter({
      identity: runtimeIdentity,
      inputParser: z.object({ question: z.string() }),
      targetConfigParser: z.object({ deployment: z.string() }),
      outputParser: z.string(),
      outputClassification: 'public',
      async invoke() {
        return { invocationStatus: 'completed', output: 'unreachable' };
      },
    });
    const result = await execute(
      createExecutor,
      runtimeIdentity,
      { secret: 'provider-private-payload' },
      'unreachable',
    );

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const failures = result.artifacts.execution.records.filter(
      (record) => record.executionStatus === 'failed',
    );
    expect(failures).toHaveLength(4);
    expect(failures.every((record) => (
      record.error.code === 'EVAL_RUNTIME_EXECUTOR_INPUT_INVALID'
    ))).toBe(true);
    expect(JSON.stringify(failures)).not.toContain('provider-private-payload');
  });

  it('fails closed on invalid Target config without invoking the host', async () => {
    const runtimeIdentity = identity();
    let invocations = 0;
    const runtime = createEvaluationRuntime({
      executors: [{
        implementationId: runtimeIdentity.implementationId,
        createPort: () => createJsonExecutorAdapter({
          identity: runtimeIdentity,
          inputParser: z.string(),
          targetConfigParser: z.object({ deployment: z.string() }).strict(),
          outputParser: z.string(),
          outputClassification: 'public',
          async invoke() {
            invocations += 1;
            return { invocationStatus: 'completed', output: 'unreachable' };
          },
        }),
      }],
      evaluators: [{ port: createExactMatchEvaluator() }],
    });
    const definition = createExactMatchDefinition({
      datasetId: 'invalid-target-config',
      seed: 'invalid-target-config-seed',
      samples: [
        { sampleId: 'one', input: 'question', expected: 'answer' },
        { sampleId: 'two', input: 'question', expected: 'answer' },
      ],
      control: {
        targetId: 'control',
        executorId: runtimeIdentity.implementationId,
        config: { privateCredential: 'must-not-persist' },
      },
      treatment: {
        targetId: 'treatment',
        executorId: runtimeIdentity.implementationId,
        config: { deployment: 'candidate' },
      },
      bootstrap: { resamples: 100 },
    });
    const result = await runEvaluation({
      runtime,
      definition,
      policy: createMeasurementPolicy({ maxConcurrency: 1 }),
      runId: 'invalid-target-config',
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const control = result.artifacts.execution.records.filter((record) => (
      record.targetId === 'control'
    ));
    expect(control).toHaveLength(2);
    expect(control.every((record) => (
      record.executionStatus === 'failed'
      && record.error.code === 'EVAL_RUNTIME_EXECUTOR_TARGET_CONFIG_INVALID'
    ))).toBe(true);
    expect(JSON.stringify(control)).not.toContain('must-not-persist');
    expect(invocations).toBe(2);
  });

  it('rejects parser transforms that would change measurement under the same identity', async () => {
    const runtimeIdentity = identity();
    const createExecutor = () => createJsonExecutorAdapter({
      identity: runtimeIdentity,
      inputParser: z.object({ question: z.string() }),
      targetConfigParser: z.object({ deployment: z.string() }),
      outputParser: z.string(),
      outputClassification: 'public',
      async invoke() {
        return { invocationStatus: 'completed', output: 'unreachable' };
      },
    });
    const result = await execute(
      createExecutor,
      runtimeIdentity,
      { question: 'answer', undeclared: 'would-be-stripped' },
      'unreachable',
    );

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_INPUT_INVALID' },
    });
  });

  it('preserves stable host failure codes and measured usage without private messages', async () => {
    const runtimeIdentity = identity({ usage: 'required', cost: 'optional' });
    const createExecutor = () => createJsonExecutorAdapter({
      identity: runtimeIdentity,
      inputParser: z.string(),
      targetConfigParser: z.object({ deployment: z.string() }),
      outputParser: z.string(),
      outputClassification: 'public',
      async invoke() {
        return {
          invocationStatus: 'failed',
          errorCode: 'gateway-unavailable',
          usage: {
            inputTokens: 3,
            providerCost: { amount: 0.01, currency: 'USD', reportedByProvider: true },
          },
        };
      },
    });
    const result = await execute(createExecutor, runtimeIdentity, 'question', 'answer');

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: {
        code: 'gateway-unavailable',
        message: 'Executor reported a structured failure.',
      },
      usage: {
        inputTokens: 3,
        providerCost: { amount: 0.01, currency: 'USD', reportedByProvider: true },
      },
    });
  });

  it('redacts thrown provider errors into one stable public failure', async () => {
    const runtimeIdentity = identity();
    const createExecutor = () => createJsonExecutorAdapter({
      identity: runtimeIdentity,
      inputParser: z.string(),
      targetConfigParser: z.object({ deployment: z.string() }),
      outputParser: z.string(),
      outputClassification: 'public',
      async invoke() {
        throw new Error('provider secret: tenant-token');
      },
    });
    const result = await execute(createExecutor, runtimeIdentity, 'question', 'answer');

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const failures = result.artifacts.execution.records.filter(
      (record) => record.executionStatus === 'failed',
    );
    expect(failures[0]).toMatchObject({
      error: { code: 'EVAL_RUNTIME_EXECUTOR_FAILED' },
    });
    expect(JSON.stringify(failures)).not.toContain('tenant-token');
  });

  it('rejects telemetry that contradicts the sealed Runtime identity', async () => {
    const runtimeIdentity = identity({ usage: 'required', cost: 'unsupported' });
    const createExecutor = () => createJsonExecutorAdapter({
      identity: runtimeIdentity,
      inputParser: z.string(),
      targetConfigParser: z.object({ deployment: z.string() }),
      outputParser: z.string(),
      outputClassification: 'public',
      async invoke() {
        return {
          invocationStatus: 'completed',
          output: 'answer',
          usage: {
            inputTokens: 1,
            providerCost: { amount: 0.01, currency: 'USD', reportedByProvider: true },
          },
        };
      },
    });
    const result = await execute(createExecutor, runtimeIdentity, 'question', 'answer');

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION' },
    });

    const unsupportedUsageIdentity = identity({ usage: 'unsupported' });
    const unsupportedUsage = await execute(
      () => createJsonExecutorAdapter({
        identity: unsupportedUsageIdentity,
        inputParser: z.string(),
        targetConfigParser: z.object({ deployment: z.string() }),
        outputParser: z.string(),
        outputClassification: 'public',
        async invoke() {
          return {
            invocationStatus: 'completed',
            output: 'answer',
            usage: { totalTokens: 1 },
          };
        },
      }),
      unsupportedUsageIdentity,
      'question',
      'answer',
    );
    expect(unsupportedUsage.status).toBe('completed');
    if (unsupportedUsage.status !== 'completed') return;
    expect(unsupportedUsage.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION' },
    });

    const costWithoutTokenUsageIdentity = identity({ usage: 'unsupported', cost: 'required' });
    const costWithoutTokenUsage = await execute(
      () => createJsonExecutorAdapter({
        identity: costWithoutTokenUsageIdentity,
        inputParser: z.string(),
        targetConfigParser: z.object({ deployment: z.string() }),
        outputParser: z.string(),
        outputClassification: 'public',
        async invoke() {
          return {
            invocationStatus: 'completed',
            output: 'answer',
            usage: {
              providerCost: { amount: 0.01, currency: 'USD', reportedByProvider: true },
            },
          };
        },
      }),
      costWithoutTokenUsageIdentity,
      'question',
      'answer',
    );
    expect(costWithoutTokenUsage.status).toBe('completed');
    if (costWithoutTokenUsage.status !== 'completed') return;
    expect(costWithoutTokenUsage.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'completed',
      usage: {
        providerCost: { amount: 0.01, currency: 'USD', reportedByProvider: true },
      },
    });

    const unsupportedFailureTelemetryIdentity = identity({ usage: 'unsupported' });
    const unsupportedFailureTelemetry = await execute(
      () => createJsonExecutorAdapter({
        identity: unsupportedFailureTelemetryIdentity,
        inputParser: z.string(),
        targetConfigParser: z.object({ deployment: z.string() }),
        outputParser: z.string(),
        outputClassification: 'public',
        async invoke() {
          return {
            invocationStatus: 'failed',
            errorCode: 'gateway-unavailable',
            usage: { totalTokens: 1 },
          };
        },
      }),
      unsupportedFailureTelemetryIdentity,
      'question',
      'answer',
    );
    expect(unsupportedFailureTelemetry.status).toBe('completed');
    if (unsupportedFailureTelemetry.status !== 'completed') return;
    expect(unsupportedFailureTelemetry.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION' },
    });
    expect(unsupportedFailureTelemetry.artifacts.execution.records[0]).not.toHaveProperty('usage');
  });

  it('rejects invalid usage and a missing required trace with stable codes', async () => {
    const invalidUsageIdentity = identity();
    const invalidUsage = await execute(
      () => createJsonExecutorAdapter({
        identity: invalidUsageIdentity,
        inputParser: z.string(),
        targetConfigParser: z.object({ deployment: z.string() }),
        outputParser: z.string(),
        outputClassification: 'public',
        async invoke() {
          return {
            invocationStatus: 'completed',
            output: 'answer',
            usage: { inputTokens: -1 },
          } as never;
        },
      }),
      invalidUsageIdentity,
      'question',
      'answer',
    );
    expect(invalidUsage.status).toBe('completed');
    if (invalidUsage.status !== 'completed') return;
    expect(invalidUsage.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_USAGE_INVALID' },
    });

    const requiredTraceIdentity = identity({ trace: 'required' });
    const missingTrace = await execute(
      () => createJsonExecutorAdapter({
        identity: requiredTraceIdentity,
        inputParser: z.string(),
        targetConfigParser: z.object({ deployment: z.string() }),
        outputParser: z.string(),
        outputClassification: 'public',
        async invoke() {
          return { invocationStatus: 'completed', output: 'answer' };
        },
      }),
      requiredTraceIdentity,
      'question',
      'answer',
    );
    expect(missingTrace.status).toBe('completed');
    if (missingTrace.status !== 'completed') return;
    expect(missingTrace.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION' },
    });

    const costOnlyIdentity = identity({ usage: 'required', cost: 'required' });
    const costOnly = await execute(
      () => createJsonExecutorAdapter({
        identity: costOnlyIdentity,
        inputParser: z.string(),
        targetConfigParser: z.object({ deployment: z.string() }),
        outputParser: z.string(),
        outputClassification: 'public',
        async invoke() {
          return {
            invocationStatus: 'completed',
            output: 'answer',
            usage: {
              providerCost: { amount: 0.01, currency: 'USD', reportedByProvider: true },
            },
          };
        },
      }),
      costOnlyIdentity,
      'question',
      'answer',
    );
    expect(costOnly.status).toBe('completed');
    if (costOnly.status !== 'completed') return;
    expect(costOnly.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION' },
    });
  });

  it('fails with a stable redacted code when runtime output violates its parser', async () => {
    const runtimeIdentity = identity();
    const createExecutor = () => createJsonExecutorAdapter({
      identity: runtimeIdentity,
      inputParser: z.string(),
      targetConfigParser: z.object({ deployment: z.string() }),
      outputParser: z.object({ answer: z.string() }),
      outputClassification: 'public',
      async invoke() {
        return {
          invocationStatus: 'completed',
          output: { answer: 42 },
        } as never;
      },
    });
    const result = await execute(createExecutor, runtimeIdentity, 'question', { answer: 'answer' });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_OUTPUT_INVALID' },
    });
  });

  it('propagates Core cancellation to the host callback and cleans up', async () => {
    const runtimeIdentity = identity();
    const controller = new AbortController();
    let observedReason: unknown;
    const createExecutor = () => createJsonExecutorAdapter({
      identity: runtimeIdentity,
      inputParser: z.string(),
      targetConfigParser: z.object({ deployment: z.string() }),
      outputParser: z.string(),
      outputClassification: 'public',
      async invoke({ signal }) {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            observedReason = signal.reason;
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
        return { invocationStatus: 'completed', output: 'unreachable' };
      },
    });
    const result = await execute(
      createExecutor,
      runtimeIdentity,
      'question',
      'answer',
      {
        signal: controller.signal,
        onEvent(event) {
          if (event.eventKind === 'execution.attempt.started') {
            controller.abort(new Error('host cancelled evaluation'));
          }
        },
      },
    );

    expect(result.status).toBe('cancelled');
    expect(observedReason).toBe('external-cancellation');
  });
});
