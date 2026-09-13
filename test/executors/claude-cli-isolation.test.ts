import { describe, it, expect, vi } from 'vitest';
import assert from 'node:assert/strict';
import { claudeCliExecutor } from '../../src/executors/anthropic/claude/cli.js';

import { spawnWithSigintPropagation } from '../../src/executors/core/subprocess.js';
vi.mock('../../src/executors/core/subprocess.js', () => ({
  spawnWithSigintPropagation: vi.fn(() => ({ child: { stdin: { end() {} } }, done: Promise.resolve({ stdout: '', stderr: '' }) })),
}));

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

  it('textOnly disables tools and discovery without changing ordinary executor calls', async () => {
    await claudeCliExecutor({ model: 'test', prompt: 'fixture', lean: true, textOnly: true });
    const args = vi.mocked(spawnWithSigintPropagation).mock.calls.at(-1)![1];
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--disallowedTools') + 2)).toEqual(['--disallowedTools', '*']);
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('{"mcpServers":{}}');
    await claudeCliExecutor({ model: 'test', prompt: 'fixture' });
    expect(vi.mocked(spawnWithSigintPropagation).mock.calls.at(-1)![1]).not.toContain('--tools');
  });
});
