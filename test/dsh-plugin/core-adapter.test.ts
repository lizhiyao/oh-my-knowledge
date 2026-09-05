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
} from '../../src/eval-core/contracts/index.js';
import { prepareEvaluationPlan } from '../../src/eval-core/compiler/index.js';
import {
  InMemoryRuntimeEventSequencer,
  executeRunPlan,
  type ExecutionExecutor,
  type ExecutorAttemptResult,
  type ExecutorTrialContext,
} from '../../src/eval-core/execution/index.js';
import {
  createDshHostCoreExecutorAdapter,
  createDshHostCoreSchemaValidators,
} from '../../src/dsh-plugin/index.js';
import type {
  DshAgentLike,
  DshHostContextLike,
  DshSessionLike,
} from '../../src/dsh-plugin/host-executor.js';
import type {
  OmkBindingResourceLease,
  OmkBindingResourceLeaseAccess,
  OmkLeasedHostResource,
  RuntimeBindingOf,
} from '../../src/eval-workflows/runtime-adapter/index.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from '../eval-core/compiler/fixtures.js';

type UnknownRecord = Record<string, unknown>;

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function digest(value: JsonValue): Sha256Digest {
  return digestCanonicalJson(value);
}

interface HostBehavior {
  readonly createWaitsForAbort?: boolean;
  readonly hang?: boolean;
  readonly disposeFails?: boolean;
  readonly idleFails?: boolean;
  readonly mutateAssistantEvent?: boolean;
  readonly oversizedEvent?: boolean;
  readonly requiredUnknownEvent?: boolean;
  readonly schemaReadFailsAfter?: number;
  readonly sessionIdMismatch?: boolean;
  readonly setupPreset?: string;
  readonly subscriptionFailsOn?: 'created' | 'event';
  readonly toolGuardUnavailable?: boolean;
}

class FakeCoreDshHost implements DshHostContextLike {
  currentPreset = 'standard-sensitive';
  currentSchemas: UnknownRecord[] = [
    { name: 'read', description: 'read files', parameters: { type: 'object' } },
    { name: 'write', description: 'write files', parameters: { type: 'object' } },
    { name: 'skill', description: 'ambient skills', parameters: { type: 'object' } },
  ];
  readonly created: Array<{
    sessionId: string;
    cwd: string;
    parentSession?: string;
    agentPreset?: string;
    provider?: string;
    model: string;
  }> = [];
  readonly creationSignals: Array<AbortSignal | undefined> = [];
  readonly promptSections: UnknownRecord[] = [];
  readonly prompts: UnknownRecord[] = [];
  readonly allowedToolSets: string[][] = [];
  readonly deniedTools: string[][] = [];
  readonly toolGuards: Array<(execution: Readonly<{ name: string }>) => string | undefined> = [];
  cancelled = 0;
  disposed = 0;
  schemaReads = 0;
  private readonly eventListeners = new Set<(
    session: DshSessionLike,
    event: UnknownRecord,
  ) => void>();
  private readonly createdListeners = new Set<(session: DshSessionLike) => void>();

  constructor(private readonly behavior: HostBehavior = {}) {}

  readonly agentPresets = {
    composedPreset: () => this.currentPreset,
    composeFrom: () => this.behavior.setupPreset ?? this.currentPreset,
  };

  readonly tools = {
    schemas: () => {
      this.schemaReads += 1;
      if (
        this.behavior.schemaReadFailsAfter !== undefined
        && this.schemaReads > this.behavior.schemaReadFailsAfter
      ) throw new Error('sensitive schema read failure');
      return structuredClone(this.currentSchemas);
    },
  };

