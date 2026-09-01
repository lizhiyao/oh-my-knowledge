import { randomUUID } from 'node:crypto';
import {
  JsonValueSchema,
  RuntimeIdentitySchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type EvaluationDefinition,
  type JsonValue,
  type RuntimeIdentity,
  type RuntimeImplementationFacet,
  type UsageRecord,
} from '../evaluation-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutionExecutor,
  type ExecutorAttemptContext,
  type ExecutorAttemptResult,
} from '../evaluation-core/execution/index.js';
import { createDshHostRuntimeFingerprint } from '../executors/core/runtime-fingerprint.js';
import {
  captureClaudeCliRunState,
  captureClaudeCliTarget,
  disposeClaudeCliTrial,
  openClaudeCliTrial,
  type CapturedClaudeCliTarget,
  type ClaudeCliRunState,
  type ClaudeCliTrialState,
  type ClaudeResourceProjectionProfile,
} from '../eval-workflows/runtime-adapter/adapters/claude/resources.js';
import { createSameProcessExecutorAdapter } from '../eval-workflows/runtime-adapter/adapters/shared/same-process.js';
import type { OmkBindingResourceLeaseAccess } from '../eval-workflows/runtime-adapter/resource-leases/types.js';
import type { RuntimeBindingOf } from '../eval-workflows/runtime-adapter/types.js';
import {
  DSH_HOST_CORE_ADAPTER_IMPLEMENTATION_VERSION,
  dshHostCoreExecutorCapabilities,
  parseDshHostCoreResult,
} from './core-protocol.js';
import type {
  DshAgentLike,
  DshHostContextLike,
  DshSessionLike,
} from './host-executor.js';
import type { DshHostRunResult } from './protocol.js';
import { supportsDshTraceEventType } from './trace-adapter.js';

export {
  DSH_HOST_CORE_ADAPTER_IMPLEMENTATION_VERSION,
  createDshHostCoreSchemaValidators,
} from './core-protocol.js';

export const DEFAULT_DSH_HOST_CORE_MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_DSH_HOST_CORE_MAX_EVENT_BYTES = 10 * 1024 * 1024;

const RESOURCE_PROFILE = Object.freeze({
  adapterLabel: 'DSH Host',
  errorPrefix: 'OMK_DSH_HOST',
  mcpMockMode: 'hook-existing-tool',
  promptSchemaVersion: 'omk.dsh-host-prompt/v1',
}) satisfies ClaudeResourceProjectionProfile;

export interface DshHostCoreConfiguration {
  /** Interactive host session whose effective provider and preset are inherited. */
  readonly parentAgent?: DshAgentLike;
  /** Explicit host provider route when no parent session supplies one. */
  readonly provider?: string;
  readonly maxInputBytes?: number;
  readonly maxEventBytes?: number;
}

export interface CreateDshHostCoreExecutorAdapterInput {
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly host: DshHostContextLike;
  readonly dsh?: DshHostCoreConfiguration;
  readonly sessionIsolationKey: string;
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
}

interface CapturedToolSchema {
  readonly name: string;
  readonly value: JsonValue;
}

interface CapturedHost {
  readonly createAgent: DshHostContextLike['agents']['create'];
  readonly subscribeCreated: (listener: (session: DshSessionLike) => void) => () => void;
  readonly subscribeEvent: (
    listener: (session: DshSessionLike, event: Record<string, unknown>) => void,
  ) => () => void;
  readonly readToolSchemas: () => readonly Record<string, unknown>[];
  readonly readActiveAgentPreset?: () => string | undefined;
  readonly composeFrom?: (agentContext: object) => string | undefined;
  readonly parentAgentId?: string;
  readonly provider: string;
  readonly activeAgentPreset?: string;
  readonly effectiveToolSchemas: readonly CapturedToolSchema[];
  readonly maxInputBytes: number;
  readonly maxEventBytes: number;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`DSH Host ${label} must be a positive safe integer.`);
  }
  return value;
}

function optionalNonEmptyString(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new TypeError(`DSH Host ${label} must be a non-empty string.`);
  }
  return value;
}

function fail(
  code: string,
  stage: 'infrastructure' | 'execution',
  message: string,
  usage?: UsageRecord,
): never {
  throw new ExecutionPortFailure({ code, stage, message }, usage);
}

