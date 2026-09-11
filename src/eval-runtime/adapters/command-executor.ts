import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import {
  IdentifierSchema,
  JsonValueSchema,
  UsageRecordSchema,
  canonicalizeJson,
  digestCanonicalJson,
  type JsonValue,
} from '../../eval-core/contracts/index.js';
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorInvocation,
  ExecutorResult,
} from '../evaluation/contracts.js';

/**
 * Façade-level subprocess exchange. Deliberately distinct from the sealed host-seam protocol
 * `omk.custom-command-exchange/v1`: a canonical invocation carries no runId, trialId, attemptId,
 * isolation key or execution plan digest, and this adapter never fabricates them. Hosts that need
 * plan-bound isolation, workspace overlays, native MCP config or mock interception must compose the
 * advanced execution seam instead.
 */
export const SUBPROCESS_COMMAND_EXCHANGE_SCHEMA_VERSION =
  'omk.subprocess-command-exchange/v1' as const;

export const DEFAULT_SUBPROCESS_COMMAND_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

const SIGTERM_GRACE_MS = 500;

const EnvironmentSchema = z.record(
  z.string().min(1).refine((value) => !value.includes('\0')),
  z.string().refine((value) => !value.includes('\0')),
);

const SubprocessCommandConfigurationSchema = z.object({
  executablePath: z.string().min(1).refine((value) => !value.includes('\0')),
  arguments: z.array(z.string().refine((value) => !value.includes('\0'))).optional(),
  environment: EnvironmentSchema.optional(),
  workingDirectory: z.string().min(1).refine((value) => !value.includes('\0')).optional(),
  timeoutMs: z.number().int().positive().safe().optional(),
  maxOutputBytes: z.number().int().positive().safe().optional(),
}).strict();

export type SubprocessCommandConfiguration = z.infer<typeof SubprocessCommandConfigurationSchema>;

const SubprocessCommandResponseSchema = z.discriminatedUnion('resultStatus', [
  z.object({
    schemaVersion: z.literal(SUBPROCESS_COMMAND_EXCHANGE_SCHEMA_VERSION),
    resultStatus: z.literal('completed'),
    output: JsonValueSchema.optional(),
    trace: JsonValueSchema.optional(),
    usage: UsageRecordSchema.optional(),
  }).strict(),
  z.object({
    schemaVersion: z.literal(SUBPROCESS_COMMAND_EXCHANGE_SCHEMA_VERSION),
    resultStatus: z.literal('failed'),
    error: z.object({
      code: IdentifierSchema,
      stage: z.enum(['infrastructure', 'execution']),
    }).strict(),
    usage: UsageRecordSchema.optional(),
  }).strict(),
]);

type SubprocessCommandResponse = z.infer<typeof SubprocessCommandResponseSchema>;

export interface SubprocessCommandValueParser<Value> {
  /** Validate and narrow only; transforming the exchanged JSON value fails closed. */
  parse(value: unknown): Value;
}

export interface CreateSubprocessCommandExecutorInput<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> {
  readonly executorId: string;
  readonly version: string;
  readonly command: SubprocessCommandConfiguration;
  readonly schemas: Readonly<{
    input: Readonly<SubprocessCommandValueParser<Input>>;
    config?: Readonly<SubprocessCommandValueParser<Config>>;
    output: Readonly<SubprocessCommandValueParser<Output>>;
    trace?: Readonly<SubprocessCommandValueParser<Trace>>;
  }>;
  readonly outputClassification?: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly traceClassification?: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly outputMediaType?: string;
  readonly traceMediaType?: string;
  /** Determinism, seed control, concurrency and tool policy stay host declarations. */
  readonly capabilities?: ExecutorCapabilities;
  readonly fingerprintFacets?: JsonValue;
}

interface CapturedCommand {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes: number;
}

type ExchangeOutcome =
  | { readonly outcomeKind: 'response'; readonly response: SubprocessCommandResponse; }
  | { readonly outcomeKind: 'failure'; readonly errorCode: string; }
  | { readonly outcomeKind: 'cancelled'; };

function captureParser<Value>(
  parser: Readonly<SubprocessCommandValueParser<Value>> | undefined,
  role: string,
): Readonly<SubprocessCommandValueParser<Value>> | undefined {
  if (parser === undefined) return undefined;
  if (typeof parser.parse !== 'function') {
    throw new TypeError(`Subprocess command Executor requires a ${role} parser.`);
  }
  const parseValue = parser.parse;
  return Object.freeze({
    parse: (value: unknown) => Reflect.apply(parseValue, parser, [value]) as Value,
  });
}

