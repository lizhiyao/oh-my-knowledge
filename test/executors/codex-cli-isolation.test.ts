import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { codexCliExecutor } from '../../src/executors/codex-cli.js';

// codex-cli 隔离合约:
//   undefined          → 不传 -C(默认行为,看 cwd 里有什么 codex 自己决定)
//                        — 不在 CI 真测,需要 codex binary
//   []                 → 必须 cwd 非空,否则 throw(channel 3 cwd 隔离是 codex
//                        唯一 channel)
//   [...] (length>0)   → throw,codex CLI 无 partial 白名单 flag
//
// CI 上 codex binary 不存在,但 throw 路径不需要 spawn 子进程,可独立测。

describe('codexCliExecutor skill isolation contract', () => {
  it('partial whitelist: throws (codex CLI 无 partial 白名单 flag)', async () => {
    await assert.rejects(
      () => codexCliExecutor({
        model: 'gpt-5-codex',
        system: '',
        prompt: 'hello',
        cwd: '/tmp/some-dir',
        allowedSkills: ['foo', 'bar'],
      }),
      /partial skill 白名单|codex-cli executor/,
    );
  });

  it('partial whitelist with single skill: throws', async () => {
    await assert.rejects(
      () => codexCliExecutor({
        model: 'gpt-5-codex',
        system: '',
        prompt: 'hello',
        cwd: '/tmp/some-dir',
        allowedSkills: ['only-this'],
      }),
      /partial skill 白名单|codex-cli executor/,
    );
  });

  it('strict isolation [] without cwd: throws (cwd required)', async () => {
    await assert.rejects(
      () => codexCliExecutor({
        model: 'gpt-5-codex',
        system: '',
        prompt: 'hello',
        cwd: undefined,
        allowedSkills: [],
      }),
      /channel 3 cwd 隔离|cwd 非空/,
    );
  });

  it('strict isolation [] with empty-string cwd: throws (cwd required)', async () => {
    await assert.rejects(
      () => codexCliExecutor({
        model: 'gpt-5-codex',
        system: '',
        prompt: 'hello',
        cwd: '',
        allowedSkills: [],
      }),
      /channel 3 cwd 隔离|cwd 非空/,
    );
  });

  // undefined 路径会真调 codex binary,CI 没装,跳过;靠注释保契约。
  // [] + 非空 cwd 也会真调,同样不在 CI 测。
});
