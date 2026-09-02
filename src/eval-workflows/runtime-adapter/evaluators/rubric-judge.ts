import {
  IdentifierSchema,
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
  type UsageRecord,
} from '../../../eval-core/contracts/index.js';
import {
  EvaluationPortFailure,
  type EvaluatorBindingValue,
  type EvaluatorObservation,
} from '../../../eval-core/evaluation/index.js';
import {
  buildJudgePrompt,
  getJudgePromptHash,
  JUDGE_SYSTEM_PROMPT,
} from '../../../shared/llm-prompts/judge-prompts.js';
import {
  buildJudgeTraceSummary,
  JUDGE_TRACE_SUMMARY_ALGORITHM_VERSION,
} from '../../grading/judge-trace.js';
import type { ToolCallInfo, TurnInfo } from '../../../executors/contracts/trace.js';
import type { SameProcessEvaluatorImplementation } from '../adapters/shared/same-process.js';
import { createSameProcessEvaluatorAdapter } from '../adapters/shared/same-process.js';
import {
  SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR,
  SourceNeutralTraceSchema,
  type SourceNeutralTrace,
} from '../source-neutral-trace.js';
import type {
  OmkEvaluatorBindingContext,
  OmkRuntimePortBinding,
} from '../types.js';
import { mostRestrictedEvaluatorClassification } from './assertion-common.js';
import {
  assertLlmJudgeInvocationResult,
  captureLlmJudgeInvocationPort,
  parseLlmJudgeUsage,
  redactLlmJudgeFailureUsage,
  type OmkLlmJudgeEffort,
  type OmkLlmJudgeInvocationPort,
  type OmkLlmJudgeInvocationResolver,
  type OmkLlmJudgeInvocationResult,
} from './llm-judge-invocation.js';

export const RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID =
  'omk.rubric-judge/v1' as const;
export const RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION =
  'omk.rubric-judge-instrument/v1' as const;
export const RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION =
  'omk.rubric-judge-context/v1' as const;
export const RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION =
  'omk.rubric-judge-evidence/v1' as const;
export const RUBRIC_JUDGE_BINDINGS = Object.freeze({
  actual: 'actual',
  criterion: 'criterion',
  trace: 'trace',
});

export type RubricJudgeTracePolicy = 'none' | 'source-neutral';

export interface RubricJudgeInstrument {
  readonly schemaVersion: typeof RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION;
  readonly promptId: 'rubric-judge-debias-on' | 'rubric-judge-debias-off';
  readonly promptHash: string;
  readonly lengthDebias: boolean;
  readonly tracePolicy: RubricJudgeTracePolicy;
}

interface RubricJudgeRuntimeConfig {
  readonly executorId: string;
  readonly model: string;
  readonly effort?: OmkLlmJudgeEffort;
  readonly promptVariant: string;
}

interface RubricJudgeConfig {
  readonly evaluator: {
    readonly classification: 'public' | 'sensitive';
    readonly value: RubricJudgeInstrument;
  };
  readonly runtime: RubricJudgeRuntimeConfig;
}

interface RubricJudgeCriterion {
  readonly schemaVersion: typeof RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION;
  readonly criterionId: string;
  readonly prompt: string;
  readonly rubric: string;
}

interface RubricJudgeReading {
  readonly score: number;
  readonly reason: string;
  readonly reasoning?: string;
}

interface RecordState {
  readonly actual: string;
  readonly criterion: RubricJudgeCriterion;
  readonly instrument: RubricJudgeInstrument;
  readonly runtime: RubricJudgeRuntimeConfig;
  readonly trace?: SourceNeutralTrace;
  readonly metricId: string;
  readonly evidenceClassification: EvaluatorBindingValue['classification'];
}

const ALGORITHM_VERSION = 'omk.rubric-judge-reading/v1' as const;

export function rubricJudgeInstrumentId(
  instrument: Readonly<RubricJudgeInstrument>,
): string {
  return `${instrument.promptId}-trace-${instrument.tracePolicy}`;
}

const INSTRUMENT_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:rubric-judge-instrument:v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'promptId', 'promptHash', 'lengthDebias', 'tracePolicy'],
  properties: {
    schemaVersion: { const: RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION },
    promptId: { enum: ['rubric-judge-debias-on', 'rubric-judge-debias-off'] },
    promptHash: { type: 'string', pattern: '^[0-9a-f]{12}$' },
    lengthDebias: { type: 'boolean' },
    tracePolicy: { enum: ['none', 'source-neutral'] },
  },
};

