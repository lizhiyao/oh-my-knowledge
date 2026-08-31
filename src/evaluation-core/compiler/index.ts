import { z } from 'zod';
import {
  ANALYSIS_PLAN_SCHEMA_VERSION,
  DECISION_PLAN_SCHEMA_VERSION,
  EVALUATION_PLAN_SCHEMA_VERSION,
  EXECUTION_PLAN_SCHEMA_VERSION,
  EvaluationDefinitionSchema,
  MeasurementPolicySchema,
  RUN_PLAN_SCHEMA_VERSION,
  RunPlanSchema,
  canonicalizeJson,
  computePlanDigests,
  deriveSchedulingTargetGroups,
  generateRunContractSchemaIdentities,
  parseWireDocument,
  projectExecutionExperimentDesign,
  projectEvaluationInputs,
  projectAnalysisInputs,
  projectAnalysisCohorts,
  projectAnalysisGraph,
  projectExecutionInputs,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type ExtensionEntry,
  type Extensions,
  type JsonValue,
  type MeasurementPolicy,
  type ResolvedRuntime,
  type RuntimeIdentity,
  type SchemaIdentity,
  type TargetExecutionRequirements,
} from '../contracts/index.js';
import {
  EvaluationDefinitionError,
} from './errors.js';
import { deepFreeze, snapshotJson } from './immutability.js';
import {
  AnalysisCapabilitiesSchema,
  EvaluatorCapabilitiesSchema,
  ExecutorCapabilitiesSchema,
  ExtensionResolutionSchema,
  RuntimeResolutionSchema,
  type AnalysisCapabilities,
  type AnalysisNodeCapabilities,
  type AnalysisRuntimeRequirement,
  type DecisionPolicyCapabilities,
  type MissingPolicyCapabilities,
  type EvaluatorCapabilities,
  type ExecutorCapabilities,
  type ExtensionImpactStage,
  type PreparationRuntime,
  type SealedRunPlan,
} from './types.js';
import {
  validateAnalysisInputs,
  validateDefinitionSemantics,
} from './validation.js';
import { sealRunPlan } from '../internal/sealed-run-plan.js';

export * from './errors.js';
export * from './types.js';
export { assertSealedRunPlan } from '../internal/sealed-run-plan.js';
export { validateDefinitionSemantics } from './validation.js';

interface StageExtensions {
  execution?: Extensions;
  evaluation?: Extensions;
  analysis?: Extensions;
  decision?: Extensions;
  run?: Extensions;
}

interface ResolvedAnalysisRuntime {
  runtime: ResolvedRuntime;
  capabilities: AnalysisNodeCapabilities;
}

const CONTRACT_PATH_SEGMENTS = new Set([
  'schemaVersion', 'dataset', 'datasetId', 'samples', 'sampleId', 'input',
  'executionContext', 'expected', 'evaluationContext', 'analysis', 'analysisCohorts',
  'cohortId', 'cohortSetId', 'cohortSetKind', 'classification', 'disclosure',
  'derivation', 'algorithmId', 'membershipValue', 'context', 'annotations', 'targets',
  'targetId', 'targetKind', 'protocolId', 'executorId', 'versionConstraint', 'config',
  'executionRequirements', 'systemInstructions', 'workspace', 'mcp',
  'mockInterception', 'toolPolicy', 'toolPolicies', 'skillDiscovery',
  'sandboxId', 'sandboxIds', 'protocols', 'inputSchema', 'outputSchema', 'traceSchema',
  'concurrency', 'safety', 'maxInFlight', 'cancellation', 'state',
  'resourceLifecycle', 'trialState', 'seedControl', 'determinism', 'features',
  'telemetry', 'usage', 'providerCost', 'reporting', 'trustedUpperBound',
  'evaluators', 'evaluatorId', 'evaluatorKind', 'implementationId', 'measurement',
  'instrumentId', 'ensembleMemberId', 'replicateGroupId', 'replicateIndex', 'metricIds',
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

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

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

function sortedUniqueStrings(
  values: readonly string[],
  referenceId: string,
  field: string,
): string[] {
  if (new Set(values).size !== values.length) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Runtime capability manifest 包含重复声明。',
      details: { referenceId, field },
    });
  }
  return [...values].sort(compareStrings);
}

function sortedSchemas(identities: readonly SchemaIdentity[]): SchemaIdentity[] {
  return [...identities].sort((left, right) => (
    compareStrings(left.schemaUri, right.schemaUri)
    || compareStrings(left.schemaVersion, right.schemaVersion)
    || compareStrings(left.schemaDigest, right.schemaDigest)
  ));
}

function bindCapabilities(
  identity: RuntimeIdentity,
  capabilities: ExecutorCapabilities | EvaluatorCapabilities | AnalysisCapabilities,
): RuntimeIdentity {
  return {
    ...identity,
    capabilities: snapshotJson(capabilities) as JsonValue,
  };
}

