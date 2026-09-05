import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
} from '../../../../../src/eval-core/contracts/index.js';
import { prepareEvaluationPlan } from '../../../../../src/eval-core/compiler/index.js';
import {
  InMemoryRuntimeEventSequencer,
  executeRunPlan,
  type ExecutionExecutor,
  type ExecutorAttemptResult,
} from '../../../../../src/eval-core/execution/index.js';
import {
  createAnthropicApiCoreSchemaValidators,
  createAnthropicApiExecutorAdapter,
  type AnthropicApiCoreConfiguration,
  type CoreApiTransport,
  type CoreApiTransportRequest,
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

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function digest(value: JsonValue): Sha256Digest {
  return digestCanonicalJson(value);
}

interface Observations {
  readonly requests: CoreApiTransportRequest[];
  response(request: CoreApiTransportRequest): Promise<Response>;
}

interface Fixture {
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly resourceAccess: OmkBindingResourceLeaseAccess;
  readonly observations: Observations;
  readonly transport: CoreApiTransport;
}

function successResponse(input: Readonly<{
  content?: unknown[];
  usage?: unknown;
  model?: string;
  stopReason?: string | null;
}> = {}): Response {
  return new Response(JSON.stringify({
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: input.model ?? 'claude-fixture-resolved',
    content: input.content ?? [{ type: 'text', text: 'fixture answer' }],
    stop_reason: input.stopReason ?? 'end_turn',
    stop_sequence: null,
    ...(input.usage === undefined ? {
      usage: {
        input_tokens: 8,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
        cache_creation: {
          ephemeral_1h_input_tokens: 1,
          ephemeral_5m_input_tokens: 0,
        },
        output_tokens_details: { thinking_tokens: 2 },
        inference_geo: 'global',
        service_tier: 'standard',
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
    } : input.usage === null ? {} : { usage: input.usage }),
  }), { headers: { 'content-type': 'application/json' } });
}

async function fixture(options: Readonly<{
  behaviorConfig?: JsonValue;
  behaviorConfigClassification?: 'public' | 'sensitive';
  behaviorPatch?: Record<string, JsonValue>;
  requirementPatch?: Record<string, JsonValue>;
  response?: (request: CoreApiTransportRequest) => Promise<Response>;
}> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'omk-anthropic-api-core-test-'));
  roots.add(root);
  const artifact = '# Knowledge\nUse the Anthropic API fixture rule.';
  const artifactPath = join(root, 'artifact.md');
  await writeFile(artifactPath, artifact);
  const descriptor = {
    resourceId: 'artifact-a',
    digest: digest({ artifact }),
    mediaType: 'text/markdown',
    classification: 'public' as const,
    size: Buffer.byteLength(artifact),
  };
  const behavior = {
    artifact: descriptor,
    ...(options.behaviorConfig === undefined ? {} : {
      config: {
        classification: options.behaviorConfigClassification ?? 'public',
        value: options.behaviorConfig,
      },
    }),
    ...(options.behaviorPatch ?? {}),
  };
  const config = {
    behavior,
    runtime: { model: 'claude-fixture', effort: 'xhigh' as const },
  };
  const executionRequirements = {
    systemInstructions: 'required' as const,
    workspace: 'not-required' as const,
    mcp: 'not-required' as const,
    mockInterception: 'not-required' as const,
    toolPolicy: 'runtime-default' as const,
    skillDiscovery: 'runtime-default' as const,
    ...(options.requirementPatch ?? {}),
  };
  const target = {
    targetId: 'target-a',
    targetKind: 'skill',
    protocolId: 'omk.invoke/v1',
    executorId: 'test.omk.anthropic-api/v1',
    executionRequirements,
    executionControls: {
      defaults: {
        workspace: { workspaceMode: 'not-required' },
        tools: options.requirementPatch?.toolPolicy === 'allow-list'
          ? { toolPolicyKind: 'allow-list', allowedTools: [] }
          : { toolPolicyKind: 'runtime-default' },
        mcp: { mcpMode: 'not-required' },
      },
      sampleOverrides: [],
    },
    config,
  } as EvaluationDefinition['targets'][number];
  const binding: RuntimeBindingOf<'executor'> = {
    runtimeKind: 'executor',
    bindingId: 'executor-target-a',
    targetId: 'target-a',
    implementationId: 'test.omk.anthropic-api/v1',
    protocolId: 'omk.invoke/v1',
    behaviorConfigDigest: digest(config),
    executionControlsDigest: digest(target.executionControls),
    resourceLeaseRequirements: [{
      resourceId: 'artifact-a',
      resourceRole: 'artifact',
      leaseMode: 'immutable-snapshot',
    }],
    qualification: {
      model: 'claude-fixture',
      effort: 'xhigh',
      executionRequirements,
      resourceIntegrity: 'digest-before-use',
    },
  };
  const resource: OmkLeasedHostResource = {
    resourceId: 'artifact-a',
    resourceKind: 'artifact',
    descriptor,
    snapshotKind: 'file',
    leaseMode: 'immutable-snapshot',
    snapshotPath: artifactPath,
  };
  const lease: OmkBindingResourceLease = Object.freeze({
    bindingId: binding.bindingId,
    consumerKind: 'executor',
    resourcesByResourceId: new Map([['artifact-a', resource]]),
  });
  const observations: Observations = {
    requests: [],
    response: options.response ?? (async () => successResponse()),
  };
  const transport: CoreApiTransport = {
    identity: {
      transportId: 'test.anthropic-api-transport',
      version: '1.0.0',
      fingerprint: digest({ transport: 'fixture' }),
      fingerprintBasis: 'content-derived',
      assuranceLevel: 'verified',
      concurrencySafety: 'parallel-safe',
      cancellation: 'cooperative',
      retrySemantics: 'none',
    },
    async request(request) {
      observations.requests.push(request);
      return observations.response(request);
    },
  };
  return {
    target,
    binding,
    observations,
    transport,
    resourceAccess: {
      forRun(runId) {
        expect(runId).toBe('run-a');
        return lease;
      },
    },
  };
}

