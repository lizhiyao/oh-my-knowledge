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
import { afterEach, describe, expect, it } from 'vitest';
import {
  digestCanonicalJson,
  resolveEffectiveExecutionControl,
  schemaIdentityKey,
  type EvaluationDefinition,
  type JsonValue,
  type SchemaIdentity,
  type Sha256Digest,
} from '../../../../../src/eval-core/contracts/index.js';
import { prepareEvaluationPlan } from '../../../../../src/eval-core/compiler/index.js';
import {
  InMemoryRuntimeEventSequencer,
  executeRunPlan,
  type ExecutionExecutor,
  type ExecutorAttemptResult,
  type ExecutorTrialContext,
} from '../../../../../src/eval-core/execution/index.js';
import {
  buildClaudeCliCoreArguments,
  createClaudeCliCoreSchemaValidators,
  createClaudeCliExecutorAdapter,
  type ClaudeCliCoreConfiguration,
  type ClaudeCliEnvironmentEntry,
  type OmkBindingResourceLease,
  type OmkBindingResourceLeaseAccess,
  type OmkLeasedHostResource,
  type RuntimeBindingOf,
} from '../../../../../src/eval-workflows/runtime-adapter/index.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from '../../../../eval-core/compiler/fixtures.js';

const FIXTURE = fileURLToPath(new URL(
  '../../../../fixtures/claude-cli-core-runtime.mjs',
  import.meta.url,
));
const fixtureRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
  fixtureRoots.clear();
});

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
  artifactDirectory?: Readonly<Record<string, string>>;
  systemInstructions?: 'required' | 'not-required';
  workspace?: boolean;
  mcp?: boolean;
  mocks?: boolean;
  mockSampleIds?: readonly string[];
  mockTool?: string;
  allowedTools?: readonly string[];
  allowedSkills?: readonly string[];
  sandboxId?: string;
  leasedArtifactResourceId?: string;
}> = {}): Promise<AdapterFixture> {
  const root = await mkdtemp(join(tmpdir(), 'omk-claude-core-test-'));
  fixtureRoots.add(root);
  const executablePath = join(root, 'claude-fixture.mjs');
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
  const mcpPath = join(root, 'mcp.json');
  const mcpText = JSON.stringify({
    mcpServers: { search: { command: 'node', args: ['server.mjs'] } },
  });
  if (options.mcp) await writeFile(mcpPath, mcpText);
  const mcpDescriptor = {
    resourceId: 'mcp-a',
    digest: digest({ mcpText }),
    mediaType: 'application/json',
    classification: 'secret' as const,
    size: Buffer.byteLength(mcpText),
  };
  const mockPath = join(root, 'mock.json');
  const mockText = JSON.stringify({ stdout: 'mocked', exit: 0 });
  const mockRulePath = join(root, 'mock-rule.json');
  const mockPlanPath = join(root, 'mock-plan.json');
  const mockRuleText = JSON.stringify({
    tool: options.mockTool ?? 'Bash',
    match: { command_glob: '*' },
  });
  if (options.mocks) await Promise.all([
    writeFile(mockPath, mockText),
    writeFile(mockRulePath, mockRuleText),
  ]);
  const mockRuleDescriptor = {
    resourceId: 'mock-rule-a',
    digest: digest({ mockRuleText }),
    mediaType: 'application/json',
    classification: 'secret' as const,
    size: Buffer.byteLength(mockRuleText),
  };
  const mockDescriptor = {
    resourceId: 'mock-a',
    digest: digest({ mockText }),
    mediaType: 'application/json',
    classification: 'secret' as const,
    size: Buffer.byteLength(mockText),
  };
  const mockPlanText = JSON.stringify({
    schemaVersion: 'omk.mock-interception-plan/v1',
    strict: true,
    rules: [{ mockId: 'mock-1', rule: mockRuleDescriptor, payloads: [mockDescriptor] }],
  });
  const mockPlanDescriptor = {
    resourceId: 'mock-plan-a',
    digest: digest({ mockPlanText }),
    mediaType: 'application/vnd.omk.mock-interception-plan+json',
    classification: 'secret' as const,
    size: Buffer.byteLength(mockPlanText),
  };
  if (options.mocks) await writeFile(mockPlanPath, mockPlanText);
  const config = {
    behavior: {
      artifact: artifactDescriptor,
      ...(options.mcp ? { mcpConfig: mcpDescriptor } : {}),
      ...(options.allowedSkills === undefined ? {} : { allowedSkills: [...options.allowedSkills] }),
      ...(options.sandboxId === undefined ? {} : {
        sandbox: { sandboxId: options.sandboxId },
      }),
    },
    runtime: { model: 'claude-test', effort: 'high' as const },
  };
  const executionRequirements = {
    systemInstructions: options.systemInstructions ?? 'required',
    workspace: options.workspace ? 'copy-on-write-overlay' as const : 'not-required' as const,
    mcp: options.mcp ? 'native-config' as const : 'not-required' as const,
    mockInterception: options.mocks ? 'pre-tool-call' as const : 'not-required' as const,
    toolPolicy: options.allowedTools === undefined ? 'runtime-default' as const : 'allow-list' as const,
    skillDiscovery: options.allowedSkills === undefined
      ? 'runtime-default' as const
      : options.allowedSkills.length === 0
        ? 'disabled' as const
        : 'allow-list' as const,
    ...(options.sandboxId === undefined ? {} : { sandboxId: options.sandboxId }),
  };
  const target: EvaluationDefinition['targets'][number] = {
    targetId: 'target-a',
    targetKind: 'skill',
    protocolId: 'omk.invoke/v1',
    executorId: 'claude',
    executionRequirements,
    executionControls: {
      defaults: {
        workspace: options.workspace
          ? { workspaceMode: 'copy-on-write-overlay', descriptor: workspaceDescriptor }
          : { workspaceMode: 'not-required' },
        tools: options.allowedTools === undefined
          ? { toolPolicyKind: 'runtime-default' }
          : { toolPolicyKind: 'allow-list', allowedTools: [...options.allowedTools].sort() },
        mcp: { mcpMode: 'not-required' },
        mockInterception: { mockInterceptionMode: 'not-required' },
      },
      sampleOverrides: options.mocks
        ? (options.mockSampleIds ?? ['sample-a']).map((sampleId) => ({
            sampleId,
            mockInterception: {
              mockInterceptionMode: 'pre-tool-call' as const,
              descriptor: mockPlanDescriptor,
            },
          }))
        : [],
    },
    config,
  };
  const requirements = [{
    resourceId: 'artifact-a',
    resourceRole: 'artifact' as const,
    leaseMode: 'immutable-snapshot' as const,
  }, ...(options.workspace ? [{
    resourceId: 'workspace-a',
    resourceRole: 'workspace' as const,
    leaseMode: 'copy-on-write-overlay' as const,
  }] : []), ...(options.mcp ? [{
    resourceId: 'mcp-a',
    resourceRole: 'mcp-config' as const,
    leaseMode: 'immutable-snapshot' as const,
  }] : []), ...(options.mocks ? [{
    resourceId: 'mock-plan-a',
    resourceRole: 'mock-plan' as const,
    leaseMode: 'immutable-snapshot' as const,
  }, {
    resourceId: 'mock-rule-a',
    resourceRole: 'mock-rule' as const,
    leaseMode: 'immutable-snapshot' as const,
  }, {
    resourceId: 'mock-a',
    resourceRole: 'mock-payload' as const,
    leaseMode: 'immutable-snapshot' as const,
  }] : [])];
  const binding: RuntimeBindingOf<'executor'> = {
    runtimeKind: 'executor',
    bindingId: 'executor-target-a',
    targetId: 'target-a',
    implementationId: 'claude',
    protocolId: 'omk.invoke/v1',
    behaviorConfigDigest: digest(config),
    executionControlsDigest: digest(target.executionControls),
    resourceLeaseRequirements: requirements,
    qualification: {
      model: 'claude-test',
      effort: 'high',
      executionRequirements,
      resourceIntegrity: 'digest-before-use',
    },
  };
  const resources = new Map<string, OmkLeasedHostResource>([
    ['artifact-a', {
      resourceId: options.leasedArtifactResourceId ?? 'artifact-a',
      resourceKind: 'artifact',
      descriptor: artifactDescriptor,
      snapshotKind: options.artifactDirectory === undefined ? 'file' : 'directory',
      leaseMode: 'immutable-snapshot',
      snapshotPath: artifactPath,
    }],
  ]);
  if (options.workspace) resources.set('workspace-a', {
    resourceId: 'workspace-a',
    resourceKind: 'workspace',
    descriptor: workspaceDescriptor,
    snapshotKind: 'directory',
    leaseMode: 'copy-on-write-overlay',
    baseSnapshotPath: workspacePath,
    overlayPath: workspacePath,
  });
  if (options.mcp) resources.set('mcp-a', {
    resourceId: 'mcp-a',
    resourceKind: 'mcp-config',
    descriptor: mcpDescriptor,
    snapshotKind: 'file',
    leaseMode: 'immutable-snapshot',
    snapshotPath: mcpPath,
  });
  if (options.mocks) resources.set('mock-a', {
    resourceId: 'mock-a',
    resourceKind: 'mock-payload',
    descriptor: mockDescriptor,
    snapshotKind: 'file',
    leaseMode: 'immutable-snapshot',
    snapshotPath: mockPath,
  });
  if (options.mocks) resources.set('mock-plan-a', {
    resourceId: 'mock-plan-a',
    resourceKind: 'mock-plan',
    descriptor: mockPlanDescriptor,
    snapshotKind: 'file',
    leaseMode: 'immutable-snapshot',
    snapshotPath: mockPlanPath,
  });
  if (options.mocks) resources.set('mock-rule-a', {
    resourceId: 'mock-rule-a',
    resourceKind: 'mock-rule',
    descriptor: mockRuleDescriptor,
    snapshotKind: 'file',
    leaseMode: 'immutable-snapshot',
    snapshotPath: mockRulePath,
  });
  const lease: OmkBindingResourceLease = Object.freeze({
    bindingId: binding.bindingId,
    consumerKind: 'executor',
    resourcesByResourceId: resources,
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
): Readonly<Record<string, ClaudeCliEnvironmentEntry>> {
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
  command: Partial<ClaudeCliCoreConfiguration> = {},
): Promise<ExecutionExecutor> {
  return createClaudeCliExecutorAdapter({
    target: fixture.target,
    binding: fixture.binding,
    command: {
      executablePath: fixture.executablePath,
      environment: environment({ PATH: dirname(process.execPath), ...values }),
      ...command,
    },
    sessionIsolationKey: 'claude-session-a',
    resourceLeases: fixture.resourceAccess,
  });
}

async function execute(
  port: ExecutionExecutor,
  targetConfig: JsonValue,
  signal: AbortSignal = new AbortController().signal,
  sampleId = 'sample-a',
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
    sampleId,
    targetId: 'target-a',
    executionCoordinateDigest: digest({ coordinate: sampleId }),
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

describe('Claude CLI Core Executor adapter', () => {
  it('derives declared content identity without persisting credential values', async () => {
    const fixture = await adapterFixture();
    const first = await createAdapter(fixture, { OMK_TEST_SECRET: 'first-secret' });
    const rotated = await createAdapter(fixture, { OMK_TEST_SECRET: 'rotated-secret' });
    const behaviorA = await createAdapter(fixture, { OMK_TEST_EXPLICIT: 'a' });
    const behaviorB = await createAdapter(fixture, { OMK_TEST_EXPLICIT: 'b' });

    expect(first.identity).toEqual(rotated.identity);
    expect(behaviorA.identity).not.toEqual(behaviorB.identity);
    expect(JSON.stringify(first.identity)).not.toContain('first-secret');
    expect(first.identity).toMatchObject({
      implementationId: 'claude',
      version: '2.1.226',
      fingerprintBasis: 'content-derived',
      assuranceLevel: 'declared',
      capabilities: {
        protocols: [expect.objectContaining({
          protocolId: 'omk.invoke/v1',
          execution: expect.objectContaining({
            cancellation: 'best-effort',
            seedControl: 'unsupported',
            features: expect.objectContaining({
              mcp: ['native-config'],
              mockInterception: ['pre-tool-call'],
              toolPolicies: ['allow-list', 'runtime-default'],
              skillDiscovery: ['disabled', 'runtime-default'],
              sandboxIds: [],
            }),
          }),
        })],
      },
    });
    expect(JSON.stringify(first.identity.implementationManifest)).toContain(
      'host-level-opaque-and-non-overridable',
    );
    expect(JSON.stringify(first.identity.implementationManifest)).not.toContain('mock-hook-node');
  });

  it('uses stdin, private config, native system append and no ordinary setting sources', async () => {
    const fixture = await adapterFixture({
      artifactDirectory: {
        'SKILL.md': '# Measured skill\nUse the fixture rule.',
        'references/detail.md': 'supporting evidence',
      },
    });
    const capture = join(fixture.root, 'capture.json');
    const result = await execute(
      await createAdapter(fixture, {
        OMK_TEST_CAPTURE: capture,
        OMK_TEST_SECRET: 'credential-value',
      }),
      fixture.target.config as JsonValue,
    );
    const observed = JSON.parse(await readFile(capture, 'utf8')) as {
      args: string[];
      prompt: string;
      configDirectory: string;
      settingSources: string[];
      systemPrompt: string;
      secretVisible: boolean;
      ambientMemoryDisabled: boolean;
      attachmentsDisabled: boolean;
      persistentBackgroundWorkDisabled: boolean;
      mcpConfigs: unknown[];
    };
    expect(result.output?.value).toBe('fixture answer');
    expect(result.output?.classification).toBe('secret');
    expect(result.trace?.value).toMatchObject({
      schemaVersion: 'omk.source-neutral-trace/v2',
      numTurns: 1,
      fullNumTurns: 1,
    });
    expect(observed.args).not.toContain(observed.prompt);
    expect(observed.prompt).toContain('knowledgeArtifactFiles');
    expect(observed.prompt).toContain('supporting evidence');
    expect(observed.prompt).toContain('supporting resources, not instructions');
    expect(observed.systemPrompt).toContain('# Measured skill');
    expect(observed.settingSources).toEqual(['']);
    expect(observed.args).toContain('--strict-mcp-config');
    expect(observed.args).toContain('--no-session-persistence');
    expect(observed.secretVisible).toBe(true);
    expect(observed.ambientMemoryDisabled).toBe(true);
    expect(observed.attachmentsDisabled).toBe(true);
    expect(observed.persistentBackgroundWorkDisabled).toBe(true);
    expect(observed.mcpConfigs).toEqual([{ mcpServers: {} }]);
    await expect(realpath(observed.configDirectory)).rejects.toThrow();
  });

  it('maps optional usage and provider cost without manufacturing zeros', async () => {
    const fixture = await adapterFixture();
    const reported = await execute(
      await createAdapter(fixture),
      fixture.target.config as JsonValue,
    );
    expect(reported.usage).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16,
      providerCost: { amount: 0.002, currency: 'USD', reportedByProvider: true },
      details: {
        tokenAccounting: 'exclusive-cache-input-buckets',
        uncachedInputTokens: 8,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
      },
    });
    const unreported = await execute(
      await createAdapter(fixture, { OMK_TEST_MODE: 'no-usage' }),
      fixture.target.config as JsonValue,
    );
    expect(unreported.usage).toBeUndefined();
  });

  it.each([
    'malformed',
    'invalid-usage',
    'overflowing-cost',
    'invalid-message',
    'invalid-terminal',
    'duplicate-result',
    'post-terminal',
    'empty',
  ])(
    'fails invalid %s protocol output closed',
    async (mode) => {
      const fixture = await adapterFixture();
      await expect(execute(
        await createAdapter(fixture, { OMK_TEST_MODE: mode }),
        fixture.target.config as JsonValue,
      )).rejects.toMatchObject({
        evaluationError: { code: 'OMK_CLAUDE_CLI_PROTOCOL_INVALID' },
      });
    },
  );

  it('preserves reported usage on a provider-declared failed turn', async () => {
    const fixture = await adapterFixture();
    await expect(execute(
      await createAdapter(fixture, { OMK_TEST_MODE: 'failed' }),
      fixture.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CLAUDE_CLI_TURN_FAILED', stage: 'execution' },
      usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
    });
  });

  it('redacts nonzero process failures while preserving complete reported usage', async () => {
    const fixture = await adapterFixture();
    await expect(execute(
      await createAdapter(fixture, { OMK_TEST_MODE: 'nonzero' }),
      fixture.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_CLAUDE_CLI_EXIT_NONZERO',
        message: 'Claude CLI exited unsuccessfully.',
      },
      usage: { inputTokens: 11, outputTokens: 5 },
    });
  });

  it('bounds output without adding an adapter attempt timeout', async () => {
    const fixture = await adapterFixture();
    const port = await createAdapter(
      fixture,
      { OMK_TEST_MODE: 'oversized' },
      { maxOutputBytes: 256 },
    );
    await expect(execute(port, fixture.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CLAUDE_CLI_OUTPUT_LIMIT_EXCEEDED' },
    });
    expect(JSON.stringify(port.identity.implementationManifest)).toContain('maxOutputBytes');
  });

  it('forwards cancellation to the child and waits for termination', async () => {
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
      evaluationError: { code: 'OMK_CLAUDE_CLI_CANCELLED' },
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
      evaluationError: { code: 'OMK_CLAUDE_CLI_IDENTITY_CHANGED' },
    });
    await expect(readFile(invocations, 'utf8')).rejects.toThrow();
  });

  it('reports a missing captured executable as a stable Runtime failure', async () => {
    const fixture = await adapterFixture();
    const port = await createAdapter(fixture);
    await unlink(fixture.executablePath);
    await expect(execute(port, fixture.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_CLAUDE_CLI_IDENTITY_CHANGED',
        stage: 'infrastructure',
      },
    });
  });

  it('projects verified MCP and secret mock payload leases into trial-local controls', async () => {
    const fixture = await adapterFixture({ mcp: true, mocks: true });
    const capture = join(fixture.root, 'capture.json');
    const result = await execute(
      await createAdapter(fixture, { OMK_TEST_CAPTURE: capture }),
      fixture.target.config as JsonValue,
      new AbortController().signal,
      'sample-a',
      resolveEffectiveExecutionControl(fixture.target.executionControls, 'sample-a'),
    );
    const observed = JSON.parse(await readFile(capture, 'utf8')) as {
      settingsExists: boolean;
      mockFileExists: boolean;
      mcpConfigs: Array<{ mcpServers?: Record<string, unknown> }>;
    };
    expect(result.output?.classification).toBe('secret');
    expect(result.trace?.value).toMatchObject({
      mockStats: { hits: 0, misses: 0, perMock: {} },
    });
    expect(observed.settingsExists).toBe(true);
    expect(observed.mockFileExists).toBe(true);
    expect(observed.mcpConfigs).toHaveLength(1);
    expect(observed.mcpConfigs[0]?.mcpServers).toHaveProperty('search');
    expect(JSON.stringify((await createAdapter(fixture)).identity.implementationManifest))
      .toContain('mock-hook-node');
  });

  it('rejects an invalid leased mock rule before a business process starts', async () => {
    const fixture = await adapterFixture({ mocks: true });
    const invocations = join(fixture.root, 'invocations');
    const port = await createAdapter(fixture, { OMK_TEST_INVOCATIONS: invocations });
    await writeFile(join(fixture.root, 'mock-rule.json'), '{"tool":42}');

    await expect(execute(port, fixture.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CLAUDE_CLI_MOCK_CONFIG_INVALID' },
    });
    await expect(readFile(invocations, 'utf8')).rejects.toThrow();
  });

  it('treats the sample-scoped mock plan as the authoritative helper manifest', async () => {
    const fixture = await adapterFixture({ mocks: true });
    const invocations = join(fixture.root, 'invocations');
    await writeFile(join(fixture.root, 'mock-plan.json'), JSON.stringify({
      schemaVersion: 'omk.mock-interception-plan/v1',
      strict: true,
      rules: [{
        mockId: 'mock-1',
        rule: {
          resourceId: 'unknown-rule',
          digest: digest({ unknown: 'rule' }),
          mediaType: 'application/json',
          classification: 'secret',
          size: 1,
        },
        payloads: [],
      }],
    }));

    await expect(execute(
      await createAdapter(fixture, { OMK_TEST_INVOCATIONS: invocations }),
      fixture.target.config as JsonValue,
      new AbortController().signal,
      'sample-a',
      resolveEffectiveExecutionControl(fixture.target.executionControls, 'sample-a'),
    )).rejects.toMatchObject({
        evaluationError: { code: 'OMK_CLAUDE_CLI_MOCK_CONFIG_INVALID' },
      });
    await expect(readFile(invocations, 'utf8')).rejects.toThrow();
  });

  it('isolates CLI config and mock state across retry attempts', async () => {
    const fixture = await adapterFixture({ mocks: true });
    const captureLog = join(fixture.root, 'capture.jsonl');
    const port = await createAdapter(fixture, { OMK_TEST_CAPTURE_LOG: captureLog });
    const run = await port.openRun({
      runId: 'run-a',
      executionPlanDigest: digest({ plan: 'a' }),
    });
    const trial = await run.openTrial({
      signal: new AbortController().signal,
      sampleId: 'sample-a',
      targetId: 'target-a',
      executionCoordinateDigest: digest({ coordinate: 'a' }),
      executionControl: resolveEffectiveExecutionControl(
        fixture.target.executionControls,
        'sample-a',
      ),
      protocolId: 'omk.invoke/v1',
      input: { question: 'Q' },
      targetConfig: fixture.target.config as JsonValue,
      trialIndex: 0,
      trialId: digest({ trial: 'retry-isolation' }),
      schedulingBlockId: digest({ block: 'retry-isolation' }),
      samplingUnitIds: {},
    });
    try {
      for (const attemptNumber of [1, 2]) {
        await trial.execute({
          attemptId: digest({ attemptNumber }),
          attemptNumber,
          signal: new AbortController().signal,
        });
      }
    } finally {
      await trial.dispose();
      await run.dispose();
    }
    const captures = (await readFile(captureLog, 'utf8')).trim().split('\n').map((line) => (
      JSON.parse(line) as { configDirectory: string; mockFile: string }
    ));
    expect(captures).toHaveLength(2);
    expect(captures[0]?.configDirectory).not.toBe(captures[1]?.configDirectory);
    expect(captures[0]?.mockFile).not.toBe(captures[1]?.mockFile);
    for (const capture of captures) {
      await expect(realpath(capture.configDirectory)).rejects.toThrow();
      await expect(realpath(capture.mockFile)).rejects.toThrow();
    }
  });

  it('selects mock controls by sampleId without exposing another sample controls', async () => {
    const fixture = await adapterFixture({ mocks: true, mockSampleIds: ['sample-a'] });
    const capture = join(fixture.root, 'capture.json');
    const result = await execute(
      await createAdapter(fixture, { OMK_TEST_CAPTURE: capture }),
      fixture.target.config as JsonValue,
      new AbortController().signal,
      'sample-b',
    );
    const observed = JSON.parse(await readFile(capture, 'utf8')) as {
      mockFileExists: boolean;
    };
    expect(observed.mockFileExists).toBe(false);
    expect(result.output?.classification).toBe('sensitive');
    expect(result.output?.classification).not.toBe('secret');
    expect(result.trace?.value).not.toMatchObject({ mockStats: expect.anything() });
  });

  it('enforces built-in tool allow-list and complete skill disablement', async () => {
    const fixture = await adapterFixture({
      allowedTools: ['Read', 'Bash'],
      allowedSkills: [],
    });
    const capture = join(fixture.root, 'capture.json');
    await execute(
      await createAdapter(fixture, { OMK_TEST_CAPTURE: capture }),
      fixture.target.config as JsonValue,
      new AbortController().signal,
      'sample-a',
      fixture.target.executionControls.defaults,
    );
    const { args } = JSON.parse(await readFile(capture, 'utf8')) as { args: string[] };
    expect(args).toContain('--tools');
    expect(args).toContain('Bash,Read');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('mcp__*');
    expect(args).toContain('Skill');
  });

  it('rejects capability surfaces Claude cannot enforce before business execution', async () => {
    const incompleteCli = await adapterFixture();
    await expect(createAdapter(incompleteCli, { OMK_TEST_INCOMPLETE_HELP: '1' }))
      .rejects.toThrow(/missing required Core adapter flags/);

    const allowList = await adapterFixture({ allowedSkills: ['one-skill'] });
    await expect(createAdapter(allowList)).rejects.toThrow(/non-empty skill allow-list/);
    const sandbox = await adapterFixture({ sandboxId: 'omk.fake-sandbox/v1' });
    await expect(createAdapter(sandbox)).rejects.toThrow(/verifiable sandbox/);
    const mixedTools = await adapterFixture({ mcp: true, allowedTools: ['Read'] });
    await expect(createAdapter(mixedTools)).rejects.toThrow(/dynamic MCP tools/);
    const mockedMcpTools = await adapterFixture({
      mocks: true,
      mockTool: 'mcp__search__query',
      allowedTools: ['Read'],
    });
    await expect(execute(
      await createAdapter(mockedMcpTools),
      mockedMcpTools.target.config as JsonValue,
      new AbortController().signal,
      'sample-a',
      resolveEffectiveExecutionControl(mockedMcpTools.target.executionControls, 'sample-a'),
    )).rejects.toThrow(/MCP tool mocks/);

    const duplicateTools = await adapterFixture({ allowedTools: ['Read', 'Read'] });
    await expect(createAdapter(duplicateTools)).rejects.toThrow(/must not contain duplicates/);

    const conflictingMcp = await adapterFixture({
      mcp: true,
      mocks: true,
      mockTool: 'mcp__search__query',
    });
    await expect(execute(
      await createAdapter(conflictingMcp),
      conflictingMcp.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CLAUDE_CLI_MCP_CONFIG_INVALID' },
    });
  });

  it('fails inconsistent resource identity before a business process starts', async () => {
    const fixture = await adapterFixture({ leasedArtifactResourceId: 'wrong-artifact' });
    const invocations = join(fixture.root, 'invocations');
    await expect(execute(
      await createAdapter(fixture, { OMK_TEST_INVOCATIONS: invocations }),
      fixture.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CLAUDE_CLI_RESOURCE_INVALID' },
    });
    await expect(readFile(invocations, 'utf8')).rejects.toThrow();
  });

  it('passes real Core prepare only for requirements actually advertised', async () => {
    const fixture = await adapterFixture({ allowedSkills: [] });
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
    for (const validator of createClaudeCliCoreSchemaValidators()) {
      (runtime.schemaValidators as Map<string, {
        schema: SchemaIdentity;
        parse(value: unknown): JsonValue;
      }>).set(schemaIdentityKey(validator.schema), validator);
    }
    const plan = await prepareEvaluationPlan(definition, policy, runtime);
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
    }, { runId: 'run-a', bundleId: 'bundle-claude-cli' });
    expect(bundle.executionBundleStatus).toBe('completed');
    expect(bundle.records[0]).toMatchObject({
      executionStatus: 'completed',
      output: { value: 'fixture answer', classification: 'public' },
    });

    definition.experiment.sampling.seedCoupling = 'independent-by-target';
    await expect(prepareEvaluationPlan(definition, policy, runtime)).rejects.toMatchObject({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
    });
  });

  it('builds fixed arguments independently of object property order', () => {
    const first = buildClaudeCliCoreArguments({
      model: 'claude-test',
      effort: 'high',
      systemPromptFile: '/tmp/system.md',
      mcpConfigFiles: ['/tmp/mcp.json'],
      allowedTools: ['Read'],
      disableSkills: true,
    });
    const second = buildClaudeCliCoreArguments({
      disableSkills: true,
      allowedTools: ['Read'],
      mcpConfigFiles: ['/tmp/mcp.json'],
      systemPromptFile: '/tmp/system.md',
      effort: 'high',
      model: 'claude-test',
    });
    expect(first).toEqual(second);
  });
});
