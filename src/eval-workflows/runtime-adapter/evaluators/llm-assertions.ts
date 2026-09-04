import {
  IdentifierSchema,
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
  type UsageRecord,
} from '../../../eval-core/contracts/index.js';
import {
  EvaluationPortFailure,
  type EvaluatorBindingValue,
  type EvaluatorObservation,
} from '../../../eval-core/evaluation/index.js';
import {
  buildRagJudgePrompt,
  buildSemanticSimilarityPrompt,
  getRagJudgePromptHash,
  getSemanticPromptHash,
  SEMANTIC_SIMILARITY_SYSTEM,
  type RagJudgeType,
} from '../../instruments/prompts/judge-prompts.js';
import type { SameProcessEvaluatorImplementation } from '../adapters/shared/omk-resource-same-process.js';
import { createSameProcessEvaluatorAdapter } from '../adapters/shared/omk-resource-same-process.js';
import type {
  OmkEvaluatorBindingContext,
  OmkRuntimePortBinding,
} from '../types.js';
import {
  assertionSchemaIdentity,
  mostRestrictedEvaluatorClassification,
} from './assertion-common.js';
import {
  assertLlmJudgeInvocationResult,
  captureLlmJudgeInvocationPort,
  parseLlmJudgeUsage,
  redactLlmJudgeFailureUsage,
  type OmkLlmJudgeInvocationPort,
  type OmkLlmJudgeInvocationResolver,
  type OmkLlmJudgeInvocationResult,
} from './llm-judge-invocation.js';

export type {
  OmkLlmJudgeInvocationBinding,
  OmkLlmJudgeInvocationPort,
  OmkLlmJudgeInvocationRequest,
  OmkLlmJudgeInvocationResolver,
  OmkLlmJudgeInvocationResult,
} from './llm-judge-invocation.js';

export const LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID =
  'omk.llm-assertions/v2' as const;
export const LLM_ASSERTION_INSTRUMENT_SCHEMA_VERSION =
  'omk.llm-assertion-instrument/v1' as const;
export const LLM_ASSERTION_CONTEXT_SCHEMA_VERSION =
  'omk.llm-assertion-context/v2' as const;
export const LLM_ASSERTION_EVIDENCE_SCHEMA_VERSION =
  'omk.llm-assertion-evidence/v2' as const;
export const LLM_ASSERTION_BINDINGS = Object.freeze({
  actual: 'actual',
  criterion: 'criterion',
});

export type LlmAssertionType =
  | 'semantic_similarity'
  | 'faithfulness'
  | 'answer_relevancy'
  | 'context_recall';

interface LlmAssertionInstrument {
  readonly schemaVersion: typeof LLM_ASSERTION_INSTRUMENT_SCHEMA_VERSION;
  readonly assertionType: LlmAssertionType;
  readonly promptId: string;
  readonly promptHash: string;
}

interface LlmAssertionRuntimeConfig {
  readonly executorId: string;
  readonly model: string;
  readonly deploymentRevision?: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly promptVariant: string;
}

interface LlmAssertionConfig {
  readonly evaluator: {
    readonly classification: 'public' | 'sensitive';
    readonly value: LlmAssertionInstrument;
  };
  readonly runtime: LlmAssertionRuntimeConfig;
}

interface LlmAssertionCriterion {
  readonly schemaVersion: typeof LLM_ASSERTION_CONTEXT_SCHEMA_VERSION;
  readonly criterionId: string;
  readonly assertionType: LlmAssertionType;
  readonly threshold: number;
  readonly weight: number;
  readonly negated: boolean;
  readonly reference?: string;
  readonly context?: string;
  readonly question?: string;
}