function normalizeExecutorCapabilities(
  capabilities: ExecutorCapabilities,
  referenceId: string,
): ExecutorCapabilities {
  return {
    schemaVersion: capabilities.schemaVersion,
    protocols: capabilities.protocols.map((protocol) => ({
      ...protocol,
      execution: {
        ...protocol.execution,
        features: {
          ...protocol.execution.features,
          workspace: sortedUniqueStrings(
            protocol.execution.features.workspace,
            referenceId,
            `${protocol.protocolId}.features.workspace`,
          ) as typeof protocol.execution.features.workspace,
          mcp: sortedUniqueStrings(
            protocol.execution.features.mcp,
            referenceId,
            `${protocol.protocolId}.features.mcp`,
          ) as typeof protocol.execution.features.mcp,
          mockInterception: sortedUniqueStrings(
            protocol.execution.features.mockInterception,
            referenceId,
            `${protocol.protocolId}.features.mockInterception`,
          ) as typeof protocol.execution.features.mockInterception,
          toolPolicies: sortedUniqueStrings(
            protocol.execution.features.toolPolicies,
            referenceId,
            `${protocol.protocolId}.features.toolPolicies`,
          ) as typeof protocol.execution.features.toolPolicies,
          skillDiscovery: sortedUniqueStrings(
            protocol.execution.features.skillDiscovery,
            referenceId,
            `${protocol.protocolId}.features.skillDiscovery`,
          ) as typeof protocol.execution.features.skillDiscovery,
          sandboxIds: sortedUniqueStrings(
            protocol.execution.features.sandboxIds,
            referenceId,
            `${protocol.protocolId}.features.sandboxIds`,
          ),
        },
      },
    })).sort((left, right) => compareStrings(left.protocolId, right.protocolId)),
  };
}

function assertExecutionRequirementsSupported(
  referenceId: string,
  requirements: TargetExecutionRequirements,
  features: ExecutorCapabilities['protocols'][number]['execution']['features'],
): void {
  const unsupported = (
    field: keyof TargetExecutionRequirements,
    required: string,
    supported: readonly string[],
  ): never => {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Target execution requirement 不受 Runtime 支持。',
      details: { referenceId, field, required, supported: [...supported] },
    });
  };
  if (requirements.systemInstructions === 'required'
      && features.systemInstructions === 'unsupported') {
    unsupported('systemInstructions', 'required', [features.systemInstructions]);
  }
  if (requirements.workspace !== 'not-required'
      && !features.workspace.includes(requirements.workspace)) {
    unsupported('workspace', requirements.workspace, features.workspace);
  }
  if (requirements.mcp !== 'not-required' && !features.mcp.includes(requirements.mcp)) {
    unsupported('mcp', requirements.mcp, features.mcp);
  }
  if (requirements.mockInterception !== 'not-required'
      && !features.mockInterception.includes(requirements.mockInterception)) {
    unsupported(
      'mockInterception',
      requirements.mockInterception,
      features.mockInterception,
    );
  }
  if (!features.toolPolicies.includes(requirements.toolPolicy)) {
    unsupported('toolPolicy', requirements.toolPolicy, features.toolPolicies);
  }
  if (!features.skillDiscovery.includes(requirements.skillDiscovery)) {
    unsupported('skillDiscovery', requirements.skillDiscovery, features.skillDiscovery);
  }
  if (requirements.sandboxId !== undefined
      && !features.sandboxIds.includes(requirements.sandboxId)) {
    unsupported('sandboxId', requirements.sandboxId, features.sandboxIds);
  }
}

function normalizeEvaluatorCapabilities(
  capabilities: EvaluatorCapabilities,
  referenceId: string,
): EvaluatorCapabilities {
  return {
    inputSourceKinds: sortedUniqueStrings(
      capabilities.inputSourceKinds,
      referenceId,
      'inputSourceKinds',
    ) as EvaluatorCapabilities['inputSourceKinds'],
    metricValueTypes: sortedUniqueStrings(
      capabilities.metricValueTypes,
      referenceId,
      'metricValueTypes',
    ) as EvaluatorCapabilities['metricValueTypes'],
    schemas: sortedSchemas(capabilities.schemas),
    ...(capabilities.providerCost === undefined
      ? {}
      : { providerCost: snapshotJson(capabilities.providerCost) }),
  };
}

function normalizeAnalysisCapabilities(
  capabilities: AnalysisCapabilities,
  referenceId: string,
): AnalysisCapabilities {
  if (capabilities.capabilityKind === 'missing-policy') {
    return {
      capabilityKind: 'missing-policy',
      valueTypes: sortedUniqueStrings(
        capabilities.valueTypes,
        referenceId,
        'valueTypes',
      ) as MissingPolicyCapabilities['valueTypes'],
      schemas: sortedSchemas(capabilities.schemas),
    };
  }
  if (capabilities.capabilityKind === 'decision-policy') {
    return {
      capabilityKind: 'decision-policy',
      analysisResultSchemaUris: sortedUniqueStrings(
        capabilities.analysisResultSchemaUris,
        referenceId,
        'analysisResultSchemaUris',
      ),
      multipleComparisonPolicyIds: sortedUniqueStrings(
        capabilities.multipleComparisonPolicyIds,
        referenceId,
        'multipleComparisonPolicyIds',
      ),
      parameterSchema: capabilities.parameterSchema,
      schemas: sortedSchemas(capabilities.schemas),
    } as DecisionPolicyCapabilities;
  }
  const inputDomains = capabilities.inputDomains.map((domain) => (
    domain.inputKind === 'metric-observations'
      ? {
        ...domain,
        valueTypes: sortedUniqueStrings(
          domain.valueTypes,
          referenceId,
          'inputDomains.valueTypes',
        ) as typeof domain.valueTypes,
        ...(domain.missingPolicyIds !== undefined ? {
          missingPolicyIds: sortedUniqueStrings(
            domain.missingPolicyIds,
            referenceId,
            'inputDomains.missingPolicyIds',
          ),
        } : {}),
      }
      : domain.inputKind === 'analysis-result' ? {
        ...domain,
        schemaUris: sortedUniqueStrings(
          domain.schemaUris,
          referenceId,
          'inputDomains.schemaUris',
        ),
      } : domain
  )).sort((left, right) => (
    compareStrings(canonicalizeJson(left), canonicalizeJson(right))
  ));
  if (new Set(inputDomains.map((domain) => canonicalizeJson(domain))).size
      !== inputDomains.length) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Runtime capability manifest 包含重复 input domain。',
      details: { referenceId, field: 'inputDomains' },
    });
  }
  if (capabilities.sampling !== undefined
      && new Set(capabilities.sampling.repeatedMeasures).size
        !== capabilities.sampling.repeatedMeasures.length) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Runtime capability manifest 包含重复声明。',
      details: { referenceId, field: 'sampling.repeatedMeasures' },
    });
  }
  return {
    capabilityKind: 'analysis-node',
    analysisNodeKinds: sortedUniqueStrings(
      capabilities.analysisNodeKinds,
      referenceId,
      'analysisNodeKinds',
    ) as AnalysisNodeCapabilities['analysisNodeKinds'],
    inputDomains,
    outputSchema: capabilities.outputSchema,
    parameterSchema: capabilities.parameterSchema,
    inputCardinalities: capabilities.inputCardinalities,
    ...(capabilities.sampling !== undefined ? {
      sampling: {
        experimentalUnits: sortedUniqueStrings(
          capabilities.sampling.experimentalUnits,
          referenceId,
          'sampling.experimentalUnits',
        ) as NonNullable<AnalysisNodeCapabilities['sampling']>['experimentalUnits'],
        repeatedMeasures: [...capabilities.sampling.repeatedMeasures].sort(
          (left, right) => Number(left) - Number(right),
        ),
        resamplingUnits: sortedUniqueStrings(
          capabilities.sampling.resamplingUnits,
          referenceId,
          'sampling.resamplingUnits',
        ) as NonNullable<AnalysisNodeCapabilities['sampling']>['resamplingUnits'],
      },
    } : {}),
    schemas: sortedSchemas(capabilities.schemas),
  };
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, documentKind: string): T {
  try {
    return parseWireDocument(schema, value);
  } catch (error) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_SCHEMA_INVALID',
      stage: 'configuration',
      preparationStage: 'schema',
      message: `${documentKind} 不符合 Evaluation Core v1 wire contract。`,
      ...(error instanceof z.ZodError ? { details: safeSchemaDetails(error) } : {}),
    });
  }
}

