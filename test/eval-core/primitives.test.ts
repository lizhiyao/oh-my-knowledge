import { describe, expect, it } from 'vitest';
import { TRUST_LEVEL, isProvenanceTrust, minimumTrust } from '../../src/eval-core/primitives/provenance.js';
import { decodePointerToken, encodePointerToken, resolveJsonPointer } from '../../src/eval-core/primitives/json-pointer.js';
import { topologicalOrder } from '../../src/eval-core/primitives/graph.js';

describe('Core shared invariants', () => {
  it('keeps trust ordering shared without accepting inherited object keys as evidence', () => {
    expect(['verified', 'unknown', 'declared', 'untrusted'].sort((left, right) => {
      if (!isProvenanceTrust(left) || !isProvenanceTrust(right)) throw new Error('Invalid fixture');
      return TRUST_LEVEL[left] - TRUST_LEVEL[right];
    })).toEqual(['untrusted', 'unknown', 'declared', 'verified']);
    expect(Object.isFrozen(TRUST_LEVEL)).toBe(true);
    expect(minimumTrust([], 'unknown')).toBe('unknown');
    expect(minimumTrust([], 'verified')).toBe('verified');
    expect(minimumTrust(['verified'], 'unknown')).toBe('verified');
    expect(minimumTrust(['verified', 'untrusted', 'declared'], 'verified')).toBe('untrusted');
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

  it('preserves stage-specific ready-node and frontier scheduling without mutating dependencies', () => {
    const dependencies = new Map<string, ReadonlySet<string>>([
      ['c', new Set<string>()], ['a', new Set(['b'])], ['b', new Set<string>()],
    ]);
    expect(topologicalOrder(dependencies, 'ready-node', 'cycle')).toEqual(['b', 'a', 'c']);
    expect(topologicalOrder(dependencies, 'ready-frontier', 'cycle')).toEqual(['b', 'c', 'a']);
    expect([...dependencies.keys()]).toEqual(['c', 'a', 'b']);
    expect([...dependencies.get('a')!]).toEqual(['b']);
    for (const scheduling of ['ready-node', 'ready-frontier'] as const) {
      expect(topologicalOrder(new Map(), scheduling, 'cycle')).toEqual([]);
      expect(() => topologicalOrder(new Map([
        ['a', new Set(['b'])], ['b', new Set(['a'])],
      ]), scheduling, 'sealed graph cycle')).toThrow('sealed graph cycle');
    }
  });
});
