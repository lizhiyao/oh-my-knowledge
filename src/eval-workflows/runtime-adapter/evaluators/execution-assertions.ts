import { createRequire } from 'node:module';
import {
  EXECUTION_FACTS_SCHEMA_VERSION,
  ExecutionFactsSchema,
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type ExecutionFacts,
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
  EXECUTION_AWARE_SYNC_ASSERTION_TYPE_NAMES,
  OUTPUT_ONLY_SYNC_ASSERTION_TYPE_NAMES,
  createIsolatedDeterministicAssertionEvaluator,
  deterministicAssertionInputSourceKinds,
  type DeterministicAssertionContext,
  type DeterministicAssertionInputSourceKind,
} from '../../assertions/deterministic.js';
import type { ToolCallInfo } from '../../../executors/contracts/trace.js';
import type { Assertion } from '../../../inputs/contracts/assertion.js';
import type { SameProcessEvaluatorImplementation } from '../adapters/shared/same-process.js';
import {
  SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR,
  SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
  SourceNeutralTraceSchema,
  type SourceNeutralTrace,
} from '../source-neutral-trace.js';
import {
  assertionDetail,
  assertionSchemaIdentity,
  mostRestrictedEvaluatorClassification,
  parseAssertionCriteria,
  type AssertionCriterion,
} from './assertion-common.js';

export const EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID =
  'omk.assertions.execution/v1' as const;
export const EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION =
  'omk.execution-assertion-context/v1' as const;
export const EXECUTION_ASSERTION_EVIDENCE_SCHEMA_VERSION =
  'omk.execution-assertion-evidence/v1' as const;
export const EXECUTION_ASSERTION_BINDINGS = Object.freeze({
  actual: 'actual',
  facts: 'facts',
  trace: 'trace',
  criteria: 'criteria',
});

const requireFromHere = createRequire(import.meta.url);
const AJV_PACKAGE_VERSION = (requireFromHere('ajv/package.json') as { version: string }).version;

const CONTEXT_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:execution-assertion-context:v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'sourceKinds', 'criteria'],
  properties: {
    schemaVersion: { const: EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION },
    sourceKinds: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: ['output', 'execution-facts', 'trace'] },
    },
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
    'every assertion contains at least one execution-aware deterministic leaf',
    'sourceKinds is canonical and contains at least one execution-aware source',
    'every criterion in one evaluator has the same recursive source dependency signature',
    'bindings exactly equal the recursive source union plus evaluation context',
  ],
};

const EVIDENCE_SCHEMA_DOCUMENT: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:omk:execution-assertion-evidence:v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'criterionId', 'assertion', 'detail'],
  properties: {
    schemaVersion: { const: EXECUTION_ASSERTION_EVIDENCE_SCHEMA_VERSION },
    criterionId: { type: 'string' },
    assertion: { type: 'object' },
    detail: { type: 'object' },
  },
};

export const EXECUTION_ASSERTION_CONTEXT_SCHEMA = assertionSchemaIdentity(
  EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION,
  'urn:omk:execution-assertion-context:v1',
  CONTEXT_SCHEMA_DOCUMENT,
);

export const EXECUTION_ASSERTION_EVIDENCE_SCHEMA = assertionSchemaIdentity(
  EXECUTION_ASSERTION_EVIDENCE_SCHEMA_VERSION,
  'urn:omk:execution-assertion-evidence:v1',
  EVIDENCE_SCHEMA_DOCUMENT,
);

const CAPABILITIES: JsonValue = {
  inputSourceKinds: ['evaluation-context', 'execution-facts', 'output', 'trace'],
  metricValueTypes: ['boolean'],
  schemas: [EXECUTION_ASSERTION_CONTEXT_SCHEMA, EXECUTION_ASSERTION_EVIDENCE_SCHEMA],
};

export const EXECUTION_ASSERTION_EVALUATOR_IDENTITY: RuntimeIdentity =
  deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    implementationId: EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      standardId: EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
      algorithmVersion: DETERMINISTIC_ASSERTION_ALGORITHM_VERSION,
      outputAssertionTypes: [...OUTPUT_ONLY_SYNC_ASSERTION_TYPE_NAMES],
      executionAssertionTypes: [...EXECUTION_AWARE_SYNC_ASSERTION_TYPE_NAMES],
      dependencies: { ajv: AJV_PACKAGE_VERSION },
      executionFactsSchemaVersion: EXECUTION_FACTS_SCHEMA_VERSION,
      sourceNeutralTraceSchema: SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR,
      contextSchema: EXECUTION_ASSERTION_CONTEXT_SCHEMA,
      evidenceSchema: EXECUTION_ASSERTION_EVIDENCE_SCHEMA,
      capabilities: CAPABILITIES,
      missingTelemetryPolicy: 'missing-observation',
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }));

