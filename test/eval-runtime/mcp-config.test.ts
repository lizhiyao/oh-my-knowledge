import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  EvaluationConfigurationError,
  checkExecutor,
  evaluate,
  prepareEvaluation,
  type Executor,
  type McpConfigDescriptor,
  type McpConfigOpenRequest,
  type McpConfigProvider,
  type SessionExecutor,
} from '../../src/eval-runtime/index.js';
import {
  canonicalizeJson,
  derivePlannedExecutionCoordinates,
  digestCanonicalJson,
  type JsonValue,
} from '../../src/eval-core/contracts/index.js';

const configA = { mcpServers: { docs: { transport: 'stdio', token: 'secret-a' } } };
const configB = { mcpServers: { search: { transport: 'stdio', token: 'secret-b' } } };

function descriptor(resourceId: string, config: JsonValue): McpConfigDescriptor {
  return {
    resourceId,
    digest: digestCanonicalJson(config),
    mediaType: 'application/json',
    classification: 'secret',
    size: Buffer.byteLength(canonicalizeJson(config), 'utf8'),
  };
}

const descriptorA = descriptor('mcp-config-a', configA);
const descriptorB = descriptor('mcp-config-b', configB);

function provider(
  open: McpConfigProvider['open'],
  version = '1.0.0',
): McpConfigProvider {
  return {
    providerId: 'test.mcp-config-provider/v1',
    version,
    fingerprintFacets: { parser: 'native-json/v1' },
    open,
  };
}

function executor(
  mcpConfigProvider?: McpConfigProvider,
  execute?: Executor<string, undefined, string>['execute'],
): Executor<string, undefined, string> {
  return {
    executorId: 'test.mcp-executor/v1',
    version: '1.0.0',
    schemas: { input: z.string(), output: z.string() },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      ...(mcpConfigProvider === undefined ? {} : { mcp: 'native-config' as const }),
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    ...(mcpConfigProvider === undefined ? {} : { mcpConfigProvider }),
    fingerprintFacets: { revision: 'mcp-one' },
    execute: execute ?? (async ({ input, signal }) => {
      signal.throwIfAborted();
      return { output: input };
    }),
  };
}