async function resolveRuntime(
  referenceId: string,
  resolver: () => unknown | Promise<unknown>,
): Promise<z.infer<typeof RuntimeResolutionSchema>> {
  let raw: unknown;
  try {
    raw = await resolver();
  } catch (error) {
    if (error instanceof EvaluationDefinitionError) throw error;
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_RUNTIME_RESOLUTION_FAILED',
      stage: 'infrastructure',
      preparationStage: 'runtime-resolution',
      message: 'Runtime resolver 无法解析所需实现。',
      details: { referenceId },
      causes: [{
        code: 'EVAL_RUNTIME_PROVIDER_FAILURE',
        stage: 'infrastructure',
        message: 'Runtime provider 返回失败。',
      }],
    });
  }
  try {
    return parseWireDocument(RuntimeResolutionSchema, raw);
  } catch {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_RUNTIME_RESOLUTION_FAILED',
      stage: 'infrastructure',
      preparationStage: 'runtime-resolution',
      message: 'Runtime resolver 返回了无效的解析结果。',
      details: { referenceId },
    });
  }
}

function parseCapabilities<T>(
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

function assertVersionSatisfied(
  referenceId: string,
  versionConstraint: string | undefined,
  satisfied: boolean,
): void {
  if (satisfied) return;
  throw new EvaluationDefinitionError({
    code: 'EVAL_DEFINITION_RUNTIME_RESOLUTION_FAILED',
    stage: 'configuration',
    preparationStage: 'runtime-resolution',
    message: '解析出的 Runtime 不满足声明的版本约束。',
    details: {
      referenceId,
      ...(versionConstraint !== undefined ? { versionConstraint } : {}),
    },
  });
}

function addSchemaIdentity(
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

function addCapabilitySchemas(
  identitiesByUri: Map<string, SchemaIdentity>,
  identities: readonly SchemaIdentity[],
  referenceId: string,
): void {
  for (const identity of identities) addSchemaIdentity(identitiesByUri, identity, referenceId);
}

function requireSchemaValidator(
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

async function resolveExecutors(
  definition: z.infer<typeof EvaluationDefinitionSchema>,
  policy: MeasurementPolicy,
  runtime: PreparationRuntime,
  identitiesByUri: Map<string, SchemaIdentity>,
): Promise<ResolvedRuntime[]> {
  const resolved: ResolvedRuntime[] = [];
  for (const target of definition.targets) {
    const resolution = await resolveRuntime(
      target.targetId,
      () => runtime.resolveExecutor(deepFreeze(snapshotJson({
        referenceId: target.targetId,
        executorId: target.executorId,
        ...(target.versionConstraint !== undefined
          ? { versionConstraint: target.versionConstraint }
          : {}),
        protocolId: target.protocolId,
        executionRequirements: target.executionRequirements,
      }))),
    );
    assertVersionSatisfied(
      target.targetId,
      target.versionConstraint,
      resolution.satisfiesVersionConstraint,
    );
    const capabilities = normalizeExecutorCapabilities(
      parseCapabilities(
        ExecutorCapabilitiesSchema,
        resolution.identity.capabilities,
        target.targetId,
      ),
      target.targetId,
    );
    const protocolIds = capabilities.protocols.map((protocol) => protocol.protocolId);
    if (new Set(protocolIds).size !== protocolIds.length) {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_PROTOCOL_INVALID',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'Executor capability manifest 包含重复 protocolId。',
        details: { referenceId: target.targetId },
      });
    }
    const protocol = capabilities.protocols.find(
      (candidate) => candidate.protocolId === target.protocolId,
    );
    if (protocol === undefined) {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_PROTOCOL_INVALID',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'Executor 不支持 Target 声明的 protocol。',
        details: { referenceId: target.targetId, protocolId: target.protocolId },
      });
    }
    assertExecutionRequirementsSupported(
      target.targetId,
      target.executionRequirements,
      protocol.execution.features,
    );
    const expectedTrialState = target.protocolId === 'omk.session/v1'
      ? 'isolated'
      : 'stateless';
    if (protocol.execution.state.trialState !== expectedTrialState) {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_PROTOCOL_INVALID',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'Protocol manifest 的 trial state isolation 与 protocol family 不兼容。',
        details: { referenceId: target.targetId, protocolId: target.protocolId },
      });
    }
    if (protocol.execution.concurrency.safety === 'serialized'
        && protocol.execution.concurrency.maxInFlight !== undefined
        && protocol.execution.concurrency.maxInFlight !== 1) {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'serialized Runtime 的 maxInFlight 只能为 1。',
        details: { referenceId: target.targetId },
      });
    }
    const traceCapability = protocol.execution.telemetry.trace;
    if ((traceCapability === 'unsupported') === (protocol.traceSchema !== undefined)) {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'Runtime trace capability 与 trace schema identity 不一致。',
        details: { referenceId: target.targetId },
      });
    }
    const requiresTrace = definition.evaluators.some((evaluator) => (
      evaluator.inputs.some((binding) => binding.sourceKind === 'trace')
    ));
    if (requiresTrace && traceCapability === 'unsupported') {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'Evaluator 需要 trace，但 Target Runtime 不提供 trace。',
        details: { referenceId: target.targetId },
      });
    }
    if (policy.execution.timeoutMs !== undefined
        && protocol.execution.cancellation === 'unsupported') {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: '声明 timeout 的 Target Runtime 必须支持 cooperative 或 best-effort cancellation。',
        details: { referenceId: target.targetId },
      });
    }
    const { seedCoupling } = definition.experiment.sampling;
    const { determinism, seedControl } = protocol.execution;
    if (seedCoupling !== 'uncontrolled'
        && determinism !== 'deterministic'
        && seedControl === 'unsupported') {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: '随机 Target 必须支持 seed control，才能兑现声明的 seed coupling。',
        details: { referenceId: target.targetId, seedCoupling },
      });
    }
    if (seedCoupling === 'uncontrolled' && seedControl === 'required') {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: '要求 seed 的 Target Runtime 不能使用 uncontrolled seed design。',
        details: { referenceId: target.targetId, seedCoupling },
      });
    }
    if (policy.cache.executionMode === 'transparent-deterministic'
        && (protocol.execution.determinism !== 'deterministic'
          || resolution.identity.assuranceLevel !== 'verified')) {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'transparent-deterministic cache 只能用于 verified deterministic Target。',
        details: { referenceId: target.targetId, protocolId: target.protocolId },
      });
    }
    addCapabilitySchemas(
      identitiesByUri,
      [
        protocol.inputSchema,
        protocol.outputSchema,
        ...(protocol.traceSchema !== undefined ? [protocol.traceSchema] : []),
      ],
      target.targetId,
    );
    resolved.push({
      runtimeKind: 'executor',
      referenceId: target.targetId,
      identity: bindCapabilities(resolution.identity, capabilities),
    });
  }
  return resolved;
}

