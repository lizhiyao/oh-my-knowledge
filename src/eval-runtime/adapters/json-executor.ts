import { dirname, isAbsolute, normalize } from 'node:path';
import {
  IdentifierSchema,
  JsonValueSchema,
  RuntimeIdentitySchema,
  UsageRecordSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
  type UsageRecord,
} from '../../eval-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutionExecutor,
  type ExecutorAttemptContext,
  type ExecutorAttemptResult,
  type ExecutorRunContext,
  type ExecutorTrialContext,
} from '../../eval-core/execution/index.js';
import {
  MOCK_INTERCEPTION_PLAN_MEDIA_TYPE,
  captureMockInterceptionDecision,
  captureMockInterceptionProvider,
  type CapturedMockInterceptionProvider,
  type MockInterceptionAccess,
  type MockInterceptionLease,
  type MockInterceptionProvider,
  type MockInterceptionRequest,
} from '../mock-interception.js';
import {
  captureMcpConfigProvider,
  validateMcpConfigValue,
  type CapturedMcpConfigProvider,
  type McpConfigAccess,
  type McpConfigLease,
  type McpConfigProvider,
} from '../mcp-config.js';
import {
  captureWorkspaceProvider,
  type CapturedWorkspaceProvider,
  type WorkspaceAccess,
  type WorkspaceLease,
  type WorkspaceProvider,
} from '../workspace.js';
import { createSameProcessExecutorAdapter } from './same-process.js';
import {
  executorProtocol,
  invokeProtocol,
  sessionProtocol,
  validateExecutorFailureTelemetry,
  validateExecutorTelemetry,
} from './invoke-contract.js';

const OPENED_EXECUTOR_SESSIONS = new WeakSet<object>();
const OPENED_WORKSPACE_LEASES = new WeakSet<object>();
const ACTIVE_WORKSPACE_ROOTS = new Set<string>();
const OPENED_MCP_CONFIG_LEASES = new WeakSet<object>();
const OPENED_MOCK_INTERCEPTION_LEASES = new WeakSet<object>();

/** Internal process-wide guard shared by the canonical facade and advanced adapter. */
export function assertFreshExecutorSessionObject(session: object): void {
  if (OPENED_EXECUTOR_SESSIONS.has(session)) {
    throw new TypeError('Session Executor reused one session object across trials or runs.');
  }
  OPENED_EXECUTOR_SESSIONS.add(session);
}

export interface RuntimeValueParser<Value> {
  /** Validate and narrow only; changing the canonical JSON value fails closed. */
  parse(value: unknown): Value;
}

export interface JsonExecutorInvocation<Input, TargetConfig> {
  readonly input: Input;
  readonly targetConfig: TargetConfig;
  readonly executionContext?: JsonValue;
  readonly sampleId: string;
  readonly targetId: string;
  readonly trialIndex: number;
  readonly trialSeed?: string;
  readonly attemptNumber: number;
  readonly signal: AbortSignal;
  readonly workspace?: WorkspaceAccess;
  readonly mcpConfig?: McpConfigAccess;
  readonly mockInterception?: MockInterceptionAccess;
  /** Undefined means runtime default; an empty list denies every tool. */
  readonly allowedTools?: readonly string[];
}

export type JsonExecutorInvocationResult<Output extends JsonValue, Trace extends JsonValue> =
  | {
      readonly invocationStatus: 'completed';
      readonly output?: Output;
      readonly trace?: Trace;
      readonly usage?: UsageRecord;
    }
  | {
      readonly invocationStatus: 'failed';
      /** Public, stable failure classification. Provider-private messages must not be returned. */
      readonly errorCode: string;
      readonly usage?: UsageRecord;
    };

export interface JsonSessionExecutorContext<Input, TargetConfig> {
  readonly runId: string;
  readonly trialId: string;
  readonly input: Input;
  readonly targetConfig: TargetConfig;
  readonly executionContext?: JsonValue;
  readonly sampleId: string;
  readonly targetId: string;
  readonly trialIndex: number;
  readonly trialSeed?: string;
  readonly workspace?: WorkspaceAccess;
  readonly mcpConfig?: McpConfigAccess;
  /** Undefined means runtime default; an empty list denies every tool. */
  readonly allowedTools?: readonly string[];
}

export interface JsonSessionExecutorAttempt {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly signal: AbortSignal;
  readonly mockInterception?: MockInterceptionAccess;
}

export interface JsonExecutorSession<Output extends JsonValue, Trace extends JsonValue> {
  execute(
    attempt: Readonly<JsonSessionExecutorAttempt>,
  ): Promise<JsonExecutorInvocationResult<Output, Trace>>;
  close(): void | Promise<void>;
}