function evaluationInput(
  declaration: Executor<string, undefined, string> | SessionExecutor<string, undefined, string>,
  mcpConfig: McpConfigDescriptor | Readonly<{
    default?: McpConfigDescriptor;
    bySampleId?: Readonly<Record<string, McpConfigDescriptor | null>>;
  }> = descriptorA,
  retry = false,
) {
  return {
    dataset: {
      datasetId: 'mcp-evaluation',
      samples: [
        { sampleId: 'one', input: 'one', expected: 'one' },
        { sampleId: 'two', input: 'two', expected: 'two' },
      ],
    },
    variants: [{
      variantId: 'mcp-variant',
      artifact: {
        name: 'mcp-agent',
        kind: 'agent' as const,
        source: 'inline' as const,
        content: 'Use the selected MCP config.',
      },
      execution: { executor: declaration, mcpConfig },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' as const }],
    comparisons: [],
    analyses: [],
    experiment: { seed: 'mcp-seed', sampling: { samplingKind: 'solo' as const } },
    policy: retry ? {
      execution: {
        retry: {
          maxAttempts: 2,
          retryableErrorCodes: ['temporary-mcp-failure'],
          backoff: { backoffKind: 'none' as const },
        },
      },
    } : {},
  };
}

function singleSampleWorkspaceInput(
  declaration: Executor<string, undefined, string> | SessionExecutor<string, undefined, string>,
) {
  const input = evaluationInput(declaration);
  return {
    ...input,
    dataset: { ...input.dataset, samples: [input.dataset.samples[0]!] },
    variants: input.variants.map((variant) => ({
      ...variant,
      execution: {
        ...variant.execution,
        workspace: {
          resourceId: 'workspace-mcp-cancellation',
          digest: digestCanonicalJson({ snapshot: 'mcp-cancellation' }),
          mediaType: 'application/vnd.omk.workspace-tree',
          classification: 'sensitive' as const,
          size: 1,
        },
      },
    })),
  };
}

describe('eval-runtime sample-scoped MCP config', () => {
  it('does not falsely certify MCP handling without exercising a config lease', async () => {
    const declaration = executor(provider(async () => ({ config: configA, close() {} })));
    await expect(checkExecutor({
      variant: {
        variantId: 'mcp-check',
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

  it('seals descriptors and per-sample overrides without opening a lease', async () => {
    const open = vi.fn<McpConfigProvider['open']>();
    const prepared = await prepareEvaluation(evaluationInput(
      executor(provider(open)),
      { default: descriptorA, bySampleId: { one: null, two: descriptorB } },
    ));

    expect(open).not.toHaveBeenCalled();
    expect(prepared.definition.targets[0]).toMatchObject({
      executionRequirements: { mcp: 'native-config' },
      executionControls: {
        defaults: { mcp: { mcpMode: 'native-config', descriptor: descriptorA } },
        sampleOverrides: [
          { sampleId: 'one', mcp: { mcpMode: 'not-required' } },
          { sampleId: 'two', mcp: { mcpMode: 'native-config', descriptor: descriptorB } },
        ],
      },
    });
    expect(prepared.resolvedRuntimes.find((entry) => entry.runtimeKind === 'executor')
      ?.identity.capabilities).toMatchObject({
        protocols: [{ execution: { features: { mcp: ['native-config'] } } }],
      });
  });

  it('preserves a stateful provider owner while freezing the captured open method', async () => {
    const statefulProvider: McpConfigProvider & {
      config: JsonValue;
      open: McpConfigProvider['open'];
    } = {
      providerId: 'test.stateful-mcp-provider/v1',
      version: '1.0.0',
      config: configA,
      async open() {
        return { config: this.config, close() {} };
      },
    };
    const prepared = await prepareEvaluation(evaluationInput(executor(statefulProvider)));
    statefulProvider.open = async () => ({ config: configB, close() {} });

    const result = await prepared.run({ runId: 'mcp-stateful-provider' });

    expect(result.status).toBe('completed');
  });

  it('opens one config lease per trial, reuses it across retries, and closes exactly once', async () => {
    const requests: McpConfigOpenRequest[] = [];
    const closed: string[] = [];
    const accesses: Array<{ trial: number; attempt: number; config: JsonValue | undefined }> = [];
    let sequence = 0;
    const declaration = executor(provider(async (request) => {
      requests.push(structuredClone(request));
      const leaseId = `lease-${sequence += 1}`;
      return { config: configA, close: () => { closed.push(leaseId); } };
    }), async ({ trialIndex, attemptNumber, input, mcpConfig }) => {
      accesses.push({ trial: trialIndex, attempt: attemptNumber, config: mcpConfig?.config });
      return attemptNumber === 1 ? { errorCode: 'temporary-mcp-failure' } : { output: input };
    });

    const result = await evaluate(evaluationInput(declaration, descriptorA, true), {
      runId: 'mcp-retry-run',
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(accesses).toHaveLength(4);
    expect(accesses.every(({ config }) => canonicalizeJson(config) === canonicalizeJson(configA)))
      .toBe(true);
    expect(closed).toHaveLength(2);
    expect(new Set(closed).size).toBe(2);
    expect(JSON.stringify(result)).not.toContain('secret-a');
  });

  it('binds descriptor and provider identity to the affected execution coordinates', async () => {
    const first = await prepareEvaluation(evaluationInput(executor(provider(async () => ({
      config: configA, close() {},
    })))));
    const same = await prepareEvaluation(evaluationInput(executor(provider(async () => ({
      config: configA, close() {},
    })))));
    const providerChanged = await prepareEvaluation(evaluationInput(executor(provider(async () => ({
      config: configA, close() {},
    }), '2.0.0'))));
    const sampleChanged = await prepareEvaluation(evaluationInput(
      executor(provider(async () => ({ config: configA, close() {} }))),
      { default: descriptorA, bySampleId: { two: descriptorB } },
    ));
    const coordinates = (prepared: typeof first) => derivePlannedExecutionCoordinates(prepared.plan)
      .map(({ sampleId, executionCoordinateDigest }) => ({ sampleId, executionCoordinateDigest }));

    expect(first.planDigest).toBe(same.planDigest);
    expect(first.planDigest).not.toBe(providerChanged.planDigest);
    expect(coordinates(first).find(({ sampleId }) => sampleId === 'one')).toEqual(
      coordinates(sampleChanged).find(({ sampleId }) => sampleId === 'one'),
    );
    expect(coordinates(first).find(({ sampleId }) => sampleId === 'two')
      ?.executionCoordinateDigest).not.toBe(
        coordinates(sampleChanged).find(({ sampleId }) => sampleId === 'two')
          ?.executionCoordinateDigest,
      );

    const disabled = await prepareEvaluation(evaluationInput(
      executor(provider(async () => ({ config: configA, close() {} }))),
      { default: descriptorA, bySampleId: { two: null } },
    ));
    const disabledProviderChanged = await prepareEvaluation(evaluationInput(
      executor(provider(async () => ({ config: configA, close() {} }), '2.0.0')),
      { default: descriptorA, bySampleId: { two: null } },
    ));
    expect(coordinates(disabled).find(({ sampleId }) => sampleId === 'two')
      ?.executionCoordinateDigest).not.toBe(
        coordinates(disabledProviderChanged).find(({ sampleId }) => sampleId === 'two')
          ?.executionCoordinateDigest,
      );
  });

  it('cancels a pending materialization and closes late MCP plus opened workspace leases', async () => {
    let resolveConfig!: (lease: { config: JsonValue; close(): void }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = new Promise<{ config: JsonValue; close(): void }>((resolve) => {
      resolveConfig = resolve;
    });
    const workspaceClose = vi.fn();
    const mcpClose = vi.fn();
    const declaration: Executor<string, undefined, string> = {
      ...executor(provider(async ({ signal }) => {
        expect(signal.aborted).toBe(false);
        markStarted();
        return pending;
      })),
      workspaceProvider: {
        providerId: 'test.workspace-provider/v1',
        version: '1.0.0',
        async open() {
          return { root: '/virtual/mcp-cancellation', close: workspaceClose };
        },
      },
    };
    const controller = new AbortController();
    const evaluating = evaluate(singleSampleWorkspaceInput(declaration), {
      runId: 'mcp-materialization-cancellation',
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error('cancelled-with-secret-marker'));

    const result = await evaluating;
    expect(result.status).toBe('cancelled');
    expect(workspaceClose).toHaveBeenCalledTimes(1);
    resolveConfig({ config: configA, close: mcpClose });
    await vi.waitFor(() => expect(mcpClose).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(result)).not.toContain('secret-marker');
  });

  it('does not lose an abort triggered synchronously inside provider open', async () => {
    const controller = new AbortController();
    const workspaceClose = vi.fn();
    const execute = vi.fn<Executor<string, undefined, string>['execute']>();
    const declaration: Executor<string, undefined, string> = {
      ...executor(provider(async () => {
        controller.abort(new Error('synchronous-provider-abort'));
        return new Promise(() => undefined);
      }), execute),
      workspaceProvider: {
        providerId: 'test.sync-abort-workspace/v1',
        version: '1.0.0',
        async open() {
          return { root: '/virtual/mcp-sync-abort', close: workspaceClose };
        },
      },
    };

    const result = await evaluate(singleSampleWorkspaceInput(declaration), {
      runId: 'mcp-sync-open-abort',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(workspaceClose).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('closes a lease that settles immediately before cancellation without invoking the Target', async () => {
    let resolveConfig!: (lease: { config: JsonValue; close(): void }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = new Promise<{ config: JsonValue; close(): void }>((resolve) => {
      resolveConfig = resolve;
    });
    const controller = new AbortController();
    const workspaceClose = vi.fn();
    const mcpClose = vi.fn();
    const execute = vi.fn<Executor<string, undefined, string>['execute']>();
    const declaration: Executor<string, undefined, string> = {
      ...executor(provider(async () => {
        markStarted();
        return pending;
      }), execute),
      workspaceProvider: {
        providerId: 'test.settle-abort-workspace/v1',
        version: '1.0.0',
        async open() {
          return { root: '/virtual/mcp-settle-abort', close: workspaceClose };
        },
      },
    };
    const evaluating = evaluate(singleSampleWorkspaceInput(declaration), {
      runId: 'mcp-settle-then-abort',
      signal: controller.signal,
    });
    await started;
    resolveConfig({ config: configA, close: mcpClose });
    controller.abort(new Error('settled-provider-abort'));

    const result = await evaluating;
    expect(result.status).toBe('cancelled');
    expect(mcpClose).toHaveBeenCalledTimes(1);
    expect(workspaceClose).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not open a Session when cancellation lands after config validation', async () => {
    const controller = new AbortController();
    const workspaceClose = vi.fn();
    const mcpClose = vi.fn();
    const openSession = vi.fn(async () => ({
      async execute() { return { output: 'unexpected' }; },
      close() {},
    }));
    const base = executor(provider(async () => ({
      get config() {
        queueMicrotask(() => controller.abort(new Error('post-validation-abort')));
        return configA;
      },
      close: mcpClose,
    })));
    const declaration: SessionExecutor<string, undefined, string> = {
      ...base,
      protocol: 'session',
      workspaceProvider: {
        providerId: 'test.session-abort-workspace/v1',
        version: '1.0.0',
        async open() {
          return { root: '/virtual/mcp-session-abort', close: workspaceClose };
        },
      },
      openSession,
    };

    const result = await evaluate(singleSampleWorkspaceInput(declaration), {
      runId: 'mcp-session-post-validation-abort',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(openSession).not.toHaveBeenCalled();
    expect(mcpClose).toHaveBeenCalledTimes(1);
    expect(workspaceClose).toHaveBeenCalledTimes(1);
  });

  it('fails closed on capability mismatches, unknown samples, and poisoned content', async () => {
    const noProvider = { ...executor(), capabilities: { mcp: 'native-config' as const } };
    await expect(prepareEvaluation(evaluationInput(noProvider)))
      .rejects.toBeInstanceOf(EvaluationConfigurationError);

    await expect(prepareEvaluation(evaluationInput(executor(provider(async () => ({
      config: configA, close() {},
    }))), { bySampleId: { unknown: descriptorA } })))
      .rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });

    const close = vi.fn();
    const result = await evaluate(evaluationInput(executor(provider(async () => ({
      config: configB,
      close,
    })))));
    expect(result.status).toBe('failed');
    expect(close).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('secret-b');
  });

  it('closes config after a Session failure and keeps it available for the full session', async () => {
    const cleanup: string[] = [];
    const base = executor(provider(async () => ({ config: configA, close() {} })));
    const declaration: SessionExecutor<string, undefined, string> = {
      ...base,
      protocol: 'session',
      mcpConfigProvider: provider(async ({ trialId }) => ({
        config: configA,
        close: () => { cleanup.push(`mcp:${trialId}`); },
      })),
      async openSession({ input, mcpConfig, trialId }) {
        expect(mcpConfig?.config).toEqual(configA);
        return {
          async execute() { return { output: input }; },
          close() {
            cleanup.push(`session:${trialId}`);
            throw new Error('private close failure');
          },
        };
      },
    };

    const result = await evaluate(evaluationInput(declaration));
    expect(result.status).toBe('failed');
    expect(cleanup.filter((entry) => entry.startsWith('session:'))).toHaveLength(2);
    expect(cleanup.filter((entry) => entry.startsWith('mcp:'))).toHaveLength(2);
  });
});
