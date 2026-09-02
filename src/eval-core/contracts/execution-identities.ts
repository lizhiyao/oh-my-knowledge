import {
  canonicalizeJson,
  digestCanonicalJson,
  type JsonValue,
  type Sha256Digest,
} from './json.js';
import {
  resolveEffectiveExecutionControl,
  type EffectiveExecutionControl,
} from './execution-controls.js';
import type { ExecutionPlan, ExecutionPlanPolicy, ResolvedRuntime } from './plans.js';

type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

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
  randomizationDesignDigest: Sha256Digest;
  unitKind: 'pairing' | 'cluster' | 'stratum';
  memberSampleIds: readonly string[];
}

export function deriveSamplingUnitId(input: SamplingUnitIdentityInput): Sha256Digest {
  return digestCanonicalJson({
    derivation: 'omk.sampling-unit-id/v1',
    randomizationDesignDigest: input.randomizationDesignDigest,
    unitKind: input.unitKind,
    memberSampleIds: sortedUnique(input.memberSampleIds, 'memberSampleIds'),
  });
}

export interface SchedulingBlockIdentityInput {
  randomizationDesignDigest: Sha256Digest;
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
    randomizationDesignDigest: input.randomizationDesignDigest,
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
  executionCoordinateDigest: Sha256Digest;
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
    executionCoordinateDigest: input.executionCoordinateDigest,
    targetId: input.targetId,
    sampleId: input.sampleId,
    trialIndex: input.trialIndex,
  });
}

export type TrialSeedIdentityInput = {
  randomizationDesignDigest: Sha256Digest;
  seedCoupling: 'shared-within-block';
  trialIndex: number;
  sampleId: string;
} | {
  randomizationDesignDigest: Sha256Digest;
  seedCoupling: 'independent-by-target';
  trialIndex: number;
  sampleId: string;
  randomizationSlotId: string;
} | {
  randomizationDesignDigest: Sha256Digest;
  seedCoupling: 'uncontrolled';
  trialIndex: number;
  sampleId: string;
  randomizationSlotId: string;
};