export interface CreateJsonExecutorAdapterInput<
  Input extends JsonValue,
  TargetConfig extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> {
  readonly identity: RuntimeIdentity;
  readonly inputParser: RuntimeValueParser<Input>;
  readonly targetConfigParser: RuntimeValueParser<TargetConfig>;
  readonly outputParser: RuntimeValueParser<Output>;
  readonly traceParser?: RuntimeValueParser<Trace>;
  readonly invoke: (
    invocation: Readonly<JsonExecutorInvocation<Input, TargetConfig>>,
  ) => Promise<JsonExecutorInvocationResult<Output, Trace>>;
  readonly outputClassification: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly traceClassification?: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly outputMediaType?: string;
  readonly traceMediaType?: string;
  readonly sessionIsolationKey?: string;
  readonly workspaceProvider?: WorkspaceProvider;
  readonly mcpConfigProvider?: McpConfigProvider;
  readonly mockInterceptionProvider?: MockInterceptionProvider;
}

export interface CreateJsonSessionExecutorAdapterInput<
  Input extends JsonValue,
  TargetConfig extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> {
  readonly identity: RuntimeIdentity;
  readonly inputParser: RuntimeValueParser<Input>;
  readonly targetConfigParser: RuntimeValueParser<TargetConfig>;
  readonly outputParser: RuntimeValueParser<Output>;
  readonly traceParser?: RuntimeValueParser<Trace>;
  readonly openSession: (
    context: Readonly<JsonSessionExecutorContext<Input, TargetConfig>>,
  ) => Promise<JsonExecutorSession<Output, Trace>>;
  readonly outputClassification: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly traceClassification?: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly outputMediaType?: string;
  readonly traceMediaType?: string;
  readonly sessionIsolationKey?: string;
  readonly workspaceProvider?: WorkspaceProvider;
  readonly mcpConfigProvider?: McpConfigProvider;
  readonly mockInterceptionProvider?: MockInterceptionProvider;
}

interface OpenedWorkspace {
  readonly access: WorkspaceAccess;
  close(): Promise<void>;
}

interface OpenedMcpConfig {
  readonly access: McpConfigAccess;
  close(): Promise<void>;
}

interface OpenedMockInterception {
  readonly access: MockInterceptionAccess;
  close(): Promise<void>;
}

function effectiveAllowedTools(trial: Readonly<ExecutorTrialContext>): readonly string[] | undefined {
  return trial.executionControl.tools.toolPolicyKind === 'runtime-default'
    ? undefined
    : Object.freeze([...trial.executionControl.tools.allowedTools]);
}

async function rejectInvalidWorkspaceLease(lease: unknown): Promise<never> {
  if (lease !== null && typeof lease === 'object'
      && typeof (lease as Partial<WorkspaceLease>).close === 'function') {
    try {
      await Reflect.apply((lease as WorkspaceLease).close, lease, []);
    } catch {
      // The public failure remains a single redacted resource-open error.
    }
  }
  throw new TypeError('Workspace provider returned an invalid lease.');
}

async function openWorkspace(
  provider: CapturedWorkspaceProvider | undefined,
  run: Readonly<ExecutorRunContext>,
  trial: Readonly<ExecutorTrialContext>,
): Promise<OpenedWorkspace | undefined> {
  const control = trial.executionControl.workspace;
  if (control.workspaceMode === 'not-required') return undefined;
  if (provider === undefined) {
    throw new TypeError('Workspace execution requires a WorkspaceProvider.');
  }
  const lease = await provider.open(Object.freeze({
    descriptor: control.descriptor,
    runId: run.runId,
    trialId: trial.trialId,
    sampleId: trial.sampleId,
    variantId: trial.targetId,
    trialIndex: trial.trialIndex,
    ...(trial.trialSeed === undefined ? {} : { trialSeed: trial.trialSeed }),
  }));
  if (lease === null || typeof lease !== 'object'
      || typeof lease.root !== 'string' || lease.root.trim() === ''
      || lease.root.includes('\0') || !isAbsolute(lease.root)
      || typeof lease.close !== 'function') {
    return rejectInvalidWorkspaceLease(lease);
  }
  const root = normalize(lease.root);
  if (dirname(root) === root) return rejectInvalidWorkspaceLease(lease);
  if (OPENED_WORKSPACE_LEASES.has(lease)) {
    throw new TypeError('Workspace provider reused one lease object across trials or runs.');
  }
  if (ACTIVE_WORKSPACE_ROOTS.has(root)) {
    OPENED_WORKSPACE_LEASES.add(lease);
    throw new TypeError('Workspace provider reused an active workspace root.');
  }
  OPENED_WORKSPACE_LEASES.add(lease);
  ACTIVE_WORKSPACE_ROOTS.add(root);
  const close = lease.close;
  return Object.freeze({
    access: Object.freeze({ descriptor: control.descriptor, root }),
    async close() {
      await Reflect.apply(close, lease, []);
      ACTIVE_WORKSPACE_ROOTS.delete(root);
    },
  });
}

async function rejectInvalidMcpConfigLease(lease: unknown): Promise<never> {
  if (lease !== null && typeof lease === 'object'
      && !OPENED_MCP_CONFIG_LEASES.has(lease)
      && typeof (lease as Partial<McpConfigLease>).close === 'function') {
    OPENED_MCP_CONFIG_LEASES.add(lease);
    try {
      await Reflect.apply((lease as McpConfigLease).close, lease, []);
    } catch {
      // The public failure remains a single redacted resource-open error.
    }
  }
  throw new TypeError('MCP config provider returned an invalid lease.');
}

