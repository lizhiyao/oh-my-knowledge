import {
  executeRunPlan,
} from '../../../../helpers/core-runs.js';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  digestCanonicalJson,
  schemaIdentityKey,
  type EvaluationDefinition,
  type JsonValue,
  type SchemaIdentity,
  type Sha256Digest,
} from '../../../../../src/eval-core/contracts/index.js';
import {
  InMemoryRuntimeEventSequencer,
  type ExecutionExecutor,
  type ExecutorAttemptResult,
  type ExecutorTrialContext,
} from '../../../../../src/eval-core/execution/index.js';
import { prepareEvaluationPlan } from '../../../../../src/eval-core/compiler/index.js';
import {
  CODEX_CLI_WORKSPACE_WRITE_SANDBOX_ID,
  createCodexCliCoreSchemaValidators,
} from '../../../../../src/eval-workflows/hosts/adapters/codex/cli-protocol.js';
import {
  buildCodexCliCoreArguments,
  createCodexCliExecutorAdapter,
  type CodexCliCoreConfiguration,
  type CodexCliEnvironmentEntry,
} from '../../../../../src/eval-workflows/hosts/adapters/codex/cli.js';
import {
  type OmkBindingResourceLease,
  type OmkBindingResourceLeaseAccess,
  type OmkLeasedHostResource,
} from '../../../../../src/eval-workflows/hosts/resource-leases/types.js';
import {
  type RuntimeBindingOf,
} from '../../../../../src/eval-workflows/hosts/types.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from '../../../../eval-core/compiler/fixtures.js';

const FIXTURE = fileURLToPath(new URL(
  '../../../../fixtures/codex-cli-core-runtime.mjs',
  import.meta.url,
));

function digest(value: JsonValue): Sha256Digest {
  return digestCanonicalJson(value);
}

interface AdapterFixture {
  readonly root: string;
  readonly executablePath: string;
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly resourceAccess: OmkBindingResourceLeaseAccess;
}

