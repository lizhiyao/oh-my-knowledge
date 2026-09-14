import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { load } from 'js-yaml';
// @ts-expect-error Standalone Node scripts run without a TypeScript build.
import { fullCI, findEvidence, readJSON } from '../../scripts/release-evidence.mjs';
// @ts-expect-error Standalone Node script.
import { failureCategory, runBounded } from '../../scripts/ci-run.mjs';
// @ts-expect-error Standalone Node script.
import { verifyBundle, publicationState, publish, pack } from '../../scripts/release-package.mjs';

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'omk-release-test-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const channel = JSON.parse(readFileSync('package.json', 'utf8')).version.includes('-') ? 'next' : 'latest';
const sha = 'a'.repeat(40); const repository = 'owner/repo';
const run = { id: 12, run_attempt: 2, repository: { full_name: repository }, workflow_id: 9, head_sha: sha,
  event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success', html_url: 'https://github.com/run' };
const jobs = ['quality', 'test (22)', 'test (24)', ...['22', '24'].flatMap(v => [1, 2, 3, 4].map(s => `test shard (${v}, ${s}/4)`))]
  .map(name => ({ name, status: 'completed', conclusion: 'success' }));
const identity = { sha, repository, workflowId: 9 };

describe('exact-commit release evidence', () => {
  it('requires the trusted workflow, repository, event, commit and complete matrix', () => {
    expect(fullCI(run, jobs, identity)).toBe(true);
    for (const patch of [{ head_sha: 'b'.repeat(40) }, { workflow_id: 10 }, { repository: { full_name: 'fork/repo' } },
      { event: 'pull_request' }, { head_branch: 'feature' }, { conclusion: 'failure' }, { status: 'in_progress' }]) {
      expect(fullCI({ ...run, ...patch }, jobs, identity)).toBe(false);
    }
    expect(fullCI(run, jobs.slice(0, 3), identity)).toBe(false);
    for (const conclusion of ['failure', 'cancelled', 'skipped']) {
      expect(fullCI(run, [...jobs.slice(0, -1), { ...jobs.at(-1), conclusion }], identity)).toBe(false);
    }
    expect(fullCI({ ...run, event: 'workflow_dispatch' }, jobs, identity)).toBe(true);
  });
  it('reads the exact attempt and refuses newer failed evidence rather than taking an older green run', async () => {
    const read = vi.fn(async (url: string) => url.endsWith('ci.yml') ? { id: 9 }
      : url.includes('/runs?') ? { workflow_runs: [run] } : { jobs });
    expect(await findEvidence({ repository, sha, read, timeoutMs: 0 })).toMatchObject({ commit: sha, attempt: 2 });
    expect(read.mock.calls.at(-1)?.[0]).toContain('/runs/12/attempts/2/jobs');
    read.mockImplementation(async (url: string) => url.endsWith('ci.yml') ? { id: 9 }
      : url.includes('/runs?') ? { workflow_runs: [run, { ...run, id: 13, conclusion: 'failure' }] } : { jobs });
    await expect(findEvidence({ repository, sha, read, timeoutMs: 0 })).rejects.toThrow('failed');
  });
  it('fails within budget if the exact commit has no completed run', async () => {
    const read = async (url: string) => url.endsWith('ci.yml') ? { id: 9 } : { workflow_runs: [] };
    await expect(findEvidence({ repository, sha, read, timeoutMs: 0 })).rejects.toThrow('wait budget');
  });
  it('retries only transient read failures, with a bounded attempt count', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const wait = vi.fn();
    expect(await readJSON('https://example.invalid', { fetcher, wait })).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].method).toBe('GET');
    fetcher.mockReset().mockResolvedValue({ ok: false, status: 403 });
    await expect(readJSON('https://example.invalid', { fetcher, wait })).rejects.toThrow('403');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockReset().mockResolvedValue({ ok: false, status: 503 });
    await expect(readJSON('https://example.invalid', { fetcher, wait })).rejects.toThrow('503');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('bounded command diagnostics', () => {
  it('does not call a killed or slow process OOM without evidence', () => {
    expect(failureCategory({ signal: 'SIGKILL' })).toBe('unknown_signal');
    expect(failureCategory({ timedOut: true })).toBe('process_timeout');
    expect(failureCategory({ code: 1, tail: 'fixture assertion failed' })).toBe('command_failure');
    expect(failureCategory({ code: 1, tail: 'FATAL ERROR: Reached heap limit Allocation failed' })).toBe('out_of_memory');
    expect(failureCategory({ cancelled: true })).toBe('cancelled');
    expect(failureCategory({ code: 0, tail: 'JavaScript heap out of memory\nReadNetworkError: recovered' })).toBe('success');
    expect(failureCategory({ code: 1, tail: 'ReadNetworkError: request timed out' })).toBe('network_failure');
  });
  it('terminates a hung process group and saves evidence without retrying', async () => {
    const directory = temp();
    const code = await runBounded({ name: 'hang', directory, timeoutMs: 150, graceMs: 50, sampleMs: 100,
      command: [process.execPath, '-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"] });
    expect(code).toBe(124);
    const record = JSON.parse(readFileSync(join(directory, 'hang.json'), 'utf8'));
    expect(record).toMatchObject({ category: 'process_timeout', attempts: 1 });
    expect(record.durationMs).toBeLessThan(2500);
    expect(readFileSync(join(directory, 'hang-resources.jsonl'), 'utf8')).toContain('freeMemory');
  });
  it('cancels the CLI wrapper and records an actual signal without leaving the child running', async () => {
    const directory = temp();
    const wrapper = spawn(process.execPath, ['scripts/ci-run.mjs', 'cancel-test', directory, '5000', process.execPath,
      '-e', "console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
    const finished = new Promise<number | null>(resolve => wrapper.on('close', code => resolve(code)));
    await new Promise<void>(resolve => wrapper.stdout.on('data', chunk => { if (chunk.toString().includes('ready')) resolve(); }));
    wrapper.kill('SIGTERM');
    expect(await finished).toBe(130);
    expect(JSON.parse(readFileSync(join(directory, 'cancel-test.json'), 'utf8')).category).toBe('cancelled');
  });
  it('records inability to start a process without confusing it with a test assertion', async () => {
    const directory = temp();
    expect(await runBounded({ name: 'spawn', directory, timeoutMs: 3000, command: [join(directory, 'absent-executable')] })).not.toBe(0);
    expect(JSON.parse(readFileSync(join(directory, 'spawn.json'), 'utf8')).category).toBe('execution_failure');
  });
  it('records ordinary failures and aggregates machine-readable counts', async () => {
    const directory = temp();
    expect(await runBounded({ name: 'failed-test', directory, timeoutMs: 3000, command: [process.execPath, '-e', 'process.exit(7)'] })).toBe(7);
    const result = spawnSync(process.execPath, ['scripts/ci-report.mjs', directory], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: join(directory, 'summary.md') } });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8')).counts).toEqual({ command_failure: 1 });
  });
});

function bundle() {
  const directory = temp(); const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const bytes = 'fixed package bytes'; const filename = 'package.tgz'; writeFileSync(join(directory, filename), bytes);
  const manifest = { name: pkg.name, version: pkg.version, commit: sha, filename,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  writeFileSync(join(directory, 'package-manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'package-smoke.json'), JSON.stringify({ commit: sha, version: pkg.version, integrity: manifest.integrity, status: 'passed' }));
  return { directory, manifest, pkg };
}

describe('verified package publication', () => {
  it('refuses altered bytes, identity and incompatible registry versions', async () => {
    const { directory, manifest, pkg } = bundle();
    expect(verifyBundle(directory, sha, pkg).file).toBe(join(directory, 'package.tgz'));
    expect(() => verifyBundle(directory, 'b'.repeat(40), pkg)).toThrow('identity');
    writeFileSync(join(directory, 'package.tgz'), 'tampered');
    expect(() => verifyBundle(directory, sha, pkg)).toThrow('digest');
    await expect(publicationState(manifest, async () => ({ ...manifest, dist: { integrity: 'wrong' } }))).rejects.toThrow('different');
  });
  it('publishes the verified tarball once without lifecycle hooks; identical versions skip upload', async () => {
    const { directory, manifest } = bundle(); const execute = vi.fn();
    await publish(directory, sha, channel, { run: execute, read: async () => null });
    expect(execute.mock.calls).toHaveLength(1);
    expect(execute.mock.calls[0].slice(0, 2)).toEqual(['npm', ['publish', join(directory, 'package.tgz'), '--ignore-scripts', '--access', 'public', '--tag', channel]]);
    execute.mockClear();
    await publish(directory, sha, channel, { run: execute, read: async () => ({ ...manifest, dist: { integrity: manifest.integrity } }) });
    expect(execute).not.toHaveBeenCalled();
    execute.mockImplementation(() => { throw new Error('uncertain publication'); });
    await expect(publish(directory, sha, channel, { run: execute, read: async () => null })).rejects.toThrow('uncertain');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('packs once with lifecycle scripts disabled and hashes the resulting file', () => {
    const { directory, pkg } = bundle();
    const execute = vi.fn(() => JSON.stringify([{ name: pkg.name, version: pkg.version, filename: 'package.tgz' }]));
    expect(pack(directory, sha, execute)).toMatchObject({ commit: sha, name: pkg.name });
    expect(execute.mock.calls[0]).toEqual(['npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory]]);
  });
});

it('separates read-only verification from OIDC publication and never cancels an in-flight publish', () => {
  const workflow = load(readFileSync(resolve('.github/workflows/publish.yml'), 'utf8')) as { concurrency: Record<string, unknown>; jobs: Record<string, { permissions: Record<string, string>; needs?: string; 'timeout-minutes': number; steps: { run?: string }[] }> };
  expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  expect(workflow.jobs.verify.permissions['id-token']).toBeUndefined();
  expect(workflow.jobs.publish.needs).toBe('verify');
  expect(workflow.jobs.publish.permissions['id-token']).toBe('write');
  expect(workflow.jobs.verify['timeout-minutes']).toBeGreaterThan(0);
  expect(workflow.jobs.publish['timeout-minutes']).toBeGreaterThan(0);
  const steps = workflow.jobs.publish.steps.map((step) => step.run ?? '').join('\n');
  expect(steps).not.toMatch(/yarn.*build|yarn.*test/);
});
