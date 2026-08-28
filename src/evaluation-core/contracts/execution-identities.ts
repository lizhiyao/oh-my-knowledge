import {
  canonicalizeJson,
  digestCanonicalJson,
  type JsonValue,
  type Sha256Digest,
} from './json.js';

function sortedUnique(values: readonly string[], field: string): string[] {
  if (values.length === 0) throw new TypeError(`${field} must not be empty`);
  if (values.some((value) => value.length === 0)) {
    throw new TypeError(`${field} must contain non-empty identifiers`);
  }
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${field} must not contain duplicate identifiers`);
  }
  return [...values].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function assertTrialIndex(trialIndex: number): void {
  if (!Number.isSafeInteger(trialIndex) || trialIndex < 0) {
    throw new TypeError('trialIndex must be a non-negative safe integer');
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new TypeError(`${field} must not be empty`);
}

export interface SamplingUnitIdentityInput {
  executionPlanDigest: Sha256Digest;
  unitKind: 'pairing' | 'cluster' | 'stratum';
  memberSampleIds: readonly string[];
}

export function deriveSamplingUnitId(input: SamplingUnitIdentityInput): Sha256Digest {
  return digestCanonicalJson({
    derivation: 'omk.sampling-unit-id/v1',
    executionPlanDigest: input.executionPlanDigest,
    unitKind: input.unitKind,
    memberSampleIds: sortedUnique(input.memberSampleIds, 'memberSampleIds'),
  });
}

export interface SchedulingBlockIdentityInput {
  executionPlanDigest: Sha256Digest;
  trialIndex: number;
  coordinates: readonly SchedulingCoordinateInput[];
  pairingBlockId?: Sha256Digest;
  clusterId?: Sha256Digest;
  stratumId?: Sha256Digest;
}

export interface SchedulingCoordinateInput {
  targetId: string;
  sampleId: string;
}

function sortedUniqueCoordinates(
  coordinates: readonly SchedulingCoordinateInput[],
): SchedulingCoordinateInput[] {
  if (coordinates.length === 0) throw new TypeError('coordinates must not be empty');
  const sorted = coordinates.map(({ targetId, sampleId }) => {
    assertNonEmpty(targetId, 'coordinates.targetId');
    assertNonEmpty(sampleId, 'coordinates.sampleId');
    return { targetId, sampleId };
  }).sort((left, right) => {
    if (left.targetId < right.targetId) return -1;
    if (left.targetId > right.targetId) return 1;
    if (left.sampleId < right.sampleId) return -1;
    if (left.sampleId > right.sampleId) return 1;
    return 0;
  });
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].targetId === sorted[index].targetId
        && sorted[index - 1].sampleId === sorted[index].sampleId) {
      throw new TypeError('coordinates must not contain duplicate coordinates');
    }
  }
  return sorted;
}

export function deriveSchedulingBlockId(
  input: SchedulingBlockIdentityInput,
): Sha256Digest {
  assertTrialIndex(input.trialIndex);
  return digestCanonicalJson({
    derivation: 'omk.scheduling-block-id/v1',
    executionPlanDigest: input.executionPlanDigest,
    trialIndex: input.trialIndex,
    coordinates: sortedUniqueCoordinates(input.coordinates),
    ...(input.pairingBlockId !== undefined
      ? { pairingBlockId: input.pairingBlockId }
      : {}),
    ...(input.clusterId !== undefined ? { clusterId: input.clusterId } : {}),
    ...(input.stratumId !== undefined ? { stratumId: input.stratumId } : {}),
  });
}

export interface TrialIdentityInput {
  executionPlanDigest: Sha256Digest;
  targetId: string;
  sampleId: string;
  trialIndex: number;
}

export function deriveTrialId(input: TrialIdentityInput): Sha256Digest {
  assertTrialIndex(input.trialIndex);
  assertNonEmpty(input.targetId, 'targetId');
  assertNonEmpty(input.sampleId, 'sampleId');
  return digestCanonicalJson({
    derivation: 'omk.trial-id/v1',
    executionPlanDigest: input.executionPlanDigest,
    targetId: input.targetId,
    sampleId: input.sampleId,
    trialIndex: input.trialIndex,
  });
}

export type TrialSeedIdentityInput = {
  rootSeed: string;
  seedCoupling: 'shared-within-block';
  schedulingBlockId: Sha256Digest;
  sampleId: string;
} | {
  rootSeed: string;
  seedCoupling: 'independent-by-target';
  schedulingBlockId: Sha256Digest;
  sampleId: string;
  targetId: string;
} | {
  rootSeed: string;
  seedCoupling: 'uncontrolled';
  schedulingBlockId: Sha256Digest;
  sampleId: string;
  targetId: string;
};

export function deriveTrialSeed(input: TrialSeedIdentityInput): Sha256Digest {
  assertNonEmpty(input.rootSeed, 'rootSeed');
  assertNonEmpty(input.sampleId, 'sampleId');
  if (input.seedCoupling !== 'shared-within-block') {
    assertNonEmpty(input.targetId, 'targetId');
  }
  return digestCanonicalJson({
    derivation: 'omk.trial-seed/v1',
    rootSeed: input.rootSeed,
    seedCoupling: input.seedCoupling,
    schedulingBlockId: input.schedulingBlockId,
    sampleId: input.sampleId,
    ...(input.seedCoupling !== 'shared-within-block'
      ? { targetId: input.targetId }
      : {}),
  });
}

export interface AttemptIdentityInput {
  trialId: Sha256Digest;
  attemptNumber: number;
}

export function deriveAttemptId(input: AttemptIdentityInput): Sha256Digest {
  if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1) {
    throw new TypeError('attemptNumber must be a positive safe integer');
  }
  return digestCanonicalJson({
    derivation: 'omk.execution-attempt-id/v1',
    trialId: input.trialId,
    attemptNumber: input.attemptNumber,
  });
}

export interface ExecutionIdentityPlanContext {
  execution: {
    executionPlanDigest: string;
    samples: readonly {
      sampleId: string;
      input: unknown;
      executionContext?: unknown;
    }[];
    targets: readonly { targetId: string }[];
    schedulingTargetGroups: readonly (readonly string[])[];
    experiment: {
      trials: number;
      seed: string;
      sampling: {
        pairingKey?: string;
        clusterKey?: string;
        stratumKey?: string;
        resamplingUnit: 'sample' | 'paired-block' | 'cluster' | 'run';
        seedCoupling: 'shared-within-block' | 'independent-by-target' | 'uncontrolled';
      };
    };
  };
}

export interface PlannedExecutionCoordinate {
  targetId: string;
  sampleId: string;
  trialIndex: number;
  trialId: Sha256Digest;
  trialSeed: Sha256Digest;
  schedulingBlockId: Sha256Digest;
  samplingUnitIds: {
    pairingBlockId?: Sha256Digest;
    clusterId?: Sha256Digest;
    stratumId?: Sha256Digest;
  };
}

function resolvePointer(value: unknown, pointer: string): JsonValue {
  let current = value;
  if (pointer !== '') {
    for (const encodedToken of pointer.slice(1).split('/')) {
      const token = encodedToken.replaceAll('~1', '/').replaceAll('~0', '~');
      if (current === null || typeof current !== 'object') {
        throw new TypeError(`Sampling pointer ${pointer} does not resolve`);
      }
      if (Array.isArray(current)) {
        if (!/^(?:0|[1-9]\d*)$/.test(token)) {
          throw new TypeError(`Sampling pointer ${pointer} does not resolve`);
        }
        current = current[Number(token)];
      } else {
        if (!Object.prototype.hasOwnProperty.call(current, token)) {
          throw new TypeError(`Sampling pointer ${pointer} does not resolve`);
        }
        current = (current as Record<string, unknown>)[token];
      }
    }
  }
  canonicalizeJson(current);
  return current as JsonValue;
}

function deriveMembershipBySample(
  plan: ExecutionIdentityPlanContext,
  unitKind: SamplingUnitIdentityInput['unitKind'],
  pointer: string | undefined,
): Map<string, Sha256Digest> {
  const result = new Map<string, Sha256Digest>();
  if (pointer === undefined) return result;
  const groups = new Map<string, string[]>();
  for (const sample of plan.execution.samples) {
    const key = canonicalizeJson(resolvePointer(sample, pointer));
    const members = groups.get(key) ?? [];
    members.push(sample.sampleId);
    groups.set(key, members);
  }
  for (const members of groups.values()) {
    const unitId = deriveSamplingUnitId({
      executionPlanDigest: plan.execution.executionPlanDigest as Sha256Digest,
      unitKind,
      memberSampleIds: members,
    });
    for (const sampleId of members) result.set(sampleId, unitId);
  }
  return result;
}

export interface SchedulingTargetGroupsInput {
  targetIds: readonly string[];
  comparisons: readonly {
    controlTargetId: string;
    treatmentTargetIds: readonly string[];
  }[];
  paired: boolean;
}

function compareIdentifierGroups(left: readonly string[], right: readonly string[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

export function deriveSchedulingTargetGroups(
  input: SchedulingTargetGroupsInput,
): string[][] {
  const targetIds = sortedUnique(input.targetIds, 'targetIds');
  if (!input.paired) return targetIds.map((targetId) => [targetId]);

  const parents = new Map(targetIds.map((targetId) => [targetId, targetId]));
  const find = (targetId: string): string => {
    const parent = parents.get(targetId);
    if (parent === undefined) throw new TypeError(`Unknown comparison target ${targetId}`);
    if (parent === targetId) return targetId;
    const root = find(parent);
    parents.set(targetId, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [parent, child] = leftRoot < rightRoot
      ? [leftRoot, rightRoot]
      : [rightRoot, leftRoot];
    parents.set(child, parent);
  };
  for (const comparison of input.comparisons) {
    find(comparison.controlTargetId);
    for (const treatmentTargetId of comparison.treatmentTargetIds) {
      union(comparison.controlTargetId, treatmentTargetId);
    }
  }
  const groups = new Map<string, string[]>();
  for (const targetId of targetIds) {
    const root = find(targetId);
    const members = groups.get(root) ?? [];
    members.push(targetId);
    groups.set(root, members);
  }
  return [...groups.values()]
    .map((members) => members.sort())
    .sort(compareIdentifierGroups);
}

function validateSchedulingTargetGroups(
  plan: ExecutionIdentityPlanContext,
): string[][] {
  const targetIds = sortedUnique(
    plan.execution.targets.map((target) => target.targetId),
    'execution.targets',
  );
  const expected = new Set(targetIds);
  const seen = new Set<string>();
  const groups = plan.execution.schedulingTargetGroups.map((group, groupIndex) => {
    const members = sortedUnique(group, `schedulingTargetGroups[${groupIndex}]`);
    for (const targetId of members) {
      if (!expected.has(targetId)) {
        throw new TypeError(`Unknown scheduling target ${targetId}`);
      }
      if (seen.has(targetId)) {
        throw new TypeError(`Scheduling target ${targetId} appears more than once`);
      }
      seen.add(targetId);
    }
    if (plan.execution.experiment.sampling.resamplingUnit !== 'paired-block'
        && members.length !== 1) {
      throw new TypeError('Non-paired execution requires singleton scheduling groups');
    }
    return members;
  }).sort(compareIdentifierGroups);
  if (seen.size !== targetIds.length) {
    const missing = targetIds.filter((targetId) => !seen.has(targetId));
    throw new TypeError(`Scheduling target groups omit ${missing.join(', ')}`);
  }
  return groups;
}

function comparePlannedCoordinates(
  left: PlannedExecutionCoordinate,
  right: PlannedExecutionCoordinate,
): number {
  if (left.targetId < right.targetId) return -1;
  if (left.targetId > right.targetId) return 1;
  if (left.sampleId < right.sampleId) return -1;
  if (left.sampleId > right.sampleId) return 1;
  return left.trialIndex - right.trialIndex;
}

export function derivePlannedExecutionCoordinates(
  plan: ExecutionIdentityPlanContext,
): PlannedExecutionCoordinate[] {
  const { execution } = plan;
  const { sampling } = execution.experiment;
  const pairingBySample = deriveMembershipBySample(
    plan,
    'pairing',
    sampling.pairingKey,
  );
  const clusterBySample = deriveMembershipBySample(plan, 'cluster', sampling.clusterKey);
  const stratumBySample = deriveMembershipBySample(plan, 'stratum', sampling.stratumKey);
  const targetGroups = validateSchedulingTargetGroups(plan);
  const coordinates: PlannedExecutionCoordinate[] = [];

  for (let trialIndex = 0; trialIndex < execution.experiment.trials; trialIndex += 1) {
    for (const sample of execution.samples) {
      const samplingUnitIds = {
        ...(pairingBySample.has(sample.sampleId)
          ? { pairingBlockId: pairingBySample.get(sample.sampleId) }
          : {}),
        ...(clusterBySample.has(sample.sampleId)
          ? { clusterId: clusterBySample.get(sample.sampleId) }
          : {}),
        ...(stratumBySample.has(sample.sampleId)
          ? { stratumId: stratumBySample.get(sample.sampleId) }
          : {}),
      };
      for (const targetGroup of targetGroups) {
        const blockCoordinates = targetGroup.map((targetId) => ({
          targetId,
          sampleId: sample.sampleId,
        }));
        const schedulingBlockId = deriveSchedulingBlockId({
          executionPlanDigest: execution.executionPlanDigest as Sha256Digest,
          trialIndex,
          coordinates: blockCoordinates,
          ...samplingUnitIds,
        });
        for (const { targetId, sampleId } of blockCoordinates) {
          const trialId = deriveTrialId({
            executionPlanDigest: execution.executionPlanDigest as Sha256Digest,
            targetId,
            sampleId,
            trialIndex,
          });
          const trialSeed = sampling.seedCoupling === 'shared-within-block'
            ? deriveTrialSeed({
              rootSeed: execution.experiment.seed,
              seedCoupling: sampling.seedCoupling,
              schedulingBlockId,
              sampleId,
            })
            : deriveTrialSeed({
              rootSeed: execution.experiment.seed,
              seedCoupling: sampling.seedCoupling,
              schedulingBlockId,
              sampleId,
              targetId,
            });
          coordinates.push({
            targetId,
            sampleId,
            trialIndex,
            trialId,
            trialSeed,
            schedulingBlockId,
            samplingUnitIds,
          });
        }
      }
    }
  }
  return coordinates.sort(comparePlannedCoordinates);
}
