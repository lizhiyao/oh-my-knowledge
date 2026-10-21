import { deriveSchedulingTargetGroups, type EvaluationDefinition, type MeasurementPolicy } from '../../contracts/index.js';
import { definitionError } from '../errors.js';

export function validatePolicy(
  definition: EvaluationDefinition,
  policy: MeasurementPolicy,
): void {
  const requiredExecutionSources = new Set(definition.evaluators.flatMap(
    (evaluator) => evaluator.inputs.map((binding) => binding.sourceKind),
  ));
  for (const sourceKind of ['output', 'trace'] as const) {
    const captureMode = policy.evidence[sourceKind];
    if (requiredExecutionSources.has(sourceKind)
        && (captureMode === 'digest' || captureMode === 'none')) {
      throw definitionError(
        'EVAL_DEFINITION_POLICY_INVALID',
        `Evaluator 读取 ${sourceKind} 时，EvidencePolicy 必须保留 full 或 reference 内容。`,
        { location: `evidence.${sourceKind}`, sourceKind },
      );
    }
  }
  if (policy.failure.failureMode === 'failure-threshold') {
    if (policy.failure.maxFailures === undefined) {
      throw definitionError(
        'EVAL_DEFINITION_POLICY_INVALID',
        'failure-threshold 模式必须声明 maxFailures。',
        { location: 'failure.maxFailures' },
      );
    }
  } else if (policy.failure.maxFailures !== undefined) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'maxFailures 只能用于 failure-threshold 模式。',
      { location: 'failure.maxFailures' },
    );
  }

  const { backoff } = policy.retry;
  if (backoff.backoffKind === 'none'
      && (backoff.initialDelayMs !== 0 || backoff.maxDelayMs !== undefined)) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'none backoff 必须使用 0 initialDelayMs 且不声明 maxDelayMs。',
      { location: 'retry.backoff' },
    );
  }
  if (backoff.maxDelayMs !== undefined && backoff.maxDelayMs < backoff.initialDelayMs) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'maxDelayMs 不能小于 initialDelayMs。',
      { location: 'retry.backoff.maxDelayMs' },
    );
  }

  const { eventDelivery } = policy;
  if (eventDelivery.writerMode === 'disabled'
      && eventDelivery.writerFailureMode !== 'ignore') {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'EventWriter 禁用时 writerFailureMode 必须为 ignore。',
      { location: 'eventDelivery' },
    );
  }
  if (eventDelivery.writerMode === 'required'
      && eventDelivery.writerFailureMode !== 'fail-run') {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      '必需的 EventWriter 失败时必须 fail-run。',
      { location: 'eventDelivery' },
    );
  }

  if (definition.experiment.sampling.resamplingUnit === 'paired-block') {
    const schedulingTargetGroups = deriveSchedulingTargetGroups({
      targetIds: definition.targets.map((target) => target.targetId),
      comparisons: definition.comparisons,
      paired: true,
    });
    const smallestBlock = Math.min(...schedulingTargetGroups.map(
      (targetIds) => targetIds.length,
    ));
    const executionInvocationLimits = [
      policy.budget.run.maxInvocations,
      policy.budget.stages.execution.maxInvocations,
    ].filter((limit): limit is number => limit !== undefined);
    const executionInvocationLimit = executionInvocationLimits.length === 0
      ? undefined
      : Math.min(...executionInvocationLimits);
    if (executionInvocationLimit !== undefined
        && executionInvocationLimit < smallestBlock) {
      throw definitionError(
        'EVAL_DEFINITION_POLICY_INVALID',
        'Target invocation budget 不足以启动一个完整的 paired block。',
        { location: 'budget.stages.execution.maxInvocations', requiredMinimum: smallestBlock },
      );
    }
  }
}
