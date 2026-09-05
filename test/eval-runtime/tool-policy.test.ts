import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { derivePlannedExecutionCoordinates } from '../../src/eval-core/contracts/index.js';
import {
  EvaluationConfigurationError,
  checkExecutor,
  evaluate,
  prepareEvaluation,
  type AllowedToolsInput,
  type Executor,
  type SessionExecutor,
} from '../../src/eval-runtime/index.js';

function executor(
  execute?: Executor<string, undefined, string>['execute'],
  supportsAllowList = true,
): Executor<string, undefined, string> {
  return {
    executorId: 'test.tool-policy-executor/v1',
    version: '1.0.0',
    schemas: { input: z.string(), output: z.string() },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      ...(supportsAllowList ? { toolPolicy: 'allow-list' as const } : {}),
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    execute: execute ?? (async ({ input, signal }) => {
      signal.throwIfAborted();
      return { output: input };
    }),
  };
}

function evaluationInput(
  declaration: Executor<string, undefined, string> | SessionExecutor<string, undefined, string>,
  allowedTools?: AllowedToolsInput,
  retry = false,
) {
  return {
    dataset: {
      datasetId: 'tool-policy-evaluation',
      samples: [
        { sampleId: 'one', input: 'one', expected: 'one' },
        { sampleId: 'two', input: 'two', expected: 'two' },
      ],
    },
    variants: [{
      variantId: 'tool-policy-variant',
      artifact: {
        name: 'tool-policy-agent',
        kind: 'agent' as const,
        source: 'inline' as const,
        content: 'Use only the tools granted for this sample.',
      },
      execution: {
        executor: declaration,
        ...(allowedTools === undefined ? {} : { allowedTools }),
      },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' as const }],
    comparisons: [],
    analyses: [{
      analysisId: 'tool-policy-correct-rate',
      analysisKind: 'summary' as const,
      statistic: 'rate' as const,
      variantId: 'tool-policy-variant',
      metricId: 'correct',
    }],
    experiment: {
      seed: 'tool-policy-seed',
      sampling: { samplingKind: 'solo' as const },
    },
    policy: retry ? {
      execution: {
        maxConcurrency: 2,
        retry: {
          maxAttempts: 2,
          retryableErrorCodes: ['temporary-tool-failure'],
          backoff: { backoffKind: 'none' as const },
        },
      },
    } : {},
  };
}

describe('eval-runtime tool policy', () => {
  it('seals exact sample-scoped allow-lists without unioning them', async () => {
    const prepared = await prepareEvaluation(evaluationInput(executor(), {
      default: ['Read', 'Grep'],
      bySampleId: { two: [], one: null },
    }));

    expect(prepared.definition.targets[0]).toMatchObject({
      executionRequirements: { toolPolicy: 'allow-list' },
      executionControls: {
        defaults: {
          tools: { toolPolicyKind: 'allow-list', allowedTools: ['Grep', 'Read'] },
        },
        sampleOverrides: [
          { sampleId: 'one', tools: { toolPolicyKind: 'runtime-default' } },
          { sampleId: 'two', tools: { toolPolicyKind: 'allow-list', allowedTools: [] } },
        ],
      },
    });
    const runtime = prepared.resolvedRuntimes.find((entry) => entry.runtimeKind === 'executor');
    expect(runtime?.identity.capabilities).toMatchObject({
      protocols: [{
        execution: { features: { toolPolicies: ['allow-list', 'runtime-default'] } },
      }],
    });
  });

  it('merges independent workspace and tool overrides without dropping either field', async () => {
    const descriptor = {
      resourceId: 'tool-policy-workspace',
      digest: `sha256:${'a'.repeat(64)}`,
      mediaType: 'application/vnd.omk.workspace-tree',
      classification: 'sensitive' as const,
      size: 1,
    };
    const declaration = {
      ...executor(),
      workspaceProvider: {
        providerId: 'test.tool-policy-workspace/v1',
        version: '1.0.0',
        async open() { return { root: '/virtual/tool-policy', close() {} }; },
      },
    };
    const base = evaluationInput(declaration, {
      default: ['Read'],
      bySampleId: { one: [] },
    });
    const prepared = await prepareEvaluation({
      ...base,
      variants: [{
        ...base.variants[0],
        execution: {
          ...base.variants[0]!.execution,
          workspace: { default: descriptor, bySampleId: { two: null } },
        },
      }],
    });

    expect(prepared.definition.targets[0]?.executionControls.sampleOverrides).toEqual([
      { sampleId: 'one', tools: { toolPolicyKind: 'allow-list', allowedTools: [] } },
      { sampleId: 'two', workspace: { workspaceMode: 'not-required' } },
    ]);
  });

  it('passes only the effective list to each trial and keeps it stable across retries', async () => {
    const invocations: Array<{
      sampleId: string;
      attemptNumber: number;
      allowedTools?: readonly string[];
    }> = [];
    const declaration = executor(async ({ input, sampleId, attemptNumber, allowedTools }) => {
      invocations.push({
        sampleId,
        attemptNumber,
        ...(allowedTools === undefined ? {} : { allowedTools: [...allowedTools] }),
      });
      return attemptNumber === 1
        ? { errorCode: 'temporary-tool-failure' }
        : { output: input };
    });

    const result = await evaluate(evaluationInput(declaration, {
      bySampleId: { one: ['Read'], two: [] },
    }, true));

    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(invocations).toHaveLength(4);
    expect(invocations.filter(({ sampleId }) => sampleId === 'one')).toEqual([
      { sampleId: 'one', attemptNumber: 1, allowedTools: ['Read'] },
      { sampleId: 'one', attemptNumber: 2, allowedTools: ['Read'] },
    ]);
    expect(invocations.filter(({ sampleId }) => sampleId === 'two')).toEqual([
      { sampleId: 'two', attemptNumber: 1, allowedTools: [] },
      { sampleId: 'two', attemptNumber: 2, allowedTools: [] },
    ]);
  });

  it('passes the effective list once when opening an isolated Session', async () => {
    const opened: Array<{ sampleId: string; allowedTools?: readonly string[] }> = [];
    const declaration: SessionExecutor<string, undefined, string> = {
      ...executor(),
      protocol: 'session',
      async openSession({ input, sampleId, allowedTools }) {
        opened.push({
          sampleId,
          ...(allowedTools === undefined ? {} : { allowedTools: [...allowedTools] }),
        });
        return {
          async execute() { return { output: input }; },
          close() {},
        };
      },
    };

    const result = await evaluate(evaluationInput(declaration, {
      default: ['Read'],
      bySampleId: { two: null },
    }));

    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(opened.sort((left, right) => left.sampleId.localeCompare(right.sampleId))).toEqual([
      { sampleId: 'one', allowedTools: ['Read'] },
      { sampleId: 'two' },
    ]);
  });

  it('fails before execution when the Executor cannot enforce an allow-list', async () => {
    await expect(prepareEvaluation(evaluationInput(executor(undefined, false), ['Read'])))
      .rejects.toEqual(expect.objectContaining({
        code: 'EVAL_RUNTIME_VARIANT_INVALID',
      } satisfies Partial<EvaluationConfigurationError>));
  });

  it('does not falsely certify allow-list enforcement without a tool-policy probe', async () => {
    const declaration = executor(async ({ input }) => (
      input === 'failure'
        ? { errorCode: 'expected-failure' }
        : { output: input }
    ));
    await expect(checkExecutor({
      variant: {
        variantId: 'tool-policy-check',
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

  it('rejects ambiguous or ineffective plans instead of widening authority', async () => {
    const declaration = executor();
    await expect(prepareEvaluation(evaluationInput(declaration, ['Read', 'Read'])))
      .rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });
    await expect(prepareEvaluation(evaluationInput(declaration, {
      bySampleId: { unknown: ['Read'] },
    }))).rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });
    await expect(prepareEvaluation(evaluationInput(declaration, {
      bySampleId: { one: null },
    }))).rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });
  });

  it('canonicalizes list order and changes only an affected coordinate identity', async () => {
    const declaration = executor();
    const first = await prepareEvaluation(evaluationInput(declaration, ['Read', 'Grep']));
    const reordered = await prepareEvaluation(evaluationInput(declaration, ['Grep', 'Read']));
    const changed = await prepareEvaluation(evaluationInput(declaration, {
      default: ['Grep', 'Read'],
      bySampleId: { two: ['Write'] },
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

  it('captures caller-owned lists before they can be mutated', async () => {
    const defaultTools = ['Read'];
    const sampleTools = ['Grep'];
    const prepared = await prepareEvaluation(evaluationInput(executor(), {
      default: defaultTools,
      bySampleId: { two: sampleTools },
    }));
    defaultTools.push('Write');
    sampleTools.push('Shell');

    expect(prepared.definition.targets[0]?.executionControls).toMatchObject({
      defaults: { tools: { allowedTools: ['Read'] } },
      sampleOverrides: [{ sampleId: 'two', tools: { allowedTools: ['Grep'] } }],
    });
  });
});