async function resolveEvaluators(
  definition: z.infer<typeof EvaluationDefinitionSchema>,
  runtime: PreparationRuntime,
  identitiesByUri: Map<string, SchemaIdentity>,
): Promise<ResolvedRuntime[]> {
  const metricsById = new Map(definition.metrics.map((metric) => [metric.metricId, metric]));
  const resolved: ResolvedRuntime[] = [];
  for (const evaluator of definition.evaluators) {
    const resolution = await resolveRuntime(
      evaluator.evaluatorId,
      () => runtime.resolveEvaluator(deepFreeze(snapshotJson({
        referenceId: evaluator.evaluatorId,
        implementationId: evaluator.implementationId,
        ...(evaluator.versionConstraint !== undefined
          ? { versionConstraint: evaluator.versionConstraint }
          : {}),
      }))),
    );
    assertVersionSatisfied(
      evaluator.evaluatorId,
      evaluator.versionConstraint,
      resolution.satisfiesVersionConstraint,
    );
    const capabilities = normalizeEvaluatorCapabilities(
      parseCapabilities(
        EvaluatorCapabilitiesSchema,
        resolution.identity.capabilities,
        evaluator.evaluatorId,
      ),
      evaluator.evaluatorId,
    );
    for (const binding of evaluator.inputs) {
      if (capabilities.inputSourceKinds.includes(binding.sourceKind)) continue;
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'Evaluator 不支持声明的 input binding source。',
        details: {
          referenceId: evaluator.evaluatorId,
          bindingId: binding.bindingId,
          sourceKind: binding.sourceKind,
        },
      });
    }
    for (const metricId of evaluator.metricIds) {
      const valueType = metricsById.get(metricId)?.valueType;
      if (valueType !== undefined && capabilities.metricValueTypes.includes(valueType)) continue;
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'Evaluator 不支持声明的 Metric valueType。',
        details: { referenceId: evaluator.evaluatorId, metricId },
      });
    }
    addCapabilitySchemas(identitiesByUri, capabilities.schemas, evaluator.evaluatorId);
    resolved.push({
      runtimeKind: 'evaluator',
      referenceId: evaluator.evaluatorId,
      identity: bindCapabilities(resolution.identity, capabilities),
    });
  }
  return resolved;
}

