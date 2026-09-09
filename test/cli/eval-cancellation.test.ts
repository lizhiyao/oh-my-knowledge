import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

// A real process is required: the subprocess coordinator re-raises SIGINT,
// which must reach the CLI's cancellation handler instead of terminating it.
it.each(['SIGINT', 'SIGTERM'] as const)('saves cancelled evidence and releases children and resources after %s', async (signal) => {
  const root = await mkdtemp(join(tmpdir(), 'omk-eval-signal-'));
  const home = join(root, 'home');
  const skill = join(root, 'answer');
  const marker = join(root, 'child.pid');
  const executor = join(root, 'executor.mjs');
  const samples = join(root, 'samples.json');
  await mkdir(skill);
  await writeFile(join(skill, 'SKILL.md'), '# Answer\nAnswer the question.\n');
  await writeFile(samples, JSON.stringify({ schemaVersion: 'omk.eval-sample-set/v2', samples: [
    { sample_id: 'answer', prompt: 'Answer.', assertions: [{ type: 'contains', value: 'answer' }] },
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
  const child = spawn(process.execPath, [resolve('dist/cli/index.js'), 'eval',
    '--control', 'baseline', '--treatment', skill, '--samples', samples,
    '--executor', executor, '--model', 'fixture', '--no-judge', '--no-serve',
    '--skip-connectivity', '--concurrency', '1', '--retry', '0', '--timeout', '60',
    '--output-dir', join(root, 'reports'),
  ], { cwd: root, env: { ...process.env, OMK_HOME: home, OMK_SKIP_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const output = JSON.parse(stdout);
    expect(output).toMatchObject({
      status: { runStatus: 'cancelled', evidenceStatus: 'unresolvable', conclusionStatus: 'inconclusive' },
      gate: { gateStatus: 'blocked', exitCode: 1, reasonCodes: ['core-run-cancelled'] },
    });
    const { createNodeCoreRunArtifactStore } = await import('../../src/eval-workflows/artifact-store/index.js');
    const stored = await createNodeCoreRunArtifactStore(join(root, 'reports')).get(output.runId);
    expect(stored?.report.status.runStatus).toBe('cancelled');
    expect(await readdir(join(home, 'state', 'tmp', 'resource-leases'))).toEqual([]);
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
