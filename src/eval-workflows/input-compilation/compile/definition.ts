import { compareStrings } from '../../../eval-core/primitives/ordering.js';
import { EVALUATION_DEFINITION_SCHEMA_VERSION, deepFreezeCanonicalJson, resolveEffectiveExecutionControl, type EvaluationDefinition, type EvaluatorDefinition, type JsonValue, type TargetExecutionRequirements } from '../../../eval-core/contracts/index.js';
import { normalizeEvaluationDefinition } from '../../../eval-core/compiler/index.js';
import { type ResolvedCliEvaluationInput, type ResolvedEvaluatorTemplate, type ResolvedJudgeMember, type ResolvedTargetBehavior } from '../types.js';
import { fail, canonicalSnapshot, assertUnique } from './values.js';
import { descriptorSnapshot } from './resources.js';

function behaviorConfig(
  behavior: ResolvedTargetBehavior,
  runtime: ResolvedCliEvaluationInput['targets'][number]['executor'],
): JsonValue {
  if (behavior.config !== undefined
      && behavior.config.classification !== 'public'
      && behavior.config.classification !== 'sensitive') fail({
    code: 'CLI_INPUT_RESTRICTED_INLINE_CONTENT',
    fieldPath: 'targets[].behavior.config.classification',
    message: 'Target config 不得内联 secret 或 gold 内容，请改用 digest-bound resource descriptor。',
  });
  if (behavior.sandbox?.config !== undefined
      && behavior.sandbox.config.classification !== 'public'
      && behavior.sandbox.config.classification !== 'sensitive') fail({
    code: 'CLI_INPUT_RESTRICTED_INLINE_CONTENT',
    fieldPath: 'targets[].behavior.sandbox.config.classification',
    message: 'Sandbox config 不得内联 secret 或 gold 内容，请改用 digest-bound resource descriptor。',
  });
  return canonicalSnapshot({
    behavior: {
      artifact: descriptorSnapshot(behavior.artifact),
      ...(behavior.mcpConfig === undefined ? {} : { mcpConfig: descriptorSnapshot(behavior.mcpConfig) }),
      ...(behavior.allowedSkills === undefined ? {} : {
        allowedSkills: [...behavior.allowedSkills].sort(compareStrings),
      }),
      ...(behavior.sandbox === undefined ? {} : {
        sandbox: {
          sandboxId: behavior.sandbox.sandboxId,
          ...(behavior.sandbox.config === undefined ? {} : {
            config: {
              classification: behavior.sandbox.config.classification,
              value: canonicalSnapshot(behavior.sandbox.config.value),
            },
          }),
        },
      }),
      ...(behavior.config === undefined ? {} : {
        config: {
          classification: behavior.config.classification,
          value: canonicalSnapshot(behavior.config.value),
        },
      }),
    },
    runtime: {
      model: runtime.model,
      ...(runtime.effort === undefined ? {} : { effort: runtime.effort }),
      ...(runtime.implementationResource === undefined ? {} : {
        implementationResource: descriptorSnapshot(runtime.implementationResource),
      }),
    },
  });
}

function executionRequirementsForTarget(
  behavior: ResolvedTargetBehavior,
  controls: ResolvedCliEvaluationInput['targets'][number]['executionControls'],
): TargetExecutionRequirements {
  const effectiveControls = controls.sampleOverrides.map((override) => (
    resolveEffectiveExecutionControl(controls, override.sampleId)
  ));
  effectiveControls.push(controls.defaults);
  return {
    systemInstructions: behavior.systemInstructions,
    workspace: effectiveControls.some((control) => (
      control.workspace.workspaceMode === 'copy-on-write-overlay'
    )) ? 'copy-on-write-overlay' : 'not-required',
    mcp: behavior.mcpConfig === undefined ? 'not-required' : 'native-config',
    mockInterception: effectiveControls.some((control) => (
      control.mockInterception.mockInterceptionMode === 'pre-tool-call'
    )) ? 'pre-tool-call' : 'not-required',
    toolPolicy: effectiveControls.some((control) => (
      control.tools.toolPolicyKind === 'allow-list'
    )) ? 'allow-list' : 'runtime-default',
    skillDiscovery: behavior.allowedSkills === undefined
      ? 'runtime-default'
      : behavior.allowedSkills.length === 0
        ? 'disabled'
        : 'allow-list',
    ...(behavior.sandbox === undefined ? {} : { sandboxId: behavior.sandbox.sandboxId }),
  };
}

