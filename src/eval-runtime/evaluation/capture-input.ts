import {
  type JsonValue,
  type RuntimeIdentity,
  JsonValueSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  IdentifierSchema,
  EvaluationDatasetSchema,
} from '../../eval-core/contracts/index.js';
import {
  type EvaluationExecutor,
  type Artifact,
  type RuntimeContext,
  type InvokeExecutor,
  type SessionExecutor,
  type ExecutorResult,
  type ExecutorSession,
  type ExecutorSessionAttempt,
  type Dataset,
  type Variant,
} from './contracts.js';
import {
  type RuntimeValueParser,
  createJsonExecutorAdapter,
  createJsonSessionExecutorAdapter,
  assertFreshExecutorSessionObject,
} from '../adapters/json-executor.js';
import {
  type CapturedWorkspaceProvider,
  captureWorkspaceProvider,
  type CapturedWorkspacePlan,
  captureWorkspacePlan,
} from '../workspace.js';
import {
  type CapturedMcpConfigProvider,
  captureMcpConfigProvider,
  type CapturedMcpConfigPlan,
  captureMcpConfigPlan,
} from '../mcp-config.js';
import {
  type CapturedMockInterceptionProvider,
  captureMockInterceptionProvider,
  type CapturedMockInterceptionPlan,
  captureMockInterceptionPlan,
} from '../mock-interception.js';
import {
  EvaluationConfigurationError,
  configurationFailure,
} from './errors.js';
import {
  ArtifactSchema,
  RuntimeContextSchema,
  VariantConfigEnvelopeSchema,
  VARIANT_CONFIG_SCHEMA_VERSION,
} from './schemas.js';
import {
  createSessionExecutorIdentity,
  createInvokeExecutorIdentity,
} from '../identity.js';
import {
  type CapturedAllowedToolsPlan,
  captureAllowedToolsPlan,
} from '../tool-policy.js';

interface CapturedExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue,
> {
  readonly declaration: EvaluationExecutor<Input, Config, Output, Trace>;
  readonly identity: RuntimeIdentity;
  readonly protocolId: 'omk.invoke/v1' | 'omk.session/v1';
  readonly inputParser: RuntimeValueParser<Input>;
  readonly configParser: RuntimeValueParser<Config>;
  readonly outputParser: RuntimeValueParser<Output>;
  readonly workspaceProvider?: CapturedWorkspaceProvider;
  readonly mcpConfigProvider?: CapturedMcpConfigProvider;
  readonly mockInterceptionProvider?: CapturedMockInterceptionProvider;
  readonly supportsToolAllowList: boolean;
  readonly createPort: (
    targetId: string,
    identity?: RuntimeIdentity,
  ) => ReturnType<typeof createJsonExecutorAdapter<Input, JsonValue, Output, Trace>>;
}

function captureParser<Value>(
  parser: Readonly<RuntimeValueParser<Value>> | undefined,
  code: EvaluationConfigurationError['code'],
): RuntimeValueParser<Value> | undefined {
  if (parser === undefined) return undefined;
  if (typeof parser.parse !== 'function') {
    return configurationFailure(code, 'Evaluation schema 缺少可调用的 parse 方法。');
  }
  const parse = parser.parse;
  return Object.freeze({
    parse: (value: unknown) => Reflect.apply(parse, parser, [value]) as Value,
  });
}

export function parseWithoutTransform<Value extends JsonValue>(
  parser: Readonly<RuntimeValueParser<Value>>,
  value: unknown,
  code: EvaluationConfigurationError['code'],
  message: string,
): Value {
  try {
    const wire = JsonValueSchema.parse(structuredClone(value));
    const parsed = parser.parse(structuredClone(wire));
    const parsedWire = JsonValueSchema.parse(parsed);
    if (canonicalizeJson(wire) !== canonicalizeJson(parsedWire)) {
      return configurationFailure(code, message);
    }
    return parsed;
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(code, message);
  }
}

