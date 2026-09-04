import { describe, expect, it } from 'vitest';
import {
  requiredPairedComparisonUnits,
} from '../../../src/eval-workflows/analysis/sample-size.js';

const baseline = {
  minimumDetectableDifference: 0.5,
  expectedDifferenceStandardDeviation: 1,
  targetPower: 0.8,
  familywiseAlpha: 0.05,
  plannedComparisonCount: 1,
} as const;

describe('a priori paired-comparison sample-size planning', () => {
  it('matches reference normal-approximation planning vectors', () => {
    expect(requiredPairedComparisonUnits(baseline)).toBe(32);
    expect(requiredPairedComparisonUnits({
      ...baseline,
      plannedComparisonCount: 2,
    })).toBe(39);
  });

  it('changes monotonically with the sealed design assumptions', () => {
    const planned = requiredPairedComparisonUnits(baseline);
    expect(requiredPairedComparisonUnits({ ...baseline, targetPower: 0.9 })).toBeGreaterThan(planned);
    expect(requiredPairedComparisonUnits({
      ...baseline,
      expectedDifferenceStandardDeviation: 1.5,
    })).toBeGreaterThan(planned);
    expect(requiredPairedComparisonUnits({
      ...baseline,
      minimumDetectableDifference: 0.75,
    })).toBeLessThan(planned);
  });

  it.each([
    { ...baseline, minimumDetectableDifference: 0 },
    { ...baseline, minimumDetectableDifference: Number.POSITIVE_INFINITY },
    { ...baseline, expectedDifferenceStandardDeviation: Number.NaN },
    { ...baseline, targetPower: 0.5 },
    { ...baseline, familywiseAlpha: 1 },
    { ...baseline, plannedComparisonCount: 0 },
  ])('rejects invalid planning assumptions', (assumptions) => {
    expect(() => requiredPairedComparisonUnits(assumptions)).toThrow(TypeError);
  });
});