async function resolveAnalysisRequirement(
  runtime: PreparationRuntime,
  requirement: Extract<AnalysisRuntimeRequirement, {
    requirementKind: 'analysis-node' | 'sampling-estimator';
  }>,
  identitiesByUri: Map<string, SchemaIdentity>,
): Promise<ResolvedAnalysisRuntime> {
  const resolution = await resolveRuntime(
    requirement.referenceId,
    () => runtime.resolveAnalysis(deepFreeze(snapshotJson(requirement))),
  );
  assertVersionSatisfied(
    requirement.referenceId,
    requirement.versionConstraint,
    resolution.satisfiesVersionConstraint,
  );
  const capabilities = normalizeAnalysisCapabilities(
    parseCapabilities(
      AnalysisCapabilitiesSchema,
      resolution.identity.capabilities,
      requirement.referenceId,
    ),
    requirement.referenceId,
  );
  if (capabilities.capabilityKind !== 'analysis-node') {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Analysis node Runtime 返回了错误的 capability kind。',
      details: { referenceId: requirement.referenceId },
    });
  }
  if (!capabilities.analysisNodeKinds.includes(requirement.analysisNodeKind)) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Analysis implementation 不支持声明的 node kind。',
      details: {
        referenceId: requirement.referenceId,
        analysisNodeKind: requirement.analysisNodeKind,
      },
    });
  }
  requireSchemaValidator(runtime, capabilities.outputSchema, requirement.referenceId);
  requireSchemaValidator(runtime, capabilities.parameterSchema, requirement.referenceId);
  addCapabilitySchemas(
    identitiesByUri,
    [capabilities.outputSchema, capabilities.parameterSchema, ...capabilities.schemas],
    requirement.referenceId,
  );
  return {
    runtime: {
      runtimeKind: 'analysis-node',
      referenceId: requirement.referenceId,
      identity: bindCapabilities(resolution.identity, capabilities),
    },
    capabilities,
  };
}

async function resolveAnalysisRuntimes(
  definition: z.infer<typeof EvaluationDefinitionSchema>,
  runtime: PreparationRuntime,
  identitiesByUri: Map<string, SchemaIdentity>,
): Promise<ResolvedRuntime[]> {
  const byNodeId = new Map<string, ResolvedAnalysisRuntime>();
  for (const node of definition.analysisGraph.nodes) {
    byNodeId.set(node.nodeId, await resolveAnalysisRequirement(runtime, {
      referenceId: node.nodeId,
      implementationId: node.implementationId,
      ...(node.versionConstraint !== undefined
        ? { versionConstraint: node.versionConstraint }
        : {}),
      analysisNodeKind: node.analysisNodeKind,
      requirementKind: 'analysis-node',
    }, identitiesByUri));
  }

  const samplingReferenceId = definition.experiment.sampling.estimatorId;
  const samplingEstimator = await resolveAnalysisRequirement(runtime, {
    referenceId: samplingReferenceId,
    implementationId: definition.experiment.sampling.estimatorId,
    analysisNodeKind: 'estimator',
    requirementKind: 'sampling-estimator',
  }, identitiesByUri);
  const samplingCapabilities = samplingEstimator.capabilities.sampling;
  const sampling = definition.experiment.sampling;
  if (samplingCapabilities === undefined
      || !samplingCapabilities.experimentalUnits.includes(sampling.experimentalUnit)
      || !samplingCapabilities.repeatedMeasures.includes(sampling.repeatedMeasures)
      || !samplingCapabilities.resamplingUnits.includes(sampling.resamplingUnit)) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'Estimator 不支持声明的 SamplingDesign。',
      details: { referenceId: samplingReferenceId },
    });
  }

  const metricsById = new Map(definition.metrics.map((metric) => [metric.metricId, metric]));
  const outputSchemasByResultId = new Map<string, string>();
  for (const node of definition.analysisGraph.nodes) {
    const resolved = byNodeId.get(node.nodeId);
    if (resolved !== undefined) {
      outputSchemasByResultId.set(
        node.outputResultId,
        resolved.capabilities.outputSchema.schemaUri,
      );
    }
  }
  for (const node of definition.analysisGraph.nodes) {
    const resolved = byNodeId.get(node.nodeId);
    if (resolved !== undefined) {
      validateAnalysisInputs(node, resolved.capabilities, metricsById, outputSchemasByResultId);
    }
  }

  const missingPolicyRuntimes: ResolvedRuntime[] = [];
  const valueTypesByPolicy = new Map<string, Set<string>>();
  for (const metric of definition.metrics) {
    const valueTypes = valueTypesByPolicy.get(metric.missingPolicyId) ?? new Set<string>();
    valueTypes.add(metric.valueType);
    valueTypesByPolicy.set(metric.missingPolicyId, valueTypes);
  }
  for (const missingPolicyId of [...valueTypesByPolicy.keys()].sort(compareStrings)) {
    const requirement = {
      referenceId: missingPolicyId,
      implementationId: missingPolicyId,
      requirementKind: 'missing-policy' as const,
    };
    const resolution = await resolveRuntime(
      missingPolicyId,
      () => runtime.resolveAnalysis(deepFreeze(snapshotJson(requirement))),
    );
    assertVersionSatisfied(missingPolicyId, undefined, resolution.satisfiesVersionConstraint);
    const capabilities = normalizeAnalysisCapabilities(
      parseCapabilities(
        AnalysisCapabilitiesSchema,
        resolution.identity.capabilities,
        missingPolicyId,
      ),
      missingPolicyId,
    );
    if (capabilities.capabilityKind !== 'missing-policy'
        || [...(valueTypesByPolicy.get(missingPolicyId) ?? [])].some(
          (valueType) => !capabilities.valueTypes.includes(
            valueType as MissingPolicyCapabilities['valueTypes'][number],
          ),
        )) {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'MissingPolicy Runtime 不支持声明的 Metric 值域。',
        details: { referenceId: missingPolicyId },
      });
    }
    addCapabilitySchemas(identitiesByUri, capabilities.schemas, missingPolicyId);
    missingPolicyRuntimes.push({
      runtimeKind: 'missing-policy',
      referenceId: missingPolicyId,
      identity: bindCapabilities(resolution.identity, capabilities),
    });
  }

  return [
    ...definition.analysisGraph.nodes.map((node) => byNodeId.get(node.nodeId)?.runtime)
      .filter((entry): entry is ResolvedRuntime => entry !== undefined),
    samplingEstimator.runtime,
    ...missingPolicyRuntimes,
  ];
}