function parseOptionalWithoutTransform<Value extends JsonValue | undefined>(
  parser: Readonly<RuntimeValueParser<Value>>,
  value: unknown,
  code: EvaluationConfigurationError['code'],
  message: string,
): Value {
  if (value !== undefined) {
    return parseWithoutTransform(
      parser as RuntimeValueParser<Exclude<Value, undefined>>,
      value,
      code,
      message,
    ) as Value;
  }
  try {
    const parsed = parser.parse(undefined);
    if (parsed !== undefined) return configurationFailure(code, message);
    return parsed;
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(code, message);
  }
}

function captureArtifact(value: Readonly<Artifact>): Artifact {
  try {
    const parsed = ArtifactSchema.parse(structuredClone(value));
    return deepFreezeCanonicalJson(parsed) as Artifact;
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant 包含无效 artifact。',
    );
  }
}

function captureRuntimeContext(
  value: Readonly<RuntimeContext> | undefined,
): RuntimeContext | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = RuntimeContextSchema.parse(structuredClone(value));
    return deepFreezeCanonicalJson(parsed) as RuntimeContext;
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant 包含无效 runtime context。',
    );
  }
}

function undefinedConfigParser<Config extends JsonValue | undefined>(): RuntimeValueParser<Config> {
  return Object.freeze({
    parse(value: unknown): Config {
      if (value !== undefined) throw new TypeError('Executor config schema is required.');
      return undefined as Config;
    },
  });
}

function captureExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue,
>(
  value: Readonly<EvaluationExecutor<Input, Config, Output, Trace>>,
): CapturedExecutor<Input, Config, Output, Trace> {
  const executorId = IdentifierSchema.safeParse(value?.executorId);
  const protocol = value?.protocol ?? 'invoke';
  if (!executorId.success
      || typeof value?.version !== 'string'
      || value.version.length === 0
      || (protocol !== 'invoke' && protocol !== 'session')
      || (protocol === 'invoke'
        ? typeof (value as InvokeExecutor<Input, Config, Output, Trace>)?.execute !== 'function'
        : typeof (value as SessionExecutor<Input, Config, Output, Trace>)?.openSession
          !== 'function')) {
    return configurationFailure(
      'EVAL_RUNTIME_EXECUTOR_INVALID',
      'Evaluation executor declaration 无效。',
    );
  }
  const inputParser = captureParser(
    value.schemas?.input,
    'EVAL_RUNTIME_EXECUTOR_INVALID',
  );
  const configParser = captureParser(
    value.schemas?.config,
    'EVAL_RUNTIME_EXECUTOR_INVALID',
  ) ?? undefinedConfigParser<Config>();
  const outputParser = captureParser(
    value.schemas?.output,
    'EVAL_RUNTIME_EXECUTOR_INVALID',
  );
  const traceParser = captureParser(
    value.schemas?.trace,
    'EVAL_RUNTIME_EXECUTOR_INVALID',
  );
  if (inputParser === undefined || outputParser === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_EXECUTOR_INVALID',
      'Evaluation executor 必须声明 input 与 output schema。',
    );
  }
  let workspaceProvider: CapturedWorkspaceProvider | undefined;
  try {
    workspaceProvider = captureWorkspaceProvider(value.workspaceProvider);
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_EXECUTOR_INVALID',
      'Evaluation executor workspaceProvider declaration 无效。',
    );
  }
  let mcpConfigProvider: CapturedMcpConfigProvider | undefined;
  try {
    mcpConfigProvider = captureMcpConfigProvider(value.mcpConfigProvider);
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_EXECUTOR_INVALID',
      'Evaluation executor mcpConfigProvider declaration 无效。',
    );
  }
  let mockInterceptionProvider: CapturedMockInterceptionProvider | undefined;
  try {
    mockInterceptionProvider = captureMockInterceptionProvider(
      value.mockInterceptionProvider,
    );
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_EXECUTOR_INVALID',
      'Evaluation executor mockInterceptionProvider declaration 无效。',
    );
  }
  const capabilities = value.capabilities ?? {};
  if ((capabilities.mcp !== undefined && capabilities.mcp !== 'native-config')
      || (capabilities.mcp === 'native-config') !== (mcpConfigProvider !== undefined)) {
    return configurationFailure(
      'EVAL_RUNTIME_EXECUTOR_INVALID',
      'Evaluation executor native-config capability 与 mcpConfigProvider 必须成对声明。',
    );
  }
  if ((capabilities.mockInterception !== undefined
        && capabilities.mockInterception !== 'pre-tool-call')
      || (capabilities.mockInterception === 'pre-tool-call')
        !== (mockInterceptionProvider !== undefined)) {
    return configurationFailure(
      'EVAL_RUNTIME_EXECUTOR_INVALID',
      'Evaluation executor pre-tool-call capability 与 mockInterceptionProvider 必须成对声明。',
    );
  }
  const telemetry = capabilities.telemetry ?? {};
  const outputClassification = value.outputClassification ?? 'sensitive';
  const traceClassification = value.traceClassification ?? outputClassification;
  const identity = (() => {
    try {
      const createIdentity = protocol === 'session'
        ? createSessionExecutorIdentity
        : createInvokeExecutorIdentity;
      return createIdentity({
        implementationId: executorId.data,
        version: value.version,
        determinism: capabilities.determinism ?? 'unknown',
        cancellation: capabilities.cancellation ?? 'best-effort',
        concurrency: capabilities.concurrency ?? { safety: 'serialized' },
        seedControl: capabilities.seedControl ?? 'unsupported',
        ...(capabilities.toolPolicy === undefined
          ? {}
          : { toolPolicy: capabilities.toolPolicy }),
        ...(workspaceProvider === undefined
          ? {}
          : { workspace: 'copy-on-write-overlay' as const }),
        ...(capabilities.mcp === undefined ? {} : { mcp: capabilities.mcp }),
        ...(capabilities.mockInterception === undefined
          ? {}
          : { mockInterception: capabilities.mockInterception }),
        telemetry: {
          trace: telemetry.trace ?? (traceParser === undefined ? 'unsupported' : 'optional'),
          usage: telemetry.usage ?? 'optional',
          providerCost: telemetry.providerCost ?? { reporting: 'optional' },
        },
        fingerprintFacets: {
          facade: {
            version: mockInterceptionProvider !== undefined
              ? 'omk.eval-runtime.evaluate/v7'
              : mcpConfigProvider === undefined
              ? capabilities.toolPolicy === 'allow-list'
                ? 'omk.eval-runtime.evaluate/v5'
                : workspaceProvider === undefined
                  ? 'omk.eval-runtime.evaluate/v3'
                  : 'omk.eval-runtime.evaluate/v4'
              : 'omk.eval-runtime.evaluate/v6',
            outputClassification,
            traceClassification,
            ...(value.outputMediaType === undefined
              ? {}
              : { outputMediaType: value.outputMediaType }),
            ...(value.traceMediaType === undefined
              ? {}
              : { traceMediaType: value.traceMediaType }),
          },
          ...(value.fingerprintFacets === undefined
            ? {}
            : { host: structuredClone(value.fingerprintFacets) }),
        },
      });
    } catch {
      return configurationFailure(
        'EVAL_RUNTIME_EXECUTOR_INVALID',
        'Evaluation executor capabilities declaration 无效。',
      );
    }
  })();
  if (!['public', 'sensitive', 'secret', 'gold'].includes(outputClassification)
      || (value.traceClassification !== undefined
        && !['public', 'sensitive', 'secret', 'gold'].includes(value.traceClassification))) {
    return configurationFailure(
      'EVAL_RUNTIME_EXECUTOR_INVALID',
      'Evaluation executor classification declaration 无效。',
    );
  }
  const commonDeclaration = {
    executorId: executorId.data,
    version: value.version,
    schemas: Object.freeze({
      input: inputParser,
      ...(value.schemas.config === undefined ? {} : { config: configParser }),
      output: outputParser,
      ...(traceParser === undefined ? {} : { trace: traceParser }),
    }),
    outputClassification,
    ...(value.traceClassification === undefined
      ? {}
      : { traceClassification: value.traceClassification }),
    ...(value.outputMediaType === undefined ? {} : { outputMediaType: value.outputMediaType }),
    ...(value.traceMediaType === undefined ? {} : { traceMediaType: value.traceMediaType }),
    ...(value.capabilities === undefined ? {} : {
      capabilities: deepFreezeCanonicalJson(structuredClone(value.capabilities)),
    }),
    ...(workspaceProvider === undefined ? {} : { workspaceProvider }),
    ...(mcpConfigProvider === undefined ? {} : { mcpConfigProvider }),
    ...(mockInterceptionProvider === undefined ? {} : { mockInterceptionProvider }),
    ...(value.fingerprintFacets === undefined ? {} : {
      fingerprintFacets: deepFreezeCanonicalJson(structuredClone(value.fingerprintFacets)),
    }),
  };
  const declaration: EvaluationExecutor<Input, Config, Output, Trace> = protocol === 'session'
    ? Object.freeze({
      ...commonDeclaration,
      protocol: 'session' as const,
      openSession: (value as SessionExecutor<Input, Config, Output, Trace>).openSession,
    })
    : Object.freeze({
      ...commonDeclaration,
      ...(value.protocol === 'invoke' ? { protocol: 'invoke' as const } : {}),
      execute: (value as InvokeExecutor<Input, Config, Output, Trace>).execute,
    });

  function adaptResult(result: ExecutorResult<Output, Trace>) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      return result as never;
    }
    if ('errorCode' in result) {
      return {
        invocationStatus: 'failed' as const,
        errorCode: result.errorCode as string,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    }
    return {
      invocationStatus: 'completed' as const,
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(result.trace === undefined ? {} : { trace: result.trace }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }

  const adapterInput = {
    inputParser,
    targetConfigParser: {
      parse(raw: unknown): JsonValue {
        const envelope = VariantConfigEnvelopeSchema.parse(raw);
        return deepFreezeCanonicalJson({
          schemaVersion: VARIANT_CONFIG_SCHEMA_VERSION,
          artifact: envelope.artifact,
          ...(envelope.runtimeContext === undefined
            ? {}
            : { runtimeContext: envelope.runtimeContext }),
          ...(envelope.executorConfig === undefined
            ? {}
            : { executorConfig: envelope.executorConfig }),
        });
      },
    },
    outputParser,
    ...(traceParser === undefined ? {} : { traceParser }),
    outputClassification,
    ...(value.traceClassification === undefined
      ? {}
      : { traceClassification: value.traceClassification }),
    ...(value.outputMediaType === undefined ? {} : { outputMediaType: value.outputMediaType }),
    ...(value.traceMediaType === undefined ? {} : { traceMediaType: value.traceMediaType }),
    ...(workspaceProvider === undefined ? {} : { workspaceProvider }),
    ...(mcpConfigProvider === undefined ? {} : { mcpConfigProvider }),
    ...(mockInterceptionProvider === undefined ? {} : { mockInterceptionProvider }),
  };
  const createPort = (targetId: string, runtimeIdentity = identity) => protocol === 'session'
    ? createJsonSessionExecutorAdapter({
      ...adapterInput,
      identity: runtimeIdentity,
      async openSession(sessionContext) {
        const targetConfig = VariantConfigEnvelopeSchema.parse(sessionContext.targetConfig);
        const host = declaration as SessionExecutor<Input, Config, Output, Trace>;
        const session = await Reflect.apply(host.openSession, host, [{
          runId: sessionContext.runId,
          trialId: sessionContext.trialId,
          input: sessionContext.input,
          artifact: targetConfig.artifact,
          ...(targetConfig.runtimeContext === undefined
            ? {}
            : { runtimeContext: targetConfig.runtimeContext }),
          config: targetConfig.executorConfig as Config,
          ...(sessionContext.executionContext === undefined
            ? {}
            : { executionContext: sessionContext.executionContext }),
          sampleId: sessionContext.sampleId,
          variantId: targetId,
          trialIndex: sessionContext.trialIndex,
          ...(sessionContext.trialSeed === undefined
            ? {}
            : { trialSeed: sessionContext.trialSeed }),
          ...(sessionContext.workspace === undefined
            ? {}
            : { workspace: sessionContext.workspace }),
          ...(sessionContext.mcpConfig === undefined
            ? {}
            : { mcpConfig: sessionContext.mcpConfig }),
          ...(sessionContext.allowedTools === undefined
            ? {}
            : { allowedTools: sessionContext.allowedTools }),
        }]) as ExecutorSession<Output, Trace>;
        if (session === null || typeof session !== 'object'
            || typeof session.execute !== 'function'
            || typeof session.close !== 'function') {
          throw new TypeError('Session Executor returned an invalid session lifecycle.');
        }
        assertFreshExecutorSessionObject(session);
        const executeSession = session.execute;
        const closeSession = session.close;
        return Object.freeze({
          execute: async (attempt: Readonly<ExecutorSessionAttempt>) => adaptResult(
            await Reflect.apply(
              executeSession,
              session,
              [attempt],
            ) as ExecutorResult<Output, Trace>,
          ),
          close: () => Reflect.apply(closeSession, session, []) as void | Promise<void>,
        });
      },
    })
    : createJsonExecutorAdapter({
      ...adapterInput,
      identity: runtimeIdentity,
      async invoke(invocation) {
        const targetConfig = VariantConfigEnvelopeSchema.parse(invocation.targetConfig);
        const host = declaration as InvokeExecutor<Input, Config, Output, Trace>;
        const result = await Reflect.apply(host.execute, host, [{
          input: invocation.input,
          artifact: targetConfig.artifact,
          ...(targetConfig.runtimeContext === undefined
            ? {}
            : { runtimeContext: targetConfig.runtimeContext }),
          config: targetConfig.executorConfig as Config,
          ...(invocation.executionContext === undefined
            ? {}
            : { executionContext: invocation.executionContext }),
          sampleId: invocation.sampleId,
          variantId: targetId,
          trialIndex: invocation.trialIndex,
          ...(invocation.trialSeed === undefined ? {} : { trialSeed: invocation.trialSeed }),
          attemptNumber: invocation.attemptNumber,
          signal: invocation.signal,
          ...(invocation.workspace === undefined
            ? {}
            : { workspace: invocation.workspace }),
          ...(invocation.mcpConfig === undefined
            ? {}
            : { mcpConfig: invocation.mcpConfig }),
          ...(invocation.mockInterception === undefined
            ? {}
            : { mockInterception: invocation.mockInterception }),
          ...(invocation.allowedTools === undefined
            ? {}
            : { allowedTools: invocation.allowedTools }),
        }]) as ExecutorResult<Output, Trace>;
        return adaptResult(result);
      },
    });

  return Object.freeze({
    declaration,
    identity,
    protocolId: protocol === 'session' ? 'omk.session/v1' : 'omk.invoke/v1',
    inputParser,
    configParser,
    outputParser,
    ...(workspaceProvider === undefined ? {} : { workspaceProvider }),
    ...(mcpConfigProvider === undefined ? {} : { mcpConfigProvider }),
    ...(mockInterceptionProvider === undefined ? {} : { mockInterceptionProvider }),
    supportsToolAllowList: capabilities.toolPolicy === 'allow-list',
    createPort,
  });
}

export function captureDataset(value: Readonly<Dataset>): Dataset {
  try {
    const parsed = EvaluationDatasetSchema.parse(structuredClone(value));
    return deepFreezeCanonicalJson(parsed);
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation dataset 无效。',
    );
  }
}

