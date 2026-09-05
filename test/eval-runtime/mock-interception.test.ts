import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  MOCK_INTERCEPTION_PLAN_MEDIA_TYPE,
  EvaluationConfigurationError,
  checkExecutor,
  evaluate,
  prepareEvaluation,
  type Executor,
  type ExecutorSessionAttempt,
  type MockInterceptionAccess,
  type MockInterceptionDescriptor,
  type MockInterceptionOpenRequest,
  type MockInterceptionProvider,
  type SessionExecutor,
} from '../../src/eval-runtime/index.js';
import {
  canonicalizeJson,
  derivePlannedExecutionCoordinates,
  digestCanonicalJson,
  type JsonValue,
} from '../../src/eval-core/contracts/index.js';

const planA = {
  schemaVersion: 'omk.mock-interception-plan/v1',
  strict: true,
  rules: [{ mockId: 'mock-1', rule: { digest: 'rule-a' }, payloads: [{ digest: 'value-a' }] }],
};
const planB = {
  schemaVersion: 'omk.mock-interception-plan/v1',
  strict: false,
  rules: [{ mockId: 'mock-1', rule: { digest: 'rule-b' }, payloads: [{ digest: 'value-b' }] }],
};

function descriptor(resourceId: string, value: JsonValue): MockInterceptionDescriptor {
  return {
    resourceId,
    digest: digestCanonicalJson(value),
    mediaType: MOCK_INTERCEPTION_PLAN_MEDIA_TYPE,
    classification: 'secret',
    size: Buffer.byteLength(canonicalizeJson(value), 'utf8'),
  };
}

const descriptorA = descriptor('mock-plan-a', planA);
const descriptorB = descriptor('mock-plan-b', planB);

function provider(
  open: MockInterceptionProvider['open'],
  version = '1.0.0',
): MockInterceptionProvider {
  return {
    providerId: 'test.mock-interception-provider/v1',
    version,
    fingerprintFacets: { matcher: 'source-neutral/v1' },
    open,
  };
}

function executor(
  mockInterceptionProvider?: MockInterceptionProvider,
  execute?: Executor<string, undefined, string>['execute'],
): Executor<string, undefined, string> {
  return {
    executorId: 'test.mock-interception-executor/v1',
    version: '1.0.0',
    schemas: { input: z.string(), output: z.string() },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      ...(mockInterceptionProvider === undefined
        ? {}
        : { mockInterception: 'pre-tool-call' as const }),
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    ...(mockInterceptionProvider === undefined ? {} : { mockInterceptionProvider }),
    fingerprintFacets: { revision: 'mock-one' },
    execute: execute ?? (async ({ input, signal }) => {
      signal.throwIfAborted();
      return { output: input };
    }),
  };
}

