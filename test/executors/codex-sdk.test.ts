import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Codex, type CodexOptions, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk';
import { testDirectory } from '../helpers/temp-directory.js';
import { parseCodexSdkStream } from '../../src/eval-workflows/hosts/adapters/codex/sdk-protocol.js';
import type { CodexSdkClient as CoreCodexSdkClient } from '../../src/eval-workflows/hosts/adapters/codex/sdk-runtime.js';
import {
  __resetCodexSdkStateForTest,
  buildCodexSdkClientOptions,
  buildCodexSdkThreadOptions,
  getIsolatedCodexHome,
  type CodexSdkClient,
} from '../../src/executors/openai/codex/sdk.js';

describe('codex-sdk executor parity contract', () => {
  it('maps the SDK-exposed eval-critical thread options to codex-cli equivalents', () => {
    const opts = buildCodexSdkThreadOptions({ model: 'gpt-5-codex', cwd: '/tmp/iso', effort: 'high' });
    assert.equal(opts.model, 'gpt-5-codex');
    assert.equal(opts.workingDirectory, '/tmp/iso');
    assert.equal(opts.sandboxMode, 'read-only');
    assert.equal(opts.skipGitRepoCheck, true);
    assert.equal(opts.approvalPolicy, 'never');
    assert.equal(opts.modelReasoningEffort, 'high');
  });

  it('omits workingDirectory when cwd is unset, matching codex CLI no -C behavior', () => {
    const opts = buildCodexSdkThreadOptions({ model: 'gpt-5-codex', cwd: null });
    assert.equal('workingDirectory' in opts, false);
    assert.equal('modelReasoningEffort' in opts, false);
  });

  it('uses the SDK bundled binary by leaving codexPathOverride unset', () => {
    const opts = buildCodexSdkClientOptions({ PATH: '/bin' });
    assert.equal('codexPathOverride' in opts, false);
    assert.deepEqual(opts.env, { PATH: '/bin' });
  });

});

