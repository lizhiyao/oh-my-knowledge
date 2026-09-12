import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUBPROCESS_COMMAND_MAX_OUTPUT_BYTES,
  SUBPROCESS_COMMAND_EXCHANGE_SCHEMA_VERSION,
  createSubprocessCommandExecutor,
  type SubprocessCommandConfiguration,
} from '../../../src/eval-runtime/advanced.js';
import {
  checkExecutor,
  type Artifact,
  type ExecutorInvocation,
  type Variant,
} from '../../../src/eval-runtime/index.js';

const CHILD_PATH = fileURLToPath(
  new URL('../fixtures/subprocess-command-child.mjs', import.meta.url),
);

const HOST_ONLY_ENVIRONMENT_KEY = 'OMK_HOST_ONLY_SENTINEL';
process.env[HOST_ONLY_ENVIRONMENT_KEY] = 'must-not-reach-the-child';

const artifact: Artifact = {
  name: 'prompt-under-test',
  kind: 'prompt',
  source: 'inline',
  content: 'Answer concisely.',
};

type EchoInput = {
  readonly query: string;
};

type EchoOutput = {
  readonly echoed: string;
  readonly artifactName: string;
  readonly sampleId: string;
  readonly variantId: string;
  readonly trialIndex: number;
  readonly attemptNumber: number;
  readonly allowedTools: string[] | null;
  readonly executionContext: Readonly<Record<string, string>> | null;
  readonly config: { readonly answers: Record<string, string> } | null;
};

type EchoTrace = {
  readonly environmentKeys: string[];
};

const outputSchema = z.object({
  echoed: z.string(),
  artifactName: z.string(),
  sampleId: z.string(),
  variantId: z.string(),
  trialIndex: z.number(),
  attemptNumber: z.number(),
  allowedTools: z.array(z.string()).nullable(),
  executionContext: z.record(z.string(), z.string()).nullable(),
  config: z.object({ answers: z.record(z.string(), z.string()) }).strict().nullable(),
}).strict();

const traceSchema = z.object({ environmentKeys: z.array(z.string()) }).strict();

function childCommand(
  mode: string,
  overrides: Readonly<Partial<SubprocessCommandConfiguration>> = {},
): SubprocessCommandConfiguration {
  return {
    executablePath: process.execPath,
    arguments: [CHILD_PATH],
    environment: { OMK_FIXTURE_MODE: mode },
    ...overrides,
  };
}

function echoExecutor(
  mode: string,
  overrides: Readonly<Partial<SubprocessCommandConfiguration>> = {},
) {
  return createSubprocessCommandExecutor<EchoInput, undefined, EchoOutput, EchoTrace>({
    executorId: 'test.subprocess-command/v1',
    version: '1.0.0',
    command: childCommand(mode, overrides),
    schemas: {
      input: z.object({ query: z.string() }).strict(),
      output: outputSchema,
      trace: traceSchema,
    },
  });
}

