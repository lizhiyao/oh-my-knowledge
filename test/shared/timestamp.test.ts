import { describe, expect, it } from 'vitest';
import {
  isRfc3339Timestamp,
  normalizeRfc3339Timestamp,
} from '../../src/shared/timestamp.js';

describe('RFC 3339 timestamps', () => {
  it('normalizes absolute timestamps with explicit offsets', () => {
    expect(normalizeRfc3339Timestamp('2026-07-25T08:30:45+08:00'))
      .toBe('2026-07-25T00:30:45.000Z');
    expect(normalizeRfc3339Timestamp(' 2026-07-25T00:30:45.123456Z '))
      .toBe('2026-07-25T00:30:45.123Z');
    expect(normalizeRfc3339Timestamp('1990-12-31T23:59:60.5Z'))
      .toBe('1991-01-01T00:00:00.500Z');
    expect(normalizeRfc3339Timestamp('1991-01-01T00:59:60+01:00'))
      .toBe('1991-01-01T00:00:00.000Z');
  });

  it('rejects environment-dependent shortcuts and invalid calendar dates', () => {
    for (const value of [
      '1',
      '2026-07-25',
      '2026-07-25T00:00:00',
      '2026-02-30T00:00:00Z',
      '2025-02-29T00:00:00Z',
      '2026-07-25T24:00:00Z',
      '2026-07-25T00:00:60Z',
      '2026-07-25T00:00:61Z',
      '2026-07-25T00:00:00+24:00',
      '2026-07-25T00:00:00-00:00',
    ]) {
      expect(normalizeRfc3339Timestamp(value), value).toBeUndefined();
      expect(isRfc3339Timestamp(value), value).toBe(false);
    }
    expect(isRfc3339Timestamp('2024-02-29T00:00:00Z')).toBe(true);
  });
});