const CONTEXT_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:rubric-judge-context:v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'criterionId', 'prompt', 'rubric'],
  properties: {
    schemaVersion: { const: RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION },
    criterionId: { type: 'string', minLength: 1, maxLength: 256 },
    prompt: { type: 'string' },
    rubric: { type: 'string', minLength: 1 },
  },
};

const EVIDENCE_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:rubric-judge-evidence:v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'criterionId',
    'promptId',
    'promptHash',
    'lengthDebias',
    'tracePolicy',
    'score',
    'reason',
  ],
  properties: {
    schemaVersion: { const: RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION },
    criterionId: { type: 'string' },
    promptId: { type: 'string' },
    promptHash: { type: 'string' },
    lengthDebias: { type: 'boolean' },
    tracePolicy: { enum: ['none', 'source-neutral'] },
    score: { type: 'integer', minimum: 1, maximum: 5 },
    reason: { type: 'string', minLength: 1 },
    reasoning: { type: 'string', minLength: 1 },
  },
};

function schemaIdentity(
  schemaVersion: string,
  schemaUri: string,
  schema: JsonValue,
): SchemaIdentity {
  return deepFreezeCanonicalJson({
    schemaVersion,
    schemaUri,
    schemaDigest: digestCanonicalJson(schema),
  });
}

export const RUBRIC_JUDGE_INSTRUMENT_SCHEMA = schemaIdentity(
  RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION,
  'urn:omk:rubric-judge-instrument:v1',
  INSTRUMENT_SCHEMA_DOCUMENT,
);
export const RUBRIC_JUDGE_CONTEXT_SCHEMA = schemaIdentity(
  RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
  'urn:omk:rubric-judge-context:v1',
  CONTEXT_SCHEMA_DOCUMENT,
);
export const RUBRIC_JUDGE_EVIDENCE_SCHEMA = schemaIdentity(
  RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION,
  'urn:omk:rubric-judge-evidence:v1',
  EVIDENCE_SCHEMA_DOCUMENT,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function failure(code: string, message: string, usage?: UsageRecord): never {
  throw new EvaluationPortFailure({ code, stage: 'evaluation', message }, usage);
}

function expectedPromptIdentity(lengthDebias: boolean): Readonly<{
  promptId: RubricJudgeInstrument['promptId'];
  promptHash: string;
}> {
  return lengthDebias
    ? { promptId: 'rubric-judge-debias-on', promptHash: getJudgePromptHash(true) }
    : { promptId: 'rubric-judge-debias-off', promptHash: getJudgePromptHash(false) };
}

function parseInstrument(value: unknown): RubricJudgeInstrument {
  if (!isRecord(value)
      || !exactKeys(value, [
        'schemaVersion',
        'promptId',
        'promptHash',
        'lengthDebias',
        'tracePolicy',
      ])
      || value.schemaVersion !== RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION
      || typeof value.promptId !== 'string'
      || typeof value.promptHash !== 'string'
      || typeof value.lengthDebias !== 'boolean'
      || !['none', 'source-neutral'].includes(String(value.tracePolicy))) {
    return failure(
      'omk-rubric-judge-instrument-invalid',
      'Rubric judge instrument configuration is invalid.',
    );
  }
  const expected = expectedPromptIdentity(value.lengthDebias);
  if (value.promptId !== expected.promptId || value.promptHash !== expected.promptHash) {
    return failure(
      'omk-rubric-judge-prompt-identity-mismatch',
      'Rubric judge prompt identity differs from the frozen registry.',
    );
  }
  return Object.freeze({
    schemaVersion: RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION,
    promptId: expected.promptId,
    promptHash: expected.promptHash,
    lengthDebias: value.lengthDebias,
    tracePolicy: value.tracePolicy as RubricJudgeTracePolicy,
  });
}

function parseRuntime(value: unknown): RubricJudgeRuntimeConfig {
  if (!isRecord(value)
      || !exactKeys(value, [
        'executorId',
        'model',
        'promptVariant',
        ...('effort' in value ? ['effort'] : []),
      ])
      || typeof value.executorId !== 'string' || value.executorId === ''
      || typeof value.model !== 'string' || value.model === ''
      || typeof value.promptVariant !== 'string' || value.promptVariant === ''
      || (value.effort !== undefined
        && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(value.effort)))) {
    return failure(
      'omk-rubric-judge-runtime-invalid',
      'Rubric judge runtime configuration is invalid.',
    );
  }
  return Object.freeze({
    executorId: value.executorId,
    model: value.model,
    promptVariant: value.promptVariant,
    ...(value.effort === undefined ? {} : { effort: value.effort as OmkLlmJudgeEffort }),
  });
}

