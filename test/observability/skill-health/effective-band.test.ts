import { describe, expect, it } from 'vitest';
import { effectiveObserveBand } from '../../../src/observability/skill-health/analyzer.js';

describe('effectiveObserveBand', () => {
  it('keeps an absent observation unscored', () => {
    expect(effectiveObserveBand(null)).toBe('gray');
  });

  for (const healthBand of ['green', 'yellow', 'red'] as const) {
    for (const confidence of ['underpowered', 'low', 'high'] as const) {
      it(`${healthBand} with ${confidence} confidence`, () => {
        const evidence = { healthBand, confidence };
        expect(effectiveObserveBand(evidence)).toBe(confidence === 'underpowered' ? 'gray' : healthBand);
        expect(evidence).toEqual({ healthBand, confidence });
      });
    }
  }

  it.each([
    { toolCallCount: 0, expected: 'green' },
    { toolCallCount: 4, expected: 'gray' },
    { toolCallCount: 5, expected: 'green' },
    { toolCallCount: 8, toolResolvedCount: 4, expected: 'gray' },
    { toolCallCount: 8, toolResolvedCount: 5, expected: 'green' },
    { toolCallCount: 8, toolResolvedCount: 5, toolCancelledCount: 1, expected: 'gray' },
    { toolCallCount: 8, toolResolvedCount: 6, toolCancelledCount: 1, expected: 'green' },
    { toolCallCount: 8, toolResolvedCount: 0, expected: 'gray' },
  ])('applies the comparable tool result boundary: $expected', ({ expected, ...counts }) => {
    expect(effectiveObserveBand({ healthBand: 'green', confidence: 'high', ...counts })).toBe(expected);
    expect(effectiveObserveBand({ healthBand: 'yellow', confidence: 'high', ...counts })).toBe('yellow');
    expect(effectiveObserveBand({ healthBand: 'red', confidence: 'high', ...counts })).toBe('red');
  });
});
