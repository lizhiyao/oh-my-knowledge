import { z } from 'zod';
import {
  IdentifierSchema,
  EvaluationDatasetSchema,
  JsonValueSchema,
  deepFreezeCanonicalJson,
  canonicalizeJson,
  type EvaluationDefinition,
  type EvaluationSample,
  type JsonValue,
  type MeasurementPolicy,
  type UsageRecord,
} from '../eval-core/contracts/index.js';
import type {
  EvaluationEngineClock,
  EvaluationRunResult,
} from '../eval-core/engine/index.js';
import { createJsonExecutorAdapter, type RuntimeValueParser } from './adapters/json-executor.js';
import { createExactMatchDefinition } from './builders/exact-match.js';
import { createPairedComparisonDefinition } from './builders/paired-comparison.js';
import {
  createMeasurementPolicy,
  type MeasurementPolicyBuilderInput,
} from './builders/policy.js';
import { createExactMatchEvaluator } from './evaluators/exact-match.js';
import { createInvokeExecutorIdentity, createRuntimeIdentity } from './identity.js';
import type {
  OmkLlmJudgeEffort,
  OmkLlmJudgeInvocationRequest,
  OmkLlmJudgeInvocationResult,
} from './judges/invocation.js';
import { createRubricJudgeKit } from './judges/rubric-kit.js';
import type {
  RubricJudgeCriterion,
  RubricJudgeTracePolicy,
} from './judges/rubric-contracts.js';
import {
  EvaluationEventConsumptionError as AdvancedEvaluationEventConsumptionError,
  runEvaluation,
  type EvaluationEventObserver,
} from './runner.js';
import { createEvaluationRuntime } from './runtime.js';
import {
  runExecutorConformance,
  type ExecutorConformanceResult,
  type RuntimeConformanceCheck,
} from './conformance/executor.js';

const ARTIFACT_KINDS = ['baseline', 'skill', 'prompt', 'agent', 'workflow'] as const;
const ARTIFACT_SOURCES = [
  'baseline',
  'variant-name',
  'file-path',
  'git',
  'inline',
  'custom',
] as const;
const VARIANT_CONFIG_SCHEMA_VERSION = 'omk.eval-runtime.variant-config/v2' as const;

const ArtifactSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(ARTIFACT_KINDS),
  source: z.enum(ARTIFACT_SOURCES),
  content: z.string().nullable(),
  contentHash: z.string().min(1).optional(),
  locator: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  resolvedCommit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  metadata: JsonValueSchema.optional(),
}).strict().superRefine((artifact, context) => {
  if (artifact.kind === 'baseline' && (artifact.source !== 'baseline' || artifact.content !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'baseline artifact must use baseline source and null content.',
    });
  }
  if (artifact.kind !== 'baseline' && artifact.source === 'baseline') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only a baseline artifact may use baseline source.',
    });
  }
});

const RuntimeContextSchema = z.object({
  values: JsonValueSchema.optional(),
}).strict();

const ExperimentSchema = z.object({
  seed: z.string().min(1),
  trials: z.number().int().positive().optional(),
  bootstrap: z.object({
    resamples: z.number().int().positive().optional(),
    alpha: z.number().gt(0).lt(1).optional(),
  }).strict().optional(),
  decision: z.object({
    threshold: z.number().optional(),
    equivalence: z.number().nonnegative().optional(),
    minimumEvidenceStatus: z.enum(['complete', 'partial', 'unresolvable']).optional(),
  }).strict().optional(),
}).strict();

const PolicyInputSchema = z.object({
  maxConcurrency: z.number().int().positive().optional(),
  executionTimeoutMs: z.number().nonnegative().optional(),
  evaluationTimeoutMs: z.number().nonnegative().optional(),
  maxInvocations: z.number().int().positive().optional(),
  failureMode: z.enum(['continue', 'fail-fast']).optional(),
  maximumClassification: z.enum(['public', 'sensitive', 'secret', 'gold']).optional(),
}).strict();

