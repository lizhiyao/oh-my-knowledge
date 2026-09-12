import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JsonValue } from '../../../src/eval-core/contracts/index.js';
import {
  CODEX_CLI_MIN_SUPPORTED_VERSION,
  CODEX_CLI_REFERENCE_ADAPTER_VERSION,
  DEFAULT_CODEX_CLI_REFERENCE_PROBE_TIMEOUT_MS,
  createCodexCliReferenceExecutor,
  type CodexCliEnvironmentEntry,
  type CreateCodexCliReferenceExecutorInput,
} from '../../../src/eval-workflows/hosts/reference-executors.js';
import {
  DEFAULT_CODEX_CLI_MAX_PROMPT_BYTES,
} from '../../../src/eval-workflows/hosts/adapters/codex/cli.js';
import {
  CODEX_CLI_RESOURCE_PROFILE,
  codexPromptEnvelopeText,
} from '../../../src/eval-workflows/hosts/adapters/codex/resources.js';
import {
  checkExecutor,
  type Artifact,
  type Executor,
  type ExecutorInvocation,
  type Variant,
} from '../../../src/eval-runtime/index.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/codex-cli-core-runtime.mjs', import.meta.url));

const ARTIFACT_CONTENT = '# Skill\nAnswer with the fixture rule.';
const CREDENTIAL = 'sk-vendor-credential-must-not-leak';
const FAILED_USAGE = {
  inputTokens: 8,
  outputTokens: 5,
  totalTokens: 13,
  details: { cachedInputTokens: 3, reasoningOutputTokens: 2 },
};

type FacetDocument = Readonly<Record<string, JsonValue>>;

interface CapturedVendorCall {
  readonly args: string[];
  readonly cwd: string;
  readonly prompt: string | null;
  readonly inheritedHome: string | null;
  readonly explicit: string | null;
}

function facets(executor: { readonly fingerprintFacets?: JsonValue }): FacetDocument {
  return executor.fingerprintFacets as FacetDocument;
}

function codexFacet(executor: { readonly fingerprintFacets?: JsonValue }): FacetDocument {
  return facets(executor).codexCli as FacetDocument;
}

function environment(
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, CodexCliEnvironmentEntry>> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    value,
    identity: key.includes('SECRET')
      ? { identityKind: 'credential' as const }
      : key.endsWith('_CAPTURE') || key.endsWith('_INVOCATIONS')
        ? { identityKind: 'effect-locator' as const }
        : { identityKind: 'behavior' as const, value },
  }]));
}

const createdRoots: string[] = [];

interface VendorFixture {
  readonly root: string;
  readonly executablePath: string;
  readonly capturePath: string;
  readonly invocationLog: string;
  readonly env: Readonly<Record<string, CodexCliEnvironmentEntry>>;
}

async function vendor(
  overrides: Readonly<Record<string, string>> = {},
): Promise<VendorFixture> {
  const root = await mkdtemp(join(tmpdir(), 'omk-codex-reference-test-'));
  createdRoots.push(root);
  const executablePath = join(root, 'codex');
  await copyFile(FIXTURE, executablePath);
  await chmod(executablePath, 0o755);
  const capturePath = join(root, 'capture.json');
  const invocationLog = join(root, 'invocations.log');
  return {
    root,
    executablePath,
    capturePath,
    invocationLog,
    env: environment({
      PATH: dirname(process.execPath),
      HOME: '/home/vendor-account',
      CODEX_SESSION_SECRET: CREDENTIAL,
      OMK_TEST_MODE: 'success',
      OMK_TEST_CAPTURE: capturePath,
      OMK_TEST_INVOCATIONS: invocationLog,
      ...overrides,
    }),
  };
}