async function closeLateMcpConfigLease(lease: unknown): Promise<void> {
  if (lease === null || typeof lease !== 'object'
      || OPENED_MCP_CONFIG_LEASES.has(lease)
      || typeof (lease as Partial<McpConfigLease>).close !== 'function') return;
  OPENED_MCP_CONFIG_LEASES.add(lease);
  try {
    await Reflect.apply((lease as McpConfigLease).close, lease, []);
  } catch {
    // Cancellation is already authoritative; late cleanup failure must not leak provider details.
  }
}

async function openMcpConfig(
  provider: CapturedMcpConfigProvider | undefined,
  run: Readonly<ExecutorRunContext>,
  trial: Readonly<ExecutorTrialContext>,
): Promise<OpenedMcpConfig | undefined> {
  const control = trial.executionControl.mcp;
  if (control.mcpMode === 'not-required') return undefined;
  if (provider === undefined) throw new TypeError('MCP execution requires an McpConfigProvider.');
  if (trial.signal.aborted) throw trial.signal.reason;
  if (control.descriptor.mediaType !== 'application/json'
      || control.descriptor.classification !== 'secret') {
    throw new TypeError('MCP config descriptors require secret application/json content.');
  }
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(trial.signal.reason);
    trial.signal.addEventListener('abort', abortListener, { once: true });
    if (trial.signal.aborted) abortListener();
  });
  const opening = Promise.resolve().then(() => {
    if (trial.signal.aborted) throw trial.signal.reason;
    return provider.open(Object.freeze({
      descriptor: control.descriptor,
      runId: run.runId,
      trialId: trial.trialId,
      sampleId: trial.sampleId,
      variantId: trial.targetId,
      trialIndex: trial.trialIndex,
      ...(trial.trialSeed === undefined ? {} : { trialSeed: trial.trialSeed }),
      signal: trial.signal,
    }));
  });
  let lease: McpConfigLease;
  try {
    lease = await Promise.race([opening, aborted]);
  } catch (error) {
    if (trial.signal.aborted) {
      void opening.then(closeLateMcpConfigLease, () => undefined);
    }
    throw error;
  } finally {
    if (abortListener !== undefined) {
      trial.signal.removeEventListener('abort', abortListener);
    }
  }
  if (trial.signal.aborted) {
    await closeLateMcpConfigLease(lease);
    throw trial.signal.reason;
  }
  if (lease === null || typeof lease !== 'object'
      || !Object.prototype.hasOwnProperty.call(lease, 'config')
      || typeof lease.close !== 'function') {
    return rejectInvalidMcpConfigLease(lease);
  }
  if (OPENED_MCP_CONFIG_LEASES.has(lease)) {
    throw new TypeError('MCP config provider reused one lease object across trials or runs.');
  }
  OPENED_MCP_CONFIG_LEASES.add(lease);
  let config: JsonValue;
  try {
    config = validateMcpConfigValue(control.descriptor, lease.config);
  } catch {
    try {
      await Reflect.apply(lease.close, lease, []);
    } catch {
      // The public failure remains a single redacted resource-open error.
    }
    throw new TypeError('MCP config provider returned invalid content.');
  }
  const close = lease.close;
  return Object.freeze({
    access: Object.freeze({ descriptor: control.descriptor, config }),
    async close() {
      await Reflect.apply(close, lease, []) as void | Promise<void>;
    },
  });
}

async function rejectInvalidMockInterceptionLease(
  lease: unknown,
  capturedClose?: unknown,
): Promise<never> {
  if (lease !== null && typeof lease === 'object'
      && !OPENED_MOCK_INTERCEPTION_LEASES.has(lease)) {
    OPENED_MOCK_INTERCEPTION_LEASES.add(lease);
    if (typeof capturedClose === 'function') {
      try {
        await Reflect.apply(capturedClose, lease, []);
      } catch {
        // The public failure remains a single redacted resource-open error.
      }
    }
  }
  throw new TypeError('Mock interception provider returned an invalid lease.');
}

async function closeLateMockInterceptionLease(lease: unknown): Promise<void> {
  if (lease === null || typeof lease !== 'object'
      || OPENED_MOCK_INTERCEPTION_LEASES.has(lease)) return;
  let close: unknown;
  try {
    close = Reflect.get(lease, 'close');
  } catch {
    return;
  }
  OPENED_MOCK_INTERCEPTION_LEASES.add(lease);
  if (typeof close !== 'function') return;
  try {
    await Reflect.apply(close, lease, []);
  } catch {
    // Cancellation is authoritative; late cleanup failure must not leak provider details.
  }
}