function validateDshTargetSubset(
  target: EvaluationDefinition['targets'][number],
): void {
  const config = record(target.config);
  const behavior = record(config?.behavior);
  const runtime = record(config?.runtime);
  if (behavior === undefined || runtime === undefined) {
    throw new TypeError('DSH Host Target config is invalid.');
  }
  if (runtime.effort !== undefined) {
    throw new TypeError(
      'DSH Host Core adapter cannot map the generic reasoning effort to the host provider.',
    );
  }
  if (behavior.mcpConfig !== undefined || behavior.mocks !== undefined) {
    throw new TypeError('DSH Host Core adapter does not inject MCP config or mock interception.');
  }
  if (behavior.sandbox !== undefined) {
    throw new TypeError('DSH Host Core adapter does not provide a verifiable sandbox.');
  }
  if (behavior.config !== undefined) {
    throw new TypeError('DSH Host Core adapter does not accept opaque provider config.');
  }
  const requirements = target.executionRequirements;
  const workspaceControls = [
    target.executionControls.defaults.workspace,
    ...target.executionControls.sampleOverrides.flatMap((override) => (
      override.workspace === undefined ? [] : [override.workspace]
    )),
  ];
  const toolControls = [
    target.executionControls.defaults.tools,
    ...target.executionControls.sampleOverrides.flatMap((override) => (
      override.tools === undefined ? [] : [override.tools]
    )),
  ];
  const expectedWorkspace = workspaceControls.some((workspace) => (
    workspace.workspaceMode === 'copy-on-write-overlay'
  )) ? 'copy-on-write-overlay' : 'not-required';
  const expectedToolPolicy = toolControls.some((tools) => (
    tools.toolPolicyKind === 'allow-list'
  )) ? 'allow-list' : 'runtime-default';
  const expectedSkillDiscovery = behavior.allowedSkills === undefined
    ? 'runtime-default'
    : Array.isArray(behavior.allowedSkills) && behavior.allowedSkills.length === 0
      ? 'disabled'
      : 'allow-list';
  if (
    requirements.workspace !== expectedWorkspace
    || requirements.mcp !== 'not-required'
    || requirements.mockInterception !== 'not-required'
    || requirements.toolPolicy !== expectedToolPolicy
    || requirements.skillDiscovery !== expectedSkillDiscovery
    || requirements.sandboxId !== undefined
  ) {
    throw new TypeError('DSH Host behavior and execution requirements are inconsistent.');
  }
}

function toolSchemas(
  values: readonly Record<string, unknown>[],
): readonly CapturedToolSchema[] {
  const captured: CapturedToolSchema[] = [];
  const names = new Set<string>();
  for (const value of values) {
    if (typeof value.name !== 'string' || value.name.trim() === '' || names.has(value.name)) {
      throw new TypeError('DSH Host tool schemas must have unique non-empty names.');
    }
    let schema: JsonValue;
    try {
      schema = JsonValueSchema.parse(structuredClone(value));
    } catch {
      throw new TypeError('DSH Host tool schemas must be canonical JSON values.');
    }
    names.add(value.name);
    captured.push(Object.freeze({ name: value.name, value: schema }));
  }
  return Object.freeze(captured);
}

function effectiveToolSchemas(
  schemas: readonly CapturedToolSchema[],
  target: CapturedClaudeCliTarget,
): readonly CapturedToolSchema[] {
  const disableSkills = target.config.behavior.allowedSkills !== undefined;
  const available = new Set(schemas.map(({ name }) => name));
  const toolControls = [
    target.target.executionControls.defaults.tools,
    ...target.target.executionControls.sampleOverrides.flatMap((override) => (
      override.tools === undefined ? [] : [override.tools]
    )),
  ];
  for (const tools of toolControls) {
    if (tools.toolPolicyKind !== 'allow-list') continue;
    if (disableSkills && tools.allowedTools.includes('skill')) {
      throw new TypeError('DSH Host disabled skills conflict with the skill tool allow-list.');
    }
    if (tools.allowedTools.some((name) => !available.has(name))) {
      throw new TypeError('DSH Host tool allow-list references an unavailable host tool.');
    }
    if (!disableSkills && !tools.allowedTools.includes('skill')) {
      throw new TypeError(
        'DSH Host runtime-default skill discovery requires the skill tool in a tool allow-list.',
      );
    }
  }
  return Object.freeze([...schemas]);
}

