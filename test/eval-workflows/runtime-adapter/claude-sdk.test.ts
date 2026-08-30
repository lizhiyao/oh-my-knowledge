import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  executeRunPlan,
  type ExecutionExecutor,
  type ExecutorAttemptResult,
} from '../../../src/evaluation-core/execution/index.js';
import {
  createClaudeSdkCoreSchemaValidators,
  createClaudeSdkExecutorAdapter,
  type ClaudeSdkCoreConfiguration,
  type ClaudeSdkEnvironmentEntry,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryInput,
  type OmkBindingResourceLease,
  type OmkBindingResourceLeaseAccess,
  type OmkLeasedHostResource,
  type ResolvedClaudeSdkRuntime,
  type RuntimeBindingOf,
} from '../../../src/eval-workflows/runtime-adapter/index.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from '../../evaluation-core/compiler/fixtures.js';

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function digest(value: JsonValue): Sha256Digest {
  return digestCanonicalJson(value);
}

type RuntimeMode =
  | 'success'
  | 'no-usage'
  | 'failed'
  | 'invalid'
  | 'oversized'
  | 'wait'
  | 'create-error'
  | 'runtime-error'
  | 'invalid-query';

interface Observations {
  mode: RuntimeMode;
  resolverCalls: number;
  queries: ClaudeSdkQueryInput[];
  closeCalls: number;
  started: boolean;
  aborted: boolean;
}

interface Fixture {
  readonly root: string;
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly resourceAccess: OmkBindingResourceLeaseAccess;
  readonly runtime: ResolvedClaudeSdkRuntime;
  readonly observations: Observations;
  readonly identityPaths: Readonly<Record<string, string>>;
}

function messages(mode: RuntimeMode): unknown[] {
  const assistant = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }] },
    uuid: 'assistant-a',
    session_id: 'session-a',
  };
  const result = {
    type: 'result',
    subtype: mode === 'failed' ? 'error_during_execution' : 'success',
    is_error: mode === 'failed',
    result: 'fixture answer',
    ...(mode === 'no-usage' ? {} : {
      total_cost_usd: 0.002,
      modelUsage: {
        'claude-test': {
          inputTokens: 8,
          outputTokens: 5,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
        },
      },
    }),
    ...(mode === 'failed' ? { errors: ['sensitive provider failure'] } : {}),
    uuid: 'result-a',
    session_id: 'session-a',
  };
  return [
    { type: 'system', subtype: 'init', session_id: 'session-a', uuid: 'system-a' },
    assistant,
    ...(mode === 'invalid' ? [{ future: 'missing type' }] : []),
    result,
  ];
}

