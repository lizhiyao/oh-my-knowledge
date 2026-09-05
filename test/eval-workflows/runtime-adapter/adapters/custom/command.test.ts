import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
  digestCanonicalJson,
  type EvaluationDefinition,
  type ExecutorCapabilities,
  type JsonValue,
  type SchemaIdentity,
  type Sha256Digest,
  type TargetExecutionControls,
} from '../../../../../src/eval-core/contracts/index.js';
import {
  ExecutionPortFailure,
  InMemoryRuntimeEventSequencer,
  executeRunPlan,
  type ExecutionExecutor,
  type ExecutorAttemptResult,
  type ExecutorTrialContext,
} from '../../../../../src/eval-core/execution/index.js';
import {
  CUSTOM_COMMAND_EXCHANGE_SCHEMA_VERSION,
  createCustomCommandExecutorAdapter,
  type OmkBindingResourceLease,
  type OmkBindingResourceLeaseAccess,
  type RuntimeBindingOf,
} from '../../../../../src/eval-workflows/runtime-adapter/index.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from '../../../../eval-core/compiler/fixtures.js';
import { prepareEvaluationPlan } from '../../../../../src/eval-core/compiler/index.js';

const FIXTURE = fileURLToPath(new URL(
  '../../../../fixtures/custom-command-core-runtime.mjs',
  import.meta.url,
));

function digest(value: JsonValue): Sha256Digest {
  return digestCanonicalJson(value);
}

function schema(name: string): SchemaIdentity {
  return {
    schemaVersion: `test.omk.${name}/v1`,
    schemaUri: `urn:test:omk:${name}:v1`,
    schemaDigest: digest({ name }),
  };
}

function capabilities(): ExecutorCapabilities {
  return {
    schemaVersion: EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
    protocols: [{
      protocolId: 'omk.invoke/v1',
      inputSchema: schema('custom-command-input'),
      outputSchema: schema('custom-command-output'),
      traceSchema: schema('custom-command-trace'),
      execution: {
        concurrency: { safety: 'parallel-safe' },
        cancellation: 'best-effort',
        state: { resourceLifecycle: 'per-invocation', trialState: 'stateless' },
        seedControl: 'optional',
        determinism: 'unknown',
        features: {
          systemInstructions: 'unsupported',
          workspace: ['copy-on-write-overlay'],
          mcp: [],
          mockInterception: [],
          toolPolicies: ['allow-list', 'runtime-default'],
          skillDiscovery: ['runtime-default'],
          sandboxIds: [],
        },
        telemetry: { trace: 'optional', usage: 'optional' },
      },
    }],
  };
}

function resourceAccess(
  lease: OmkBindingResourceLease = Object.freeze({
    bindingId: 'executor-a',
    consumerKind: 'executor',
    resourcesByResourceId: new Map(),
  }),
): OmkBindingResourceLeaseAccess {
  return {
    forRun(runId) {
      expect(runId).toBe('run-a');
      return lease;
    },
  };
}

