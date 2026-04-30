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

  // Skill isolation 必须进 cache key,否则 strict / non-strict 切换会误命中。
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

  it('cache key 带 v3: 前缀(invalidates old v2 cache entries)', () => {
    const key = cacheKey('sonnet', '', 'p', '/tmp/p');
    assert.match(key, /^v3:/);
  });

  // executor 进 cache key:同 model 名(如 'gpt-4o')走 openai-api vs codex 输出不同,
  // 不区分会污染。新版 v3 含 executor 名,跨 executor 必拿不同 key。
  it('executor 进 cache key:不同 executor 同 model 不同键', () => {
    const codex = cacheKey('gpt-4o', '', 'p', '/tmp/p', undefined, 'codex');
    const openaiApi = cacheKey('gpt-4o', '', 'p', '/tmp/p', undefined, 'openai-api');
    assert.notEqual(codex, openaiApi);
  });

  it('executor 进 cache key:undefined 跟空串等价(都 fallback)', () => {
    const noExec = cacheKey('sonnet', '', 'p', '/tmp/p');
    const emptyExec = cacheKey('sonnet', '', 'p', '/tmp/p', undefined, '');
    assert.equal(noExec, emptyExec);
  });

  it('executor 进 cache key:同 executor 同 model 同 key', () => {
    const a = cacheKey('sonnet', '', 'p', '/tmp/p', undefined, 'claude');
    const b = cacheKey('sonnet', '', 'p', '/tmp/p', undefined, 'claude');
    assert.equal(a, b);
  });
});
