import { compareStrings } from '../../primitives/ordering.js';
import { z } from 'zod';
import { EvaluationDefinitionSchema, parseWireDocument, type MeasurementPolicy, type ResolvedRuntime, type SchemaIdentity } from '../../contracts/index.js';
import { EvaluationDefinitionError } from '../errors.js';
import { deepFreeze, snapshotJson } from '../immutability.js';
import { AnalysisCapabilitiesSchema, EvaluatorCapabilitiesSchema, ExecutorCapabilitiesSchema, RuntimeResolutionSchema, type AnalysisNodeCapabilities, type AnalysisRuntimeRequirement, type MissingPolicyCapabilities, type PreparationRuntime } from '../types.js';
import { validateAnalysisInputs } from '../validation.js';
import { parseCapabilities, addCapabilitySchemas, requireSchemaValidator } from './schemas.js';
import { bindCapabilities, normalizeExecutorCapabilities, assertExecutionRequirementsSupported, normalizeEvaluatorCapabilities, normalizeAnalysisCapabilities, assertVersionSatisfied } from './capabilities.js';

interface ResolvedAnalysisRuntime {
  runtime: ResolvedRuntime;
  capabilities: AnalysisNodeCapabilities;
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

export async function resolveExecutors(
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

export async function resolveEvaluators(
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

export async function resolveAnalysisRuntimes(
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
      || !samplingCapabilities.assignmentKinds.includes(
        definition.experiment.assignment.assignmentKind,
      )
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

  for (const [nodeId, resolved] of byNodeId) {
    const capabilities = resolved.capabilities.sampling;
    if (capabilities === undefined) continue;
    if (!capabilities.assignmentKinds.includes(definition.experiment.assignment.assignmentKind)
        || !capabilities.experimentalUnits.includes(sampling.experimentalUnit)
        || !capabilities.repeatedMeasures.includes(sampling.repeatedMeasures)
        || !capabilities.resamplingUnits.includes(sampling.resamplingUnit)) {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
        message: 'Analysis node 不支持声明的 AssignmentDesign／SamplingDesign。',
        details: { referenceId: nodeId },
      });
    }
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

export async function resolveDecisionRuntimes(
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
