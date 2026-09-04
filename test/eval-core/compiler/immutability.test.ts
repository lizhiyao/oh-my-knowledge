import { describe, expect, it } from 'vitest';
import { deepFreeze } from '../../../src/eval-core/compiler/immutability.js';

describe('Evaluation Core immutable snapshots', () => {
  it('freezes plain cyclic graphs without traversing opaque host objects', () => {
    const hostObject = new AbortController();
    const value: {
      nested: { enabled: boolean };
      self?: unknown;
      hostObject: AbortController;
    } = { nested: { enabled: true }, hostObject };
    value.self = value;

    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(hostObject)).toBe(false);
  });
});
