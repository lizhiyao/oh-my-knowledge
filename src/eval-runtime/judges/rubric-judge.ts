import { compareStrings } from '../../eval-core/primitives/ordering.js';
import { decodeRubricReadings, type RubricReading } from './rubric-readings.js';
import {
  IdentifierSchema,
  EvaluatorDefinitionSchema,
  MetricDefinitionSchema,
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
  type UsageRecord,
  type EvaluatorDefinition,
  type MetricDefinition,
} from '../../eval-core/contracts/index.js';
import {
  EvaluationPortFailure,
  type EvaluationEvaluator,
  type EvaluatorBindingValue,
  type EvaluatorObservation,
} from '../../eval-core/evaluation/index.js';
import type { EvaluatorRuntimeRequirement } from '../../eval-core/compiler/index.js';
import {
  buildJudgePrompt,
  getJudgePromptHash,
  JUDGE_SYSTEM_PROMPT,
} from './rubric-prompt.js';
import {
  buildJudgeTraceSummary,
  JUDGE_TRACE_SUMMARY_ALGORITHM_VERSION,
} from './trace-summary.js';
import type { ToolCallInfo, TurnInfo } from '../../executors/contracts/trace.js';
import {
  createSameProcessEvaluatorAdapter,
  type SameProcessEvaluatorImplementation,
  type SameProcessResourceLeaseAccess,
} from '../adapters/same-process.js';
import {
  SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR,
  SourceNeutralTraceSchema,
  type SourceNeutralTrace,
} from '../traces/source-neutral.js';
import {
  assertLlmJudgeInvocationResult,
  captureLlmJudgeInvocationPort,
  parseLlmJudgeUsage,
  redactLlmJudgeFailureUsage,
  type OmkLlmJudgeEffort,
  type OmkLlmJudgeInvocationPort,
  type OmkLlmJudgeInvocationResult,
} from './invocation.js';
import type { RuntimePortRegistration } from '../runtime.js';
import {
  RUBRIC_JUDGE_BINDINGS,
  RUBRIC_JUDGE_CONTEXT_SCHEMA,
  RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
  RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
  RUBRIC_JUDGE_EVIDENCE_SCHEMA,
  RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION,
  RUBRIC_JUDGE_INSTRUMENT_SCHEMA,
  RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION,
  type RubricJudgeConfig,
  type RubricJudgeCriterion,
  type RubricJudgeInstrument,
  type RubricJudgeRuntimeConfig,
  type RubricJudgeTracePolicy,
} from './rubric-contracts.js';
export {
  RUBRIC_JUDGE_BINDINGS,
  RUBRIC_JUDGE_CONTEXT_SCHEMA,
  RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
  RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
  RUBRIC_JUDGE_EVIDENCE_SCHEMA,
  RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION,
  RUBRIC_JUDGE_INSTRUMENT_SCHEMA,
  RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION,
} from './rubric-contracts.js';
export type {
  RubricJudgeConfig,
  RubricJudgeCriterion,
  RubricJudgeInstrument,
  RubricJudgeRuntimeConfig,
  RubricJudgeTracePolicy,
} from './rubric-contracts.js';

interface RecordState {
  readonly actual: string;
  readonly criteria: readonly RubricJudgeCriterion[];
  readonly instrument: RubricJudgeInstrument;
  readonly runtime: RubricJudgeRuntimeConfig;
  readonly trace?: SourceNeutralTrace;
  readonly evidenceClassification: EvaluatorBindingValue['classification'];
}

const ALGORITHM_VERSION = 'omk.rubric-judge-reading/v2' as const;
const CLASSIFICATION_LEVEL = { public: 0, sensitive: 1, secret: 2, gold: 3 } as const;

function mostRestrictedEvaluatorClassification(
  ...values: readonly EvaluatorBindingValue['classification'][]
): EvaluatorBindingValue['classification'] {
  return values.reduce((highest, candidate) => (
    CLASSIFICATION_LEVEL[candidate] > CLASSIFICATION_LEVEL[highest] ? candidate : highest
  ), 'public');
}

export function rubricJudgeInstrumentId(
  instrument: Readonly<RubricJudgeInstrument>,
): string {
  return `${instrument.promptId}-trace-${instrument.tracePolicy}`;
}

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
        ...('deploymentRevision' in value ? ['deploymentRevision'] : []),
        ...('effort' in value ? ['effort'] : []),
      ])
      || typeof value.executorId !== 'string' || value.executorId === ''
      || typeof value.model !== 'string' || value.model === ''
      || (value.deploymentRevision !== undefined
        && (typeof value.deploymentRevision !== 'string'
          || value.deploymentRevision.trim() === ''))
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
    ...(value.deploymentRevision === undefined
      ? {}
      : { deploymentRevision: value.deploymentRevision }),
    promptVariant: value.promptVariant,
    ...(value.effort === undefined ? {} : { effort: value.effort as OmkLlmJudgeEffort }),
  });
}