interface RecordState {
  readonly output: string;
  readonly facts?: ExecutionFacts;
  readonly trace?: SourceNeutralTrace;
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

function supportsExecutionAssertion(assertion: Assertion): boolean {
  const sources = deterministicAssertionInputSourceKinds(assertion);
  return sources.length > 0 && sources.some((source) => source !== 'output');
}

function signature(assertion: Assertion): string {
  return deterministicAssertionInputSourceKinds(assertion).join('+');
}

const CANONICAL_SOURCE_KINDS = ['output', 'execution-facts', 'trace'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseContext(value: JsonValue): {
  readonly sourceKinds: readonly DeterministicAssertionInputSourceKind[];
  readonly criteria: JsonValue;
} {
  if (!isRecord(value)
      || Object.keys(value).sort().join(',') !== 'criteria,schemaVersion,sourceKinds'
      || value.schemaVersion !== EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION
      || !Array.isArray(value.sourceKinds)
      || !Array.isArray(value.criteria)) {
    return fail(
      'omk-execution-assertion-context-invalid',
      'Execution assertion criteria do not match the sealed context schema.',
    );
  }
  const sourceKinds = value.sourceKinds;
  const canonical = CANONICAL_SOURCE_KINDS.filter((source) => sourceKinds.includes(source));
  if (sourceKinds.length === 0
      || sourceKinds.length !== canonical.length
      || sourceKinds.some((source, index) => source !== canonical[index])
      || !sourceKinds.some((source) => source !== 'output')) {
    return fail(
      'omk-execution-assertion-dependency-invalid',
      'Execution assertion sourceKinds must be a canonical execution-aware dependency signature.',
    );
  }
  return {
    sourceKinds: canonical,
    criteria: {
      schemaVersion: EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION,
      criteria: value.criteria,
    },
  };
}

function bindingFor(
  bindings: readonly EvaluatorBindingValue[],
  bindingId: string,
  sourceKind: EvaluatorBindingValue['sourceKind'],
): EvaluatorBindingValue {
  const candidates = bindings.filter((candidate) => candidate.bindingId === bindingId);
  if (candidates.length !== 1 || candidates[0].sourceKind !== sourceKind) {
    return fail(
      'omk-execution-assertion-binding-invalid',
      'Execution assertion Evaluator received an invalid binding set.',
      { bindingId, sourceKind },
    );
  }
  return candidates[0];
}

function expectedBinding(
  bindings: readonly EvaluatorBindingValue[],
  source: DeterministicAssertionInputSourceKind,
): EvaluatorBindingValue {
  if (source === 'output') {
    return bindingFor(bindings, EXECUTION_ASSERTION_BINDINGS.actual, 'output');
  }
  if (source === 'execution-facts') {
    return bindingFor(bindings, EXECUTION_ASSERTION_BINDINGS.facts, 'execution-facts');
  }
  return bindingFor(bindings, EXECUTION_ASSERTION_BINDINGS.trace, 'trace');
}

function unavailableReason(
  assertion: Assertion,
  facts: ExecutionFacts | undefined,
  trace: SourceNeutralTrace | undefined,
): string | undefined {
  if (assertion.type === 'assert-set') {
    for (const child of assertion.children ?? []) {
      const reason = unavailableReason(child, facts, trace);
      if (reason !== undefined) return reason;
    }
    return undefined;
  }
  if (assertion.type === 'cost_max') {
    const cost = facts?.usage.providerCost;
    if (cost?.reportingStatus !== 'reported') return 'provider-cost-unavailable';
    if (cost.currency !== 'USD') return 'provider-cost-currency-unsupported';
  }
  if (assertion.type === 'latency_max'
      && facts?.timing.wallClockDurationMs.reportingStatus !== 'reported') {
    return 'wall-clock-duration-unavailable';
  }
  if (assertion.type === 'mock_hit' && trace?.mockStats === undefined) {
    return 'mock-stats-unavailable';
  }
  return undefined;
}

function deterministicContext(
  facts: ExecutionFacts | undefined,
  trace: SourceNeutralTrace | undefined,
): DeterministicAssertionContext {
  const providerCost = facts?.usage.providerCost;
  const wallClock = facts?.timing.wallClockDurationMs;
  return {
    ...(providerCost?.reportingStatus === 'reported' && providerCost.currency === 'USD'
      ? { costUSD: providerCost.amount }
      : {}),
    ...(wallClock?.reportingStatus === 'reported' ? { durationMs: wallClock.value } : {}),
    ...(trace === undefined ? {} : {
      numTurns: trace.numTurns,
      toolCalls: trace.toolCalls as unknown as readonly ToolCallInfo[],
      ...(trace.mockStats === undefined ? {} : { mockStats: trace.mockStats }),
    }),
  };
}

function observation(
  state: RecordState,
  criterion: AssertionCriterion,
): EvaluatorObservation {
  const reasonCode = unavailableReason(criterion.assertion, state.facts, state.trace);
  if (reasonCode !== undefined) {
    return {
      metricId: criterion.metricId,
      observationStatus: 'missing',
      valueType: 'boolean',
      reasonCode,
    };
  }
  const passed = state.evaluateAssertion(
    state.output,
    criterion.assertion,
    deterministicContext(state.facts, state.trace),
  );
  return {
    metricId: criterion.metricId,
    observationStatus: 'observed',
    valueType: 'boolean',
    value: passed,
    evidence: {
      value: {
        schemaVersion: EXECUTION_ASSERTION_EVIDENCE_SCHEMA_VERSION,
        criterionId: criterion.criterionId,
        assertion: structuredClone(criterion.assertion) as unknown as JsonValue,
        detail: assertionDetail(criterion.assertion, passed),
      },
      classification: state.evidenceClassification,
    },
  };
}

export function createExecutionAssertionEvaluatorImplementation():
SameProcessEvaluatorImplementation<undefined, RecordState> {
  const implementation: SameProcessEvaluatorImplementation<undefined, RecordState> = {
    openRun: () => undefined,
    openRecord({ record }): RecordState {
      if (record.evaluatorConfig !== undefined) {
        return fail(
          'omk-execution-assertion-record-invalid',
          'Execution assertion Evaluator received an unsupported record configuration.',
        );
      }
      const criteriaBinding = bindingFor(
        record.bindings,
        EXECUTION_ASSERTION_BINDINGS.criteria,
        'evaluation-context',
      );
      const context = parseContext(criteriaBinding.value);
      const criteria = parseAssertionCriteria(context.criteria, {
        schemaVersion: EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION,
        supports: supportsExecutionAssertion,
        fail,
        errorPrefix: 'omk-execution-assertion',
      });
      const declaredSignature = context.sourceKinds.join('+');
      if (criteria.some((criterion) => signature(criterion.assertion) !== declaredSignature)) {
        return fail(
          'omk-execution-assertion-dependency-mixed',
          'Execution assertion criteria must match the declared source dependency signature.',
        );
      }
      const sources = context.sourceKinds;
      if (record.bindings.length !== sources.length + 1) {
        return fail(
          'omk-execution-assertion-binding-invalid',
          'Execution assertion bindings exceed or omit the recursive source dependency union.',
        );
      }
      const sourceBindings = sources.map((source) => expectedBinding(record.bindings, source));
      let output = '';
      let facts: ExecutionFacts | undefined;
      let trace: SourceNeutralTrace | undefined;
      for (const [index, source] of sources.entries()) {
        const sourceBinding = sourceBindings[index];
        if (source === 'output') {
          if (typeof sourceBinding.value !== 'string') {
            return fail(
              'omk-execution-assertion-actual-invalid',
              'Execution assertion Evaluator requires a string output.',
            );
          }
          output = sourceBinding.value;
        } else if (source === 'execution-facts') {
          const parsed = ExecutionFactsSchema.safeParse(sourceBinding.value);
          if (!parsed.success) {
            return fail(
              'omk-execution-assertion-facts-invalid',
              'Execution assertion Evaluator requires canonical execution facts.',
            );
          }
          facts = parsed.data;
        } else {
          const parsed = SourceNeutralTraceSchema.safeParse(sourceBinding.value);
          if (!parsed.success) {
            return fail(
              'omk-execution-assertion-trace-invalid',
              `Execution assertion Evaluator requires ${SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION}.`,
            );
          }
          trace = parsed.data;
        }
      }
      const declaredMetricIds = new Set(record.metrics.map((metric) => metric.metricId));
      if (record.metrics.some((metric) => (
        metric.valueType !== 'boolean' || metric.direction !== 'higher-is-better'
      )) || criteria.some((criterion) => !declaredMetricIds.has(criterion.metricId))) {
        return fail(
          'omk-execution-assertion-metric-invalid',
          'Execution assertion criteria require declared higher-is-better Boolean Metrics.',
        );
      }
      return Object.freeze({
        output,
        ...(facts === undefined ? {} : { facts }),
        ...(trace === undefined ? {} : { trace }),
        evaluateAssertion: createIsolatedDeterministicAssertionEvaluator(),
        criteriaByMetricId: new Map(criteria.map((criterion) => [criterion.metricId, criterion])),
        metricIds: record.metrics.map((metric) => metric.metricId),
        evidenceClassification: mostRestrictedEvaluatorClassification(
          criteriaBinding.classification,
          ...sourceBindings.map((sourceBinding) => sourceBinding.classification),
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
          : observation(recordState, criterion));
      }
      if (attempt.signal.aborted) throw attempt.signal.reason;
      return { observations };
    },
    disposeRecord: () => undefined,
    disposeRun: () => undefined,
  };
  return Object.freeze(implementation);
}
