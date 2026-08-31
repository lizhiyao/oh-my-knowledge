import type {
  AnalysisNodeCapabilities,
} from './types.js';
import {
  canonicalizeJson,
  deriveSchedulingTargetGroups,
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
  const targetIds = definition.targets.map((target) => target.targetId);
  assertUnique(
    experiment.randomizationSlots.map((slot) => slot.targetId),
    'experiment:randomization-slot-target',
  );
  assertUnique(
    experiment.randomizationSlots.map((slot) => slot.randomizationSlotId),
    'experiment:randomization-slot',
  );
  const targetIdSet = new Set(targetIds);
  for (const slot of experiment.randomizationSlots) {
    assertReference(
      targetIdSet,
      slot.targetId,
      'experiment.randomizationSlots',
      'Target',
    );
  }
  const mappedTargetIds = new Set(experiment.randomizationSlots.map((slot) => slot.targetId));
  if (mappedTargetIds.size !== targetIds.length) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      '每个 Target 必须恰好声明一个 randomization slot。',
      { location: 'experiment.randomizationSlots' },
    );
  }
  const canonicalSlots = [...experiment.randomizationSlots].sort((left, right) => (
    left.randomizationSlotId < right.randomizationSlotId ? -1
      : left.randomizationSlotId > right.randomizationSlotId ? 1
        : left.targetId < right.targetId ? -1
          : left.targetId > right.targetId ? 1
            : 0
  ));
  if (canonicalizeJson(canonicalSlots) !== canonicalizeJson(experiment.randomizationSlots)) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'randomizationSlots 必须按 randomizationSlotId、targetId 的 canonical 顺序排列。',
      { location: 'experiment.randomizationSlots' },
    );
  }
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
    const schedulingTargetGroups = deriveSchedulingTargetGroups({
      targetIds: definition.targets.map((target) => target.targetId),
      comparisons: definition.comparisons,
      paired: true,
    });
    const requiredBlockSize = Math.max(...schedulingTargetGroups.map(
      (targetIds) => targetIds.length,
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

function validateGraph(
  nodes: readonly AnalysisNodeDefinition[],
  metricIds: ReadonlySet<string>,
  comparisons: ReadonlyMap<string, EvaluationDefinition['comparisons'][number]>,
): void {
  const resultProducer = new Map<string, string>();
  for (const node of nodes) resultProducer.set(node.outputResultId, node.nodeId);
  const dependencies = new Map<string, Set<string>>();
  for (const node of nodes) {
    assertUnique(
      node.inputs.map((input) => canonicalizeJson(input)),
      `analysis-node:${node.nodeId}:input`,
    );
    const nodeDependencies = new Set<string>();
    for (const input of node.inputs) {
      if (input.inputKind === 'metric-observations') {
        assertReference(
          metricIds,
          input.referenceId,
          `analysisGraph.nodes.${node.nodeId}.inputs`,
          'Metric',
        );
      } else if (input.inputKind === 'analysis-result') {
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
      } else {
        assertReference(
          new Set(comparisons.keys()),
          input.referenceId,
          `analysisGraph.nodes.${node.nodeId}.inputs`,
          'Comparison',
        );
        const comparison = comparisons.get(input.referenceId);
        if (comparison !== undefined
            && (!comparison.treatmentTargetIds.includes(input.treatmentTargetId)
              || !comparison.metricIds.includes(input.metricId))) {
          throw definitionError(
            'EVAL_DEFINITION_MISSING_REFERENCE',
            'Analysis input 引用了不存在的 Comparison contrast。',
            { nodeId: node.nodeId, referenceId: input.referenceId },
          );
        }
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
  const cohorts = definition.dataset.analysisCohorts ?? [];
  assertUnique(cohorts.map((cohort) => cohort.cohortId), 'analysis-cohort');
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
  const metricsById = new Map(definition.metrics.map((metric) => [metric.metricId, metric]));
  const resultIds = new Set(
    definition.analysisGraph.nodes.map((node) => node.outputResultId),
  );
  const cohortIds = new Set(cohorts.map((cohort) => cohort.cohortId));
  const cohortById = new Map(cohorts.map((cohort) => [cohort.cohortId, cohort]));
  const cohortSetKinds = new Map<string, string>();
  const partitionDerivations = new Map<string, string>();
  for (const cohort of cohorts) {
    const existingKind = cohortSetKinds.get(cohort.cohortSetId);
    if (existingKind !== undefined && existingKind !== cohort.cohortSetKind) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        '同一 Analysis cohort set 必须使用一致的集合语义。',
        { cohortSetId: cohort.cohortSetId },
      );
    }
    cohortSetKinds.set(cohort.cohortSetId, cohort.cohortSetKind);
    if (cohort.cohortSetKind === 'partition') {
      const derivation = canonicalizeJson(cohort.derivation ?? null);
      const existingDerivation = partitionDerivations.get(cohort.cohortSetId);
      if (existingDerivation !== undefined && existingDerivation !== derivation) {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          '同一 Analysis partition 必须使用一致的 membership derivation。',
          { cohortSetId: cohort.cohortSetId },
        );
      }
      partitionDerivations.set(cohort.cohortSetId, derivation);
    }
  }

  for (const sample of definition.dataset.samples) {
    const memberships = sample.analysis?.memberships ?? [];
    assertUnique(memberships.map((membership) => membership.cohortId), `sample:${sample.sampleId}:cohort`);
    const cohortSets = new Set<string>();
    for (const membership of memberships) {
      assertReference(
        cohortIds,
        membership.cohortId,
        `dataset.samples.${sample.sampleId}.analysis.memberships`,
        'AnalysisCohort',
      );
      const cohort = cohortById.get(membership.cohortId);
      if (cohort?.cohortSetKind === 'partition') {
        if (cohortSets.has(cohort.cohortSetId)) {
          throw definitionError(
            'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
            '同一 Sample 在一个 partition 中只能属于一个 cohort。',
            { sampleId: sample.sampleId, cohortSetId: cohort.cohortSetId },
          );
        }
        cohortSets.add(cohort.cohortSetId);
      }
      if (membership.membershipValue !== undefined && cohort?.disclosure !== 'full') {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          'identity-only cohort 不能携带 raw membership value。',
          { sampleId: sample.sampleId, cohortId: membership.cohortId },
        );
      }
    }
  }

  for (const node of definition.analysisGraph.nodes) {
    const include = node.cohortFilter?.includeCohortIds ?? [];
    const exclude = node.cohortFilter?.excludeCohortIds ?? [];
    assertUnique(include, `analysis-node:${node.nodeId}:include-cohort`);
    assertUnique(exclude, `analysis-node:${node.nodeId}:exclude-cohort`);
    for (const cohortId of [...include, ...exclude]) {
      assertReference(
        cohortIds,
        cohortId,
        `analysisGraph.nodes.${node.nodeId}.cohortFilter`,
        'AnalysisCohort',
      );
    }
    if (include.some((cohortId) => exclude.includes(cohortId))) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Analysis cohort filter 不能同时包含并排除同一个 cohort。',
        { nodeId: node.nodeId },
      );
    }
  }

  for (const evaluator of definition.evaluators) {
    assertUnique(evaluator.metricIds, `evaluator:${evaluator.evaluatorId}:metric`);
    for (const metricId of evaluator.metricIds) {
      assertReference(
        metricIds,
        metricId,
        `evaluators.${evaluator.evaluatorId}.metricIds`,
        'Metric',
      );
      if (metricsById.get(metricId)?.scope !== 'sample') {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          'v1 record-scoped Evaluator 只能直接产生 sample scope Metric。',
          { evaluatorId: evaluator.evaluatorId, metricId },
        );
      }
    }
  }
  const measurementCoordinates = definition.evaluators.map((evaluator) => canonicalizeJson({
    instrumentId: evaluator.measurement.instrumentId,
    ensembleMemberId: evaluator.measurement.ensembleMemberId,
    replicateGroupId: evaluator.measurement.replicateGroupId,
    replicateIndex: evaluator.measurement.replicateIndex,
  }));
  assertUnique(measurementCoordinates, 'evaluator-measurement-coordinate');
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
    const family = definition.decisionPolicy.comparisonFamily ?? [];
    const hypothesisMembers = family.filter(
      (member): member is typeof member & { hypothesisId: string } => (
        'hypothesisId' in member
      ),
    );
    assertUnique(hypothesisMembers.map((member) => member.hypothesisId), 'decision-policy:hypothesis');
    const familyResultId = definition.decisionPolicy.comparisonFamilyResultId;
    if (familyResultId === undefined) {
      assertUnique(
        family.map((member) => member.analysisResultId),
        'decision-policy:family-analysis-result',
      );
    } else if (family.length === 0
        || !definition.decisionPolicy.analysisResultIds.includes(familyResultId)
        || family.some((member) => member.analysisResultId !== familyResultId)) {
      throw definitionError(
        'EVAL_DEFINITION_MISSING_REFERENCE',
        '权威 comparison family result 必须由每个 member 共同绑定并被 DecisionPolicy 消费。',
        { referenceId: familyResultId },
      );
    }
    assertUnique(
      family.map((member) => canonicalizeJson([
        member.comparisonId,
        member.treatmentTargetId,
        member.metricId,
      ])),
      'decision-policy:comparison-family-member',
    );
    const comparisonById = new Map(definition.comparisons.map(
      (comparison) => [comparison.comparisonId, comparison],
    ));
    const nodeByResultId = new Map(definition.analysisGraph.nodes.map(
      (node) => [node.outputResultId, node],
    ));
    for (const member of family) {
      const comparison = comparisonById.get(member.comparisonId);
      if (comparison === undefined
          || !comparison.treatmentTargetIds.includes(member.treatmentTargetId)
          || !comparison.metricIds.includes(member.metricId)) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          'DecisionPolicy comparison family 引用了不存在的 contrast。',
          { comparisonId: member.comparisonId },
        );
      }
      const producer = nodeByResultId.get(member.analysisResultId);
      const expectedInputs = [
        canonicalizeJson({
          inputKind: 'metric-observations',
          referenceId: member.metricId,
        }),
        canonicalizeJson({
          inputKind: 'comparison',
          referenceId: member.comparisonId,
          treatmentTargetId: member.treatmentTargetId,
          metricId: member.metricId,
        }),
      ].sort();
      const actualInputs = producer?.inputs.map((input) => canonicalizeJson(input)).sort();
      if (producer === undefined
          || (familyResultId === undefined
            && canonicalizeJson(actualInputs) !== canonicalizeJson(expectedInputs))) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          'Comparison family member 必须精确绑定只消费该 contrast 的 AnalysisResult。',
          { referenceId: member.analysisResultId },
        );
      }
    }
    const correctionId = definition.decisionPolicy.multipleComparisonPolicyId;
    if ((family.length > 1) !== (correctionId !== undefined)) {
      throw definitionError(
        'EVAL_DEFINITION_MISSING_REFERENCE',
        '多个 comparison family member 必须声明 correction，单个或空 family 不得伪装成多重比较。',
      );
    }
    if (correctionId !== undefined && familyResultId === undefined) {
      const correctionNodes = definition.analysisGraph.nodes.filter((node) => (
        node.analysisNodeKind === 'correction'
        && node.implementationId === correctionId
      ));
      if (correctionNodes.length !== 1
          || !definition.decisionPolicy.analysisResultIds.includes(
            correctionNodes[0].outputResultId,
          )) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          'DecisionPolicy 的 multiple-comparison policy 必须绑定唯一 correction result。',
          { referenceId: correctionId },
        );
      }
      if (hypothesisMembers.length !== family.length) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          '多重比较 family 的每个 member 都必须绑定原始 hypothesis result。',
        );
      }
      const correctionInputs = correctionNodes[0].inputs;
      const correctionResultIds = correctionInputs
        .filter((input) => input.inputKind === 'analysis-result')
        .map((input) => input.referenceId)
        .sort();
      const expectedResultIds = hypothesisMembers.map(
        (member) => member.analysisResultId,
      ).sort();
      if (correctionInputs.some((input) => input.inputKind !== 'analysis-result')
          || canonicalizeJson(correctionResultIds) !== canonicalizeJson(expectedResultIds)) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          'Correction node inputs 必须精确等于 comparison family 的原始 hypothesis results。',
          { referenceId: correctionId },
        );
      }
    } else if (correctionId !== undefined) {
      const familyProducer = nodeByResultId.get(familyResultId as string);
      if (familyProducer?.analysisNodeKind !== 'estimator'
          || familyProducer.implementationId !== correctionId) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          '权威 comparison family result 必须由声明的 estimator-owned standard 产生。',
          { referenceId: correctionId },
        );
      }
    } else if (correctionId === undefined) {
      for (const member of family) {
        if (!definition.decisionPolicy.analysisResultIds.includes(member.analysisResultId)) {
          throw definitionError(
            'EVAL_DEFINITION_MISSING_REFERENCE',
            '未校正的 comparison family member 必须直接绑定 DecisionPolicy 消费的 AnalysisResult。',
            { referenceId: member.analysisResultId },
          );
        }
      }
    }
  }
  for (const metric of definition.metrics) validateMetric(metric);
  validateEvaluatorBindings(definition);
  validateSamplingDesign(definition);
  validateGraph(
    definition.analysisGraph.nodes,
    metricIds,
    new Map(definition.comparisons.map((comparison) => [comparison.comparisonId, comparison])),
  );
  validatePolicy(definition, policy);
}

export function validateAnalysisInputs(
  node: AnalysisNodeDefinition,
  capabilities: AnalysisNodeCapabilities,
  metricsById: ReadonlyMap<string, MetricDefinition>,
  outputSchemasByResultId: ReadonlyMap<string, string>,
): void {
  const cardinalities = [
    ['metric-observations', capabilities.inputCardinalities.metricObservations],
    ['analysis-result', capabilities.inputCardinalities.analysisResults],
    ['comparison', capabilities.inputCardinalities.comparisons],
  ] as const;
  for (const [inputKind, cardinality] of cardinalities) {
    const inputCount = node.inputs.filter((input) => input.inputKind === inputKind).length;
    if (inputCount < cardinality.min
        || (cardinality.max !== undefined && inputCount > cardinality.max)) {
      throw definitionError(
        'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        'Analysis Runtime 不支持声明的输入数量。',
        { nodeId: node.nodeId, inputKind, inputCount },
      );
    }
  }
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
      if (input.inputKind === 'comparison') {
        const compatible = capabilities.inputDomains.some(
          (domain) => domain.inputKind === 'comparison',
        );
        if (compatible) continue;
      }
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
