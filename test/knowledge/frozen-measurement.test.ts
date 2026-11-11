import { describe, expect, it } from 'vitest';
import { KnowledgeDraftSchema } from '../../src/knowledge/contracts.js';
import { KnowledgeDraftSchema as FrozenTypedDraftSchema } from '../../src/knowledge/measurement/typed-contracts.js';
import { draft } from './fixtures.js';

describe('frozen typed knowledge measurement contracts', () => {
  it('keeps the historical typed draft contract readable without treating it as the current body draft', () => {
    const legacy = draft();
    expect(FrozenTypedDraftSchema.parse(legacy)).toEqual(legacy);
    expect(KnowledgeDraftSchema.safeParse(legacy).success).toBe(false);
  });
});