  readonly agents = {
    create: async (options: Parameters<DshHostContextLike['agents']['create']>[0]) => {
      this.creationSignals.push(options.signal);
      if (this.behavior.createWaitsForAbort) {
        await new Promise<never>((_resolve, reject) => {
          if (options.signal?.aborted) {
            reject(new Error('sensitive creation cancellation'));
            return;
          }
          options.signal?.addEventListener('abort', () => {
            reject(new Error('sensitive creation cancellation'));
          }, { once: true });
        });
      }
      const events: UnknownRecord[] = [];
      const actualSessionId = this.behavior.sessionIdMismatch
        ? `${options.sessionId}-changed`
        : options.sessionId;
      const session: DshSessionLike = {
        id: actualSessionId,
        events,
        header: {
          cwd: options.meta.cwd,
          ...(options.meta.parentSession === undefined
            ? {}
            : { parentSession: options.meta.parentSession }),
          ...(options.meta.agentPreset === undefined
            ? {}
            : { agentPreset: options.meta.agentPreset }),
        },
      };
      let sequence = 0;
      let settle: (() => void) | undefined;
      let idle = Promise.resolve();
      type SetupContext = Parameters<typeof options.setup>[0];
      const scope = { agent: undefined as DshAgentLike | undefined };
      const agentContext: SetupContext = {
        get agent() { return scope.agent; },
        systemPrompt: {
          section: (section) => {
            this.promptSections.push(section);
            return () => undefined;
          },
          suppressRuntimeContext: () => () => undefined,
        },
        tools: {
          get: () => ({}),
          restrict: ({ allow, deny }) => {
            if (allow !== undefined) this.allowedToolSets.push([...allow]);
            if (deny !== undefined) this.deniedTools.push([...deny]);
            return () => undefined;
          },
          ...(this.behavior.toolGuardUnavailable ? {} : {
            guard: (guard: (execution: Readonly<{ name: string }>) => string | undefined) => {
              this.toolGuards.push(guard);
              return () => undefined;
            },
          }),
        },
      };
      const emit = (type: string, data: UnknownRecord, ignorable?: true): UnknownRecord => {
        const event = {
          type,
          seq: sequence,
          time: 1_800_000_000_000 + sequence,
          data,
          ...(ignorable === undefined ? {} : { ignorable }),
        };
        sequence += 1;
        events.push(event);
        for (const listener of this.eventListeners) listener(session, event);
        return event;
      };
      const agent: DshAgentLike = {
        id: actualSessionId,
        options: options.agentOptions,
        ctx: agentContext,
        session,
        followup: (message) => {
          this.prompts.push(message);
          idle = this.behavior.idleFails
            ? Promise.reject(new Error('sensitive idle failure'))
            : new Promise<void>((resolve) => { settle = resolve; });
          emit('user/message', message);
          if (this.behavior.oversizedEvent) {
            emit('plugin/telemetry-note', { blob: 'x'.repeat(8_192) }, true);
          }
          if (this.behavior.requiredUnknownEvent) {
            emit('future/semantic-boundary', { secret: 'must not leak' });
          }
          if (this.behavior.hang) return;
          const assistantEvent = emit('assistant/message', {
            message: { content: [{ type: 'text', text: 'host core answer' }] },
            usage: {
              inputTokens: 9,
              outputTokens: 4,
              cacheReadTokens: 2,
              cacheWriteTokens: 1,
              reasoningTokens: 1,
            },
          });
          if (this.behavior.mutateAssistantEvent) {
            const data = assistantEvent.data as UnknownRecord;
            const assistantMessage = data.message as UnknownRecord;
            assistantMessage.content = [{ type: 'text', text: 'mutated after delivery' }];
            (data.usage as UnknownRecord).inputTokens = 999;
          }
          emit('turn/end', { reason: { kind: 'completed' } });
          settle?.();
        },
        whenIdle: () => idle,
        cancel: () => {
          this.cancelled += 1;
          emit('turn/end', { reason: { kind: 'aborted' } });
          settle?.();
        },
      };
      scope.agent = agent;
      options.setup(agentContext);
      this.created.push({
        sessionId: options.sessionId,
        cwd: options.meta.cwd,
        ...(options.meta.parentSession === undefined
          ? {}
          : { parentSession: options.meta.parentSession }),
        ...(options.meta.agentPreset === undefined
          ? {}
          : { agentPreset: options.meta.agentPreset }),
        ...(options.agentOptions.provider === undefined
          ? {}
          : { provider: options.agentOptions.provider }),
        model: options.agentOptions.model,
      });
      for (const listener of this.createdListeners) listener(session);
      return {
        agent,
        dispose: async () => {
          this.disposed += 1;
          if (this.behavior.disposeFails) throw new Error('sensitive dispose failure');
        },
      };
    },
  };

  on(
    event: 'session/event' | 'session/created',
    listener: ((session: DshSessionLike, entry: UnknownRecord) => void)
      | ((session: DshSessionLike) => void),
  ): () => void {
    if (event === 'session/event') {
      if (this.behavior.subscriptionFailsOn === 'event') {
        throw new Error('sensitive event subscription failure');
      }
      const typed = listener as (session: DshSessionLike, entry: UnknownRecord) => void;
      this.eventListeners.add(typed);
      return () => this.eventListeners.delete(typed);
    }
    if (this.behavior.subscriptionFailsOn === 'created') {
      throw new Error('sensitive created subscription failure');
    }
    const typed = listener as (session: DshSessionLike) => void;
    this.createdListeners.add(typed);
    return () => this.createdListeners.delete(typed);
  }