async function resolveDecisionRuntimes(
  definition: z.infer<typeof EvaluationDefinitionSchema>,
  runtime: PreparationRuntime,
  analysisRuntimes: readonly ResolvedRuntime[],
  identitiesByUri: Map<string, SchemaIdentity>,
): Promise<ResolvedRuntime[]> {
  const policy = definition.decisionPolicy;
  if (policy === undefined) return [];
  const requirement = {
    referenceId: policy.decisionPolicyId,
    implementationId: policy.implementationId,
    ...(policy.versionConstraint !== undefined
      ? { versionConstraint: policy.versionConstraint }
      : {}),
    requirementKind: 'decision-policy' as const,
  };
  const resolution = await resolveRuntime(
    policy.decisionPolicyId,
    () => runtime.resolveAnalysis(deepFreeze(snapshotJson(requirement))),
  );
  assertVersionSatisfied(
    policy.decisionPolicyId,
    policy.versionConstraint,
    resolution.satisfiesVersionConstraint,
  );
  const capabilities = normalizeAnalysisCapabilities(
    parseCapabilities(
      AnalysisCapabilitiesSchema,
      resolution.identity.capabilities,
      policy.decisionPolicyId,
    ),
    policy.decisionPolicyId,
  );
  if (capabilities.capabilityKind !== 'decision-policy') {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'DecisionPolicy Runtime 返回了错误的 capability kind。',
      details: { referenceId: policy.decisionPolicyId },
    });
  }
  requireSchemaValidator(runtime, capabilities.parameterSchema, policy.decisionPolicyId);
  if (policy.multipleComparisonPolicyId !== undefined
      && !capabilities.multipleComparisonPolicyIds.includes(
        policy.multipleComparisonPolicyId,
      )) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'DecisionPolicy Runtime 不支持声明的 multiple-comparison policy。',
      details: { referenceId: policy.decisionPolicyId },
    });
  }
  const nodeByResultId = new Map(definition.analysisGraph.nodes.map(
    (node) => [node.outputResultId, node.nodeId],
  ));
  const runtimeByNodeId = new Map(analysisRuntimes
    .filter((entry) => entry.runtimeKind === 'analysis-node')
    .map((entry) => [entry.referenceId, entry]));
  for (const resultId of policy.analysisResultIds) {
    const nodeId = nodeByResultId.get(resultId);
    const nodeRuntime = nodeId === undefined ? undefined : runtimeByNodeId.get(nodeId);
    const parsed = nodeRuntime === undefined ? undefined : AnalysisCapabilitiesSchema.safeParse(
      nodeRuntime.identity.capabilities,
    );
    const schemaUri = parsed?.success === true
      && parsed.data.capabilityKind === 'analysis-node'
      ? parsed.data.outputSchema.schemaUri
      : undefined;
    if (schemaUri !== undefined
        && capabilities.analysisResultSchemaUris.includes(schemaUri)) continue;
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
      message: 'DecisionPolicy Runtime 不接受声明的 AnalysisResult schema。',
      details: { referenceId: policy.decisionPolicyId, resultId },
    });
  }
  addCapabilitySchemas(
    identitiesByUri,
    [capabilities.parameterSchema, ...capabilities.schemas],
    policy.decisionPolicyId,
  );
  return [{
    runtimeKind: 'decision-policy',
    referenceId: policy.decisionPolicyId,
    identity: bindCapabilities(resolution.identity, capabilities),
  }];
}

function normalizeDefinitionParameters(
  definition: z.infer<typeof EvaluationDefinitionSchema>,
  analysisRuntimes: readonly ResolvedRuntime[],
  decisionRuntimes: readonly ResolvedRuntime[],
  runtime: PreparationRuntime,
): z.infer<typeof EvaluationDefinitionSchema> {
  const analysisRuntimeByNodeId = new Map(analysisRuntimes
    .filter((entry) => entry.runtimeKind === 'analysis-node')
    .map((entry) => [entry.referenceId, entry]));
  const nodes = definition.analysisGraph.nodes.map((node) => {
    const resolved = analysisRuntimeByNodeId.get(node.nodeId);
    const capabilities = resolved === undefined ? undefined : AnalysisCapabilitiesSchema.safeParse(
      resolved.identity.capabilities,
    );
    if (capabilities?.success !== true || capabilities.data.capabilityKind !== 'analysis-node') {
      throw new TypeError('Resolved Analysis capabilities disappeared before sealing.');
    }
    const validator = requireSchemaValidator(
      runtime,
      capabilities.data.parameterSchema,
      node.nodeId,
    );
    try {
      return {
        ...node,
        parameters: validator.parse(node.parameters ?? {}),
      };
    } catch {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'Analysis node parameters 不符合实现声明的 schema。',
        details: { nodeId: node.nodeId },
      });
    }
  });
  let decisionPolicy = definition.decisionPolicy;
  if (decisionPolicy !== undefined) {
    const resolved = decisionRuntimes.find((entry) => entry.runtimeKind === 'decision-policy');
    const capabilities = resolved === undefined ? undefined : AnalysisCapabilitiesSchema.safeParse(
      resolved.identity.capabilities,
    );
    if (capabilities?.success !== true || capabilities.data.capabilityKind !== 'decision-policy') {
      throw new TypeError('Resolved Decision capabilities disappeared before sealing.');
    }
    const validator = requireSchemaValidator(
      runtime,
      capabilities.data.parameterSchema,
      decisionPolicy.decisionPolicyId,
    );
    try {
      decisionPolicy = {
        ...decisionPolicy,
        parameters: validator.parse(decisionPolicy.parameters ?? {}),
      };
    } catch {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'DecisionPolicy parameters 不符合实现声明的 schema。',
        details: { referenceId: decisionPolicy.decisionPolicyId },
      });
    }
  }
  return parseInput(EvaluationDefinitionSchema, {
    ...definition,
    analysisGraph: { ...definition.analysisGraph, nodes },
    ...(decisionPolicy !== undefined ? { decisionPolicy } : {}),
  }, 'EvaluationDefinition');
}