function parseConfig(value: unknown): RubricJudgeConfig {
  if (!isRecord(value)
      || !exactKeys(value, ['evaluator', 'runtime'])
      || !isRecord(value.evaluator)
      || !exactKeys(value.evaluator, ['classification', 'value'])
      || !['public', 'sensitive'].includes(String(value.evaluator.classification))) {
    return failure(
      'omk-rubric-judge-config-invalid',
      'Rubric judge Evaluator requires a sealed instrument and runtime configuration.',
    );
  }
  const instrument = parseInstrument(value.evaluator.value);
  const runtime = parseRuntime(value.runtime);
  if (runtime.promptVariant !== instrument.promptId) {
    return failure(
      'omk-rubric-judge-prompt-variant-mismatch',
      'Rubric judge runtime prompt variant differs from the sealed instrument.',
    );
  }
  return Object.freeze({
    evaluator: {
      classification: value.evaluator.classification as 'public' | 'sensitive',
      value: instrument,
    },
    runtime,
  });
}

function parseCriterion(value: unknown): RubricJudgeCriterion {
  if (!isRecord(value)
      || !exactKeys(value, ['schemaVersion', 'criterionId', 'prompt', 'rubric'])
      || value.schemaVersion !== RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION
      || typeof value.criterionId !== 'string'
      || !IdentifierSchema.safeParse(value.criterionId).success
      || typeof value.prompt !== 'string'
      || typeof value.rubric !== 'string'
      || value.rubric.trim() === '') {
    return failure(
      'omk-rubric-judge-criterion-invalid',
      'Rubric judge criterion is invalid.',
    );
  }
  return Object.freeze({
    schemaVersion: RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
    criterionId: value.criterionId,
    prompt: value.prompt,
    rubric: value.rubric,
  });
}

function binding(
  bindings: readonly EvaluatorBindingValue[],
  bindingId: string,
  sourceKind: EvaluatorBindingValue['sourceKind'],
): EvaluatorBindingValue {
  const candidates = bindings.filter((candidate) => candidate.bindingId === bindingId);
  if (candidates.length !== 1 || candidates[0].sourceKind !== sourceKind) {
    return failure(
      'omk-rubric-judge-binding-invalid',
      'Rubric judge Evaluator received an invalid binding set.',
    );
  }
  return candidates[0];
}

function invalidObservation(metricId: string, reasonCode: string): EvaluatorObservation {
  return {
    metricId,
    observationStatus: 'invalid',
    valueType: 'numeric',
    reasonCode,
  };
}

function parseReading(
  metricId: string,
  output: string,
): RubricJudgeReading | EvaluatorObservation {
  const json = output.trim();
  if (!json.includes('{')) return invalidObservation(metricId, 'judge-response-non-json');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return invalidObservation(metricId, 'judge-response-malformed-json');
  }
  if (!isRecord(value) || typeof value.score !== 'number' || !Number.isInteger(value.score)) {
    return invalidObservation(metricId, 'judge-score-malformed');
  }
  if (value.score < 1 || value.score > 5) {
    return invalidObservation(metricId, 'judge-score-out-of-range');
  }
  if (typeof value.reason !== 'string' || value.reason.trim() === '') {
    return invalidObservation(metricId, 'judge-reason-missing');
  }
  return {
    score: value.score,
    reason: value.reason,
    ...(typeof value.reasoning === 'string' && value.reasoning.trim() !== ''
      ? { reasoning: value.reasoning }
      : {}),
  };
}

function observed(state: RecordState, reading: RubricJudgeReading): EvaluatorObservation {
  return {
    metricId: state.metricId,
    observationStatus: 'observed',
    valueType: 'numeric',
    value: reading.score,
    evidence: {
      value: {
        schemaVersion: RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION,
        criterionId: state.criterion.criterionId,
        promptId: state.instrument.promptId,
        promptHash: state.instrument.promptHash,
        lengthDebias: state.instrument.lengthDebias,
        tracePolicy: state.instrument.tracePolicy,
        score: reading.score,
        reason: reading.reason,
        ...(reading.reasoning === undefined ? {} : { reasoning: reading.reasoning }),
      },
      classification: state.evidenceClassification,
    },
  };
}

