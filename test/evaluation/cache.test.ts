import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { cacheKey } from '../../src/eval-core/cache.js';

describe('cacheKey', () => {
  it('不同 cwd 生成不同缓存键', () => {
    const key1 = cacheKey('sonnet', '', 'same prompt', '/tmp/project-a');
    const key2 = cacheKey('sonnet', '', 'same prompt', '/tmp/project-b');
    assert.notEqual(key1, key2);
  });

  it('相同 cwd 生成相同缓存键', () => {
    const key1 = cacheKey('sonnet', '', 'same prompt', '/tmp/project-a');
    const key2 = cacheKey('sonnet', '', 'same prompt', '/tmp/project-a');
    assert.equal(key1, key2);
  });

  // v0.22 — Skill isolation 必须进 cache key,否则 strict / non-strict 切换会误命中。
  it('allowedSkills 进 cache key:undefined vs [] 不同键', () => {
    const noIso = cacheKey('sonnet', '', 'same prompt', '/tmp/p', undefined);
    const strict = cacheKey('sonnet', '', 'same prompt', '/tmp/p', []);
    assert.notEqual(noIso, strict);
  });

  it('allowedSkills 进 cache key:[] vs [foo] 不同键', () => {
    const strict = cacheKey('sonnet', '', 'p', '/tmp/p', []);
    const whitelist = cacheKey('sonnet', '', 'p', '/tmp/p', ['foo']);
    assert.notEqual(strict, whitelist);
  });

  it('allowedSkills 顺序不影响 cache key(语义等价)', () => {
    const a = cacheKey('sonnet', '', 'p', '/tmp/p', ['a', 'b']);
    const b = cacheKey('sonnet', '', 'p', '/tmp/p', ['b', 'a']);
    assert.equal(a, b);
  });

  it('cache key 带 v2: 前缀(v0.22 invalidates pre-isolation cache)', () => {
    const key = cacheKey('sonnet', '', 'p', '/tmp/p');
    assert.match(key, /^v2:/);
  });
});