const INSTRUMENT_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:llm-assertion-instrument:v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'assertionType', 'promptId', 'promptHash'],
  properties: {
    schemaVersion: { const: LLM_ASSERTION_INSTRUMENT_SCHEMA_VERSION },
    assertionType: {
      enum: ['semantic_similarity', 'faithfulness', 'answer_relevancy', 'context_recall'],
    },
    promptId: { type: 'string', minLength: 1 },
    promptHash: { type: 'string', pattern: '^[0-9a-f]{12}$' },
  },
};

const CONTEXT_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:llm-assertion-context:v2',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'criterionId',
    'assertionType',
    'threshold',
    'weight',
    'negated',
  ],
  properties: {
    schemaVersion: { const: LLM_ASSERTION_CONTEXT_SCHEMA_VERSION },
    criterionId: { type: 'string', minLength: 1, maxLength: 256 },
    assertionType: {
      enum: ['semantic_similarity', 'faithfulness', 'answer_relevancy', 'context_recall'],
    },
    threshold: { type: 'number', minimum: 1, maximum: 5 },
    weight: { type: 'number', exclusiveMinimum: 0 },
    negated: { type: 'boolean' },
    reference: { type: 'string', minLength: 1 },
    context: { type: 'string', minLength: 1 },
    question: { type: 'string', minLength: 1 },
  },
  oneOf: [
    {
      properties: { assertionType: { const: 'semantic_similarity' } },
      required: ['reference'],
    },
    {
      properties: { assertionType: { const: 'faithfulness' } },
      required: ['context'],
    },
    {
      properties: { assertionType: { const: 'answer_relevancy' } },
      required: ['question'],
    },
    {
      properties: { assertionType: { const: 'context_recall' } },
      required: ['reference'],
    },
  ],
};

const EVIDENCE_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:llm-assertion-evidence:v2',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'criterionId',
    'assertionType',
    'threshold',
    'weight',
    'negated',
    'layer',
    'promptId',
    'promptHash',
    'score',
    'rawPassed',
    'reason',
  ],
  properties: {
    schemaVersion: { const: LLM_ASSERTION_EVIDENCE_SCHEMA_VERSION },
    criterionId: { type: 'string' },
    assertionType: { type: 'string' },
    threshold: { type: 'number' },
    weight: { type: 'number', exclusiveMinimum: 0 },
    negated: { type: 'boolean' },
    layer: { const: 'fact' },
    promptId: { type: 'string' },
    promptHash: { type: 'string' },
    score: { type: 'integer', minimum: 1, maximum: 5 },
    rawPassed: { type: 'boolean' },
    reason: { type: 'string', minLength: 1 },
  },
};

export const LLM_ASSERTION_INSTRUMENT_SCHEMA = assertionSchemaIdentity(
  LLM_ASSERTION_INSTRUMENT_SCHEMA_VERSION,
  'urn:omk:llm-assertion-instrument:v1',
  INSTRUMENT_SCHEMA_DOCUMENT,
);
export const LLM_ASSERTION_CONTEXT_SCHEMA = assertionSchemaIdentity(
  LLM_ASSERTION_CONTEXT_SCHEMA_VERSION,
  'urn:omk:llm-assertion-context:v2',
  CONTEXT_SCHEMA_DOCUMENT,
);
export const LLM_ASSERTION_EVIDENCE_SCHEMA = assertionSchemaIdentity(
  LLM_ASSERTION_EVIDENCE_SCHEMA_VERSION,
  'urn:omk:llm-assertion-evidence:v2',
  EVIDENCE_SCHEMA_DOCUMENT,
);

const INSTRUMENTS: Readonly<Record<LlmAssertionType, Readonly<{
  promptId: string;
  promptHash: string;
}>>> = Object.freeze({
  semantic_similarity: {
    promptId: 'semantic-similarity',
    promptHash: getSemanticPromptHash(),
  },
  faithfulness: {
    promptId: 'rag-faithfulness',
    promptHash: getRagJudgePromptHash('faithfulness'),
  },
  answer_relevancy: {
    promptId: 'rag-answer-relevancy',
    promptHash: getRagJudgePromptHash('answer_relevancy'),
  },
  context_recall: {
    promptId: 'rag-context-recall',
    promptHash: getRagJudgePromptHash('context_recall'),
  },
});