function evaluatorConfig(
  template: ResolvedEvaluatorTemplate,
  member?: ResolvedJudgeMember,
): JsonValue | undefined {
  if (template.config !== undefined
      && template.config.classification !== 'public'
      && template.config.classification !== 'sensitive') fail({
    code: 'CLI_INPUT_RESTRICTED_INLINE_CONTENT',
    fieldPath: `evaluatorTemplates.${template.evaluatorId}.config.classification`,
    message: 'Evaluator config 不得内联 secret 或 gold 内容，请改用 digest-bound resource descriptor。',
  });
  if (template.config === undefined && template.resources === undefined && member === undefined) return undefined;
  return canonicalSnapshot({
    ...(template.config === undefined ? {} : {
      evaluator: {
        classification: template.config.classification,
        value: canonicalSnapshot(template.config.value),
      },
    }),
    ...(template.resources === undefined ? {} : {
      resources: [...template.resources]
        .sort((left, right) => compareStrings(left.resourceId, right.resourceId))
        .map(descriptorSnapshot),
    }),
    ...(member === undefined ? {} : {
      runtime: {
        executorId: member.executorId,
        model: member.model,
        ...(member.deploymentRevision === undefined
          ? {}
          : { deploymentRevision: member.deploymentRevision }),
        promptVariant: template.runtimePromptVariant,
        ...(member.effort === undefined ? {} : { effort: member.effort }),
      },
    }),
  });
}

function makeEvaluator(
  template: ResolvedEvaluatorTemplate,
  input: {
    evaluatorId: string;
    implementationId: string;
    versionConstraint?: string;
    ensembleMemberId: string;
    replicateIndex: number;
    member?: ResolvedJudgeMember;
  },
): EvaluatorDefinition {
  const config = evaluatorConfig(template, input.member);
  return {
    evaluatorId: input.evaluatorId,
    evaluatorKind: template.evaluatorKind,
    implementationId: input.implementationId,
    ...(input.versionConstraint === undefined ? {} : { versionConstraint: input.versionConstraint }),
    ...(template.applicableSampleIds === undefined ? {} : {
      applicableSampleIds: [...template.applicableSampleIds].sort(compareStrings),
    }),
    measurement: {
      instrumentId: template.instrumentId,
      ensembleMemberId: input.ensembleMemberId,
      replicateGroupId: template.replicateGroupId,
      replicateIndex: input.replicateIndex,
    },
    metricIds: [...template.metricIds].sort(compareStrings),
    inputs: [...template.inputs].sort((left, right) => compareStrings(left.bindingId, right.bindingId)),
    ...(config === undefined ? {} : { config }),
  };
}

function compileEvaluators(input: ResolvedCliEvaluationInput): EvaluatorDefinition[] {
  assertUnique(input.evaluatorTemplates.map((template) => template.evaluatorId), 'evaluatorTemplates[].evaluatorId');
  assertUnique(input.evaluatorTemplates.flatMap((template) => (
    template.applicableSampleIds ?? input.dataset.samples.map((sample) => sample.sampleId)
  ).map((sampleId) => (
    `${template.instrumentId}\u0000${template.replicateGroupId}\u0000${sampleId}`
  ))), 'evaluatorTemplates[].measurementIdentity');
  assertUnique(input.judges.members.map((member) => member.ensembleMemberId), 'judges.members[].ensembleMemberId');
  if (!Number.isInteger(input.judges.replicateCount) || input.judges.replicateCount < 1) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'judges.replicateCount',
    message: '评委 replicate 数量必须是正整数。',
  });
  const hasJudgeTemplate = input.evaluatorTemplates.some((template) => template.runtimeBindingKind === 'judge');
  if (input.judges.enabled && hasJudgeTemplate && input.judges.members.length === 0) fail({
    code: 'CLI_INPUT_JUDGE_REQUIRED',
    fieldPath: 'judges.members',
    message: '启用评委时必须提供至少一个经过解析的评委实现。',
  });

  const evaluators: EvaluatorDefinition[] = [];
  for (const template of input.evaluatorTemplates) {
    if (template.runtimeBindingKind === 'builtin') {
      evaluators.push(makeEvaluator(template, {
        evaluatorId: template.evaluatorId,
        implementationId: template.implementationId,
        versionConstraint: template.versionConstraint,
        ensembleMemberId: `${template.evaluatorId}-builtin`,
        replicateIndex: 0,
      }));
      continue;
    }
    if (!input.judges.enabled) continue;
    if (template.runtimePromptVariant === undefined) fail({
      code: 'CLI_INPUT_INVALID',
      fieldPath: `evaluatorTemplates.${template.evaluatorId}.runtimePromptVariant`,
      message: `评委 evaluator「${template.evaluatorId}」缺少 runtimePromptVariant。`,
    });
    for (const member of [...input.judges.members]
      .sort((left, right) => compareStrings(left.ensembleMemberId, right.ensembleMemberId))) {
      for (let replicateIndex = 0; replicateIndex < input.judges.replicateCount; replicateIndex += 1) {
        evaluators.push(makeEvaluator(template, {
          evaluatorId: `${template.evaluatorId}--${member.ensembleMemberId}--r${replicateIndex}`,
          implementationId: template.implementationId,
          versionConstraint: template.versionConstraint,
          ensembleMemberId: member.ensembleMemberId,
          replicateIndex,
          member,
        }));
      }
    }
  }
  assertUnique(evaluators.map((evaluator) => evaluator.evaluatorId), 'definition.evaluators[].evaluatorId');
  return evaluators.sort((left, right) => compareStrings(left.evaluatorId, right.evaluatorId));
}