async function adapterFixture(options: Readonly<{
  artifact?: string;
  systemInstructions?: 'required' | 'not-required';
  workspace?: boolean;
  sandboxId?: string;
  allowedTools?: readonly string[];
  artifactDirectory?: Readonly<Record<string, string>>;
  leasedArtifactResourceId?: string;
}> = {}): Promise<AdapterFixture> {
  const root = await mkdtemp(join(tmpdir(), 'omk-codex-core-test-'));
  const executablePath = join(root, 'codex-fixture.mjs');
  await copyFile(FIXTURE, executablePath);
  await chmod(executablePath, 0o755);
  const artifact = options.artifact ?? '# Knowledge\nUse the fixture rule.';
  const artifactPath = options.artifactDirectory === undefined
    ? join(root, 'artifact.md')
    : join(root, 'artifact');
  if (options.artifactDirectory === undefined) await writeFile(artifactPath, artifact);
  else {
    await mkdir(artifactPath);
    for (const [path, content] of Object.entries(options.artifactDirectory)) {
      const destination = join(artifactPath, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
  }
  const artifactDescriptor = {
    resourceId: 'artifact-a',
    digest: digest(options.artifactDirectory === undefined
      ? { artifact }
      : { artifactDirectory: options.artifactDirectory }),
    mediaType: 'text/markdown',
    classification: 'public' as const,
    size: options.artifactDirectory === undefined
      ? Buffer.byteLength(artifact)
      : Object.values(options.artifactDirectory)
        .reduce((sum, content) => sum + Buffer.byteLength(content), 0),
  };
  const workspaceDescriptor = {
    resourceId: 'workspace-a',
    digest: digest({ workspace: 'a' }),
    mediaType: 'application/vnd.omk.workspace-tree',
    classification: 'sensitive' as const,
    size: 0,
  };
  const workspacePath = join(root, 'workspace');
  if (options.workspace) await mkdir(workspacePath);
  const config = {
    behavior: {
      artifact: artifactDescriptor,
      ...(options.sandboxId === undefined ? {} : { sandbox: { sandboxId: options.sandboxId } }),
    },
    runtime: { model: 'gpt-test', effort: 'high' as const },
  };
  const executionRequirements = {
    systemInstructions: options.systemInstructions ?? 'required',
    workspace: options.workspace ? 'copy-on-write-overlay' as const : 'not-required' as const,
    mcp: 'not-required' as const,
    mockInterception: 'not-required' as const,
    toolPolicy: options.allowedTools === undefined ? 'runtime-default' as const : 'allow-list' as const,
    skillDiscovery: 'runtime-default' as const,
    ...(options.sandboxId === undefined ? {} : { sandboxId: options.sandboxId }),
  };
  const target: EvaluationDefinition['targets'][number] = {
    targetId: 'target-a',
    targetKind: 'skill',
    protocolId: 'omk.invoke/v1',
    executorId: 'codex',
    executionRequirements,
    executionControls: {
      defaults: {
        workspace: options.workspace
          ? { workspaceMode: 'copy-on-write-overlay', descriptor: workspaceDescriptor }
          : { workspaceMode: 'not-required' },
        tools: options.allowedTools === undefined
          ? { toolPolicyKind: 'runtime-default' }
          : { toolPolicyKind: 'allow-list', allowedTools: [...options.allowedTools] },
        mcp: { mcpMode: 'not-required' },
        mockInterception: { mockInterceptionMode: 'not-required' },
      },
      sampleOverrides: [],
    },
    config,
  };
  const binding: RuntimeBindingOf<'executor'> = {
    runtimeKind: 'executor',
    bindingId: 'executor-target-a',
    targetId: 'target-a',
    implementationId: 'codex',
    protocolId: 'omk.invoke/v1',
    behaviorConfigDigest: digest(config),
    executionControlsDigest: digest(target.executionControls),
    resourceLeaseRequirements: [{
      resourceId: 'artifact-a',
      resourceRole: 'artifact',
      leaseMode: 'immutable-snapshot',
    }, ...(options.workspace ? [{
      resourceId: 'workspace-a',
      resourceRole: 'workspace' as const,
      leaseMode: 'copy-on-write-overlay' as const,
    }] : [])],
    qualification: {
      model: 'gpt-test',
      effort: 'high',
      executionRequirements,
      resourceIntegrity: 'digest-before-use',
    },
  };
  const lease: OmkBindingResourceLease = Object.freeze({
    bindingId: binding.bindingId,
    consumerKind: 'executor',
    resourcesByResourceId: new Map<string, OmkLeasedHostResource>([
      ['artifact-a', {
        resourceId: options.leasedArtifactResourceId ?? 'artifact-a',
        resourceKind: 'artifact' as const,
        descriptor: artifactDescriptor,
        snapshotKind: options.artifactDirectory === undefined
          ? 'file' as const
          : 'directory' as const,
        leaseMode: 'immutable-snapshot' as const,
        snapshotPath: artifactPath,
      }],
      ...(options.workspace ? [[
        'workspace-a',
        {
          resourceId: 'workspace-a',
          resourceKind: 'workspace' as const,
          descriptor: workspaceDescriptor,
          snapshotKind: 'directory' as const,
          leaseMode: 'copy-on-write-overlay' as const,
          baseSnapshotPath: workspacePath,

        },
      ] as const] : []),
    ]),
  });
  return {
    root,
    executablePath,
    target,
    binding,
    resourceAccess: {
      forRun(runId) {
        expect(runId).toBe('run-a');
        return lease;
      },
    },
  };
}

function environment(
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, CodexCliEnvironmentEntry>> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    value,
    identity: key === 'OMK_TEST_SECRET'
      ? { identityKind: 'credential' as const }
      : key.endsWith('_CAPTURE')
        || key.endsWith('_INVOCATIONS')
        || key.endsWith('_STARTED')
        || key.endsWith('_CANCELLED')
        ? { identityKind: 'effect-locator' as const }
        : { identityKind: 'behavior' as const, value },
  }]));
}