const ALGORITHM_VERSION = 'omk.llm-assertion-reading/v2' as const;
const LLM_ASSERTION_TYPES = new Set<LlmAssertionType>([
  'semantic_similarity',
  'faithfulness',
  'answer_relevancy',
  'context_recall',
]);

interface RecordState {
  readonly actual: string;
  readonly criterion: LlmAssertionCriterion;
  readonly instrument: LlmAssertionInstrument;
  readonly runtime: LlmAssertionRuntimeConfig;
  readonly metricId: string;
  readonly evidenceClassification: EvaluatorBindingValue['classification'];
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

function parseInstrument(value: unknown): LlmAssertionInstrument {
  if (!isRecord(value)
      || !exactKeys(value, ['schemaVersion', 'assertionType', 'promptId', 'promptHash'])
      || value.schemaVersion !== LLM_ASSERTION_INSTRUMENT_SCHEMA_VERSION
      || typeof value.assertionType !== 'string'
      || !LLM_ASSERTION_TYPES.has(value.assertionType as LlmAssertionType)
      || typeof value.promptId !== 'string'
      || typeof value.promptHash !== 'string') {
    return failure(
      'omk-llm-assertion-instrument-invalid',
      'LLM assertion instrument configuration is invalid.',
    );
  }
  const assertionType = value.assertionType as LlmAssertionType;
  const expected = INSTRUMENTS[assertionType];
  if (value.promptId !== expected.promptId || value.promptHash !== expected.promptHash) {
    return failure(
      'omk-llm-assertion-prompt-identity-mismatch',
      'LLM assertion prompt identity differs from the frozen registry.',
    );
  }
  return Object.freeze({
    schemaVersion: LLM_ASSERTION_INSTRUMENT_SCHEMA_VERSION,
    assertionType,
    promptId: value.promptId,
    promptHash: value.promptHash,
  });
}

function parseRuntime(value: unknown): LlmAssertionRuntimeConfig {
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
      'omk-llm-assertion-runtime-invalid',
      'LLM assertion runtime configuration is invalid.',
    );
  }
  return Object.freeze({
    executorId: value.executorId,
    model: value.model,
    ...(value.deploymentRevision === undefined
      ? {}
      : { deploymentRevision: value.deploymentRevision }),
    promptVariant: value.promptVariant,
    ...(value.effort === undefined
      ? {}
      : { effort: value.effort as LlmAssertionRuntimeConfig['effort'] }),
  });
}

