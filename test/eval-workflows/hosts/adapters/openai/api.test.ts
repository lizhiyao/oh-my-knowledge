import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  createOpenAIApiCoreSchemaValidators,
} from '../../../../../src/eval-workflows/hosts/adapters/openai/protocol.js';
import {
  createOpenAIApiExecutorAdapter,
  type OpenAIApiCoreConfiguration,
} from '../../../../../src/eval-workflows/hosts/adapters/openai/api.js';
import {
  type CoreApiTransport,
  type CoreApiTransportRequest,
} from '../../../../../src/eval-workflows/hosts/adapters/shared/api-http.js';
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

const roots = new Set<string>();

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
  output?: unknown[];
  usage?: unknown;
  model?: string;
  status?: string;
  error?: unknown;
  statePatch?: Record<string, unknown>;
}> = {}): Response {
  return new Response(JSON.stringify({
    id: 'resp_fixture',
    object: 'response',
    model: input.model ?? 'gpt-5.6-fixture-resolved',
    status: input.status ?? 'completed',
    output: input.output ?? [{
      id: 'rs_fixture',
      type: 'reasoning',
      summary: [],
    }, {
      id: 'msg_fixture',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'fixture answer', annotations: [] }],
    }],
    service_tier: 'default',
    reasoning: { effort: 'xhigh', summary: null },
    store: false,
    background: false,
    previous_response_id: null,
    conversation: null,
    tools: [],
    tool_choice: 'none',
    parallel_tool_calls: false,
    truncation: 'disabled',
    error: input.error ?? null,
    ...(input.usage === undefined ? {
      usage: {
        input_tokens: 13,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 20,
      },
    } : { usage: input.usage }),
    ...(input.statePatch ?? {}),
  }), { headers: { 'content-type': 'application/json' } });
}