function capabilities(
  instrument: RubricJudgeInstrument,
  invocation: OmkLlmJudgeInvocationPort,
): JsonValue {
  return {
    inputSourceKinds: instrument.tracePolicy === 'source-neutral'
      ? ['evaluation-context', 'output', 'trace']
      : ['evaluation-context', 'output'],
    metricValueTypes: ['numeric'],
    schemas: [
      RUBRIC_JUDGE_CONTEXT_SCHEMA,
      RUBRIC_JUDGE_EVIDENCE_SCHEMA,
      RUBRIC_JUDGE_INSTRUMENT_SCHEMA,
    ],
    providerCost: invocation.providerCost,
  };
}

export function createRubricJudgeEvaluatorIdentity(input: Readonly<{
  instrument: RubricJudgeInstrument;
  runtime: RubricJudgeRuntimeConfig;
  invocation: OmkLlmJudgeInvocationPort;
}>): RuntimeIdentity {
  const invocation = captureLlmJudgeInvocationPort(input.invocation);
  const declaredCapabilities = capabilities(input.instrument, invocation);
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    implementationId: RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
      algorithmVersion: ALGORITHM_VERSION,
      instrument: input.instrument,
      runtime: input.runtime,
      invocationRuntime: invocation.identity,
      ...(input.instrument.tracePolicy === 'source-neutral' ? {
        traceSummaryAlgorithmVersion: JUDGE_TRACE_SUMMARY_ALGORITHM_VERSION,
        sourceNeutralTraceSchema: SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR,
      } : {}),
      capabilities: declaredCapabilities,
    }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: invocation.identity.assuranceLevel,
    capabilities: declaredCapabilities,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }));
}

export function createRubricJudgeEvaluatorImplementation(
  invocation: OmkLlmJudgeInvocationPort,
): SameProcessEvaluatorImplementation<undefined, RecordState> {
  const capturedInvocation = captureLlmJudgeInvocationPort(invocation);
  const implementation: SameProcessEvaluatorImplementation<undefined, RecordState> = {
    openRun: () => undefined,
    openRecord({ record }): RecordState {
      if (record.evaluatorConfig === undefined) {
        return failure(
          'omk-rubric-judge-record-invalid',
          'Rubric judge Evaluator requires a sealed record configuration.',
        );
      }
      const config = parseConfig(record.evaluatorConfig);
      const expectedBindings = config.evaluator.value.tracePolicy === 'source-neutral' ? 3 : 2;
      if (record.bindings.length !== expectedBindings) {
        return failure(
          'omk-rubric-judge-record-invalid',
          'Rubric judge Evaluator received an unsupported binding set.',
        );
      }
      const actual = binding(record.bindings, RUBRIC_JUDGE_BINDINGS.actual, 'output');
      const criterionBinding = binding(
        record.bindings,
        RUBRIC_JUDGE_BINDINGS.criterion,
        'evaluation-context',
      );
      const criterion = parseCriterion(criterionBinding.value);
      let traceBinding: EvaluatorBindingValue | undefined;
      let trace: SourceNeutralTrace | undefined;
      if (config.evaluator.value.tracePolicy === 'source-neutral') {
        traceBinding = binding(record.bindings, RUBRIC_JUDGE_BINDINGS.trace, 'trace');
        const parsed = SourceNeutralTraceSchema.safeParse(traceBinding.value);
        if (!parsed.success) {
          return failure(
            'omk-rubric-judge-trace-invalid',
            'Rubric judge Evaluator requires a canonical source-neutral trace.',
          );
        }
        trace = parsed.data;
      }
      const metric = record.metrics[0];
      if (typeof actual.value !== 'string'
          || record.measurement.instrumentId !== rubricJudgeInstrumentId(config.evaluator.value)
          || record.metrics.length !== 1
          || metric.valueType !== 'numeric'
          || metric.direction !== 'higher-is-better'
          || metric.scale?.min !== 1
          || metric.scale.max !== 5
          || metric.scale.target !== undefined) {
        return failure(
          'omk-rubric-judge-contract-mismatch',
          'Rubric judge record differs from its 1–5 numeric Metric contract.',
        );
      }
      return Object.freeze({
        actual: actual.value,
        criterion,
        instrument: config.evaluator.value,
        runtime: config.runtime,
        ...(trace === undefined ? {} : { trace }),
        metricId: metric.metricId,
        evidenceClassification: mostRestrictedEvaluatorClassification(
          actual.classification,
          criterionBinding.classification,
          ...(traceBinding === undefined ? [] : [traceBinding.classification]),
        ),
      });
    },
    async evaluate({ recordState, attempt }) {
      if (attempt.signal.aborted) throw attempt.signal.reason;
      const traceSummary = recordState.trace === undefined
        ? null
        : buildJudgeTraceSummary(
          recordState.trace.turns as unknown as readonly TurnInfo[],
          recordState.trace.toolCalls as unknown as readonly ToolCallInfo[],
        );
      const prompt = buildJudgePrompt(
        recordState.criterion.prompt,
        recordState.criterion.rubric,
        recordState.actual,
        traceSummary,
        recordState.instrument.lengthDebias,
      );
      let result: OmkLlmJudgeInvocationResult;
      try {
        result = await capturedInvocation.invoke({
          executorId: recordState.runtime.executorId,
          model: recordState.runtime.model,
          ...(recordState.runtime.effort === undefined
            ? {}
            : { effort: recordState.runtime.effort }),
          system: JUDGE_SYSTEM_PROMPT,
          prompt,
          promptId: recordState.instrument.promptId,
          promptHash: recordState.instrument.promptHash,
          signal: attempt.signal,
        });
      } catch {
        if (attempt.signal.aborted) throw attempt.signal.reason;
        return failure(
          'judge-provider-failure',
          'LLM judge provider invocation failed.',
        );
      }
      if (attempt.signal.aborted) throw attempt.signal.reason;
      assertLlmJudgeInvocationResult(result);
      if (result.invocationStatus === 'failed') {
        return failure(
          'judge-provider-failure',
          'LLM judge provider reported a structured failure.',
          redactLlmJudgeFailureUsage(result.usage),
        );
      }
      const measuredUsage = parseLlmJudgeUsage(result.usage);
      const reading = parseReading(recordState.metricId, result.output);
      return {
        observations: ['observationStatus' in reading ? reading : observed(recordState, reading)],
        ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
      };
    },
    disposeRecord: () => undefined,
    disposeRun: () => undefined,
  };
  return Object.freeze(implementation);
}