async function openMockInterception(
  provider: CapturedMockInterceptionProvider | undefined,
  run: Readonly<ExecutorRunContext>,
  trial: Readonly<ExecutorTrialContext>,
  attempt: Readonly<ExecutorAttemptContext>,
): Promise<OpenedMockInterception | undefined> {
  const control = trial.executionControl.mockInterception;
  if (control.mockInterceptionMode === 'not-required') return undefined;
  if (provider === undefined) {
    throw new TypeError('Mock interception execution requires a MockInterceptionProvider.');
  }
  if (attempt.signal.aborted) throw attempt.signal.reason;
  if (control.descriptor.mediaType !== MOCK_INTERCEPTION_PLAN_MEDIA_TYPE
      || control.descriptor.classification !== 'secret') {
    throw new TypeError('Mock interception descriptor is invalid.');
  }
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(attempt.signal.reason);
    attempt.signal.addEventListener('abort', abortListener, { once: true });
    if (attempt.signal.aborted) abortListener();
  });
  const opening = Promise.resolve().then(() => {
    if (attempt.signal.aborted) throw attempt.signal.reason;
    return provider.open(Object.freeze({
      descriptor: control.descriptor,
      runId: run.runId,
      trialId: trial.trialId,
      sampleId: trial.sampleId,
      variantId: trial.targetId,
      trialIndex: trial.trialIndex,
      ...(trial.trialSeed === undefined ? {} : { trialSeed: trial.trialSeed }),
      attemptId: attempt.attemptId,
      attemptNumber: attempt.attemptNumber,
      signal: attempt.signal,
    }));
  });
  let lease: MockInterceptionLease;
  try {
    lease = await Promise.race([opening, aborted]);
  } catch (error) {
    if (attempt.signal.aborted) {
      void opening.then(closeLateMockInterceptionLease, () => undefined);
      throw error;
    }
    throw new TypeError('Mock interception provider failed to open a lease.');
  } finally {
    if (abortListener !== undefined) {
      attempt.signal.removeEventListener('abort', abortListener);
    }
  }
  if (attempt.signal.aborted) {
    await closeLateMockInterceptionLease(lease);
    throw attempt.signal.reason;
  }
  if (lease === null || typeof lease !== 'object') {
    return rejectInvalidMockInterceptionLease(lease);
  }
  let close: unknown;
  let intercept: unknown;
  try {
    close = Reflect.get(lease, 'close');
    intercept = Reflect.get(lease, 'intercept');
  } catch {
    return rejectInvalidMockInterceptionLease(lease, close);
  }
  if (typeof intercept !== 'function' || typeof close !== 'function') {
    return rejectInvalidMockInterceptionLease(lease, close);
  }
  if (OPENED_MOCK_INTERCEPTION_LEASES.has(lease)) {
    throw new TypeError('Mock interception provider reused one lease object across attempts.');
  }
  OPENED_MOCK_INTERCEPTION_LEASES.add(lease);
  if (attempt.signal.aborted) {
    try {
      await Reflect.apply(close, lease, []) as void | Promise<void>;
    } catch {
      // Cancellation is authoritative; cleanup failure must not leak provider details.
    }
    throw attempt.signal.reason;
  }
  let active = true;
  let closePromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();
  return Object.freeze({
    access: Object.freeze({
      descriptor: control.descriptor,
      async intercept(request: Readonly<MockInterceptionRequest>) {
        if (!active) throw new TypeError('Mock interception access is no longer active.');
        if (request?.signal !== attempt.signal
            || !IdentifierSchema.safeParse(request?.callId).success
            || !IdentifierSchema.safeParse(request?.toolName).success) {
          throw new TypeError('Mock interception request is invalid.');
        }
        let capturedInput: JsonValue;
        try {
          capturedInput = deepFreezeCanonicalJson(
            JsonValueSchema.parse(structuredClone(request.input)),
          );
        } catch {
          throw new TypeError('Mock interception request is invalid.');
        }
        if (attempt.signal.aborted) throw attempt.signal.reason;
        const operation = (async () => {
          const decision = await Reflect.apply(intercept, lease, [Object.freeze({
            callId: request.callId,
            toolName: request.toolName,
            input: capturedInput,
            signal: attempt.signal,
          })]) as unknown;
          if (attempt.signal.aborted) throw attempt.signal.reason;
          return captureMockInterceptionDecision(decision);
        })();
        const settled = operation.then(() => undefined, () => undefined);
        inFlight.add(settled);
        try {
          return await operation;
        } catch (error) {
          if (attempt.signal.aborted) throw attempt.signal.reason;
          if (error instanceof TypeError
              && error.message === 'Mock interception provider returned an invalid decision.') {
            throw error;
          }
          throw new TypeError('Mock interception provider failed.');
        } finally {
          inFlight.delete(settled);
        }
      },
    }),
    async close() {
      if (closePromise !== undefined) return closePromise;
      active = false;
      closePromise = (async () => {
        await Promise.all([...inFlight]);
        try {
          await Reflect.apply(close, lease, []) as void | Promise<void>;
        } catch {
          throw new TypeError('Mock interception lease cleanup failed.');
        }
      })();
      return closePromise;
    },
  });
}

