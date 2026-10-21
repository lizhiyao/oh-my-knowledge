import { compareStrings } from '../../primitives/ordering.js';
import { z } from 'zod';
import { canonicalizeJson, parseWireDocument, schemaIdentityKey, type CoreSchemaValidator, type JsonValue, type SchemaIdentity } from '../../contracts/index.js';
import { EvaluationDefinitionError } from '../errors.js';
import { type PreparationRuntime } from '../types.js';

const CONTRACT_PATH_SEGMENTS = new Set([
  'schemaVersion', 'dataset', 'datasetId', 'samples', 'sampleId', 'input',
  'executionContext', 'expected', 'evaluationContext', 'analysis', 'analysisCohorts',
  'cohortId', 'cohortSetId', 'cohortSetKind', 'classification', 'disclosure',
  'derivation', 'algorithmId', 'membershipValue', 'context', 'annotations', 'targets',
  'targetId', 'targetKind', 'protocolId', 'executorId', 'versionConstraint', 'config',
  'executionRequirements', 'systemInstructions', 'workspace', 'mcp',
  'executionControls', 'defaults', 'sampleOverrides', 'workspaceMode', 'descriptor',
  'resourceId', 'digest', 'mediaType', 'size', 'tools', 'toolPolicyKind', 'allowedTools',
  'mockInterception', 'mockInterceptionMode', 'toolPolicy', 'toolPolicies', 'skillDiscovery',
  'sandboxId', 'sandboxIds', 'protocols', 'inputSchema', 'outputSchema', 'traceSchema',
  'concurrency', 'safety', 'maxInFlight', 'cancellation', 'state',
  'resourceLifecycle', 'trialState', 'seedControl', 'determinism', 'features',
  'telemetry', 'usage', 'providerCost', 'reporting', 'trustedUpperBound',
  'evaluators', 'evaluatorId', 'evaluatorKind', 'implementationId', 'measurement',
  'applicableSampleIds', 'instrumentId', 'ensembleMemberId', 'replicateGroupId',
  'replicateIndex', 'metricIds',
  'inputs', 'bindingId', 'sourceKind', 'pointer', 'metrics', 'metricId', 'valueType',
  'scope', 'scale', 'min', 'max', 'target', 'unit', 'direction', 'missingPolicyId',
  'experiment', 'trials', 'seed', 'sampling', 'experimentalUnit', 'pairingKey',
  'clusterKey', 'stratumKey', 'repeatedMeasures', 'resamplingUnit', 'estimatorId',
  'seedCoupling', 'randomizationSlots', 'randomizationSlotId', 'schedulingTargetGroups',
  'scheduling', 'schedulingKind', 'blockSize', 'analysisGraph', 'analysisMode', 'nodes', 'nodeId',
  'analysisNodeKind', 'inputKind', 'referenceId', 'outputResultId', 'cohortFilter',
  'includeCohortIds', 'excludeCohortIds', 'parameters',
  'comparisons', 'comparisonId', 'controlTargetId', 'treatmentTargetIds',
  'decisionPolicy', 'decisionPolicyId', 'analysisResultIds', 'comparisonFamily',
  'comparisonFamilyResultId', 'hypothesisId', 'treatmentTargetId',
  'multipleComparisonPolicyId', 'minimumEvidenceStatus', 'execution', 'timeoutMs',
  'maxConcurrency', 'retry', 'maxAttempts', 'retryableErrorCodes', 'backoff',
  'backoffKind', 'initialDelayMs', 'maxDelayMs', 'budget', 'run', 'stages',
  'coordinate', 'attempt', 'maxInvocations', 'maxWallClockMs', 'maxActiveDurationMs',
  'maxProviderCost', 'providerCostAdmission', 'admissionMode', 'unknownCostMode',
  'amount', 'currency', 'cache', 'executionMode',
  'evaluationMode', 'evidence', 'output', 'trace', 'maximumClassification', 'failure',
  'failureMode', 'maxFailures', 'eventDelivery', 'writerMode', 'backpressureMode',
  'writerFailureMode', 'extensions', 'schemaUri', 'schemaDigest', 'data',
  'seriesMembership', 'seriesDesignDigest', 'memberId',
]);

function safeSchemaDetails(error: z.ZodError): {
  issues: Array<{ code: string; path: Array<string | number> }>;
} {
  return {
    issues: error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map((part) => {
        if (typeof part === 'number') return part;
        if (typeof part === 'symbol') return '*';
        return CONTRACT_PATH_SEGMENTS.has(part) ? part : '*';
      }),
    })),
  };
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown, documentKind: string): T {
  try {
    return parseWireDocument(schema, value);
  } catch (error) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_SCHEMA_INVALID',
      stage: 'configuration',
      preparationStage: 'schema',
      message: `${documentKind} 不符合当前 Evaluation Core wire contract。`,
      ...(error instanceof z.ZodError ? { details: safeSchemaDetails(error) } : {}),
    });
  }
}

export function parseCapabilities<T>(
  schema: z.ZodType<T>,
  capabilities: JsonValue,
  referenceId: string,
): T {
  const result = schema.safeParse(capabilities);
  if (result.success) return result.data;
  throw new EvaluationDefinitionError({
    code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
    stage: 'configuration',
    preparationStage: 'runtime-resolution',
    message: 'Runtime capability manifest 不符合 Compiler 要求。',
    details: { referenceId, ...safeSchemaDetails(result.error) },
  });
}

export function addSchemaIdentity(
  identitiesByUri: Map<string, SchemaIdentity>,
  identity: SchemaIdentity,
  referenceId: string,
): void {
  const existing = identitiesByUri.get(identity.schemaUri);
  if (existing === undefined) {
    identitiesByUri.set(identity.schemaUri, identity);
    return;
  }
  if (existing.schemaVersion === identity.schemaVersion
      && existing.schemaDigest === identity.schemaDigest) return;
  throw new EvaluationDefinitionError({
    code: 'EVAL_DEFINITION_PROTOCOL_INVALID',
    stage: 'configuration',
    preparationStage: 'runtime-resolution',
    message: '同一 schema URI 被解析为冲突的 schema identity。',
    details: { referenceId, schemaUri: identity.schemaUri },
  });
}

export function addCapabilitySchemas(
  identitiesByUri: Map<string, SchemaIdentity>,
  identities: readonly SchemaIdentity[],
  referenceId: string,
): void {
  for (const identity of identities) addSchemaIdentity(identitiesByUri, identity, referenceId);
}

export function requireSchemaValidator(
  runtime: PreparationRuntime,
  identity: SchemaIdentity,
  referenceId: string,
): CoreSchemaValidator {
  const validator = runtime.schemaValidators.get(schemaIdentityKey(identity));
  if (validator !== undefined
      && canonicalizeJson(validator.schema) === canonicalizeJson(identity)) return validator;
  throw new EvaluationDefinitionError({
    code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
    stage: 'configuration',
    preparationStage: 'runtime-resolution',
    message: 'Runtime 声明的 schema identity 缺少 Core 绑定的精确 validator。',
    details: { referenceId, schemaUri: identity.schemaUri },
  });
}

export function sortSchemaIdentities(
  identitiesByUri: ReadonlyMap<string, SchemaIdentity>,
): SchemaIdentity[] {
  return [...identitiesByUri.values()].sort((left, right) => (
    compareStrings(left.schemaUri, right.schemaUri)
    || compareStrings(left.schemaVersion, right.schemaVersion)
    || compareStrings(left.schemaDigest, right.schemaDigest)
  ));
}
