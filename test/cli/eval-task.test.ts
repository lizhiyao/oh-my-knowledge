import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import EvalTask from '../../src/cli/commands/eval/task.js';
import { runCommand } from '../helpers/run-command.js';
import { runCli } from '../helpers/cli-process.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omk-task-command-'));
  await cp(resolve('examples/local-task'), join(root, 'task'), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('eval task command', () => {
  it('previews without executing or creating reports', async () => {
    await writeFile(join(root, 'task/fixture.mjs'), 'throw new Error("must not execute");');
    const output = await runCommand(EvalTask, [join(root, 'task/task.yaml'), '--dry-run', '--output', join(root, 'reports')]);
    expect(JSON.parse(output.stdout)).toMatchObject({ runtimeKind: 'fixture', knowledgeMode: 'provided-content', estimatedCostUSD: null });
    expect(await readdir(root)).toEqual(['task']);
  });

  // The real dispatcher and compiled package must find the new subcommand and persist a report.
  it('runs from the production dispatcher and stores canonical evidence', async () => {
    const output = await runCli(['eval', 'task', join(root, 'task/task.yaml'), '--output', join(root, 'reports')], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, OMK_HOME: join(root, 'home'), OMK_LANG: 'en' },
    });
    const result = JSON.parse(output.stdout) as { runId: string; report: { status: { runStatus: string } } };
    expect(result.runId).toBeTruthy();
    expect(result.report.status.runStatus).toBe('completed');
    expect(output.stderr).toContain('provided-content');
    expect(await readFile(join(root, 'task/snapshot/math.mjs'), 'utf8')).toContain('return value;');
    expect(await readdir(join(root, 'reports'))).toContain('content');
  });
});