export function deriveTrialSeed(input: TrialSeedIdentityInput): Sha256Digest {
  assertTrialIndex(input.trialIndex);
  assertNonEmpty(input.sampleId, 'sampleId');
  if (input.seedCoupling !== 'shared-within-block') {
    assertNonEmpty(input.randomizationSlotId, 'randomizationSlotId');
  }
  return digestCanonicalJson({
    derivation: 'omk.trial-seed/v1',
    randomizationDesignDigest: input.randomizationDesignDigest,
    seedCoupling: input.seedCoupling,
    trialIndex: input.trialIndex,
    sampleId: input.sampleId,
    ...(input.seedCoupling !== 'shared-within-block'
      ? { randomizationSlotId: input.randomizationSlotId }
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
  execution: Pick<DeepReadonly<ExecutionPlan>,
  | 'executionPlanDigest'
  | 'randomizationDesignDigest'
  | 'samples'
  | 'targets'
  | 'runtimes'
  | 'policy'
  | 'extensions'
  | 'schedulingTargetGroups'
  | 'experiment'>;
}

export interface PlannedExecutionCoordinate {
  targetId: string;
  randomizationSlotId: string;
  sampleId: string;
  trialIndex: number;
  executionCoordinateDigest: Sha256Digest;
  executionControl: EffectiveExecutionControl;
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
      randomizationDesignDigest: plan.execution.randomizationDesignDigest as Sha256Digest,
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
  if (left.randomizationSlotId < right.randomizationSlotId) return -1;
  if (left.randomizationSlotId > right.randomizationSlotId) return 1;
  if (left.sampleId < right.sampleId) return -1;
  if (left.sampleId > right.sampleId) return 1;
  return left.trialIndex - right.trialIndex
    || (left.targetId < right.targetId ? -1 : left.targetId > right.targetId ? 1 : 0);
}

export interface ExecutionCoordinateDigestInput {
  randomizationDesignDigest: Sha256Digest;
  sample: ExecutionIdentityPlanContext['execution']['samples'][number];
  target: ExecutionIdentityPlanContext['execution']['targets'][number];
  runtime: DeepReadonly<ResolvedRuntime>;
  executionControl: DeepReadonly<EffectiveExecutionControl>;
  policy: DeepReadonly<ExecutionPlanPolicy>;
  extensions?: ExecutionIdentityPlanContext['execution']['extensions'];
}

export function deriveExecutionCoordinateDigest(
  input: ExecutionCoordinateDigestInput,
): Sha256Digest {
  const { executionControls: _controls, executionRequirements, ...target } = input.target;
  void _controls;
  const sample = {
    sampleId: input.sample.sampleId,
    input: input.sample.input,
    ...(input.sample.executionContext === undefined
      ? {}
      : { executionContext: input.sample.executionContext }),
  };
  return digestCanonicalJson({
    derivation: 'omk.execution-coordinate/v1',
    randomizationDesignDigest: input.randomizationDesignDigest,
    sample,
    target: {
      ...target,
      executionRequirements: {
        ...executionRequirements,
        workspace: input.executionControl.workspace.workspaceMode,
        toolPolicy: input.executionControl.tools.toolPolicyKind,
      },
    },
    runtime: input.runtime,
    executionControl: input.executionControl,
    policy: input.policy,
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
  });
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
  const randomizationSlotByTarget = new Map(execution.experiment.randomizationSlots.map(
    (slot) => [slot.targetId, slot.randomizationSlotId],
  ));
  const targetById = new Map(execution.targets.map((target) => [target.targetId, target]));
  const runtimeByTarget = new Map(execution.runtimes.flatMap((runtime) => (
    runtime.runtimeKind === 'executor' ? [[runtime.referenceId, runtime] as const] : []
  )));
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
          randomizationDesignDigest: execution.randomizationDesignDigest as Sha256Digest,
          trialIndex,
          coordinates: blockCoordinates,
          ...samplingUnitIds,
        });
        for (const { targetId, sampleId } of blockCoordinates) {
          const randomizationSlotId = randomizationSlotByTarget.get(targetId);
          if (randomizationSlotId === undefined) {
            throw new TypeError(`Missing randomization slot for Target ${targetId}`);
          }
          const target = targetById.get(targetId);
          const runtime = runtimeByTarget.get(targetId);
          if (target === undefined || runtime === undefined) {
            throw new TypeError(`Missing sealed execution identity input for Target ${targetId}`);
          }
          const executionControl = resolveEffectiveExecutionControl(
            target.executionControls,
            sampleId,
          );
          const executionCoordinateDigest = deriveExecutionCoordinateDigest({
            randomizationDesignDigest: execution.randomizationDesignDigest as Sha256Digest,
            sample,
            target,
            runtime,
            executionControl,
            policy: execution.policy,
            ...(execution.extensions === undefined ? {} : { extensions: execution.extensions }),
          });
          const trialId = deriveTrialId({
            executionCoordinateDigest,
            targetId,
            sampleId,
            trialIndex,
          });
          const trialSeed = sampling.seedCoupling === 'shared-within-block'
            ? deriveTrialSeed({
              randomizationDesignDigest: execution.randomizationDesignDigest as Sha256Digest,
              seedCoupling: sampling.seedCoupling,
              trialIndex,
              sampleId,
            })
            : deriveTrialSeed({
              randomizationDesignDigest: execution.randomizationDesignDigest as Sha256Digest,
              seedCoupling: sampling.seedCoupling,
              trialIndex,
              sampleId,
              randomizationSlotId,
            });
          coordinates.push({
            targetId,
            randomizationSlotId,
            sampleId,
            trialIndex,
            executionCoordinateDigest,
            executionControl,
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
