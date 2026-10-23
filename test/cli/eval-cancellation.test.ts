import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';

function safeExecutorPid(pid: number | undefined, excluded: readonly (number | undefined)[]): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 && !excluded.includes(pid);
}

function executorPidFromMarker(raw: string, excluded: readonly (number | undefined)[]): number | undefined {
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  const pid = Number(raw);
  return safeExecutorPid(pid, excluded) ? pid : undefined;
}

function signalExecutor(pid: number | undefined, signal: NodeJS.Signals | 0, excluded: readonly (number | undefined)[],
  kill: (pid: number, signal: NodeJS.Signals | 0) => boolean = process.kill): boolean {
  if (!safeExecutorPid(pid, excluded)) throw new Error('Refusing to signal an unsafe executor PID.');
  return kill(pid, signal);
}

it.each([
  { label: 'empty or process-group markers', markers: ['', ' ', '\n', '0', '1'], pids: [undefined, 0, 1] },
  { label: 'nondecimal markers', markers: ['-42', '+42', '4.2', '4e2', 'NaN', 'Infinity'], pids: [-42, 4.2, NaN, Infinity] },
  { label: 'unsafe or owner markers', markers: ['9007199254740992', '123', '456'], pids: [Number.MAX_SAFE_INTEGER + 1, 123, 456] },
])('rejects $label before any signal dispatch', ({ markers, pids }) => {
  const excluded = [123, 456], kill = vi.fn(() => true);
  for (const raw of markers) expect(executorPidFromMarker(raw, excluded)).toBeUndefined();
  for (const pid of pids) expect(() => signalExecutor(pid, 'SIGKILL', excluded, kill)).toThrow('unsafe executor PID');
  expect(kill).not.toHaveBeenCalled();
});

it('dispatches only an independently validated executor PID through the guarded signal boundary', () => {
  const excluded = [123, 456], kill = vi.fn(() => true);
  const pid = executorPidFromMarker('42', excluded);
  expect(pid).toBe(42); expect(signalExecutor(pid, 'SIGKILL', excluded, kill)).toBe(true);
  expect(kill).toHaveBeenCalledExactlyOnceWith(42, 'SIGKILL');
});

// A real process is required: the subprocess coordinator re-raises SIGINT,
// which must reach the CLI's cancellation handler instead of terminating it.
it.each(['eval', 'sample', 'evolve', 'doctor'].flatMap((command) => (['SIGINT', 'SIGTERM'] as const).map((signal) => ({ command, signal }))))('cancels $command after $signal without leaving children or overwriting inputs', async ({ command, signal }) => {
  const root = await mkdtemp(join(tmpdir(), 'omk-eval-signal-'));
  const home = join(root, 'home');
  const skill = join(root, 'answer');
  const marker = join(root, 'child.pid');
  const executor = join(root, 'executor.mjs');
  const samples = join(root, 'samples.json');
  await mkdir(skill);
  await writeFile(join(skill, 'SKILL.md'), '# Answer\nAnswer the question.\n');
  await writeFile(samples, JSON.stringify({ schemaVersion: 'omk.eval-sample-set/v3', samples: [
{ sampleId: 'answer', input: { inputKind: 'text', text: 'Answer.' }, evaluationContext: { assertions: [{ type: 'contains', value: 'answer' }] } }
] }));
  await writeFile(executor, `#!/usr/bin/env node
import { writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  JSON.parse(line);
  const pendingMarker = ${JSON.stringify(marker)} + '.' + process.pid + '.tmp';
  await writeFile(pendingMarker, String(process.pid), { flag: 'wx' });
  await rename(pendingMarker, ${JSON.stringify(marker)});
  setInterval(() => {}, 1000);
  break;
}
`, { mode: 0o755 });
  const common = ['--executor', executor, '--model', 'fixture'];
  const args = command === 'eval'
    ? ['--control', 'baseline', '--treatment', skill, '--samples', samples, ...common,
      '--no-judge', '--no-serve', '--skip-connectivity', '--concurrency', '1', '--retry', '0', '--timeout', '60',
      '--output-dir', join(root, 'reports')]
    : command === 'doctor' ? [skill, ...common, '--repeat', '1']
      : command === 'sample' ? [skill, ...common]
      : [skill, ...common, '--samples', samples, '--skip-doctor', '--rounds', '1'];
  const child = spawn(process.execPath, [resolve('dist/cli/index.js'), command, ...args], {
    cwd: root, env: { ...process.env, OMK_HOME: home, OMK_SKIP_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const excludedPids = [process.pid, child.pid];
  let executorPid: number | undefined;
  try {
    await expect.poll(async () => {
      executorPid = await readFile(marker, 'utf8').then(raw => executorPidFromMarker(raw, excludedPids), () => undefined);
      return executorPid;
    }, { timeout: 15_000 }).toBeDefined();
    expect(child.kill(signal)).toBe(true);
    const ended = await Promise.race([closed, delay(10_000).then(() => { throw new Error(`Cancellation timed out: ${stderr}`); })]);
    expect(ended, stderr).toEqual({ code: 1, signal: null });
    if (command === 'eval') {
      const output = JSON.parse(stdout);
      expect(output).toMatchObject({
        status: { runStatus: 'cancelled', evidenceStatus: 'unresolvable', conclusionStatus: 'inconclusive' },
        gate: { gateStatus: 'blocked', exitCode: 1, reasonCodes: ['core-run-cancelled'] },
      });
      const { createNodeCoreRunArtifactStore } = await import('../../src/eval-workflows/artifact-store/index.js');
      const stored = await createNodeCoreRunArtifactStore(join(root, 'reports')).get(output.runId);
      expect(stored?.report.status.runStatus).toBe('cancelled');
      expect(await readdir(join(home, 'state', 'tmp', 'resource-leases'))).toEqual([]);
    }
    expect(await readFile(join(skill, 'SKILL.md'), 'utf8')).toBe('# Answer\nAnswer the question.\n');
    expect(await readFile(join(skill, '.omk', 'eval-samples.json'), 'utf8').catch(() => undefined)).toBeUndefined();
    expect(() => signalExecutor(executorPid, 0, excludedPids)).toThrow();
  } finally {
    if (executorPid !== undefined) {
      try { signalExecutor(executorPid, 'SIGKILL', excludedPids); } catch { /* Unsafe or already reaped; never signal another process. */ }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try {
      await closed;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

it('exits 130 after a second SIGINT when an asynchronous operation ignores cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omk-force-interrupt-'));
  const fixture = join(root, 'uncooperative.mjs');
  const marker = join(root, 'state');
  await writeFile(fixture, `
import { writeFileSync } from 'node:fs';
import { BaseCommand } from ${JSON.stringify(pathToFileURL(resolve('dist/cli/oclif/base-command.js')).href)};
const runner = Object.create(BaseCommand.prototype);
await runner.runWithCancellation(async (signal) => {
  signal.addEventListener('abort', () => writeFileSync(${JSON.stringify(marker)}, 'aborted'));
  writeFileSync(${JSON.stringify(marker)}, 'ready');
  await new Promise(() => setInterval(() => {}, 1000));
});
`);
  const child = spawn(process.execPath, [fixture], { stdio: 'ignore' });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    await expect.poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 15_000 }).toBe('ready');
    child.kill('SIGINT');
    await expect.poll(() => readFile(marker, 'utf8'), { timeout: 15_000 }).toBe('aborted');
    expect(child.exitCode).toBeNull();
    child.kill('SIGINT');
    await expect(Promise.race([closed, delay(5_000).then(() => { throw new Error('second SIGINT did not terminate'); })]))
      .resolves.toEqual({ code: 130, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
