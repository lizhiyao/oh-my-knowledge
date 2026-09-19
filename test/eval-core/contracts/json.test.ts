import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../../src/eval-core/primitives/ordering.js';
import { decodePointerToken, encodePointerToken, resolveJsonPointer } from '../../../src/eval-core/primitives/json-pointer.js';
import { TRUST_LEVEL, isProvenanceTrust } from '../../../src/eval-core/primitives/provenance.js';
import {
  InvalidCanonicalJsonError,
  canonicalizeJson,
  canonicalizeJsonBytes,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
} from '../../../src/eval-core/contracts/json.js';

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
    expect(Object.keys(value).sort(compareStrings)).toEqual(expectedOrder);
    expect(compareStrings('same', 'same')).toBe(0);
    const parsed = JSON.parse(canonical);
    expect(parsed.nested).toEqual([{ a: 2, z: 1 }]);
  });

  it('keeps trust ordering shared without accepting inherited object keys as evidence', () => {
    expect(['verified', 'unknown', 'declared', 'untrusted'].sort((left, right) => {
      if (!isProvenanceTrust(left) || !isProvenanceTrust(right)) throw new Error('Invalid fixture');
      return TRUST_LEVEL[left] - TRUST_LEVEL[right];
    })).toEqual(['untrusted', 'unknown', 'declared', 'verified']);
    expect(Object.isFrozen(TRUST_LEVEL)).toBe(true);
    for (const invalid of ['toString', '__proto__', 'constructor', '', null, 0]) {
      expect(isProvenanceTrust(invalid)).toBe(false);
    }
  });

  it('decodes pointer tokens once in RFC order and retains literal empty/property tokens', () => {
    const tokens = ['', '~01', '~1', '/', '~', 'a/b', '__proto__'];
    expect(tokens.map(encodePointerToken).map(decodePointerToken)).toEqual(tokens);
    expect(['', '~01', '~1', '~0', 'a~1b', '__proto__'].map(decodePointerToken))
      .toEqual(['', '~1', '/', '~', 'a/b', '__proto__']);
  });

  it('shares pointer traversal without confusing missing paths with null or own properties', () => {
    const value = { '': 7, 'a/b': { '~1': [null, 0] }, defined: undefined };
    expect(resolveJsonPointer(value, '')).toEqual({ resolved: true, value });
    expect(resolveJsonPointer(value, '/')).toEqual({ resolved: true, value: 7 });
    expect(resolveJsonPointer(value, '/a~1b/~01/0')).toEqual({ resolved: true, value: null });
    expect(resolveJsonPointer(value, '/defined')).toEqual({ resolved: true, value: undefined });
    for (const pointer of ['/missing', '/constructor', '/__proto__', '/a~1b/~01/01',
      '/a~1b/~01/-', '/a~1b/~01/2', '/a~1b/~01/length', '/a~1b/~01/0/x']) {
      expect(resolveJsonPointer(value, pointer), pointer).toEqual({ resolved: false });
    }
    const own = JSON.parse('{"__proto__": 1}') as unknown;
    expect(resolveJsonPointer(own, '/__proto__')).toEqual({ resolved: true, value: 1 });
  });

  it('produces stable full sha256 digests independent of property order', () => {
    const first = digestCanonicalJson({ b: 2, a: { y: 2, x: 1 } });
    const second = digestCanonicalJson({ a: { x: 1, y: 2 }, b: 2 });

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('preserves the frozen UTF-8 byte and digest contract without Node Buffer', () => {
    const value = { text: '知识😀' };

    expect([...canonicalizeJsonBytes(value)]).toEqual([
      123, 34, 116, 101, 120, 116, 34, 58, 34,
      231, 159, 165, 232, 175, 134, 240, 159, 152, 128,
      34, 125,
    ]);
    expect(digestCanonicalJson(value)).toBe(
      'sha256:c944686c8bd06911f743ac2510ee0a691a0751eb7dc9e8bba4ee43d84c3b6a31',
    );
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

  it('deeply freezes canonical JSON through the shared Core implementation', () => {
    const value = { nested: [{ score: 5 }] };

    expect(deepFreezeCanonicalJson(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(value.nested[0])).toBe(true);
  });
});
