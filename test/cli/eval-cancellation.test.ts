import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

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
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  JSON.parse(line);
  await writeFile(${JSON.stringify(marker)}, String(process.pid));
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
  let executorPid: number | undefined;
  try {
    await expect.poll(async () => {
      executorPid = await readFile(marker, 'utf8').then(Number, () => undefined);
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
    expect(() => process.kill(executorPid!, 0)).toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    if (executorPid !== undefined) {
      try { process.kill(executorPid, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
    await rm(root, { recursive: true, force: true });
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
