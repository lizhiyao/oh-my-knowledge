import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWithSigintPropagation } from '../../../../executors/core/subprocess.js';

const VERSION_LINE = /^(?:codex-cli(?:-exec)?\s+)?([^\s]+)$/;

/**
 * One-shot `--version` probe in a throwaway directory, shared by the sealed host seam and the
 * published reference Executor so both read the vendor identity the same way. Failures stay
 * generic: stderr and provider detail never reach the caller.
 */
export async function probeCodexCliVersion(input: Readonly<{
  executablePath: string;
  environment: Readonly<Record<string, string>>;
  maxOutputBytes: number;
  timeoutMs: number;
}>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'omk-codex-identity-'));
  try {
    const internalAbort = new AbortController();
    const { child, done } = spawnWithSigintPropagation(
      input.executablePath,
      ['--version'],
      {
        cwd: directory,
        env: { ...input.environment },
        maxBuffer: Math.min(input.maxOutputBytes, 64 * 1024),
        timeoutMs: input.timeoutMs,
        abortSignal: internalAbort.signal,
      },
    );
    let stdinFailed = child.stdin === null;
    if (child.stdin === null) internalAbort.abort();
    else {
      child.stdin.once('error', () => {
        stdinFailed = true;
        internalAbort.abort();
      });
      child.stdin.end();
    }
    let stdout: string;
    try {
      stdout = (await done).stdout.trim();
    } catch {
      if (stdinFailed) throw new TypeError('Codex CLI version probe stdin is unavailable.');
      throw new TypeError('Codex CLI version probe failed.');
    }
    const match = VERSION_LINE.exec(stdout);
    if (match?.[1] === undefined || match[1].length > 128) {
      throw new TypeError('Codex CLI version probe returned an invalid version.');
    }
    return match[1];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
