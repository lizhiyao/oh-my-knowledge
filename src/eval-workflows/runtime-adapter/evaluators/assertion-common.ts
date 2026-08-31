import {
  IdentifierSchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type SchemaIdentity,
} from '../../../evaluation-core/contracts/index.js';
import type { EvaluatorBindingValue } from '../../../evaluation-core/evaluation/index.js';
import { resolveAssertionLayer } from '../../../shared/assertions/layers.js';
import { assertionContractValidationError } from '../../../shared/sample-contract.js';
import type { Assertion } from '../../../types/index.js';

export interface AssertionCriterion {
  readonly criterionId: string;
  readonly metricId: string;
  readonly assertion: Assertion;
}

export function assertionSchemaIdentity(
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

const CLASSIFICATION_LEVEL = { public: 0, sensitive: 1, secret: 2, gold: 3 } as const;

export function mostRestrictedEvaluatorClassification(
  ...values: readonly EvaluatorBindingValue['classification'][]
): EvaluatorBindingValue['classification'] {
  return values.reduce((highest, candidate) => (
    CLASSIFICATION_LEVEL[candidate] > CLASSIFICATION_LEVEL[highest] ? candidate : highest
  ), 'public');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

export function parseAssertionCriteria(
  value: JsonValue,
  input: Readonly<{
    schemaVersion: string;
    supports(assertion: Assertion): boolean;
    fail(code: string, message: string, details?: JsonValue): never;
    errorPrefix: string;
  }>,
): AssertionCriterion[] {
  if (!isRecord(value)
      || !hasExactKeys(value, ['schemaVersion', 'criteria'])
      || value.schemaVersion !== input.schemaVersion
      || !Array.isArray(value.criteria)) {
    return input.fail(
      `${input.errorPrefix}-context-invalid`,
      'Assertion criteria do not match the sealed context schema.',
    );
  }
  const criteria: AssertionCriterion[] = [];
  const criterionIds = new Set<string>();
  const metricIds = new Set<string>();
  for (const [index, candidate] of value.criteria.entries()) {
    if (!isRecord(candidate)
        || !hasExactKeys(candidate, ['criterionId', 'metricId', 'assertion'])
        || typeof candidate.criterionId !== 'string'
        || !IdentifierSchema.safeParse(candidate.criterionId).success
        || typeof candidate.metricId !== 'string'
        || !IdentifierSchema.safeParse(candidate.metricId).success) {
      return input.fail(
        `${input.errorPrefix}-criterion-invalid`,
        'Assertion criterion is malformed.',
        { index },
      );
    }
    if (criterionIds.has(candidate.criterionId) || metricIds.has(candidate.metricId)) {
      return input.fail(
        `${input.errorPrefix}-criterion-duplicate`,
        'Assertion criteria contain duplicate identities.',
        { index },
      );
    }
    const assertionError = assertionContractValidationError(candidate.assertion);
    if (assertionError !== undefined
        || !input.supports(candidate.assertion as unknown as Assertion)) {
      return input.fail(
        `${input.errorPrefix}-contract-invalid`,
        'Assertion criterion is unsupported by this Evaluator.',
        { index },
      );
    }
    criterionIds.add(candidate.criterionId);
    metricIds.add(candidate.metricId);
    criteria.push({
      criterionId: candidate.criterionId,
      metricId: candidate.metricId,
      assertion: structuredClone(candidate.assertion) as unknown as Assertion,
    });
  }
  return criteria;
}

export function assertionDetail(assertion: Assertion, passed: boolean): JsonValue {
  const layer = assertion.type === 'assert-set'
    ? resolveAssertionLayer(assertion)
    : undefined;
  return {
    type: assertion.type,
    value: assertion.value ?? assertion.pattern ?? assertion.values?.join(', ') ?? '',
    weight: assertion.weight ?? 1,
    passed,
    ...(layer === undefined ? {} : { layer }),
  };
}