const VariantConfigEnvelopeSchema = z.object({
  schemaVersion: z.literal(VARIANT_CONFIG_SCHEMA_VERSION),
  artifact: ArtifactSchema,
  runtimeContext: RuntimeContextSchema.optional(),
  executorConfig: JsonValueSchema.optional(),
}).strict();

export type ArtifactKind = typeof ARTIFACT_KINDS[number];
export type ArtifactSource = typeof ARTIFACT_SOURCES[number];

export interface Artifact {
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly source: ArtifactSource;
  readonly content: string | null;
  readonly contentHash?: string;
  readonly locator?: string;
  readonly ref?: string;
  readonly resolvedCommit?: string;
  readonly metadata?: JsonValue;
}

export interface RuntimeContext {
  readonly values?: JsonValue;
}

export interface Variant<Config extends JsonValue | undefined = JsonValue | undefined> {
  readonly variantId: string;
  readonly artifact: Artifact;
  readonly runtimeContext?: RuntimeContext;
  readonly config?: Config;
}

export interface Dataset {
  readonly datasetId: string;
  readonly samples: readonly EvaluationSample[];
}

export interface ExecutorCapabilities {
  readonly determinism?: 'deterministic' | 'stochastic' | 'unknown';
  readonly cancellation?: 'cooperative' | 'best-effort' | 'unsupported';
  readonly concurrency?: Readonly<{
    safety: 'serialized' | 'parallel-safe';
    maxInFlight?: number;
  }>;
  readonly seedControl?: 'unsupported' | 'optional' | 'required';
  readonly telemetry?: Readonly<{
    trace?: 'unsupported' | 'optional' | 'required';
    usage?: 'unsupported' | 'optional' | 'required';
    providerCost?: Readonly<{
      reporting: 'unsupported' | 'optional' | 'required';
      trustedUpperBound?: Readonly<{ amount: number; currency: string }>;
    }>;
  }>;
}

export interface ExecutorInvocation<
  Input,
  Config extends JsonValue | undefined,
> {
  readonly input: Input;
  readonly artifact: Artifact;
  readonly runtimeContext?: RuntimeContext;
  readonly config: Config;
  readonly executionContext?: JsonValue;
  readonly sampleId: string;
  readonly variantId: string;
  readonly experimentRole: 'control' | 'treatment';
  readonly trialIndex: number;
  readonly trialSeed?: string;
  readonly attemptNumber: number;
  readonly signal: AbortSignal;
}

export type ExecutorResult<Output extends JsonValue, Trace extends JsonValue = JsonValue> =
  | {
      readonly output?: Output;
      readonly trace?: Trace;
      readonly usage?: UsageRecord;
      readonly errorCode?: never;
    }
  | {
      /** Stable, non-sensitive failure category. */
      readonly errorCode: string;
      readonly usage?: UsageRecord;
      readonly output?: never;
      readonly trace?: never;
    };

export interface Executor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> {
  readonly executorId: string;
  readonly version: string;
  readonly schemas: Readonly<{
    input: RuntimeValueParser<Input>;
    config?: RuntimeValueParser<Config>;
    output: RuntimeValueParser<Output>;
    trace?: RuntimeValueParser<Trace>;
  }>;
  /** Defaults to `sensitive`; declare `public` only when outputs are safe to disclose. */
  readonly outputClassification?: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly traceClassification?: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly outputMediaType?: string;
  readonly traceMediaType?: string;
  readonly capabilities?: ExecutorCapabilities;
  /** Host-declared deployment or implementation facets beyond executorId and version. */
  readonly fingerprintFacets?: JsonValue;
  execute(
    invocation: Readonly<ExecutorInvocation<Input, Config>>,
  ): Promise<ExecutorResult<Output, Trace>>;
}

export interface ExactMatchEvaluator {
  readonly evaluatorKind: 'exact-match';
  readonly metricId?: string;
}

export interface Judge {
  readonly judgeId: string;
  readonly version: string;
  readonly providerCost: Readonly<{
    reporting: 'unsupported' | 'optional' | 'required';
    trustedUpperBound?: Readonly<{ amount: number; currency: string }>;
  }>;
  readonly fingerprintFacets?: JsonValue;
  invoke(
    request: Readonly<OmkLlmJudgeInvocationRequest>,
  ): Promise<OmkLlmJudgeInvocationResult>;
}