function requireWorkspaceCapability(
  protocol: ReturnType<typeof executorProtocol>,
  provider: CapturedWorkspaceProvider | undefined,
): void {
  const supportsWorkspace = protocol.execution.features.workspace.includes(
    'copy-on-write-overlay',
  );
  if (provider !== undefined && !supportsWorkspace) {
    throw new TypeError(
      'WorkspaceProvider requires copy-on-write-overlay Runtime capability.',
    );
  }
  if (provider === undefined && supportsWorkspace) {
    throw new TypeError(
      'copy-on-write-overlay Runtime capability requires a WorkspaceProvider.',
    );
  }
}

function requireMcpConfigCapability(
  protocol: ReturnType<typeof executorProtocol>,
  provider: CapturedMcpConfigProvider | undefined,
): void {
  const supportsMcp = protocol.execution.features.mcp.includes('native-config');
  if (provider !== undefined && !supportsMcp) {
    throw new TypeError('McpConfigProvider requires native-config Runtime capability.');
  }
  if (provider === undefined && supportsMcp) {
    throw new TypeError('native-config Runtime capability requires an McpConfigProvider.');
  }
}

function requireMockInterceptionCapability(
  protocol: ReturnType<typeof executorProtocol>,
  provider: CapturedMockInterceptionProvider | undefined,
): void {
  const supportsMockInterception = protocol.execution.features.mockInterception.includes(
    'pre-tool-call',
  );
  if (provider !== undefined && !supportsMockInterception) {
    throw new TypeError(
      'MockInterceptionProvider requires pre-tool-call Runtime capability.',
    );
  }
  if (provider === undefined && supportsMockInterception) {
    throw new TypeError(
      'pre-tool-call Runtime capability requires a MockInterceptionProvider.',
    );
  }
}

function bindWorkspaceIdentity(
  identity: RuntimeIdentity,
  provider: CapturedWorkspaceProvider | undefined,
): RuntimeIdentity {
  if (provider === undefined) return identity;
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    ...structuredClone(identity),
    fingerprint: digestCanonicalJson({
      derivation: 'omk.eval-runtime.workspace-bound-identity/v1',
      executorIdentity: identity,
      workspaceProvider: {
        providerId: provider.providerId,
        version: provider.version,
        ...(provider.fingerprintFacets === undefined
          ? {}
          : { fingerprintFacets: provider.fingerprintFacets }),
      },
    }),
  }));
}

function bindMcpConfigIdentity(
  identity: RuntimeIdentity,
  provider: CapturedMcpConfigProvider | undefined,
): RuntimeIdentity {
  if (provider === undefined) return identity;
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    ...structuredClone(identity),
    fingerprint: digestCanonicalJson({
      derivation: 'omk.eval-runtime.mcp-config-bound-identity/v1',
      executorIdentity: identity,
      mcpConfigProvider: {
        providerId: provider.providerId,
        version: provider.version,
        ...(provider.fingerprintFacets === undefined
          ? {}
          : { fingerprintFacets: provider.fingerprintFacets }),
      },
    }),
  }));
}

function bindMockInterceptionIdentity(
  identity: RuntimeIdentity,
  provider: CapturedMockInterceptionProvider | undefined,
): RuntimeIdentity {
  if (provider === undefined) return identity;
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    ...structuredClone(identity),
    fingerprint: digestCanonicalJson({
      derivation: 'omk.eval-runtime.mock-interception-bound-identity/v1',
      executorIdentity: identity,
      mockInterceptionProvider: {
        providerId: provider.providerId,
        version: provider.version,
        ...(provider.fingerprintFacets === undefined
          ? {}
          : { fingerprintFacets: provider.fingerprintFacets }),
      },
    }),
  }));
}

function structuredFailure(code: string, usage?: UsageRecord): never {
  throw new ExecutionPortFailure({
    code,
    stage: 'execution',
    message: 'Host JSON Executor reported a structured failure.',
  }, usage);
}

function parse<Value>(
  parser: Readonly<RuntimeValueParser<Value>>,
  value: unknown,
  failureCode: string,
): Value {
  try {
    return parser.parse(structuredClone(value));
  } catch {
    return structuredFailure(failureCode);
  }
}

function captureParser<Value>(
  parser: Readonly<RuntimeValueParser<Value>>,
): RuntimeValueParser<Value> {
  if (typeof parser?.parse !== 'function') {
    throw new TypeError('JSON Executor adapter requires every Runtime parser.');
  }
  const parseValue = parser.parse;
  return Object.freeze({
    parse: (value: unknown) => Reflect.apply(parseValue, parser, [value]) as Value,
  });
}

function parseJsonUnchanged<Value extends JsonValue>(
  parser: Readonly<RuntimeValueParser<Value>>,
  value: unknown,
  failureCode: string,
): Value {
  const wire = parse(JsonValueSchema, value, failureCode);
  const parsed = parse(parser, wire, failureCode);
  const parsedWire = parse(JsonValueSchema, parsed, failureCode);
  if (canonicalizeJson(wire) !== canonicalizeJson(parsedWire)) {
    return structuredFailure(failureCode);
  }
  return parsed;
}

