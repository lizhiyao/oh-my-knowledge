import { describe, expect, it } from 'vitest';
import { pickByStride, splitHoldout } from '../../src/shared/holdout.js';

describe('shared holdout assignment', () => {
  it('selects a deterministic cohort spread across canonical order', () => {
    expect([...pickByStride(['s1', 's2', 's3', 's4', 's5', 's6'], 3)]).toEqual(['s1', 's3', 's5']);
  });

  it('partitions samples without overlap when both cohorts are measurable', () => {
    const split = splitHoldout(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'], 0.375);
    expect(split).not.toBeNull();
    expect([...split!.holdoutIds]).toEqual(['s1', 's3', 's6']);
    expect([...split!.trainIds]).toEqual(['s2', 's4', 's5', 's7', 's8']);
  });

  it('disables holdout rather than emitting underpowered cohorts', () => {
    expect(splitHoldout(['s1', 's2', 's3', 's4', 's5'], 0.4)).toBeNull();
    expect(splitHoldout(['s1', 's2', 's3'], 0)).toBeNull();
  });
});