  activeListenerCount(): number {
    return this.eventListeners.size + this.createdListeners.size;
  }
}

const parentAgent = {
  id: 'interactive-session',
  options: { provider: 'configured-provider', model: 'configured-model' },
  ctx: { name: 'interactive-agent-context' },
  session: {
    id: 'interactive-session',
    events: [],
    header: { cwd: '/project', agentPreset: 'stale-preset' },
  },
  followup() {},
  whenIdle: () => Promise.resolve(),
  cancel() {},
} satisfies DshAgentLike;

interface Fixture {
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly resourceAccess: OmkBindingResourceLeaseAccess;
}

async function fixture(options: Readonly<{
  allowedTools?: string[];
  allowedSkills?: string[];
  behaviorPatch?: Record<string, JsonValue>;
  runtimePatch?: Record<string, JsonValue>;
  requirementPatch?: Record<string, JsonValue>;
}> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'omk-dsh-core-test-'));
  roots.add(root);
  const artifact = '# Knowledge\nUse the DSH Core fixture rule.';
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
    ...(options.allowedSkills === undefined ? { allowedSkills: [] } : {
      allowedSkills: options.allowedSkills,
    }),
    ...(options.behaviorPatch ?? {}),
  };
  const config = {
    behavior,
    runtime: { model: 'dsh-model', ...(options.runtimePatch ?? {}) },
  };
  const executionRequirements = {
    systemInstructions: 'required' as const,
    workspace: 'not-required' as const,
    mcp: 'not-required' as const,
    mockInterception: 'not-required' as const,
    toolPolicy: options.allowedTools === undefined ? 'runtime-default' as const : 'allow-list' as const,
    skillDiscovery: options.allowedSkills === undefined || options.allowedSkills.length === 0
      ? 'disabled' as const
      : 'allow-list' as const,
    ...(options.requirementPatch ?? {}),
  };
  const target = {
    targetId: 'target-a',
    targetKind: 'skill',
    protocolId: 'omk.invoke/v1',
    executorId: 'test.omk.dsh-host/v1',
    executionRequirements,
    executionControls: {
      defaults: {
        workspace: { workspaceMode: 'not-required' as const },
        tools: options.allowedTools === undefined
          ? { toolPolicyKind: 'runtime-default' as const }
          : { toolPolicyKind: 'allow-list' as const, allowedTools: [...options.allowedTools] },
        mcp: { mcpMode: 'not-required' as const },
        mockInterception: { mockInterceptionMode: 'not-required' as const },
      },
      sampleOverrides: [],
    },
    config,
  } as EvaluationDefinition['targets'][number];
  const binding: RuntimeBindingOf<'executor'> = {
    runtimeKind: 'executor',
    bindingId: 'executor-target-a',
    targetId: 'target-a',
    implementationId: 'test.omk.dsh-host/v1',
    protocolId: 'omk.invoke/v1',
    behaviorConfigDigest: digest(config),
    executionControlsDigest: digest(target.executionControls),
    resourceLeaseRequirements: [{
      resourceId: 'artifact-a',
      resourceRole: 'artifact',
      leaseMode: 'immutable-snapshot',
    }],
    qualification: {
      model: 'dsh-model',
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
  return {
    target,
    binding,
    resourceAccess: {
      forRun(runId) {
        expect(runId).toMatch(/^run-/u);
        return lease;
      },
    },
  };
}

async function createAdapter(
  value: Fixture,
  host: FakeCoreDshHost,
  patch: Readonly<{ maxEventBytes?: number }> = {},
): Promise<ExecutionExecutor> {
  return createDshHostCoreExecutorAdapter({
    target: value.target,
    binding: value.binding,
    host,
    dsh: { parentAgent, ...patch },
    sessionIsolationKey: 'dsh-host-session-a',
    resourceLeases: value.resourceAccess,
  });
}

async function execute(
  port: ExecutionExecutor,
  targetConfig: JsonValue,
  signal: AbortSignal = new AbortController().signal,
  runId = 'run-a',
  executionControl: ExecutorTrialContext['executionControl'] = {
    workspace: { workspaceMode: 'not-required' },
    tools: { toolPolicyKind: 'runtime-default' },
    mcp: { mcpMode: 'not-required' },
    mockInterception: { mockInterceptionMode: 'not-required' },
  },
): Promise<ExecutorAttemptResult> {
  const run = await port.openRun({ runId, executionPlanDigest: digest({ plan: 'a' }) });
  const trial = await run.openTrial({
    signal: new AbortController().signal,
    sampleId: 'sample-a',
    targetId: 'target-a',
    executionCoordinateDigest: digest({ coordinate: 'a' }),
    executionControl,
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

describe('DSH host-only Core Executor adapter', () => {
  it('seals partial host identity without exposing preset or tool schema values', async () => {
    const value = await fixture();
    const firstHost = new FakeCoreDshHost();
    const first = await createAdapter(value, firstHost);
    const changedHost = new FakeCoreDshHost();
    changedHost.currentPreset = 'other-sensitive-preset';
    const changed = await createAdapter(value, changedHost);

    expect(first.identity.fingerprint).not.toBe(changed.identity.fingerprint);
    expect(first.identity).toMatchObject({
      implementationId: 'test.omk.dsh-host/v1',
      fingerprintBasis: 'environment-derived',
      assuranceLevel: 'declared',
      capabilities: {
        protocols: [{
          protocolId: 'omk.invoke/v1',
          execution: {
            concurrency: { safety: 'serialized', maxInFlight: 1 },
            cancellation: 'best-effort',
          },
        }],
      },
      implementationManifest: { coverageKind: 'fingerprint-plus-facets' },
    });
    expect(JSON.stringify(first.identity)).not.toContain('standard-sensitive');
    expect(JSON.stringify(first.identity)).not.toContain('read files');
  });

  it('requires a sealed provider route when no parent agent supplies one', async () => {
    const value = await fixture();
    const host = new FakeCoreDshHost();
    const base = {
      target: value.target,
      binding: value.binding,
      host,
      sessionIsolationKey: 'dsh-host-session-a',
      resourceLeases: value.resourceAccess,
    };
    await expect(createDshHostCoreExecutorAdapter({ ...base, dsh: {} })).rejects.toThrow(
      'requires an explicit or parent-inherited provider route',
    );

    const explicit = await createDshHostCoreExecutorAdapter({
      ...base,
      dsh: { provider: 'explicit-route' },
    });
    expect(JSON.stringify(explicit.identity)).toContain('explicit-route');
  });

  it('projects a controlled session with exclusive usage normalized to Core totals', async () => {
    const value = await fixture();
    const host = new FakeCoreDshHost();
    const result = await execute(await createAdapter(value, host), value.target.config as JsonValue);

    expect(result.output).toEqual({
      value: 'host core answer',
      classification: 'secret',
      mediaType: 'text/plain',
    });
    expect(result.trace?.value).toMatchObject({
      schemaVersion: 'omk.source-neutral-trace/v2',
      numTurns: 1,
      fullNumTurns: 1,
      numSubAgents: 0,
      toolCalls: [],
    });
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      details: {
        provider: 'dsh-host',
        model: 'dsh-model',
        providerRoute: 'configured-provider',
        stopReason: 'completed',
        tokenAccounting: 'exclusive-cache-input-buckets',
        uncachedInputTokens: 9,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        reasoningOutputTokens: 1,
      },
    });
    expect(result.usage).not.toHaveProperty('providerCost');
    expect(host.created[0]).toMatchObject({
      parentSession: 'interactive-session',
      agentPreset: 'standard-sensitive',
      provider: 'configured-provider',
      model: 'dsh-model',
    });
    expect(host.promptSections).toEqual([{
      name: 'omk:evaluation-core',
      order: 0,
      text: '# Knowledge\nUse the DSH Core fixture rule.',
      complete: true,
    }]);
    expect(host.prompts[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('omk.dsh-host-prompt/v1') }],
    });
    expect(host.deniedTools).toEqual([['skill']]);
    expect(host.toolGuards[0]?.({ name: 'skill' })).toContain('disabled skill discovery');
    expect(host.disposed).toBe(1);
  });

  it('captures immutable event snapshots instead of retaining host-owned objects', async () => {
    const value = await fixture();
    const host = new FakeCoreDshHost({ mutateAssistantEvent: true });
    const result = await execute(await createAdapter(value, host), value.target.config as JsonValue);

    expect(result.output).toMatchObject({ value: 'host core answer' });
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 4, totalTokens: 16 });
  });

  it('bounds event capture, cancels the host, and disposes the attempt', async () => {
    const value = await fixture();
    const host = new FakeCoreDshHost({ oversizedEvent: true });

    await expect(execute(
      await createAdapter(value, host, { maxEventBytes: 2_048 }),
      value.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_DSH_HOST_OUTPUT_LIMIT_EXCEEDED' },
    });
    expect(host.cancelled).toBe(1);
    expect(host.disposed).toBe(1);
  });

  it('enforces a host tool allow-list before dispatch', async () => {
    const value = await fixture({ allowedTools: ['read'] });
    const host = new FakeCoreDshHost();
    await execute(
      await createAdapter(value, host),
      value.target.config as JsonValue,
      undefined,
      'run-a',
      value.target.executionControls.defaults,
    );

    expect(host.allowedToolSets).toEqual([['read']]);
    expect(host.toolGuards[0]?.({ name: 'read' })).toBeUndefined();
    expect(host.toolGuards[0]?.({ name: 'write' })).toContain('allow-list denied');
  });

  it('derives distinct host session identities for the same trial across runs', async () => {
    const value = await fixture();
    const host = new FakeCoreDshHost();
    const port = await createAdapter(value, host);

    await execute(port, value.target.config as JsonValue, undefined, 'run-a');
    await execute(port, value.target.config as JsonValue, undefined, 'run-b');

    expect(host.created).toHaveLength(2);
    expect(host.created[0]?.sessionId).not.toBe(host.created[1]?.sessionId);
  });

  it('forwards cancellation and waits for host idle before disposal', async () => {
    const value = await fixture();
    const host = new FakeCoreDshHost({ hang: true });
    const controller = new AbortController();
    const promise = execute(
      await createAdapter(value, host),
      value.target.config as JsonValue,
      controller.signal,
    );
    await expect.poll(() => host.prompts.length).toBe(1);
    controller.abort();

    await expect(promise).rejects.toMatchObject({
      evaluationError: { code: 'OMK_DSH_HOST_CANCELLED' },
    });
    expect(host.cancelled).toBe(1);
    expect(host.disposed).toBe(1);
  });

  it('forwards cancellation while the host is still creating the agent', async () => {
    const value = await fixture();
    const host = new FakeCoreDshHost({ createWaitsForAbort: true });
    const controller = new AbortController();
    const promise = execute(
      await createAdapter(value, host),
      value.target.config as JsonValue,
      controller.signal,
    );
    await expect.poll(() => host.creationSignals.length).toBe(1);
    expect(host.creationSignals[0]).toBe(controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({
      evaluationError: { code: 'OMK_DSH_HOST_CANCELLED' },
    });
    expect(host.created).toHaveLength(0);
    expect(host.disposed).toBe(0);
  });

  it('fails identity drift before creating a measurement session', async () => {
    const value = await fixture();
    const host = new FakeCoreDshHost();
    const port = await createAdapter(value, host);
    host.currentSchemas[0] = { ...host.currentSchemas[0], description: 'changed after assembly' };

    await expect(execute(port, value.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: { code: 'OMK_DSH_HOST_IDENTITY_CHANGED' },
    });
    expect(host.created).toHaveLength(0);
  });

  it('redacts host identity capture and revalidation failures', async () => {
    const value = await fixture();
    const assemblyHost = new FakeCoreDshHost({ schemaReadFailsAfter: 0 });
    await expect(createAdapter(value, assemblyHost)).rejects.toThrow(
      'DSH Host Core adapter could not capture effective tool schemas.',
    );

    const executionHost = new FakeCoreDshHost({ schemaReadFailsAfter: 1 });
    const port = await createAdapter(value, executionHost);
    await expect(execute(port, value.target.config as JsonValue)).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_DSH_HOST_IDENTITY_REVALIDATION_FAILED',
        message: 'DSH Host effective tool schemas could not be revalidated.',
      },
    });
    expect(executionHost.created).toHaveLength(0);
  });

  it('rolls back partial subscriptions and rejects unavailable tool guards', async () => {
    const value = await fixture();
    const subscriptionHost = new FakeCoreDshHost({ subscriptionFailsOn: 'event' });
    await expect(execute(
      await createAdapter(value, subscriptionHost),
      value.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_DSH_HOST_SUBSCRIPTION_FAILED' },
    });
    expect(subscriptionHost.activeListenerCount()).toBe(0);
    expect(subscriptionHost.created).toHaveLength(0);

    const policyHost = new FakeCoreDshHost({ toolGuardUnavailable: true });
    await expect(execute(
      await createAdapter(value, policyHost),
      value.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_DSH_HOST_TOOL_POLICY_UNAVAILABLE' },
    });
    expect(policyHost.created).toHaveLength(0);
  });

  it('classifies setup-time preset drift and session identity drift as infrastructure failures', async () => {
    const value = await fixture();
    const presetHost = new FakeCoreDshHost({ setupPreset: 'changed-during-setup' });
    await expect(execute(
      await createAdapter(value, presetHost),
      value.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_DSH_HOST_IDENTITY_CHANGED' },
    });

    const sessionHost = new FakeCoreDshHost({ sessionIdMismatch: true });
    await expect(execute(
      await createAdapter(value, sessionHost),
      value.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: { code: 'OMK_DSH_HOST_SESSION_ID_MISMATCH' },
    });
    expect(sessionHost.prompts).toHaveLength(0);
    expect(sessionHost.disposed).toBe(1);
  });

  it('redacts host idle failures, removes cancellation listeners, and disposes', async () => {
    const value = await fixture();
    const host = new FakeCoreDshHost({ idleFails: true });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(execute(
      await createAdapter(value, host),
      value.target.config as JsonValue,
      controller.signal,
    )).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_DSH_HOST_SESSION_FAILED',
        message: 'DSH Host session failed.',
      },
    });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(host.disposed).toBe(1);
  });

  it('redacts required protocol evolution and disposal failures', async () => {
    const value = await fixture();
    const unknown = new FakeCoreDshHost({ requiredUnknownEvent: true });
    await expect(execute(
      await createAdapter(value, unknown),
      value.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_DSH_HOST_PROTOCOL_INVALID',
        message: 'DSH Host returned an unsupported required session event.',
      },
    });
    expect(unknown.cancelled).toBe(1);
    expect(unknown.disposed).toBe(1);

    const disposal = new FakeCoreDshHost({ disposeFails: true });
    await expect(execute(
      await createAdapter(value, disposal),
      value.target.config as JsonValue,
    )).rejects.toMatchObject({
      evaluationError: {
        code: 'OMK_DSH_HOST_ATTEMPT_DISPOSE_FAILED',
        message: 'DSH Host measurement session could not be disposed.',
      },
      usage: { inputTokens: 12 },
    });
  });

  it('rejects unsupported or split-brain controls before host side effects', async () => {
    const effort = await fixture({ runtimePatch: { effort: 'high' } });
    const effortHost = new FakeCoreDshHost();
    await expect(createAdapter(effort, effortHost)).rejects.toThrow(/cannot map/);

    const mcp = await fixture({ behaviorPatch: {
      mcpConfig: {
        resourceId: 'mcp-a',
        digest: digest({ mcp: true }),
        mediaType: 'application/json',
        classification: 'public',
        size: 2,
      },
    } });
    const mcpHost = new FakeCoreDshHost();
    await expect(createAdapter(mcp, mcpHost)).rejects.toThrow(/does not inject MCP/);

    const mismatch = await fixture({ requirementPatch: { toolPolicy: 'allow-list' } });
    const mismatchHost = new FakeCoreDshHost();
    await expect(createAdapter(mismatch, mismatchHost)).rejects.toThrow(/inconsistent/);
    const conflictingTools = await fixture({ allowedTools: ['skill'] });
    await expect(createAdapter(conflictingTools, new FakeCoreDshHost())).rejects.toThrow(
      /disabled skills conflict/,
    );
    expect(effortHost.created).toHaveLength(0);
    expect(mcpHost.created).toHaveLength(0);
    expect(mismatchHost.created).toHaveLength(0);
  });

  it('passes real Core prepare and execution without entering a generic factory', async () => {
    const value = await fixture();
    const host = new FakeCoreDshHost();
    const port = await createAdapter(value, host);
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
    for (const validator of createDshHostCoreSchemaValidators()) {
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
    }, { runId: 'run-a', bundleId: 'bundle-dsh-host-core' });

    expect(bundle.executionBundleStatus).toBe('completed');
    expect(bundle.records[0]).toMatchObject({
      executionStatus: 'completed',
      output: { value: 'host core answer', classification: 'secret' },
    });
  });
});
