import { digestCanonicalJson, type Sha256Digest } from './json.js';

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
  targetIds: readonly string[];
  sampleIds: readonly string[];
  pairingBlockId?: Sha256Digest;
  clusterId?: Sha256Digest;
  stratumId?: Sha256Digest;
}

export function deriveSchedulingBlockId(
  input: SchedulingBlockIdentityInput,
): Sha256Digest {
  assertTrialIndex(input.trialIndex);
  return digestCanonicalJson({
    derivation: 'omk.scheduling-block-id/v1',
    executionPlanDigest: input.executionPlanDigest,
    trialIndex: input.trialIndex,
    targetIds: sortedUnique(input.targetIds, 'targetIds'),
    sampleIds: sortedUnique(input.sampleIds, 'sampleIds'),
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
};

export function deriveTrialSeed(input: TrialSeedIdentityInput): Sha256Digest {
  assertNonEmpty(input.rootSeed, 'rootSeed');
  assertNonEmpty(input.sampleId, 'sampleId');
  if (input.seedCoupling === 'independent-by-target') {
    assertNonEmpty(input.targetId, 'targetId');
  }
  return digestCanonicalJson({
    derivation: 'omk.trial-seed/v1',
    rootSeed: input.rootSeed,
    seedCoupling: input.seedCoupling,
    schedulingBlockId: input.schedulingBlockId,
    sampleId: input.sampleId,
    ...(input.seedCoupling === 'independent-by-target'
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
