import type {
  AnalysisCapabilities,
} from './types.js';
import {
  projectExecutionInputs,
  type AnalysisNodeDefinition,
  type EvaluationDefinition,
  type MeasurementPolicy,
  type MetricDefinition,
} from '../contracts/index.js';
import { definitionError } from './errors.js';

function assertUnique(
  values: readonly string[],
  namespace: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw definitionError(
        'EVAL_DEFINITION_DUPLICATE_ID',
        `“${namespace}”命名空间中存在重复 ID。`,
        { namespace, duplicateId: value },
      );
    }
    seen.add(value);
  }
}

function assertReference(
  known: ReadonlySet<string>,
  referenceId: string,
  location: string,
  referenceKind: string,
): void {
  if (known.has(referenceId)) return;
  throw definitionError(
    'EVAL_DEFINITION_MISSING_REFERENCE',
    `“${location}”引用了不存在的${referenceKind}。`,
    { location, referenceKind, referenceId },
  );
}

function decodePointerToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolvesPointer(value: unknown, pointer: string): boolean {
  if (pointer === '') return true;
  let current = value;
  for (const encodedToken of pointer.slice(1).split('/')) {
    const token = decodePointerToken(encodedToken);
    if (current === null || typeof current !== 'object') return false;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return false;
      const index = Number(token);
      if (index >= current.length) return false;
      current = current[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, token)) return false;
    current = (current as Record<string, unknown>)[token];
  }
  return true;
}

function validateDesignPointers(definition: EvaluationDefinition): void {
  const executionSamples = projectExecutionInputs(definition.dataset);
  const pointers = [
    ['pairingKey', definition.experiment.sampling.pairingKey],
    ['clusterKey', definition.experiment.sampling.clusterKey],
    ['stratumKey', definition.experiment.sampling.stratumKey],
  ] as const;

  for (const [field, pointer] of pointers) {
    if (pointer === undefined) continue;
    for (const sample of executionSamples) {
      if (!resolvesPointer(sample, pointer)) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          `SamplingDesign.${field} 无法在 execution-visible sample 中定位值。`,
          {
            location: `experiment.sampling.${field}`,
            sampleId: sample.sampleId,
          },
        );
      }
    }
  }
}

