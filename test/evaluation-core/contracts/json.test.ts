import { describe, expect, it } from 'vitest';
import {
  InvalidCanonicalJsonError,
  canonicalizeJson,
  digestCanonicalJson,
  isCanonicalJson,
} from '../../../src/evaluation-core/contracts/json.js';

describe('Evaluation Core RFC 8785 JSON', () => {
  it('matches the RFC 8785 primitive serialization example', () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };

    expect(canonicalizeJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts object names by raw UTF-16 code units and preserves array order', () => {
    const value = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      1: 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
      nested: [{ z: 1, a: 2 }],
    };

    const canonical = canonicalizeJson(value);
    const expectedOrder = [
      '\r',
      '1',
      'nested',
      '\u0080',
      'ö',
      '€',
      '😀',
      'דּ',
    ];
    const offsets = expectedOrder.map((key) => canonical.indexOf(`${JSON.stringify(key)}:`));
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    const parsed = JSON.parse(canonical);
    expect(parsed.nested).toEqual([{ a: 2, z: 1 }]);
  });

  it('produces stable full sha256 digests independent of property order', () => {
    const first = digestCanonicalJson({ b: 2, a: { y: 2, x: 1 } });
    const second = digestCanonicalJson({ a: { x: 1, y: 2 }, b: 2 });

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    undefined,
    1n,
    Symbol('x'),
    () => undefined,
    new Date(),
  ])('rejects non-I-JSON value %s', (value) => {
    expect(() => canonicalizeJson(value)).toThrow(InvalidCanonicalJsonError);
    expect(isCanonicalJson(value)).toBe(false);
  });

  it('rejects cycles, sparse arrays, extra properties, accessors, and symbols', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = Array(2);
    const withExtra = [1] as number[] & { extra?: number };
    withExtra.extra = 2;
    const accessor = {};
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
    const symbolProperty = { value: 1, [Symbol('secret')]: 2 };

    for (const value of [cyclic, sparse, withExtra, accessor, symbolProperty]) {
      expect(() => canonicalizeJson(value)).toThrow(InvalidCanonicalJsonError);
    }
  });

  it('rejects unpaired Unicode surrogates in values and property names', () => {
    expect(() => canonicalizeJson('\ud800')).toThrow(/unpaired high surrogate/);
    expect(() => canonicalizeJson('\udc00')).toThrow(/unpaired low surrogate/);
    expect(() => canonicalizeJson({ ['\ud800']: true })).toThrow(/unpaired high surrogate/);
  });

  it('uses the ECMAScript representation for negative zero', () => {
    expect(canonicalizeJson(-0)).toBe('0');
  });
});