function parseOptionalJsonUnchanged<Value extends JsonValue | undefined>(
  parser: Readonly<RuntimeValueParser<Value>>,
  value: unknown,
  failureCode: string,
): Value {
  if (value === undefined) {
    const parsed = parse(parser, undefined, failureCode);
    if (parsed !== undefined) return structuredFailure(failureCode);
    return parsed;
  }
  return parseJsonUnchanged(
    parser as RuntimeValueParser<Exclude<Value, undefined>>,
    value,
    failureCode,
  ) as Value;
}

interface JsonResultContract<Output extends JsonValue, Trace extends JsonValue> {
  readonly outputParser: RuntimeValueParser<Output>;
  readonly traceParser?: RuntimeValueParser<Trace>;
  readonly outputClassification: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly traceClassification: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly outputMediaType?: string;
  readonly traceMediaType?: string;
}

async function executeJsonHost<Output extends JsonValue, Trace extends JsonValue>(
  protocol: ReturnType<typeof executorProtocol>,
  signal: AbortSignal,
  hostCall: () => Promise<JsonExecutorInvocationResult<Output, Trace>>,
  contract: Readonly<JsonResultContract<Output, Trace>>,
): Promise<ExecutorAttemptResult> {
  let hostResult: JsonExecutorInvocationResult<Output, Trace>;
  try {
    hostResult = await hostCall();
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ExecutionPortFailure) throw error;
    return structuredFailure('EVAL_RUNTIME_EXECUTOR_FAILED');
  }
  if (hostResult === null || typeof hostResult !== 'object' || Array.isArray(hostResult)) {
    return structuredFailure('EVAL_RUNTIME_EXECUTOR_RESULT_INVALID');
  }
  const usage = hostResult.usage === undefined
    ? undefined
    : parse(UsageRecordSchema, hostResult.usage, 'EVAL_RUNTIME_EXECUTOR_USAGE_INVALID');
  if (hostResult.invocationStatus === 'failed') {
    validateExecutorFailureTelemetry(protocol, usage);
    const parsedCode = IdentifierSchema.safeParse(hostResult.errorCode);
    if (!parsedCode.success) {
      return structuredFailure('EVAL_RUNTIME_EXECUTOR_FAILURE_CODE_INVALID', usage);
    }
    return structuredFailure(parsedCode.data, usage);
  }
  if (hostResult.invocationStatus !== 'completed') {
    return structuredFailure('EVAL_RUNTIME_EXECUTOR_RESULT_INVALID', usage);
  }
  const result: ExecutorAttemptResult = {
    ...(hostResult.output === undefined ? {} : {
      output: {
        value: parseJsonUnchanged(
          contract.outputParser,
          hostResult.output,
          'EVAL_RUNTIME_EXECUTOR_OUTPUT_INVALID',
        ),
        classification: contract.outputClassification,
        ...(contract.outputMediaType === undefined
          ? {}
          : { mediaType: contract.outputMediaType }),
      },
    }),
    ...(hostResult.trace === undefined ? {} : {
      trace: {
        value: contract.traceParser === undefined
          ? parse(JsonValueSchema, hostResult.trace, 'EVAL_RUNTIME_EXECUTOR_TRACE_INVALID')
          : parseJsonUnchanged(
            contract.traceParser,
            hostResult.trace,
            'EVAL_RUNTIME_EXECUTOR_TRACE_INVALID',
          ),
        classification: contract.traceClassification,
        ...(contract.traceMediaType === undefined
          ? {}
          : { mediaType: contract.traceMediaType }),
      },
    }),
    ...(usage === undefined ? {} : { usage }),
  };
  validateExecutorTelemetry(protocol, result);
  return result;
}

/** Adapts a typed, source-neutral JSON callback to the Core `omk.invoke/v1` Executor port. */
export function createJsonExecutorAdapter<
  Input extends JsonValue,
  TargetConfig extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