function appendExtension(
  stageExtensions: StageExtensions,
  stage: Exclude<ExtensionImpactStage, 'audit'>,
  namespace: string,
  entry: ExtensionEntry,
): void {
  const current = stageExtensions[stage] ?? {};
  stageExtensions[stage] = { ...current, [namespace]: entry };
}

async function resolveExtensions(
  definitionExtensions: Extensions | undefined,
  policyExtensions: Extensions | undefined,
  runtime: PreparationRuntime,
): Promise<StageExtensions> {
  const requests = [
    ...Object.entries(definitionExtensions ?? {}).map(([namespace, entry]) => ({
      namespace,
      source: 'definition' as const,
      entry,
    })),
    ...Object.entries(policyExtensions ?? {}).map(([namespace, entry]) => ({
      namespace,
      source: 'measurement-policy' as const,
      entry,
    })),
  ].sort((left, right) => compareStrings(left.namespace, right.namespace)
    || compareStrings(left.source, right.source));
  const namespaces = requests.map((request) => request.namespace);
  if (new Set(namespaces).size !== namespaces.length) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_EXTENSION_INVALID',
      stage: 'configuration',
      preparationStage: 'extension-resolution',
      message: 'Definition 与 MeasurementPolicy 不能重复声明同一 extension namespace。',
    });
  }
  if (requests.length > 0 && runtime.validateExtension === undefined) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_EXTENSION_INVALID',
      stage: 'configuration',
      preparationStage: 'extension-resolution',
      message: '存在 extension，但 PreparationRuntime 未提供 extension validator。',
    });
  }

  const stageExtensions: StageExtensions = {};
  for (const request of requests) {
    let raw: unknown;
    try {
      raw = await runtime.validateExtension?.(deepFreeze(snapshotJson(request)));
    } catch {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_EXTENSION_INVALID',
        stage: 'configuration',
        preparationStage: 'extension-resolution',
        message: 'Extension schema 校验失败。',
        details: { namespace: request.namespace, source: request.source },
      });
    }
    let resolution: z.infer<typeof ExtensionResolutionSchema>;
    try {
      resolution = parseWireDocument(ExtensionResolutionSchema, raw);
    } catch {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_EXTENSION_INVALID',
        stage: 'configuration',
        preparationStage: 'extension-resolution',
        message: 'Extension validator 未返回明确的阶段影响。',
        details: { namespace: request.namespace, source: request.source },
      });
    }
    if (resolution.impactStage !== 'audit') {
      appendExtension(
        stageExtensions,
        resolution.impactStage,
        request.namespace,
        request.entry,
      );
    }
  }
  return stageExtensions;
}

function sortSchemaIdentities(
  identitiesByUri: ReadonlyMap<string, SchemaIdentity>,
): SchemaIdentity[] {
  return [...identitiesByUri.values()].sort((left, right) => (
    compareStrings(left.schemaUri, right.schemaUri)
    || compareStrings(left.schemaVersion, right.schemaVersion)
    || compareStrings(left.schemaDigest, right.schemaDigest)
  ));
}

export function normalizeEvaluationDefinition(
  definitionInput: unknown,
): z.infer<typeof EvaluationDefinitionSchema> {
  const definition = parseInput(
    EvaluationDefinitionSchema,
    definitionInput,
    'EvaluationDefinition',
  );
  return parseInput(EvaluationDefinitionSchema, {
    ...definition,
    dataset: {
      ...definition.dataset,
      samples: definition.dataset.samples.map((sample) => ({
        ...sample,
        ...(sample.analysis === undefined ? {} : {
          analysis: {
            ...sample.analysis,
            memberships: [...sample.analysis.memberships].sort((left, right) => (
              compareStrings(left.cohortId, right.cohortId)
            )),
          },
        }),
      })),
      ...(definition.dataset.analysisCohorts === undefined ? {} : {
        analysisCohorts: projectAnalysisCohorts(definition.dataset),
      }),
    },
    analysisGraph: projectAnalysisGraph(definition.analysisGraph),
  }, 'EvaluationDefinition');
}