function parseConfig(value: unknown): LlmAssertionConfig {
  if (!isRecord(value)
      || !exactKeys(value, ['evaluator', 'runtime'])
      || !isRecord(value.evaluator)
      || !exactKeys(value.evaluator, ['classification', 'value'])
      || !['public', 'sensitive'].includes(String(value.evaluator.classification))) {
    return failure(
      'omk-llm-assertion-config-invalid',
      'LLM assertion Evaluator requires a sealed instrument and runtime configuration.',
    );
  }
  const instrument = parseInstrument(value.evaluator.value);
  const runtime = parseRuntime(value.runtime);
  if (runtime.promptVariant !== instrument.promptId) {
    return failure(
      'omk-llm-assertion-prompt-variant-mismatch',
      'LLM assertion runtime prompt variant differs from the sealed instrument.',
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

function parseCriterion(value: unknown): LlmAssertionCriterion {
  if (!isRecord(value)
      || !exactKeys(value, [
        'schemaVersion',
        'criterionId',
        'assertionType',
        'threshold',
        'weight',
        'negated',
        ...('reference' in value ? ['reference'] : []),
        ...('context' in value ? ['context'] : []),
        ...('question' in value ? ['question'] : []),
      ])
      || value.schemaVersion !== LLM_ASSERTION_CONTEXT_SCHEMA_VERSION
      || typeof value.criterionId !== 'string'
      || !IdentifierSchema.safeParse(value.criterionId).success
      || typeof value.assertionType !== 'string'
      || !LLM_ASSERTION_TYPES.has(value.assertionType as LlmAssertionType)
      || typeof value.threshold !== 'number'
      || !Number.isFinite(value.threshold)
      || value.threshold < 1 || value.threshold > 5
      || typeof value.weight !== 'number'
      || !Number.isFinite(value.weight)
      || value.weight <= 0) {
    return failure(
      'omk-llm-assertion-criterion-invalid',
      'LLM assertion criterion is invalid.',
    );
  }
  const assertionType = value.assertionType as LlmAssertionType;
  if (typeof value.negated !== 'boolean') {
    return failure(
      'omk-llm-assertion-criterion-invalid',
      'LLM assertion criterion negation must be explicit.',
    );
  }
  const expectedField = assertionType === 'faithfulness'
    ? 'context'
    : assertionType === 'answer_relevancy'
      ? 'question'
      : 'reference';
  const textFields = ['reference', 'context', 'question'] as const;
  if (textFields.some((field) => (
    value[field] !== undefined
    && (typeof value[field] !== 'string' || value[field] === '')
  ))
      || typeof value[expectedField] !== 'string'
      || value[expectedField] === ''
      || textFields.some((field) => field !== expectedField && value[field] !== undefined)) {
    return failure(
      'omk-llm-assertion-criterion-input-invalid',
      'LLM assertion criterion does not contain its exact required reference input.',
    );
  }
  return Object.freeze({
    schemaVersion: LLM_ASSERTION_CONTEXT_SCHEMA_VERSION,
    criterionId: value.criterionId,
    assertionType,
    threshold: value.threshold,
    weight: value.weight,
    negated: value.negated,
    [expectedField]: value[expectedField],
  }) as unknown as LlmAssertionCriterion;
}

function binding(
  bindings: readonly EvaluatorBindingValue[],
  bindingId: string,
  sourceKind: EvaluatorBindingValue['sourceKind'],
): EvaluatorBindingValue {
  const candidates = bindings.filter((candidate) => candidate.bindingId === bindingId);
  if (candidates.length !== 1 || candidates[0].sourceKind !== sourceKind) {
    return failure(
      'omk-llm-assertion-binding-invalid',
      'LLM assertion Evaluator received an invalid binding set.',
    );
  }
  return candidates[0];
}

function buildPrompt(
  criterion: LlmAssertionCriterion,
  actual: string,
): { system: string; prompt: string } {
  if (criterion.assertionType === 'semantic_similarity') {
    return {
      system: SEMANTIC_SIMILARITY_SYSTEM,
      prompt: buildSemanticSimilarityPrompt(criterion.reference as string, actual),
    };
  }
  const type = criterion.assertionType as RagJudgeType;
  if (type === 'faithfulness') {
    return buildRagJudgePrompt(type, { output: actual, context: criterion.context });
  }
  if (type === 'answer_relevancy') {
    return buildRagJudgePrompt(type, { output: actual, question: criterion.question });
  }
  return buildRagJudgePrompt(type, { output: actual, reference: criterion.reference });
}

type JudgeReading = { readonly score: number; readonly reason: string };

function invalidObservation(
  state: RecordState,
  reasonCode: string,
): EvaluatorObservation {
  return {
    metricId: state.metricId,
    observationStatus: 'invalid',
    valueType: 'boolean',
    reasonCode,
  };
}

function parseReading(
  state: RecordState,
  output: string,
): JudgeReading | EvaluatorObservation {
  const match = output.trim().match(/\{[\s\S]*\}/);
  if (match === null) return invalidObservation(state, 'judge-response-non-json');
  let value: unknown;
  try {
    value = JSON.parse(match[0]);
  } catch {
    return invalidObservation(state, 'judge-response-malformed-json');
  }
  if (!isRecord(value) || typeof value.score !== 'number' || !Number.isInteger(value.score)) {
    return invalidObservation(state, 'judge-score-malformed');
  }
  if (value.score < 1 || value.score > 5) {
    return invalidObservation(state, 'judge-score-out-of-range');
  }
  if (typeof value.reason !== 'string' || value.reason.trim() === '') {
    return invalidObservation(state, 'judge-reason-missing');
  }
  return { score: value.score, reason: value.reason };
}

function observed(
  state: RecordState,
  reading: JudgeReading,
): EvaluatorObservation {
  const rawPassed = reading.score >= state.criterion.threshold;
  return {
    metricId: state.metricId,
    observationStatus: 'observed',
    valueType: 'boolean',
    value: state.criterion.negated ? !rawPassed : rawPassed,
    evidence: {
      value: {
        schemaVersion: LLM_ASSERTION_EVIDENCE_SCHEMA_VERSION,
        criterionId: state.criterion.criterionId,
        assertionType: state.criterion.assertionType,
        threshold: state.criterion.threshold,
        weight: state.criterion.weight,
        negated: state.criterion.negated,
        layer: 'fact',
        promptId: state.instrument.promptId,
        promptHash: state.instrument.promptHash,
        score: reading.score,
        rawPassed,
        reason: reading.reason,
      },
      classification: state.evidenceClassification,
    },
  };
}

export function createLlmAssertionEvaluatorIdentity(input: Readonly<{
  instrument: LlmAssertionInstrument;
  runtime: LlmAssertionRuntimeConfig;
  invocation: OmkLlmJudgeInvocationPort;
}>): RuntimeIdentity {
  const invocation = captureLlmJudgeInvocationPort(input.invocation);
  const capabilities: JsonValue = {
    inputSourceKinds: ['evaluation-context', 'output'],
    metricValueTypes: ['boolean'],
    schemas: [
      LLM_ASSERTION_CONTEXT_SCHEMA,
      LLM_ASSERTION_EVIDENCE_SCHEMA,
      LLM_ASSERTION_INSTRUMENT_SCHEMA,
    ],
    providerCost: invocation.providerCost,
  };
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    implementationId: LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
      runtimeProvenanceCompositionVersion: 'omk.runtime-provenance-composition/v2',
      algorithmVersion: ALGORITHM_VERSION,
      instrument: input.instrument,
      runtime: input.runtime,
      invocationRuntime: invocation.identity,
      capabilities,
    }),
    // Preserve the provider Runtime's evidence strength through composition.
    // Otherwise an opaque remote model would be mislabeled content-derived.
    fingerprintBasis: invocation.identity.fingerprintBasis,
    assuranceLevel: invocation.identity.assuranceLevel,
    capabilities,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }));
}

