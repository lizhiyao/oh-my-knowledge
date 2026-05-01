import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildCodexSdkClientOptions, buildCodexSdkThreadOptions, codexSdkExecutor } from '../../src/executors/codex-sdk.js';

describe('codex-sdk executor parity contract', () => {
  it('uses the same eval-critical thread options as codex CLI executor', () => {
    const opts = buildCodexSdkThreadOptions({ model: 'gpt-5-codex', cwd: '/tmp/iso' });
    assert.equal(opts.model, 'gpt-5-codex');
    assert.equal(opts.workingDirectory, '/tmp/iso');
    assert.equal(opts.sandboxMode, 'read-only');
    assert.equal(opts.skipGitRepoCheck, true);
    assert.equal(opts.approvalPolicy, 'never');
  });

  it('omits workingDirectory when cwd is unset, matching codex CLI no -C behavior', () => {
    const opts = buildCodexSdkThreadOptions({ model: 'gpt-5-codex', cwd: null });
    assert.equal('workingDirectory' in opts, false);
  });

  it('uses the SDK bundled binary by leaving codexPathOverride unset', () => {
    const opts = buildCodexSdkClientOptions({ PATH: '/bin' });
    assert.equal('codexPathOverride' in opts, false);
    assert.deepEqual(opts.env, { PATH: '/bin' });
  });

  it('partial allowedSkills still throws because codex has no skill whitelist flag', async () => {
    await assert.rejects(
      () => codexSdkExecutor({
        model: 'gpt-5-codex',
        prompt: 'hello',
        cwd: '/tmp/iso',
        allowedSkills: ['one'],
      }),
      /partial skill 白名单|codex-sdk executor/,
    );
  });

  it('strict isolation [] without cwd still throws before invoking SDK', async () => {
    await assert.rejects(
      () => codexSdkExecutor({
        model: 'gpt-5-codex',
        prompt: 'hello',
        cwd: undefined,
        allowedSkills: [],
      }),
      /channel 3 cwd 隔离|cwd 非空/,
    );
  });
});
