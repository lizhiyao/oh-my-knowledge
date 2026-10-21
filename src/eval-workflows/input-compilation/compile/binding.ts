import { compareStrings } from '../../../eval-core/primitives/ordering.js';
import { deepFreezeCanonicalJson, digestCanonicalJson, type EvaluationDefinition } from '../../../eval-core/contracts/index.js';
import { RUNTIME_BINDING_REQUEST_SCHEMA_VERSION, type CompiledIndependentSeries, type ResolvedCliEvaluationInput, type ResolvedTargetBehavior, type RuntimeBinding, type RuntimeBindingRequest } from '../types.js';
import { fail, canonicalSnapshot } from './values.js';

function resourceLeaseRequirementsForTarget(
  behavior: ResolvedTargetBehavior,
  controls: ResolvedCliEvaluationInput['targets'][number]['executionControls'],
  runtime: ResolvedCliEvaluationInput['targets'][number]['executor'],
): Extract<RuntimeBinding, { runtimeKind: 'executor' }>['resourceLeaseRequirements'] {
  const workspaces = [
    controls.defaults.workspace,
    ...controls.sampleOverrides.flatMap((override) => (
      override.workspace === undefined ? [] : [override.workspace]
    )),
  ].flatMap((workspace) => workspace.workspaceMode === 'copy-on-write-overlay'
    ? [workspace.descriptor]
    : []);
  const mockPlans = [
    controls.defaults.mockInterception,
    ...controls.sampleOverrides.flatMap((override) => (
      override.mockInterception === undefined ? [] : [override.mockInterception]
    )),
  ].flatMap((control) => control.mockInterceptionMode === 'pre-tool-call'
    ? [control.descriptor]
    : []);
  const requirements = [
    {
      resourceId: behavior.artifact.resourceId,
      resourceRole: 'artifact' as const,
      leaseMode: 'immutable-snapshot' as const,
    },
    ...workspaces.map((workspace) => ({
      resourceId: workspace.resourceId,
      resourceRole: 'workspace' as const,
      leaseMode: 'copy-on-write-overlay' as const,
    })),
    ...mockPlans.map((plan) => ({
      resourceId: plan.resourceId,
      resourceRole: 'mock-plan' as const,
      leaseMode: 'immutable-snapshot' as const,
    })),
    ...(behavior.mcpConfig === undefined ? [] : [{
      resourceId: behavior.mcpConfig.resourceId,
      resourceRole: 'mcp-config' as const,
      leaseMode: 'immutable-snapshot' as const,
    }]),
    ...(behavior.mocks ?? []).map((mock) => ({
      resourceId: mock.rule.resourceId,
      resourceRole: 'mock-rule' as const,
      leaseMode: 'immutable-snapshot' as const,
    })),
    ...(behavior.mocks ?? []).flatMap((mock) => mock.payloads.map((payload) => ({
      resourceId: payload.resourceId,
      resourceRole: 'mock-payload' as const,
      leaseMode: 'immutable-snapshot' as const,
    }))),
    ...(runtime.implementationResource === undefined ? [] : [{
      resourceId: runtime.implementationResource.resourceId,
      resourceRole: 'runtime-implementation' as const,
      leaseMode: 'immutable-snapshot' as const,
    }]),
  ];
  return [...new Map(requirements.map((requirement) => [
    `${requirement.resourceRole}\u0000${requirement.resourceId}`,
    requirement,
  ])).values()].sort((left, right) => (
    compareStrings(left.resourceRole, right.resourceRole)
    || compareStrings(left.resourceId, right.resourceId)
  ));
}