function captureHost(
  input: Readonly<CreateDshHostCoreExecutorAdapterInput>,
  target: CapturedClaudeCliTarget,
): CapturedHost {
  if (typeof input.host?.agents?.create !== 'function'
      || typeof input.host.on !== 'function'
      || typeof input.host.agentPresets?.composedPreset !== 'function'
      || typeof input.host.agentPresets?.composeFrom !== 'function'
      || typeof input.host.tools?.schemas !== 'function') {
    throw new TypeError('DSH Host Core adapter requires agents, events, presets, and tool schemas.');
  }
  const configuration = input.dsh ?? {};
  const parentAgent = configuration.parentAgent;
  const provider = optionalNonEmptyString(
    configuration.provider ?? parentAgent?.options.provider,
    'provider',
  );
  if (provider === undefined) {
    throw new TypeError(
      'DSH Host Core adapter requires an explicit or parent-inherited provider route.',
    );
  }
  let activeAgentPreset: string | undefined;
  try {
    activeAgentPreset = parentAgent === undefined
      ? undefined
      : optionalNonEmptyString(
          input.host.agentPresets.composedPreset(parentAgent.ctx),
          'agent preset',
        );
  } catch {
    throw new TypeError('DSH Host Core adapter could not capture the effective agent preset.');
  }
  const createAgent = input.host.agents.create.bind(input.host.agents);
  const subscribe = input.host.on.bind(input.host) as DshHostContextLike['on'];
  const readSchemas = input.host.tools.schemas.bind(input.host.tools, parentAgent);
  const composeFrom = input.host.agentPresets.composeFrom;
  const composedPreset = input.host.agentPresets.composedPreset;
  let capturedSchemas: readonly CapturedToolSchema[];
  try {
    capturedSchemas = toolSchemas(readSchemas());
  } catch {
    throw new TypeError('DSH Host Core adapter could not capture effective tool schemas.');
  }
  return Object.freeze({
    createAgent,
    subscribeCreated(listener: (session: DshSessionLike) => void) {
      return subscribe('session/created', listener);
    },
    subscribeEvent(
      listener: (session: DshSessionLike, event: Record<string, unknown>) => void,
    ) {
      return subscribe('session/event', listener);
    },
    readToolSchemas: readSchemas,
    ...(parentAgent === undefined ? {} : {
      readActiveAgentPreset() {
        return Reflect.apply(
          composedPreset,
          input.host.agentPresets,
          [parentAgent.ctx],
        ) as string | undefined;
      },
    }),
    ...(parentAgent === undefined ? {} : {
      composeFrom(agentContext: object) {
        return Reflect.apply(
          composeFrom,
          input.host.agentPresets,
          [agentContext, parentAgent.ctx],
        ) as string | undefined;
      },
    }),
    ...(parentAgent === undefined ? {} : { parentAgentId: String(parentAgent.id) }),
    provider,
    ...(activeAgentPreset === undefined ? {} : { activeAgentPreset }),
    effectiveToolSchemas: effectiveToolSchemas(capturedSchemas, target),
    maxInputBytes: positiveSafeInteger(
      configuration.maxInputBytes ?? DEFAULT_DSH_HOST_CORE_MAX_INPUT_BYTES,
      'maxInputBytes',
    ),
    maxEventBytes: positiveSafeInteger(
      configuration.maxEventBytes ?? DEFAULT_DSH_HOST_CORE_MAX_EVENT_BYTES,
      'maxEventBytes',
    ),
  });
}

function hostRuntimeEvidence(
  target: CapturedClaudeCliTarget,
  host: CapturedHost,
) {
  return createDshHostRuntimeFingerprint(target.binding.qualification.model, {
    provider: host.provider,
    ...(host.activeAgentPreset === undefined ? {} : { agentPreset: host.activeAgentPreset }),
    toolSchemas: host.effectiveToolSchemas.map(({ value }) => value),
  });
}

