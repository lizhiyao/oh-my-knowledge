import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  EvaluationConfigurationError,
  checkExecutor,
  evaluate,
  prepareEvaluation,
  type Executor,
  type SessionExecutor,
  type WorkspaceDescriptor,
  type WorkspaceOpenRequest,
  type WorkspaceProvider,
} from '../../src/eval-runtime/index.js';
import { derivePlannedExecutionCoordinates } from '../../src/eval-core/contracts/index.js';
import {
  createInvokeExecutorIdentity,
  createJsonExecutorAdapter,
} from '../../src/eval-runtime/advanced.js';

const workspaceA: WorkspaceDescriptor = {
  resourceId: 'workspace-a',
  digest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'application/vnd.omk.workspace-tree',
  classification: 'sensitive',
  size: 128,
};

const workspaceB: WorkspaceDescriptor = {
  resourceId: 'workspace-b',
  digest: `sha256:${'b'.repeat(64)}`,
  mediaType: 'application/vnd.omk.workspace-tree',
  classification: 'sensitive',
  size: 256,
};

function provider(
  open: WorkspaceProvider['open'],
  input: Readonly<{ providerId?: string; version?: string; }> = {},
): WorkspaceProvider {
  return {
    providerId: input.providerId ?? 'test.workspace-provider/v1',
    version: input.version ?? '1.0.0',
    fingerprintFacets: { materializer: 'test-cas-overlay/v1' },
    open,
  };
}

function executor(
  workspaceProvider?: WorkspaceProvider,
  execute?: Executor<string, undefined, string>['execute'],
): Executor<string, undefined, string> {
  return {
    executorId: 'test.workspace-executor/v1',
    version: '1.0.0',
    schemas: { input: z.string(), output: z.string() },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    fingerprintFacets: { revision: 'workspace-one' },
    ...(workspaceProvider === undefined ? {} : { workspaceProvider }),
    execute: execute ?? (async ({ input, signal }) => {
      signal.throwIfAborted();
      return { output: input };
    }),
  };
}

