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
  generateWireSchemaIdentities,
  parseWireDocument,
  projectEvaluationInputs,
  projectExecutionInputs,
  type ExtensionEntry,
  type Extensions,
  type JsonValue,
  type MeasurementPolicy,
  type ResolvedRuntime,
  type RuntimeIdentity,
  type SchemaIdentity,
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

export * from './errors.js';
export * from './types.js';

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
  'executionContext', 'expected', 'evaluationContext', 'annotations', 'targets',
  'targetId', 'targetKind', 'protocolId', 'executorId', 'versionConstraint', 'config',
  'evaluators', 'evaluatorId', 'evaluatorKind', 'implementationId', 'metricIds',
  'inputs', 'bindingId', 'sourceKind', 'pointer', 'metrics', 'metricId', 'valueType',
  'scope', 'scale', 'min', 'max', 'target', 'unit', 'direction', 'missingPolicyId',
  'experiment', 'trials', 'seed', 'sampling', 'experimentalUnit', 'pairingKey',
  'clusterKey', 'stratumKey', 'repeatedMeasures', 'resamplingUnit', 'estimatorId',
  'seedCoupling', 'schedulingTargetGroups',
  'scheduling', 'schedulingKind', 'blockSize', 'analysisGraph', 'analysisMode', 'nodes', 'nodeId',
  'analysisNodeKind', 'inputKind', 'referenceId', 'outputResultId', 'parameters',
  'comparisons', 'comparisonId', 'controlTargetId', 'treatmentTargetIds',
  'decisionPolicy', 'decisionPolicyId', 'analysisResultIds',
  'multipleComparisonPolicyId', 'minimumEvidenceStatus', 'execution', 'timeoutMs',
  'maxConcurrency', 'retry', 'maxAttempts', 'retryableErrorCodes', 'backoff',
  'backoffKind', 'initialDelayMs', 'maxDelayMs', 'budget', 'maxTargetInvocations',
  'maxDurationMs', 'maxProviderCost', 'amount', 'currency', 'cache', 'executionMode',
  'evaluationMode', 'evidence', 'output', 'trace', 'maximumClassification', 'failure',
  'failureMode', 'maxFailures', 'eventDelivery', 'writerMode', 'backpressureMode',
  'writerFailureMode', 'extensions', 'schemaUri', 'schemaDigest', 'data',
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
): ExecutorCapabilities {
  return {
    protocols: [...capabilities.protocols].sort((left, right) => (
      compareStrings(left.protocolId, right.protocolId)
    )),
  };
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
  } catch {
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
  addCapabilitySchemas(
    identitiesByUri,
    [capabilities.outputSchema, ...capabilities.schemas],
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
  addCapabilitySchemas(identitiesByUri, capabilities.schemas, policy.decisionPolicyId);
  return [{
    runtimeKind: 'decision-policy',
    referenceId: policy.decisionPolicyId,
    identity: bindCapabilities(resolution.identity, capabilities),
  }];
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

export async function prepareEvaluationPlan(
  definitionInput: unknown,
  measurementPolicyInput: unknown,
  runtime: PreparationRuntime,
): Promise<SealedRunPlan> {
  const definition = parseInput(
    EvaluationDefinitionSchema,
    definitionInput,
    'EvaluationDefinition',
  );
  const measurementPolicy = parseInput(
    MeasurementPolicySchema,
    measurementPolicyInput,
    'MeasurementPolicy',
  );
  validateDefinitionSemantics(definition, measurementPolicy);

  const identitiesByUri = new Map<string, SchemaIdentity>();
  for (const identity of generateWireSchemaIdentities()) {
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
    stageExtensions,
  });

  const execution = {
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    executionInputDigest: digests.executionInputDigest,
    samples: projectExecutionInputs(definition.dataset),
    targets: definition.targets,
    schedulingTargetGroups,
    experiment: definition.experiment,
    runtimes: executorRuntimes,
    policy: {
      execution: measurementPolicy.execution,
      retry: measurementPolicy.retry,
      budget: measurementPolicy.budget,
      executionCacheMode: measurementPolicy.cache.executionMode,
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
    return deepFreeze(snapshotJson(parsed)) as SealedRunPlan;
  } catch {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_SCHEMA_INVALID',
      stage: 'internal',
      preparationStage: 'sealing',
      message: 'Compiler 生成的 RunPlan 未通过内部契约校验。',
    });
  }
}
