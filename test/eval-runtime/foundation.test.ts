import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createEvaluationEngine } from '../../src/eval-core/index.js';
import {
  assertExecutorConformance,
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createInvokeExecutorIdentity,
  createJsonExecutorAdapter,
  createMeasurementPolicy,
  createPairedComparisonDefinition,
  runExecutorConformance,
} from '../../src/eval-runtime/advanced.js';
import {
  createExecutorFnAdapter,
  type ExecResult,
} from '../../src/eval-runtime/advanced.js';

function result(output: string): ExecResult {
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

function executorIdentity() {
  return createInvokeExecutorIdentity({
    implementationId: 'test.faas-function/v1',
    version: '1.0.0',
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'required' },
    fingerprintFacets: { deployment: 'test-revision-1' },
  });
}

describe('eval-runtime foundation', () => {
  it('runs a deterministic paired comparison through only public host primitives', async () => {
    const seenSignals: AbortSignal[] = [];
    const identity = executorIdentity();
    const createExecutor = () => createExecutorFnAdapter({
      identity,
      outputClassification: 'public',
      mapInput: (trial) => ({
        model: trial.targetId,
        prompt: String((trial.input as { prompt: string }).prompt),
      }),
      executor: async (input) => {
        expect(input.abortSignal).toBeInstanceOf(AbortSignal);
        seenSignals.push(input.abortSignal!);
        const answers: Record<string, Record<string, string>> = {
          control: { one: 'A', two: 'wrong', three: 'wrong' },
          treatment: { one: 'A', two: 'B', three: 'C' },
        };
        return result(answers[input.model][input.prompt]);
      },
    });
    const runtime = createEvaluationRuntime({
      executors: [{ implementationId: identity.implementationId, createPort: createExecutor }],
      evaluators: [{ port: createExactMatchEvaluator() }],
    });
    const definition = createExactMatchDefinition({
      datasetId: 'faas-evaluation',
      seed: 'explicit-seed-1',
      samples: [
        { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
        { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
        { sampleId: 'three', input: { prompt: 'three' }, expected: 'C' },
      ],
      control: { targetId: 'control', executorId: 'test.faas-function/v1' },
      treatment: { targetId: 'treatment', executorId: 'test.faas-function/v1' },
      bootstrap: { resamples: 100, alpha: 0.1 },
    });
    const policy = createMeasurementPolicy({
      execution: { maxConcurrency: 2 },
      evaluation: { maxConcurrency: 2 },
    });
    const engine = createEvaluationEngine(runtime);
    const [first, second] = await Promise.all([
      engine.prepare(definition, policy),
      engine.prepare(structuredClone(definition), structuredClone(policy)),
    ]);
    expect(second.plan.digests.runContractDigest).toBe(first.plan.digests.runContractDigest);

    const run = first.start({ runId: 'faas-run', eventBufferCapacity: 128 });
    const consuming = (async () => {
      for await (const event of run.events) void event;
    })();
    const completed = await run.result;
    await consuming;

    expect(completed.status, JSON.stringify(completed)).toBe('completed');
    if (completed.status !== 'completed') return;
    expect(completed.artifacts.execution.records).toHaveLength(6);
    expect(completed.artifacts.evaluation.records).toHaveLength(6);
    expect(completed.artifacts.analysis.records[0]).toMatchObject({
      analysisStatus: 'completed',
      resultType: 'interval',
      value: { estimate: 2 / 3, resamples: 100, unitCount: 3 },
    });
    expect(completed.artifacts.decision?.decisionStatus).toBe('decided');
    expect(completed.report.bundles).toHaveLength(3);
    expect(seenSignals).toHaveLength(6);
  });

  it('seals builder defaults into immutable serializable contracts', () => {
    const definition = createExactMatchDefinition({
      datasetId: 'dataset',
      seed: 'seed',
      samples: [
        { sampleId: 'one', input: 'one', expected: 'one' },
        { sampleId: 'two', input: 'two', expected: 'two' },
      ],
      control: { targetId: 'control', executorId: 'executor/v1' },
      treatment: { targetId: 'treatment', executorId: 'executor/v1' },
    });
    const policy = createMeasurementPolicy();

    expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
    expect(JSON.parse(JSON.stringify(policy))).toEqual(policy);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.experiment.sampling)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.budget).toEqual({
      run: { maxInvocations: 10_000 },
      stages: { execution: {}, evaluation: {} },
      coordinate: {},
      attempt: {},
      providerCostAdmission: {
        admissionMode: 'bounded-overshoot',
        unknownCostMode: 'mark-unverifiable',
      },
    });
    expect(definition.experiment.seed).toBe('seed');
    expect(definition.experiment.sampling).toMatchObject({
      estimatorId: 'bootstrap.paired-difference-percentile/v1',
      resamplingUnit: 'paired-block',
      seedCoupling: 'shared-within-block',
    });
    expect(definition.decisionPolicy?.implementationId).toBe('progress/v2');
    expect(createMeasurementPolicy({
      eventDelivery: { writerMode: 'optional' },
    }).eventDelivery).toEqual({
      writerMode: 'optional',
      backpressureMode: 'block',
      writerFailureMode: 'ignore',
    });
    expect(createMeasurementPolicy({
      eventDelivery: { writerMode: 'required' },
    }).eventDelivery).toEqual({
      writerMode: 'required',
      backpressureMode: 'block',
      writerFailureMode: 'fail-run',
    });
    expect(() => createMeasurementPolicy({
      eventDelivery: { writerMode: 'required', writerFailureMode: 'ignore' },
    } as never)).toThrow();

    const configured = createMeasurementPolicy({
      execution: {
        maxConcurrency: 8,
        timeoutMs: 30_000,
        retry: {
          maxAttempts: 3,
          retryableErrorCodes: ['timeout', 'rate-limit'],
          backoff: {
            backoffKind: 'exponential',
            initialDelayMs: 250,
            maxDelayMs: 5_000,
          },
        },
      },
      evaluation: {
        maxConcurrency: 2,
        timeoutMs: 10_000,
        retry: {
          maxAttempts: 2,
          retryableErrorCodes: ['judge-rate-limit'],
          backoff: { backoffKind: 'fixed', initialDelayMs: 200 },
        },
      },
      budget: {
        run: {
          maxInvocations: 500,
          maxActiveDurationMs: 100_000,
          maxWallClockMs: 120_000,
          maxProviderCost: { amount: 5, currency: 'USD' },
        },
        execution: {
          maxInvocations: 300,
          maxActiveDurationMs: 80_000,
          maxProviderCost: { amount: 4, currency: 'USD' },
        },
        evaluation: {
          maxInvocations: 200,
          maxActiveDurationMs: 20_000,
          maxProviderCost: { amount: 1, currency: 'USD' },
        },
        coordinate: {
          maxInvocations: 3,
          maxActiveDurationMs: 30_000,
          maxProviderCost: { amount: 0.1, currency: 'USD' },
        },
        attempt: { maxProviderCost: { amount: 0.05, currency: 'USD' } },
        onUnreportedProviderCost: 'fail-run',
      },
      failure: { failureMode: 'failure-threshold', maxFailures: 2 },
      evidence: { maximumClassification: 'sensitive' },
    });
    expect(configured).toMatchObject({
      execution: { maxConcurrency: 8, timeoutMs: 30_000 },
      retry: {
        maxAttempts: 3,
        retryableErrorCodes: ['rate-limit', 'timeout'],
        backoff: {
          backoffKind: 'exponential', initialDelayMs: 250, maxDelayMs: 5_000,
        },
      },
      evaluation: {
        maxConcurrency: 2,
        timeoutMs: 10_000,
        retry: {
          maxAttempts: 2,
          retryableErrorCodes: ['judge-rate-limit'],
          backoff: { backoffKind: 'fixed', initialDelayMs: 200 },
        },
      },
      budget: {
        run: {
          maxInvocations: 500,
          maxActiveDurationMs: 100_000,
          maxWallClockMs: 120_000,
          maxProviderCost: { amount: 5, currency: 'USD' },
        },
        stages: {
          execution: {
            maxInvocations: 300,
            maxActiveDurationMs: 80_000,
            maxProviderCost: { amount: 4, currency: 'USD' },
          },
          evaluation: {
            maxInvocations: 200,
            maxActiveDurationMs: 20_000,
            maxProviderCost: { amount: 1, currency: 'USD' },
          },
        },
        coordinate: {
          maxInvocations: 3,
          maxActiveDurationMs: 30_000,
          maxProviderCost: { amount: 0.1, currency: 'USD' },
        },
        attempt: { maxProviderCost: { amount: 0.05, currency: 'USD' } },
        providerCostAdmission: {
          admissionMode: 'bounded-overshoot',
          unknownCostMode: 'fail-run',
        },
      },
      failure: { failureMode: 'failure-threshold', maxFailures: 2 },
      evidence: { maximumClassification: 'sensitive' },
    });
    expect(createMeasurementPolicy({
      execution: {
        retry: {
          maxAttempts: 3,
          retryableErrorCodes: ['rate-limit', 'timeout'],
          backoff: {
            backoffKind: 'exponential', initialDelayMs: 250, maxDelayMs: 5_000,
          },
        },
      },
    }).retry).toEqual(configured.retry);

    for (const invalid of [
      { maxConcurrency: 2 },
      { budget: { maxInvocations: 2 } },
      { budget: { run: { maxInvocations: 0 } } },
      { budget: { execution: { maxWallClockMs: 1 } } },
      { budget: { attempt: { maxInvocations: 1 } } },
      { budget: { run: { maxProviderCost: { amount: -1, currency: 'USD' } } } },
      { budget: { run: { maxProviderCost: { amount: 1, currency: 'usd' } } } },
      { budget: {
        run: { maxProviderCost: { amount: 1, currency: 'USD' } },
        evaluation: { maxProviderCost: { amount: 1, currency: 'CNY' } },
      } },
      { execution: { timeoutMs: 0 } },
      { execution: { retry: {
        maxAttempts: 1,
        retryableErrorCodes: ['timeout'],
        backoff: { backoffKind: 'none' },
      } } },
      { execution: { retry: {
        maxAttempts: 2,
        retryableErrorCodes: ['timeout', 'timeout'],
        backoff: { backoffKind: 'none' },
      } } },
      { execution: { retry: {
        maxAttempts: 2,
        retryableErrorCodes: [''],
        backoff: { backoffKind: 'none' },
      } } },
      { execution: { retry: {
        maxAttempts: 2,
        retryableErrorCodes: ['timeout'],
        backoff: { backoffKind: 'exponential', initialDelayMs: 10, maxDelayMs: 5 },
      } } },
      { failure: { failureMode: 'continue', maxFailures: 1 } },
      { failure: { failureMode: 'failure-threshold' } },
    ]) {
      expect(
        () => createMeasurementPolicy(invalid as never),
        JSON.stringify(invalid),
      ).toThrow();
    }
  });

  it('invalidates only the configured stage and its causal downstream identities', async () => {
    const identity = executorIdentity();
    const runtime = createEvaluationRuntime({
      executors: [{
        implementationId: identity.implementationId,
        createPort: () => createExecutorFnAdapter({
          identity,
          outputClassification: 'public',
          mapInput: ({ targetId, input }) => ({ model: targetId, prompt: String(input) }),
          executor: async () => result('expected'),
        }),
      }],
      evaluators: [{ port: createExactMatchEvaluator() }],
    });
    const definition = createExactMatchDefinition({
      datasetId: 'policy-identity',
      seed: 'policy-identity-seed',
      samples: [
        { sampleId: 'one', input: 'one', expected: 'expected' },
        { sampleId: 'two', input: 'two', expected: 'expected' },
      ],
      control: { targetId: 'control', executorId: identity.implementationId },
      treatment: { targetId: 'treatment', executorId: identity.implementationId },
    });
    const engine = createEvaluationEngine(runtime);
    const prepare = (policy: Parameters<typeof createMeasurementPolicy>[0]) => (
      engine.prepare(definition, createMeasurementPolicy(policy))
    );
    const base = await prepare({});
    const executionChanged = await prepare({ execution: { maxConcurrency: 5 } });
    const evaluationChanged = await prepare({ evaluation: { maxConcurrency: 5 } });

    expect(executionChanged.plan.digests.executionPlanDigest)
      .not.toBe(base.plan.digests.executionPlanDigest);
    expect(executionChanged.plan.digests.evaluationPlanDigest)
      .not.toBe(base.plan.digests.evaluationPlanDigest);
    expect(executionChanged.plan.digests.runContractDigest)
      .not.toBe(base.plan.digests.runContractDigest);

    expect(evaluationChanged.plan.digests.executionPlanDigest)
      .toBe(base.plan.digests.executionPlanDigest);
    expect(evaluationChanged.plan.digests.evaluationPlanDigest)
      .not.toBe(base.plan.digests.evaluationPlanDigest);
    expect(evaluationChanged.plan.digests.runContractDigest)
      .not.toBe(base.plan.digests.runContractDigest);

    const retry = {
      maxAttempts: 2,
      retryableErrorCodes: ['timeout', 'rate-limit'],
      backoff: { backoffKind: 'none' as const },
    };
    const retryReordered = {
      ...retry,
      retryableErrorCodes: [...retry.retryableErrorCodes].reverse(),
    };
    const firstRetry = await prepare({ execution: { retry } });
    const secondRetry = await prepare({ execution: { retry: retryReordered } });
    expect(secondRetry.plan.digests.runContractDigest)
      .toBe(firstRetry.plan.digests.runContractDigest);
  });

  it('maps an ExecutorFn failure into a stable Core execution error', async () => {
    const identity = executorIdentity();
    const runtime = createEvaluationRuntime({
      executors: [{
        implementationId: identity.implementationId,
        createPort: () => createExecutorFnAdapter({
          identity,
          outputClassification: 'public',
          mapInput: ({ targetId, input }) => ({ model: targetId, prompt: String(input) }),
          executor: async ({ model }) => model === 'treatment'
            ? { ...result(''), ok: false, output: null, error: 'provider secret' }
            : {
                ...result('expected'),
                tokenUsageReportedByExecutor: false,
                costReportedByExecutor: false,
              },
        }),
      }],
      evaluators: [{ port: createExactMatchEvaluator() }],
    });
    const definition = createExactMatchDefinition({
      datasetId: 'failure-mapping',
      seed: 'failure-seed',
      samples: [
        { sampleId: 'one', input: 'one', expected: 'expected' },
        { sampleId: 'two', input: 'two', expected: 'expected' },
      ],
      control: { targetId: 'control', executorId: identity.implementationId },
      treatment: { targetId: 'treatment', executorId: identity.implementationId },
    });
    const run = createEvaluationEngine(runtime).start(definition, {
      policy: createMeasurementPolicy(),
      runId: 'failure-run',
      eventBufferCapacity: 128,
    });
    const draining = (async () => {
      for await (const event of run.events) void event;
    })();
    const completed = await run.result;
    await draining;

    expect(completed.status).toBe('completed');
    if (completed.status !== 'completed') return;
    const failures = completed.artifacts.execution.records.filter(
      (record) => record.executionStatus === 'failed',
    );
    expect(failures).toHaveLength(4);
    expect(failures.map((record) => record.error.code).sort()).toEqual([
      'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION',
      'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION',
      'EVAL_RUNTIME_EXECUTOR_FAILED',
      'EVAL_RUNTIME_EXECUTOR_FAILED',
    ].sort());
    expect(JSON.stringify(failures)).not.toContain('provider secret');
  });

  it('builds a generic service/RAG comparison as the ordinary Core contract', () => {
    const exact = createExactMatchDefinition({
      datasetId: 'generic-comparison',
      seed: 'generic-seed',
      samples: [{ sampleId: 'one', input: { query: 'q' }, expected: 'answer' }],
      control: { targetId: 'control', executorId: 'service/v1' },
      treatment: { targetId: 'treatment', executorId: 'service/v1' },
    });
    const definition = createPairedComparisonDefinition({
      datasetId: 'generic-comparison',
      seed: 'generic-seed',
      samples: exact.dataset.samples,
      control: {
        targetId: 'control',
        targetKind: 'rag',
        executorId: 'service/v1',
        config: { indexRevision: 'baseline' },
      },
      treatment: {
        targetId: 'treatment',
        targetKind: 'rag',
        executorId: 'service/v1',
        config: { indexRevision: 'candidate' },
      },
      evaluator: exact.evaluators[0],
      metric: exact.metrics[0],
    });

    expect(definition.targets).toMatchObject([
      { targetKind: 'rag', config: { indexRevision: 'baseline' } },
      { targetKind: 'rag', config: { indexRevision: 'candidate' } },
    ]);
    expect(definition.analysisGraph.nodes[0]).toMatchObject({
      implementationId: 'bootstrap.paired-difference-percentile/v1',
      inputs: [
        { inputKind: 'metric-observations', referenceId: 'correct' },
        { inputKind: 'comparison', metricId: 'correct' },
      ],
    });
    expect(Object.isFrozen(definition.targets[0].config)).toBe(true);

    expect(() => createPairedComparisonDefinition({
      datasetId: 'invalid-comparison',
      seed: 'invalid-seed',
      samples: exact.dataset.samples,
      control: { targetId: 'same', executorId: 'service/v1' },
      treatment: { targetId: 'same', executorId: 'service/v1' },
      evaluator: exact.evaluators[0],
      metric: exact.metrics[0],
    })).toThrow(/targetId must differ/);
    expect(() => createPairedComparisonDefinition({
      datasetId: 'invalid-metric',
      seed: 'invalid-seed',
      samples: exact.dataset.samples,
      control: { targetId: 'control', executorId: 'service/v1' },
      treatment: { targetId: 'treatment', executorId: 'service/v1' },
      evaluator: exact.evaluators[0],
      metric: { ...exact.metrics[0], direction: 'lower-is-better' },
    })).toThrow(/higher-is-better/);
    expect(() => createPairedComparisonDefinition({
      datasetId: 'invalid-binding',
      seed: 'invalid-seed',
      samples: exact.dataset.samples,
      control: { targetId: 'control', executorId: 'service/v1' },
      treatment: { targetId: 'treatment', executorId: 'service/v1' },
      evaluator: { ...exact.evaluators[0], metricIds: ['another-metric'] },
      metric: exact.metrics[0],
    })).toThrow(/matching metric/);
  });

  it('rejects duplicate Executor identities during Runtime assembly', () => {
    const identity = executorIdentity();
    const createExecutor = () => createExecutorFnAdapter({
      identity,
      outputClassification: 'public',
      mapInput: ({ targetId, input }) => ({ model: targetId, prompt: String(input) }),
      executor: async () => result('answer'),
    });

    expect(() => createEvaluationRuntime({
      executors: [
        { implementationId: identity.implementationId, createPort: createExecutor },
        { implementationId: identity.implementationId, createPort: createExecutor },
      ],
      evaluators: [{ port: createExactMatchEvaluator() }],
    })).toThrowError(expect.objectContaining({
      code: 'EVAL_RUNTIME_DUPLICATE_IMPLEMENTATION',
    }));
  });

  it('offers a framework-neutral Executor conformance probe through the real pipeline', async () => {
    const identity = executorIdentity();
    const createProbeExecutor = (options: Readonly<{
      successOutput: string;
      reportFailure?: boolean;
      honorCancellation?: boolean;
      reportUsage?: boolean;
    }>) => () => createJsonExecutorAdapter({
      identity,
      inputParser: z.string(),
      targetConfigParser: z.undefined(),
      outputParser: z.string(),
      outputClassification: 'public',
      async invoke({ input, signal }) {
        if (input === 'failure' && options.reportFailure !== false) {
          return { invocationStatus: 'failed', errorCode: 'expected-probe-failure' };
        }
        if (input === 'cancellation' && options.honorCancellation !== false) {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        }
        return {
          invocationStatus: 'completed',
          output: options.successOutput,
          ...(options.reportUsage === false
            ? {}
            : { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
        };
      },
    });
    const conformance = await runExecutorConformance({
      implementationId: identity.implementationId,
      createExecutor: createProbeExecutor({ successOutput: 'expected' }),
      success: { input: 'success', expected: 'expected' },
      failure: { input: 'failure', expectedErrorCode: 'expected-probe-failure' },
      cancellation: { input: 'cancellation' },
    });

    expect(conformance.conformant, JSON.stringify(conformance.checks)).toBe(true);
    expect(conformance.checks.every((check) => check.checkStatus === 'passed')).toBe(true);
    expect(() => assertExecutorConformance(conformance)).not.toThrow();

    const failed = await runExecutorConformance({
      implementationId: identity.implementationId,
      createExecutor: createProbeExecutor({ successOutput: 'unexpected' }),
      success: { input: 'success', expected: 'expected' },
      failure: { input: 'failure', expectedErrorCode: 'expected-probe-failure' },
      cancellation: { input: 'cancellation' },
    });
    expect(failed.conformant).toBe(false);
    expect(failed.checks).toContainEqual({
      checkId: 'evaluation-observation',
      checkStatus: 'failed',
      reasonCode: 'runtime-conformance-output-mismatch',
    });
    expect(() => assertExecutorConformance(failed)).toThrowError(
      expect.objectContaining({
        code: 'EVAL_RUNTIME_CONFORMANCE_FAILED',
        failedCheckIds: ['evaluation-observation'],
      }),
    );

    const ignoredCancellation = await runExecutorConformance({
      implementationId: identity.implementationId,
      createExecutor: createProbeExecutor({
        successOutput: 'expected',
        honorCancellation: false,
      }),
      success: { input: 'success', expected: 'expected' },
      failure: { input: 'failure', expectedErrorCode: 'expected-probe-failure' },
      cancellation: { input: 'cancellation' },
    });
    expect(ignoredCancellation.checks).toContainEqual({
      checkId: 'cancellation-contract',
      checkStatus: 'failed',
      reasonCode: 'runtime-conformance-cancellation-ignored',
    });

    const invalidFailure = await runExecutorConformance({
      implementationId: identity.implementationId,
      createExecutor: createProbeExecutor({
        successOutput: 'expected',
        reportFailure: false,
      }),
      success: { input: 'success', expected: 'expected' },
      failure: { input: 'failure', expectedErrorCode: 'expected-probe-failure' },
      cancellation: { input: 'cancellation' },
    });
    expect(invalidFailure.checks).toContainEqual({
      checkId: 'failure-contract',
      checkStatus: 'failed',
      reasonCode: 'runtime-conformance-failure-contract-invalid',
    });

    const invalidTelemetry = await runExecutorConformance({
      implementationId: identity.implementationId,
      createExecutor: createProbeExecutor({
        successOutput: 'expected',
        reportUsage: false,
      }),
      success: { input: 'success', expected: 'expected' },
      failure: { input: 'failure', expectedErrorCode: 'expected-probe-failure' },
      cancellation: { input: 'cancellation' },
    });
    expect(invalidTelemetry.checks).toContainEqual({
      checkId: 'telemetry-contract',
      checkStatus: 'failed',
      reasonCode: 'runtime-conformance-telemetry-invalid',
    });

    const sharedExecutor = createProbeExecutor({ successOutput: 'expected' })();
    const sharedBinding = await runExecutorConformance({
      implementationId: identity.implementationId,
      createExecutor: () => sharedExecutor,
      success: { input: 'success', expected: 'expected' },
      failure: { input: 'failure', expectedErrorCode: 'expected-probe-failure' },
      cancellation: { input: 'cancellation' },
    });
    expect(sharedBinding.checks).toContainEqual({
      checkId: 'binding-isolation',
      checkStatus: 'failed',
      reasonCode: 'runtime-conformance-binding-not-isolated',
    });
  });
});