async function createAdapter(
  _workingDirectory: string,
  options: Readonly<{
    environment?: Readonly<Record<string, string>>;
    identityFile?: string | false;
    maxOutputBytes?: number;
    resourceLeases?: OmkBindingResourceLeaseAccess;
    executionControls?: TargetExecutionControls;
  }> = {},
): Promise<ExecutionExecutor> {
  const identityFile = options.identityFile === false ? undefined : options.identityFile ?? FIXTURE;
  const environment = Object.fromEntries(Object.entries(options.environment ?? {}).map(([
    key,
    value,
  ]) => [key, {
    value,
    identity: key === 'OMK_TEST_SECRET'
      ? { identityKind: 'credential' as const }
      : key.endsWith('_PATH')
        || key.endsWith('_STARTED')
        || key.endsWith('_CANCELLED')
        || key.endsWith('_INVOCATIONS')
        ? { identityKind: 'effect-locator' as const }
        : { identityKind: 'behavior' as const, value },
  }]));
  const executionControls: TargetExecutionControls = options.executionControls ?? {
    defaults: {
      workspace: { workspaceMode: 'not-required' },
      tools: { toolPolicyKind: 'runtime-default' },
      mcp: { mcpMode: 'not-required' },
    },
    sampleOverrides: [],
  };
  const workspaceRequirements = [
    executionControls.defaults.workspace,
    ...executionControls.sampleOverrides.flatMap((override) => (
      override.workspace === undefined ? [] : [override.workspace]
    )),
  ].flatMap((workspace) => workspace.workspaceMode === 'copy-on-write-overlay'
    ? [{
        resourceId: workspace.descriptor.resourceId,
        resourceRole: 'workspace' as const,
        leaseMode: 'copy-on-write-overlay' as const,
      }]
    : []);
  const resourceLeaseRequirements = [...new Map(workspaceRequirements.map((requirement) => (
    [requirement.resourceId, requirement]
  ))).values(), {
    resourceId: 'runtime-implementation-test',
    resourceRole: 'runtime-implementation' as const,
    leaseMode: 'immutable-snapshot' as const,
  }];
  const runtimeBytes = await readFile(process.execPath);
  const runtimeResource = Object.freeze({
    resourceId: 'runtime-implementation-test',
    resourceKind: 'runtime-implementation' as const,
    descriptor: {
      resourceId: 'runtime-implementation-test',
      digest: `sha256:${createHash('sha256').update(runtimeBytes).digest('hex')}` as Sha256Digest,
      mediaType: 'application/vnd.omk.custom-command-runtime',
      classification: 'sensitive' as const,
      size: runtimeBytes.byteLength,
    },
    snapshotKind: 'file' as const,
    leaseMode: 'immutable-snapshot' as const,
    snapshotPath: process.execPath,
  });
  const sourceResourceLeases = options.resourceLeases ?? resourceAccess();
  const resourceLeases: OmkBindingResourceLeaseAccess = {
    forRun(runId) {
      const source = sourceResourceLeases.forRun(runId);
      return Object.freeze({
        ...source,
        resourcesByResourceId: new Map([
          ...source.resourcesByResourceId,
          [runtimeResource.resourceId, runtimeResource] as const,
        ]),
      });
    },
  };
  const executionRequirements = {
    systemInstructions: 'not-required' as const,
    workspace: workspaceRequirements.length === 0
      ? 'not-required' as const
      : 'copy-on-write-overlay' as const,
    mcp: 'not-required' as const,
    mockInterception: 'not-required' as const,
    toolPolicy: [
      executionControls.defaults.tools,
      ...executionControls.sampleOverrides.flatMap((override) => (
        override.tools === undefined ? [] : [override.tools]
      )),
    ].some((tools) => tools.toolPolicyKind === 'allow-list')
      ? 'allow-list' as const
      : 'runtime-default' as const,
    skillDiscovery: 'runtime-default' as const,
  };
  const target: EvaluationDefinition['targets'][number] = {
    targetId: 'target-a',
    targetKind: 'function',
    protocolId: 'omk.invoke/v1',
    executorId: 'test.omk.custom-command/v1',
    executionRequirements,
    executionControls,
  };
  const binding: RuntimeBindingOf<'executor'> = {
    runtimeKind: 'executor',
    bindingId: 'executor-a',
    targetId: target.targetId,
    implementationId: target.executorId,
    protocolId: target.protocolId,
    behaviorConfigDigest: digest(null),
    executionControlsDigest: digest(executionControls),
    resourceLeaseRequirements,
    qualification: {
      model: 'custom-command',
      executionRequirements,
      resourceIntegrity: 'digest-before-use',
    },
  };
  return createCustomCommandExecutorAdapter({
    target,
    binding,
    runtime: {
      implementationId: 'test.omk.custom-command/v1',
      version: '1.0.0',
      capabilities: capabilities(),
      ...(identityFile === undefined ? {} : {
        contentIdentityFiles: [{ facetId: 'runtime-script', path: identityFile }],
      }),
    },
    command: {
      executablePath: process.execPath,
      arguments: [identityFile ?? FIXTURE],
      environment,
      ...(options.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: options.maxOutputBytes }),
    },
    sessionIsolationKey: 'binding-session-a',
    resourceLeases,
  });
}

