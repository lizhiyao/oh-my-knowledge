import {
  mkdir,
  mkdtemp,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  digestCanonicalJson,
  schemaIdentityKey,
  type EvaluationDefinition,
  type JsonValue,
  type SchemaIdentity,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';
import { prepareEvaluationPlan } from '../../../src/evaluation-core/compiler/index.js';
import {
  InMemoryRuntimeEventSequencer,
  type ExecutionExecutor,
  type ExecutorAttemptResult,
  executeRunPlan,
} from '../../../src/evaluation-core/execution/index.js';
import {
  CODEX_SDK_WORKSPACE_WRITE_SANDBOX_ID,
  createCodexSdkCoreSchemaValidators,
  createCodexSdkExecutorAdapter,
  type CodexSdkClientOptions,
  type CodexSdkCoreConfiguration,
  type CodexSdkEnvironmentEntry,
  type CodexSdkThreadOptions,
  type OmkBindingResourceLease,
  type OmkBindingResourceLeaseAccess,
  type OmkLeasedHostResource,
  type ResolvedCodexSdkRuntime,
  type RuntimeBindingOf,
} from '../../../src/eval-workflows/runtime-adapter/index.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from '../../evaluation-core/compiler/fixtures.js';

function digest(value: JsonValue): Sha256Digest {
  return digestCanonicalJson(value);
}

type SdkMode =
  | 'success'
  | 'usage'
  | 'failed-usage'
  | 'invalid'
  | 'runtime-error'
  | 'create-error'
  | 'drift-on-create'
  | 'start-error'
  | 'oversized'
  | 'wait';

interface SdkObservations {
  mode: SdkMode;
  resolverCalls: number;
  clientOptions: CodexSdkClientOptions[];
  threadOptions: CodexSdkThreadOptions[];
  prompts: string[];
  signals: AbortSignal[];
  streamClosed: number;
  started: boolean;
}

interface AdapterFixture {
  readonly root: string;
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly resourceAccess: OmkBindingResourceLeaseAccess;
  readonly runtime: ResolvedCodexSdkRuntime;
  readonly observations: SdkObservations;
  readonly identityPaths: Readonly<Record<string, string>>;
}

async function adapterFixture(options: Readonly<{
  workspace?: boolean;
  allowedTools?: readonly string[];
  leasedArtifactResourceId?: string;
}> = {}): Promise<AdapterFixture> {
  const root = await mkdtemp(join(tmpdir(), 'omk-codex-sdk-core-test-'));
  const artifact = '# Knowledge\nUse the SDK fixture rule.';
  const artifactPath = join(root, 'artifact.md');
  await writeFile(artifactPath, artifact);
  const identityPaths = {
    'codex-sdk.package-manifest': join(root, 'sdk-package.json'),
    'codex-sdk.entrypoint': join(root, 'sdk-index.js'),
    'codex.package-manifest': join(root, 'codex-package.json'),
    'codex-native.package-manifest': join(root, 'native-package.json'),
    'codex-native.executable': join(root, 'codex'),
  };
  await Promise.all(Object.entries(identityPaths).map(([facetId, path]) => (
    writeFile(path, `identity:${facetId}`)
  )));
  const artifactDescriptor = {
    resourceId: 'artifact-a',
    digest: digest({ artifact }),
    mediaType: 'text/markdown',
    classification: 'public' as const,
    size: Buffer.byteLength(artifact),
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
      ...(options.workspace ? { workspace: workspaceDescriptor } : {}),
      ...(options.workspace ? {
        sandbox: { sandboxId: CODEX_SDK_WORKSPACE_WRITE_SANDBOX_ID },
      } : {}),
      ...(options.allowedTools === undefined ? {} : {
        allowedTools: [...options.allowedTools],
      }),
    },
    runtime: { model: 'gpt-test', effort: 'high' as const },
  };
  const executionRequirements = {
    systemInstructions: 'required' as const,
    workspace: options.workspace ? 'copy-on-write-overlay' as const : 'not-required' as const,
    mcp: 'not-required' as const,
    mockInterception: 'not-required' as const,
    toolPolicy: options.allowedTools === undefined ? 'runtime-default' as const : 'allow-list' as const,
    skillDiscovery: 'runtime-default' as const,
    ...(options.workspace ? { sandboxId: CODEX_SDK_WORKSPACE_WRITE_SANDBOX_ID } : {}),
  };
  const target: EvaluationDefinition['targets'][number] = {
    targetId: 'target-a',
    targetKind: 'skill',
    protocolId: 'omk.invoke/v1',
    executorId: 'test.omk.codex-sdk/v1',
    executionRequirements,
    config,
  };
  const binding: RuntimeBindingOf<'executor'> = {
    runtimeKind: 'executor',
    bindingId: 'executor-target-a',
    targetId: 'target-a',
    implementationId: 'test.omk.codex-sdk/v1',
    protocolId: 'omk.invoke/v1',
    behaviorConfigDigest: digest(config),
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
        resourceKind: 'artifact',
        descriptor: artifactDescriptor,
        snapshotKind: 'file',
        leaseMode: 'immutable-snapshot',
        snapshotPath: artifactPath,
      }],
      ...(options.workspace ? [[
        'workspace-a', {
          resourceId: 'workspace-a',
          resourceKind: 'workspace' as const,
          descriptor: workspaceDescriptor,
          snapshotKind: 'directory' as const,
          leaseMode: 'copy-on-write-overlay' as const,
          baseSnapshotPath: workspacePath,
          overlayPath: workspacePath,
        },
      ] as const] : []),
    ]),
  });
  const observations: SdkObservations = {
    mode: 'success',
    resolverCalls: 0,
    clientOptions: [],
    threadOptions: [],
    prompts: [],
    signals: [],
    streamClosed: 0,
    started: false,
  };
  const stream = async function* (signal: AbortSignal): AsyncGenerator<unknown> {
    try {
      if (observations.mode === 'runtime-error') throw new Error('sensitive provider failure');
      if (observations.mode === 'invalid') {
        yield { type: 'future.provider.event', secret: 'sensitive' };
        return;
      }
      yield { type: 'thread.started', thread_id: 'thread-test' };
      yield { type: 'turn.started' };
      if (observations.mode === 'wait') {
        observations.started = true;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
        return;
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'message-1',
          type: 'agent_message',
          text: observations.mode === 'oversized' ? 'x'.repeat(4096) : 'fixture answer',
        },
      };
      const usage = observations.mode === 'usage' || observations.mode === 'failed-usage'
        ? {
            input_tokens: 8,
            cached_input_tokens: 3,
            cache_write_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          }
        : undefined;
      yield {
        type: observations.mode === 'failed-usage' ? 'turn.failed' : 'turn.completed',
        ...(usage === undefined ? {} : { usage }),
        ...(observations.mode === 'failed-usage'
          ? { error: { message: 'sensitive failure detail' } }
          : {}),
      };
    } finally {
      observations.streamClosed += 1;
    }
  };
  const runtime: ResolvedCodexSdkRuntime = {
    sdkVersion: '0.149.0',
    codexVersion: '0.149.0',
    contentIdentityFiles: Object.entries(identityPaths).map(([facetId, path]) => ({
      facetId,
      path,
    })),
    async createClient(clientOptions) {
      observations.clientOptions.push(clientOptions);
      if (observations.mode === 'create-error') {
        throw new Error('sensitive client creation failure');
      }
      if (observations.mode === 'drift-on-create') {
        await writeFile(identityPaths['codex-native.executable'], 'drift-during-load');
      }
      return {
        startThread(threadOptions = {}) {
          if (observations.mode === 'start-error') {
            throw new Error('sensitive session startup failure');
          }
          observations.threadOptions.push(threadOptions);
          return {
            async runStreamed(prompt, turnOptions = {}) {
              observations.prompts.push(prompt);
              if (turnOptions.signal === undefined) throw new Error('missing signal');
              observations.signals.push(turnOptions.signal);
              return { events: stream(turnOptions.signal) };
            },
          };
        },
      };
    },
  };
  return {
    root,
    target,
    binding,
    observations,
    runtime,
    identityPaths,
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
): Readonly<Record<string, CodexSdkEnvironmentEntry>> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    value,
    identity: key === 'OMK_TEST_SECRET'
      ? { identityKind: 'credential' as const }
      : { identityKind: 'behavior' as const, value },
  }]));
}

