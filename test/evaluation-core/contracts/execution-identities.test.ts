import { describe, expect, it } from 'vitest';
import {
  deriveAttemptId,
  deriveSamplingUnitId,
  deriveSchedulingBlockId,
  deriveTrialId,
  deriveTrialSeed,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';

const executionPlanDigest = `sha256:${'1'.repeat(64)}` as Sha256Digest;

describe('Execution identity derivation', () => {
  it('matches the v1 domain-separated golden vector', () => {
    const pairingBlockId = deriveSamplingUnitId({
      executionPlanDigest,
      unitKind: 'pairing',
      memberSampleIds: ['s2', 's1'],
    });
    const schedulingBlockId = deriveSchedulingBlockId({
      executionPlanDigest,
      trialIndex: 0,
      targetIds: ['treatment', 'control'],
      sampleIds: ['s1', 's2'],
      pairingBlockId,
    });
    const trialId = deriveTrialId({
      executionPlanDigest,
      targetId: 'control',
      sampleId: 's1',
      trialIndex: 0,
    });

    expect(pairingBlockId).toBe(
      'sha256:ebadbb4f19e742a368d1cba4013a295ff7eaf36b58b5b4da0f0306909cebd4fe',
    );
    expect(schedulingBlockId).toBe(
      'sha256:ee5ca2c68e77d436746f0f62c0d613c8d259f1a989b6f528f7153c258835dd3e',
    );
    expect(trialId).toBe(
      'sha256:6627fa21a900f74e3d5c6aa726ca5e5090595c0617d2385fff59afcf0b84dfa8',
    );
    expect(deriveTrialSeed({
      rootSeed: 'seed-1',
      seedCoupling: 'shared-within-block',
      schedulingBlockId,
      sampleId: 's1',
    })).toBe(
      'sha256:f1eb2f39b43ce07b47935d783ad32f34fb77062d59f2d671bd84942bdc141749',
    );
    expect(deriveTrialSeed({
      rootSeed: 'seed-1',
      seedCoupling: 'independent-by-target',
      schedulingBlockId,
      sampleId: 's1',
      targetId: 'control',
    })).toBe(
      'sha256:a8cd44e0f720f0cba70f77e6787892aaec98f240bf8e63ca093f5ad6a4f0f861',
    );
    expect(deriveAttemptId({ trialId, attemptNumber: 1 })).toBe(
      'sha256:f664c308f4675c875006748ec0893aa279b47a2eb97d52e8845a13fcd27cc833',
    );
  });

  it('treats sampling members and scheduling arms as sets', () => {
    expect(deriveSamplingUnitId({
      executionPlanDigest,
      unitKind: 'pairing',
      memberSampleIds: ['s1', 's2'],
    })).toBe(deriveSamplingUnitId({
      executionPlanDigest,
      unitKind: 'pairing',
      memberSampleIds: ['s2', 's1'],
    }));
  });

  it('makes seed coupling an explicit construct-validity choice', () => {
    const schedulingBlockId = `sha256:${'2'.repeat(64)}` as Sha256Digest;
    const shared = deriveTrialSeed({
      rootSeed: 'root',
      seedCoupling: 'shared-within-block',
      schedulingBlockId,
      sampleId: 'sample',
    });
    const control = deriveTrialSeed({
      rootSeed: 'root',
      seedCoupling: 'independent-by-target',
      schedulingBlockId,
      sampleId: 'sample',
      targetId: 'control',
    });
    const treatment = deriveTrialSeed({
      rootSeed: 'root',
      seedCoupling: 'independent-by-target',
      schedulingBlockId,
      sampleId: 'sample',
      targetId: 'treatment',
    });

    expect(control).not.toBe(treatment);
    expect(shared).not.toBe(control);
  });

  it('rejects ambiguous identity inputs', () => {
    expect(() => deriveSamplingUnitId({
      executionPlanDigest,
      unitKind: 'cluster',
      memberSampleIds: ['s1', 's1'],
    })).toThrow(/duplicate/);
    expect(() => deriveTrialId({
      executionPlanDigest,
      targetId: 't',
      sampleId: 's',
      trialIndex: -1,
    })).toThrow(/trialIndex/);
  });
});