/** Inherits only PATH, so no other host environment value reaches the child by accident. */
function childEnvironment(declared: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const path = process.env.PATH;
  return {
    ...(path === undefined ? {} : { PATH: path }),
    ...declared,
  };
}

function commandIdentityFacet(command: Readonly<CapturedCommand>): string {
  return digestCanonicalJson({
    derivation: 'omk.eval-runtime.subprocess-command-identity/v1',
    executablePath: command.executablePath,
    arguments: command.arguments,
    environmentDigest: digestCanonicalJson(command.environment),
    ...(command.workingDirectory === undefined
      ? {}
      : { workingDirectory: command.workingDirectory }),
    ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    maxOutputBytes: command.maxOutputBytes,
  });
}

/**
 * One child process per attempt. Truncated, over-deadline or cancelled output is never admitted as
 * evidence: the attempt fails closed instead of reporting a partially read document.
 */
function exchangeOnce(
  command: Readonly<CapturedCommand>,
  request: JsonValue,
  signal: AbortSignal,
): Promise<ExchangeOutcome> {
  return new Promise<ExchangeOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command.executablePath, [...command.arguments], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnvironment(command.environment),
        ...(command.workingDirectory === undefined ? {} : { cwd: command.workingDirectory }),
      });
    } catch {
      resolve({ outcomeKind: 'failure', errorCode: 'OMK_SUBPROCESS_COMMAND_SPAWN_FAILED' });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stopReason: 'timeout' | 'abort' | 'output-limit' | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let settled = false;

    function onAbort(): void {
      stop('abort');
    }

    const finish = (outcome: ExchangeOutcome): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    function stop(reason: 'timeout' | 'abort' | 'output-limit'): void {
      if (stopReason !== undefined) return;
      stopReason = reason;
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
      graceTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch { /* already reaped */ }
      }, SIGTERM_GRACE_MS);
      graceTimer.unref();
    }

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    if (command.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => stop('timeout'), command.timeoutMs);
      timeoutTimer.unref();
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > command.maxOutputBytes) {
        stop('output-limit');
        return;
      }
      if (stopReason === undefined) stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      // Child diagnostics stay private: counted against the limit, never surfaced as evidence.
      stderrBytes += chunk.byteLength;
      if (stderrBytes > command.maxOutputBytes) stop('output-limit');
    });
    child.on('error', () => {
      finish({ outcomeKind: 'failure', errorCode: 'OMK_SUBPROCESS_COMMAND_SPAWN_FAILED' });
    });
    child.on('close', (code: number | null) => {
      if (stopReason === 'abort' || signal.aborted) {
        finish({ outcomeKind: 'cancelled' });
        return;
      }
      if (stopReason === 'timeout') {
        finish({ outcomeKind: 'failure', errorCode: 'OMK_SUBPROCESS_COMMAND_TIMEOUT' });
        return;
      }
      if (stopReason === 'output-limit') {
        finish({ outcomeKind: 'failure', errorCode: 'OMK_SUBPROCESS_COMMAND_OUTPUT_LIMIT' });
        return;
      }
      if (code !== 0) {
        finish({ outcomeKind: 'failure', errorCode: 'OMK_SUBPROCESS_COMMAND_NONZERO_EXIT' });
        return;
      }
      let document: unknown;
      try {
        // Decode once: per-chunk decoding turns a multibyte character split across reads into U+FFFD.
        document = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8'));
      } catch {
        finish({ outcomeKind: 'failure', errorCode: 'OMK_SUBPROCESS_COMMAND_RESPONSE_INVALID' });
        return;
      }
      const parsed = SubprocessCommandResponseSchema.safeParse(document);
      if (!parsed.success) {
        finish({ outcomeKind: 'failure', errorCode: 'OMK_SUBPROCESS_COMMAND_RESPONSE_INVALID' });
        return;
      }
      finish({ outcomeKind: 'response', response: parsed.data });
    });

    child.stdin?.on('error', () => {
      // A child that exits before reading stdin is reported through its close status.
    });
    child.stdin?.end(`${canonicalizeJson(request)}\n`);
  });
}