async function createAdapter(
  fixture: AdapterFixture,
  values: Readonly<Record<string, string>> = {},
  command: Partial<CodexCliCoreConfiguration> = {},
): Promise<ExecutionExecutor> {
  return createCodexCliExecutorAdapter({
    target: fixture.target,
    binding: fixture.binding,
    command: {
      executablePath: fixture.executablePath,
      environment: environment({
        PATH: dirname(process.execPath),
        ...values,
      }),
      ...command,
    },
    sessionIsolationKey: 'codex-session-a',
    resourceLeases: fixture.resourceAccess,
  });
}

async function execute(
  port: ExecutionExecutor,
  targetConfig: JsonValue,
  signal: AbortSignal = new AbortController().signal,
  executionControl: ExecutorTrialContext['executionControl'] = {
    workspace: { workspaceMode: 'not-required' },
    tools: { toolPolicyKind: 'runtime-default' },
    mcp: { mcpMode: 'not-required' },
    mockInterception: { mockInterceptionMode: 'not-required' },
  },
): Promise<ExecutorAttemptResult> {
  const run = await port.openRun({ runId: 'run-a', executionPlanDigest: digest({ plan: 'a' }) });
  const trial = await run.openTrial({
    signal: new AbortController().signal,
    sampleId: 'sample-a',
    targetId: 'target-a',
    executionCoordinateDigest: digest({ coordinate: 'a' }),
    executionControl,
    protocolId: 'omk.invoke/v1',
    input: { question: 'Q', expected: 'must-not-be-inferred-as-gold' },
    executionContext: { locale: 'zh-CN' },
    targetConfig,
    trialIndex: 0,
    trialId: digest({ trial: 'a' }),
    schedulingBlockId: digest({ block: 'a' }),
    samplingUnitIds: {},
  });
  try {
    return await trial.execute({
      attemptId: digest({ attempt: 'a' }),
      attemptNumber: 1,
      signal,
    });
  } finally {
    await trial.dispose();
    await run.dispose();
  }
}

