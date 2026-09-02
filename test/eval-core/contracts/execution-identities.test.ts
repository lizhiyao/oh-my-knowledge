import { describe, expect, it } from 'vitest';
import {
  deriveAttemptId,
  deriveSamplingUnitId,
  deriveSchedulingBlockId,
  deriveSchedulingTargetGroups,
  deriveTrialId,
  deriveTrialSeed,
  type Sha256Digest,
} from '../../../src/eval-core/contracts/index.js';

const executionCoordinateDigest = `sha256:${'1'.repeat(64)}` as Sha256Digest;
const randomizationDesignDigest = `sha256:${'3'.repeat(64)}` as Sha256Digest;

describe('Execution identity derivation', () => {
  it('matches the v1 domain-separated golden vector', () => {
    const pairingBlockId = deriveSamplingUnitId({
      randomizationDesignDigest,
      unitKind: 'pairing',
      memberSampleIds: ['s2', 's1'],
    });
    const schedulingBlockId = deriveSchedulingBlockId({
      randomizationDesignDigest,
      trialIndex: 0,
      coordinates: [
        { targetId: 'treatment', sampleId: 's1' },
        { targetId: 'control', sampleId: 's1' },
      ],
      pairingBlockId,
    });
    const trialId = deriveTrialId({
      executionCoordinateDigest,
      targetId: 'control',
      sampleId: 's1',
      trialIndex: 0,
    });

    expect(pairingBlockId).toBe(
      'sha256:a89efa6127d254c2dfe97878808d0986bbc693a37717872f4524404a398c8fee',
    );
    expect(schedulingBlockId).toBe(
      'sha256:4b14106cee0bcaead82843c8b0117e37df0b729c0be1009870879486dcfcc2f6',
    );
    expect(trialId).toBe(
      'sha256:7398b9ac60fd180d014db3b68779dc86a11a0353b754a7bf6ba035a9719e15e0',
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
      'sha256:f99341d83962e6ff9bef6c9ba6e8d8188cc71b3d9bbcb4c2e831ca2d7166e1ba',
    );
  });

  it('treats sampling members and scheduling arms as sets', () => {
    expect(deriveSamplingUnitId({
      randomizationDesignDigest,
      unitKind: 'pairing',
      memberSampleIds: ['s1', 's2'],
    })).toBe(deriveSamplingUnitId({
      randomizationDesignDigest,
      unitKind: 'pairing',
      memberSampleIds: ['s2', 's1'],
    }));
    expect(deriveSchedulingBlockId({
      randomizationDesignDigest,
      trialIndex: 0,
      coordinates: [
        { targetId: 't2', sampleId: 's2' },
        { targetId: 't1', sampleId: 's1' },
      ],
    })).toBe(deriveSchedulingBlockId({
      randomizationDesignDigest,
      trialIndex: 0,
      coordinates: [
        { targetId: 't1', sampleId: 's1' },
        { targetId: 't2', sampleId: 's2' },
      ],
    }));
  });

  it('preserves target/sample coordinate incidence in scheduling identity', () => {
    expect(deriveSchedulingBlockId({
      randomizationDesignDigest,
      trialIndex: 0,
      coordinates: [
        { targetId: 't1', sampleId: 's1' },
        { targetId: 't2', sampleId: 's2' },
      ],
    })).not.toBe(deriveSchedulingBlockId({
      randomizationDesignDigest,
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
      randomizationDesignDigest,
      unitKind: 'cluster',
      memberSampleIds: ['s1', 's1'],
    })).toThrow(/duplicate/);
    expect(() => deriveTrialId({
      executionCoordinateDigest,
      targetId: 't',
      sampleId: 's',
      trialIndex: -1,
    })).toThrow(/trialIndex/);
  });
});