function resolveIdentity(
  target: CapturedClaudeCliTarget,
  host: CapturedHost,
): RuntimeIdentity {
  const capabilities = dshHostCoreExecutorCapabilities();
  const evidence = hostRuntimeEvidence(target, host);
  const facets: RuntimeImplementationFacet[] = [{
    facetId: 'adapter.composition',
    value: {
      adapterVersion: DSH_HOST_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      cancellation: 'host-cancel-then-await-idle',
      processIsolation: 'host-agent-per-attempt',
      sourceProtocol: 'DeepSeek Harness host session events',
    },
  }, {
    facetId: 'adapter.input-projection',
    value: {
      artifact: 'complete-system-prompt-section-plus-supporting-files',
      directoryEntrypoint: 'SKILL.md',
      promptTransport: 'agent-followup',
      runtimeContext: 'suppressed',
      version: RESOURCE_PROFILE.promptSchemaVersion,
    },
  }, {
    facetId: 'adapter.limits',
    value: {
      maxEventBytes: host.maxEventBytes,
      maxInputBytes: host.maxInputBytes,
    },
  }, {
    facetId: 'dsh.host-coverage',
    value: {
      auditability: 'partial',
      dshPackageVersion: evidence.binary?.version ?? null,
      hostCompositionDigest: evidence.binary?.contentHash ?? null,
      omkPackageVersion: evidence.sdk?.version ?? null,
      provider: host.provider,
      presetDigest: host.activeAgentPreset === undefined
        ? null
        : digestCanonicalJson(host.activeAgentPreset),
      revalidation: 'effective-preset-and-tool-schemas-before-each-agent',
      toolSchemaDigest: digestCanonicalJson(
        host.effectiveToolSchemas.map(({ value }) => value),
      ),
      toolSchemaCount: host.effectiveToolSchemas.length,
    },
  }, {
    facetId: 'dsh.tool-policy',
    value: {
      skillDiscovery: target.config.behavior.allowedSkills === undefined
        ? 'runtime-default'
        : 'disabled',
      toolPolicy: 'sample-scoped-sealed-control',
    },
  }, {
    facetId: 'runtime.binding',
    value: {
      behaviorConfigDigest: target.binding.behaviorConfigDigest,
      deploymentCoverage: 'remote-provider-and-host-plugins-partial',
      effort: null,
      model: target.binding.qualification.model,
      protocolId: target.binding.protocolId,
      providerTransportRetries: 'runtime-opaque',
      sandbox: 'none',
      workspace: 'sample-scoped-sealed-control',
    },
  }];
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    implementationId: target.binding.implementationId,
    ...(evidence.binary?.version === undefined ? {} : { version: evidence.binary.version }),
    fingerprint: digestCanonicalJson({
      derivation: 'omk.dsh-host-core-runtime-fingerprint/v1',
      adapterVersion: DSH_HOST_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      capabilities,
      bindingDigest: digestCanonicalJson(target.binding),
      hostEvidence: {
        legacyFingerprint: evidence.fingerprint,
        compositionHash: evidence.binary?.contentHash ?? null,
        dshVersion: evidence.binary?.version ?? null,
        omkVersion: evidence.sdk?.version ?? null,
      },
      limits: { maxEventBytes: host.maxEventBytes, maxInputBytes: host.maxInputBytes },
      provider: host.provider,
      presetDigest: host.activeAgentPreset === undefined
        ? null
        : digestCanonicalJson(host.activeAgentPreset),
      toolSchemas: host.effectiveToolSchemas.map(({ value }) => value),
    }),
    fingerprintBasis: 'environment-derived',
    assuranceLevel: 'declared',
    capabilities,
    implementationManifest: { coverageKind: 'fingerprint-plus-facets', facets },
  }));
}

function currentToolPolicy(host: CapturedHost, target: CapturedClaudeCliTarget): {
  readonly effective: readonly CapturedToolSchema[];
  readonly denied: readonly string[];
} {
  let rawSchemas: readonly Record<string, unknown>[];
  try {
    rawSchemas = host.readToolSchemas();
  } catch {
    fail(
      'OMK_DSH_HOST_IDENTITY_REVALIDATION_FAILED',
      'infrastructure',
      'DSH Host effective tool schemas could not be revalidated.',
    );
  }
  let all: readonly CapturedToolSchema[];
  let effective: readonly CapturedToolSchema[];
  try {
    all = toolSchemas(rawSchemas);
    effective = effectiveToolSchemas(all, target);
  } catch {
    fail(
      'OMK_DSH_HOST_IDENTITY_CHANGED',
      'infrastructure',
      'DSH Host effective tool schemas changed after adapter assembly.',
    );
  }
  const effectiveNames = new Set(effective.map(({ name }) => name));
  return {
    effective,
    denied: Object.freeze(all.map(({ name }) => name).filter((name) => !effectiveNames.has(name))),
  };
}