export function parseRubricJudgeConfig(value: unknown): RubricJudgeConfig {
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
      || !exactKeys(value, ['schemaVersion', 'metricId', 'criterionId', 'prompt', 'rubric'])
      || value.schemaVersion !== RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION
      || !IdentifierSchema.safeParse(value.metricId).success
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
    metricId: value.metricId as string,
    criterionId: value.criterionId,
    prompt: value.prompt,
    rubric: value.rubric,
  });
}

export function captureRubricJudgeCriteria(value: unknown): readonly RubricJudgeCriterion[] {
  if (!Array.isArray(value) || value.length === 0) {
    return failure('omk-rubric-judge-criteria-invalid', 'Rubric judge requires a nonempty criteria array.');
  }
  const criteria = value.map(parseCriterion).sort((a, b) => compareStrings(a.metricId, b.metricId));
  if (new Set(criteria.map((item) => item.metricId)).size !== criteria.length
      || new Set(criteria.map((item) => item.criterionId)).size !== criteria.length) {
    return failure('omk-rubric-judge-criteria-invalid', 'Rubric judge metric and criterion IDs must be unique.');
  }
  return Object.freeze(criteria);
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

function parseReadings(state: RecordState, output: string): EvaluatorObservation[] {
  return decodeRubricReadings(state.criteria.map((criterion) => criterion.metricId), output)
    .map((reading, index) => reading.observationStatus === 'invalid'
      ? { ...reading, valueType: 'numeric' as const }
      : observed(state, state.criteria[index], reading));
}

function observed(state: RecordState, criterion: RubricJudgeCriterion, reading: Extract<RubricReading, { observationStatus: 'observed' }>): EvaluatorObservation {
  return {
    metricId: criterion.metricId,
    observationStatus: 'observed',
    valueType: 'numeric',
    value: reading.value,
    evidence: {
      value: {
        schemaVersion: RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION,
        metricId: criterion.metricId,
        criterionId: criterion.criterionId,
        promptId: state.instrument.promptId,
        promptHash: state.instrument.promptHash,
        lengthDebias: state.instrument.lengthDebias,
        tracePolicy: state.instrument.tracePolicy,
        score: reading.value,
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
    version: '2.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
      runtimeProvenanceCompositionVersion: 'omk.runtime-provenance-composition/v2',
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
    // A composed evaluator cannot claim stronger provenance than the provider
    // Runtime that produced its measurement. In particular, hashing an opaque
    // provider identity does not make the remote deployment content-derived.
    fingerprintBasis: invocation.identity.fingerprintBasis,
    assuranceLevel: invocation.identity.assuranceLevel,
    capabilities: declaredCapabilities,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }));
}

export function createRubricJudgeEvaluatorImplementation<ResourceLease = undefined>(
  invocation: OmkLlmJudgeInvocationPort,
  expected?: Readonly<{
    instrument: RubricJudgeInstrument;
    runtime: RubricJudgeRuntimeConfig;
  }>,
): SameProcessEvaluatorImplementation<undefined, RecordState, ResourceLease> {
  const capturedInvocation = captureLlmJudgeInvocationPort(invocation);
  const expectedFingerprint = expected === undefined ? undefined : digestCanonicalJson({
    instrument: parseInstrument(expected.instrument),
    runtime: parseRuntime(expected.runtime),
  });
  const implementation: SameProcessEvaluatorImplementation<undefined, RecordState, ResourceLease> = {
    openRun: () => undefined,
    openRecord({ record }): RecordState {
      if (record.evaluatorConfig === undefined) {
        return failure(
          'omk-rubric-judge-record-invalid',
          'Rubric judge Evaluator requires a sealed record configuration.',
        );
      }
      const config = parseRubricJudgeConfig(record.evaluatorConfig);
      if (expectedFingerprint !== undefined
          && digestCanonicalJson({
            instrument: config.evaluator.value,
            runtime: config.runtime,
          }) !== expectedFingerprint) {
        return failure(
          'omk-rubric-judge-runtime-binding-mismatch',
          'Rubric judge Runtime binding differs from the sealed Evaluator configuration.',
        );
      }
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
        RUBRIC_JUDGE_BINDINGS.criteria,
        'evaluation-context',
      );
      const criteria = captureRubricJudgeCriteria(criterionBinding.value);
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
      if (typeof actual.value !== 'string'
          || record.measurement.instrumentId !== rubricJudgeInstrumentId(config.evaluator.value)
          || record.metrics.length !== criteria.length
          || record.metrics.some((metric) => !criteria.some((item) => item.metricId === metric.metricId)
          || metric.valueType !== 'numeric'
          || metric.direction !== 'higher-is-better'
          || metric.scale?.min !== 1
          || metric.scale.max !== 5
          || metric.scale.target !== undefined)) {
        return failure(
          'omk-rubric-judge-contract-mismatch',
          'Rubric judge record differs from its 1–5 numeric Metric contract.',
        );
      }
      return Object.freeze({
        actual: actual.value,
        criteria,
        instrument: config.evaluator.value,
        runtime: config.runtime,
        ...(trace === undefined ? {} : { trace }),
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
        recordState.criteria,
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
      return {
        observations: parseReadings(recordState, result.output),
        ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
      };
    },
    disposeRecord: () => undefined,
    disposeRun: () => undefined,
  };
  return Object.freeze(implementation);
}

export function rubricJudgeInstrument(input: Readonly<{
  lengthDebias?: boolean;
  tracePolicy?: RubricJudgeTracePolicy;
}> = {}): RubricJudgeInstrument {
  const lengthDebias = input.lengthDebias ?? true;
  const tracePolicy = input.tracePolicy ?? 'none';
  const prompt = expectedPromptIdentity(lengthDebias);
  return deepFreezeCanonicalJson({
    schemaVersion: RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION,
    promptId: prompt.promptId,
    promptHash: prompt.promptHash,
    lengthDebias,
    tracePolicy,
  });
}

export const createRubricJudgeInstrument = rubricJudgeInstrument;

export function createRubricJudgeCriterion(
  input: Readonly<{
    metricId: string;
    criterionId: string;
    prompt: string;
    rubric: string;
  }>,
): RubricJudgeCriterion {
  return deepFreezeCanonicalJson(parseCriterion({
    schemaVersion: RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
    metricId: input.metricId,
    criterionId: input.criterionId,
    prompt: input.prompt,
    rubric: input.rubric,
  }));
}

export function createRubricJudgeRuntimeConfig(input: Readonly<{
  executorId: string;
  model: string;
  deploymentRevision?: string;
  effort?: OmkLlmJudgeEffort;
  instrument: RubricJudgeInstrument;
}>): RubricJudgeRuntimeConfig {
  return deepFreezeCanonicalJson(parseRuntime({
    executorId: input.executorId,
    model: input.model,
    ...(input.deploymentRevision === undefined
      ? {}
      : { deploymentRevision: input.deploymentRevision }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    promptVariant: parseInstrument(input.instrument).promptId,
  }));
}

export interface CreateRubricJudgeEvaluatorInput<ResourceLease = undefined> {
  readonly instrument: RubricJudgeInstrument;
  readonly runtime: RubricJudgeRuntimeConfig;
  readonly invocation: OmkLlmJudgeInvocationPort;
  readonly sessionIsolationKey?: string;
  readonly resourceLeases?: SameProcessResourceLeaseAccess<ResourceLease>;
}

export interface RubricJudgeEvaluatorBinding<ResourceLease = undefined>
  extends CreateRubricJudgeEvaluatorInput<ResourceLease> {
  /** Must match the EvaluatorDefinition evaluatorId (Core requirement referenceId). */
  readonly evaluatorId: string;
}

/** Creates a Core Evaluator while the host owns exactly one provider invocation. */
export function createRubricJudgeEvaluator<ResourceLease = undefined>(
  input: Readonly<CreateRubricJudgeEvaluatorInput<ResourceLease>>,
): EvaluationEvaluator {
  const instrument = parseInstrument(input.instrument);
  const runtime = parseRuntime(input.runtime);
  if (runtime.promptVariant !== instrument.promptId) {
    return failure(
      'omk-rubric-judge-prompt-variant-mismatch',
      'Rubric judge runtime prompt variant differs from the sealed instrument.',
    );
  }
  const invocation = captureLlmJudgeInvocationPort(input.invocation);
  if (invocation.identity.implementationId !== runtime.executorId) {
    return failure(
      'omk-rubric-judge-provider-identity-mismatch',
      'LLM judge invocation Runtime identity differs from the selected executor.',
    );
  }
  return createSameProcessEvaluatorAdapter({
    identity: createRubricJudgeEvaluatorIdentity({ instrument, runtime, invocation }),
    sessionIsolationKey: input.sessionIsolationKey ?? 'omk.rubric-judge/v2',
    resourceLeases: input.resourceLeases ?? { forRun: () => undefined as ResourceLease },
    implementation: createRubricJudgeEvaluatorImplementation(invocation, { instrument, runtime }),
  });
}

/**
 * Creates one lazy eval-runtime registration for one or more Rubric definitions.
 * Provider identity and method are captured at registration; no invocation,
 * provider discovery, credential lookup, or preflight occurs until Core runs it.
 */
export function createRubricJudgeEvaluatorRegistration<ResourceLease = undefined>(
  bindings: readonly Readonly<RubricJudgeEvaluatorBinding<ResourceLease>>[],
): RuntimePortRegistration<EvaluationEvaluator, EvaluatorRuntimeRequirement> {
  const byEvaluatorId = new Map<string, Readonly<RubricJudgeEvaluatorBinding<ResourceLease>>>();
  for (const binding of bindings) {
    if (!IdentifierSchema.safeParse(binding.evaluatorId).success) {
      throw new TypeError('Rubric judge registration requires a valid evaluatorId.');
    }
    if (byEvaluatorId.has(binding.evaluatorId)) {
      throw new TypeError(`Rubric judge evaluatorId is duplicated: "${binding.evaluatorId}".`);
    }
    byEvaluatorId.set(binding.evaluatorId, Object.freeze({
      ...binding,
      instrument: parseInstrument(binding.instrument),
      runtime: parseRuntime(binding.runtime),
      invocation: captureLlmJudgeInvocationPort(binding.invocation),
    }));
  }
  if (byEvaluatorId.size === 0) {
    throw new TypeError('Rubric judge registration requires at least one binding.');
  }
  return Object.freeze({
    implementationId: RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
    createPort(requirement: Readonly<EvaluatorRuntimeRequirement>) {
      const binding = byEvaluatorId.get(requirement.referenceId);
      if (binding === undefined) {
        throw new TypeError(
          `Rubric judge registration does not contain evaluatorId "${requirement.referenceId}".`,
        );
      }
      return createRubricJudgeEvaluator(binding);
    },
  });
}

export interface RubricJudgeEvaluatorDefinitionBuilderInput {
  readonly evaluatorId: string;
  readonly metricIds: readonly string[];
  readonly versionConstraint?: string;
  readonly instrument: RubricJudgeInstrument;
  readonly runtime: RubricJudgeRuntimeConfig;
  readonly actualPointer?: string;
  readonly criteriaPointer: string;
  readonly tracePointer?: string;
  readonly applicableSampleIds?: readonly string[];
  readonly ensembleMemberId?: string;
  readonly replicateGroupId?: string;
  readonly replicateIndex?: number;
  readonly classification?: 'public' | 'sensitive';
}

/** Builds the serializable Core EvaluatorDefinition matching createRubricJudgeEvaluator. */
export function createRubricJudgeEvaluatorDefinition(
  input: Readonly<RubricJudgeEvaluatorDefinitionBuilderInput>,
): EvaluatorDefinition {
  const instrument = parseInstrument(input.instrument);
  const runtime = parseRuntime(input.runtime);
  if (runtime.promptVariant !== instrument.promptId) {
    return failure(
      'omk-rubric-judge-prompt-variant-mismatch',
      'Rubric judge runtime prompt variant differs from the sealed instrument.',
    );
  }
  const memberDigest = digestCanonicalJson({ runtime }).slice('sha256:'.length, 'sha256:'.length + 16);
  return deepFreezeCanonicalJson(EvaluatorDefinitionSchema.parse({
    evaluatorId: input.evaluatorId,
    evaluatorKind: 'llm-rubric',
    implementationId: RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
    ...(input.versionConstraint === undefined
      ? {}
      : { versionConstraint: input.versionConstraint }),
    ...(input.applicableSampleIds === undefined
      ? {}
      : { applicableSampleIds: [...input.applicableSampleIds] }),
    measurement: {
      instrumentId: rubricJudgeInstrumentId(instrument),
      ensembleMemberId: input.ensembleMemberId ?? `judge-${memberDigest}`,
      replicateGroupId: input.replicateGroupId ?? `rubric-${digestCanonicalJson([...input.metricIds].sort()).slice(7, 23)}`,
      replicateIndex: input.replicateIndex ?? 0,
    },
    metricIds: [...input.metricIds].sort(),
    inputs: [
      {
        bindingId: RUBRIC_JUDGE_BINDINGS.actual,
        sourceKind: 'output',
        pointer: input.actualPointer ?? '',
      },
      {
        bindingId: RUBRIC_JUDGE_BINDINGS.criteria,
        sourceKind: 'evaluation-context',
        pointer: input.criteriaPointer,
      },
      ...(instrument.tracePolicy === 'source-neutral' ? [{
        bindingId: RUBRIC_JUDGE_BINDINGS.trace,
        sourceKind: 'trace' as const,
        pointer: input.tracePointer ?? '',
      }] : []),
    ],
    config: {
      evaluator: {
        classification: input.classification ?? 'public',
        value: instrument,
      },
      runtime,
    },
  }));
}

export function createRubricJudgeMetricDefinition(metricId: string): MetricDefinition {
  return deepFreezeCanonicalJson(MetricDefinitionSchema.parse({
    metricId,
    valueType: 'numeric',
    scope: 'sample',
    scale: { min: 1, max: 5 },
    direction: 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  }));
}