async function assemble(
  fixture: VendorFixture,
  overrides: Readonly<Partial<CreateCodexCliReferenceExecutorInput>> = {},
): Promise<Executor<JsonValue, undefined, string, JsonValue>> {
  return createCodexCliReferenceExecutor({
    executorId: 'vendor.codex-cli/reference',
    executablePath: fixture.executablePath,
    model: 'gpt-fixture',
    environment: fixture.env,
    ...overrides,
  });
}

function artifact(overrides: Readonly<Partial<Artifact>> = {}): Artifact {
  return {
    name: 'skill-under-test',
    kind: 'skill',
    source: 'inline',
    content: ARTIFACT_CONTENT,
    ...overrides,
  };
}

function invocation(
  overrides: Readonly<Partial<ExecutorInvocation<JsonValue, undefined>>> = {},
): Readonly<ExecutorInvocation<JsonValue, undefined>> {
  return {
    input: { prompt: 'one' },
    artifact: artifact(),
    config: undefined,
    sampleId: 'sample-1',
    variantId: 'candidate',
    trialIndex: 0,
    attemptNumber: 1,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function capturedCall(fixture: VendorFixture): Promise<CapturedVendorCall> {
  return JSON.parse(await readFile(fixture.capturePath, 'utf8')) as CapturedVendorCall;
}

function digestOf(path: string): Promise<string> {
  return readFile(path).then((content) => (
    `sha256:${createHash('sha256').update(content).digest('hex')}`
  ));
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe('Codex CLI reference Executor', () => {
  it('derives complete measurement identity from the probed vendor', async () => {
    const fixture = await vendor();
    const helperPath = join(fixture.root, 'helper.sh');
    await writeFile(helperPath, '#!/bin/sh\necho helper\n');
    const executableContent = await readFile(fixture.executablePath);
    const helperContent = await readFile(helperPath);

    const executor = await assemble(fixture, {
      effort: 'high',
      sandbox: 'workspace-write',
      contentIdentityFiles: [{ facetId: 'codex-helper', path: helperPath }],
      fingerprintFacets: { deployment: 'platform-host' },
    });

    expect(executor.executorId).toBe('vendor.codex-cli/reference');
    expect(executor.version).toBe(CODEX_CLI_MIN_SUPPORTED_VERSION);
    expect(executor.outputMediaType).toBe('text/plain');
    expect(executor.traceMediaType).toBe('application/vnd.omk.source-neutral-trace+json');
    // A credential entry raises the handling floor for both output and trace.
    expect(executor.outputClassification).toBe('secret');
    expect(executor.traceClassification).toBe('secret');
    expect(executor.capabilities).toEqual({
      determinism: 'stochastic',
      cancellation: 'best-effort',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      telemetry: {
        trace: 'optional',
        usage: 'optional',
        providerCost: { reporting: 'unsupported' },
      },
    });

    expect(facets(executor).deployment).toBe('platform-host');
    const declared = codexFacet(executor);
    expect(declared.adapter).toEqual({
      adapterVersion: CODEX_CLI_REFERENCE_ADAPTER_VERSION,
      seam: 'eval-runtime-facade',
      sourceProtocol: 'codex exec --json',
      cancellation: 'sigterm-then-sigkill',
      processIsolation: 'per-attempt',
    });
    expect(declared['version-floor']).toEqual({
      minSupportedVersion: CODEX_CLI_MIN_SUPPORTED_VERSION,
      probeTimeoutMs: DEFAULT_CODEX_CLI_REFERENCE_PROBE_TIMEOUT_MS,
    });
    expect(declared.runtime).toEqual({
      model: 'gpt-fixture',
      effort: 'high',
      sandbox: 'workspace-write',
    });
    expect(declared.binary).toEqual({
      coverage: 'declared-files-reverified-before-spawn',
      files: [
        {
          facetId: 'codex-executable',
          digest: await digestOf(fixture.executablePath),
          size: executableContent.byteLength,
        },
        {
          facetId: 'codex-helper',
          digest: await digestOf(helperPath),
          size: helperContent.byteLength,
        },
      ],
    });
    expect(declared['fixed-controls']).toEqual({
      approvalPolicy: 'never',
      configMode: 'strict-ignore-user-config',
      rules: 'ignored',
      session: 'ephemeral',
      shellEnvironmentInheritance: 'none',
      workspaceRoot: 'attempt-private-temp-directory',
    });
    expect(declared['input-projection']).toEqual({
      version: 'omk.codex-cli-prompt/v1',
      promptSchemaVersion: CODEX_CLI_RESOURCE_PROFILE.promptSchemaVersion,
      artifact: 'content-string-only',
      envelope: 'canonical-json',
      executionContext: 'executionContext-field',
      task: 'sample-input-verbatim',
    });
    expect(declared.limits).toEqual({
      maxOutputBytes: 10 * 1024 * 1024,
      maxPromptBytes: DEFAULT_CODEX_CLI_MAX_PROMPT_BYTES,
    });
    expect((declared.launcher as FacetDocument).executablePathDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    const entries = (declared.environment as FacetDocument).entries as readonly FacetDocument[];
    expect(entries.map((entry) => entry.identityKind)).toContain('credential');
    // Runtime identity stays free of carrier content and secret values.
    expect(JSON.stringify(executor.fingerprintFacets)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(executor.fingerprintFacets)).not.toContain(ARTIFACT_CONTENT);
  });

  it('separates measurement identity when the pinned runtime or binary differs', async () => {
    const fixture = await vendor();
    const baseline = await assemble(fixture);
    const otherModel = await assemble(fixture, { model: 'gpt-fixture-2' });
    const withEffort = await assemble(fixture, { effort: 'low' });
    const otherSandbox = await assemble(fixture, { sandbox: 'workspace-write' });
    const copiedFixture = await vendor();
    const copied = await assemble(copiedFixture);

    expect(codexFacet(otherModel).runtime).not.toEqual(codexFacet(baseline).runtime);
    expect(codexFacet(withEffort).runtime).not.toEqual(codexFacet(baseline).runtime);
    expect(codexFacet(otherSandbox).runtime).not.toEqual(codexFacet(baseline).runtime);
    expect(codexFacet(otherModel).launcher).toEqual(codexFacet(baseline).launcher);
    // A byte-identical copy elsewhere keeps binary identity and changes the launcher facet.
    expect(codexFacet(copied).binary).toEqual(codexFacet(baseline).binary);
    expect(codexFacet(copied).launcher).not.toEqual(codexFacet(baseline).launcher);
    expect(copied.version).toBe(baseline.version);
  });

  it('keeps the knowledge carrier in the prompt envelope and the attempt directory private', async () => {
    const fixture = await vendor({ OMK_TEST_MODE: 'conformance' });
    const executor = await assemble(fixture);

    const result = await executor.execute(invocation({
      executionContext: { dispatchedBy: 'platform-host' },
    }));

    expect(result.errorCode).toBeUndefined();
    expect(result.output).toBe('answer:one');
    const captured = await capturedCall(fixture);
    expect(captured.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(captured.args).toContain('--ephemeral');
    expect(captured.args).toContain('--ignore-user-config');
    expect(captured.args).toContain('--ignore-rules');
    expect(captured.args).toContain('--strict-config');
    expect(captured.args).toContain('--skip-git-repo-check');
    expect(captured.args).toEqual(expect.arrayContaining([
      '--color', 'never',
      '--sandbox', 'read-only',
      '-c', 'approval_policy="never"',
      '-c', 'shell_environment_policy.inherit="none"',
      '--model', 'gpt-fixture',
    ]));
    // The attempt-private directory is both the vendor working directory and the process cwd.
    const attemptDir = captured.args[captured.args.indexOf('-C') + 1];
    // The child reports its cwd with the temp-root symlink resolved.
    expect(basename(attemptDir)).toBe(basename(captured.cwd));
    expect(await realpath(dirname(attemptDir))).toBe(dirname(captured.cwd));
    expect(captured.args[captured.args.lastIndexOf('--') + 1]).toBe(captured.prompt);
    // The child sees exactly the declared environment instead of process.env.
    expect(captured.inheritedHome).toBe('/home/vendor-account');
    // Both seams render the same bytes, so switching seams cannot move the input projection.
    expect(captured.prompt).toBe(codexPromptEnvelopeText(
      CODEX_CLI_RESOURCE_PROFILE,
      {
        knowledgeArtifact: { artifactKind: 'file', instructions: ARTIFACT_CONTENT },
        executionContext: { dispatchedBy: 'platform-host' },
        task: { prompt: 'one' },
      },
      DEFAULT_CODEX_CLI_MAX_PROMPT_BYTES,
    ));
    expect(captured.cwd).not.toBe(fixture.root);
    expect(existsSync(captured.cwd)).toBe(false);
  });

  it('gives every attempt a clean directory instead of a leaked trial state', async () => {
    const fixture = await vendor({ OMK_TEST_MODE: 'workspace-state' });
    const executor = await assemble(fixture);

    const first = await executor.execute(invocation());
    const second = await executor.execute(invocation({ trialIndex: 1, attemptNumber: 2 }));

    expect(first).toMatchObject({ output: 'clean' });
    expect(second).toMatchObject({ output: 'clean' });
  });

  it('projects only the carriers this seam can hand to the vendor', async () => {
    const fixture = await vendor({ OMK_TEST_MODE: 'conformance' });
    const executor = await assemble(fixture);

    const baseline = await executor.execute(invocation({
      artifact: artifact({ kind: 'baseline', content: null }),
    }));
    expect(baseline.output).toBe('answer:one');
    const prompt = String((await capturedCall(fixture)).prompt);
    const envelope = JSON.parse(prompt.slice(prompt.indexOf('{'))) as FacetDocument;
    expect(envelope.knowledgeArtifact).toBeUndefined();
    expect(envelope.task).toEqual({ prompt: 'one' });

    for (const carrier of [
      artifact({ kind: 'baseline', content: '   ' }),
      artifact({ kind: 'skill', content: null }),
      artifact({ kind: 'agent', content: '' }),
    ]) {
      expect(await executor.execute(invocation({ artifact: carrier }))).toEqual({
        errorCode: 'OMK_CODEX_CLI_ARTIFACT_UNSUPPORTED',
      });
    }
    // Only the accepted baseline reached the vendor.
    expect((await readFile(fixture.invocationLog, 'utf8')).trim()).toBe('exec');
  });

  it('refuses controlled resources it cannot lease', async () => {
    const fixture = await vendor();
    const executor = await assemble(fixture);
    const cases: ReadonlyArray<readonly [
      Readonly<Partial<ExecutorInvocation<JsonValue, undefined>>>,
      string,
    ]> = [
      [
        { workspace: { descriptor: { mediaType: 'application/json' }, root: '/tmp/leased' } as never },
        'OMK_CODEX_CLI_ISOLATION_UNSUPPORTED',
      ],
      [
        { mcpConfig: { descriptor: {}, config: {} } as never },
        'OMK_CODEX_CLI_ISOLATION_UNSUPPORTED',
      ],
      [
        { mockInterception: { descriptor: {} } as never },
        'OMK_CODEX_CLI_ISOLATION_UNSUPPORTED',
      ],
      [{ allowedTools: ['read'] }, 'OMK_CODEX_CLI_TOOL_POLICY_UNSUPPORTED'],
      [{ allowedTools: [] }, 'OMK_CODEX_CLI_TOOL_POLICY_UNSUPPORTED'],
      [
        { runtimeContext: { values: { skill: 'x' } } },
        'OMK_CODEX_CLI_RUNTIME_CONTEXT_UNSUPPORTED',
      ],
    ];
    for (const [override, errorCode] of cases) {
      expect(await executor.execute(invocation(override)), JSON.stringify(override)).toEqual({
        errorCode,
      });
    }
    // Failing closed means the vendor process never starts.
    expect(existsSync(fixture.invocationLog)).toBe(false);
  });

  it('reports stable codes without leaking provider detail', async () => {
    const cases: ReadonlyArray<readonly [Readonly<Record<string, string>>, JsonValue, string]> = [
      [
        { OMK_TEST_MODE: 'exit' },
        { errorCode: 'OMK_CODEX_CLI_EXIT_NONZERO' },
        'sensitive provider failure',
      ],
      [
        { OMK_TEST_MODE: 'invalid' },
        { errorCode: 'OMK_CODEX_CLI_PROTOCOL_INVALID' },
        'not-json',
      ],
      [
        { OMK_TEST_MODE: 'failed' },
        { errorCode: 'OMK_CODEX_CLI_TURN_FAILED' },
        'sensitive failure detail',
      ],
      [
        { OMK_TEST_MODE: 'failed-usage' },
        { errorCode: 'OMK_CODEX_CLI_TURN_FAILED', usage: FAILED_USAGE },
        'sensitive failure detail',
      ],
      [
        { OMK_TEST_MODE: 'upgrade-required' },
        { errorCode: 'OMK_CODEX_CLI_UPGRADE_REQUIRED' },
        'private-model',
      ],
    ];
    for (const [overrides, expected, secret] of cases) {
      const fixture = await vendor(overrides);
      const executor = await assemble(fixture);

      const result = await executor.execute(invocation());

      expect(result, JSON.stringify(overrides)).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
    }

    const oversized = await vendor({ OMK_TEST_MODE: 'oversized' });
    const capped = await assemble(oversized, { maxOutputBytes: 64 });
    expect(await capped.execute(invocation())).toEqual({
      errorCode: 'OMK_CODEX_CLI_OUTPUT_LIMIT_EXCEEDED',
    });
  });

  it('refuses to invent an answer when the stream has no valid terminal event', async () => {
    const fixture = await vendor({ OMK_TEST_MODE: 'missing-thread' });
    const executor = await assemble(fixture);

    expect(await executor.execute(invocation())).toEqual({
      errorCode: 'OMK_CODEX_CLI_PROTOCOL_INVALID',
    });
  });

  it('keeps reported usage and a schema-valid trace on a successful attempt', async () => {
    const fixture = await vendor({ OMK_TEST_MODE: 'usage' });
    const executor = await assemble(fixture);

    const result = await executor.execute(invocation());

    expect(result.output).toBe('fixture answer');
    expect(result.usage).toEqual(FAILED_USAGE);
    const trace = result.trace;
    expect(trace).toBeDefined();
    expect(executor.schemas?.trace?.parse(trace)).toEqual(trace);
    expect(() => executor.schemas?.trace?.parse({ unexpected: true })).toThrow(z.ZodError);
  });

  it('escalates cancellation to the vendor process and rethrows the host reason', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-codex-cancel-'));
    createdRoots.push(root);
    const fixture = await vendor({
      OMK_TEST_MODE: 'wait',
      OMK_TEST_CANCELLED: join(root, 'cancelled'),
    });
    const executor = await assemble(fixture);
    const controller = new AbortController();
    const reason = new Error('host cancelled the attempt');
    setTimeout(() => controller.abort(reason), 200);

    await expect(executor.execute(invocation({ signal: controller.signal })))
      .rejects.toBe(reason);
    // The helper sends SIGTERM first, so the vendor sees a cooperative cancellation.
    expect(existsSync(join(root, 'cancelled'))).toBe(true);
  });

  it('releases the attempt directory when the vendor exits unsuccessfully', async () => {
    const fixture = await vendor({ OMK_TEST_MODE: 'exit' });
    const executor = await assemble(fixture);

    expect(await executor.execute(invocation())).toEqual({
      errorCode: 'OMK_CODEX_CLI_EXIT_NONZERO',
    });
    expect(existsSync((await capturedCall(fixture)).cwd)).toBe(false);
  });

  it('detects a tampered implementation before spawning', async () => {
    const fixture = await vendor();
    const executor = await assemble(fixture);
    await writeFile(fixture.executablePath, '#!/usr/bin/env node\nconsole.log("tampered")\n');

    expect(await executor.execute(invocation())).toEqual({
      errorCode: 'OMK_CODEX_CLI_IDENTITY_CHANGED',
    });
    expect(existsSync(fixture.invocationLog)).toBe(false);
  });

  it('keeps a credential entry at secret handling when the host declares a lower taint', async () => {
    const fixture = await vendor();
    const executor = await assemble(fixture, {
      environment: {
        ...fixture.env,
        CODEX_SESSION_SECRET: {
          value: CREDENTIAL,
          outputTaint: 'sensitive',
          identity: { identityKind: 'credential' },
        },
      },
    });

    // A declared taint raises handling; it cannot talk a credential down below its own role.
    expect(executor.outputClassification).toBe('secret');
    expect(executor.traceClassification).toBe('secret');
  });

  it('refuses an effort outside the published enum before probing the vendor', async () => {
    const fixture = await vendor();
    // A non-executable binary makes any spawn fail loudly, so reaching the effort diagnostic
    // proves assembly rejected the declaration before the version probe ran.
    await chmod(fixture.executablePath, 0o644);
    for (const effort of ['definitely-invalid', '', 'HIGH', 'xHigh', null, 3]) {
      await expect(createCodexCliReferenceExecutor({
        executorId: 'vendor.codex-cli/reference',
        executablePath: fixture.executablePath,
        model: 'gpt-fixture',
        environment: fixture.env,
        effort: effort as never,
      })).rejects.toThrow(/effort must be low, medium, high, xhigh, or max/);
    }
    expect(existsSync(fixture.invocationLog)).toBe(false);

    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const pinned = await assemble(await vendor(), { effort });
      expect(codexFacet(pinned).runtime).toEqual({
        model: 'gpt-fixture',
        effort,
        sandbox: 'read-only',
      });
    }
  });

  it('admits only vendor releases at or above the frozen protocol floor', async () => {
    const above = await assemble(await vendor({ OMK_TEST_VERSION_OUTPUT: 'codex-cli 0.147.0' }));
    expect(above.version).toBe('0.147.0');

    await expect(assemble(await vendor({ OMK_TEST_VERSION_OUTPUT: 'codex-cli 0.145.9' })))
      .rejects.toThrow(new RegExp(`below the supported floor ${CODEX_CLI_MIN_SUPPORTED_VERSION}`));
    // Comparison is numeric, so a shorter major version is not read as above the floor.
    await expect(assemble(await vendor({ OMK_TEST_VERSION_OUTPUT: 'codex-cli 0.9.0' })))
      .rejects.toThrow(/below the supported floor/);
    await expect(assemble(await vendor({ OMK_TEST_VERSION_OUTPUT: 'codex-cli 0.146.0-alpha.1' })))
      .rejects.toThrow(/unsupported version format/);
    await expect(assemble(await vendor({ OMK_TEST_VERSION_OUTPUT: 'codex-cli nightly' })))
      .rejects.toThrow(/unsupported version format/);
    await expect(assemble(await vendor({ OMK_TEST_VERSION_OUTPUT: 'codex-cli 0.146.0 (build 9)' })))
      .rejects.toThrow(/invalid version/);
    // A rejected token is vendor stdout, so the diagnostic names the expected shape, not the value.
    const rejected = await assemble(await vendor({
      OMK_TEST_VERSION_OUTPUT: `codex-cli ${CREDENTIAL}`,
    })).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(TypeError);
    expect((rejected as TypeError).message).toMatch(/unsupported version format/);
    expect((rejected as TypeError).message).not.toContain(CREDENTIAL);
  });

  it('rejects declarations that would fake identity or omit required pinning', async () => {
    const fixture = await vendor();
    const base = {
      executorId: 'vendor.codex-cli/reference',
      executablePath: fixture.executablePath,
      model: 'gpt-fixture',
      environment: fixture.env,
    } as const;

    await expect(createCodexCliReferenceExecutor({ ...base, executorId: '' }))
      .rejects.toThrow(TypeError);
    await expect(createCodexCliReferenceExecutor({ ...base, executablePath: 'codex' }))
      .rejects.toThrow(/absolute executablePath/);
    await expect(createCodexCliReferenceExecutor({
      ...base,
      executablePath: `${fixture.executablePath}\0`,
    })).rejects.toThrow(/absolute executablePath/);
    await expect(createCodexCliReferenceExecutor({ ...base, model: '   ' }))
      .rejects.toThrow(/non-empty model/);
    await expect(createCodexCliReferenceExecutor({
      ...base,
      sandbox: 'danger-full-access' as 'read-only',
    })).rejects.toThrow(/read-only or workspace-write/);
    await expect(createCodexCliReferenceExecutor({
      ...base,
      executablePath: join(fixture.root, 'absent'),
    })).rejects.toThrow(/identity file "codex-executable" is unavailable/);
    await expect(createCodexCliReferenceExecutor({
      ...base,
      fingerprintFacets: { codexCli: { model: 'spoofed' } },
    })).rejects.toThrow(/reserves the codexCli fingerprint facet/);
    await expect(createCodexCliReferenceExecutor({
      ...base,
      fingerprintFacets: ['deployment'] as unknown as Record<string, JsonValue>,
    })).rejects.toThrow(/must be a JSON object/);
    await expect(createCodexCliReferenceExecutor({ ...base, maxOutputBytes: 0 }))
      .rejects.toThrow(/maxOutputBytes must be a positive safe integer/);
    await expect(createCodexCliReferenceExecutor({ ...base, identityProbeTimeoutMs: Number.NaN }))
      .rejects.toThrow(/identityProbeTimeoutMs must be a positive safe integer/);
    await expect(createCodexCliReferenceExecutor({
      ...base,
      environment: { PATH: { value: '/usr/bin' } as never },
    })).rejects.toThrow(z.ZodError);
  });

  it('publishes only the façade Executor shape', async () => {
    const executor = await assemble(await vendor());

    expect(Object.keys(executor).sort()).toEqual([
      'capabilities',
      'execute',
      'executorId',
      'fingerprintFacets',
      'outputClassification',
      'outputMediaType',
      'schemas',
      'traceClassification',
      'traceMediaType',
      'version',
    ]);
    expect(executor).not.toHaveProperty('workspaceProvider');
    expect(executor).not.toHaveProperty('mcpConfigProvider');
    expect(executor).not.toHaveProperty('mockInterceptionProvider');
    expect(Object.isFrozen(executor)).toBe(true);
  });

  it('passes the published runtime conformance gate', async () => {
    const fixture = await vendor({ OMK_TEST_MODE: 'conformance' });
    const executor = await assemble(fixture);
    const variant: Variant<JsonValue, undefined, string> = {
      variantId: 'candidate',
      artifact: artifact(),
      execution: { executor },
    };

    const result = await checkExecutor({
      variant,
      success: { input: { prompt: 'one' }, expected: 'answer:one' },
      failure: { input: { prompt: 'failure' }, expectedErrorCode: 'OMK_CODEX_CLI_EXIT_NONZERO' },
      cancellation: { input: { prompt: 'cancellation' } },
    });

    expect(result.conformant, JSON.stringify(result.checks)).toBe(true);
    expect(JSON.stringify(result.checks)).not.toContain('sensitive');
    expect(JSON.stringify(result.checks)).not.toContain(CREDENTIAL);
  });
});
