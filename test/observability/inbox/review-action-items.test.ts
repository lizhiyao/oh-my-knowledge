import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildReviewActionItems } from '../../../src/observability/inbox/skill-rollups.js';
import { baseItem } from './_helpers.js';

function model(items: ReturnType<typeof baseItem>[]) {
  return {
    allItems: items,
    skillInvocationCounts: {},
    skillSessionCounts: {},
    skillInvocationLastSeen: {},
    skillToolCallCounts: {},
  };
}

describe('review action items (host-independent)', () => {
  it('prioritizes high severity as P0 and sorts by priority then evidence count', () => {
    const items = buildReviewActionItems(model([
      baseItem({ id: 'a', skillName: 'risky', severity: 'high', occurrences: 2 }),
      baseItem({ id: 'b', skillName: 'noisy', severity: 'noise', occurrences: 9 }),
    ]));
    assert.equal(items[0].skillName, 'risky');
    assert.equal(items[0].priority, 'P0');
    assert.equal(items[0].tone, 'error');
    assert.equal(items[1].priority, 'P3');
  });

  it('raises repeated medium signals to P1 with the occurrence count interpolated', () => {
    const items = buildReviewActionItems(model([
      baseItem({ id: 'm1', skillName: 'rep', severity: 'medium', occurrences: 2 }),
      baseItem({ id: 'm2', skillName: 'rep', severity: 'medium', occurrences: 2 }),
    ]));
    assert.equal(items[0].priority, 'P1');
    assert.match(items[0].reason, /4/);
  });

  it('renders bilingual action text', () => {
    const items = buildReviewActionItems(model([baseItem({ severity: 'high' })]), 'en');
    assert.equal(items[0].action, 'Check whether this skill is missing key information');
  });
});
