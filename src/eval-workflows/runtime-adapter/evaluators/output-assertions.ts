import { createRequire } from 'node:module';
import {
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
} from '../../../evaluation-core/contracts/index.js';
import {
  EvaluationPortFailure,
  type EvaluatorBindingValue,
  type EvaluatorObservation,
} from '../../../evaluation-core/evaluation/index.js';
import {
  DETERMINISTIC_ASSERTION_ALGORITHM_VERSION,
  OUTPUT_ONLY_SYNC_ASSERTION_TYPE_NAMES,
  assertionUsesOnlyOutput,
  createIsolatedDeterministicAssertionEvaluator,
  type DeterministicAssertionContext,
} from '../../../shared/assertions/deterministic.js';
import type { Assertion } from '../../../types/index.js';
import type { SameProcessEvaluatorImplementation } from '../adapters/same-process.js';
import {
  assertionDetail,
  assertionSchemaIdentity,
  mostRestrictedAssertionClassification,
  parseAssertionCriteria,
  type AssertionCriterion,
} from './assertion-common.js';

export const OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID =
  'omk.assertions.output/v1' as const;
export const OUTPUT_ASSERTION_CONTEXT_SCHEMA_VERSION =
  'omk.output-assertion-context/v1' as const;
export const OUTPUT_ASSERTION_EVIDENCE_SCHEMA_VERSION =
  'omk.output-assertion-evidence/v1' as const;
export const OUTPUT_ASSERTION_BINDINGS = Object.freeze({
  actual: 'actual',
  criteria: 'criteria',
});

const requireFromHere = createRequire(import.meta.url);
const AJV_PACKAGE_VERSION = (requireFromHere('ajv/package.json') as { version: string }).version;

const CONTEXT_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:output-assertion-context:v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'criteria'],
  properties: {
    schemaVersion: { const: OUTPUT_ASSERTION_CONTEXT_SCHEMA_VERSION },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterionId', 'metricId', 'assertion'],
        properties: {
          criterionId: { type: 'string', minLength: 1, maxLength: 256 },
          metricId: { type: 'string', minLength: 1, maxLength: 256 },
          assertion: { type: 'object' },
        },
      },
    },
  },
  'x-omk-invariants': [
    'criterionId and metricId are unique identifiers',
    'every assertion satisfies the OMK assertion contract',
    'every assertion recursively uses output-only deterministic leaves',
  ],
};

const EVIDENCE_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:output-assertion-evidence:v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'criterionId', 'assertion', 'detail'],
  properties: {
    schemaVersion: { const: OUTPUT_ASSERTION_EVIDENCE_SCHEMA_VERSION },
    criterionId: { type: 'string' },
    assertion: { type: 'object' },
    detail: { type: 'object' },
  },
};

export const OUTPUT_ASSERTION_CONTEXT_SCHEMA = assertionSchemaIdentity(
  OUTPUT_ASSERTION_CONTEXT_SCHEMA_VERSION,
  'urn:omk:output-assertion-context:v1',
  CONTEXT_SCHEMA_DOCUMENT,
);

export const OUTPUT_ASSERTION_EVIDENCE_SCHEMA = assertionSchemaIdentity(
  OUTPUT_ASSERTION_EVIDENCE_SCHEMA_VERSION,
  'urn:omk:output-assertion-evidence:v1',
  EVIDENCE_SCHEMA_DOCUMENT,
);

const CAPABILITIES: JsonValue = {
  inputSourceKinds: ['evaluation-context', 'output'],
  metricValueTypes: ['boolean'],
  schemas: [OUTPUT_ASSERTION_CONTEXT_SCHEMA, OUTPUT_ASSERTION_EVIDENCE_SCHEMA],
};

const OUTPUT_ASSERTION_RUNTIME_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      standardId: OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
      algorithmVersion: DETERMINISTIC_ASSERTION_ALGORITHM_VERSION,
      assertionTypes: [...OUTPUT_ONLY_SYNC_ASSERTION_TYPE_NAMES],
      dependencies: { ajv: AJV_PACKAGE_VERSION },
      contextSchema: OUTPUT_ASSERTION_CONTEXT_SCHEMA,
      evidenceSchema: OUTPUT_ASSERTION_EVIDENCE_SCHEMA,
      capabilities: CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export const OUTPUT_ASSERTION_EVALUATOR_IDENTITY: RuntimeIdentity =
  OUTPUT_ASSERTION_RUNTIME_IDENTITY;