function validateEvaluatorBindings(definition: EvaluationDefinition): void {
  for (const evaluator of definition.evaluators) {
    assertUnique(
      evaluator.inputs.map((binding) => binding.bindingId),
      `evaluator:${evaluator.evaluatorId}:binding`,
    );
    for (const binding of evaluator.inputs) {
      if (binding.sourceKind !== 'expected' && binding.sourceKind !== 'evaluation-context') {
        continue;
      }
      const field = binding.sourceKind === 'expected' ? 'expected' : 'evaluationContext';
      const samplesWithSource = definition.dataset.samples.filter(
        (sample) => sample[field] !== undefined,
      );
      if (samplesWithSource.length === 0) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          `Evaluator binding 引用了 Dataset 中不存在的“${binding.sourceKind}”数据源。`,
          {
            evaluatorId: evaluator.evaluatorId,
            bindingId: binding.bindingId,
            sourceKind: binding.sourceKind,
          },
        );
      }
      for (const sample of samplesWithSource) {
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

function validateMetric(metric: MetricDefinition): void {
  if (metric.valueType !== 'numeric' && metric.scale !== undefined) {
    throw definitionError(
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      '只有 numeric Metric 可以声明 scale。',
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

function validateSamplingDesign(definition: EvaluationDefinition): void {
  const { experiment } = definition;
  const { sampling, scheduling } = experiment;
  if (experiment.trials > 1 && !sampling.repeatedMeasures) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'trials 大于 1 时必须显式声明 repeatedMeasures。',
      { location: 'experiment.sampling.repeatedMeasures' },
    );
  }
  if (sampling.resamplingUnit === 'paired-block') {
    if (sampling.pairingKey === undefined || definition.comparisons.length === 0) {
      throw definitionError(
        'EVAL_DEFINITION_POLICY_INVALID',
        'paired-block 重采样要求 pairingKey 和至少一个 Comparison。',
        { location: 'experiment.sampling' },
      );
    }
  } else if (sampling.pairingKey !== undefined) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'pairingKey 只能与 paired-block 重采样一起使用。',
      { location: 'experiment.sampling.pairingKey' },
    );
  }
  if (sampling.experimentalUnit === 'cluster' || sampling.resamplingUnit === 'cluster') {
    if (sampling.clusterKey === undefined
        || sampling.experimentalUnit !== 'cluster'
        || sampling.resamplingUnit !== 'cluster') {
      throw definitionError(
        'EVAL_DEFINITION_POLICY_INVALID',
        'cluster 设计要求 experimentalUnit、resamplingUnit 和 clusterKey 一致声明。',
        { location: 'experiment.sampling' },
      );
    }
  } else if (sampling.clusterKey !== undefined) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'clusterKey 只能用于 cluster experimental unit。',
      { location: 'experiment.sampling.clusterKey' },
    );
  }
  if ((sampling.experimentalUnit === 'run') !== (sampling.resamplingUnit === 'run')) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'run experimental unit 必须使用 run resampling unit，反之亦然。',
      { location: 'experiment.sampling' },
    );
  }
  if (scheduling.schedulingKind === 'randomized-block') {
    if (scheduling.blockSize === undefined) {
      throw definitionError(
        'EVAL_DEFINITION_POLICY_INVALID',
        'randomized-block scheduling 必须声明 blockSize。',
        { location: 'experiment.scheduling.blockSize' },
      );
    }
  } else if (scheduling.blockSize !== undefined) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'blockSize 只能用于 randomized-block scheduling。',
      { location: 'experiment.scheduling.blockSize' },
    );
  }
  if (sampling.resamplingUnit === 'paired-block'
      && scheduling.schedulingKind === 'randomized-block') {
    const requiredBlockSize = Math.max(...definition.comparisons.map(
      (comparison) => 1 + comparison.treatmentTargetIds.length,
    ));
    if ((scheduling.blockSize ?? 0) < requiredBlockSize) {
      throw definitionError(
        'EVAL_DEFINITION_POLICY_INVALID',
        'randomized block 必须容纳完整的 control／treatment scheduling block。',
        { location: 'experiment.scheduling.blockSize', requiredMinimum: requiredBlockSize },
      );
    }
  }
  validateDesignPointers(definition);
}

function validatePolicy(
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
    const smallestBlock = Math.min(...definition.comparisons.map(
      (comparison) => 1 + comparison.treatmentTargetIds.length,
    ));
    if (policy.budget.maxTargetInvocations !== undefined
        && policy.budget.maxTargetInvocations < smallestBlock) {
      throw definitionError(
        'EVAL_DEFINITION_POLICY_INVALID',
        'Target invocation budget 不足以启动一个完整的 paired block。',
        { location: 'budget.maxTargetInvocations', requiredMinimum: smallestBlock },
      );
    }
  }
}

function validateGraph(
  nodes: readonly AnalysisNodeDefinition[],
  metricIds: ReadonlySet<string>,
): void {
  const resultProducer = new Map<string, string>();
  for (const node of nodes) resultProducer.set(node.outputResultId, node.nodeId);
  const dependencies = new Map<string, Set<string>>();
  for (const node of nodes) {
    const nodeDependencies = new Set<string>();
    for (const input of node.inputs) {
      if (input.inputKind === 'metric-observations') {
        assertReference(
          metricIds,
          input.referenceId,
          `analysisGraph.nodes.${node.nodeId}.inputs`,
          'Metric',
        );
      } else {
        const producer = resultProducer.get(input.referenceId);
        if (producer === undefined) {
          throw definitionError(
            'EVAL_DEFINITION_MISSING_REFERENCE',
            'Analysis input 引用了不存在的 AnalysisResult。',
            {
              location: `analysisGraph.nodes.${node.nodeId}.inputs`,
              referenceKind: 'AnalysisResult',
              referenceId: input.referenceId,
            },
          );
        }
        nodeDependencies.add(producer);
      }
    }
    dependencies.set(node.nodeId, nodeDependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      throw definitionError(
        'EVAL_DEFINITION_GRAPH_CYCLE',
        'AnalysisGraph 必须是无环图。',
        { nodeId },
      );
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependency of dependencies.get(nodeId) ?? []) visit(dependency);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.nodeId);
}