async function createAdapter(
  fixture: AdapterFixture,
  values: Readonly<Record<string, string>> = {},
  sdk: Partial<CodexSdkCoreConfiguration> = {},
): Promise<ExecutionExecutor> {
  return createCodexSdkExecutorAdapter({
    target: fixture.target,
    binding: fixture.binding,
    sdk: {
      environment: environment(values),
      runtimeResolver: async () => {
        fixture.observations.resolverCalls += 1;
        return fixture.runtime;
      },
      ...sdk,
    },
    sessionIsolationKey: 'codex-sdk-session-a',
    resourceLeases: fixture.resourceAccess,
  });
}

async function execute(
  port: ExecutionExecutor,
  targetConfig: JsonValue,
  signal: AbortSignal = new AbortController().signal,
): Promise<ExecutorAttemptResult> {
  const run = await port.openRun({ runId: 'run-a', executionPlanDigest: digest({ plan: 'a' }) });
  const trial = await run.openTrial({
    targetId: 'target-a',
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

describe('Codex SDK Core Executor adapter', () => {
  it('derives declared content identity from SDK and bundled native runtime bytes', async () => {
    const fixture = await adapterFixture();
    const first = await createAdapter(fixture, { OMK_TEST_SECRET: 'first-secret' });
    const rotated = await createAdapter(fixture, { OMK_TEST_SECRET: 'rotated-secret' });
    const behaviorA = await createAdapter(fixture, { OMK_TEST_EXPLICIT: 'a' });
    const behaviorB = await createAdapter(fixture, { OMK_TEST_EXPLICIT: 'b' });

    expect(first.identity).toEqual(rotated.identity);
    expect(behaviorA.identity).not.toEqual(behaviorB.identity);
    expect(first.identity).toMatchObject({
      implementationId: 'test.omk.codex-sdk/v1',
      version: '0.149.0',
      fingerprintBasis: 'content-derived',
      assuranceLevel: 'declared',
    });
    expect(JSON.stringify(first.identity)).not.toContain('first-secret');
    expect(JSON.stringify(first.identity)).not.toContain('OMK_TEST_SECRET');
    expect(fixture.observations.resolverCalls).toBe(4);
  });

  it('uses a private CODEX_HOME, exact controls, and deterministic prompt projection', async () => {
    const fixture = await adapterFixture();
    const result = await execute(
      await createAdapter(fixture, { OMK_TEST_EXPLICIT: 'visible' }),
      fixture.target.config as JsonValue,
    );
    const clientEnvironment = fixture.observations.clientOptions[0]?.env;
    const codexHome = clientEnvironment?.CODEX_HOME;
    expect(result.output).toEqual({
      value: 'fixture answer',
      classification: 'public',
      mediaType: 'text/plain',
    });
    expect(clientEnvironment).toMatchObject({ OMK_TEST_EXPLICIT: 'visible' });
    expect(clientEnvironment).not.toHaveProperty('HOME');
    expect(codexHome).toEqual(expect.stringContaining('omk-codex-sdk-home-'));
    await expect(stat(codexHome ?? '')).rejects.toThrow();
    expect(fixture.observations.threadOptions).toEqual([{
      model: 'gpt-test',
      modelReasoningEffort: 'high',
      sandboxMode: 'read-only',
      workingDirectory: expect.stringContaining('omk-codex-run-'),
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      approvalPolicy: 'never',
    }]);
    const envelope = JSON.parse(
      fixture.observations.prompts[0]?.split('\n').at(-1) ?? '',
    ) as Record<string, unknown>;
    expect(envelope).toEqual({
      schemaVersion: 'omk.codex-sdk-prompt/v1',
      knowledgeArtifact: {
        artifactKind: 'file',
        instructions: '# Knowledge\nUse the SDK fixture rule.',
      },
      executionContext: { locale: 'zh-CN' },
      task: { question: 'Q', expected: 'must-not-be-inferred-as-gold' },
    });
  });

  it('creates a fresh thread for every Core attempt and forwards the exact signal', async () => {
    const fixture = await adapterFixture();
    const port = await createAdapter(fixture);
    const run = await port.openRun({ runId: 'run-a', executionPlanDigest: digest({ plan: 'a' }) });
    const trial = await run.openTrial({
      targetId: 'target-a',
      protocolId: 'omk.invoke/v1',
      input: 'Q',
      targetConfig: fixture.target.config as JsonValue,
      trialIndex: 0,
      trialId: digest({ trial: 'a' }),
      schedulingBlockId: digest({ block: 'a' }),
      samplingUnitIds: {},
    });
    const first = new AbortController();
    const second = new AbortController();
    try {
      await trial.execute({ attemptId: digest({ attempt: 1 }), attemptNumber: 1, signal: first.signal });
      await trial.execute({ attemptId: digest({ attempt: 2 }), attemptNumber: 2, signal: second.signal });
    } finally {
      await trial.dispose();
      await run.dispose();
    }
    expect(fixture.observations.threadOptions).toHaveLength(2);
    expect(fixture.observations.clientOptions).toHaveLength(2);
    expect(fixture.observations.signals).toEqual([first.signal, second.signal]);
  });

  it('projects trace and preserves reported or unknown usage without provider cost', async () => {
    const fixture = await adapterFixture();
    fixture.observations.mode = 'usage';
    const withUsage = await execute(
      await createAdapter(fixture),
      fixture.target.config as JsonValue,
    );
    expect(withUsage.usage).toEqual({
      inputTokens: 8,
      outputTokens: 5,
      totalTokens: 13,
      details: {
        cachedInputTokens: 3,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 2,
      },
    });
    expect(withUsage.usage).not.toHaveProperty('providerCost');
    expect(withUsage.trace?.value).toMatchObject({
      schemaVersion: 'omk.source-neutral-trace/v1',
      turns: [{ role: 'assistant', content: 'fixture answer' }],
    });

    fixture.observations.mode = 'success';
    const unknown = await execute(
      await createAdapter(fixture),
      fixture.target.config as JsonValue,
    );
    expect(unknown.usage).toBeUndefined();
  });

  it('uses the exact workspace overlay and elevates output classification', async () => {
    const fixture = await adapterFixture({ workspace: true });
    const result = await execute(
      await createAdapter(fixture),
      fixture.target.config as JsonValue,
    );
    expect(fixture.observations.threadOptions[0]).toMatchObject({
      sandboxMode: 'workspace-write',
      workingDirectory: join(fixture.root, 'workspace'),
    });
    expect(result.output?.classification).toBe('sensitive');
  });

  it.each([
    ['invalid', 'OMK_CODEX_SDK_PROTOCOL_INVALID'],
    ['runtime-error', 'OMK_CODEX_SDK_EXECUTION_FAILED'],
    ['create-error', 'OMK_CODEX_SDK_SESSION_FAILED'],
    ['start-error', 'OMK_CODEX_SDK_SESSION_FAILED'],
  ] as const)('redacts %s provider failures behind a stable boundary', async (mode, code) => {
    const fixture = await adapterFixture();
    fixture.observations.mode = mode;
    const promise = execute(
      await createAdapter(fixture),
      fixture.target.config as JsonValue,
    );
    await expect(promise).rejects.toMatchObject({ evaluationError: { code } });
    await expect(promise).rejects.not.toThrow(/sensitive provider failure/);
  });

  it('keeps trustworthy usage on a redacted failed turn', async () => {
    const fixture = await adapterFixture();
    fixture.observations.mode = 'failed-usage';
    await expect(execute(
      await createAdapter(fixture),
      fixture.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_CODEX_SDK_TURN_FAILED',
        message: 'Codex SDK reported a failed turn.',
      },
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
    });
  });

  it('bounds streamed events and closes the underlying SDK generator', async () => {
    const fixture = await adapterFixture();
    fixture.observations.mode = 'oversized';
    const port = await createAdapter(fixture, {}, { maxEventBytes: 256 });
    await expect(execute(port, fixture.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_SDK_OUTPUT_LIMIT_EXCEEDED' },
    });
    expect(fixture.observations.streamClosed).toBe(1);
    expect(JSON.stringify(port.identity.implementationManifest)).toContain('maxEventBytes');
  });

  it('forwards cancellation to the SDK and awaits stream settlement', async () => {
    const fixture = await adapterFixture();
    fixture.observations.mode = 'wait';
    const controller = new AbortController();
    const promise = execute(
      await createAdapter(fixture),
      fixture.target.config as JsonValue,
      controller.signal,
    );
    await expect.poll(() => fixture.observations.started).toBe(true);
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_SDK_CANCELLED' },
    });
    expect(fixture.observations.signals).toEqual([controller.signal]);
    expect(fixture.observations.streamClosed).toBe(1);
  });

  it('does not construct an SDK client for an already-cancelled Core attempt', async () => {
    const fixture = await adapterFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(execute(
      await createAdapter(fixture),
      fixture.target.config as JsonValue,
      controller.signal,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_SDK_CANCELLED' },
    });
    expect(fixture.observations.clientOptions).toHaveLength(0);
    expect(fixture.observations.threadOptions).toHaveLength(0);
  });

  it('keeps CODEX_HOME alive until an active trial settles during run disposal', async () => {
    const fixture = await adapterFixture();
    fixture.observations.mode = 'wait';
    const port = await createAdapter(fixture);
    const run = await port.openRun({ runId: 'run-a', executionPlanDigest: digest({ plan: 'a' }) });
    const trial = await run.openTrial({
      targetId: 'target-a',
      protocolId: 'omk.invoke/v1',
      input: 'Q',
      targetConfig: fixture.target.config as JsonValue,
      trialIndex: 0,
      trialId: digest({ trial: 'a' }),
      schedulingBlockId: digest({ block: 'a' }),
      samplingUnitIds: {},
    });
    const controller = new AbortController();
    const execution = trial.execute({
      attemptId: digest({ attempt: 'a' }),
      attemptNumber: 1,
      signal: controller.signal,
    });
    await expect.poll(() => fixture.observations.started).toBe(true);
    const codexHome = fixture.observations.clientOptions[0]?.env.CODEX_HOME ?? '';
    const trialDisposal = trial.dispose();
    const disposal = run.dispose();
    await expect(stat(codexHome)).resolves.toBeDefined();
    controller.abort();
    await expect(execution).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_SDK_CANCELLED' },
    });
    await trialDisposal;
    await disposal;
    await expect(stat(codexHome)).rejects.toThrow();
  });

  it('fails identity drift before a business thread starts', async () => {
    const fixture = await adapterFixture();
    const port = await createAdapter(fixture);
    await writeFile(fixture.identityPaths['codex-native.executable'], 'drift');
    await expect(execute(port, fixture.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_SDK_IDENTITY_CHANGED' },
    });
    expect(fixture.observations.threadOptions).toHaveLength(0);
    expect(fixture.observations.clientOptions).toHaveLength(0);
  });

  it('detects identity drift between SDK loading and thread creation', async () => {
    const fixture = await adapterFixture();
    const port = await createAdapter(fixture);
    fixture.observations.mode = 'drift-on-create';
    await expect(execute(port, fixture.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_SDK_IDENTITY_CHANGED' },
    });
    expect(fixture.observations.clientOptions).toHaveLength(1);
    expect(fixture.observations.threadOptions).toHaveLength(0);
  });

  it('rejects incomplete runtime identity coverage during assembly', async () => {
    const fixture = await adapterFixture();
    const incomplete = { ...fixture.runtime, contentIdentityFiles: [] };
    await expect(createAdapter(fixture, {}, {
      runtimeResolver: async () => incomplete,
    })).rejects.toThrow(/identity coverage is incomplete/);
  });

  it('rejects ambient CODEX_HOME instead of weakening run isolation', async () => {
    const fixture = await adapterFixture();
    await expect(createAdapter(fixture, { CODEX_HOME: '/mutable/profile' })).rejects.toThrow(
      /must not override adapter-owned CODEX_HOME/,
    );
  });

  it('fails unsupported behavior and inconsistent leases before an SDK thread starts', async () => {
    const unsupported = await adapterFixture({ allowedTools: ['shell'] });
    await expect(execute(
      await createAdapter(unsupported),
      unsupported.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_SDK_BEHAVIOR_UNSUPPORTED' },
    });
    expect(unsupported.observations.threadOptions).toHaveLength(0);

    const inconsistent = await adapterFixture({ leasedArtifactResourceId: 'poisoned' });
    await expect(execute(
      await createAdapter(inconsistent),
      inconsistent.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CODEX_SDK_RESOURCE_INVALID' },
    });
    expect(inconsistent.observations.threadOptions).toHaveLength(0);
  });

  it('passes real Core prepare only for requirements the SDK adapter supports', async () => {
    const fixture = await adapterFixture();
    const port = await createAdapter(fixture);
    const definition = validDefinition();
    definition.targets = [{ ...fixture.target }];
    definition.experiment.randomizationSlots = [{
      targetId: fixture.target.targetId,
      randomizationSlotId: 'slot-target-a',
    }];
    definition.experiment.sampling.seedCoupling = 'uncontrolled';
    definition.comparisons = [];
    const policy = validPolicy();
    policy.cache.executionMode = 'disabled';
    policy.evidence.trace = 'full';
    delete policy.execution.timeoutMs;
    policy.retry.maxAttempts = 1;
    const runtime = testRuntime();
    runtime.resolveExecutor = () => ({ identity: port.identity, satisfiesVersionConstraint: true });
    for (const validator of createCodexSdkCoreSchemaValidators()) {
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
    }, { runId: 'run-a', bundleId: 'bundle-codex-sdk' });
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

  it('exports strict validators for every advertised SDK schema', async () => {
    const fixture = await adapterFixture();
    const port = await createAdapter(fixture);
    const validators = createCodexSdkCoreSchemaValidators();
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
