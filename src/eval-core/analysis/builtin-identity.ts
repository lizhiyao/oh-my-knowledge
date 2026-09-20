/**
 * 内建分析节点与决策策略的运行时身份：能力声明、指纹 facet 与派生串（全部是冻结的摘要输入）。
 */
import { compareStrings } from '../primitives/ordering.js';
import {
  canonicalizeJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
} from '../contracts/index.js';
import {
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BUILTIN_SCALAR_RESULT_SCHEMA,
  BUILTIN_SIMULTANEOUS_INTERVAL_FAMILY_RESULT_SCHEMA,
  FAMILY_RELEASE_PARAMETERS_SCHEMA,
  PROGRESS_PARAMETERS_SCHEMA,
} from './builtin-schemas.js';

export function runtimeIdentity(
  implementationId: string,
  capabilities: JsonValue,
  fingerprintFacets?: JsonValue,
): RuntimeIdentity {
  const version = '1.0.0';
  return {
    implementationId,
    version,
    fingerprint: digestCanonicalJson({
      implementationId,
      version,
      capabilities,
      ...(fingerprintFacets === undefined ? {} : { fingerprintFacets }),
    }),
    // A builtin can declare its release identity, but it cannot independently
    // attest that the executing code matches that declaration.
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  };
}


export function nodeCapabilities(input: {
  analysisNodeKind: 'reducer' | 'estimator' | 'correction';
  valueTypes?: Array<'numeric' | 'boolean'>;
  missingPolicyIds?: string[];
  analysisResultSchemaUris?: string[];
  analysisResultCardinality?: { min: number; max?: number };
  metricObservationCardinality?: { min: number; max?: number };
  comparison?: boolean;
  outputSchema: SchemaIdentity;
  parameterSchema: SchemaIdentity;
  sampling?: {
    assignmentKinds: Array<'complete-block' | 'independent-groups'>;
    experimentalUnits: Array<'sample' | 'run' | 'cluster'>;
    repeatedMeasures: boolean[];
    resamplingUnits: Array<'sample' | 'paired-block' | 'cluster' | 'run'>;
  };
}): JsonValue {
  const inputDomains: JsonValue[] = [];
  if (input.valueTypes !== undefined) {
    inputDomains.push({
      inputKind: 'metric-observations',
      valueTypes: [...input.valueTypes].sort(),
      ...(input.missingPolicyIds !== undefined
        ? { missingPolicyIds: [...input.missingPolicyIds].sort() }
        : {}),
    });
  }
  if (input.analysisResultSchemaUris !== undefined) {
    inputDomains.push({
      inputKind: 'analysis-result',
      schemaUris: [...input.analysisResultSchemaUris].sort(),
    });
  }
  if (input.comparison === true) inputDomains.push({ inputKind: 'comparison' });
  inputDomains.sort((left, right) => {
    const leftCanonical = canonicalizeJson(left);
    const rightCanonical = canonicalizeJson(right);
    return compareStrings(leftCanonical, rightCanonical);
  });
  return {
    capabilityKind: 'analysis-node',
    analysisNodeKinds: [input.analysisNodeKind],
    inputDomains,
    outputSchema: input.outputSchema,
    parameterSchema: input.parameterSchema,
    inputCardinalities: {
      metricObservations: input.valueTypes !== undefined
        ? input.metricObservationCardinality ?? { min: 1, max: 1 }
        : { min: 0, max: 0 },
      analysisResults: input.analysisResultSchemaUris !== undefined
        ? input.analysisResultCardinality ?? { min: 1 }
        : { min: 0, max: 0 },
      comparisons: input.comparison === true ? { min: 1, max: 1 } : { min: 0, max: 0 },
    },
    ...(input.sampling !== undefined ? {
      sampling: {
        assignmentKinds: [...input.sampling.assignmentKinds].sort(),
        experimentalUnits: [...input.sampling.experimentalUnits].sort(),
        repeatedMeasures: [...input.sampling.repeatedMeasures].sort(
          (left, right) => Number(left) - Number(right),
        ),
        resamplingUnits: [...input.sampling.resamplingUnits].sort(),
      },
    } : {}),
    schemas: [],
  };
}


export const EXCLUDE_CAPABILITIES: JsonValue = {
  capabilityKind: 'missing-policy',
  valueTypes: ['boolean', 'categorical', 'numeric', 'ranking', 'text'],
  schemas: [],
};


export const PROGRESS_V1_DECISION_CAPABILITIES: JsonValue = {
  capabilityKind: 'decision-policy',
  analysisResultSchemaUris: [
    BUILTIN_INTERVAL_RESULT_SCHEMA.schemaUri,
    BUILTIN_SCALAR_RESULT_SCHEMA.schemaUri,
  ].sort(),
  multipleComparisonPolicyIds: [],
  parameterSchema: PROGRESS_PARAMETERS_SCHEMA,
  schemas: [],
};


export const PROGRESS_V2_DECISION_CAPABILITIES: JsonValue = {
  capabilityKind: 'decision-policy',
  analysisResultSchemaUris: [BUILTIN_INTERVAL_RESULT_SCHEMA.schemaUri],
  multipleComparisonPolicyIds: [],
  parameterSchema: PROGRESS_PARAMETERS_SCHEMA,
  schemas: [],
};


export const FAMILY_RELEASE_DECISION_CAPABILITIES: JsonValue = {
  capabilityKind: 'decision-policy',
  analysisResultSchemaUris: [BUILTIN_SIMULTANEOUS_INTERVAL_FAMILY_RESULT_SCHEMA.schemaUri],
  multipleComparisonPolicyIds: ['simultaneous-intervals.bonferroni/v1'],
  parameterSchema: FAMILY_RELEASE_PARAMETERS_SCHEMA,
  schemas: [],
};


export const PROGRESS_V1_DECISION_FINGERPRINT_FACETS: JsonValue = {
  decisionOutputContract: 'decided-verdict-with-reason-codes/v1',
  reasonRules: {
    progress: 'effect-above-progress-threshold',
    regression: 'effect-below-regression-threshold',
    noise: 'effect-within-equivalence-band',
    notDecided: 'decision-effect-unavailable',
  },
};


export const PROGRESS_V2_DECISION_FINGERPRINT_FACETS: JsonValue = {
  decisionOutputContract: 'interval-bounded-verdict-with-reason-codes/v2',
  directionRule: 'confidence-interval-must-exclude-threshold-plus-equivalence-band',
  reasonRules: {
    progress: 'interval-above-progress-boundary',
    regression: 'interval-below-regression-boundary',
    noise: 'interval-overlaps-decision-boundary',
    notDecided: 'decision-interval-unavailable',
  },
};


export const FAMILY_RELEASE_DECISION_FINGERPRINT_FACETS: JsonValue = {
  decisionOutputContract: 'all-member-bounded-release/v1',
  effectRule: 'raw-treatment-minus-control-interval',
  equalityRule: 'bounds-are-inclusive-for-acceptance',
  reasonRules: {
    release: 'all-family-criteria-acceptable',
    block: 'family-criterion-unacceptable',
    notDecided: 'family-criterion-uncertain',
    unavailable: 'decision-family-contract-unavailable',
  },
};

