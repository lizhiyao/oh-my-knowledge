import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ENTITY_COLLECTIVE_REFERENCE_POLICY } from '../../src/knowledge/extraction/knowledge-semantic-policy.js';

const rangeIdentityClarification = '所指范围已有明确的来源依据时，计量单位、表示层次或展开方式未知，不自动使该范围成为身份未决；范围身份与这些未知分别记录。不能由此断言不同层次的成员相同；来源未证明同一范围时仍保留真实指代歧义，不另造上位对象吸收分歧。';

/** Retain the current version label but restore the exact immediately preceding policy bytes. */
export function withImmediatePriorCollectivePolicy(system: string): string {
  assert.equal(ENTITY_COLLECTIVE_REFERENCE_POLICY.split(rangeIdentityClarification).length, 2);
  assert.equal(system.split(ENTITY_COLLECTIVE_REFERENCE_POLICY).length, 2);
  const previousPolicy = ENTITY_COLLECTIVE_REFERENCE_POLICY.replace(rangeIdentityClarification, '');
  assert.equal(createHash('sha256').update(previousPolicy).digest('hex'), 'cb152bdd2f604589e5ea9877d4f26345dbc82be8a670bc91ab22ccaf0e2efce9');
  return system.replace(ENTITY_COLLECTIVE_REFERENCE_POLICY, previousPolicy);
}