async function createAdapter(
  value: Fixture,
  api: Partial<AnthropicApiCoreConfiguration> = {},
): Promise<ExecutionExecutor> {
  return createAnthropicApiExecutorAdapter({
    target: value.target,
    binding: value.binding,
    api: {
      apiKey: 'fixture-secret-key',
      transport: value.transport,
      ...api,
    },
    sessionIsolationKey: 'anthropic-api-session-a',
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
    signal: new AbortController().signal,
    sampleId: 'sample-a',
    targetId: 'target-a',
    executionCoordinateDigest: digest({ coordinate: 'a' }),
    executionControl: {
      workspace: { workspaceMode: 'not-required' },
      tools: { toolPolicyKind: 'runtime-default' },
      mcp: { mcpMode: 'not-required' },
    },
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

describe('Anthropic API Core Executor adapter', () => {
  it('keeps credentials identity-invariant while endpoint changes identity', async () => {
    const value = await fixture();
    const first = await createAdapter(value, { apiKey: 'first-secret' });
    const rotated = await createAdapter(value, { apiKey: 'rotated-secret' });
    const relocated = await createAdapter(value, {
      apiKey: 'first-secret',
      endpoint: 'https://proxy.example.test/anthropic/messages',
    });

    expect(first.identity).toEqual(rotated.identity);
    expect(first.identity.fingerprint).not.toBe(relocated.identity.fingerprint);
    expect(JSON.stringify(first.identity)).not.toContain('first-secret');
    expect(JSON.stringify(relocated.identity)).not.toContain('proxy.example.test');
    expect(first.identity).toMatchObject({
      implementationId: 'test.omk.anthropic-api/v1',
      version: '1.1.0',
      fingerprintBasis: 'opaque',
      assuranceLevel: 'unknown',
      capabilities: {
        protocols: [{
          protocolId: 'omk.invoke/v1',
          execution: {
            concurrency: { safety: 'parallel-safe' },
            cancellation: 'cooperative',
          },
        }],
      },
    });
  });

  it('projects the sealed target into the current Messages API request', async () => {
    const value = await fixture({
      behaviorConfig: { maxOutputTokens: 321, stopSequences: ['<END>'] },
    });
    const result = await execute(await createAdapter(value), value.target.config as JsonValue);

    expect(result.output).toEqual({
      value: 'fixture answer',
      classification: 'secret',
      mediaType: 'text/plain',
    });
    expect(result.trace?.value).toEqual({
      schemaVersion: 'omk.source-neutral-trace/v2',
      turns: [{ role: 'assistant', content: 'fixture answer' }],
      toolCalls: [],
      numTurns: 1,
      fullNumTurns: 1,
      numSubAgents: 0,
    });
    const request = value.observations.requests[0]!;
    expect(request.endpoint).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': 'fixture-secret-key',
      'anthropic-version': '2023-06-01',
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(request.body)).toMatchObject({
      model: 'claude-fixture',
      max_tokens: 321,
      messages: [{ role: 'user', content: expect.stringContaining('omk.anthropic-api-prompt/v1') }],
      stream: false,
      system: '# Knowledge\nUse the Anthropic API fixture rule.',
      output_config: { effort: 'xhigh' },
      stop_sequences: ['<END>'],
    });
    expect(request.body).not.toContain('fixture-secret-key');
  });

  it('preserves exclusive cache usage and leaves provider cost unknown', async () => {
    const value = await fixture();
    const result = await execute(await createAdapter(value), value.target.config as JsonValue);

    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16,
      details: {
        provider: 'anthropic',
        responseModel: 'claude-fixture-resolved',
        stopReason: 'end_turn',
        stopSequence: null,
        tokenAccounting: 'exclusive-cache-input-buckets',
        uncachedInputTokens: 8,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        cacheCreationInputTokens1h: 1,
        cacheCreationInputTokens5m: 0,
        thinkingOutputTokens: 2,
        inferenceGeo: 'global',
        serviceTier: 'standard',
      },
    });
    expect(result.usage).not.toHaveProperty('providerCost');
  });

  it('keeps unreported token usage unknown while retaining response provenance', async () => {
    const value = await fixture({ response: async () => successResponse({ usage: null }) });
    const result = await execute(await createAdapter(value), value.target.config as JsonValue);

    expect(result.usage).toEqual({
      details: {
        provider: 'anthropic',
        responseModel: 'claude-fixture-resolved',
        stopReason: 'end_turn',
        stopSequence: null,
        tokenAccounting: 'exclusive-cache-input-buckets',
      },
    });
    expect(result.usage).not.toHaveProperty('inputTokens');
    expect(result.usage).not.toHaveProperty('outputTokens');
    expect(result.usage).not.toHaveProperty('totalTokens');

    const partial = await fixture({
      response: async () => successResponse({
        usage: { input_tokens: 8, output_tokens: 5 },
      }),
    });
    const partialResult = await execute(
      await createAdapter(partial),
      partial.target.config as JsonValue,
    );
    expect(partialResult.usage).toMatchObject({
      outputTokens: 5,
      details: { uncachedInputTokens: 8 },
    });
    expect(partialResult.usage).not.toHaveProperty('inputTokens');
    expect(partialResult.usage).not.toHaveProperty('totalTokens');

    const nullable = await fixture({
      response: async () => successResponse({
        usage: {
          input_tokens: 8,
          output_tokens: 5,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      }),
    });
    const nullableResult = await execute(
      await createAdapter(nullable),
      nullable.target.config as JsonValue,
    );
    expect(nullableResult.usage).toMatchObject({
      outputTokens: 5,
      details: { uncachedInputTokens: 8 },
    });
    expect(nullableResult.usage).not.toHaveProperty('inputTokens');

    const emptyGeo = await fixture({
      response: async () => successResponse({
        usage: {
          input_tokens: 8,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          inference_geo: '',
        },
      }),
    });
    const emptyGeoResult = await execute(
      await createAdapter(emptyGeo),
      emptyGeo.target.config as JsonValue,
    );
    expect(emptyGeoResult.usage?.details).toMatchObject({ inferenceGeo: '' });
  });

  it('redacts provider bodies and exposes only stable retry classes', async () => {
    const rejected = await fixture({
      response: async () => new Response(
        JSON.stringify({ error: { message: 'sensitive provider rejection' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    });
    await expect(execute(
      await createAdapter(rejected),
      rejected.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_ANTHROPIC_API_REQUEST_REJECTED',
        message: 'Anthropic API rejected the request.',
      },
    });

    const overloaded = await fixture({
      response: async () => new Response('sensitive overload details', { status: 529 }),
    });
    await expect(execute(
      await createAdapter(overloaded),
      overloaded.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'transport-error', stage: 'infrastructure' },
    });
  });

  it('fails malformed and oversized success responses closed', async () => {
    const malformed = await fixture({
      response: async () => successResponse({
        content: [{ type: 'text', text: 42 }],
      }),
    });
    await expect(execute(
      await createAdapter(malformed),
      malformed.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_ANTHROPIC_API_PROTOCOL_INVALID' },
      usage: { inputTokens: 11, outputTokens: 5 },
    });

    const oversized = await fixture();
    await expect(execute(
      await createAdapter(oversized, { maxResponseBytes: 32 }),
      oversized.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_ANTHROPIC_API_OUTPUT_LIMIT_EXCEEDED' },
    });

    const unexpectedTool = await fixture({
      response: async () => successResponse({
        content: [
          { type: 'text', text: 'partial answer' },
          { type: 'tool_use', id: 'tool-a', name: 'unexpected', input: {} },
        ],
      }),
    });
    await expect(execute(
      await createAdapter(unexpectedTool),
      unexpectedTool.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_ANTHROPIC_API_PROTOCOL_INVALID' },
    });

    const hiddenServerTool = await fixture({
      response: async () => successResponse({
        usage: {
          input_tokens: 8,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          server_tool_use: { web_search_requests: 1 },
        },
      }),
    });
    await expect(execute(
      await createAdapter(hiddenServerTool),
      hiddenServerTool.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_ANTHROPIC_API_PROTOCOL_INVALID' },
    });
  });

  it('forwards cancellation to the transport and waits for settlement', async () => {
    let started = false;
    let settled = false;
    const value = await fixture({
      response: async (request) => new Promise<Response>((_resolve, reject) => {
        started = true;
        request.signal.addEventListener('abort', () => {
          settled = true;
          reject(new DOMException('sensitive abort reason', 'AbortError'));
        }, { once: true });
      }),
    });
    const controller = new AbortController();
    const promise = execute(
      await createAdapter(value),
      value.target.config as JsonValue,
      controller.signal,
    );
    await expect.poll(() => started).toBe(true);
    controller.abort();

    await expect(promise).rejects.toMatchObject({
      evaluationError: { code: 'OMK_ANTHROPIC_API_CANCELLED' },
    });
    expect(settled).toBe(true);
  });

  it('rejects unsupported agent controls and deprecated sampling config before calls', async () => {
    const tools = await fixture({
      requirementPatch: { toolPolicy: 'allow-list' },
    });
    await expect(createAdapter(tools)).rejects.toThrow(/supports no workspace, MCP, mocks/);

    const temperature = await fixture({ behaviorConfig: { temperature: 0 } });
    await expect(createAdapter(temperature)).rejects.toThrow();
    await expect(createAdapter(temperature, {
      endpoint: 'http://provider.example.test/v1/messages',
    })).rejects.toThrow(/must use HTTPS/);
    expect(tools.observations.requests).toHaveLength(0);
    expect(temperature.observations.requests).toHaveLength(0);
  });

  it('passes real Core prepare and execution with the advertised contract', async () => {
    const value = await fixture();
    const port = await createAdapter(value);
    const definition = validDefinition();
    definition.targets = [{ ...value.target }];
    definition.experiment.randomizationSlots = [{
      targetId: value.target.targetId,
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
    policy.evidence.maximumClassification = 'secret';
    delete policy.execution.timeoutMs;
    policy.retry.maxAttempts = 1;
    const runtime = testRuntime();
    runtime.resolveExecutor = () => ({ identity: port.identity, satisfiesVersionConstraint: true });
    for (const validator of createAnthropicApiCoreSchemaValidators()) {
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
    }, { runId: 'run-a', bundleId: 'bundle-anthropic-api' });

    expect(bundle.executionBundleStatus).toBe('completed');
    expect(bundle.records[0]).toMatchObject({
      executionStatus: 'completed',
      output: { value: 'fixture answer', classification: 'secret' },
    });
  });
});
