import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildCodexArgs } from '../../src/executors/codex-cli.js';

// Args shape 回归测:codex CLI 0.125 起去掉 `--ask-for-approval` flag。
// 我们曾经用过这个 flag,会让 preflight 直接挂(unexpected argument)。
// 改用 -c approval_policy="never" config override 后,锁住别再退回去。

describe('buildCodexArgs flag schema', () => {
  it('does not include the removed --ask-for-approval flag', () => {
    const args = buildCodexArgs({ model: 'gpt-5-codex', cwd: null, prompt: 'hi' });
    assert.equal(args.includes('--ask-for-approval'), false);
  });

  it('passes approval_policy="never" via -c config override', () => {
    const args = buildCodexArgs({ model: 'gpt-5-codex', cwd: null, prompt: 'hi' });
    const cIndex = args.indexOf('-c');
    assert.notEqual(cIndex, -1, '-c flag missing');
    assert.equal(args[cIndex + 1], 'approval_policy="never"');
  });

  it('keeps essential isolation flags', () => {
    const args = buildCodexArgs({ model: 'gpt-5-codex', cwd: null, prompt: 'hi' });
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('--ignore-user-config'));
    assert.ok(args.includes('--skip-git-repo-check'));
    const sIdx = args.indexOf('--sandbox');
    assert.notEqual(sIdx, -1);
    assert.equal(args[sIdx + 1], 'read-only');
  });

  it('appends -C cwd when provided', () => {
    const args = buildCodexArgs({ model: 'gpt-5-codex', cwd: '/tmp/iso', prompt: 'hi' });
    const cwdIdx = args.indexOf('-C');
    assert.notEqual(cwdIdx, -1);
    assert.equal(args[cwdIdx + 1], '/tmp/iso');
  });

  it('omits -C when cwd null/undefined', () => {
    assert.equal(buildCodexArgs({ model: 'm', cwd: null, prompt: 'hi' }).includes('-C'), false);
    assert.equal(buildCodexArgs({ model: 'm', cwd: undefined, prompt: 'hi' }).includes('-C'), false);
  });

  it('puts prompt as last positional arg', () => {
    const args = buildCodexArgs({ model: 'gpt-5-codex', cwd: '/tmp', prompt: 'the-prompt' });
    assert.equal(args[args.length - 1], 'the-prompt');
  });
});