async function fixture(options: Readonly<{
  behaviorConfig?: JsonValue;
  behaviorPatch?: Record<string, JsonValue>;
  requirementPatch?: Record<string, JsonValue>;
  response?: (request: CoreApiTransportRequest) => Promise<Response>;
}> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'omk-openai-api-core-test-'));
  roots.add(root);
  const artifact = '# Knowledge\nUse the OpenAI API fixture rule.';
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
      config: { classification: 'public' as const, value: options.behaviorConfig },
    }),
    ...(options.behaviorPatch ?? {}),
  };
  const config = {
    behavior,
    runtime: { model: 'gpt-5.6-fixture', effort: 'xhigh' as const },
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
    executorId: 'test.omk.openai-api/v1',
    executionRequirements,
    executionControls: {
      defaults: {
        workspace: { workspaceMode: 'not-required' },
        tools: options.requirementPatch?.toolPolicy === 'allow-list'
          ? { toolPolicyKind: 'allow-list', allowedTools: [] }
          : { toolPolicyKind: 'runtime-default' },
        mcp: { mcpMode: 'not-required' },
        mockInterception: { mockInterceptionMode: 'not-required' },
      },
      sampleOverrides: [],
    },
    config,
  } as EvaluationDefinition['targets'][number];
  const binding: RuntimeBindingOf<'executor'> = {
    runtimeKind: 'executor',
    bindingId: 'executor-target-a',
    targetId: 'target-a',
    implementationId: 'test.omk.openai-api/v1',
    protocolId: 'omk.invoke/v1',
    behaviorConfigDigest: digest(config),
    executionControlsDigest: digest(target.executionControls),
    resourceLeaseRequirements: [{
      resourceId: 'artifact-a',
      resourceRole: 'artifact',
      leaseMode: 'immutable-snapshot',
    }],
    qualification: {
      model: 'gpt-5.6-fixture',
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
      transportId: 'test.openai-api-transport',
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
  api: Partial<OpenAIApiCoreConfiguration> = {},
): Promise<ExecutionExecutor> {
  return createOpenAIApiExecutorAdapter({
    target: value.target,
    binding: value.binding,
    api: { apiKey: 'fixture-secret-key', transport: value.transport, ...api },
    sessionIsolationKey: 'openai-api-session-a',
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
      mockInterception: { mockInterceptionMode: 'not-required' },
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

describe('OpenAI API Core Executor adapter', () => {
  it('advertises trace v2 and keeps stateless provider constraints fail-closed', () => {
    const traceValidator = createOpenAIApiCoreSchemaValidators().find(
      (validator) => validator.schema.schemaVersion === 'omk.openai-api-trace/v2',
    );
    expect(traceValidator).toBeDefined();
    expect(() => traceValidator!.parse({
      schemaVersion: 'omk.source-neutral-trace/v2',
      turns: [{ role: 'assistant', content: 'answer' }],
      toolCalls: [],
      numTurns: 2,
      fullNumTurns: 1,
      numSubAgents: 0,
    })).toThrow();
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

  it('keeps credentials identity-invariant while effect locators change identity', async () => {
    const value = await fixture();
    const first = await createAdapter(value, { apiKey: 'first-secret' });
    const rotated = await createAdapter(value, { apiKey: 'rotated-secret' });
    const relocated = await createAdapter(value, {
      apiKey: 'first-secret',
      endpoint: 'https://proxy.example.test/openai/responses',
      organization: 'org-sensitive',
      project: 'proj-sensitive',
    });

    expect(first.identity).toEqual(rotated.identity);
    expect(first.identity.fingerprint).not.toBe(relocated.identity.fingerprint);
    expect(JSON.stringify(first.identity)).not.toContain('first-secret');
    expect(JSON.stringify(relocated.identity)).not.toMatch(/proxy\.example|org-sensitive|proj-sensitive/);
    expect(first.identity).toMatchObject({
      implementationId: 'test.omk.openai-api/v1',
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

  it('projects the sealed target into a stateless Responses API request', async () => {
    const value = await fixture({ behaviorConfig: { maxOutputTokens: 321 } });
    const result = await execute(await createAdapter(value, {
      organization: 'org-fixture',
      project: 'proj-fixture',
    }), value.target.config as JsonValue);

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
    expect(request.endpoint).toBe('https://api.openai.com/v1/responses');
    expect(request.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer fixture-secret-key',
      'content-type': 'application/json',
      'openai-organization': 'org-fixture',
      'openai-project': 'proj-fixture',
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(request.body)).toMatchObject({
      model: 'gpt-5.6-fixture',
      input: expect.stringContaining('omk.openai-api-prompt/v1'),
      instructions: '# Knowledge\nUse the OpenAI API fixture rule.',
      max_output_tokens: 321,
      stream: false,
      store: false,
      background: false,
      tools: [],
      tool_choice: 'none',
      parallel_tool_calls: false,
      truncation: 'disabled',
      reasoning: { effort: 'xhigh' },
    });
    expect(request.body).not.toContain('fixture-secret-key');
  });

  it('preserves inclusive usage subsets and leaves provider cost unknown', async () => {
    const value = await fixture();
    const result = await execute(await createAdapter(value), value.target.config as JsonValue);

    expect(result.usage).toEqual({
      inputTokens: 13,
      outputTokens: 7,
      totalTokens: 20,
      details: {
        provider: 'openai',
        responseModel: 'gpt-5.6-fixture-resolved',
        responseStatus: 'completed',
        tokenAccounting: 'inclusive-provider-totals',
        cachedInputTokens: 3,
        cacheWriteInputTokens: 4,
        reasoningOutputTokens: 2,
        serviceTier: 'default',
        effectiveEffort: 'xhigh',
      },
    });
    expect(result.usage).not.toHaveProperty('providerCost');
  });

  it('keeps absent usage and token details unknown', async () => {
    const absent = await fixture({ response: async () => successResponse({ usage: null }) });
    const absentResult = await execute(
      await createAdapter(absent),
      absent.target.config as JsonValue,
    );
    expect(absentResult.usage).toEqual({
      details: {
        provider: 'openai',
        responseModel: 'gpt-5.6-fixture-resolved',
        responseStatus: 'completed',
        tokenAccounting: 'inclusive-provider-totals',
        serviceTier: 'default',
        effectiveEffort: 'xhigh',
      },
    });
    expect(absentResult.usage).not.toHaveProperty('inputTokens');

    const noDetails = await fixture({
      response: async () => successResponse({
        usage: { input_tokens: 13, output_tokens: 7, total_tokens: 20 },
      }),
    });
    const noDetailsResult = await execute(
      await createAdapter(noDetails),
      noDetails.target.config as JsonValue,
    );
    expect(noDetailsResult.usage).toMatchObject({ inputTokens: 13, outputTokens: 7 });
    expect(noDetailsResult.usage?.details).not.toHaveProperty('cachedInputTokens');
    expect(noDetailsResult.usage?.details).not.toHaveProperty('reasoningOutputTokens');
  });

  it('preserves usage on incomplete and failed responses without leaking provider details', async () => {
    const incomplete = await fixture({
      response: async () => successResponse({
        status: 'incomplete',
        output: [],
        statePatch: { incomplete_details: { reason: 'sensitive reason' } },
      }),
    });
    await expect(execute(
      await createAdapter(incomplete),
      incomplete.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_OPENAI_API_RESPONSE_INCOMPLETE',
        message: 'OpenAI API response was incomplete.',
      },
      usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 },
    });

    const failed = await fixture({
      response: async () => successResponse({
        status: 'failed',
        output: [],
        error: { message: 'sensitive provider failure' },
      }),
    });
    await expect(execute(
      await createAdapter(failed),
      failed.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_OPENAI_API_RESPONSE_FAILED',
        message: 'OpenAI API response failed.',
      },
      usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 },
    });
  });

  it('rejects tools, refusals, hidden state, and inconsistent usage', async () => {
    const tool = await fixture({
      response: async () => successResponse({
        output: [{ id: 'call_fixture', type: 'function_call', name: 'hidden', arguments: '{}' }],
      }),
    });
    await expect(execute(
      await createAdapter(tool),
      tool.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_OPENAI_API_PROTOCOL_INVALID' },
      usage: { inputTokens: 13 },
    });

    const refusal = await fixture({
      response: async () => successResponse({
        output: [{
          id: 'msg_fixture',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'sensitive refusal' }],
        }],
      }),
    });
    await expect(execute(
      await createAdapter(refusal),
      refusal.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_OPENAI_API_PROTOCOL_INVALID' },
    });

    const stateful = await fixture({
      response: async () => successResponse({ statePatch: { store: true } }),
    });
    await expect(execute(
      await createAdapter(stateful),
      stateful.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_OPENAI_API_PROTOCOL_INVALID' },
    });

    const inconsistent = await fixture({
      response: async () => successResponse({
        usage: { input_tokens: 13, output_tokens: 7, total_tokens: 19 },
      }),
    });
    await expect(execute(
      await createAdapter(inconsistent),
      inconsistent.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_OPENAI_API_PROTOCOL_INVALID' },
    });

    const changedEffort = await fixture({
      response: async () => successResponse({ statePatch: { reasoning: { effort: 'high' } } }),
    });
    await expect(execute(
      await createAdapter(changedEffort),
      changedEffort.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_OPENAI_API_PROTOCOL_INVALID' },
      usage: { details: { effectiveEffort: 'high' } },
    });
  });

  it('redacts HTTP error bodies and fails oversized success responses closed', async () => {
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
        code: 'OMK_OPENAI_API_REQUEST_REJECTED',
        message: 'OpenAI API rejected the request.',
      },
    });

    const overloaded = await fixture({
      response: async () => new Response('sensitive overload', { status: 500 }),
    });
    await expect(execute(
      await createAdapter(overloaded),
      overloaded.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'transport-error', stage: 'infrastructure' },
    });

    const oversized = await fixture();
    await expect(execute(
      await createAdapter(oversized, { maxResponseBytes: 32 }),
      oversized.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_OPENAI_API_OUTPUT_LIMIT_EXCEEDED' },
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
      evaluationError: { code: 'OMK_OPENAI_API_CANCELLED' },
    });
    expect(settled).toBe(true);
  });

  it('captures the default fetch implementation and disables redirects', async () => {
    const value = await fixture();
    const capturedFetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => successResponse());
    const replacementFetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => successResponse());
    vi.stubGlobal('fetch', capturedFetch);
    const port = await createAdapter(value, { transport: undefined });
    vi.stubGlobal('fetch', replacementFetch);

    await execute(port, value.target.config as JsonValue);

    expect(capturedFetch).toHaveBeenCalledOnce();
    expect(replacementFetch).not.toHaveBeenCalled();
    expect(capturedFetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(capturedFetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects ambient credentials, insecure endpoints, and unsupported controls before calls', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ambient-secret');
    const value = await fixture();
    await expect(createAdapter(value, {
      apiKey: undefined as unknown as string,
    })).rejects.toThrow(/apiKey/);
    await expect(createAdapter(value, {
      endpoint: 'http://provider.example.test/v1/responses',
    })).rejects.toThrow(/must use HTTPS/);
    await expect(createAdapter(value, {
      endpoint: 'https://api.example.test/v1/responses?api_key=secret',
    })).rejects.toThrow(/credential-free/);
    await expect(createAdapter(value, {
      organization: 'org-fixture\nAuthorization: injected',
    })).rejects.toThrow(/header-safe/);

    const temperature = await fixture({ behaviorConfig: { temperature: 0 } });
    await expect(createAdapter(temperature)).rejects.toThrow();
    const tools = await fixture({
      requirementPatch: { toolPolicy: 'allow-list' },
    });
    await expect(createAdapter(tools)).rejects.toThrow(/supports no workspace, MCP, mocks/);
    expect(value.observations.requests).toHaveLength(0);
    expect(temperature.observations.requests).toHaveLength(0);
    expect(tools.observations.requests).toHaveLength(0);
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
    for (const validator of createOpenAIApiCoreSchemaValidators()) {
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
    }, { runId: 'run-a', bundleId: 'bundle-openai-api' });

    expect(bundle.executionBundleStatus).toBe('completed');
    expect(bundle.records[0]).toMatchObject({
      executionStatus: 'completed',
      output: { value: 'fixture answer', classification: 'secret' },
    });
  });
});