function parseUnchanged<Value extends JsonValue>(
  parser: Readonly<SubprocessCommandValueParser<Value>>,
  value: JsonValue,
  errorCode: string,
): Readonly<{ parsed?: Value; errorCode?: string; }> {
  let parsed: Value;
  try {
    parsed = parser.parse(structuredClone(value));
    if (canonicalizeJson(parsed) !== canonicalizeJson(value)) return { errorCode };
  } catch {
    return { errorCode };
  }
  return { parsed };
}

/**
 * Wraps a per-attempt subprocess into a canonical façade Executor, so a declaration can isolate
 * execution in a child process without hand-written IPC. The child reads one canonical JSON request
 * from stdin and writes one JSON document to stdout.
 */
export function createSubprocessCommandExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
>(
  input: Readonly<CreateSubprocessCommandExecutorInput<Input, Config, Output, Trace>>,
): Executor<Input, Config, Output, Trace> {
  const executorId = IdentifierSchema.parse(input.executorId);
  if (typeof input.version !== 'string' || input.version.trim() === '') {
    throw new TypeError('Subprocess command Executor requires a non-empty version.');
  }
  const declaredCommand = SubprocessCommandConfigurationSchema.parse(
    structuredClone(input.command) as unknown as JsonValue,
  );
  const command: CapturedCommand = Object.freeze({
    executablePath: declaredCommand.executablePath,
    arguments: Object.freeze([...(declaredCommand.arguments ?? [])]),
    environment: Object.freeze({ ...(declaredCommand.environment ?? {}) }),
    ...(declaredCommand.workingDirectory === undefined
      ? {}
      : { workingDirectory: declaredCommand.workingDirectory }),
    ...(declaredCommand.timeoutMs === undefined ? {} : { timeoutMs: declaredCommand.timeoutMs }),
    maxOutputBytes:
      declaredCommand.maxOutputBytes ?? DEFAULT_SUBPROCESS_COMMAND_MAX_OUTPUT_BYTES,
  });
  const declaredCapabilities = input.capabilities === undefined
    ? undefined
    : Object.freeze(structuredClone(input.capabilities));
  if (declaredCapabilities !== undefined
      && (declaredCapabilities.mcp !== undefined
        || declaredCapabilities.mockInterception !== undefined)) {
    throw new TypeError(
      'Subprocess command Executor cannot lease native MCP config or mock interception.',
    );
  }
  const inputParser = captureParser(input.schemas?.input, 'input');
  const configParser = captureParser(input.schemas?.config, 'config');
  const outputParser = captureParser(input.schemas?.output, 'output');
  const traceParser = captureParser(input.schemas?.trace, 'trace');
  if (inputParser === undefined || outputParser === undefined) {
    throw new TypeError('Subprocess command Executor requires input and output parsers.');
  }
  const declaredFacets = input.fingerprintFacets === undefined
    ? {}
    : structuredClone(input.fingerprintFacets);
  if (typeof declaredFacets !== 'object' || declaredFacets === null
      || Array.isArray(declaredFacets)) {
    throw new TypeError('Subprocess command Executor fingerprintFacets must be a JSON object.');
  }
  const version = input.version;

  return Object.freeze({
    executorId,
    version,
    schemas: Object.freeze({
      input: inputParser,
      ...(configParser === undefined ? {} : { config: configParser }),
      output: outputParser,
      ...(traceParser === undefined ? {} : { trace: traceParser }),
    }),
    outputClassification: input.outputClassification ?? 'sensitive',
    ...(input.traceClassification === undefined
      ? {}
      : { traceClassification: input.traceClassification }),
    ...(input.outputMediaType === undefined ? {} : { outputMediaType: input.outputMediaType }),
    ...(input.traceMediaType === undefined ? {} : { traceMediaType: input.traceMediaType }),
    capabilities: Object.freeze({
      determinism: 'unknown',
      cancellation: 'best-effort',
      concurrency: Object.freeze({ safety: 'parallel-safe' }),
      seedControl: 'unsupported',
      telemetry: Object.freeze({
        trace: traceParser === undefined ? 'unsupported' : 'optional',
        usage: 'optional',
      }),
      ...(declaredCapabilities ?? {}),
    }),
    fingerprintFacets: Object.freeze({
      ...(declaredFacets as Record<string, JsonValue>),
      command: commandIdentityFacet(command),
    }),
    async execute(
      invocation: Readonly<ExecutorInvocation<Input, Config>>,
    ): Promise<ExecutorResult<Output, Trace>> {
      const { signal } = invocation;
      if (signal.aborted) throw signal.reason;
      if (invocation.workspace !== undefined
          || invocation.mcpConfig !== undefined
          || invocation.mockInterception !== undefined) {
        return { errorCode: 'OMK_SUBPROCESS_COMMAND_ISOLATION_UNSUPPORTED' };
      }
      const validatedInput = parseUnchanged(
        inputParser,
        invocation.input,
        'EVAL_RUNTIME_EXECUTOR_INPUT_INVALID',
      );
      if (validatedInput.parsed === undefined) {
        return { errorCode: validatedInput.errorCode ?? 'EVAL_RUNTIME_EXECUTOR_INPUT_INVALID' };
      }
      let validatedConfig: JsonValue | undefined;
      if (configParser !== undefined) {
        if (invocation.config === undefined) {
          return { errorCode: 'EVAL_RUNTIME_EXECUTOR_TARGET_CONFIG_INVALID' };
        }
        const parsedConfig = parseUnchanged(
          configParser as Readonly<SubprocessCommandValueParser<Exclude<Config, undefined>>>,
          invocation.config,
          'EVAL_RUNTIME_EXECUTOR_TARGET_CONFIG_INVALID',
        );
        if (parsedConfig.parsed === undefined) {
          return {
            errorCode:
              parsedConfig.errorCode ?? 'EVAL_RUNTIME_EXECUTOR_TARGET_CONFIG_INVALID',
          };
        }
        validatedConfig = parsedConfig.parsed;
      }
      const request: JsonValue = {
        schemaVersion: SUBPROCESS_COMMAND_EXCHANGE_SCHEMA_VERSION,
        executor: { executorId, version },
        artifact: structuredClone(invocation.artifact) as unknown as JsonValue,
        trial: {
          sampleId: invocation.sampleId,
          variantId: invocation.variantId,
          trialIndex: invocation.trialIndex,
          ...(invocation.trialSeed === undefined ? {} : { trialSeed: invocation.trialSeed }),
          input: validatedInput.parsed,
          ...(validatedConfig === undefined ? {} : { config: validatedConfig }),
          ...(invocation.executionContext === undefined
            ? {}
            : { executionContext: structuredClone(invocation.executionContext) }),
          ...(invocation.allowedTools === undefined
            ? {}
            : { allowedTools: [...invocation.allowedTools] }),
        },
        attempt: { attemptNumber: invocation.attemptNumber },
      };

      const exchange = await exchangeOnce(command, request, signal);
      if (exchange.outcomeKind === 'cancelled' || signal.aborted) throw signal.reason;
      if (exchange.outcomeKind === 'failure') return { errorCode: exchange.errorCode };
      const { response } = exchange;
      const usage = response.usage;
      if (response.resultStatus === 'failed') {
        return {
          errorCode: response.error.code,
          ...(usage === undefined ? {} : { usage }),
        };
      }
      if (response.output === undefined) {
        return {
          errorCode: 'OMK_SUBPROCESS_COMMAND_OUTPUT_INVALID',
          ...(usage === undefined ? {} : { usage }),
        };
      }
      const output = parseUnchanged(outputParser, response.output, 'OMK_SUBPROCESS_COMMAND_OUTPUT_INVALID');
      if (output.parsed === undefined) {
        return {
          errorCode: output.errorCode ?? 'OMK_SUBPROCESS_COMMAND_OUTPUT_INVALID',
          ...(usage === undefined ? {} : { usage }),
        };
      }
      let trace: Trace | undefined;
      if (response.trace !== undefined) {
        if (traceParser === undefined) {
          return {
            errorCode: 'OMK_SUBPROCESS_COMMAND_TRACE_INVALID',
            ...(usage === undefined ? {} : { usage }),
          };
        }
        const parsedTrace = parseUnchanged(
          traceParser,
          response.trace,
          'OMK_SUBPROCESS_COMMAND_TRACE_INVALID',
        );
        if (parsedTrace.parsed === undefined) {
          return {
            errorCode: parsedTrace.errorCode ?? 'OMK_SUBPROCESS_COMMAND_TRACE_INVALID',
            ...(usage === undefined ? {} : { usage }),
          };
        }
        trace = parsedTrace.parsed;
      }
      return {
        output: output.parsed,
        ...(trace === undefined ? {} : { trace }),
        ...(usage === undefined ? {} : { usage }),
      };
    },
  });
}