>(
  input: Readonly<CreateJsonExecutorAdapterInput<Input, TargetConfig, Output, Trace>>,
): ExecutionExecutor {
  const protocol = invokeProtocol(input.identity);
  const workspaceProvider = captureWorkspaceProvider(input.workspaceProvider);
  const mcpConfigProvider = captureMcpConfigProvider(input.mcpConfigProvider);
  const mockInterceptionProvider = captureMockInterceptionProvider(
    input.mockInterceptionProvider,
  );
  requireWorkspaceCapability(protocol, workspaceProvider);
  requireMcpConfigCapability(protocol, mcpConfigProvider);
  requireMockInterceptionCapability(protocol, mockInterceptionProvider);
  const identity = bindMockInterceptionIdentity(
    bindMcpConfigIdentity(
      bindWorkspaceIdentity(input.identity, workspaceProvider),
      mcpConfigProvider,
    ),
    mockInterceptionProvider,
  );
  const invoke = input.invoke;
  const inputParser = captureParser(input.inputParser);
  const targetConfigParser = captureParser(input.targetConfigParser);
  const outputParser = captureParser(input.outputParser);
  const traceParser = input.traceParser === undefined
    ? undefined
    : captureParser(input.traceParser);
  const outputClassification = input.outputClassification;
  const traceClassification = input.traceClassification ?? input.outputClassification;
  const resultContract: JsonResultContract<Output, Trace> = Object.freeze({
    outputParser,
    ...(traceParser === undefined ? {} : { traceParser }),
    outputClassification,
    traceClassification,
    ...(input.outputMediaType === undefined ? {} : { outputMediaType: input.outputMediaType }),
    ...(input.traceMediaType === undefined ? {} : { traceMediaType: input.traceMediaType }),
  });

  return createSameProcessExecutorAdapter({
    identity,
    sessionIsolationKey: input.sessionIsolationKey
      ?? `eval-runtime:${identity.implementationId}`,
    resourceLeases: { forRun: () => undefined },
    implementation: {
      openRun: ({ run }) => run,
      async openTrial({ run, trial }) {
        const workspace = await openWorkspace(workspaceProvider, run, trial);
        try {
          return Object.freeze({
            run,
            trial,
            workspace,
            mcpConfig: await openMcpConfig(mcpConfigProvider, run, trial),
            allowedTools: effectiveAllowedTools(trial),
          });
        } catch (error) {
          if (workspace !== undefined) await workspace.close();
          throw error;
        }
      },
      async execute({ trialState, attempt }): Promise<ExecutorAttemptResult> {
        if (attempt.signal.aborted) throw attempt.signal.reason;
        const { run, trial, workspace, mcpConfig, allowedTools } = trialState;
        const mockInterception = trial.executionControl.mockInterception.mockInterceptionMode
          === 'not-required'
          ? undefined
          : await openMockInterception(mockInterceptionProvider, run, trial, attempt);
        try {
          const invocation: JsonExecutorInvocation<Input, TargetConfig> = Object.freeze({
            input: parseJsonUnchanged(
              inputParser,
              trial.input,
              'EVAL_RUNTIME_EXECUTOR_INPUT_INVALID',
            ),
            targetConfig: parseOptionalJsonUnchanged(
              targetConfigParser,
              trial.targetConfig,
              'EVAL_RUNTIME_EXECUTOR_TARGET_CONFIG_INVALID',
            ),
            ...(trial.executionContext === undefined
              ? {}
              : { executionContext: structuredClone(trial.executionContext) }),
            sampleId: trial.sampleId,
            targetId: trial.targetId,
            trialIndex: trial.trialIndex,
            ...(trial.trialSeed === undefined ? {} : { trialSeed: trial.trialSeed }),
            attemptNumber: attempt.attemptNumber,
            signal: attempt.signal,
            ...(workspace === undefined ? {} : { workspace: workspace.access }),
            ...(mcpConfig === undefined ? {} : { mcpConfig: mcpConfig.access }),
            ...(mockInterception === undefined
              ? {}
              : { mockInterception: mockInterception.access }),
            ...(allowedTools === undefined ? {} : { allowedTools }),
          });
          attempt.signal.throwIfAborted();
          return await executeJsonHost(
            protocol,
            attempt.signal,
            () => invoke(invocation),
            mockInterception === undefined
              ? resultContract
              : { ...resultContract, outputClassification: 'secret', traceClassification: 'secret' },
          );
        } finally {
          if (mockInterception !== undefined) await mockInterception.close();
        }
      },
      async disposeTrial({ trialState }) {
        let cleanupFailed = false;
        if (trialState.mcpConfig !== undefined) {
          try {
            await trialState.mcpConfig.close();
          } catch {
            cleanupFailed = true;
          }
        }
        if (trialState.workspace !== undefined) {
          try {
            await trialState.workspace.close();
          } catch {
            cleanupFailed = true;
          }
        }
        if (cleanupFailed) throw new TypeError('Executor resource cleanup failed.');
      },
      disposeRun: () => undefined,
    },
  });
}

/** Adapts an isolated typed JSON session lifecycle to the Core `omk.session/v1` port. */
export function createJsonSessionExecutorAdapter<
  Input extends JsonValue,
  TargetConfig extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