async function fixture(options: Readonly<{
  mcp?: boolean;
  mocks?: boolean;
  mockTool?: string;
  allowedTools?: readonly string[];
  allowedSkills?: readonly string[];
}> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'omk-claude-sdk-core-test-'));
  roots.add(root);
  const artifact = '# Knowledge\nUse the SDK fixture rule.';
  const artifactPath = join(root, 'artifact.md');
  await writeFile(artifactPath, artifact);
  const identityPaths = {
    'claude-sdk.package-manifest': join(root, 'sdk-package.json'),
    'claude-sdk.entrypoint': join(root, 'sdk.mjs'),
    'claude-native.package-manifest': join(root, 'native-package.json'),
    'claude-native.executable': join(root, 'claude'),
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
  const mcpText = JSON.stringify({
    mcpServers: { search: { command: 'node', args: ['server.mjs'] } },
  });
  const mcpPath = join(root, 'mcp.json');
  if (options.mcp) await writeFile(mcpPath, mcpText);
  const mcpDescriptor = {
    resourceId: 'mcp-a',
    digest: digest({ mcpText }),
    mediaType: 'application/json',
    classification: 'sensitive' as const,
    size: Buffer.byteLength(mcpText),
  };
  const mockText = JSON.stringify({ result: 'mocked' });
  const mockPath = join(root, 'mock.json');
  if (options.mocks) await writeFile(mockPath, mockText);
  const mockDescriptor = {
    resourceId: 'mock-a',
    digest: digest({ mockText }),
    mediaType: 'application/json',
    classification: 'secret' as const,
    size: Buffer.byteLength(mockText),
  };
  const config = {
    behavior: {
      artifact: artifactDescriptor,
      ...(options.mcp ? { mcpConfig: mcpDescriptor } : {}),
      ...(options.mocks ? {
        mocks: [{
          matchRules: { tool: options.mockTool ?? 'Bash' },
          strict: true,
          payloads: [mockDescriptor],
        }],
      } : {}),
      ...(options.allowedTools === undefined ? {} : { allowedTools: [...options.allowedTools] }),
      ...(options.allowedSkills === undefined ? {} : { allowedSkills: [...options.allowedSkills] }),
    },
    runtime: { model: 'claude-test', effort: 'high' as const },
  };
  const executionRequirements = {
    systemInstructions: 'required' as const,
    workspace: 'not-required' as const,
    mcp: options.mcp ? 'native-config' as const : 'not-required' as const,
    mockInterception: options.mocks ? 'pre-tool-call' as const : 'not-required' as const,
    toolPolicy: options.allowedTools === undefined ? 'runtime-default' as const : 'allow-list' as const,
    skillDiscovery: options.allowedSkills === undefined
      ? 'runtime-default' as const
      : options.allowedSkills.length === 0
        ? 'disabled' as const
        : 'allow-list' as const,
  };
  const target: EvaluationDefinition['targets'][number] = {
    targetId: 'target-a',
    targetKind: 'skill',
    protocolId: 'omk.invoke/v1',
    executorId: 'test.omk.claude-sdk/v1',
    executionRequirements,
    config,
  };
  const binding: RuntimeBindingOf<'executor'> = {
    runtimeKind: 'executor',
    bindingId: 'executor-target-a',
    targetId: 'target-a',
    implementationId: 'test.omk.claude-sdk/v1',
    protocolId: 'omk.invoke/v1',
    behaviorConfigDigest: digest(config),
    resourceLeaseRequirements: [{
      resourceId: 'artifact-a',
      resourceRole: 'artifact',
      leaseMode: 'immutable-snapshot',
    }, ...(options.mcp ? [{
      resourceId: 'mcp-a',
      resourceRole: 'mcp-config' as const,
      leaseMode: 'immutable-snapshot' as const,
    }] : []), ...(options.mocks ? [{
      resourceId: 'mock-a',
      resourceRole: 'mock-payload' as const,
      leaseMode: 'immutable-snapshot' as const,
    }] : [])],
    qualification: {
      model: 'claude-test',
      effort: 'high',
      executionRequirements,
      resourceIntegrity: 'digest-before-use',
    },
  };
  const resources = new Map<string, OmkLeasedHostResource>([['artifact-a', {
    resourceId: 'artifact-a',
    resourceKind: 'artifact',
    descriptor: artifactDescriptor,
    snapshotKind: 'file',
    leaseMode: 'immutable-snapshot',
    snapshotPath: artifactPath,
  }]]);
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
  const lease: OmkBindingResourceLease = Object.freeze({
    bindingId: binding.bindingId,
    consumerKind: 'executor',
    resourcesByResourceId: resources,
  });
  const observations: Observations = {
    mode: 'success',
    resolverCalls: 0,
    queries: [],
    closeCalls: 0,
    started: false,
    aborted: false,
  };
  const runtime: ResolvedClaudeSdkRuntime = {
    sdkVersion: '0.3.143',
    claudeCodeVersion: '2.1.143',
    contentIdentityFiles: Object.entries(identityPaths).map(([facetId, path]) => ({ facetId, path })),
    createQuery(input) {
      observations.queries.push(input);
      if (observations.mode === 'create-error') throw new Error('sensitive create failure');
      if (observations.mode === 'invalid-query') {
        return {
          close() {
            observations.closeCalls += 1;
          },
        } as unknown as ClaudeSdkQuery;
      }
      const stream = async function* (): AsyncGenerator<unknown> {
        if (observations.mode === 'runtime-error') {
          throw new Error('sensitive runtime failure');
        }
        if (observations.mode === 'wait') {
          observations.started = true;
          await new Promise<void>((_resolve, reject) => {
            input.options.abortController.signal.addEventListener('abort', () => {
              observations.aborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
          });
          return;
        }
        if (observations.mode === 'oversized') {
          yield { type: 'system', payload: 'x'.repeat(4096) };
          return;
        }
        yield* messages(observations.mode);
      }();
      return Object.assign(stream, {
        close() {
          observations.closeCalls += 1;
        },
      }) satisfies ClaudeSdkQuery;
    },
  };
  return {
    root,
    target,
    binding,
    runtime,
    observations,
    identityPaths,
    resourceAccess: {
      forRun(runId) {
        expect(runId).toBe('run-a');
        return lease;
      },
    },
  };
}

function environment(secret?: string): Readonly<Record<string, ClaudeSdkEnvironmentEntry>> {
  return {
    ...(secret === undefined ? {} : {
      OMK_TEST_SECRET: { value: secret, identity: { identityKind: 'credential' as const } },
    }),
  };
}

async function createAdapter(
  value: Fixture,
  sdk: Partial<ClaudeSdkCoreConfiguration> = {},
): Promise<ExecutionExecutor> {
  return createClaudeSdkExecutorAdapter({
    target: value.target,
    binding: value.binding,
    sdk: {
      runtimeResolver: async () => {
        value.observations.resolverCalls += 1;
        return value.runtime;
      },
      ...sdk,
    },
    sessionIsolationKey: 'claude-sdk-session-a',
    resourceLeases: value.resourceAccess,
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
    input: { question: 'Q' },
    executionContext: { locale: 'zh-CN' },
    targetConfig,
    trialIndex: 0,
    trialId: digest({ trial: 'a' }),
    schedulingBlockId: digest({ block: 'a' }),
    samplingUnitIds: {},
  });
  try {
    return await trial.execute({ attemptId: digest({ attempt: 'a' }), attemptNumber: 1, signal });
  } finally {
    await trial.dispose();
    await run.dispose();
  }
}

describe('Claude SDK Core Executor adapter', () => {
  it('captures SDK/native identity once per assembly without persisting credential values', async () => {
    const value = await fixture();
    const first = await createAdapter(value, { environment: environment('first-secret') });
    const rotated = await createAdapter(value, { environment: environment('rotated-secret') });
    expect(first.identity).toEqual(rotated.identity);
    expect(value.observations.resolverCalls).toBe(2);
    expect(JSON.stringify(first.identity)).not.toContain('first-secret');
    expect(first.identity).toMatchObject({
      implementationId: 'test.omk.claude-sdk/v1',
      version: '0.3.143',
      fingerprintBasis: 'content-derived',
      assuranceLevel: 'declared',
      capabilities: { protocols: [expect.objectContaining({ protocolId: 'omk.invoke/v1' })] },
    });
    expect(JSON.stringify(first.identity.implementationManifest)).toContain('2.1.143');
  });

  it('uses isolated native SDK options and keeps unknown usage absent', async () => {
    const value = await fixture({ allowedTools: ['Read'], allowedSkills: [] });
    value.observations.mode = 'no-usage';
    const result = await execute(
      await createAdapter(value, { environment: environment('credential') }),
      value.target.config as JsonValue,
    );
    expect(result.output).toMatchObject({ value: 'fixture answer', classification: 'secret' });
    expect(result.usage).toBeUndefined();
    const input = value.observations.queries[0]!;
    expect(input.prompt).toContain('The input envelope is canonical JSON');
    expect(input.prompt).toContain('omk.claude-sdk-prompt/v1');
    expect(input.options).toMatchObject({
      model: 'claude-test',
      effort: 'high',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      settingSources: [],
      tools: ['Read'],
      skills: [],
      disallowedTools: ['mcp__*', 'Skill'],
      strictMcpConfig: true,
      extraArgs: {
        'mcp-config': '{"mcpServers":{}}',
        'no-chrome': null,
      },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    });
    expect(input.options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    expect(input.options.env.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBe('1');
    await expect(realpath(input.options.env.CLAUDE_CONFIG_DIR!)).rejects.toThrow();
    expect(value.observations.closeCalls).toBe(1);
  });

  it('maps provider usage and preserves it on a failed terminal turn', async () => {
    const value = await fixture();
    const reported = await execute(await createAdapter(value), value.target.config as JsonValue);
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
    value.observations.mode = 'failed';
    await expect(execute(
      await createAdapter(value),
      value.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CLAUDE_SDK_TURN_FAILED' },
      usage: { inputTokens: 11, outputTokens: 5 },
    });
  });

  it('fails invalid and oversized streams closed while disposing the query', async () => {
    const invalid = await fixture();
    invalid.observations.mode = 'invalid';
    await expect(execute(
      await createAdapter(invalid),
      invalid.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CLAUDE_SDK_PROTOCOL_INVALID' },
    });
    expect(invalid.observations.closeCalls).toBe(1);

    const oversized = await fixture();
    oversized.observations.mode = 'oversized';
    await expect(execute(
      await createAdapter(oversized, { maxEventBytes: 256 }),
      oversized.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CLAUDE_SDK_OUTPUT_LIMIT_EXCEEDED' },
    });
    expect(oversized.observations.closeCalls).toBe(1);
  });

  it('redacts session and stream failures and removes attempt state', async () => {
    for (const mode of ['create-error', 'runtime-error', 'invalid-query'] as const) {
      const value = await fixture();
      value.observations.mode = mode;
      await expect(execute(
        await createAdapter(value),
        value.target.config as JsonValue,
      )).rejects.toMatchObject({
        evaluationError: {
          code: mode === 'runtime-error'
            ? 'OMK_CLAUDE_SDK_EXECUTION_FAILED'
            : 'OMK_CLAUDE_SDK_SESSION_FAILED',
          message: mode === 'runtime-error'
            ? 'Claude SDK execution failed.'
            : 'Claude SDK attempt session could not be created.',
        },
      });
      await expect(realpath(
        value.observations.queries[0]!.options.env.CLAUDE_CONFIG_DIR!,
      )).rejects.toThrow();
    }
  });

  it('forwards cancellation into the SDK and waits for the iterator to settle', async () => {
    const value = await fixture();
    value.observations.mode = 'wait';
    const controller = new AbortController();
    const promise = execute(
      await createAdapter(value),
      value.target.config as JsonValue,
      controller.signal,
    );
    await expect.poll(() => value.observations.started).toBe(true);
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CLAUDE_SDK_CANCELLED' },
    });
    expect(value.observations.aborted).toBe(true);
    expect(value.observations.closeCalls).toBe(1);
  });

  it('fails identity drift before creating a provider query', async () => {
    const value = await fixture();
    const port = await createAdapter(value);
    await writeFile(value.identityPaths['claude-native.executable']!, 'drift');
    await expect(execute(port, value.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CLAUDE_SDK_IDENTITY_CHANGED' },
    });
    expect(value.observations.queries).toHaveLength(0);
  });

  it('supports MCP hook mocks only when the sealed server exists', async () => {
    const valid = await fixture({ mcp: true, mocks: true, mockTool: 'mcp__search__query' });
    await execute(await createAdapter(valid), valid.target.config as JsonValue);
    expect(valid.observations.queries[0]!.options.mcpServers).toHaveProperty('search');
    expect(valid.observations.queries[0]!.options.hooks).toHaveProperty('PreToolUse');

    const missing = await fixture({ mocks: true, mockTool: 'mcp__search__query' });
    await expect(execute(
      await createAdapter(missing),
      missing.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_CLAUDE_SDK_MCP_CONFIG_INVALID' },
    });
    expect(missing.observations.queries).toHaveLength(0);
  });

  it('rejects contradictory tool and skill policies before runtime assembly', async () => {
    const dynamicTool = await fixture({ allowedTools: ['mcp__search__query'] });
    await expect(createAdapter(dynamicTool)).rejects.toThrow(/must not contain MCP tools/);

    const disabledSkillTool = await fixture({ allowedTools: ['Skill'], allowedSkills: [] });
    await expect(createAdapter(disabledSkillTool)).rejects.toThrow(/conflict with the Skill tool/);
  });

  it('passes real Core prepare with the exact advertised contract', async () => {
    const value = await fixture();
    const port = await createAdapter(value);
    const definition = validDefinition();
    definition.targets = [{ ...value.target }];
    definition.experiment.randomizationSlots = [{
      targetId: value.target.targetId,
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
    for (const validator of createClaudeSdkCoreSchemaValidators()) {
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
    }, { runId: 'run-a', bundleId: 'bundle-claude-sdk' });
    expect(bundle.executionBundleStatus).toBe('completed');
    expect(bundle.records[0]).toMatchObject({
      executionStatus: 'completed',
      output: { value: 'fixture answer', classification: 'public' },
    });
  });
});
