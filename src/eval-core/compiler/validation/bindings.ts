import { resolveEffectiveExecutionControl, type EvaluationDefinition, type MetricDefinition } from '../../contracts/index.js';
import { definitionError } from '../errors.js';
import { assertUnique, assertReference, resolvesPointer } from './shared.js';

export function validateEvaluatorBindings(definition: EvaluationDefinition): void {
  const datasetSampleIds = new Set(definition.dataset.samples.map((sample) => sample.sampleId));
  for (const evaluator of definition.evaluators) {
    const applicableSampleIds = evaluator.applicableSampleIds;
    if (applicableSampleIds !== undefined) {
      assertUnique(applicableSampleIds, `evaluator:${evaluator.evaluatorId}:applicable-sample`);
      for (const sampleId of applicableSampleIds) {
        assertReference(
          datasetSampleIds,
          sampleId,
          `evaluators.${evaluator.evaluatorId}.applicableSampleIds`,
          'EvaluationSample',
        );
      }
    }
    const applicableSampleIdSet = applicableSampleIds === undefined
      ? undefined
      : new Set(applicableSampleIds);
    assertUnique(
      evaluator.inputs.map((binding) => binding.bindingId),
      `evaluator:${evaluator.evaluatorId}:binding`,
    );
    for (const binding of evaluator.inputs) {
      if (binding.sourceKind === 'execution-facts') {
        if (binding.pointer !== '') {
          throw definitionError(
            'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
            'execution-facts binding 必须消费完整 canonical projection。',
            {
              evaluatorId: evaluator.evaluatorId,
              bindingId: binding.bindingId,
              pointer: binding.pointer,
            },
          );
        }
        continue;
      }
      if (binding.sourceKind !== 'expected' && binding.sourceKind !== 'evaluation-context') {
        continue;
      }
      const field = binding.sourceKind === 'expected' ? 'expected' : 'evaluationContext';
      const applicableSamples = definition.dataset.samples.filter(
        (sample) => applicableSampleIdSet === undefined
          || applicableSampleIdSet.has(sample.sampleId),
      );
      for (const sample of applicableSamples) {
        if (sample[field] === undefined) {
          throw definitionError(
            'EVAL_DEFINITION_MISSING_REFERENCE',
            `Evaluator binding 的适用 sample 缺少“${binding.sourceKind}”数据源。`,
            {
              evaluatorId: evaluator.evaluatorId,
              bindingId: binding.bindingId,
              sourceKind: binding.sourceKind,
              sampleId: sample.sampleId,
            },
          );
        }
        if (resolvesPointer(sample[field], binding.pointer)) continue;
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          'Evaluator binding 的 JSON Pointer 无法定位数据。',
          {
            evaluatorId: evaluator.evaluatorId,
            bindingId: binding.bindingId,
            sampleId: sample.sampleId,
          },
        );
      }
    }
  }
}

export function validateTargetExecutionControls(definition: EvaluationDefinition): void {
  const sampleIds = new Set(definition.dataset.samples.map((sample) => sample.sampleId));
  for (const target of definition.targets) {
    const overrides = target.executionControls.sampleOverrides;
    assertUnique(
      overrides.map((override) => override.sampleId),
      `target:${target.targetId}:sample-execution-control`,
    );
    for (const override of overrides) {
      assertReference(
        sampleIds,
        override.sampleId,
        `targets.${target.targetId}.executionControls.sampleOverrides`,
        'EvaluationSample',
      );
    }
    const toolPolicies = [
      target.executionControls.defaults.tools,
      ...overrides.flatMap((override) => override.tools === undefined ? [] : [override.tools]),
    ];
    for (const policy of toolPolicies) {
      if (policy.toolPolicyKind === 'allow-list') {
        assertUnique(policy.allowedTools, `target:${target.targetId}:allowed-tool`);
      }
    }
    const effective = definition.dataset.samples.map((sample) => (
      resolveEffectiveExecutionControl(target.executionControls, sample.sampleId)
    ));
    const expectedWorkspace = effective.some((control) => (
      control.workspace.workspaceMode === 'copy-on-write-overlay'
    )) ? 'copy-on-write-overlay' : 'not-required';
    const expectedToolPolicy = effective.some((control) => (
      control.tools.toolPolicyKind === 'allow-list'
    )) ? 'allow-list' : 'runtime-default';
    const expectedMcp = effective.some((control) => (
      control.mcp.mcpMode === 'native-config'
    )) ? 'native-config' : 'not-required';
    const expectedMockInterception = effective.some((control) => (
      control.mockInterception.mockInterceptionMode === 'pre-tool-call'
    )) ? 'pre-tool-call' : 'not-required';
    if (target.executionRequirements.workspace !== expectedWorkspace
        || target.executionRequirements.toolPolicy !== expectedToolPolicy
        || target.executionRequirements.mcp !== expectedMcp
        || target.executionRequirements.mockInterception !== expectedMockInterception) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Target executionRequirements 必须精确覆盖所有 sample 的 effective execution control。',
        {
          targetId: target.targetId,
          expectedWorkspace,
          expectedToolPolicy,
          expectedMcp,
          expectedMockInterception,
        },
      );
    }
  }
}

export function validateMetric(metric: MetricDefinition): void {
  if (metric.valueType !== 'numeric' && metric.scale !== undefined) {
    throw definitionError(
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      '只有 numeric Metric 可以声明 scale。',
      { metricId: metric.metricId },
    );
  }
  if (metric.valueType !== 'numeric' && metric.unit !== undefined) {
    throw definitionError(
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      '只有 numeric Metric 可以声明 unit。',
      { metricId: metric.metricId },
    );
  }
  if (metric.scale?.min !== undefined && metric.scale.max !== undefined
      && metric.scale.min > metric.scale.max) {
    throw definitionError(
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      'Metric scale 的 min 不能大于 max。',
      { metricId: metric.metricId },
    );
  }
  if (metric.direction === 'target-is-best' && metric.scale?.target === undefined) {
    throw definitionError(
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      'target-is-best Metric 必须声明 scale.target。',
      { metricId: metric.metricId },
    );
  }
  const target = metric.scale?.target;
  if (target !== undefined && (
    (metric.scale?.min !== undefined && target < metric.scale.min)
    || (metric.scale?.max !== undefined && target > metric.scale.max)
  )) {
    throw definitionError(
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      'Metric scale.target 必须位于声明的 scale 范围内。',
      { metricId: metric.metricId },
    );
  }
}
