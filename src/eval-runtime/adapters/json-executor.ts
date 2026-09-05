import {
  IdentifierSchema,
  JsonValueSchema,
  UsageRecordSchema,
  canonicalizeJson,
  type JsonValue,
  type RuntimeIdentity,
  type UsageRecord,
} from '../../eval-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutionExecutor,
  type ExecutorAttemptResult,
} from '../../eval-core/execution/index.js';
import { createSameProcessExecutorAdapter } from './same-process.js';
import {
  executorProtocol,
  invokeProtocol,
  sessionProtocol,
  validateExecutorFailureTelemetry,
  validateExecutorTelemetry,
} from './invoke-contract.js';

const OPENED_EXECUTOR_SESSIONS = new WeakSet<object>();

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
}

export interface JsonSessionExecutorAttempt {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly signal: AbortSignal;
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
  const identity = input.identity;
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
      openRun: () => undefined,
      openTrial: ({ trial }) => trial,
      async execute({ trial, attempt }): Promise<ExecutorAttemptResult> {
        if (attempt.signal.aborted) throw attempt.signal.reason;
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
        });
        return executeJsonHost(
          protocol,
          attempt.signal,
          () => invoke(invocation),
          resultContract,
        );
      },
      disposeTrial: () => undefined,
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
  const identity = input.identity;
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
        });
        const session = await Reflect.apply(openSession, input, [context]);
        if (session === null || typeof session !== 'object'
            || typeof session.execute !== 'function'
            || typeof session.close !== 'function') {
          throw new TypeError('Session Executor returned an invalid session lifecycle.');
        }
        assertFreshExecutorSessionObject(session);
        return Object.freeze({
          session,
          execute: session.execute,
          close: session.close,
        });
      },
      async execute({ trialState, attempt }) {
        if (attempt.signal.aborted) throw attempt.signal.reason;
        const sessionAttempt: JsonSessionExecutorAttempt = Object.freeze({
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
          signal: attempt.signal,
        });
        return executeJsonHost(
          protocol,
          attempt.signal,
          () => Reflect.apply(trialState.execute, trialState.session, [sessionAttempt]),
          resultContract,
        );
      },
      disposeTrial: ({ trialState }) => (
        Reflect.apply(trialState.close, trialState.session, []) as void | Promise<void>
      ),
      disposeRun: () => undefined,
    },
  });
}
