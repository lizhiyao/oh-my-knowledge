import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { claudeCliExecutor } from '../../src/executors/anthropic/claude/cli.js';

// claude CLI executor isolation 行为契约。
//
// claude CLI 用 `--disable-slash-commands` (文档:"Disable all skills") +
// `--disallowedTools Skill` 双堵,跟 SDK 等价。非空白名单已移除(无法真正隔离,三个
// 执行器一致 throw)。
//   undefined → 不传任何 isolation flag(原行为,全发现)
//   []        → --disable-slash-commands + --disallowedTools Skill(完全隔离)
//   [...]     → throw,非空白名单不再支持

describe('claude-cli executor — skill isolation degraded mode', () => {
  it('allowedSkills=[\'foo\', \'bar\'] (白名单)→ throw,不静默降级', async () => {
    await assert.rejects(
      claudeCliExecutor({
        model: 'haiku',
        prompt: 'p',
        allowedSkills: ['foo', 'bar'],
        timeoutMs: 1000,
      }),
      /skill 白名单.*不再支持|无法真正隔离/,
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
      /skill 白名单.*不再支持|无法真正隔离/,
    );
  });

  // allowedSkills=[] 和 undefined 路径会真正 spawn claude CLI(不在 CI 装),无法
  // 直接测;契约由 cliPartialAllowlistWarned 的 "首次 warn 不阻塞 spawn" 文档替代。
});