export function createRubricJudgeEvaluatorBindingFactory(
  resolveInvocation: OmkLlmJudgeInvocationResolver,
): (
  context: Readonly<OmkEvaluatorBindingContext>,
) => Promise<OmkRuntimePortBinding<ReturnType<typeof createSameProcessEvaluatorAdapter>>> {
  return async (context) => {
    const config = parseConfig(context.evaluator.config);
    const qualification = context.binding.qualification;
    if (context.evaluator.measurement.instrumentId
          !== rubricJudgeInstrumentId(config.evaluator.value)
        || qualification === undefined
        || qualification.executorId !== config.runtime.executorId
        || qualification.model !== config.runtime.model
        || qualification.effort !== config.runtime.effort
        || qualification.promptVariant !== config.runtime.promptVariant) {
      return failure(
        'omk-rubric-judge-runtime-binding-mismatch',
        'Rubric judge Runtime binding differs from the sealed Evaluator configuration.',
      );
    }
    const resolved = await resolveInvocation(context);
    const invocation = captureLlmJudgeInvocationPort(resolved.port);
    if (invocation.identity.implementationId !== config.runtime.executorId) {
      return failure(
        'omk-rubric-judge-provider-identity-mismatch',
        'LLM judge invocation Runtime identity differs from the selected executor.',
      );
    }
    const identity = createRubricJudgeEvaluatorIdentity({
      instrument: config.evaluator.value,
      runtime: config.runtime,
      invocation,
    });
    return {
      port: createSameProcessEvaluatorAdapter({
        identity,
        sessionIsolationKey: context.sessionIsolationKey,
        resourceLeases: context.resourceLeases,
        implementation: createRubricJudgeEvaluatorImplementation(invocation),
      }),
      satisfiesVersionConstraint: true,
      preflightDeclarations: resolved.preflightDeclarations,
    };
  };
}

export function rubricJudgeInstrument(input: Readonly<{
  lengthDebias: boolean;
  tracePolicy: RubricJudgeTracePolicy;
}>): RubricJudgeInstrument {
  const prompt = expectedPromptIdentity(input.lengthDebias);
  return deepFreezeCanonicalJson({
    schemaVersion: RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION,
    promptId: prompt.promptId,
    promptHash: prompt.promptHash,
    lengthDebias: input.lengthDebias,
    tracePolicy: input.tracePolicy,
  });
}