describe('Codex CLI Core Executor adapter', () => {
  it('advertises trace v2 without unsupported mock telemetry', () => {
    const traceValidator = createCodexCliCoreSchemaValidators().find(
      (validator) => validator.schema.schemaVersion === 'omk.codex-cli-trace/v2',
    );
    expect(traceValidator).toBeDefined();
    expect(() => traceValidator!.parse({
      schemaVersion: 'omk.source-neutral-trace/v2',
      turns: [{ role: 'assistant', content: 'answer' }],
      toolCalls: [],
      numTurns: 1,
      fullNumTurns: 1,
      numSubAgents: 0,
      mockStats: { hits: 0, misses: 0, perMock: {} },
    })).toThrow();
  });

  it('derives declared content identity from the actual executable and version probe', async () => {
    const fixture = await adapterFixture();
    const first = await createAdapter(fixture, { OMK_TEST_SECRET: 'first-secret' });
    const rotated = await createAdapter(fixture, { OMK_TEST_SECRET: 'rotated-secret' });
    const behaviorA = await createAdapter(fixture, { OMK_TEST_EXPLICIT: 'a' });
    const behaviorB = await createAdapter(fixture, { OMK_TEST_EXPLICIT: 'b' });

    expect(first.identity).toEqual(rotated.identity);
    expect(behaviorA.identity).not.toEqual(behaviorB.identity);
    expect(first.identity).toMatchObject({
      implementationId: 'codex',
      version: '0.146.0',
      fingerprintBasis: 'content-derived',
      assuranceLevel: 'declared',
    });
    expect(JSON.stringify(first.identity)).not.toContain('first-secret');
    expect(JSON.stringify(first.identity)).not.toContain('OMK_TEST_SECRET');
    expect(first.identity.capabilities).toMatchObject({
      protocols: [{
        execution: {
          concurrency: { safety: 'serialized', maxInFlight: 1 },
        },
      }],
    });
  });

  it('uses fixed isolated controls, exact model/effort, closed stdin, and deterministic prompt projection', async () => {
    const fixture = await adapterFixture();
    const capture = join(fixture.root, 'capture.json');
    const result = await execute(
      await createAdapter(fixture, {
        OMK_TEST_CAPTURE: capture,
        OMK_TEST_EXPLICIT: 'visible',
      }),
      fixture.target.config as JsonValue,
    );
    const captured = JSON.parse(await readFile(capture, 'utf8')) as {
      args: string[];
      cwd: string;
      prompt: string;
      inheritedHome: string | null;
      explicit: string | null;
    };

    expect(result.output).toEqual({
      value: 'fixture answer',
      classification: 'sensitive',
      mediaType: 'text/plain',
    });
    expect(result.usage).toBeUndefined();
    expect(captured.args).toEqual(expect.arrayContaining([
      '--ignore-user-config', '--ignore-rules', '--strict-config',
      '--model', 'gpt-test', '--sandbox', 'read-only',
      'model_reasoning_effort="high"',
    ]));
    const envelope = JSON.parse(captured.prompt.split('\n').at(-1) ?? '') as Record<string, unknown>;
    expect(envelope).toEqual({
      schemaVersion: 'omk.codex-cli-prompt/v1',
      knowledgeArtifact: {
        artifactKind: 'file',
        instructions: '# Knowledge\nUse the fixture rule.',
      },
      executionContext: { locale: 'zh-CN' },
      task: { question: 'Q', expected: 'must-not-be-inferred-as-gold' },
    });
    expect(captured.inheritedHome).toBeNull();
    expect(captured.explicit).toBe('visible');
  });

  it('keeps directory supporting files separate from SKILL.md instructions', async () => {
    const fixture = await adapterFixture({
      artifactDirectory: {
        'SKILL.md': '# Knowledge\nRead references/rule.md when needed.',
        'a/rule.md': 'Nested support.',
        'a.txt': 'Root support.',
        'references/rule.md': 'Supporting rule, not an instruction.',
      },
    });
    const capture = join(fixture.root, 'directory-capture.json');
    await execute(
      await createAdapter(fixture, { OMK_TEST_CAPTURE: capture }),
      fixture.target.config as JsonValue,
      new AbortController().signal,
      fixture.target.executionControls.defaults,
    );
    const captured = JSON.parse(await readFile(capture, 'utf8')) as { prompt: string };
    const envelope = JSON.parse(captured.prompt.split('\n').at(-1) ?? '') as Record<string, unknown>;
    expect(envelope.knowledgeArtifact).toEqual({
      artifactKind: 'directory',
      entrypoint: 'SKILL.md',
      instructions: '# Knowledge\nRead references/rule.md when needed.',
      files: [
        { path: 'a.txt', content: 'Root support.' },
        { path: 'a/rule.md', content: 'Nested support.' },
        {
          path: 'references/rule.md',
          content: 'Supporting rule, not an instruction.',
        },
      ],
    });
  });

  it('rejects a non-empty directory without a root SKILL.md before process spawn', async () => {
    const fixture = await adapterFixture({
      artifactDirectory: { 'references/rule.md': 'orphaned' },
    });
    const invocations = join(fixture.root, 'invocations');
    const port = await createAdapter(fixture, { OMK_TEST_INVOCATIONS: invocations });
    await expect(execute(port, fixture.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_CLI_ARTIFACT_INVALID' },
    });
    await expect(readFile(invocations, 'utf8')).rejects.toThrow();
  });

  it('rejects an internally inconsistent resource lease before process spawn', async () => {
    const fixture = await adapterFixture({ leasedArtifactResourceId: 'artifact-poisoned' });
    const invocations = join(fixture.root, 'invocations');
    const port = await createAdapter(fixture, { OMK_TEST_INVOCATIONS: invocations });
    await expect(execute(port, fixture.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_CLI_RESOURCE_INVALID' },
    });
    await expect(readFile(invocations, 'utf8')).rejects.toThrow();
  });

  it('projects source-neutral trace and preserves reported or unknown usage without provider cost', async () => {
    const fixture = await adapterFixture();
    const withUsage = await execute(
      await createAdapter(fixture, { OMK_TEST_MODE: 'usage' }),
      fixture.target.config as JsonValue,
    );
    expect(withUsage.usage).toEqual({
      inputTokens: 8,
      outputTokens: 5,
      totalTokens: 13,
      details: { cachedInputTokens: 3, reasoningOutputTokens: 2 },
    });
    expect(withUsage.usage).not.toHaveProperty('providerCost');
    expect(withUsage.trace?.value).toMatchObject({
      schemaVersion: 'omk.source-neutral-trace/v2',
      numTurns: 1,
      turns: [{ role: 'assistant', content: 'fixture answer' }],
    });

    const unknown = await execute(
      await createAdapter(fixture),
      fixture.target.config as JsonValue,
    );
    expect(unknown.usage).toBeUndefined();
  });

  it.each([false, true])('isolates sequential trials while retaining same-trial attempts（workspace=%s）', async (workspace) => {
    const fixture = await adapterFixture({
      workspace,
      ...(workspace ? { sandboxId: CODEX_CLI_WORKSPACE_WRITE_SANDBOX_ID } : {}),
    });
    const adapter = await createAdapter(fixture, { OMK_TEST_MODE: 'workspace-state' });
    const run = await adapter.openRun({ runId: 'run-a', executionPlanDigest: digest('plan') });
    try {
      const outputs: unknown[] = [];
      for (let index = 0; index < 2; index += 1) {
        const trial = await run.openTrial({
          signal: new AbortController().signal,
          sampleId: 'sample-a', targetId: 'target-a',
          executionCoordinateDigest: digest({ coordinate: index }),
          executionControl: fixture.target.executionControls.defaults,
          protocolId: 'omk.invoke/v1', input: 'Inspect the workspace.',
          targetConfig: fixture.target.config,
          trialIndex: index, trialId: digest({ trial: index }),
          schedulingBlockId: digest({ block: index }), samplingUnitIds: {},
        });
        try {
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            outputs.push((await trial.execute({
              attemptId: digest({ index, attempt }), attemptNumber: attempt,
              signal: new AbortController().signal,
            })).output?.value);
          }
        } finally {
          await trial.dispose();
        }
      }
      expect(outputs).toEqual(['clean', 'contaminated', 'clean', 'contaminated']);
      if (workspace) {
        await expect(readFile(join(fixture.root, 'workspace', '.trial-marker')))
          .rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await run.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('uses a trial-private workspace copy and elevates output classification', async () => {
    const fixture = await adapterFixture({
      workspace: true,
      sandboxId: CODEX_CLI_WORKSPACE_WRITE_SANDBOX_ID,
    });
    const capture = join(fixture.root, 'workspace-capture.json');
    const result = await execute(
      await createAdapter(fixture, { OMK_TEST_CAPTURE: capture }),
      fixture.target.config as JsonValue,
      new AbortController().signal,
      fixture.target.executionControls.defaults,
    );
    const captured = JSON.parse(await readFile(capture, 'utf8')) as {
      args: string[];
      cwd: string;
    };
    expect(captured.cwd).not.toBe(await realpath(join(fixture.root, 'workspace')));
    expect(captured.cwd).toMatch(/omk-codex-run-[^/]+\/trial-/);
    expect(captured.args).toEqual(expect.arrayContaining([
      '--sandbox', 'workspace-write', '-C', expect.stringMatching(/trial-/),
    ]));
    expect(result.output?.classification).toBe('sensitive');
  });

  it.each([
    ['invalid', 'OMK_CODEX_CLI_PROTOCOL_INVALID'],
    ['missing-thread', 'OMK_CODEX_CLI_PROTOCOL_INVALID'],
    ['duplicate-item', 'OMK_CODEX_CLI_PROTOCOL_INVALID'],
    ['exit', 'OMK_CODEX_CLI_EXIT_NONZERO'],
  ])('redacts %s provider failures behind a stable boundary', async (mode, code) => {
    const fixture = await adapterFixture();
    const promise = execute(
      await createAdapter(fixture, { OMK_TEST_MODE: mode }),
      fixture.target.config as JsonValue,
    );
    await expect(promise).rejects.toMatchObject({
      evaluationError: { code },
    });
    await expect(promise).rejects.not.toThrow(/sensitive provider failure/);
  });

  it('keeps trustworthy usage on a redacted failed turn', async () => {
    const fixture = await adapterFixture();
    const promise = execute(
      await createAdapter(fixture, { OMK_TEST_MODE: 'failed-usage' }),
      fixture.target.config as JsonValue,
    );
    await expect(promise).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_CODEX_CLI_TURN_FAILED',
        message: 'Codex CLI reported a failed turn.',
      },
      usage: {
        inputTokens: 8,
        outputTokens: 5,
        totalTokens: 13,
      },
    });
  });

  it('bounds provider output as an implementation facet without adding an attempt timeout', async () => {
    const fixture = await adapterFixture();
    const port = await createAdapter(
      fixture,
      { OMK_TEST_MODE: 'oversized' },
      { maxOutputBytes: 256 },
    );
    await expect(execute(port, fixture.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_CLI_OUTPUT_LIMIT_EXCEEDED' },
    });
    expect(JSON.stringify(port.identity.implementationManifest)).toContain('maxOutputBytes');
  });

  it('forwards cancellation to the child and treats it as authoritative', async () => {
    const fixture = await adapterFixture();
    const started = join(fixture.root, 'started');
    const cancelled = join(fixture.root, 'cancelled');
    const controller = new AbortController();
    const promise = execute(
      await createAdapter(fixture, {
        OMK_TEST_MODE: 'wait',
        OMK_TEST_STARTED: started,
        OMK_TEST_CANCELLED: cancelled,
      }),
      fixture.target.config as JsonValue,
      controller.signal,
    );
    await expect.poll(async () => readFile(started, 'utf8').catch(() => '')).toBe('started');
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_CLI_CANCELLED' },
    });
    await expect.poll(async () => readFile(cancelled, 'utf8').catch(() => '')).toBe('cancelled');
  });

  it('fails identity drift before a business process starts', async () => {
    const fixture = await adapterFixture();
    const invocations = join(fixture.root, 'invocations');
    const port = await createAdapter(fixture, { OMK_TEST_INVOCATIONS: invocations });
    await writeFile(
      fixture.executablePath,
      `${await readFile(fixture.executablePath, 'utf8')}\n// drift\n`,
    );
    await expect(execute(port, fixture.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_CLI_IDENTITY_CHANGED' },
    });
    await expect(readFile(invocations, 'utf8')).rejects.toThrow();
  });

  it('reports a missing captured executable as a stable Runtime failure', async () => {
    const fixture = await adapterFixture();
    const port = await createAdapter(fixture);
    await unlink(fixture.executablePath);
    await expect(execute(port, fixture.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_CODEX_CLI_IDENTITY_CHANGED',
        stage: 'infrastructure',
      },
    });
  });

  it('fails unsupported behavior before a business process starts', async () => {
    const fixture = await adapterFixture({ allowedTools: ['shell'] });
    const invocations = join(fixture.root, 'invocations');
    await expect(createAdapter(fixture, { OMK_TEST_INVOCATIONS: invocations }))
      .rejects.toThrow(/tool allow-list/);
    await expect(readFile(invocations, 'utf8')).rejects.toThrow();
  });

  it('passes real Core prepare only for requirements the adapter actually supports', async () => {
    const fixture = await adapterFixture();
    const port = await createAdapter(fixture);
    const definition = validDefinition();
    definition.targets = [{ ...fixture.target }];
    definition.experiment.randomizationSlots = [{
      targetId: fixture.target.targetId,
      randomizationSlotId: 'slot-target-a',
    }];
    definition.experiment.assignment = {
      assignmentKind: 'complete-block',
      algorithmId: 'assignment.complete-block/v1',
      randomizationSlotIds: ['slot-target-a'],
    };
    definition.experiment.sampling.seedCoupling = 'uncontrolled';
    definition.comparisons = [];
    const policy = validPolicy();
    policy.cache.executionMode = 'disabled';
    policy.evidence.trace = 'full';
    delete policy.execution.timeoutMs;
    policy.retry.maxAttempts = 1;
    const runtime = testRuntime();
    runtime.resolveExecutor = () => ({ identity: port.identity, satisfiesVersionConstraint: true });
    for (const validator of createCodexCliCoreSchemaValidators()) {
      (runtime.schemaValidators as Map<string, {
        schema: SchemaIdentity;
        parse(value: unknown): JsonValue;
      }>).set(schemaIdentityKey(validator.schema), validator);
    }
    const plan = await prepareEvaluationPlan(definition, policy, runtime);
    expect(plan).toMatchObject({
      execution: {
        runtimes: expect.arrayContaining([expect.objectContaining({
          runtimeKind: 'executor',
          referenceId: 'target-a',
        })]),
      },
    });
    const bundle = await executeRunPlan(plan, {
      executorsByTargetId: new Map([['target-a', port]]),
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
      bundleId: 'bundle-codex-cli',
    });
    expect(bundle.executionBundleStatus).toBe('completed');
    expect(bundle.records).toHaveLength(1);
    expect(bundle.records[0]).toMatchObject({
      executionStatus: 'completed',
      output: { value: 'fixture answer', classification: 'public' },
    });

    definition.experiment.sampling.seedCoupling = 'independent-by-target';
    await expect(prepareEvaluationPlan(definition, policy, runtime)).rejects.toMatchObject({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
    });
  });

  it.each(['read-only', 'workspace-write'] as const)(
    'preserves the measured wire contract for %s with every effort setting',
    (sandbox) => {
      for (const effort of [undefined, 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
        const prompt = '---\nname: skill\n---\n正文';
        expect(buildCodexCliCoreArguments({
          model: 'gpt-test', workingDirectory: '/tmp/a b', prompt, sandbox,
          ...(effort === undefined ? {} : { effort }),
        })).toEqual([
          'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
          '--strict-config', '--skip-git-repo-check', '--color', 'never',
          '--sandbox', sandbox, '-c', 'approval_policy="never"',
          '-c', 'shell_environment_policy.inherit="none"',
          ...(effort === undefined ? [] : ['-c', `model_reasoning_effort="${effort}"`]),
          '--model', 'gpt-test', '-C', '/tmp/a b', '--', prompt,
        ]);
      }
    },
  );

  it('builds the fixed argument order independently of object property order', () => {
    const first = buildCodexCliCoreArguments({
      model: 'gpt-test',
      effort: 'low',
      sandbox: 'read-only',
      workingDirectory: '/tmp/omk-codex-test',
      prompt: 'hello',
    });
    const second = buildCodexCliCoreArguments({
      prompt: 'hello',
      workingDirectory: '/tmp/omk-codex-test',
      sandbox: 'read-only',
      effort: 'low',
      model: 'gpt-test',
    });
    expect(first).toEqual(second);
    expect(first.at(-2)).toBe('--');
    expect(first.at(-1)).toBe('hello');
    expect(first).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
  });

  it('exports strict validators for every advertised provider schema', async () => {
    const fixture = await adapterFixture();
    const port = await createAdapter(fixture);
    const validators = createCodexCliCoreSchemaValidators();
    const protocols = port.identity.capabilities as {
      protocols: Array<{
        inputSchema: SchemaIdentity;
        outputSchema: SchemaIdentity;
        traceSchema?: SchemaIdentity;
      }>;
    };
    const identities = protocols.protocols.flatMap((protocol) => [
      protocol.inputSchema,
      protocol.outputSchema,
      ...(protocol.traceSchema === undefined ? [] : [protocol.traceSchema]),
    ]);
    expect(validators.map((validator) => validator.schema)).toEqual(identities);
    expect(() => validators[1].parse({ not: 'text' })).toThrow();
    expect(() => validators[2].parse({ schemaVersion: 'future' })).toThrow();
  });
});