async function execute(
  port: ExecutionExecutor,
  signal: AbortSignal = new AbortController().signal,
  executionControl: ExecutorTrialContext['executionControl'] = {
    workspace: { workspaceMode: 'not-required' },
    tools: { toolPolicyKind: 'runtime-default' },
    mcp: { mcpMode: 'not-required' },
  },
  sampleId = 'sample-a',
): Promise<ExecutorAttemptResult> {
  const run = await port.openRun({
    runId: 'run-a',
    executionPlanDigest: digest({ plan: 'a' }),
  });
  try {
    const trial = await run.openTrial({
      signal: new AbortController().signal,
      sampleId,
      targetId: 'target-a',
      executionCoordinateDigest: digest({ coordinate: 'a' }),
      executionControl,
      protocolId: 'omk.invoke/v1',
      input: { prompt: 'hello' },
      executionContext: { locale: 'zh-CN' },
      targetConfig: { model: 'test-model' },
      trialIndex: 0,
      trialId: digest({ trial: 'a' }),
      schedulingBlockId: digest({ block: 'a' }),
      samplingUnitIds: { clusterId: digest({ cluster: 'a' }) },
      trialSeed: digest({ seed: 'a' }),
    });
    try {
      return await trial.execute({
        attemptId: digest({ attempt: 'a' }),
        attemptNumber: 1,
        signal,
      });
    } finally {
      await trial.dispose();
    }
  } finally {
    await run.dispose();
  }
}