export interface CapturedVariant {
  variantId: string;
  artifact: Artifact;
  runtimeContext?: RuntimeContext;
  config?: JsonValue;
  envelope: JsonValue;
  workspace?: CapturedWorkspacePlan;
  allowedTools?: CapturedAllowedToolsPlan;
  mcpConfig?: CapturedMcpConfigPlan;
  mockInterception?: CapturedMockInterceptionPlan;
  runtimeIdentity: RuntimeIdentity;
  executor: CapturedExecutor<JsonValue, JsonValue | undefined, JsonValue, JsonValue>;
}

export function captureVariant(
  value: Readonly<Variant>,
  sampleIds: ReadonlySet<string>,
): Readonly<CapturedVariant> {
  const variantId = IdentifierSchema.safeParse(value?.variantId);
  if (!variantId.success || value.execution === null || typeof value.execution !== 'object') {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variantId 或 execution binding 无效。',
    );
  }
  const executor = captureExecutor(value.execution.executor);
  const artifact = captureArtifact(value.artifact);
  const runtimeContext = captureRuntimeContext(value.execution.runtimeContext);
  let workspace: CapturedWorkspacePlan | undefined;
  try {
    workspace = captureWorkspacePlan(value.execution.workspace, sampleIds);
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant workspace selection 无效。',
    );
  }
  let allowedTools: CapturedAllowedToolsPlan | undefined;
  try {
    allowedTools = captureAllowedToolsPlan(value.execution.allowedTools, sampleIds);
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant allowedTools selection 无效。',
    );
  }
  let mcpConfig: CapturedMcpConfigPlan | undefined;
  try {
    mcpConfig = captureMcpConfigPlan(value.execution.mcpConfig, sampleIds);
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant mcpConfig selection 无效。',
    );
  }
  let mockInterception: CapturedMockInterceptionPlan | undefined;
  try {
    mockInterception = captureMockInterceptionPlan(
      value.execution.mockInterception,
      sampleIds,
    );
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant mockInterception selection 无效。',
    );
  }
  if (workspace !== undefined && executor.workspaceProvider === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant workspace requires an Executor workspaceProvider。',
    );
  }
  if (allowedTools !== undefined && !executor.supportsToolAllowList) {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant allowedTools requires an Executor allow-list toolPolicy capability。',
    );
  }
  if (mcpConfig !== undefined && executor.mcpConfigProvider === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant mcpConfig requires an Executor mcpConfigProvider。',
    );
  }
  if (mockInterception !== undefined && executor.mockInterceptionProvider === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variant mockInterception requires an Executor mockInterceptionProvider。',
    );
  }
  const config = parseOptionalWithoutTransform(
    executor.configParser,
    value.execution.config,
    'EVAL_RUNTIME_VARIANT_INVALID',
    'Evaluation variant config 不符合 Executor schema，或 schema 改变了值。',
  );
  const envelope = deepFreezeCanonicalJson(VariantConfigEnvelopeSchema.parse({
    schemaVersion: VARIANT_CONFIG_SCHEMA_VERSION,
    artifact,
    ...(runtimeContext === undefined ? {} : { runtimeContext }),
    ...(config === undefined ? {} : { executorConfig: config }),
  }));
  return Object.freeze({
    variantId: variantId.data,
    artifact,
    ...(runtimeContext === undefined ? {} : { runtimeContext }),
    ...(config === undefined ? {} : { config }),
    envelope,
    ...(workspace === undefined ? {} : { workspace }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(mcpConfig === undefined ? {} : { mcpConfig }),
    ...(mockInterception === undefined ? {} : { mockInterception }),
    runtimeIdentity: executor.identity,
    executor,
  });
}