function evaluationInput(
  declaration: Executor<string, undefined, string> | SessionExecutor<string, undefined, string>,
  mockInterception: MockInterceptionDescriptor | Readonly<{
    default?: MockInterceptionDescriptor;
    bySampleId?: Readonly<Record<string, MockInterceptionDescriptor | null>>;
  }> = descriptorA,
  retry = false,
) {
  return {
    dataset: {
      datasetId: 'mock-interception-evaluation',
      samples: [
        { sampleId: 'one', input: 'one', expected: 'mocked' },
        { sampleId: 'two', input: 'two', expected: 'two' },
      ],
    },
    variants: [{
      variantId: 'mock-variant',
      artifact: {
        name: 'mock-agent',
        kind: 'agent' as const,
        source: 'inline' as const,
        content: 'Use tools.',
      },
      execution: { executor: declaration, mockInterception },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' as const }],
    comparisons: [],
    analyses: [],
    experiment: { seed: 'mock-seed', sampling: { samplingKind: 'solo' as const } },
    policy: retry ? {
      execution: {
        retry: {
          maxAttempts: 2,
          retryableErrorCodes: ['temporary-mock-failure'],
          backoff: { backoffKind: 'none' as const },
        },
      },
    } : {},
  };
}

describe('eval-runtime sample-scoped mock interception', () => {
  it('seals sample controls without opening a lease and rejects false conformance', async () => {
    const open = vi.fn<MockInterceptionProvider['open']>();
    const declaration = executor(provider(open));
    const prepared = await prepareEvaluation(evaluationInput(
      declaration,
      { default: descriptorA, bySampleId: { two: null } },
    ));

    expect(open).not.toHaveBeenCalled();
    expect(prepared.definition.targets[0]).toMatchObject({
      executionRequirements: { mockInterception: 'pre-tool-call' },
      executionControls: {
        defaults: {
          mockInterception: {
            mockInterceptionMode: 'pre-tool-call',
            descriptor: descriptorA,
          },
        },
        sampleOverrides: [{
          sampleId: 'two',
          mockInterception: { mockInterceptionMode: 'not-required' },
        }],
      },
    });
    await expect(checkExecutor({
      variant: {
        variantId: 'mock-check',
        artifact: { name: 'check', kind: 'agent', source: 'inline', content: 'check' },
        execution: { executor: declaration },
      },
      success: { input: 'success', expected: 'success' },
      failure: { input: 'failure', expectedErrorCode: 'expected-failure' },
      cancellation: { input: 'cancel' },
    })).rejects.toBeInstanceOf(EvaluationConfigurationError);
  });

  it('opens a fresh attempt lease, exposes only validated decisions, and closes it', async () => {
    const requests: MockInterceptionOpenRequest[] = [];
    const closed: string[] = [];
    let leaseSequence = 0;
    const declaration = executor(provider(async (request) => {
      requests.push(request);
      const leaseId = `lease-${leaseSequence += 1}`;
      return {
        async intercept({ toolName, input, signal }) {
          expect(signal).toBe(request.signal);
          expect(toolName).toBe('search');
          expect(input).toEqual({ query: request.sampleId });
          return { decisionKind: 'mocked', output: 'mocked' };
        },
        close() { closed.push(leaseId); },
      };
    }), async ({ input, signal, mockInterception }) => {
      if (mockInterception === undefined) return { output: input };
      const decision = await mockInterception.intercept({
        callId: `call-${input}`,
        toolName: 'search',
        input: { query: input },
        signal,
      });
      return decision.decisionKind === 'mocked'
        ? { output: decision.output as string }
        : { errorCode: 'mock-not-applied' };
    });

    const result = await evaluate(evaluationInput(
      declaration,
      { default: descriptorA, bySampleId: { two: null } },
    ), { runId: 'mock-interception-run' });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      runId: 'mock-interception-run',
      sampleId: 'one',
      variantId: 'mock-variant',
      attemptNumber: 1,
      descriptor: descriptorA,
    });
    expect(closed).toEqual(['lease-1']);
    expect(JSON.stringify(result)).not.toContain('source-neutral/v1');
  });

  it('resets provider state for every retry attempt', async () => {
    const firstValues: string[] = [];
    const closed: number[] = [];
    const declaration = executor(provider(async ({ attemptNumber }) => {
      let index = 0;
      return {
        async intercept() {
          index += 1;
          firstValues.push(`${attemptNumber}:${index}`);
          return { decisionKind: 'mocked', output: `value-${index}` };
        },
        close() { closed.push(attemptNumber); },
      };
    }), async ({ input, attemptNumber, signal, mockInterception }) => {
      if (mockInterception === undefined) return { output: input };
      await mockInterception.intercept({
        callId: `call-${attemptNumber}`,
        toolName: 'search',
        input: {},
        signal,
      });
      return attemptNumber === 1
        ? { errorCode: 'temporary-mock-failure' }
        : { output: 'mocked' };
    });

    const result = await evaluate(evaluationInput(
      declaration,
      { default: descriptorA, bySampleId: { two: null } },
      true,
    ));

    expect(result.status).toBe('completed');
    expect(firstValues).toEqual(['1:1', '2:1']);
    expect(closed).toEqual([1, 2]);
  });

  it('gives each Session attempt a fresh access without reopening the Session', async () => {
    const opened: number[] = [];
    const closed: number[] = [];
    const openSession: SessionExecutor<string, undefined, string>['openSession'] = vi.fn(
      async ({ input }) => ({
        async execute({ attemptNumber, mockInterception }: ExecutorSessionAttempt) {
          if (input === 'two') {
            expect(mockInterception).toBeUndefined();
            return { output: input };
          }
          expect(mockInterception).toBeDefined();
          if (attemptNumber === 1) return { errorCode: 'temporary-mock-failure' };
          return { output: 'mocked' };
        },
        close() {},
      }),
    );
    const base = executor(provider(async ({ attemptNumber }) => {
      opened.push(attemptNumber);
      return {
        async intercept() { return { decisionKind: 'pass-through' }; },
        close() { closed.push(attemptNumber); },
      };
    }));
    const declaration: SessionExecutor<string, undefined, string> = {
      ...base,
      protocol: 'session',
      openSession,
    };

    const result = await evaluate(evaluationInput(
      declaration,
      { default: descriptorA, bySampleId: { two: null } },
      true,
    ));

    expect(result.status).toBe('completed');
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(opened).toEqual([1, 2]);
    expect(closed).toEqual([1, 2]);
  });

  it('binds descriptor changes locally and provider identity globally', async () => {
    const make = (selected: MockInterceptionDescriptor, version = '1.0.0') => (
      prepareEvaluation(evaluationInput(
        executor(provider(async () => ({
          async intercept() { return { decisionKind: 'mocked', output: 'mocked' }; },
          close() {},
        }), version)),
        { default: selected, bySampleId: { two: null } },
      ))
    );
    const first = await make(descriptorA);
    const descriptorChanged = await make(descriptorB);
    const providerChanged = await make(descriptorA, '2.0.0');
    const coordinates = (prepared: typeof first) => derivePlannedExecutionCoordinates(prepared.plan)
      .map(({ sampleId, executionCoordinateDigest }) => ({ sampleId, executionCoordinateDigest }));

    expect(coordinates(first).find(({ sampleId }) => sampleId === 'one')
      ?.executionCoordinateDigest).not.toBe(
        coordinates(descriptorChanged).find(({ sampleId }) => sampleId === 'one')
          ?.executionCoordinateDigest,
      );
    expect(coordinates(first).find(({ sampleId }) => sampleId === 'two')).toEqual(
      coordinates(descriptorChanged).find(({ sampleId }) => sampleId === 'two'),
    );
    expect(first.planDigest).not.toBe(providerChanged.planDigest);
  });

  it('cancels a pending provider open and closes a late lease without invoking the Target', async () => {
    let resolveLease!: (lease: {
      intercept(): Promise<{ decisionKind: 'pass-through' }>;
      close(): void;
    }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = new Promise<{
      intercept(): Promise<{ decisionKind: 'pass-through' }>;
      close(): void;
    }>((resolve) => { resolveLease = resolve; });
    const close = vi.fn();
    const execute = vi.fn<Executor<string, undefined, string>['execute']>();
    const declaration = executor(provider(async ({ signal }) => {
      expect(signal.aborted).toBe(false);
      markStarted();
      return pending;
    }), execute);
    const controller = new AbortController();
    const evaluating = evaluate(evaluationInput(
      declaration,
      { default: descriptorA, bySampleId: { two: null } },
    ), { runId: 'mock-open-cancellation', signal: controller.signal });

    await started;
    controller.abort(new Error('private-cancellation-marker'));
    const result = await evaluating;
    expect(result.status).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();

    resolveLease({
      async intercept() { return { decisionKind: 'pass-through' }; },
      close,
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(result)).not.toContain('private-cancellation-marker');
  });

  it('does not invoke an Invoke Target when lease method capture cancels the attempt', async () => {
    const controller = new AbortController();
    const close = vi.fn();
    const execute = vi.fn<Executor<string, undefined, string>['execute']>();
    const declaration = executor(provider(async () => ({
      get intercept() {
        controller.abort(new Error('private-getter-abort'));
        return async () => ({ decisionKind: 'pass-through' as const });
      },
      close,
    })), execute);
    const input = evaluationInput(declaration);
    input.dataset.samples.splice(1);

    const result = await evaluate(input, { signal: controller.signal });

    expect(result.status).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not execute a Session attempt when lease method capture cancels it', async () => {
    const controller = new AbortController();
    const leaseClose = vi.fn();
    const sessionClose = vi.fn();
    const sessionExecute = vi.fn(async () => ({ output: 'unexpected' }));
    const base = executor(provider(async () => ({
      get intercept() {
        controller.abort(new Error('private-session-getter-abort'));
        return async () => ({ decisionKind: 'pass-through' as const });
      },
      close: leaseClose,
    })));
    const openSession = vi.fn(async () => ({ execute: sessionExecute, close: sessionClose }));
    const declaration: SessionExecutor<string, undefined, string> = {
      ...base,
      protocol: 'session',
      openSession,
    };
    const input = evaluationInput(declaration);
    input.dataset.samples.splice(1);

    const result = await evaluate(input, { signal: controller.signal });

    expect(result.status).toBe('cancelled');
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(sessionExecute).not.toHaveBeenCalled();
    expect(leaseClose).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it('captures lease methods exactly once before executing the Target', async () => {
    let interceptReads = 0;
    let closeReads = 0;
    const close = vi.fn();
    const declaration = executor(provider(async () => ({
      get intercept() {
        interceptReads += 1;
        if (interceptReads > 1) throw new Error('intercept getter was read twice');
        return async () => ({ decisionKind: 'pass-through' as const });
      },
      get close() {
        closeReads += 1;
        if (closeReads > 1) throw new Error('close getter was read twice');
        return close;
      },
    })), async ({ input }) => ({ output: input }));
    const input = evaluationInput(declaration);
    input.dataset.samples.splice(1);

    const result = await evaluate(input);

    expect(result.status).toBe('completed');
    expect(interceptReads).toBe(1);
    expect(closeReads).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes once when lease method capture fails after obtaining close', async () => {
    const close = vi.fn();
    const declaration = executor(provider(async () => ({
      get close() { return close; },
      get intercept(): never { throw new Error('private-invalid-getter'); },
    })));
    const input = evaluationInput(declaration);
    input.dataset.samples.splice(1);

    const result = await evaluate(input);

    expect(result.status).toBe('completed');
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private-invalid-getter');
  });

  it('revokes retained access after the attempt closes', async () => {
    const providerIntercept = vi.fn(async () => ({ decisionKind: 'pass-through' as const }));
    let retainedAccess: MockInterceptionAccess | undefined;
    let retainedSignal: AbortSignal | undefined;
    const declaration = executor(provider(async () => ({
      intercept: providerIntercept,
      close() {},
    })), async ({ input, mockInterception, signal }) => {
      retainedAccess = mockInterception;
      retainedSignal = signal;
      return { output: input };
    });
    const input = evaluationInput(declaration);
    input.dataset.samples.splice(1);

    const result = await evaluate(input);
    expect(result.status).toBe('completed');
    if (retainedAccess === undefined || retainedSignal === undefined) {
      throw new Error('mock access fixture was not captured');
    }
    await expect(retainedAccess.intercept({
      callId: 'late-call',
      toolName: 'search',
      input: {},
      signal: retainedSignal,
    })).rejects.toThrow('no longer active');
    expect(providerIntercept).not.toHaveBeenCalled();
  });

  it('waits for in-flight interception before closing an attempt lease', async () => {
    let resolveDecision!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const decision = new Promise<void>((resolve) => { resolveDecision = resolve; });
    const close = vi.fn();
    const declaration = executor(provider(async () => ({
      async intercept() {
        markStarted();
        await decision;
        return { decisionKind: 'pass-through' };
      },
      close,
    })), async ({ input, mockInterception, signal }) => {
      void mockInterception!.intercept({
        callId: 'background-call',
        toolName: 'search',
        input: {},
        signal,
      });
      return { output: input };
    });
    const input = evaluationInput(declaration);
    input.dataset.samples.splice(1);
    let evaluationSettled = false;
    const evaluating = evaluate(input).finally(() => { evaluationSettled = true; });

    await started;
    await Promise.resolve();
    expect(evaluationSettled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    resolveDecision();

    const result = await evaluating;
    expect(result.status).toBe('completed');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects a lease object reused across retry attempts', async () => {
    const close = vi.fn();
    const sharedLease = {
      async intercept() { return { decisionKind: 'pass-through' as const }; },
      close,
    };
    const open = vi.fn(async () => sharedLease);
    const execute = vi.fn<Executor<string, undefined, string>['execute']>(
      async () => ({ errorCode: 'temporary-mock-failure' }),
    );
    const result = await evaluate(evaluationInput(
      executor(provider(open), execute),
      { default: descriptorA, bySampleId: { two: null } },
      true,
    ));

    expect(result.status).toBe('completed');
    expect(open).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('reused one lease object');
  });

  it('fails closed for capability/provider mismatches and redacts provider failures', async () => {
    const missingProvider = {
      ...executor(),
      capabilities: { mockInterception: 'pre-tool-call' as const },
    };
    await expect(prepareEvaluation(evaluationInput(missingProvider)))
      .rejects.toBeInstanceOf(EvaluationConfigurationError);

    const close = vi.fn();
    const result = await evaluate(evaluationInput(executor(provider(async () => ({
      async intercept() { throw new Error('private-provider-secret'); },
      close,
    })), async ({ signal, mockInterception }) => {
      await mockInterception!.intercept({ callId: 'call-1', toolName: 'search', input: {}, signal });
      return { output: 'unexpected' };
    })));
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records.every((record) => (
      record.executionStatus === 'failed'
      && record.error.code === 'EVAL_RUNTIME_EXECUTOR_FAILED'
    ))).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('private-provider-secret');
  });
});