describe('custom-command Core Executor adapter', () => {
  it('uses content evidence conservatively and keeps secret environment values out of identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omk-custom-command-identity-'));
    const port = await createAdapter(cwd, {
      environment: { OMK_TEST_SECRET: 'do-not-persist-this-secret' },
    });

    expect(port.identity.fingerprintBasis).toBe('content-derived');
    expect(port.identity.assuranceLevel).toBe('declared');
    expect(port.identity.implementationManifest.coverageKind).toBe('fingerprint-plus-facets');
    expect(JSON.stringify(port.identity)).not.toContain('do-not-persist-this-secret');
    expect(JSON.stringify(port.identity)).not.toContain('OMK_TEST_SECRET');
    const credentialTaintedResult = await execute(port);
    expect(credentialTaintedResult.output?.classification).toBe('secret');
    expect(credentialTaintedResult.trace?.classification).toBe('secret');

    const rotatedCredential = await createAdapter(cwd, {
      environment: { OMK_TEST_SECRET: 'rotated-secret' },
    });
    expect(rotatedCredential.identity).toEqual(port.identity);
    const changedBehavior = await createAdapter(cwd, {
      environment: { OMK_TEST_EXPLICIT: 'behavior-a' },
    });
    const anotherBehavior = await createAdapter(cwd, {
      environment: { OMK_TEST_EXPLICIT: 'behavior-b' },
    });
    expect(changedBehavior.identity).not.toEqual(anotherBehavior.identity);

    const opaque = await createAdapter(cwd, { identityFile: false });
    expect(opaque.identity.fingerprintBasis).toBe('opaque');
    expect(opaque.identity.assuranceLevel).toBe('unknown');
  });

  it('sends a canonical source-neutral request without ambient env and preserves unknown usage', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omk-custom-command-request-'));
    const result = await execute(await createAdapter(cwd, {
      environment: { OMK_TEST_EXPLICIT: 'visible' },
    }));

    expect(result.output).toEqual({
      value: { echoed: { prompt: 'hello' } },
      classification: 'public',
    });
    expect(result.usage).toBeUndefined();
    expect(result.trace?.value).toMatchObject({
      inheritedHome: null,
      explicitValue: 'visible',
      request: {
        schemaVersion: CUSTOM_COMMAND_EXCHANGE_SCHEMA_VERSION,
        run: { runId: 'run-a' },
        trial: {
          targetId: 'target-a',
          executionContext: { locale: 'zh-CN' },
          targetConfig: { model: 'test-model' },
        },
        attempt: { attemptNumber: 1 },
        resources: [],
      },
    });
    const trace = result.trace?.value as { cwd?: unknown } | undefined;
    expect(trace?.cwd).toEqual(expect.stringContaining('omk-custom-command-run-'));
    expect(trace?.cwd).not.toBe(await realpath(cwd));
    expect(existsSync(trace?.cwd as string)).toBe(false);
  });

  it('passes real Core prepare and execution with identity unchanged and one process per attempt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omk-custom-command-core-'));
    const invocations = join(cwd, 'invocations.log');
    const port = await createAdapter(cwd, {
      environment: { OMK_TEST_INVOCATIONS: invocations },
    });
    const definition = validDefinition();
    definition.targets = [definition.targets[0]];
    definition.experiment.randomizationSlots = [definition.experiment.randomizationSlots[0]];
    if (definition.experiment.assignment.assignmentKind === 'complete-block') {
      definition.experiment.assignment.randomizationSlotIds = [
        definition.experiment.randomizationSlots[0].randomizationSlotId,
      ];
    }
    definition.comparisons = [];
    const policy = validPolicy();
    delete policy.execution.timeoutMs;
    policy.retry.maxAttempts = 1;
    policy.evidence.trace = 'full';
    const runtime = testRuntime();
    runtime.resolveExecutor = () => ({
      identity: port.identity,
      satisfiesVersionConstraint: true,
    });
    const plan = await prepareEvaluationPlan(definition, policy, runtime);
    const bundle = await executeRunPlan(plan, {
      executorsByTargetId: new Map([['control', port]]),
      eventSequencer: new InMemoryRuntimeEventSequencer(),
      clock: {
        monotonicNow: () => performance.now(),
        timestamp: () => new Date().toISOString(),
        sleep: async (_delayMs, signal) => {
          if (signal.aborted) throw new Error('aborted');
        },
      },
    }, {
      runId: 'run-a',
      bundleId: 'bundle-custom-command',
    });

    expect(bundle.executionBundleStatus).toBe('completed');
    expect(bundle.records).toHaveLength(1);
    const [record] = bundle.records;
    expect(record.executionStatus).toBe('completed');
    if (record.executionStatus !== 'completed') throw new Error('Expected completed record.');
    expect(record.attempts[0].usage).toBeUndefined();
    expect(await readFile(invocations, 'utf8')).toBe('spawn\n');
  });

  it('forwards reported usage exactly and keeps structured child failures redacted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omk-custom-command-usage-'));
    const completed = await execute(await createAdapter(cwd, {
      environment: { OMK_TEST_USAGE: '1' },
    }));
    expect(completed.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });

    const empty = await execute(await createAdapter(cwd, {
      environment: { OMK_TEST_USAGE: 'empty' },
    }));
    expect(empty.usage).toBeUndefined();

    const failed = execute(await createAdapter(cwd, {
      environment: { OMK_TEST_MODE: 'failed', OMK_TEST_USAGE: '1' },
    }));
    await expect(failed).rejects.toMatchObject({
      evaluationError: {
        code: 'TEST_PROVIDER_UNAVAILABLE',
        stage: 'infrastructure',
        message: 'Custom-command Runtime reported a structured failure.',
      },
      usage: { inputTokens: 3 },
    });
  });

  it.each([
    ['invalid', 'OMK_CUSTOM_COMMAND_OUTPUT_INVALID'],
    ['exit', 'OMK_CUSTOM_COMMAND_EXIT_NONZERO'],
  ])('fails closed for %s output without leaking child diagnostics', async (mode, code) => {
    const cwd = await mkdtemp(join(tmpdir(), `omk-custom-command-${mode}-`));
    const promise = execute(await createAdapter(cwd, {
      environment: { OMK_TEST_MODE: mode },
    }));
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionPortFailure);
    expect((caught as ExecutionPortFailure).evaluationError.code).toBe(code);
    expect(JSON.stringify(caught)).not.toContain('sensitive-provider-diagnostic');
  });

  it('bounds stdout independently of Core timeout policy', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omk-custom-command-limit-'));
    await expect(execute(await createAdapter(cwd, {
      environment: { OMK_TEST_MODE: 'oversized' },
      maxOutputBytes: 256,
    }))).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CUSTOM_COMMAND_OUTPUT_LIMIT_EXCEEDED' },
    });
  });

  it('reverifies declared implementation bytes before every spawn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omk-custom-command-reverify-'));
    const script = join(cwd, 'runtime.mjs');
    const invocations = join(cwd, 'invocations.log');
    await copyFile(FIXTURE, script);
    const port = await createAdapter(cwd, {
      identityFile: script,
      environment: { OMK_TEST_INVOCATIONS: invocations },
    });
    await appendFile(script, '\n// changed after assembly\n');

    await expect(execute(port)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CUSTOM_COMMAND_IDENTITY_CHANGED' },
    });
    expect(existsSync(invocations)).toBe(false);
  });

  it('projects only verified leases and runs inside the requested workspace overlay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-custom-command-workspace-'));
    const baseSnapshotPath = join(root, 'base');
    const overlayPath = join(root, 'overlay');
    await mkdir(baseSnapshotPath);
    await mkdir(overlayPath);
    const workspace = Object.freeze({
      resourceId: 'workspace-a',
      resourceKind: 'workspace' as const,
      descriptor: {
        resourceId: 'workspace-a',
        digest: digest({ workspace: 'a' }),
        mediaType: 'application/vnd.omk.workspace-tree',
        classification: 'sensitive' as const,
        size: 0,
      },
      snapshotKind: 'directory' as const,
      leaseMode: 'copy-on-write-overlay' as const,
      baseSnapshotPath,
      overlayPath,
    });
    const lease = Object.freeze({
      bindingId: 'executor-a',
      consumerKind: 'executor' as const,
      resourcesByResourceId: new Map([['workspace-a', workspace]]),
    });
    const result = await execute(await createAdapter(root, {
      resourceLeases: resourceAccess(lease),
      executionControls: {
        defaults: {
          workspace: {
            workspaceMode: 'copy-on-write-overlay',
            descriptor: workspace.descriptor,
          },
          tools: { toolPolicyKind: 'runtime-default' },
          mcp: { mcpMode: 'not-required' },
        },
        sampleOverrides: [],
      },
    }), new AbortController().signal, {
      workspace: {
        workspaceMode: 'copy-on-write-overlay',
        descriptor: workspace.descriptor,
      },
      tools: { toolPolicyKind: 'runtime-default' },
      mcp: { mcpMode: 'not-required' },
    });

    expect(result.trace?.value).toMatchObject({
      cwd: await realpath(overlayPath),
      request: {
        resources: [{
          resourceId: 'workspace-a',
          leaseMode: 'copy-on-write-overlay',
          baseSnapshotPath,
          overlayPath,
        }],
      },
    });
  });

  it('projects only the current Trial workspace and tool policy from an aggregate lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-custom-command-sample-controls-'));
    const workspace = async (suffix: 'a' | 'b') => {
      const baseSnapshotPath = join(root, `base-${suffix}`);
      const overlayPath = join(root, `overlay-${suffix}`);
      await mkdir(baseSnapshotPath);
      await mkdir(overlayPath);
      return Object.freeze({
        resourceId: `workspace-${suffix}`,
        resourceKind: 'workspace' as const,
        descriptor: {
          resourceId: `workspace-${suffix}`,
          digest: digest({ workspace: suffix }),
          mediaType: 'application/vnd.omk.workspace-tree',
          classification: 'sensitive' as const,
          size: 0,
        },
        snapshotKind: 'directory' as const,
        leaseMode: 'copy-on-write-overlay' as const,
        baseSnapshotPath,
        overlayPath,
      });
    };
    const [workspaceA, workspaceB] = await Promise.all([workspace('a'), workspace('b')]);
    const lease = Object.freeze({
      bindingId: 'executor-a',
      consumerKind: 'executor' as const,
      resourcesByResourceId: new Map([
        [workspaceA.resourceId, workspaceA],
        [workspaceB.resourceId, workspaceB],
      ]),
    });
    const controlA = {
      workspace: {
        workspaceMode: 'copy-on-write-overlay' as const,
        descriptor: workspaceA.descriptor,
      },
      tools: { toolPolicyKind: 'allow-list' as const, allowedTools: ['read'] },
      mcp: { mcpMode: 'not-required' as const },
    };
    const controlB = {
      workspace: {
        workspaceMode: 'copy-on-write-overlay' as const,
        descriptor: workspaceB.descriptor,
      },
      tools: { toolPolicyKind: 'allow-list' as const, allowedTools: ['shell'] },
      mcp: { mcpMode: 'not-required' as const },
    };
    const port = await createAdapter(root, {
      resourceLeases: resourceAccess(lease),
      executionControls: {
        defaults: controlA,
        sampleOverrides: [{ sampleId: 'sample-b', ...controlB }],
      },
    });
    const resultA = await execute(port, new AbortController().signal, {
      ...controlA,
    });
    const resultB = await execute(port, new AbortController().signal, {
      ...controlB,
    }, 'sample-b');

    expect(resultA.trace?.value).toMatchObject({
      cwd: await realpath(workspaceA.overlayPath),
      request: {
        trial: {
          executionControl: {
            tools: { toolPolicyKind: 'allow-list', allowedTools: ['read'] },
          },
        },
        resources: [{ resourceId: workspaceA.resourceId }],
      },
    });
    expect(resultB.trace?.value).toMatchObject({
      cwd: await realpath(workspaceB.overlayPath),
      request: {
        trial: {
          executionControl: {
            tools: { toolPolicyKind: 'allow-list', allowedTools: ['shell'] },
          },
        },
        resources: [{ resourceId: workspaceB.resourceId }],
      },
    });
    expect(JSON.stringify(resultA.trace?.value)).not.toContain(workspaceB.overlayPath);
    expect(JSON.stringify(resultB.trace?.value)).not.toContain(workspaceA.overlayPath);
    await expect(execute(port, new AbortController().signal, controlB, 'sample-a'))
      .rejects.toMatchObject({
        evaluationError: { code: 'OMK_CUSTOM_COMMAND_EXECUTION_CONTROL_MISMATCH' },
      });
  });

  it('delivers the Core AbortSignal to the child and waits for termination', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omk-custom-command-cancel-'));
    const started = join(cwd, 'started');
    const cancelled = join(cwd, 'cancelled');
    const controller = new AbortController();
    const promise = execute(await createAdapter(cwd, {
      environment: {
        OMK_TEST_MODE: 'wait',
        OMK_TEST_STARTED: started,
        OMK_TEST_CANCELLED: cancelled,
      },
    }), controller.signal);
    const outcome = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => expect(existsSync(started)).toBe(true));
    controller.abort('test-cancel');

    expect(await outcome).toMatchObject({
      error: {
        evaluationError: { code: 'OMK_CUSTOM_COMMAND_CANCELLED' },
      },
    });
    expect(await readFile(cancelled, 'utf8')).toBe('cancelled');
  });

  it('does not spawn when the Core signal is already aborted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omk-custom-command-pre-abort-'));
    const invocations = join(cwd, 'invocations.log');
    const controller = new AbortController();
    controller.abort('already-cancelled');

    await expect(execute(await createAdapter(cwd, {
      environment: { OMK_TEST_INVOCATIONS: invocations },
    }), controller.signal)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CUSTOM_COMMAND_CANCELLED' },
    });
    expect(existsSync(invocations)).toBe(false);
  });

  it('defers ephemeral run cleanup until a racing live trial is released', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-custom-command-dispose-race-'));
    const port = await createAdapter(root);
    const run = await port.openRun({
      runId: 'run-a',
      executionPlanDigest: digest({ plan: 'dispose-race' }),
    });
    const trial = await run.openTrial({
      signal: new AbortController().signal,
      sampleId: 'sample-a',
      targetId: 'target-a',
      executionCoordinateDigest: digest({ coordinate: 'dispose-race' }),
      executionControl: {
        workspace: { workspaceMode: 'not-required' },
        tools: { toolPolicyKind: 'runtime-default' },
        mcp: { mcpMode: 'not-required' },
      },
      protocolId: 'omk.invoke/v1',
      input: { prompt: 'hello' },
      trialIndex: 0,
      trialId: digest({ trial: 'dispose-race' }),
      schedulingBlockId: digest({ block: 'dispose-race' }),
      samplingUnitIds: {},
    });
    const result = await trial.execute({
      attemptId: digest({ attempt: 'dispose-race' }),
      attemptNumber: 1,
      signal: new AbortController().signal,
    });
    const trace = result.trace?.value as { cwd: string };

    await run.dispose();
    expect(existsSync(trace.cwd)).toBe(true);
    await trial.dispose();
    expect(existsSync(trace.cwd)).toBe(false);
  });

  it('rejects analysis-only gold resources before spawning', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omk-custom-command-gold-'));
    const payload = join(cwd, 'gold.json');
    const invocations = join(cwd, 'invocations.log');
    await writeFile(payload, '{}');
    const lease = Object.freeze({
      bindingId: 'executor-a',
      consumerKind: 'executor' as const,
      resourcesByResourceId: new Map([['gold-a', Object.freeze({
        resourceId: 'gold-a',
        resourceKind: 'gold-dataset' as const,
        descriptor: {
          resourceId: 'gold-a',
          digest: digest({ gold: 'a' }),
          mediaType: 'application/json',
          classification: 'gold' as const,
          size: 2,
        },
        snapshotKind: 'file' as const,
        leaseMode: 'immutable-snapshot' as const,
        snapshotPath: payload,
      })]]),
    });
    const port = await createAdapter(cwd, {
      environment: { OMK_TEST_INVOCATIONS: invocations },
      resourceLeases: resourceAccess(lease),
    });

    await expect(execute(port)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CUSTOM_COMMAND_RESOURCE_FORBIDDEN' },
    });
    expect(existsSync(invocations)).toBe(false);
  });
});
