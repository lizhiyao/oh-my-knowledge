import { describe, expect, it } from 'vitest';
import {
  clopperPearsonInterval,
} from '../../../src/eval-workflows/analysis/binomial-confidence.js';

describe('Clopper-Pearson binomial confidence interval', () => {
  it('matches exact boundary and central reference values', () => {
    expect(clopperPearsonInterval(0, 100, 0.95)).toEqual({
      lower: 0,
      upper: expect.closeTo(0.0362166926, 9),
    });
    expect(clopperPearsonInterval(100, 100, 0.95)).toEqual({
      lower: expect.closeTo(0.9637833074, 9),
      upper: 1,
    });
    expect(clopperPearsonInterval(5, 10, 0.95)).toEqual({
      lower: expect.closeTo(0.1870860284, 9),
      upper: expect.closeTo(0.8129139716, 9),
    });
  });

  it('rejects invalid counts and confidence levels', () => {
    expect(() => clopperPearsonInterval(-1, 10, 0.95)).toThrow(/invalid/);
    expect(() => clopperPearsonInterval(11, 10, 0.95)).toThrow(/invalid/);
    expect(() => clopperPearsonInterval(1, 0, 0.95)).toThrow(/invalid/);
    expect(() => clopperPearsonInterval(1, 10, 1)).toThrow(/invalid/);
  });
});
