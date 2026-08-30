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
const randomizationDesignDigest = `sha256:${'3'.repeat(64)}` as Sha256Digest;

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
      randomizationDesignDigest,
      seedCoupling: 'shared-within-block',
      trialIndex: 0,
      sampleId: 's1',
    })).toBe(
      'sha256:5ebf2f47afac73711928a5bd7f079dcc500800f342d7bbf9e558d8bbecb2d2a7',
    );
    expect(deriveTrialSeed({
      randomizationDesignDigest,
      seedCoupling: 'independent-by-target',
      trialIndex: 0,
      sampleId: 's1',
      randomizationSlotId: 'slot-control',
    })).toBe(
      'sha256:d06893a19334e92784c221806803a724914f2108281b0b7641f3e6331826cb2c',
    );
    expect(deriveTrialSeed({
      randomizationDesignDigest,
      seedCoupling: 'uncontrolled',
      trialIndex: 0,
      sampleId: 's1',
      randomizationSlotId: 'slot-control',
    })).toBe(
      'sha256:f1b4f0911478ff68d7c94ad818dbb4ca145f69cfbbd7626d1e8fa46ff4c70b9d',
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
    const shared = deriveTrialSeed({
      randomizationDesignDigest,
      seedCoupling: 'shared-within-block',
      trialIndex: 0,
      sampleId: 'sample',
    });
    const control = deriveTrialSeed({
      randomizationDesignDigest,
      seedCoupling: 'independent-by-target',
      trialIndex: 0,
      sampleId: 'sample',
      randomizationSlotId: 'slot-control',
    });
    const treatment = deriveTrialSeed({
      randomizationDesignDigest,
      seedCoupling: 'independent-by-target',
      trialIndex: 0,
      sampleId: 'sample',
      randomizationSlotId: 'slot-treatment',
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
