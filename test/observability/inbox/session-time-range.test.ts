import { describe, expect, it } from 'vitest';
import { buildOverallSessionTimeRange } from '../../../src/observability/inbox/session-time-range.js';

describe('buildOverallSessionTimeRange', () => {
  it('keeps empty and incomplete ranges empty', () => {
    expect(buildOverallSessionTimeRange()).toEqual({ from: '', to: '' });
    expect(buildOverallSessionTimeRange([])).toEqual({ from: '', to: '' });
    expect(buildOverallSessionTimeRange([{ startTimestamp: '2026-09-01T00:00:00Z' }]))
      .toEqual({ from: '', to: '' });
    expect(buildOverallSessionTimeRange([{ endTimestamp: '2026-09-01T00:00:00Z' }]))
      .toEqual({ from: '', to: '' });
  });

  it('combines independent extrema without sorting or mutating session evidence', () => {
    const ranges = Object.freeze([
      Object.freeze({ startTimestamp: '2026-09-01T00:00:02Z', endTimestamp: '2026-09-01T00:00:03Z' }),
      Object.freeze({ startTimestamp: '2026-09-01T00:00:01Z' }),
      Object.freeze({ endTimestamp: '2026-09-01T00:00:04Z' }),
    ]);
    expect(buildOverallSessionTimeRange(ranges)).toEqual({
      from: '2026-09-01T00:00:01Z', to: '2026-09-01T00:00:04Z', durationMs: 3000,
    });
    expect(ranges[0]).toEqual({
      startTimestamp: '2026-09-01T00:00:02Z', endTimestamp: '2026-09-01T00:00:03Z',
    });
  });

  it.each([
    { from: '2026-09-01T00:00:00Z', to: '2026-09-01T00:00:00Z', durationMs: 0 },
    { from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z', durationMs: undefined },
    { from: 'invalid', to: 'invalid', durationMs: undefined },
  ])('preserves duration semantics for $from to $to', ({ from, to, durationMs }) => {
    expect(buildOverallSessionTimeRange([{ startTimestamp: from, endTimestamp: to }]))
      .toEqual({ from, to, durationMs });
  });
});