function assertHostCompositionUnchanged(
  host: CapturedHost,
  target: CapturedClaudeCliTarget,
  signal: AbortSignal,
): readonly string[] {
  if (signal.aborted) {
    fail('OMK_DSH_HOST_CANCELLED', 'execution', 'DSH Host execution was cancelled.');
  }
  const policy = currentToolPolicy(host, target);
  if (canonicalizeJson(policy.effective.map(({ value }) => value))
      !== canonicalizeJson(host.effectiveToolSchemas.map(({ value }) => value))) {
    fail(
      'OMK_DSH_HOST_IDENTITY_CHANGED',
      'infrastructure',
      'DSH Host effective tool schemas changed after adapter assembly.',
    );
  }
  if (host.readActiveAgentPreset !== undefined) {
    let activePreset: string | undefined;
    try {
      activePreset = host.readActiveAgentPreset();
    } catch {
      fail(
        'OMK_DSH_HOST_IDENTITY_REVALIDATION_FAILED',
        'infrastructure',
        'DSH Host effective agent preset could not be revalidated.',
      );
    }
    if (activePreset !== host.activeAgentPreset) {
      fail(
        'OMK_DSH_HOST_IDENTITY_CHANGED',
        'infrastructure',
        'DSH Host effective agent preset changed after adapter assembly.',
      );
    }
  }
  return policy.denied;
}

function createPromptMessage(prompt: string): Record<string, unknown> {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [Object.freeze({ type: 'text', text: prompt })],
    // `source.kind` mirrors the host-owned DSH message protocol.
    source: Object.freeze({ kind: 'user' }),
  });
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap((block) => {
    const item = record(block);
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  }).join('');
}

function lastRootAssistantText(result: DshHostRunResult): string {
  for (let index = result.events.length - 1; index >= 0; index -= 1) {
    const item = result.events[index];
    if (item?.sessionId !== result.rootSessionId || item.event.type !== 'assistant/message') {
      continue;
    }
    const data = record(item.event.data);
    const message = record(data?.message);
    const text = textFromContent(message?.content);
    if (text !== '') return text;
  }
  return '';
}