function evaluationInput(
  declaration: Executor<string, undefined, string> | SessionExecutor<string, undefined, string>,
  workspace: WorkspaceDescriptor | {
    readonly default?: WorkspaceDescriptor;
    readonly bySampleId?: Readonly<Record<string, WorkspaceDescriptor | null>>;
  } = workspaceA,
  input: Readonly<{ trials?: number; retry?: boolean; }> = {},
) {
  return {
    dataset: {
      datasetId: 'workspace-evaluation',
      samples: [
        { sampleId: 'one', input: 'one', expected: 'one' },
        { sampleId: 'two', input: 'two', expected: 'two' },
      ],
    },
    variants: [{
      variantId: 'workspace-variant',
      artifact: {
        name: 'workspace-agent',
        kind: 'agent' as const,
        source: 'inline' as const,
        content: 'Use the isolated workspace.',
      },
      execution: { executor: declaration, workspace },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' as const }],
    comparisons: [],
    analyses: [{
      analysisId: 'workspace-correct-rate',
      analysisKind: 'summary' as const,
      statistic: 'rate' as const,
      variantId: 'workspace-variant',
      metricId: 'correct',
    }],
    experiment: {
      seed: 'workspace-seed',
      ...(input.trials === undefined ? {} : { trials: input.trials }),
      sampling: { samplingKind: 'solo' as const },
    },
    policy: input.retry === true ? {
      execution: {
        maxConcurrency: 4,
        retry: {
          maxAttempts: 2,
          retryableErrorCodes: ['temporary-workspace-failure'],
          backoff: { backoffKind: 'none' as const },
        },
      },
    } : {},
  };
}

describe('eval-runtime workspace lease', () => {
  it('seals logical workspace controls without materializing a physical root', async () => {
    const open = vi.fn<WorkspaceProvider['open']>();
    const declaration = executor(provider(open));
    const prepared = await prepareEvaluation(evaluationInput(declaration, {
      default: workspaceA,
      bySampleId: { two: workspaceB, one: null },
    }));

    expect(open).not.toHaveBeenCalled();
    expect(prepared.definition.targets[0]).toMatchObject({
      executionRequirements: { workspace: 'copy-on-write-overlay' },
      executionControls: {
        defaults: {
          workspace: { workspaceMode: 'copy-on-write-overlay', descriptor: workspaceA },
        },
        sampleOverrides: [
          { sampleId: 'one', workspace: { workspaceMode: 'not-required' } },
          {
            sampleId: 'two',
            workspace: { workspaceMode: 'copy-on-write-overlay', descriptor: workspaceB },
          },
        ],
      },
    });
    const runtime = prepared.resolvedRuntimes.find((entry) => entry.runtimeKind === 'executor');
    expect(runtime?.identity.capabilities).toMatchObject({
      protocols: [{
        execution: { features: { workspace: ['copy-on-write-overlay'] } },
      }],
    });
  });

  it('opens one fresh trial lease, reuses it across retries, and closes it exactly once', async () => {
    const requests: WorkspaceOpenRequest[] = [];
    const closed: string[] = [];
    const accesses: Array<{ sampleId: string; attemptNumber: number; root?: string; }> = [];
    let rootSequence = 0;
    const declaration = executor(provider(async (request) => {
      requests.push(request);
      const root = `/virtual/omk-workspace-${rootSequence += 1}`;
      return { root, close: () => { closed.push(root); } };
    }), async ({ sampleId, input, attemptNumber, workspace }) => {
      accesses.push({ sampleId, attemptNumber, root: workspace?.root });
      return attemptNumber === 1
        ? { errorCode: 'temporary-workspace-failure' }
        : { output: input };
    });

    const prepared = await prepareEvaluation(evaluationInput(
      declaration,
      workspaceA,
      { trials: 2, retry: true },
    ));
    expect(requests).toHaveLength(0);
    const result = await prepared.run({ runId: 'workspace-retry-run' });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map((request) => request.trialId)).size).toBe(4);
    expect(requests.every((request) => (
      request.runId === 'workspace-retry-run'
      && request.variantId === 'workspace-variant'
      && request.descriptor.digest === workspaceA.digest
      && Object.keys(request).sort().join(',')
        === 'descriptor,runId,sampleId,signal,trialId,trialIndex,trialSeed,variantId'
      && request.signal instanceof AbortSignal
    ))).toBe(true);
    expect(accesses).toHaveLength(8);
    for (const root of new Set(accesses.map((access) => access.root))) {
      expect(accesses.filter((access) => access.root === root).map(
        (access) => access.attemptNumber,
      )).toEqual([1, 2]);
    }
    expect(closed.sort()).toEqual(
      [...new Set(accesses.map((access) => access.root as string))].sort(),
    );
    expect(JSON.stringify(result)).not.toContain('/virtual/omk-workspace-');
  });

  it('keeps provider locators out of identity while provider identity changes fingerprints', async () => {
    const providerOne = provider(async () => ({ root: '/physical/one', close() {} }));
    const providerTwo = provider(async () => ({ root: '/physical/two', close() {} }));
    const providerV2 = provider(
      async () => ({ root: '/physical/three', close() {} }),
      { version: '2.0.0' },
    );
    const first = await prepareEvaluation(evaluationInput(executor(providerOne)));
    const second = await prepareEvaluation(evaluationInput(executor(providerTwo)));
    const changed = await prepareEvaluation(evaluationInput(executor(providerV2)));
    const firstIdentity = first.resolvedRuntimes.find(
      (entry) => entry.runtimeKind === 'executor',
    )?.identity;
    const secondIdentity = second.resolvedRuntimes.find(
      (entry) => entry.runtimeKind === 'executor',
    )?.identity;
    const changedIdentity = changed.resolvedRuntimes.find(
      (entry) => entry.runtimeKind === 'executor',
    )?.identity;

    expect(firstIdentity).toEqual(secondIdentity);
    expect(firstIdentity?.fingerprint).not.toBe(changedIdentity?.fingerprint);
    expect(first.planDigest).toBe(second.planDigest);
    expect(derivePlannedExecutionCoordinates(first.plan).map(
      ({ executionCoordinateDigest }) => executionCoordinateDigest,
    )).not.toEqual(derivePlannedExecutionCoordinates(changed.plan).map(
      ({ executionCoordinateDigest }) => executionCoordinateDigest,
    ));
    expect(JSON.stringify(firstIdentity)).not.toContain('/physical/');
  });

  it('changes only the affected coordinate identity when workspace content changes', async () => {
    const declaration = executor(provider(async () => ({ root: '/physical/unused', close() {} })));
    const first = await prepareEvaluation(evaluationInput(declaration, workspaceA));
    const reordered = await prepareEvaluation(evaluationInput(declaration, {
      size: 128,
      classification: 'sensitive',
      mediaType: 'application/vnd.omk.workspace-tree',
      digest: `sha256:${'a'.repeat(64)}`,
      resourceId: 'workspace-a',
    }));
    const changed = await prepareEvaluation(evaluationInput(declaration, {
      default: workspaceA,
      bySampleId: { two: workspaceB },
    }));
    const coordinates = (prepared: typeof first) => derivePlannedExecutionCoordinates(
      prepared.plan,
    ).map(({ sampleId, executionCoordinateDigest }) => ({ sampleId, executionCoordinateDigest }));

    expect(first.planDigest).toBe(reordered.planDigest);
    expect(coordinates(first)).toEqual(coordinates(reordered));
    expect(coordinates(changed).find(({ sampleId }) => sampleId === 'one')).toEqual(
      coordinates(first).find(({ sampleId }) => sampleId === 'one'),
    );
    expect(coordinates(changed).find(({ sampleId }) => sampleId === 'two')
      ?.executionCoordinateDigest).not.toBe(
        coordinates(first).find(({ sampleId }) => sampleId === 'two')
          ?.executionCoordinateDigest,
      );
  });

  it('captures the descriptor and provider declaration before the caller can mutate them', async () => {
    let originalOpenings = 0;
    let replacementOpenings = 0;
    const mutableDescriptor = { ...workspaceA };
    const mutableProvider = provider(async ({ descriptor, trialId }) => {
      originalOpenings += 1;
      expect(descriptor.digest).toBe(workspaceA.digest);
      return { root: `/virtual/captured-${trialId}`, close() {} };
    }) as {
      providerId: string;
      version: string;
      fingerprintFacets: { materializer: string };
      open: WorkspaceProvider['open'];
    };
    const prepared = await prepareEvaluation(evaluationInput(
      executor(mutableProvider),
      mutableDescriptor,
    ));
    mutableDescriptor.digest = workspaceB.digest;
    mutableProvider.version = '9.0.0';
    mutableProvider.open = async () => {
      replacementOpenings += 1;
      return { root: '/virtual/replacement', close() {} };
    };

    const result = await prepared.run({ runId: 'captured-workspace-declaration' });

    expect(result.status).toBe('completed');
    expect(originalOpenings).toBe(2);
    expect(replacementOpenings).toBe(0);
    expect(prepared.definition.targets[0]?.executionControls.defaults.workspace)
      .toMatchObject({ descriptor: workspaceA });
  });

  it('fails closed on invalid plans and invalid physical leases', async () => {
    const close = vi.fn();
    const invalidLease = executor(provider(async () => ({ root: 'relative/path', close })));
    const invalidRun = await evaluate(evaluationInput(invalidLease));
    expect(invalidRun.status).toBe('failed');
    expect(JSON.stringify(invalidRun)).not.toContain('relative/path');
    expect(close).toHaveBeenCalledTimes(2);

    await expect(prepareEvaluation(evaluationInput(executor(), workspaceA)))
      .rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });
    await expect(prepareEvaluation(evaluationInput(executor(provider(async () => ({
      root: '/unused', close() {},
    }))), {
      bySampleId: { unknown: workspaceA },
    }))).rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });
  });

  it('closes the workspace even when a Session close throws synchronously', async () => {
    const closeWorkspace = vi.fn();
    const cleanupOrder: string[] = [];
    const declaration: SessionExecutor<string, undefined, string> = {
      protocol: 'session',
      executorId: 'test.workspace-session/v1',
      version: '1.0.0',
      schemas: { input: z.string(), output: z.string() },
      outputClassification: 'public',
      capabilities: {
        determinism: 'deterministic',
        cancellation: 'cooperative',
        concurrency: { safety: 'parallel-safe' },
        seedControl: 'unsupported',
        telemetry: { trace: 'unsupported', usage: 'optional' },
      },
      workspaceProvider: provider(async ({ trialId }) => {
        const root = `/virtual/session-${trialId}`;
        return {
          root,
          close() {
            cleanupOrder.push(`workspace:${root}`);
            closeWorkspace();
          },
        };
      }),
      async openSession({ input, workspace }) {
        expect(workspace?.root).toMatch(/^\/virtual\/session-/u);
        const root = workspace?.root as string;
        return {
          async execute() { return { output: input }; },
          close() {
            cleanupOrder.push(`session:${root}`);
            throw new Error('session close failed');
          },
        };
      },
    };

    const result = await evaluate(evaluationInput(declaration));
    expect(closeWorkspace, JSON.stringify(result)).toHaveBeenCalledTimes(2);
    for (const root of cleanupOrder
      .filter((entry) => entry.startsWith('session:'))
      .map((entry) => entry.slice('session:'.length))) {
      expect(cleanupOrder.indexOf(`session:${root}`)).toBeLessThan(
        cleanupOrder.indexOf(`workspace:${root}`),
      );
    }
  });

  it('closes the workspace when opening a Session fails', async () => {
    const closeWorkspace = vi.fn();
    const base = executor(provider(async () => ({ root: '/unused', close() {} })));
    const declaration: SessionExecutor<string, undefined, string> = {
      ...base,
      protocol: 'session',
      workspaceProvider: provider(async ({ trialId }) => ({
        root: `/virtual/open-failure-${trialId}`,
        close: closeWorkspace,
      })),
      async openSession() {
        throw new Error('private provider session failure');
      },
    };

    const result = await evaluate(evaluationInput(declaration));

    expect(result.status).toBe('failed');
    expect(closeWorkspace).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('private provider session failure');
  });

  it('closes the workspace when Session input parsing fails before openSession', async () => {
    const closeWorkspace = vi.fn();
    const openSession = vi.fn<SessionExecutor<string, undefined, string>['openSession']>();
    const base = executor();
    const declaration: SessionExecutor<string, undefined, string> = {
      ...base,
      protocol: 'session',
      workspaceProvider: provider(async ({ trialId }) => ({
        root: `/virtual/parser-failure-${trialId}`,
        close: closeWorkspace,
      })),
      openSession,
    };
    const valid = evaluationInput(declaration);
    const input = {
      ...valid,
      dataset: {
        ...valid.dataset,
        samples: [{ sampleId: 'invalid', input: 42, expected: 'unused' }],
      },
    };

    const result = await evaluate(input as never);

    expect(result.status).toBe('failed');
    expect(openSession).not.toHaveBeenCalled();
    expect(closeWorkspace).toHaveBeenCalledTimes(1);
  });

  it('closes every opened lease when the run is cancelled', async () => {
    const controller = new AbortController();
    const opened: string[] = [];
    const closed: string[] = [];
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const declaration = executor(provider(async ({ trialId }) => {
      const root = `/virtual/cancel-${trialId}`;
      opened.push(root);
      return { root, close: () => { closed.push(root); } };
    }), async ({ signal }) => {
      markStarted?.();
      return new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    const pending = evaluate(evaluationInput(declaration), { signal: controller.signal });
    await started;
    controller.abort('workspace-cancelled');
    const result = await pending;

    expect(result.status).toBe('cancelled');
    expect(opened.length).toBeGreaterThan(0);
    expect(closed.sort()).toEqual(opened.sort());
  });

  it('cancels a pending workspace open and closes a late lease before Target execution', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let resolveOpen: ((lease: { root: string; close(): void }) => void) | undefined;
    let markOpening: (() => void) | undefined;
    const opening = new Promise<void>((resolve) => { markOpening = resolve; });
    let markClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const execute = vi.fn(async () => ({ output: 'unused' }));
    const declaration = executor(provider(async ({ signal }) => {
      observedSignal = signal;
      markOpening?.();
      return new Promise((resolve) => { resolveOpen = resolve; });
    }), execute);
    const base = evaluationInput(declaration);
    const pending = evaluate({
      ...base,
      dataset: { ...base.dataset, samples: [base.dataset.samples[0]!] },
    }, { runId: 'workspace-pending-open-cancel', signal: controller.signal });

    await opening;
    controller.abort('cancel pending workspace open');
    const result = await pending;

    expect(result.status).toBe('cancelled');
    expect(observedSignal?.aborted).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    resolveOpen?.({
      root: '/virtual/late-workspace',
      close() { markClosed?.(); },
    });
    await closed;
    expect(JSON.stringify(result)).not.toContain('/virtual/late-workspace');
  });

  it('closes a fresh lease rejected for reusing an active workspace root', async () => {
    const closeCounts = new Map<string, number>();
    let markFirstExecution: (() => void) | undefined;
    const firstExecution = new Promise<void>((resolve) => { markFirstExecution = resolve; });
    let releaseFirstExecution: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirstExecution = resolve; });
    let markSecondLeaseOpened: (() => void) | undefined;
    const secondLeaseOpened = new Promise<void>((resolve) => { markSecondLeaseOpened = resolve; });
    let markSecondLeaseClosed: (() => void) | undefined;
    const secondLeaseClosed = new Promise<void>((resolve) => { markSecondLeaseClosed = resolve; });
    const declaration = executor(provider(async ({ sampleId }) => {
      if (sampleId === 'two') await firstExecution;
      if (sampleId === 'two') markSecondLeaseOpened?.();
      return {
        root: '/virtual/shared-active-root',
        close() {
          closeCounts.set(sampleId, (closeCounts.get(sampleId) ?? 0) + 1);
          if (sampleId === 'two') markSecondLeaseClosed?.();
        },
      };
    }), async ({ sampleId, input }) => {
      if (sampleId === 'one') {
        markFirstExecution?.();
        await firstMayFinish;
      }
      return { output: input };
    });

    const pending = evaluate({
      ...evaluationInput(declaration),
      policy: { execution: { maxConcurrency: 2 } },
    }, { runId: 'workspace-active-root-reuse' });

    await secondLeaseOpened;
    await Promise.resolve();
    expect(closeCounts.get('two')).toBeUndefined();
    releaseFirstExecution?.();
    const result = await pending;
    await secondLeaseClosed;

    expect(closeCounts).toEqual(new Map([['two', 1], ['one', 1]]));
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('/virtual/shared-active-root');
  });

  it('closes every opened lease after an Executor attempt times out', async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const declaration = executor(provider(async ({ trialId }) => {
      const root = `/virtual/timeout-${trialId}`;
      opened.push(root);
      return { root, close: () => { closed.push(root); } };
    }), async ({ signal }) => new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const base = evaluationInput(declaration);

    const result = await evaluate({
      ...base,
      policy: { execution: { maxConcurrency: 1, timeoutMs: 1 } },
    });

    expect(result.status).toBe('completed');
    expect(opened).toHaveLength(2);
    expect(closed.sort()).toEqual(opened.sort());
    expect(result.artifacts?.execution?.records.every((record) => (
      record.executionStatus === 'failed' && record.error.code === 'timeout'
    ))).toBe(true);
  });

  it('quarantines a root whose cleanup failed instead of risking cross-trial reuse', async () => {
    let invocations = 0;
    let closes = 0;
    const declaration = executor(provider(async () => ({
      root: '/virtual/tainted-workspace-root',
      close() {
        closes += 1;
        throw new Error('cleanup failed');
      },
    })), async ({ input }) => {
      invocations += 1;
      return { output: input };
    });
    const base = evaluationInput(declaration);
    const input = {
      ...base,
      dataset: { ...base.dataset, samples: [base.dataset.samples[0]!] },
    };

    const first = await evaluate(input, { runId: 'workspace-cleanup-failure-one' });
    const second = await evaluate(input, { runId: 'workspace-cleanup-failure-two' });

    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed');
    expect(invocations).toBe(1);
    expect(closes).toBe(2);
  });

  it('does not falsely certify a provider without exercising a workspace lease', async () => {
    const declaration = executor(provider(async () => ({ root: '/virtual/check', close() {} })));
    await expect(checkExecutor({
      variant: {
        variantId: 'workspace-check',
        artifact: { name: 'check', kind: 'agent', source: 'inline', content: 'check' },
        execution: { executor: declaration },
      },
      success: { input: 'success', expected: 'success' },
      failure: { input: 'failure', expectedErrorCode: 'expected-failure' },
      cancellation: { input: 'cancel' },
    })).rejects.toEqual(expect.objectContaining({
      code: 'EVAL_RUNTIME_INPUT_INVALID',
    } satisfies Partial<EvaluationConfigurationError>));
  });

  it('requires advanced adapter identity and provider capability to agree', () => {
    const identity = (workspace: boolean) => createInvokeExecutorIdentity({
      implementationId: 'test.advanced-workspace/v1',
      version: '1.0.0',
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      ...(workspace ? { workspace: 'copy-on-write-overlay' as const } : {}),
      telemetry: { trace: 'unsupported', usage: 'optional' },
      fingerprintFacets: { revision: 'one' },
    });
    const adapter = (runtimeIdentity: ReturnType<typeof identity>, workspaceProvider?: WorkspaceProvider) => (
      createJsonExecutorAdapter({
        identity: runtimeIdentity,
        inputParser: z.string(),
        targetConfigParser: z.undefined(),
        outputParser: z.string(),
        outputClassification: 'public',
        ...(workspaceProvider === undefined ? {} : { workspaceProvider }),
        async invoke({ input }) {
          return { invocationStatus: 'completed', output: input };
        },
      })
    );
    const workspaceProvider = provider(async () => ({ root: '/virtual/advanced', close() {} }));
    const changedProvider = provider(
      async () => ({ root: '/virtual/advanced-v2', close() {} }),
      { version: '2.0.0' },
    );

    expect(() => adapter(identity(true))).toThrow(/requires a WorkspaceProvider/u);
    expect(() => adapter(identity(false), workspaceProvider)).toThrow(/requires copy-on-write/u);
    expect(() => adapter(identity(true), workspaceProvider)).not.toThrow();
    expect(adapter(identity(true), workspaceProvider).identity.fingerprint).not.toBe(
      adapter(identity(true), changedProvider).identity.fingerprint,
    );
  });
});