function invocation(
  overrides: Readonly<Partial<ExecutorInvocation<EchoInput, undefined>>> = {},
): Readonly<ExecutorInvocation<EchoInput, undefined>> {
  return {
    input: { query: 'hello' },
    artifact,
    config: undefined,
    sampleId: 'sample-1',
    variantId: 'candidate',
    trialIndex: 0,
    attemptNumber: 1,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('subprocess command Executor', () => {
  it('exchanges one canonical request per attempt and admits the child document', async () => {
    const executor = echoExecutor('echo');

    const result = await executor.execute(invocation({
      trialIndex: 2,
      attemptNumber: 3,
      trialSeed: 'seed-7',
      executionContext: { dispatchedBy: 'platform-host' },
      allowedTools: ['read'],
    }));

    expect(result.errorCode).toBeUndefined();
    if (result.errorCode !== undefined) return;
    expect(result.output).toEqual({
      echoed: 'hello',
      artifactName: artifact.name,
      sampleId: 'sample-1',
      variantId: 'candidate',
      trialIndex: 2,
      attemptNumber: 3,
      allowedTools: ['read'],
      executionContext: { dispatchedBy: 'platform-host' },
      config: null,
    });
    expect(result.usage).toEqual({ totalTokens: 7 });
    // Only PATH is inherited; macOS additionally injects __CF_USER_TEXT_ENCODING into every child.
    expect(result.trace?.environmentKeys.filter((key) => key !== '__CF_USER_TEXT_ENCODING'))
      .toEqual(['OMK_FIXTURE_MODE', 'PATH']);
    expect(result.trace?.environmentKeys).not.toContain(HOST_ONLY_ENVIRONMENT_KEY);
  });

  it('reports a child-declared structured failure without provider detail', async () => {
    const result = await echoExecutor('failed').execute(invocation());

    expect(result).toEqual({
      errorCode: 'OMK_FIXTURE_TARGET_UNAVAILABLE',
      usage: { totalTokens: 3 },
    });
  });

  it('fails closed on malformed, stale, extended, and output-less responses', async () => {
    for (const mode of ['malformed', 'stale-schema-version', 'unknown-field']) {
      const result = await echoExecutor(mode).execute(invocation());
      expect(result, mode).toEqual({ errorCode: 'OMK_SUBPROCESS_COMMAND_RESPONSE_INVALID' });
      expect(JSON.stringify(result)).not.toContain('provider-private detail');
    }

    expect(await echoExecutor('missing-output').execute(invocation())).toEqual({
      errorCode: 'OMK_SUBPROCESS_COMMAND_OUTPUT_INVALID',
    });
  });

  it('never surfaces child stderr and fails closed on a nonzero exit', async () => {
    const result = await echoExecutor('nonzero-exit').execute(invocation());

    expect(result).toEqual({ errorCode: 'OMK_SUBPROCESS_COMMAND_NONZERO_EXIT' });
    expect(JSON.stringify(result)).not.toContain('provider-private crash detail');
  });

  it('enforces the declared deadline and output byte cap', async () => {
    expect(await echoExecutor('slow', { timeoutMs: 300 }).execute(invocation())).toEqual({
      errorCode: 'OMK_SUBPROCESS_COMMAND_TIMEOUT',
    });
    expect(await echoExecutor('noisy', { maxOutputBytes: 4096 }).execute(invocation())).toEqual({
      errorCode: 'OMK_SUBPROCESS_COMMAND_OUTPUT_LIMIT',
    });
    expect(DEFAULT_SUBPROCESS_COMMAND_MAX_OUTPUT_BYTES).toBe(10 * 1024 * 1024);
  });

  it('settles when a descendant keeps the stdio pipes open after the child exits', async () => {
    const startedAt = Date.now();

    const result = await echoExecutor('descendant-holds-pipes').execute(invocation());

    expect(result).toMatchObject({ output: { echoed: 'hello' } });
    // The grandchild holds the pipes for 3000ms, so waiting for 'close' would outlast this bound.
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('enforces the deadline even when the child never releases the pipes', async () => {
    const startedAt = Date.now();

    expect(await echoExecutor('descendant-and-hang', { timeoutMs: 300 }).execute(invocation()))
      .toEqual({ errorCode: 'OMK_SUBPROCESS_COMMAND_TIMEOUT' });
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const startedAt = Date.now();

    expect(await echoExecutor('ignore-sigterm', { timeoutMs: 200 }).execute(invocation()))
      .toEqual({ errorCode: 'OMK_SUBPROCESS_COMMAND_TIMEOUT' });
    // The child ignores SIGTERM and would otherwise sleep for 10s.
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('counts stderr against the byte cap without surfacing it', async () => {
    expect(await echoExecutor('stderr-noisy', { maxOutputBytes: 4096 }).execute(invocation()))
      .toEqual({ errorCode: 'OMK_SUBPROCESS_COMMAND_OUTPUT_LIMIT' });
  });

  it('reports a spawn failure instead of hanging when the executable does not exist', async () => {
    const executor = createSubprocessCommandExecutor<EchoInput, undefined, EchoOutput>({
      executorId: 'test.subprocess-command/v1',
      version: '1.0.0',
      command: { executablePath: '/nonexistent/omk-subprocess-fixture' },
      schemas: {
        input: z.object({ query: z.string() }).strict(),
        output: outputSchema,
      },
    });

    expect(await executor.execute(invocation())).toEqual({
      errorCode: 'OMK_SUBPROCESS_COMMAND_SPAWN_FAILED',
    });
  });

  it('rejects a child that writes anything besides the exchange document to stdout', async () => {
    expect(await echoExecutor('stdout-noise').execute(invocation())).toEqual({
      errorCode: 'OMK_SUBPROCESS_COMMAND_RESPONSE_INVALID',
    });
  });

  it('propagates cancellation instead of admitting partial output', async () => {
    const controller = new AbortController();
    const reason = new Error('host cancelled the attempt');
    setTimeout(() => controller.abort(reason), 100);

    await expect(
      echoExecutor('slow', { timeoutMs: 30_000 }).execute(invocation({ signal: controller.signal })),
    ).rejects.toBe(reason);
  });

  it('refuses leased isolation it cannot hand to a child process', async () => {
    const workspace = { descriptor: { mediaType: 'application/json' }, root: '/tmp/leased' };

    expect(await echoExecutor('echo').execute(invocation({
      workspace: workspace as never,
    }))).toEqual({ errorCode: 'OMK_SUBPROCESS_COMMAND_ISOLATION_UNSUPPORTED' });
    expect(await echoExecutor('echo').execute(invocation({
      mcpConfig: { descriptor: {}, config: {} } as never,
    }))).toEqual({ errorCode: 'OMK_SUBPROCESS_COMMAND_ISOLATION_UNSUPPORTED' });
    expect(await echoExecutor('echo').execute(invocation({
      mockInterception: { descriptor: {} } as never,
    }))).toEqual({ errorCode: 'OMK_SUBPROCESS_COMMAND_ISOLATION_UNSUPPORTED' });
  });

  it('rejects exchanged values the declared parsers transform or do not declare', async () => {
    const transforming = createSubprocessCommandExecutor<EchoInput, undefined, EchoOutput>({
      executorId: 'test.subprocess-command/v1',
      version: '1.0.0',
      command: childCommand('env-probe'),
      schemas: {
        input: z.object({ query: z.string() }).strict(),
        output: outputSchema.transform((value) => ({ ...value, echoed: value.echoed.toUpperCase() })),
      },
    });
    expect(await transforming.execute(invocation())).toEqual({
      errorCode: 'OMK_SUBPROCESS_COMMAND_OUTPUT_INVALID',
      usage: { totalTokens: 7 },
    });

    const withoutTrace = createSubprocessCommandExecutor<EchoInput, undefined, EchoOutput>({
      executorId: 'test.subprocess-command/v1',
      version: '1.0.0',
      command: childCommand('undeclared-trace'),
      schemas: {
        input: z.object({ query: z.string() }).strict(),
        output: outputSchema,
      },
    });
    expect(await withoutTrace.execute(invocation())).toEqual({
      errorCode: 'OMK_SUBPROCESS_COMMAND_TRACE_INVALID',
      usage: { totalTokens: 7 },
    });
  });

  it('decodes a child document whose multibyte characters straddle read boundaries', async () => {
    type ChunkedOutput = { readonly echoed: string };
    const executor = createSubprocessCommandExecutor<EchoInput, undefined, ChunkedOutput>({
      executorId: 'test.subprocess-command/v1',
      version: '1.0.0',
      command: childCommand('byte-chunked'),
      schemas: {
        input: z.object({ query: z.string() }).strict(),
        output: z.object({ echoed: z.string() }).strict(),
      },
    });

    expect(await executor.execute(invocation())).toEqual({
      output: { echoed: '知识改动有据可依' },
    });
  });

  it('fingers the command in the identity facets and stays honest about capabilities', () => {
    const executor = echoExecutor('echo');
    const facets = executor.fingerprintFacets as Readonly<Record<string, string>>;

    expect(SUBPROCESS_COMMAND_EXCHANGE_SCHEMA_VERSION).toBe('omk.subprocess-command-exchange/v1');
    expect(facets.command).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(executor.capabilities).toEqual({
      determinism: 'unknown',
      cancellation: 'best-effort',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      telemetry: { trace: 'optional', usage: 'optional' },
    });

    const otherArguments = echoExecutor('echo', { arguments: [CHILD_PATH, '--other'] });
    expect((otherArguments.fingerprintFacets as Record<string, string>).command)
      .not.toBe(facets.command);

    const declared = createSubprocessCommandExecutor<EchoInput, undefined, EchoOutput>({
      executorId: 'test.subprocess-command/v1',
      version: '1.0.0',
      command: childCommand('echo'),
      schemas: { input: z.object({ query: z.string() }).strict(), output: outputSchema },
      capabilities: { determinism: 'deterministic', cancellation: 'cooperative' },
      fingerprintFacets: { deployment: 'platform-host' },
    });
    expect(declared.capabilities).toMatchObject({
      determinism: 'deterministic',
      cancellation: 'cooperative',
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'optional' },
    });
    expect(declared.capabilities?.mcp).toBeUndefined();
    expect(declared.capabilities?.mockInterception).toBeUndefined();
    expect((declared.fingerprintFacets as Record<string, unknown>).deployment).toBe('platform-host');
  });

  it('rejects declarations that claim isolation or omit required parsers', () => {
    const base = {
      executorId: 'test.subprocess-command/v1',
      command: childCommand('echo'),
      schemas: { input: z.object({ query: z.string() }).strict(), output: outputSchema },
    } as const;

    expect(() => createSubprocessCommandExecutor({ ...base, version: '  ' }))
      .toThrow(TypeError);
    expect(() => createSubprocessCommandExecutor({
      ...base,
      version: '1.0.0',
      capabilities: { mcp: 'native-config' },
    })).toThrow(TypeError);
    expect(() => createSubprocessCommandExecutor({
      ...base,
      version: '1.0.0',
      capabilities: { mockInterception: 'pre-tool-call' },
    })).toThrow(TypeError);
    expect(() => createSubprocessCommandExecutor({
      ...base,
      version: '1.0.0',
      fingerprintFacets: ['deployment'],
    })).toThrow(TypeError);
    expect(() => createSubprocessCommandExecutor({
      ...base,
      version: '1.0.0',
      command: { executablePath: 'child\0' },
    })).toThrow(z.ZodError);
  });

  it('validates a declared config before spawning and forwards it unchanged', async () => {
    type EchoConfig = {
      readonly answers: Record<string, string>;
    };
    const withConfig = createSubprocessCommandExecutor<EchoInput, EchoConfig, EchoOutput>({
      executorId: 'test.subprocess-command/v1',
      version: '1.0.0',
      // Unreachable on purpose: a spawn would report SPAWN_FAILED, not a config rejection.
      command: { executablePath: `${CHILD_PATH}.missing` },
      schemas: {
        input: z.object({ query: z.string() }).strict(),
        config: z.object({ answers: z.record(z.string(), z.string()) }).strict(),
        output: outputSchema,
      },
    });

    expect(await withConfig.execute({ ...invocation(), config: undefined as never })).toEqual({
      errorCode: 'EVAL_RUNTIME_EXECUTOR_TARGET_CONFIG_INVALID',
    });
    expect(await withConfig.execute({ ...invocation(), config: { answers: 3 } as never })).toEqual({
      errorCode: 'EVAL_RUNTIME_EXECUTOR_TARGET_CONFIG_INVALID',
    });

    const reachable = createSubprocessCommandExecutor<EchoInput, EchoConfig, EchoOutput>({
      executorId: 'test.subprocess-command/v1',
      version: '1.0.0',
      command: childCommand('env-probe'),
      schemas: {
        input: z.object({ query: z.string() }).strict(),
        config: z.object({ answers: z.record(z.string(), z.string()) }).strict(),
        output: outputSchema,
      },
    });
    const forwarded = await reachable.execute({
      ...invocation(),
      config: { answers: { one: 'A' } },
    });

    expect(forwarded.errorCode).toBeUndefined();
    if (forwarded.errorCode !== undefined) return;
    expect(forwarded.output?.config).toEqual({ answers: { one: 'A' } });
  });

  it('passes the published runtime conformance gate', async () => {
    type ConformanceInput = {
      readonly prompt: string;
    };
    const executor = createSubprocessCommandExecutor<ConformanceInput, undefined, string>({
      executorId: 'test.subprocess-command/v1',
      version: '1.0.0',
      command: childCommand('conformance'),
      schemas: {
        input: z.object({ prompt: z.string() }).strict(),
        output: z.string(),
      },
      outputClassification: 'public',
      // The seeded conformance definition requires seed control; the fixture child may ignore it.
      capabilities: { seedControl: 'optional' },
    });
    const variant: Variant<ConformanceInput, undefined, string> = {
      variantId: 'candidate',
      artifact,
      execution: { executor },
    };

    const result = await checkExecutor({
      variant,
      success: { input: { prompt: 'one' }, expected: 'A' },
      failure: { input: { prompt: 'failure' }, expectedErrorCode: 'OMK_FIXTURE_TARGET_UNAVAILABLE' },
      cancellation: { input: { prompt: 'cancellation' } },
    });

    expect(result.conformant, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.every((check) => check.checkStatus === 'passed')).toBe(true);
  });
});
