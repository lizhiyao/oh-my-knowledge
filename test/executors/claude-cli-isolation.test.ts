import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { claudeCliExecutor } from '../../src/executors/claude-cli.js';

// v0.22 — claude CLI executor isolation 行为契约。
//
// claude CLI 用 `--disable-slash-commands` (文档:"Disable all skills") +
// `--disallowedTools Skill` 双堵,跟 SDK 等价,只缺 partial whitelist。
//   undefined → 不传任何 isolation flag(原行为,全发现)
//   []        → --disable-slash-commands + --disallowedTools Skill(完全隔离)
//   [...]     → throw,提示用户改 --executor claude-sdk(精确白名单)

describe('claude-cli executor — skill isolation degraded mode (v0.22)', () => {
  it('allowedSkills=[\'foo\', \'bar\'] (白名单)→ throw,不静默降级', async () => {
    await assert.rejects(
      claudeCliExecutor({
        model: 'haiku',
        prompt: 'p',
        allowedSkills: ['foo', 'bar'],
        timeoutMs: 1000,
      }),
      /partial skill 白名单|claude-cli executor/,
    );
  });

  it('allowedSkills=[\'single-skill\'] → throw(不允许任何非空白名单)', async () => {
    await assert.rejects(
      claudeCliExecutor({
        model: 'haiku',
        prompt: 'p',
        allowedSkills: ['single-skill'],
        timeoutMs: 1000,
      }),
      /partial skill 白名单|claude-cli executor/,
    );
  });

  // allowedSkills=[] 和 undefined 路径会真正 spawn claude CLI(不在 CI 装),无法
  // 直接测;契约由 cliPartialAllowlistWarned 的 "首次 warn 不阻塞 spawn" 文档替代。
});