export interface Rubric {
  readonly criterionId: string;
  readonly prompt: string;
  readonly rubric: string;
}

export interface RubricJudgeEvaluator {
  readonly evaluatorKind: 'rubric-judge';
  readonly evaluatorId: string;
  readonly metricId: string;
  readonly model: string;
  readonly judge: Judge;
  readonly rubric: Rubric;
  readonly effort?: OmkLlmJudgeEffort;
  readonly lengthDebias?: boolean;
  readonly tracePolicy?: RubricJudgeTracePolicy;
  readonly actualPointer?: string;
  readonly tracePointer?: string;
  readonly classification?: 'public' | 'sensitive';
}

export type Evaluator = ExactMatchEvaluator | RubricJudgeEvaluator;

export interface Experiment {
  /** Required measurement seed; never sourced from time, environment, or randomness. */
  readonly seed: string;
  readonly trials?: number;
  readonly bootstrap?: Readonly<{ resamples?: number; alpha?: number }>;
  readonly decision?: Readonly<{
    threshold?: number;
    equivalence?: number;
    minimumEvidenceStatus?: 'complete' | 'partial' | 'unresolvable';
  }>;
}

export type Policy = Omit<MeasurementPolicyBuilderInput, 'eventDelivery'>;
export type Sample = EvaluationSample;
/** Core run result plus the exact sealed Definition compiled by the façade. */
export type EvaluationResult = EvaluationRunResult & Readonly<{
  definition: EvaluationDefinition;
  policy: MeasurementPolicy;
}>;
export type EventObserver = EvaluationEventObserver;
export type Clock = EvaluationEngineClock;

/** Stable, redacted event-consumption failure from the canonical facade. */
export class EvaluationEventConsumptionError extends Error {
  readonly code:
    | 'EVAL_RUNTIME_EVENT_OBSERVER_FAILED'
    | 'EVAL_RUNTIME_EVENT_STREAM_FAILED';
  readonly runResult?: EvaluationResult;

  constructor(input: Readonly<{
    code: EvaluationEventConsumptionError['code'];
    message: string;
    runResult?: EvaluationResult;
  }>) {
    super(input.message);
    this.name = 'EvaluationEventConsumptionError';
    this.code = input.code;
    this.runResult = input.runResult;
  }
}

export interface EvaluateInput<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> {
  readonly executor: Executor<Input, Config, Output, Trace>;
  readonly dataset: Dataset;
  readonly control: Variant<Config>;
  readonly treatment: Variant<Config>;
  readonly evaluator: Evaluator;
  readonly experiment: Experiment;
  readonly policy: Policy;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly annotations?: JsonValue;
  readonly summaries?: JsonValue;
  readonly eventBufferCapacity?: number;
  readonly onEvent?: EventObserver;
  readonly clock?: Clock;
}

export interface ExecutorCheckInput<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
> {
  readonly executor: Executor<Input, Config, Output, Trace>;
  readonly variant: Variant<Config>;
  readonly success: Readonly<{ input: Input; expected: Output }>;
  /** Input that must make the Executor return this stable, non-sensitive error code. */
  readonly failure: Readonly<{ input: Input; expectedErrorCode: string }>;
  /** Input that must keep running until the supplied AbortSignal is cancelled. */
  readonly cancellation: Readonly<{ input: Input }>;
  readonly seed?: string;
  readonly runId?: string;
}

export type ExecutorCheckResult = ExecutorConformanceResult;
export type { RuntimeConformanceCheck };

export class EvaluationConfigurationError extends TypeError {
  readonly code:
    | 'EVAL_RUNTIME_INPUT_INVALID'
    | 'EVAL_RUNTIME_EXECUTOR_INVALID'
    | 'EVAL_RUNTIME_VARIANT_INVALID'
    | 'EVAL_RUNTIME_EVALUATOR_INVALID';

