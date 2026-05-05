import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  registerHealthDimension,
  getRegisteredHealthDimensions,
  __resetHealthDimensionsForTest,
} from '../../../src/doctor/health/dimension-registry.js';
import type { HealthDimensionSpec } from '../../../src/doctor/health/dimension-spec.js';

const stubSpec = (id: string, overrides: Partial<HealthDimensionSpec> = {}): HealthDimensionSpec => ({
  id,
  displayName: id,
  labelKey: `cli.doctor.health.dim.${id}`,
  severity: 'warn',
  promptSection: `check ${id}`,
  ...overrides,
});

describe('dimension-registry', () => {
  beforeEach(() => __resetHealthDimensionsForTest());

  it('preserves registration order', () => {
    registerHealthDimension(stubSpec('a'));
    registerHealthDimension(stubSpec('b'));
    registerHealthDimension(stubSpec('c'));
    assert.deepEqual(getRegisteredHealthDimensions().map((d) => d.id), ['a', 'b', 'c']);
  });

  it('throws on duplicate id', () => {
    registerHealthDimension(stubSpec('a'));
    assert.throws(() => registerHealthDimension(stubSpec('a')), /collision/);
  });

  it('throws on empty id or id containing colon', () => {
    assert.throws(() => registerHealthDimension(stubSpec('')), /invalid/);
    assert.throws(() => registerHealthDimension(stubSpec('a:b')), /invalid/);
  });

  it('returns a defensive copy (mutation does not affect registry)', () => {
    registerHealthDimension(stubSpec('a'));
    const list = getRegisteredHealthDimensions();
    list.push(stubSpec('rogue'));
    assert.deepEqual(getRegisteredHealthDimensions().map((d) => d.id), ['a']);
  });
});
