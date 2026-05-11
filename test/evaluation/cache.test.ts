import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheKey, createCache } from '../../src/eval-core/cache.js';
import type { ExecResult } from '../../src/types/executor.js';

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

  it('cache key 带 v5: 前缀(invalidates older cache entries — effort 加进 key)', () => {
    const key = cacheKey('sonnet', '', 'p', '/tmp/p');
    assert.match(key, /^v5:/);
  });

  // effort 必须进 cache key:同 model/prompt 不同 effort('low' vs 'high')改变 LLM 思考预算,
  // 输出 / 工具调用 / 分数都可能不同;跨 effort 共享 cache 会让报告 meta 标的 effort 跟实际
  // 跑的 effort 不一致(测量可比性污染)。
  it('effort 进 cache key:low vs high 不同键', () => {
    const low = cacheKey('sonnet', '', 'p', '/tmp/p', undefined, 'claude', 'rt1', undefined, undefined, 'low');
    const high = cacheKey('sonnet', '', 'p', '/tmp/p', undefined, 'claude', 'rt1', undefined, undefined, 'high');
    assert.notEqual(low, high);
  });

  it('effort 进 cache key:undefined 跟空串等价(默认 fallback)', () => {
    const noEffort = cacheKey('sonnet', '', 'p', '/tmp/p', undefined, 'claude', 'rt1');
    const emptyEffort = cacheKey('sonnet', '', 'p', '/tmp/p', undefined, 'claude', 'rt1', undefined, undefined, '');
    assert.equal(noEffort, emptyEffort);
  });

  // executor 进 cache key:同 model 名(如 'gpt-4o')走 openai-api vs codex 输出不同,
  // 不区分会污染。新版 key 含 executor 名,跨 executor 必拿不同 key。
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

  it('runtime fingerprint 进 cache key:同 executor 换 runtime 不同键', () => {
    const a = cacheKey('sonnet', '', 'p', '/tmp/p', undefined, 'claude', 'runtime111111');
    const b = cacheKey('sonnet', '', 'p', '/tmp/p', undefined, 'claude', 'runtime222222');
    assert.notEqual(a, b);
  });
});

describe('createCache:cache.set 保留 turns / toolCalls', () => {
  // 工具类断言(tool_called / tool_input_contains / tools_called)和 diagnostic 都要 trace。
  // 之前 cache.set 砍掉 turns + toolCalls,cached rerun 进 grade() 时工具断言为空、
  // diagnostic 没真实证据,跟 cold run 不一致。这里 lock 保留行为(参考 PR #95 review P1-2)。
  it('set 后 get 回来的 ExecResult 含 toolCalls 和 turns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-cache-test-'));
    try {
      const cache = createCache(dir);
      const value: ExecResult = {
        ok: true,
        output: 'hello',
        durationMs: 1000,
        durationApiMs: 800,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0.001,
        stopReason: 'end_turn',
        numTurns: 2,
        toolCalls: [{ tool: 'Read', input: { file_path: '/tmp/x' }, output: 'ok', success: true }],
        turns: [{ role: 'assistant', content: 'ok' }],
      };
      cache.set('k', value);
      const got = cache.get('k');
      assert.ok(got);
      assert.equal(got!.toolCalls?.length, 1);
      assert.equal(got!.toolCalls?.[0].tool, 'Read');
      assert.equal(got!.turns?.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