async function waitForIdleOrCancellation(
  agent: DshAgentLike,
  signal: AbortSignal,
): Promise<'idle' | 'cancelled'> {
  let removeAbortListener: (() => void) | undefined;
  const idle = agent.whenIdle();
  if (signal.aborted) {
    try { agent.cancel({ kind: 'hook', reason: 'OMK Core attempt was cancelled' }); } catch { /* settle below */ }
    await idle;
    return 'cancelled';
  }
  let outcome: 'idle' | 'cancelled';
  try {
    outcome = await Promise.race([
      idle.then(() => 'idle' as const),
      new Promise<'cancelled'>((resolve) => {
        const onAbort = (): void => resolve('cancelled');
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    removeAbortListener?.();
  }
  if (outcome === 'idle') return outcome;
  try { agent.cancel({ kind: 'hook', reason: 'OMK Core attempt was cancelled' }); } catch { /* settle below */ }
  await idle;
  return outcome;
}

function executionFailure(error: unknown, signal: AbortSignal): ExecutionPortFailure {
  if (error instanceof ExecutionPortFailure) return error;
  if (signal.aborted) {
    return new ExecutionPortFailure({
      code: 'OMK_DSH_HOST_CANCELLED',
      stage: 'execution',
      message: 'DSH Host execution was cancelled.',
    });
  }
  return new ExecutionPortFailure({
    code: 'OMK_DSH_HOST_SESSION_FAILED',
    stage: 'execution',
    message: 'DSH Host session failed.',
  });
}

async function executeDshHost(
  host: CapturedHost,
  target: CapturedClaudeCliTarget,
  runState: ClaudeCliRunState,
  trialState: ClaudeCliTrialState,
  attempt: Readonly<ExecutorAttemptContext>,
  operationIsolationKey: string,
): Promise<ExecutorAttemptResult> {
  assertHostCompositionUnchanged(host, target, attempt.signal);
  const allowedTools = trialState.allowedTools;
  const skillsDisabled = target.config.behavior.allowedSkills !== undefined;
  const effectiveToolNames = Object.freeze(
    host.effectiveToolSchemas.map(({ name }) => name).filter((name) => (
      (allowedTools === undefined || allowedTools.includes(name))
      && (!skillsDisabled || name !== 'skill')
    )),
  );
  const effectiveToolNameSet = new Set(effectiveToolNames);
  const deniedTools = Object.freeze(host.effectiveToolSchemas
    .map(({ name }) => name)
    .filter((name) => !effectiveToolNameSet.has(name)));
  const rootSessionId = `omk-core-${digestCanonicalJson({
    derivation: 'omk.dsh-host-attempt-session/v1',
    operationIsolationKey,
    attemptId: attempt.attemptId,
  }).replace(/^sha256:/, '')}`;
  const descendants = new Set<string>();
  const events: DshHostRunResult['events'] = [];
  let handle: Awaited<ReturnType<DshHostContextLike['agents']['create']>> | undefined;
  let eventBytes = 0;
  let eventCaptureInvalid = false;
  let eventEnvelopeInvalid = false;
  let eventLimitExceeded = false;
  let eventProtocolUnsupported = false;
  const expectedSequenceBySession = new Map<string, number>();
  let cancellationRequested = false;
  const requestCancellation = (): void => {
    if (cancellationRequested || handle === undefined) return;
    cancellationRequested = true;
    try {
      handle.agent.cancel({ kind: 'hook', reason: 'OMK Core rejected the host event stream' });
    } catch {
      // The adapter still awaits host settlement and reports the bounded failure.
    }
  };
  let disposeCreated: () => void = () => undefined;
  let disposeEvents: () => void = () => undefined;
  try {
    disposeCreated = host.subscribeCreated((session) => {
      const parent = session.header.parentSession;
      if (parent !== rootSessionId && (parent === undefined || !descendants.has(parent))) return;
      descendants.add(String(session.id));
    });
    disposeEvents = host.subscribeEvent((session, event) => {
      if (
        eventCaptureInvalid
        || eventEnvelopeInvalid
        || eventLimitExceeded
        || eventProtocolUnsupported
      ) return;
      const sessionId = String(session.id);
      const traceRole = sessionId === rootSessionId
        ? 'main'
        : descendants.has(sessionId)
          ? 'subagent'
          : undefined;
      if (traceRole === undefined) return;
      try {
        const captured = JsonValueSchema.parse(structuredClone(event));
        const capturedRecord = record(captured);
        if (capturedRecord === undefined) throw new TypeError('event must be an object');
        if (typeof capturedRecord.type !== 'string' || capturedRecord.type === '') {
          throw new TypeError('event type must be a non-empty string');
        }
        const expectedSequence = expectedSequenceBySession.get(sessionId) ?? 0;
        if (
          !Number.isSafeInteger(capturedRecord.seq)
          || capturedRecord.seq !== expectedSequence
          || !Number.isSafeInteger(capturedRecord.time)
          || (capturedRecord.time as number) < 0
        ) {
          eventEnvelopeInvalid = true;
          requestCancellation();
          return;
        }
        const nextEventBytes = eventBytes + Buffer.byteLength(canonicalizeJson(captured));
        if (!Number.isSafeInteger(nextEventBytes) || nextEventBytes > host.maxEventBytes) {
          eventLimitExceeded = true;
          requestCancellation();
          return;
        }
        eventBytes = nextEventBytes;
        expectedSequenceBySession.set(sessionId, expectedSequence + 1);
        events.push({
          sessionId,
          event: capturedRecord as Record<string, unknown>,
          traceRole,
        });
        if (
          capturedRecord.ignorable !== true
          && !supportsDshTraceEventType(capturedRecord.type)
        ) {
          eventProtocolUnsupported = true;
          requestCancellation();
        }
      } catch {
        eventCaptureInvalid = true;
        requestCancellation();
      }
    });
  } catch {
    try { disposeEvents(); } catch { /* subscription setup already failed */ }
    try { disposeCreated(); } catch { /* subscription setup already failed */ }
    fail(
      'OMK_DSH_HOST_SUBSCRIPTION_FAILED',
      'infrastructure',
      'DSH Host session event subscriptions could not be established.',
    );
  }

  let result: ExecutorAttemptResult | undefined;
  let pendingFailure: ExecutionPortFailure | undefined;
  let parsedUsage: UsageRecord | undefined;
  try {
    if (attempt.signal.aborted) {
      fail('OMK_DSH_HOST_CANCELLED', 'execution', 'DSH Host execution was cancelled.');
    }
    try {
      handle = await host.createAgent({
        sessionId: rootSessionId,
        meta: {
          cwd: trialState.workingDirectory,
          ...(host.parentAgentId === undefined ? {} : { parentSession: host.parentAgentId }),
          ...(host.activeAgentPreset === undefined ? {} : {
            agentPreset: host.activeAgentPreset,
          }),
        },
        agentOptions: {
          provider: host.provider,
          model: target.binding.qualification.model,
        },
        signal: attempt.signal,
        setup(agentContext) {
          if (host.composeFrom !== undefined) {
            const currentPreset = host.composeFrom(agentContext);
            if (currentPreset !== host.activeAgentPreset) {
              fail(
                'OMK_DSH_HOST_IDENTITY_CHANGED',
                'infrastructure',
                'DSH Host effective agent preset changed during session setup.',
              );
            }
          }
          agentContext.systemPrompt.section({
            name: 'omk:evaluation-core',
            order: 0,
            text: runState.systemInstructions ?? '',
            complete: true,
          });
          agentContext.systemPrompt.suppressRuntimeContext();
          if (allowedTools !== undefined || skillsDisabled) {
            if (
              agentContext.tools === undefined
              || typeof agentContext.tools.guard !== 'function'
            ) {
              fail(
                'OMK_DSH_HOST_TOOL_POLICY_UNAVAILABLE',
                'infrastructure',
                'DSH Host tool policy enforcement is unavailable during session setup.',
              );
            }
            if (allowedTools !== undefined && effectiveToolNames.length > 0) {
              agentContext.tools.restrict({ allow: effectiveToolNames });
            } else if (deniedTools.length > 0) {
              agentContext.tools.restrict({ deny: deniedTools });
            }
            agentContext.tools.guard(({ name }) => {
              if (skillsDisabled && name === 'skill') {
                return 'OMK evaluation policy disabled skill discovery.';
              }
              if (allowedTools !== undefined && !effectiveToolNameSet.has(name)) {
                return 'OMK evaluation tool allow-list denied this tool.';
              }
              return undefined;
            });
          }
        },
      });
    } catch (error) {
      if (error instanceof ExecutionPortFailure) throw error;
      if (attempt.signal.aborted) throw error;
      fail(
        'OMK_DSH_HOST_SESSION_CREATE_FAILED',
        'infrastructure',
        'DSH Host measurement session could not be created.',
      );
    }
    if (
      String(handle.agent.id) !== rootSessionId
      || String(handle.agent.session.id) !== rootSessionId
    ) {
      fail(
        'OMK_DSH_HOST_SESSION_ID_MISMATCH',
        'infrastructure',
        'DSH Host measurement session did not preserve the requested session identity.',
      );
    }
    if (
      eventCaptureInvalid
      || eventEnvelopeInvalid
      || eventLimitExceeded
      || eventProtocolUnsupported
    ) {
      requestCancellation();
    } else if (attempt.signal.aborted) {
      try { handle.agent.cancel({ kind: 'hook', reason: 'OMK Core attempt was cancelled' }); } catch { /* settle below */ }
    } else {
      handle.agent.followup(createPromptMessage(trialState.prompt));
    }
    const outcome = await waitForIdleOrCancellation(handle.agent, attempt.signal);
    if (eventCaptureInvalid) {
      fail(
        'OMK_DSH_HOST_PROTOCOL_INVALID',
        'execution',
        'DSH Host returned a non-JSON session event.',
      );
    }
    if (eventEnvelopeInvalid) {
      fail(
        'OMK_DSH_HOST_PROTOCOL_INVALID',
        'execution',
        'DSH Host returned an invalid session event envelope.',
      );
    }
    if (eventLimitExceeded) {
      fail(
        'OMK_DSH_HOST_OUTPUT_LIMIT_EXCEEDED',
        'infrastructure',
        'DSH Host session events exceeded the adapter byte limit.',
      );
    }
    if (eventProtocolUnsupported) {
      fail(
        'OMK_DSH_HOST_PROTOCOL_INVALID',
        'execution',
        'DSH Host returned an unsupported required session event.',
      );
    }
    const partialRunResult: DshHostRunResult = {
      rootSessionId,
      finalResponse: '',
      events,
      childSessionIds: [...descendants],
    };
    const runResult: DshHostRunResult = {
      ...partialRunResult,
      finalResponse: lastRootAssistantText(partialRunResult),
    };
    const parsed = parseDshHostCoreResult(runResult, {
      model: target.binding.qualification.model,
      provider: host.provider,
    });
    parsedUsage = parsed.usage;
    if (Buffer.byteLength(canonicalizeJson(parsed.trace)) > host.maxEventBytes) {
      fail(
        'OMK_DSH_HOST_OUTPUT_LIMIT_EXCEEDED',
        'infrastructure',
        'DSH Host session events exceeded the adapter byte limit.',
        parsed.usage,
      );
    }
    if (outcome === 'cancelled' || attempt.signal.aborted) {
      fail(
        'OMK_DSH_HOST_CANCELLED',
        'execution',
        'DSH Host execution was cancelled.',
        parsed.usage,
      );
    }
    if (parsed.terminalStatus !== 'completed' || parsed.output === undefined) {
      fail(
        'OMK_DSH_HOST_EXECUTION_FAILED',
        'execution',
        'DSH Host execution did not complete successfully.',
        parsed.usage,
      );
    }
    result = {
      output: { value: parsed.output, classification: 'secret', mediaType: 'text/plain' },
      trace: {
        value: parsed.trace,
        classification: 'secret',
        mediaType: 'application/vnd.omk.source-neutral-trace+json',
      },
      usage: parsed.usage,
    };
  } catch (error) {
    pendingFailure = executionFailure(error, attempt.signal);
  }

  let disposalFailed = false;
  try { disposeEvents(); } catch { disposalFailed = true; }
  try { disposeCreated(); } catch { disposalFailed = true; }
  if (handle !== undefined) {
    try { await handle.dispose(); } catch { disposalFailed = true; }
  }
  if (disposalFailed) {
    fail(
      'OMK_DSH_HOST_ATTEMPT_DISPOSE_FAILED',
      'infrastructure',
      'DSH Host measurement session could not be disposed.',
      parsedUsage ?? pendingFailure?.usage,
    );
  }
  if (pendingFailure !== undefined) throw pendingFailure;
  return result!;
}

/** Creates the DSH-plugin-owned Core adapter; it is intentionally absent from generic factories. */
export async function createDshHostCoreExecutorAdapter(
  input: Readonly<CreateDshHostCoreExecutorAdapterInput>,
): Promise<ExecutionExecutor> {
  if (typeof input.sessionIsolationKey !== 'string' || input.sessionIsolationKey.trim() === '') {
    throw new TypeError('DSH Host Core adapter requires a non-empty sessionIsolationKey.');
  }
  validateDshTargetSubset(input.target);
  const target = captureClaudeCliTarget(input.target, input.binding, RESOURCE_PROFILE);
  const host = captureHost(input, target);
  const identity = resolveIdentity(target, host);
  const resourceLeases = Object.freeze({
    forRun: input.resourceLeases.forRun.bind(input.resourceLeases),
  });
  return createSameProcessExecutorAdapter({
    identity,
    sessionIsolationKey: input.sessionIsolationKey,
    resourceLeases,
    implementation: {
      openRun({ resources }) {
        return captureClaudeCliRunState(resources, target, host.maxInputBytes, RESOURCE_PROFILE);
      },
      async openTrial({ runState, trial }) {
        if (
          trial.protocolId !== target.binding.protocolId
          || trial.targetId !== target.binding.targetId
          || canonicalizeJson(trial.targetConfig ?? null)
            !== canonicalizeJson(target.target.config ?? null)
        ) {
          fail(
            'OMK_DSH_HOST_TRIAL_MISMATCH',
            'infrastructure',
            'DSH Host trial does not match the sealed Target binding.',
          );
        }
        runState.acquireTrial();
        try {
          return openClaudeCliTrial(trial, runState, host.maxInputBytes, RESOURCE_PROFILE);
        } catch (error) {
          await runState.releaseTrial();
          throw error;
        }
      },
      execute({ runState, trialState, attempt, scope }) {
        return executeDshHost(
          host,
          target,
          runState,
          trialState,
          attempt,
          scope.operationIsolationKey,
        );
      },
      disposeTrial({ runState }) {
        return disposeClaudeCliTrial(runState, RESOURCE_PROFILE);
      },
      disposeRun({ runState }) {
        return runState.requestDispose();
      },
    },
  });
}