export async function prepareEvaluationPlan(
  definitionInput: unknown,
  measurementPolicyInput: unknown,
  runtime: PreparationRuntime,
): Promise<SealedRunPlan> {
  let definition = normalizeEvaluationDefinition(definitionInput);
  const measurementPolicy = parseInput(
    MeasurementPolicySchema,
    measurementPolicyInput,
    'MeasurementPolicy',
  );
  validateDefinitionSemantics(definition, measurementPolicy);

  const identitiesByUri = new Map<string, SchemaIdentity>();
  for (const identity of generateRunContractSchemaIdentities()) {
    addSchemaIdentity(identitiesByUri, identity, identity.schemaVersion);
  }
  const executorRuntimes = await resolveExecutors(
    definition,
    measurementPolicy,
    runtime,
    identitiesByUri,
  );
  const evaluatorRuntimes = await resolveEvaluators(definition, runtime, identitiesByUri);
  const analysisRuntimes = await resolveAnalysisRuntimes(definition, runtime, identitiesByUri);
  const decisionRuntimes = await resolveDecisionRuntimes(
    definition,
    runtime,
    analysisRuntimes,
    identitiesByUri,
  );
  definition = normalizeDefinitionParameters(
    definition,
    analysisRuntimes,
    decisionRuntimes,
    runtime,
  );
  const stageExtensions = await resolveExtensions(
    definition.extensions,
    measurementPolicy.extensions,
    runtime,
  );
  const schemaIdentities = sortSchemaIdentities(identitiesByUri);
  const schedulingTargetGroups = deriveSchedulingTargetGroups({
    targetIds: definition.targets.map((target) => target.targetId),
    comparisons: definition.comparisons,
    paired: definition.experiment.sampling.resamplingUnit === 'paired-block',
  });
  const digests = computePlanDigests({
    dataset: definition.dataset,
    targets: definition.targets,
    evaluators: definition.evaluators,
    metrics: definition.metrics,
    experiment: definition.experiment,
    analysisGraph: definition.analysisGraph,
    comparisons: definition.comparisons,
    ...(definition.decisionPolicy !== undefined
      ? { decisionPolicy: definition.decisionPolicy }
      : {}),
    measurementPolicy,
    executorRuntimes,
    evaluatorRuntimes,
    analysisRuntimes,
    decisionRuntimes,
    schemaIdentities,
    ...(definition.seriesMembership !== undefined
      ? { seriesMembership: definition.seriesMembership }
      : {}),
    stageExtensions,
  });

  const execution = {
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    executionInputDigest: digests.executionInputDigest,
    randomizationDesignDigest: digests.randomizationDesignDigest,
    samples: projectExecutionInputs(definition.dataset),
    targets: definition.targets,
    schedulingTargetGroups,
    experiment: projectExecutionExperimentDesign(definition.experiment),
    runtimes: executorRuntimes,
    policy: {
      execution: measurementPolicy.execution,
      retry: measurementPolicy.retry,
      budget: measurementPolicy.budget,
      executionCacheMode: measurementPolicy.cache.executionMode,
      evidence: {
        output: measurementPolicy.evidence.output,
        trace: measurementPolicy.evidence.trace,
        maximumClassification: measurementPolicy.evidence.maximumClassification,
      },
      failure: measurementPolicy.failure,
    },
    executionPlanDigest: digests.executionPlanDigest,
    ...(stageExtensions.execution !== undefined
      ? { extensions: stageExtensions.execution }
      : {}),
  };
  const evaluation = {
    schemaVersion: EVALUATION_PLAN_SCHEMA_VERSION,
    executionPlanDigest: digests.executionPlanDigest,
    evaluationInputDigest: digests.evaluationInputDigest,
    samples: projectEvaluationInputs(definition.dataset),
    evaluators: definition.evaluators,
    metrics: definition.metrics,
    runtimes: evaluatorRuntimes,
    policy: {
      runtime: measurementPolicy.evaluation,
      budget: measurementPolicy.budget,
      evaluationCacheMode: measurementPolicy.cache.evaluationMode,
      evidence: measurementPolicy.evidence,
      failure: measurementPolicy.failure,
    },
    evaluationPlanDigest: digests.evaluationPlanDigest,
    ...(stageExtensions.evaluation !== undefined
      ? { extensions: stageExtensions.evaluation }
      : {}),
  };
  const analysis = {
    schemaVersion: ANALYSIS_PLAN_SCHEMA_VERSION,
    evaluationPlanDigest: digests.evaluationPlanDigest,
    analysisInputDigest: digests.analysisInputDigest,
    samples: projectAnalysisInputs(definition.dataset),
    cohorts: projectAnalysisCohorts(definition.dataset),
    metrics: definition.metrics,
    analysisGraph: definition.analysisGraph,
    experiment: definition.experiment,
    comparisons: definition.comparisons,
    runtimes: analysisRuntimes,
    analysisPlanDigest: digests.analysisPlanDigest,
    ...(stageExtensions.analysis !== undefined
      ? { extensions: stageExtensions.analysis }
      : {}),
  };
  const decision = {
    schemaVersion: DECISION_PLAN_SCHEMA_VERSION,
    analysisPlanDigest: digests.analysisPlanDigest,
    analysisInputDigest: digests.analysisInputDigest,
    ...(definition.decisionPolicy !== undefined
      ? { decisionPolicy: definition.decisionPolicy }
      : {}),
    runtimes: decisionRuntimes,
    decisionPlanDigest: digests.decisionPlanDigest,
    ...(stageExtensions.decision !== undefined
      ? { extensions: stageExtensions.decision }
      : {}),
  };
  const plan = {
    schemaVersion: RUN_PLAN_SCHEMA_VERSION,
    definition,
    measurementPolicy,
    execution,
    evaluation,
    analysis,
    decision,
    schemaIdentities,
    digests,
    ...(stageExtensions.run !== undefined ? { extensions: stageExtensions.run } : {}),
  };

  try {
    const parsed = parseWireDocument(RunPlanSchema, plan);
    return sealRunPlan(parsed);
  } catch {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_SCHEMA_INVALID',
      stage: 'internal',
      preparationStage: 'sealing',
      message: 'Compiler 生成的 RunPlan 未通过内部契约校验。',
    });
  }
}
