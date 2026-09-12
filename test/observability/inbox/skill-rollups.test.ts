import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildObservationSkillRollups,
  skillReviewLabel,
  timestampedOccurrences,
} from '../../../src/observability/inbox/skill-rollups.js';
import { baseItem } from './_helpers.js';

function model(overrides: Partial<Parameters<typeof buildObservationSkillRollups>[0]>) {
  return {
    allItems: [],
    skillInvocationCounts: {},
    skillSessionCounts: {},
    skillInvocationLastSeen: {},
    skillToolCallCounts: {},
    ...overrides,
  };
}

describe('skill rollups (host-independent)', () => {
  it('aggregates counts, metrics and review tone per skill, sorted by risk', () => {
    const rollups = buildObservationSkillRollups(model({
      allItems: [
        baseItem({ id: 'a1', skillName: 'alpha', severity: 'high', occurrences: 2 }),
        baseItem({ id: 'a2', skillName: 'alpha', severity: 'medium', signalSubtype: 'bash_probe' }),
        baseItem({ id: 'b1', skillName: 'beta', severity: 'noise' }),
      ],
      skillInvocationCounts: { alpha: 7 },
      skillSessionCounts: { alpha: 3 },
      skillToolCallCounts: { alpha: { Bash: 4, Read: 2 } },
    }));
    assert.equal(rollups.length, 2);
    const [alpha, beta] = rollups;
    assert.equal(alpha.skillName, 'alpha');
    assert.deepEqual(alpha.counts, { high: 1, medium: 1, low: 0, noise: 0 });
    assert.equal(alpha.invocationCount, 7);
    assert.equal(alpha.sessionCount, 3);
    assert.equal(alpha.metricCounts.bash, 4);
    assert.equal(alpha.metricCounts.read, 2);
    assert.equal(alpha.metricCounts.bashProbe, 1);
    assert.equal(alpha.reviewTone, 'error');
    assert.equal(alpha.reviewLabel, '高风险');
    assert.equal(beta.skillName, 'beta');
    assert.equal(beta.reviewTone, 'neutral');
  });

  it('falls back to observation-derived invocation and session counts', () => {
    const [rollup] = buildObservationSkillRollups(model({
      allItems: [
        baseItem({ id: 'a1', skillName: 'alpha', occurrences: 3, recentSessionIds: ['s1', 's2'] }),
        baseItem({ id: 'a2', skillName: 'alpha', occurrences: 2, recentSessionIds: ['s2', 's3'] }),
      ],
    }));
    assert.equal(rollup.invocationCount, 5);
    assert.equal(rollup.sessionCount, 3);
  });

  it('treats prototype-member skill names as data, never as inherited lookups', () => {
    const [proto] = buildObservationSkillRollups(model({
      allItems: [baseItem({ id: 'p1', skillName: '__proto__', severity: 'high' })],
      skillInvocationCounts: Object.fromEntries([['__proto__', 4]]),
      skillSessionCounts: Object.fromEntries([['__proto__', 2]]),
    }));
    assert.equal(proto.skillName, '__proto__');
    assert.equal(proto.invocationCount, 4);
    assert.equal(proto.sessionCount, 2);
    assert.equal(proto.observationCount, 1);

    // 普通下标读取会拿到 Object 构造函数，再被当成计数；这里必须回落到观测派生值。
    const [ctor] = buildObservationSkillRollups(model({
      allItems: [baseItem({ id: 'c1', skillName: 'constructor', occurrences: 2, recentSessionIds: ['s1'] })],
    }));
    assert.equal(ctor.skillName, 'constructor');
    assert.equal(ctor.invocationCount, 2);
    assert.equal(ctor.sessionCount, 1);
  });

  it('labels tones bilingually', () => {
    assert.equal(skillReviewLabel('warning', 'zh'), '低风险');
    assert.equal(skillReviewLabel('warning', 'en'), 'Low risk');
    assert.equal(skillReviewLabel('success', 'en'), 'No issues');
    assert.equal(skillReviewLabel('error', 'en'), 'High risk');
  });

  it('counts only timestamped occurrences, treating the epoch sentinel as untimed', () => {
    const timed = { ...baseItem({}), timestampedOccurrences: 4 };
    assert.equal(timestampedOccurrences(timed), 4);
    const epoch = baseItem({ firstSeen: '1970-01-01T00:00:00.000Z', occurrences: 6 });
    assert.equal(timestampedOccurrences(epoch), 0);
    const plain = baseItem({ firstSeen: '2026-05-01T00:00:00.000Z', occurrences: 6 });
    assert.equal(timestampedOccurrences(plain), 6);
  });
});
