import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildSdkIsolationOptions } from '../../src/executors/claude-sdk.js';

describe('buildSdkIsolationOptions (v0.22)', () => {
  it('allowedSkills=undefined → {} (SDK 默认全发现)', () => {
    assert.deepEqual(buildSdkIsolationOptions(undefined), {});
  });

  it('allowedSkills=[] → { skills:[], disallowedTools:[Skill] } (双堵 main + subagent)', () => {
    const opts = buildSdkIsolationOptions([]);
    assert.deepEqual(opts.skills, []);
    assert.deepEqual(opts.disallowedTools, ['Skill']);
  });

  it('allowedSkills=[react] → { skills:[react] } (白名单,不注入 disallowedTools)', () => {
    const opts = buildSdkIsolationOptions(['react']);
    assert.deepEqual(opts.skills, ['react']);
    assert.equal(opts.disallowedTools, undefined,
      '白名单模式不堵 Skill 工具,subagent 走独立 channel');
  });

  it('allowedSkills=[a, b] → { skills:[a, b] }', () => {
    const opts = buildSdkIsolationOptions(['a', 'b']);
    assert.deepEqual(opts.skills, ['a', 'b']);
    assert.equal(opts.disallowedTools, undefined);
  });
});