export function validateDefinitionSemantics(
  definition: EvaluationDefinition,
  policy: MeasurementPolicy,
): void {
  assertUnique(definition.dataset.samples.map((sample) => sample.sampleId), 'sample');
  assertUnique(definition.targets.map((target) => target.targetId), 'target');
  assertUnique(definition.evaluators.map((evaluator) => evaluator.evaluatorId), 'evaluator');
  assertUnique(definition.metrics.map((metric) => metric.metricId), 'metric');
  assertUnique(definition.analysisGraph.nodes.map((node) => node.nodeId), 'analysis-node');
  assertUnique(
    definition.analysisGraph.nodes.map((node) => node.outputResultId),
    'analysis-result',
  );
  assertUnique(definition.comparisons.map((comparison) => comparison.comparisonId), 'comparison');

  const targetIds = new Set(definition.targets.map((target) => target.targetId));
  const metricIds = new Set(definition.metrics.map((metric) => metric.metricId));
  const resultIds = new Set(
    definition.analysisGraph.nodes.map((node) => node.outputResultId),
  );

  for (const evaluator of definition.evaluators) {
    assertUnique(evaluator.metricIds, `evaluator:${evaluator.evaluatorId}:metric`);
    for (const metricId of evaluator.metricIds) {
      assertReference(
        metricIds,
        metricId,
        `evaluators.${evaluator.evaluatorId}.metricIds`,
        'Metric',
      );
    }
  }
  for (const comparison of definition.comparisons) {
    assertReference(
      targetIds,
      comparison.controlTargetId,
      `comparisons.${comparison.comparisonId}.controlTargetId`,
      'Target',
    );
    assertUnique(
      comparison.treatmentTargetIds,
      `comparison:${comparison.comparisonId}:treatment-target`,
    );
    for (const targetId of comparison.treatmentTargetIds) {
      assertReference(
        targetIds,
        targetId,
        `comparisons.${comparison.comparisonId}.treatmentTargetIds`,
        'Target',
      );
      if (targetId === comparison.controlTargetId) {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          'Comparison 的 control 与 treatment 必须是不同 Target。',
          { comparisonId: comparison.comparisonId, targetId },
        );
      }
    }
    assertUnique(comparison.metricIds, `comparison:${comparison.comparisonId}:metric`);
    for (const metricId of comparison.metricIds) {
      assertReference(
        metricIds,
        metricId,
        `comparisons.${comparison.comparisonId}.metricIds`,
        'Metric',
      );
    }
  }
  if (definition.decisionPolicy !== undefined) {
    assertUnique(definition.decisionPolicy.analysisResultIds, 'decision-policy:analysis-result');
    for (const resultId of definition.decisionPolicy.analysisResultIds) {
      assertReference(
        resultIds,
        resultId,
        'decisionPolicy.analysisResultIds',
        'AnalysisResult',
      );
    }
  }
  for (const metric of definition.metrics) validateMetric(metric);
  validateEvaluatorBindings(definition);
  validateSamplingDesign(definition);
  validateGraph(definition.analysisGraph.nodes, metricIds);
  validatePolicy(definition, policy);
}

export function validateAnalysisInputs(
  node: AnalysisNodeDefinition,
  capabilities: AnalysisCapabilities,
  metricsById: ReadonlyMap<string, MetricDefinition>,
  outputSchemasByResultId: ReadonlyMap<string, string>,
): void {
  for (const input of node.inputs) {
    if (input.inputKind === 'metric-observations') {
      const metric = metricsById.get(input.referenceId);
      const compatible = capabilities.inputDomains.some((domain) => (
        domain.inputKind === 'metric-observations'
        && metric !== undefined
        && domain.valueTypes.includes(metric.valueType)
        && (domain.missingPolicyIds === undefined
          || domain.missingPolicyIds.includes(metric.missingPolicyId))
      ));
      if (compatible) continue;
    } else {
      const schemaUri = outputSchemasByResultId.get(input.referenceId);
      const compatible = capabilities.inputDomains.some((domain) => (
        domain.inputKind === 'analysis-result'
        && schemaUri !== undefined
        && domain.schemaUris.includes(schemaUri)
      ));
      if (compatible) continue;
    }
    throw definitionError(
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      'Analysis implementation 不接受声明的输入值域。',
      { nodeId: node.nodeId, inputKind: input.inputKind, referenceId: input.referenceId },
    );
  }
}