// CLI-derived identities are local to this compiler. Runtime's declaration facade
// shares the Core schema, but derives its own slots and accepts caller comparison IDs.
type CliRandomizationSlotId = `slot-${string}`;

type CliComparisonId = `control-vs-${string}`;

export function compileDefinition(input: ResolvedCliEvaluationInput): EvaluationDefinition {
  assertUnique(input.dataset.samples.map((sample) => sample.sampleId), 'dataset.samples[].sampleId');
  assertUnique(input.targets.map((target) => target.targetId), 'targets[].targetId');
  assertUnique(input.metrics.map((metric) => metric.metricId), 'metrics[].metricId');
  const controls = input.targets.filter((target) => target.experimentRole === 'control');
  const treatments = input.targets.filter((target) => target.experimentRole === 'treatment');
  if (controls.length !== 1) fail({
    code: 'CLI_INPUT_CONTROL_REQUIRED',
    fieldPath: 'targets[].experimentRole',
    message: 'Evaluation Core 编译要求且仅允许一个 control target。',
  });
  if (treatments.length === 0) fail({
    code: 'CLI_INPUT_TREATMENT_REQUIRED',
    fieldPath: 'targets[].experimentRole',
    message: 'Evaluation Core 编译要求至少一个 treatment target。',
  });
  if (input.metrics.length === 0) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'metrics',
    message: '至少需要一个 metric 才能建立比较契约。',
  });
  const targets = [...input.targets]
    .sort((left, right) => compareStrings(left.targetId, right.targetId))
    .map((target) => ({
      targetId: target.targetId,
      targetKind: target.targetKind,
      protocolId: target.protocolId,
      executorId: target.executor.implementationId,
      ...(target.executor.versionConstraint === undefined
        ? {}
        : { versionConstraint: target.executor.versionConstraint }),
      executionRequirements: executionRequirementsForTarget(
        target.behavior,
        target.executionControls,
      ),
      executionControls: target.executionControls,
      config: behaviorConfig(target.behavior, target.executor),
    }));
  const analysisNodes = [...input.analysisGraph.nodes]
    .map((node) => ({
      ...node,
      inputs: [...node.inputs].sort((left, right) => (
        compareStrings(left.inputKind, right.inputKind)
        || compareStrings(left.referenceId, right.referenceId)
      )),
    }))
    .sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  const decisionPolicy = input.decisionPolicy === undefined ? undefined : {
    ...input.decisionPolicy,
    analysisResultIds: [...input.decisionPolicy.analysisResultIds].sort(compareStrings),
    ...(input.decisionPolicy.comparisonFamily === undefined ? {} : {
      comparisonFamily: [...input.decisionPolicy.comparisonFamily].sort((left, right) => (
        compareStrings(left.comparisonId, right.comparisonId)
        || compareStrings(left.treatmentTargetId, right.treatmentTargetId)
        || compareStrings(left.metricId, right.metricId)
      )),
    }),
  };
  const raw = canonicalSnapshot({
    schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
    dataset: {
      datasetId: input.dataset.datasetId,
      samples: [...input.dataset.samples]
        .sort((left, right) => compareStrings(left.sampleId, right.sampleId)),
      ...(input.dataset.analysisCohorts === undefined ? {} : {
        analysisCohorts: [...input.dataset.analysisCohorts].sort((left, right) => (
          compareStrings(left.cohortSetId, right.cohortSetId)
          || compareStrings(left.cohortId, right.cohortId)
        )),
      }),
    },
    targets,
    evaluators: compileEvaluators(input),
    metrics: [...input.metrics].sort((left, right) => compareStrings(left.metricId, right.metricId)),
    experiment: {
      ...input.experiment,
      randomizationSlots: targets.map((target) => ({
        targetId: target.targetId,
        randomizationSlotId: `slot-${target.targetId}` satisfies CliRandomizationSlotId,
      })),
    },
    analysisGraph: { analysisMode: input.analysisGraph.analysisMode, nodes: analysisNodes },
    comparisons: treatments.map((target) => ({
      comparisonId: `control-vs-${target.targetId}` satisfies CliComparisonId,
      controlTargetId: controls[0].targetId,
      treatmentTargetIds: [target.targetId],
      metricIds: input.metrics.map((metric) => metric.metricId).sort(compareStrings),
    })),
    ...(decisionPolicy === undefined ? {} : { decisionPolicy }),
  });
  try {
    return deepFreezeCanonicalJson(normalizeEvaluationDefinition(raw));
  } catch (cause) {
    fail({
      code: 'CLI_INPUT_CORE_SCHEMA_INVALID',
      fieldPath: 'definition',
      message: '编译后的 EvaluationDefinition 不符合 Core schema。',
      cause,
    });
  }
}