>(
  input: Readonly<CreateJsonSessionExecutorAdapterInput<Input, TargetConfig, Output, Trace>>,
): ExecutionExecutor {
  const protocol = sessionProtocol(input.identity);
  const workspaceProvider = captureWorkspaceProvider(input.workspaceProvider);
  const mcpConfigProvider = captureMcpConfigProvider(input.mcpConfigProvider);
  const mockInterceptionProvider = captureMockInterceptionProvider(
    input.mockInterceptionProvider,
  );
  requireWorkspaceCapability(protocol, workspaceProvider);
  requireMcpConfigCapability(protocol, mcpConfigProvider);
  requireMockInterceptionCapability(protocol, mockInterceptionProvider);
  const identity = bindMockInterceptionIdentity(
    bindMcpConfigIdentity(
      bindWorkspaceIdentity(input.identity, workspaceProvider),
      mcpConfigProvider,
    ),
    mockInterceptionProvider,
  );
  const inputParser = captureParser(input.inputParser);
  const targetConfigParser = captureParser(input.targetConfigParser);
  const outputParser = captureParser(input.outputParser);
  const traceParser = input.traceParser === undefined
    ? undefined
    : captureParser(input.traceParser);
  const outputClassification = input.outputClassification;
  const traceClassification = input.traceClassification ?? input.outputClassification;
  const openSession = input.openSession;
  if (typeof openSession !== 'function') {
    throw new TypeError('JSON Session Executor adapter requires openSession.');
  }
  const resultContract: JsonResultContract<Output, Trace> = Object.freeze({
    outputParser,
    ...(traceParser === undefined ? {} : { traceParser }),
    outputClassification,
    traceClassification,
    ...(input.outputMediaType === undefined ? {} : { outputMediaType: input.outputMediaType }),
    ...(input.traceMediaType === undefined ? {} : { traceMediaType: input.traceMediaType }),
  });

  return createSameProcessExecutorAdapter({
    identity,
    sessionIsolationKey: input.sessionIsolationKey
      ?? `eval-runtime:${identity.implementationId}`,
    resourceLeases: { forRun: () => undefined },
    implementation: {
      openRun: ({ run }) => run,
      async openTrial({ run, trial }) {
        const workspace = await openWorkspace(workspaceProvider, run, trial);
        let mcpConfig: OpenedMcpConfig | undefined;
        const allowedTools = effectiveAllowedTools(trial);
        try {
          mcpConfig = await openMcpConfig(mcpConfigProvider, run, trial);
          const context: JsonSessionExecutorContext<Input, TargetConfig> = Object.freeze({
            runId: run.runId,
            trialId: trial.trialId,
            input: parseJsonUnchanged(
              inputParser,
              trial.input,
              'EVAL_RUNTIME_EXECUTOR_INPUT_INVALID',
            ),
            targetConfig: parseOptionalJsonUnchanged(
              targetConfigParser,
              trial.targetConfig,
              'EVAL_RUNTIME_EXECUTOR_TARGET_CONFIG_INVALID',
            ),
            ...(trial.executionContext === undefined
              ? {}
              : { executionContext: structuredClone(trial.executionContext) }),
            sampleId: trial.sampleId,
            targetId: trial.targetId,
            trialIndex: trial.trialIndex,
            ...(trial.trialSeed === undefined ? {} : { trialSeed: trial.trialSeed }),
            ...(workspace === undefined ? {} : { workspace: workspace.access }),
            ...(mcpConfig === undefined ? {} : { mcpConfig: mcpConfig.access }),
            ...(allowedTools === undefined ? {} : { allowedTools }),
          });
          if (trial.signal.aborted) throw trial.signal.reason;
          const session = await Reflect.apply(openSession, input, [context]);
          if (session === null || typeof session !== 'object'
              || typeof session.execute !== 'function'
              || typeof session.close !== 'function') {
            throw new TypeError('Session Executor returned an invalid session lifecycle.');
          }
          assertFreshExecutorSessionObject(session);
          return Object.freeze({
            run,
            trial,
            session,
            execute: session.execute,
            close: session.close,
            workspace,
            mcpConfig,
          });
        } catch (error) {
          let cleanupFailed = false;
          if (mcpConfig !== undefined) {
            try {
              await mcpConfig.close();
            } catch {
              cleanupFailed = true;
            }
          }
          if (workspace !== undefined) {
            try {
              await workspace.close();
            } catch {
              cleanupFailed = true;
            }
          }
          if (cleanupFailed) throw new TypeError('Resource cleanup failed while opening a session.');
          throw error;
        }
      },
      async execute({ trialState, attempt }) {
        if (attempt.signal.aborted) throw attempt.signal.reason;
        const mockInterception = trialState.trial.executionControl.mockInterception
          .mockInterceptionMode === 'not-required'
          ? undefined
          : await openMockInterception(
              mockInterceptionProvider,
              trialState.run,
              trialState.trial,
              attempt,
            );
        try {
          const sessionAttempt: JsonSessionExecutorAttempt = Object.freeze({
            attemptId: attempt.attemptId,
            attemptNumber: attempt.attemptNumber,
            signal: attempt.signal,
            ...(mockInterception === undefined
              ? {}
              : { mockInterception: mockInterception.access }),
          });
          attempt.signal.throwIfAborted();
          return await executeJsonHost(
            protocol,
            attempt.signal,
            () => Reflect.apply(trialState.execute, trialState.session, [sessionAttempt]),
            mockInterception === undefined
              ? resultContract
              : { ...resultContract, outputClassification: 'secret', traceClassification: 'secret' },
          );
        } finally {
          if (mockInterception !== undefined) await mockInterception.close();
        }
      },
      async disposeTrial({ trialState }) {
        let cleanupFailed = false;
        try {
          await Reflect.apply(trialState.close, trialState.session, []) as void | Promise<void>;
        } catch {
          cleanupFailed = true;
        }
        if (trialState.mcpConfig !== undefined) {
          try {
            await trialState.mcpConfig.close();
          } catch {
            cleanupFailed = true;
          }
        }
        if (trialState.workspace !== undefined) {
          try {
            await trialState.workspace.close();
          } catch {
            cleanupFailed = true;
          }
        }
        if (cleanupFailed) {
          throw new TypeError('Session or Executor resource cleanup failed.');
        }
      },
      disposeRun: () => undefined,
    },
  });
}
