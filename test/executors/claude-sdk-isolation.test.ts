import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildSdkIsolationOptions } from '../../src/executors/claude-sdk.js';

describe('buildSdkIsolationOptions', () => {
  it('allowedSkills=undefined → {} (SDK 默认全发现)', () => {
    assert.deepEqual(buildSdkIsolationOptions(undefined), {});
  });

  it('allowedSkills=[] → { skills:[], disallowedTools:[Skill] } (双堵 main + subagent)', () => {
    const opts = buildSdkIsolationOptions([]);
    assert.deepEqual(opts.skills, []);
    assert.deepEqual(opts.disallowedTools, ['Skill']);
  });

  it('allowedSkills=[react] → throw(非空白名单不再支持:无法真正隔离)', () => {
    assert.throws(() => buildSdkIsolationOptions(['react']), /白名单.*不再支持|无法真正隔离/);
  });

  it('allowedSkills=[a, b] → throw', () => {
    assert.throws(() => buildSdkIsolationOptions(['a', 'b']), /白名单.*不再支持|无法真正隔离/);
  });
});
