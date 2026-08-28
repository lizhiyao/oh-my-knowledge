import { describe, expect, it } from 'vitest';
import {
  deriveAttemptId,
  deriveSamplingUnitId,
  deriveSchedulingBlockId,
  deriveSchedulingTargetGroups,
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
      coordinates: [
        { targetId: 'treatment', sampleId: 's1' },
        { targetId: 'control', sampleId: 's1' },
      ],
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
      'sha256:c3b78a4903377b684c7a120d8f00bf360613107fc5968ff43214c91f03727cd0',
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
      'sha256:e42e56fb54bfc0f8dd1351bc498c20aab65ae326a9461b406b23b60ed6f08d3d',
    );
    expect(deriveTrialSeed({
      rootSeed: 'seed-1',
      seedCoupling: 'independent-by-target',
      schedulingBlockId,
      sampleId: 's1',
      targetId: 'control',
    })).toBe(
      'sha256:a626240acc0b900f5a9c3b8522b1a1f939eea1909b8504d56e1ce501e850c45f',
    );
    expect(deriveTrialSeed({
      rootSeed: 'seed-1',
      seedCoupling: 'uncontrolled',
      schedulingBlockId,
      sampleId: 's1',
      targetId: 'control',
    })).toBe(
      'sha256:3da1ced0b792b5a67dc18d33e6dd7ccd37f1e1bd50232c9321fc870e0f26ad8c',
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
    expect(deriveSchedulingBlockId({
      executionPlanDigest,
      trialIndex: 0,
      coordinates: [
        { targetId: 't2', sampleId: 's2' },
        { targetId: 't1', sampleId: 's1' },
      ],
    })).toBe(deriveSchedulingBlockId({
      executionPlanDigest,
      trialIndex: 0,
      coordinates: [
        { targetId: 't1', sampleId: 's1' },
        { targetId: 't2', sampleId: 's2' },
      ],
    }));
  });

  it('preserves target/sample coordinate incidence in scheduling identity', () => {
    expect(deriveSchedulingBlockId({
      executionPlanDigest,
      trialIndex: 0,
      coordinates: [
        { targetId: 't1', sampleId: 's1' },
        { targetId: 't2', sampleId: 's2' },
      ],
    })).not.toBe(deriveSchedulingBlockId({
      executionPlanDigest,
      trialIndex: 0,
      coordinates: [
        { targetId: 't1', sampleId: 's2' },
        { targetId: 't2', sampleId: 's1' },
      ],
    }));
  });

  it('materializes canonical paired scheduling groups from comparison connectivity', () => {
    expect(deriveSchedulingTargetGroups({
      targetIds: ['variant-b', 'control', 'variant-a', 'unpaired'],
      comparisons: [
        { controlTargetId: 'control', treatmentTargetIds: ['variant-a'] },
        { controlTargetId: 'variant-a', treatmentTargetIds: ['variant-b'] },
      ],
      paired: true,
    })).toEqual([
      ['control', 'variant-a', 'variant-b'],
      ['unpaired'],
    ]);
  });

  it('keeps non-paired scheduling groups independent from Decision comparisons', () => {
    expect(deriveSchedulingTargetGroups({
      targetIds: ['treatment', 'control'],
      comparisons: [{
        controlTargetId: 'control',
        treatmentTargetIds: ['treatment'],
      }],
      paired: false,
    })).toEqual([['control'], ['treatment']]);
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
