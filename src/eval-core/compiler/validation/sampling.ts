import { compareStrings } from '../../primitives/ordering.js';
import { resolveJsonPointer } from '../../primitives/json-pointer.js';
import { canonicalizeJson, deriveAssignmentMemberships, deriveSchedulingTargetGroups, projectExecutionInputs, type EvaluationDefinition, type JsonValue } from '../../contracts/index.js';
import { definitionError } from '../errors.js';
import { assertUnique, assertReference, resolvesPointer } from './shared.js';

function validateDesignPointers(definition: EvaluationDefinition): void {
  const executionSamples = projectExecutionInputs(definition.dataset);
  const pointers = [
    ['pairingKey', definition.experiment.sampling.pairingKey],
    ['clusterKey', definition.experiment.sampling.clusterKey],
    ['stratumKey', definition.experiment.assignment.stratumKey],
  ] as const;

  for (const [field, pointer] of pointers) {
    if (pointer === undefined) continue;
    for (const sample of executionSamples) {
      if (!resolvesPointer(sample, pointer)) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          `${field === 'stratumKey' ? 'AssignmentDesign' : 'SamplingDesign'}.${field} 无法在 execution-visible sample 中定位值。`,
          {
            location: field === 'stratumKey'
              ? 'experiment.assignment.stratumKey'
              : `experiment.sampling.${field}`,
            sampleId: sample.sampleId,
          },
        );
      }
    }
  }
  const { pairingKey } = definition.experiment.sampling;
  const { stratumKey } = definition.experiment.assignment;
  if (pairingKey === undefined || stratumKey === undefined) return;
  const strataByPairingBlock = new Map<string, string>();
  for (const sample of executionSamples) {
    const pairing = resolveJsonPointer(sample, pairingKey);
    const stratum = resolveJsonPointer(sample, stratumKey);
    if (!pairing.resolved || !stratum.resolved) continue;
    const pairingId = canonicalizeJson(pairing.value as JsonValue);
    const stratumId = canonicalizeJson(stratum.value as JsonValue);
    const previousStratum = strataByPairingBlock.get(pairingId);
    if (previousStratum !== undefined && previousStratum !== stratumId) {
      throw definitionError(
        'EVAL_DEFINITION_POLICY_INVALID',
        '一个 pairing block 不能跨越多个 stratum。',
        { location: 'experiment.sampling.pairingKey', sampleId: sample.sampleId },
      );
    }
    strataByPairingBlock.set(pairingId, stratumId);
  }
}

export function validateSamplingDesign(definition: EvaluationDefinition): void {
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
        : compareStrings(left.targetId, right.targetId)
  ));
  if (canonicalizeJson(canonicalSlots) !== canonicalizeJson(experiment.randomizationSlots)) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'randomizationSlots 必须按 randomizationSlotId、targetId 的 canonical 顺序排列。',
      { location: 'experiment.randomizationSlots' },
    );
  }
  const declaredSlotIds = experiment.randomizationSlots.map(
    (slot) => slot.randomizationSlotId,
  ).sort();
  const assignmentSlotIds = experiment.assignment.assignmentKind === 'complete-block'
    ? experiment.assignment.randomizationSlotIds
    : experiment.assignment.allocations.map((allocation) => allocation.randomizationSlotId);
  assertUnique(assignmentSlotIds, 'experiment:assignment-slot');
  const canonicalAssignmentSlotIds = [...assignmentSlotIds].sort();
  if (canonicalizeJson(canonicalAssignmentSlotIds) !== canonicalizeJson(assignmentSlotIds)) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'Assignment slots 必须按 randomizationSlotId 的 canonical 顺序排列。',
      { location: 'experiment.assignment' },
    );
  }
  if (canonicalizeJson(canonicalAssignmentSlotIds) !== canonicalizeJson(declaredSlotIds)) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      'Assignment 必须恰好覆盖全部 randomization slots。',
      { location: 'experiment.assignment' },
    );
  }
  if (experiment.assignment.assignmentKind === 'independent-groups') {
    if (sampling.experimentalUnit !== 'sample'
        || sampling.resamplingUnit !== 'sample'
        || sampling.seedCoupling !== 'independent-by-target'
        || definition.comparisons.length === 0) {
      throw definitionError(
        'EVAL_DEFINITION_POLICY_INVALID',
        'independent-groups 要求 sample experimental／resampling unit、independent-by-target seed coupling 和至少一个 Comparison。',
        { location: 'experiment' },
      );
    }
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
  try {
    deriveAssignmentMemberships({
      samples: projectExecutionInputs(definition.dataset),
      experiment,
    });
  } catch (error) {
    throw definitionError(
      'EVAL_DEFINITION_POLICY_INVALID',
      error instanceof Error ? error.message : 'Assignment 无法确定性编译。',
      { location: 'experiment.assignment' },
    );
  }
}