// Exercise the installed SDK's actual spawn/JSONL boundary. Only this synthetic
// executable is launched; the bundled Codex binary and user auth are never used.
async function sdkProcessFixture(mode: 'complete' | 'wait') {
  const root = testDirectory('omk-codex-sdk-real-');
  const executable = join(root, 'codex-fixture.mjs');
  const capture = join(root, 'capture.json');
  const exited = join(root, 'exited');
  await writeFile(executable, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const wireUsage = { input_tokens: 8, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2 };
writeFileSync(process.env.OMK_SDK_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), input, pid: process.pid, wireUsage,
  home: process.env.HOME, codexHome: process.env.CODEX_HOME,
  marker: process.env.OMK_SDK_PRIVATE_MARKER,
  inherited: process.env.OMK_SDK_PARENT_MARKER,
}));
const emit = (event) => console.log(JSON.stringify(event));
if (process.env.OMK_SDK_FIXTURE_MODE === 'wait') {
  process.on('SIGTERM', () => {
    writeFileSync(process.env.OMK_SDK_EXITED, 'SIGTERM');
    process.exit(0);
  });
  setInterval(() => {}, 1000);
  emit({ type: 'thread.started', thread_id: 'synthetic-thread' });
} else {
  emit({ type: 'thread.started', thread_id: 'synthetic-thread' });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'synthetic answer' } });
  // Deliberately omit cache_write_input_tokens on the CLI wire.
  emit({ type: 'turn.completed', usage: wireUsage });
}
`, { mode: 0o755 });
  const options = {
    ...buildCodexSdkClientOptions({
      PATH: dirname(process.execPath), HOME: root, CODEX_HOME: join(root, 'private-codex-home'),
      OMK_SDK_CAPTURE: capture, OMK_SDK_EXITED: exited, OMK_SDK_FIXTURE_MODE: mode,
      OMK_SDK_PRIVATE_MARKER: 'private-only',
    }),
    codexPathOverride: executable,
    baseUrl: 'http://127.0.0.1:9',
  } satisfies CodexOptions;
  return { root, capture, exited, options };
}

describe.skipIf(process.platform === 'win32')('installed Codex SDK process contract', () => {
  it('accepts OMK options/types and maps the private environment and real SDK events', async () => {
    const fixture = await sdkProcessFixture('complete');
    const originalMarker = process.env.OMK_SDK_PARENT_MARKER;
    process.env.OMK_SDK_PARENT_MARKER = 'must-not-inherit';
    try {
      // Both OMK clients must remain assignable from the real SDK declaration.
      const client: CodexSdkClient = new Codex(fixture.options);
      const coreClient: CoreCodexSdkClient = new Codex(fixture.options);
      const options = buildCodexSdkThreadOptions({
        model: 'synthetic-model', cwd: fixture.root, effort: 'high',
      }) satisfies ThreadOptions;
      const thread = client.startThread(options);
      assert.equal(typeof coreClient.startThread(options).runStreamed, 'function');
      const streamed = await thread.runStreamed('synthetic prompt');
      const events: unknown[] = [];
      for await (const event of streamed.events) events.push(event);
      const captured = JSON.parse(readFileSync(fixture.capture, 'utf8'));
      assert.deepEqual(captured.args, [
        'exec', '--experimental-json', '--config', 'openai_base_url="http://127.0.0.1:9"',
        '--model', 'synthetic-model',
        '--sandbox', 'read-only', '--cd', fixture.root, '--skip-git-repo-check',
        '--config', 'model_reasoning_effort="high"', '--config', 'approval_policy="never"',
      ]);
      assert.equal(captured.input, 'synthetic prompt');
      assert.equal(captured.home, fixture.root);
      assert.equal(captured.codexHome, fixture.options.env.CODEX_HOME);
      assert.equal(captured.marker, 'private-only');
      assert.equal(captured.inherited, undefined);

      // The installed real SDK fills a missing CLI cache-write bucket with zero. This is
      // upstream normalization, not evidence that the provider reported zero.
      assert.equal('cache_write_input_tokens' in captured.wireUsage, false);
      assert.deepEqual(events.at(-1), {
        type: 'turn.completed',
        usage: { input_tokens: 8, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 2 },
      });
      const parsed = parseCodexSdkStream(events);
      assert.equal(parsed.terminalStatus, 'completed');
      assert.equal(parsed.output, 'synthetic answer');
      assert.deepEqual(parsed.usage, {
        inputTokens: 8, outputTokens: 5, totalTokens: 13,
        details: { cachedInputTokens: 3, cacheWriteInputTokens: 0, reasoningOutputTokens: 2 },
      });
    } finally {
      if (originalMarker === undefined) delete process.env.OMK_SDK_PARENT_MARKER;
      else process.env.OMK_SDK_PARENT_MARKER = originalMarker;
    }
  });

  it('rejects the real SDK stream on abort and terminates its owned fake child', async () => {
    const fixture = await sdkProcessFixture('wait');
    const controller = new AbortController();
    const thread = new Codex(fixture.options).startThread();
    const { events } = await thread.runStreamed('synthetic cancellation', { signal: controller.signal });
    const iterator: AsyncGenerator<ThreadEvent> = events;
    try {
      assert.deepEqual((await iterator.next()).value, { type: 'thread.started', thread_id: 'synthetic-thread' });
      const drained = (async () => {
        for await (const event of iterator) void event;
      })();
      const rejected = assert.rejects(drained, { name: 'AbortError' });
      controller.abort();
      await rejected;
      for (let attempt = 0; attempt < 100 && !existsSync(fixture.exited); attempt += 1) await delay(20);
      assert.equal(readFileSync(fixture.exited, 'utf8'), 'SIGTERM');
      const { pid } = JSON.parse(readFileSync(fixture.capture, 'utf8')) as { pid: number };
      let alive = true;
      for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
        try { process.kill(pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          alive = false;
        }
        if (alive) await delay(20);
      }
      assert.equal(alive, false, 'aborting the SDK must leave no fake Codex child');
    } finally {
      controller.abort();
      // Failure cleanup is separate from the assertions above: an SDK abort
      // regression must fail the test without leaving its synthetic child.
      if (existsSync(fixture.capture) && !existsSync(fixture.exited)) {
        const { pid } = JSON.parse(readFileSync(fixture.capture, 'utf8')) as { pid: number };
        try { process.kill(pid, 'SIGTERM'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await iterator.return(undefined).catch(() => undefined);
    }
  });
});

// codex-cli passes `--ephemeral` + `--ignore-user-config` to keep eval runs
// independent of the user's real $CODEX_HOME. The SDK ThreadOptions does not
// expose either flag, so the SDK executor redirects $CODEX_HOME to a per-run
// tmp dir (auth.json copied through). Without this, codex vs codex-sdk are
// not testing the same prompt+template under the same config — construct
// validity violation.
describe('codex-sdk CODEX_HOME isolation (--ephemeral + --ignore-user-config equivalent)', () => {
  let fakeRealHome: string;
  let originalCodexHome: string | undefined;
  let isolatedHomes: string[];

  beforeEach(async () => {
    __resetCodexSdkStateForTest();
    isolatedHomes = [];
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
    await Promise.all(isolatedHomes.map((home) => rm(home, { recursive: true, force: true })));
    await rm(fakeRealHome, { recursive: true, force: true });
    __resetCodexSdkStateForTest();
  });

  const createIsolatedHome = async (): Promise<string> => {
    const home = await getIsolatedCodexHome();
    isolatedHomes.push(home);
    return home;
  };

  it('returns a fresh tmp dir under os.tmpdir(), distinct from the real CODEX_HOME', async () => {
    const isolated = await createIsolatedHome();
    assert.notEqual(isolated, fakeRealHome);
    assert.match(isolated, /omk-codex-sdk-/);
    assert.equal(isolated.startsWith(tmpdir()), true);
    assert.equal(existsSync(isolated), true);
  });

  it('does NOT carry over config.toml from real CODEX_HOME (the whole point of isolation)', async () => {
    const isolated = await createIsolatedHome();
    assert.equal(existsSync(join(isolated, 'config.toml')), false);
  });

  it('copies auth.json so SDK token refreshes cannot mutate the real credential file', async () => {
    const isolated = await createIsolatedHome();
    const copiedAuth = join(isolated, 'auth.json');
    assert.equal(readFileSync(copiedAuth, 'utf8'), '{"fake":"auth"}');
    await writeFile(copiedAuth, '{"isolated":"refresh"}', 'utf8');
    assert.equal(readFileSync(join(fakeRealHome, 'auth.json'), 'utf8'), '{"fake":"auth"}');
  });

  it('creates a distinct CODEX_HOME for every execution', async () => {
    const a = await createIsolatedHome();
    const b = await createIsolatedHome();
    assert.notEqual(a, b);
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