export function createLlmAssertionEvaluatorImplementation(
  invocation: OmkLlmJudgeInvocationPort,
): SameProcessEvaluatorImplementation<undefined, RecordState> {
  const capturedInvocation = captureLlmJudgeInvocationPort(invocation);
  const implementation: SameProcessEvaluatorImplementation<undefined, RecordState> = {
    openRun: () => undefined,
    openRecord({ record }): RecordState {
      if (record.bindings.length !== 2 || record.evaluatorConfig === undefined) {
        return failure(
          'omk-llm-assertion-record-invalid',
          'LLM assertion Evaluator received an unsupported record configuration.',
        );
      }
      const config = parseConfig(record.evaluatorConfig);
      const actual = binding(record.bindings, LLM_ASSERTION_BINDINGS.actual, 'output');
      const criterionBinding = binding(
        record.bindings,
        LLM_ASSERTION_BINDINGS.criterion,
        'evaluation-context',
      );
      const criterion = parseCriterion(criterionBinding.value);
      if (typeof actual.value !== 'string'
          || record.measurement.instrumentId !== config.evaluator.value.promptId
          || criterion.assertionType !== config.evaluator.value.assertionType
          || record.metrics.length !== 1
          || record.metrics[0].valueType !== 'boolean'
          || record.metrics[0].direction !== 'higher-is-better') {
        return failure(
          'omk-llm-assertion-contract-mismatch',
          'LLM assertion record differs from its sealed instrument or Metric contract.',
        );
      }
      return Object.freeze({
        actual: actual.value,
        criterion,
        instrument: config.evaluator.value,
        runtime: config.runtime,
        metricId: record.metrics[0].metricId,
        evidenceClassification: mostRestrictedEvaluatorClassification(
          actual.classification,
          criterionBinding.classification,
        ),
      });
    },
    async evaluate({ recordState, attempt }) {
      if (attempt.signal.aborted) throw attempt.signal.reason;
      const built = buildPrompt(recordState.criterion, recordState.actual);
      let result: OmkLlmJudgeInvocationResult;
      try {
        result = await capturedInvocation.invoke({
          executorId: recordState.runtime.executorId,
          model: recordState.runtime.model,
          ...(recordState.runtime.effort === undefined
            ? {}
            : { effort: recordState.runtime.effort }),
          system: built.system,
          prompt: built.prompt,
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
      const reading = parseReading(recordState, result.output);
      return {
        observations: ['observationStatus' in reading
          ? reading
          : observed(recordState, reading)],
        ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
      };
    },
    disposeRecord: () => undefined,
    disposeRun: () => undefined,
  };
  return Object.freeze(implementation);
}

/** Builds the host factory without introducing a second control plane for model calls. */
export function createLlmAssertionEvaluatorBindingFactory(
  resolveInvocation: OmkLlmJudgeInvocationResolver,
): (
  context: Readonly<OmkEvaluatorBindingContext>,
) => Promise<OmkRuntimePortBinding<ReturnType<typeof createSameProcessEvaluatorAdapter>>> {
  return async (context) => {
    const config = parseConfig(context.evaluator.config);
    const qualification = context.binding.qualification;
    if (context.evaluator.measurement.instrumentId !== config.evaluator.value.promptId
        || qualification === undefined
        || qualification.executorId !== config.runtime.executorId
        || qualification.model !== config.runtime.model
        || qualification.deploymentRevision !== config.runtime.deploymentRevision
        || qualification.effort !== config.runtime.effort
        || qualification.promptVariant !== config.runtime.promptVariant) {
      return failure(
        'omk-llm-assertion-runtime-binding-mismatch',
        'LLM assertion Runtime binding differs from the sealed Evaluator configuration.',
      );
    }
    const resolved = await resolveInvocation(context);
    const invocation = captureLlmJudgeInvocationPort(resolved.port);
    if (invocation.identity.implementationId !== config.runtime.executorId) {
      return failure(
        'omk-llm-assertion-provider-identity-mismatch',
        'LLM judge invocation Runtime identity differs from the selected executor.',
      );
    }
    const identity = createLlmAssertionEvaluatorIdentity({
      instrument: config.evaluator.value,
      runtime: config.runtime,
      invocation,
    });
    return {
      port: createSameProcessEvaluatorAdapter({
        identity,
        sessionIsolationKey: context.sessionIsolationKey,
        resourceLeases: context.resourceLeases,
        implementation: createLlmAssertionEvaluatorImplementation(invocation),
      }),
      satisfiesVersionConstraint: true,
      preflightDeclarations: resolved.preflightDeclarations,
    };
  };
}

export function llmAssertionInstrument(assertionType: LlmAssertionType): LlmAssertionInstrument {
  const instrument = INSTRUMENTS[assertionType];
  return deepFreezeCanonicalJson({
    schemaVersion: LLM_ASSERTION_INSTRUMENT_SCHEMA_VERSION,
    assertionType,
    promptId: instrument.promptId,
    promptHash: instrument.promptHash,
  });
}
