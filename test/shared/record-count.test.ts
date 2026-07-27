import { describe, expect, it } from 'vitest';
import {
  incrementRecordCount,
  ownRecordValue,
  setOwnRecordValue,
  sumRecordCounts,
} from '../../src/shared/record-count.js';

describe('incrementRecordCount', () => {
  it('counts prototype-shaped keys as own numeric properties', () => {
    const counts: Record<string, number> = {};

    incrementRecordCount(counts, '__proto__');
    incrementRecordCount(counts, '__proto__');
    incrementRecordCount(counts, 'constructor');

    expect(Object.hasOwn(counts, '__proto__')).toBe(true);
    expect(Object.hasOwn(counts, 'constructor')).toBe(true);
    expect(counts.__proto__).toBe(2);
    expect(counts.constructor).toBe(1);
    expect(JSON.parse(JSON.stringify(counts))).toEqual(
      JSON.parse('{"__proto__":2,"constructor":1}'),
    );
  });

  it('rejects increments that cannot represent event counts', () => {
    const counts: Record<string, number> = {};
    expect(() => incrementRecordCount(counts, 'tool', -1)).toThrow(TypeError);
    expect(() => incrementRecordCount(counts, 'tool', 0.5)).toThrow(TypeError);
    expect(() => incrementRecordCount(counts, 'tool', Number.NaN)).toThrow(TypeError);
    expect(() => incrementRecordCount(counts, 'tool', Number.MAX_VALUE)).toThrow(TypeError);
    setOwnRecordValue(counts, 'overflow', Number.MAX_SAFE_INTEGER);
    expect(() => incrementRecordCount(counts, 'overflow')).toThrow(RangeError);
  });

  it('reads and writes arbitrary dictionary keys as own properties', () => {
    const values: Record<string, string> = {};
    expect(ownRecordValue(values, 'constructor')).toBeUndefined();
    setOwnRecordValue(values, '__proto__', 'prototype-value');
    setOwnRecordValue(values, 'constructor', 'constructor-value');
    expect(ownRecordValue(values, '__proto__')).toBe('prototype-value');
    expect(ownRecordValue(values, 'constructor')).toBe('constructor-value');
  });

  it('adds persisted counts without crossing the safe-integer boundary', () => {
    expect(sumRecordCounts(2, 3, 4)).toBe(9);
    expect(() => sumRecordCounts(1, 0.5)).toThrow(TypeError);
    expect(() => sumRecordCounts(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
  });
});
