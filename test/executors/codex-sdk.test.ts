import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetCodexSdkStateForTest,
  buildCodexSdkClientOptions,
  buildCodexSdkThreadOptions,
  codexSdkExecutor,
  getIsolatedCodexHome,
} from '../../src/executors/codex-sdk.js';

describe('codex-sdk executor parity contract', () => {
  it('maps the SDK-exposed eval-critical thread options to codex-cli equivalents', () => {
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

  it('non-empty allowedSkills still throws (skill whitelist removed)', async () => {
    await assert.rejects(
      () => codexSdkExecutor({
        model: 'gpt-5-codex',
        prompt: 'hello',
        cwd: '/tmp/iso',
        allowedSkills: ['one'],
      }),
      /skill 白名单.*不再支持|无法真正隔离/,
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

// codex-cli passes `--ephemeral` + `--ignore-user-config` to keep eval runs
// independent of the user's real $CODEX_HOME. The SDK ThreadOptions does not
// expose either flag, so the SDK executor redirects $CODEX_HOME to a per-process
// tmp dir (auth.json symlinked through). Without this, codex vs codex-sdk are
// not testing the same prompt+template under the same config — construct
// validity violation.
describe('codex-sdk CODEX_HOME isolation (--ephemeral + --ignore-user-config equivalent)', () => {
  let fakeRealHome: string;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    __resetCodexSdkStateForTest();
    fakeRealHome = join(tmpdir(), `omk-codex-sdk-test-real-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(fakeRealHome, { recursive: true });
    await writeFile(join(fakeRealHome, 'auth.json'), '{"fake":"auth"}', 'utf8');
    await writeFile(join(fakeRealHome, 'config.toml'), 'model_reasoning_effort = "high"\n', 'utf8');
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fakeRealHome;
  });

  afterEach(async () => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await rm(fakeRealHome, { recursive: true, force: true });
    __resetCodexSdkStateForTest();
  });

  it('returns a fresh tmp dir under os.tmpdir(), distinct from the real CODEX_HOME', async () => {
    const isolated = await getIsolatedCodexHome();
    assert.notEqual(isolated, fakeRealHome);
    assert.match(isolated, /omk-codex-sdk-/);
    assert.equal(isolated.startsWith(tmpdir()), true);
    assert.equal(existsSync(isolated), true);
  });

  it('does NOT carry over config.toml from real CODEX_HOME (the whole point of isolation)', async () => {
    const isolated = await getIsolatedCodexHome();
    assert.equal(existsSync(join(isolated, 'config.toml')), false);
  });

  it('symlinks auth.json from real CODEX_HOME so the SDK can still authenticate', async () => {
    const isolated = await getIsolatedCodexHome();
    const linkedAuth = join(isolated, 'auth.json');
    assert.equal(existsSync(linkedAuth), true);
    const stat = lstatSync(linkedAuth);
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(readlinkSync(linkedAuth), join(fakeRealHome, 'auth.json'));
  });

  it('memoizes the isolated CODEX_HOME for subsequent calls in the same process', async () => {
    const a = await getIsolatedCodexHome();
    const b = await getIsolatedCodexHome();
    assert.equal(a, b);
  });
});

// PR #33 (SIGINT propagation) installed a process-level SIGINT handler that
// walks a Set<ChildProcess> registry from spawnWithSigintPropagation. The codex
// SDK does its own internal spawn() that the registry doesn't know about, so
// the SDK executor adds its own one-shot SIGINT listener that calls
// abortController.abort() — letting the SDK kill its child via the signal it
// already passes to spawn(). The install/remove pair lives inside try/finally;
// a meaningful end-to-end leak test would need a vi.mock'd SDK, deferred until
// the wider executor mock harness lands.
//
// docs/dev/codex-sdk-sigint-validation.md records the manual ps verification
// (Ctrl+C in a host CLI → no orphan codex process) for this code path.