  constructor(code: EvaluationConfigurationError['code'], message: string) {
    super(message);
    this.name = 'EvaluationConfigurationError';
    this.code = code;
  }
}

interface CapturedExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue,
> {
  readonly declaration: Executor<Input, Config, Output, Trace>;
  readonly inputParser: RuntimeValueParser<Input>;
  readonly configParser: RuntimeValueParser<Config>;
  readonly outputParser: RuntimeValueParser<Output>;
  readonly createPort: (
    targetId: string,
    experimentRole: 'control' | 'treatment',
  ) => ReturnType<typeof createJsonExecutorAdapter<Input, JsonValue, Output, Trace>>;
}

function configurationFailure(
  code: EvaluationConfigurationError['code'],
  message: string,
): never {
  throw new EvaluationConfigurationError(code, message);
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

function parseWithoutTransform<Value extends JsonValue>(
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
  value: Readonly<Executor<Input, Config, Output, Trace>>,
): CapturedExecutor<Input, Config, Output, Trace> {
  const executorId = IdentifierSchema.safeParse(value?.executorId);
  if (!executorId.success
      || typeof value?.version !== 'string'
      || value.version.length === 0
      || typeof value?.execute !== 'function') {
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
  const capabilities = value.capabilities ?? {};
  const telemetry = capabilities.telemetry ?? {};
  const outputClassification = value.outputClassification ?? 'sensitive';
  const traceClassification = value.traceClassification ?? outputClassification;
  const identity = (() => {
    try {
      return createInvokeExecutorIdentity({
        implementationId: executorId.data,
        version: value.version,
        determinism: capabilities.determinism ?? 'unknown',
        cancellation: capabilities.cancellation ?? 'best-effort',
        concurrency: capabilities.concurrency ?? { safety: 'serialized' },
        seedControl: capabilities.seedControl ?? 'unsupported',
        telemetry: {
          trace: telemetry.trace ?? (traceParser === undefined ? 'unsupported' : 'optional'),
          usage: telemetry.usage ?? 'optional',
          providerCost: telemetry.providerCost ?? { reporting: 'optional' },
        },
        fingerprintFacets: {
          facade: {
            version: 'omk.eval-runtime.evaluate/v2',
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
  const execute = value.execute;
  const declaration: Executor<Input, Config, Output, Trace> = Object.freeze({
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
    ...(value.fingerprintFacets === undefined ? {} : {
      fingerprintFacets: deepFreezeCanonicalJson(structuredClone(value.fingerprintFacets)),
    }),
    execute,
  });

  const createPort = (
    targetId: string,
    experimentRole: 'control' | 'treatment',
  ) => createJsonExecutorAdapter({
    identity,
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
    async invoke(invocation) {
      const targetConfig = VariantConfigEnvelopeSchema.parse(invocation.targetConfig);
      const result = await Reflect.apply(execute, declaration, [{
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
        experimentRole,
        trialIndex: invocation.trialIndex,
        ...(invocation.trialSeed === undefined ? {} : { trialSeed: invocation.trialSeed }),
        attemptNumber: invocation.attemptNumber,
        signal: invocation.signal,
      }]) as ExecutorResult<Output, Trace>;
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
    },
  });

  return Object.freeze({ declaration, inputParser, configParser, outputParser, createPort });
}

function captureDataset(value: Readonly<Dataset>): Dataset {
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

function captureVariant<Config extends JsonValue | undefined>(
  value: Readonly<Variant<Config>>,
  configParser: Readonly<RuntimeValueParser<Config>>,
): Readonly<{
  variantId: string;
  artifact: Artifact;
  runtimeContext?: RuntimeContext;
  config?: Config;
  envelope: JsonValue;
}> {
  const variantId = IdentifierSchema.safeParse(value?.variantId);
  if (!variantId.success) {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variantId 无效。',
    );
  }
  const artifact = captureArtifact(value.artifact);
  const runtimeContext = captureRuntimeContext(value.runtimeContext);
  const config = parseOptionalWithoutTransform(
    configParser,
    value.config,
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
  });
}

function captureJudge(value: Readonly<Judge>) {
  if (typeof value?.invoke !== 'function') {
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Rubric 评委声明无效。',
    );
  }
  const invoke = value.invoke;
  try {
    const providerCost = deepFreezeCanonicalJson(structuredClone(value.providerCost));
    const fingerprintFacets = value.fingerprintFacets === undefined
      ? undefined
      : deepFreezeCanonicalJson(structuredClone(value.fingerprintFacets));
    const identity = createRuntimeIdentity({
      implementationId: value.judgeId,
      version: value.version,
      capabilities: {
        invocationKind: 'llm-judge',
        cancellation: 'cooperative',
        providerCost,
      },
      fingerprintFacets: {
        facade: 'omk.eval-runtime.rubric-judge/v1',
        ...(fingerprintFacets === undefined
          ? {}
          : { host: fingerprintFacets }),
      },
    });
    const receiver: Judge = Object.freeze({
      judgeId: identity.implementationId,
      version: value.version,
      providerCost,
      ...(fingerprintFacets === undefined ? {} : { fingerprintFacets }),
      invoke,
    });
    return Object.freeze({
      identity,
      providerCost: receiver.providerCost,
      invoke: (request: Readonly<OmkLlmJudgeInvocationRequest>) => Reflect.apply(
        invoke,
        receiver,
        [request],
      ) as Promise<OmkLlmJudgeInvocationResult>,
    });
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Rubric 评委身份或费用声明无效。',
    );
  }
}

function attachDefinition(
  result: EvaluationRunResult,
  definition: EvaluationDefinition,
  policy: MeasurementPolicy,
): EvaluationResult {
  return Object.freeze({ ...result, definition, policy });
}

function rubricDataset(
  dataset: Readonly<Dataset>,
  evaluator: Readonly<RubricJudgeEvaluator>,
  createEvaluationContext: (
    criterion: Readonly<RubricJudgeCriterion>,
    base?: Readonly<{ [key: string]: JsonValue }>,
  ) => JsonValue,
): Dataset {
  let samples: EvaluationSample[];
  try {
    const criterion: RubricJudgeCriterion = {
      schemaVersion: 'omk.rubric-judge-context/v1',
      ...evaluator.rubric,
    };
    samples = dataset.samples.map((sample) => {
      const base = sample.evaluationContext;
      if (base !== undefined
          && (base === null || Array.isArray(base) || typeof base !== 'object')) {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          'Rubric 评委要求用例的 evaluationContext 为 JSON object。',
        );
      }
      return {
        ...structuredClone(sample),
        evaluationContext: createEvaluationContext(
          criterion,
          base as Readonly<{ [key: string]: JsonValue }> | undefined,
        ),
      };
    });
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Rubric 评委配置无效。',
    );
  }
  return captureDataset({ datasetId: dataset.datasetId, samples });
}

function assertCommonInput(input: Readonly<{
  runId: string;
  experiment: Experiment;
  policy: Policy;
  eventBufferCapacity?: number;
  annotations?: JsonValue;
  summaries?: JsonValue;
}>) {
  const allowedKeys = new Set([
    'executor',
    'dataset',
    'control',
    'treatment',
    'evaluator',
    'experiment',
    'policy',
    'runId',
    'signal',
    'annotations',
    'summaries',
    'eventBufferCapacity',
    'onEvent',
    'clock',
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))
      || !IdentifierSchema.safeParse(input.runId).success
      || !ExperimentSchema.safeParse(input.experiment).success
      || !PolicyInputSchema.safeParse(input.policy).success
      || (input.eventBufferCapacity !== undefined
        && (!Number.isSafeInteger(input.eventBufferCapacity) || input.eventBufferCapacity < 1))
      || (input.annotations !== undefined && !JsonValueSchema.safeParse(input.annotations).success)
      || (input.summaries !== undefined && !JsonValueSchema.safeParse(input.summaries).success)) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation input 包含无效或不受支持的字段。',
    );
  }
}

/** Runs one control/treatment evaluation through OMK's canonical user-facing API. */
export async function evaluate<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
>(
  input: Readonly<EvaluateInput<Input, Config, Output, Trace>>,
): Promise<EvaluationResult> {
  if (input === null || typeof input !== 'object') {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation input 无效。',
    );
  }
  assertCommonInput(input);
  const executor = captureExecutor(input.executor);
  const dataset = captureDataset(input.dataset);
  const annotations = input.annotations === undefined
    ? undefined
    : deepFreezeCanonicalJson(structuredClone(input.annotations));
  const summaries = input.summaries === undefined
    ? undefined
    : deepFreezeCanonicalJson(structuredClone(input.summaries));
  const control = captureVariant(input.control, executor.configParser);
  const treatment = captureVariant(input.treatment, executor.configParser);
  if (control.variantId === treatment.variantId) {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation 的对照组（control）与实验组（treatment）必须使用不同的 variantId。',
    );
  }

  let definition;
  let evaluatorRegistration;
  try {
    if (input.evaluator.evaluatorKind === 'exact-match') {
      const metricId = input.evaluator.metricId ?? 'correct';
      definition = createExactMatchDefinition({
        datasetId: dataset.datasetId,
        samples: dataset.samples,
        control: {
          targetId: control.variantId,
          targetKind: control.artifact.kind,
          executorId: executor.declaration.executorId,
          config: control.envelope,
        },
        treatment: {
          targetId: treatment.variantId,
          targetKind: treatment.artifact.kind,
          executorId: executor.declaration.executorId,
          config: treatment.envelope,
        },
        seed: input.experiment.seed,
        ...(input.experiment.trials === undefined ? {} : { trials: input.experiment.trials }),
        metricId,
        ...(input.experiment.bootstrap === undefined
          ? {}
          : { bootstrap: input.experiment.bootstrap }),
        ...(input.experiment.decision === undefined
          ? {}
          : { decision: input.experiment.decision }),
      });
      evaluatorRegistration = { port: createExactMatchEvaluator({ metricId }) };
    } else if (input.evaluator.evaluatorKind === 'rubric-judge') {
      const evaluator = input.evaluator;
      const kit = createRubricJudgeKit({
        evaluatorId: evaluator.evaluatorId,
        metricId: evaluator.metricId,
        model: evaluator.model,
        invocation: captureJudge(evaluator.judge),
        ...(evaluator.effort === undefined ? {} : { effort: evaluator.effort }),
        ...(evaluator.lengthDebias === undefined
          ? {}
          : { lengthDebias: evaluator.lengthDebias }),
        ...(evaluator.tracePolicy === undefined
          ? {}
          : { tracePolicy: evaluator.tracePolicy }),
        ...(evaluator.actualPointer === undefined
          ? {}
          : { actualPointer: evaluator.actualPointer }),
        ...(evaluator.tracePointer === undefined
          ? {}
          : { tracePointer: evaluator.tracePointer }),
        ...(evaluator.classification === undefined
          ? {}
          : { classification: evaluator.classification }),
      });
      const preparedDataset = rubricDataset(dataset, evaluator, kit.createEvaluationContext);
      definition = createPairedComparisonDefinition({
        datasetId: preparedDataset.datasetId,
        samples: preparedDataset.samples,
        control: {
          targetId: control.variantId,
          targetKind: control.artifact.kind,
          executorId: executor.declaration.executorId,
          config: control.envelope,
        },
        treatment: {
          targetId: treatment.variantId,
          targetKind: treatment.artifact.kind,
          executorId: executor.declaration.executorId,
          config: treatment.envelope,
        },
        evaluator: kit.evaluatorDefinition,
        metric: kit.metricDefinition,
        seed: input.experiment.seed,
        ...(input.experiment.trials === undefined ? {} : { trials: input.experiment.trials }),
        ...(input.experiment.bootstrap === undefined
          ? {}
          : { bootstrap: input.experiment.bootstrap }),
        ...(input.experiment.decision === undefined
          ? {}
          : { decision: input.experiment.decision }),
      });
      evaluatorRegistration = kit.evaluatorRegistration;
    } else {
      return configurationFailure(
        'EVAL_RUNTIME_EVALUATOR_INVALID',
        'Evaluation evaluatorKind 不受支持。',
      );
    }
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Evaluation evaluator 或 experiment declaration 无效。',
    );
  }

  let policy;
  try {
    policy = createMeasurementPolicy(input.policy);
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation policy 无效。',
    );
  }
  const roles = new Map([
    [control.variantId, 'control' as const],
    [treatment.variantId, 'treatment' as const],
  ]);
  const runtime = createEvaluationRuntime({
    executors: [{
      implementationId: executor.declaration.executorId,
      createPort: (requirement) => {
        const experimentRole = roles.get(requirement.referenceId);
        if (experimentRole === undefined) {
          return configurationFailure(
            'EVAL_RUNTIME_VARIANT_INVALID',
            'Evaluation Runtime 收到了未知 variant binding。',
          );
        }
        return executor.createPort(requirement.referenceId, experimentRole);
      },
    }],
    evaluators: [evaluatorRegistration],
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  try {
    const result = await runEvaluation({
      runtime,
      definition,
      policy,
      runId: input.runId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(annotations === undefined ? {} : { annotations }),
      ...(summaries === undefined ? {} : { summaries }),
      ...(input.eventBufferCapacity === undefined
        ? {}
        : { eventBufferCapacity: input.eventBufferCapacity }),
      ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    });
    return attachDefinition(result, definition, policy);
  } catch (error) {
    if (error instanceof AdvancedEvaluationEventConsumptionError) {
      throw new EvaluationEventConsumptionError({
        code: error.code,
        message: error.message,
        ...(error.runResult === undefined
          ? {}
          : { runResult: attachDefinition(error.runResult, definition, policy) }),
      });
    }
    throw error;
  }
}

/** Exercises one Executor through success, failure, cancellation, cleanup, and measurement checks. */
export async function checkExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
>(
  input: Readonly<ExecutorCheckInput<Input, Config, Output, Trace>>,
): Promise<ExecutorCheckResult> {
  if (input === null || typeof input !== 'object') {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Executor check input 无效。',
    );
  }
  if (input.success === null || typeof input.success !== 'object'
      || input.failure === null || typeof input.failure !== 'object'
      || input.cancellation === null || typeof input.cancellation !== 'object'
      || (input.seed !== undefined && (typeof input.seed !== 'string' || input.seed.length === 0))
      || (input.runId !== undefined && !IdentifierSchema.safeParse(input.runId).success)) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Executor check probe declaration 无效。',
    );
  }
  const executor = captureExecutor(input.executor);
  const variant = captureVariant(input.variant, executor.configParser);
  const successInput = parseWithoutTransform(
    executor.inputParser,
    input.success.input,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check success input 不符合 input schema，或 schema 改变了值。',
  );
  const successExpected = parseWithoutTransform(
    executor.outputParser,
    input.success.expected,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check expected output 不符合 output schema，或 schema 改变了值。',
  );
  const failureInput = parseWithoutTransform(
    executor.inputParser,
    input.failure.input,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check failure input 不符合 input schema，或 schema 改变了值。',
  );
  const cancellationInput = parseWithoutTransform(
    executor.inputParser,
    input.cancellation.input,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check cancellation input 不符合 input schema，或 schema 改变了值。',
  );
  if (!IdentifierSchema.safeParse(input.failure.expectedErrorCode).success) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Executor check expectedErrorCode 无效。',
    );
  }
  return runExecutorConformance({
    implementationId: executor.declaration.executorId,
    createExecutor(targetId) {
      if (targetId !== 'control' && targetId !== 'treatment') {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Executor check 收到了未知实验角色。',
        );
      }
      return executor.createPort(variant.variantId, targetId);
    },
    success: {
      input: successInput,
      expected: successExpected,
      targetConfig: variant.envelope,
    },
    failure: {
      input: failureInput,
      expectedErrorCode: input.failure.expectedErrorCode,
      targetConfig: variant.envelope,
    },
    cancellation: {
      input: cancellationInput,
      targetConfig: variant.envelope,
    },
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
}