interface RecordState {
  readonly output: string;
  readonly evaluateAssertion: (
    output: string,
    assertion: Assertion,
    context?: DeterministicAssertionContext,
  ) => boolean;
  readonly criteriaByMetricId: ReadonlyMap<string, AssertionCriterion>;
  readonly metricIds: readonly string[];
  readonly evidenceClassification: EvaluatorBindingValue['classification'];
}

function fail(code: string, message: string, details?: JsonValue): never {
  throw new EvaluationPortFailure({
    code,
    stage: 'evaluation',
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function binding(
  bindings: readonly EvaluatorBindingValue[],
  bindingId: string,
  sourceKind: EvaluatorBindingValue['sourceKind'],
): EvaluatorBindingValue {
  const candidates = bindings.filter((candidate) => candidate.bindingId === bindingId);
  if (candidates.length !== 1 || candidates[0].sourceKind !== sourceKind) {
    return fail(
      'omk-output-assertion-binding-invalid',
      'Output assertion Evaluator received an invalid binding set.',
      { bindingId, sourceKind },
    );
  }
  return candidates[0];
}

function observed(
  state: RecordState,
  criterion: AssertionCriterion,
): EvaluatorObservation {
  const passed = state.evaluateAssertion(state.output, criterion.assertion);
  return {
    metricId: criterion.metricId,
    observationStatus: 'observed',
    valueType: 'boolean',
    value: passed,
    evidence: {
      value: {
        schemaVersion: OUTPUT_ASSERTION_EVIDENCE_SCHEMA_VERSION,
        criterionId: criterion.criterionId,
        assertion: structuredClone(criterion.assertion) as unknown as JsonValue,
        detail: assertionDetail(criterion.assertion, passed),
      },
      classification: state.evidenceClassification,
    },
  };
}

export function createOutputAssertionEvaluatorImplementation(): SameProcessEvaluatorImplementation<
  undefined,
  RecordState
> {
  const implementation: SameProcessEvaluatorImplementation<undefined, RecordState> = {
    openRun: () => undefined,
    openRecord({ record }): RecordState {
      if (record.evaluatorConfig !== undefined || record.bindings.length !== 2) {
        return fail(
          'omk-output-assertion-record-invalid',
          'Output assertion Evaluator received an unsupported record configuration.',
        );
      }
      const actual = binding(record.bindings, OUTPUT_ASSERTION_BINDINGS.actual, 'output');
      const criteriaBinding = binding(
        record.bindings,
        OUTPUT_ASSERTION_BINDINGS.criteria,
        'evaluation-context',
      );
      if (typeof actual.value !== 'string') {
        return fail(
          'omk-output-assertion-actual-invalid',
          'Output assertion Evaluator requires a string output.',
        );
      }
      const criteria = parseAssertionCriteria(criteriaBinding.value, {
        schemaVersion: OUTPUT_ASSERTION_CONTEXT_SCHEMA_VERSION,
        supports: assertionUsesOnlyOutput,
        fail,
        errorPrefix: 'omk-output-assertion',
      });
      const declaredMetricIds = new Set(record.metrics.map((metric) => metric.metricId));
      if (record.metrics.some((metric) => (
        metric.valueType !== 'boolean' || metric.direction !== 'higher-is-better'
      ))
          || criteria.some((criterion) => !declaredMetricIds.has(criterion.metricId))) {
        return fail(
          'omk-output-assertion-metric-invalid',
          'Output assertion criteria require declared higher-is-better Boolean Metrics.',
        );
      }
      return Object.freeze({
        output: actual.value,
        evaluateAssertion: createIsolatedDeterministicAssertionEvaluator(),
        criteriaByMetricId: new Map(criteria.map((criterion) => [criterion.metricId, criterion])),
        metricIds: record.metrics.map((metric) => metric.metricId),
        evidenceClassification: mostRestrictedAssertionClassification(
          actual.classification,
          criteriaBinding.classification,
        ),
      });
    },
    async evaluate({ recordState, attempt }) {
      const observations: EvaluatorObservation[] = [];
      for (const metricId of recordState.metricIds) {
        if (attempt.signal.aborted) throw attempt.signal.reason;
        const criterion = recordState.criteriaByMetricId.get(metricId);
        observations.push(criterion === undefined
          ? {
              metricId,
              observationStatus: 'missing',
              valueType: 'boolean',
              reasonCode: 'criterion-not-applicable',
            }
          : observed(recordState, criterion));
      }
      if (attempt.signal.aborted) throw attempt.signal.reason;
      return { observations };
    },
    disposeRecord: () => undefined,
    disposeRun: () => undefined,
  };
  return Object.freeze(implementation);
}
