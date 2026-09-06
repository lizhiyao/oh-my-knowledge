import { describe, expect, it } from 'vitest';
import { readonlyMapSnapshot } from '../../../../../src/eval-workflows/hosts/adapters/shared/readonly-map-snapshot.js';

describe('readonlyMapSnapshot', () => {
  it('captures independent membership at each boundary without cloning values', () => {
    const value = { resourceId: 'first' };
    const source = new Map([['a', value]]);
    const first = readonlyMapSnapshot(source);
    source.set('b', { resourceId: 'second' });
    const second = readonlyMapSnapshot(source);
    source.clear();

    expect([...first]).toEqual([['a', value]]);
    expect([...second.keys()]).toEqual(['a', 'b']);
    expect(first.get('a')).toBe(value);
    expect(second.get('a')).toBe(value);
    expect(first).not.toBe(second);
    expect(first.size).toBe(1);
    expect(second.size).toBe(2);
    expect(first.has('b')).toBe(false);
    expect(first.get('missing')).toBeUndefined();
  });

  it('exposes only frozen read operations and preserves ordered traversal', () => {
    const view = readonlyMapSnapshot(new Map([['b', 2], ['a', 1]]));
    expect(Object.isFrozen(view)).toBe(true);
    for (const method of ['set', 'delete', 'clear']) expect(method in view).toBe(false);
    expect(Reflect.set(view, 'get', () => 99)).toBe(false);
    expect([...view.keys()]).toEqual(['b', 'a']);
    expect([...view.values()]).toEqual([2, 1]);
    expect([...view.entries()]).toEqual([...view]);

    const context = { calls: [] as [number, string][] };
    view.forEach(function (this: typeof context, value, key, map) {
      expect(this).toBe(context);
      expect(map).toBe(view);
      this.calls.push([value, key]);
    }, context);
    expect(context.calls).toEqual([[2, 'b'], [1, 'a']]);
  });

  it('supports empty maps and propagates callback failures', () => {
    const empty = readonlyMapSnapshot(new Map<string, number>());
    expect(empty.size).toBe(0);
    expect([...empty]).toEqual([]);
    let calls = 0;
    empty.forEach(() => { calls += 1; });
    expect(calls).toBe(0);
    const error = new Error('callback failed');
    const view = readonlyMapSnapshot(new Map([['a', 1]]));
    expect(() => view.forEach(() => { throw error; })).toThrow(error);
  });
});