export function compileRuntimeBinding(
  input: ResolvedCliEvaluationInput,
  definition: EvaluationDefinition,
  series: CompiledIndependentSeries | undefined,
): RuntimeBindingRequest {
  const inputTargetById = new Map(input.targets.map((target) => [target.targetId, target]));
  const judgeMemberById = new Map(input.judges.members.map((member) => [
    member.ensembleMemberId,
    member,
  ]));
  const templateByInstrument = new Map(input.evaluatorTemplates.map((template) => [
    `${template.instrumentId}\u0000${template.replicateGroupId}`,
    template,
  ]));
  const bindings: RuntimeBinding[] = [];
  for (const target of definition.targets) {
    const resolved = inputTargetById.get(target.targetId);
    if (resolved === undefined) continue;
    bindings.push({
      runtimeKind: 'executor',
      bindingId: `executor-${target.targetId}`,
      targetId: target.targetId,
      implementationId: target.executorId,
      ...(target.versionConstraint === undefined ? {} : { versionConstraint: target.versionConstraint }),
      protocolId: target.protocolId,
      behaviorConfigDigest: digestCanonicalJson(target.config ?? null),
      executionControlsDigest: digestCanonicalJson(target.executionControls),
      resourceLeaseRequirements: resourceLeaseRequirementsForTarget(
        resolved.behavior,
        resolved.executionControls,
        resolved.executor,
      ),
      qualification: {
        model: resolved.executor.model,
        ...(resolved.executor.effort === undefined ? {} : { effort: resolved.executor.effort }),
        executionRequirements: target.executionRequirements,
        resourceIntegrity: 'digest-before-use',
      },
    });
  }
  for (const evaluator of definition.evaluators) {
    const template = templateByInstrument.get(
      `${evaluator.measurement.instrumentId}\u0000${evaluator.measurement.replicateGroupId}`,
    );
    const judgeMember = judgeMemberById.get(evaluator.measurement.ensembleMemberId);
    bindings.push({
      runtimeKind: 'evaluator',
      bindingId: `evaluator-${evaluator.evaluatorId}`,
      evaluatorId: evaluator.evaluatorId,
      implementationId: evaluator.implementationId,
      ...(evaluator.versionConstraint === undefined ? {} : { versionConstraint: evaluator.versionConstraint }),
      measurement: evaluator.measurement,
      ...(evaluator.config === undefined ? {} : { configDigest: digestCanonicalJson(evaluator.config) }),
      resourceLeaseRequirements: [...new Map([...(template?.resources ?? [])]
        .map((descriptor) => [descriptor.resourceId, descriptor])).values()]
        .map((descriptor) => ({
          resourceId: descriptor.resourceId,
          resourceRole: 'content' as const,
          leaseMode: 'immutable-snapshot' as const,
        }))
        .sort((left, right) => compareStrings(left.resourceId, right.resourceId)),
      ...(judgeMember === undefined ? {} : {
        qualification: {
          executorId: judgeMember.executorId,
          model: judgeMember.model,
          ...(judgeMember.deploymentRevision === undefined
            ? {}
            : { deploymentRevision: judgeMember.deploymentRevision }),
          ...(judgeMember.effort === undefined ? {} : { effort: judgeMember.effort }),
          promptVariant: template?.runtimePromptVariant
            ?? fail({
              code: 'CLI_INPUT_INVALID',
              fieldPath: `evaluatorTemplates.${template?.evaluatorId ?? '<missing>'}.runtimePromptVariant`,
              message: '评委 evaluator 缺少 runtimePromptVariant。',
            }),
          resourceIntegrity: 'digest-before-use',
        },
      }),
    });
  }
  for (const node of definition.analysisGraph.nodes) {
    bindings.push({
      runtimeKind: 'analysis-node',
      bindingId: `analysis-${node.nodeId}`,
      referenceId: node.nodeId,
      requirementKind: 'analysis-node',
      analysisNodeKind: node.analysisNodeKind,
      implementationId: node.implementationId,
      ...(node.versionConstraint === undefined ? {} : { versionConstraint: node.versionConstraint }),
    });
  }
  bindings.push({
    runtimeKind: 'analysis-node',
    bindingId: `sampling-estimator-${definition.experiment.sampling.estimatorId}`,
    referenceId: definition.experiment.sampling.estimatorId,
    requirementKind: 'sampling-estimator',
    analysisNodeKind: 'estimator',
    implementationId: definition.experiment.sampling.estimatorId,
  });
  for (const policyId of [...new Set(definition.metrics.map((metric) => (
    metric.missingPolicyId
  )))].sort(compareStrings)) {
    bindings.push({
      runtimeKind: 'missing-policy',
      bindingId: `missing-policy-${policyId}`,
      policyId,
      implementationId: policyId,
    });
  }
  if (definition.decisionPolicy !== undefined) {
    bindings.push({
      runtimeKind: 'decision-policy',
      bindingId: `decision-${definition.decisionPolicy.decisionPolicyId}`,
      decisionPolicyId: definition.decisionPolicy.decisionPolicyId,
      implementationId: definition.decisionPolicy.implementationId,
      ...(definition.decisionPolicy.versionConstraint === undefined
        ? {}
        : { versionConstraint: definition.decisionPolicy.versionConstraint }),
    });
  }
  for (const node of series?.definition.analysisGraph.nodes ?? []) {
    bindings.push({
      runtimeKind: 'series-analysis-node',
      bindingId: `series-analysis-${node.nodeId}`,
      nodeId: node.nodeId,
      implementationId: node.implementationId,
    });
  }
  if (series?.definition.decisionPolicy !== undefined) {
    bindings.push({
      runtimeKind: 'series-decision-policy',
      bindingId: `series-decision-${series.definition.decisionPolicy.decisionPolicyId}`,
      decisionPolicyId: series.definition.decisionPolicy.decisionPolicyId,
      implementationId: series.definition.decisionPolicy.implementationId,
    });
  }
  return deepFreezeCanonicalJson(canonicalSnapshot({
    schemaVersion: RUNTIME_BINDING_REQUEST_SCHEMA_VERSION,
    bindings: bindings.sort((left, right) => compareStrings(left.bindingId, right.bindingId)),
  })) as unknown as RuntimeBindingRequest;
}
