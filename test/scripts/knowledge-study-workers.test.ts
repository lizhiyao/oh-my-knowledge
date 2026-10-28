import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerJobService, fileWorkerExecArgv } from '../../src/shared/worker-job.js';
import { nativeStudyFixture } from '../knowledge/extraction-study-fixtures.js';
import { copyStudyRuntime } from '../helpers/study-runtime.js';
import { runCli } from '../helpers/cli-process.js';

const repository = resolve('.'), roots: string[] = [], cancellations: AbortController[] = [];
const completions: Promise<unknown>[] = [];
function root() { const value = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-worker-'))); roots.push(value); return value; }
function controller() { const value = new AbortController(); cancellations.push(value); return value; }
function tracked<T>(promise: Promise<T>) { completions.push(promise.catch(() => undefined)); return promise; }
afterEach(async () => {
  for (const value of cancellations.splice(0)) value.abort();
  await Promise.all(completions.splice(0));
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function worker(directory: string, body: string) {
  const file = join(directory, 'fixture-worker.mjs');
  writeFileSync(file, `import { runWorkerJob } from ${JSON.stringify(pathToFileURL(join(repository, 'dist/shared/worker-job.js')).href)};\n${body}`);
  return pathToFileURL(file);
}
async function evalCall(installation: string, args: string[]) {
  // cli-process owns the outer harness; this fixture preserves the real Node -e/execArgv boundary.
  const entry = join(root(), 'eval-entry.mjs');
  writeFileSync(entry, `import { spawnSync } from 'node:child_process';
    const result = spawnSync(process.execPath, JSON.parse(process.argv[2]), { stdio: 'inherit', timeout: 115_000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 99;
  `);
  // Leave time for the fixture's child timeout to finish before the owner kills its parent.
  return runCli([JSON.stringify(args)], { entry, cwd: installation, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
}
async function builtCall(installation: string, module: string, name: string, input: unknown) {
  const url = pathToFileURL(join(installation, 'dist', module)).href;
  const code = `import { ${name} as execute } from ${JSON.stringify(url)};
    try { const value = await execute(JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify({ ok: true, value })); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? (error.name === 'ExtractionStudyFileError' ? 'knowledge_study_file_invalid' : 'worker_failed') })); }`;
  const result = await evalCall(installation, ['--input-type=module', '-e', code, JSON.stringify(input)]);
  return JSON.parse(result.stdout) as { ok: boolean; code?: string; value: Record<string, unknown> };
}

describe('fixed study workers (built runtime; authored local data, no model service)', () => {
  it.each([{ inputMode: ['--input-type=module'] }, { inputMode: ['--input-type', 'module'] }])('removes only eval/stdin input mode and preserves worker restrictions: $inputMode', ({ inputMode }) => {
    const retained = ['--permission', '--allow-worker', '--allow-fs-read=/private/tmp/fixture', '--conditions=omk-worker', '--require', '/fixture/preload.cjs'];
    const args = [...retained.slice(0, 2), ...inputMode, ...retained.slice(2)], original = [...args];
    expect(fileWorkerExecArgv(args)).toEqual(retained); expect(args).toEqual(original);
    expect(fileWorkerExecArgv(['--input-type', '--permission', '--allow-worker'])).toEqual(['--permission', '--allow-worker']);
  });

  it('keeps the main event loop available and counts every full, uncached physical identity pass', async () => {
    const directory = root(), installation = join(directory, 'runtime'); copyStudyRuntime(repository, installation);
    const identityUrl = pathToFileURL(join(installation, 'dist/knowledge/adapters/study-host.js')).href;
    const entry = worker(directory, `
      import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const original = fs.readFileSync; let active = false, completePasses = 0, reads = 0;
      fs.readFileSync = function(path, ...args) { if (active) { reads++; if (path === process.execPath) completePasses++; } return original.call(this, path, ...args); };
      syncBuiltinESMExports();
      const { extractionStudyHostIdentity: identity } = await import(${JSON.stringify(identityUrl)});
      void runWorkerJob(input => {
        const progress = new Int32Array(input.progress); Atomics.store(progress, 0, 1); active = true;
        const values = [identity(), identity(), identity()]; active = false; Atomics.store(progress, 0, 2);
        return { completePasses, reads, sameIdentity: values.every(value => JSON.stringify(value) === JSON.stringify(values[0])) };
      });`);
    const jobs = createWorkerJobService(entry, 'terminate'), abort = controller(), lease = jobs.reserve(abort.signal);
    const progress = new Int32Array(new SharedArrayBuffer(4)), delay = monitorEventLoopDelay({ resolution: 1 }); let ticksDuringHash = 0;
    const timer = setInterval(() => { if (Atomics.load(progress, 0) === 1) ticksDuringHash++; }, 1); delay.enable();
    try {
      const result = await tracked(lease.run<{ completePasses: number; reads: number; sameIdentity: boolean }>({ progress: progress.buffer }));
      expect(result).toMatchObject({ completePasses: 3, sameIdentity: true }); expect(result.reads).toBeGreaterThan(3); expect(ticksDuringHash).toBeGreaterThan(0);
      // Measurements are emitted by the eventual test run, not asserted as portable performance limits.
      process.stdout.write(JSON.stringify({ studyWorkerMeasurement: { completeIdentityPasses: result.completePasses,
        physicalFileReads: result.reads, mainTimerTicksDuringHash: ticksDuringHash, eventLoopDelayMaxMs: delay.max / 1e6 } }) + '\n');
    } finally { clearInterval(timer); delay.disable(); lease.release(); }
  }, 120_000);

  it.each(['terminate', 'cooperative'] as const)('bounds concurrency, cancels %s work and releases capacity only after exit/cleanup', async mode => {
    const directory = root(), marker = join(directory, 'cleanup.txt');
    const entry = worker(directory, `
      import { writeFileSync } from 'node:fs'; import { setTimeout } from 'node:timers/promises';
      void runWorkerJob(async (input, context) => {
        if (input.mode === 'success') return 'done';
        const started = new Int32Array(input.started); Atomics.store(started, 0, 1);
        try { while (true) { context.checkpoint(); await setTimeout(2); } }
        finally { await setTimeout(20); writeFileSync(input.marker, 'cleanup-complete'); }
      });`);
    const jobs = createWorkerJobService(entry, mode), abort = controller(), lease = jobs.reserve(abort.signal);
    expect(() => jobs.reserve()).toThrow('worker_busy');
    const started = new Int32Array(new SharedArrayBuffer(4));
    const pending = tracked(lease.run({ mode: 'wait', marker, started: started.buffer }));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'worker_cancelled' });
    await vi.waitFor(() => expect(Atomics.load(started, 0)).toBe(1)); abort.abort();
    expect(() => jobs.reserve()).toThrow('worker_busy'); await rejected;
    if (mode === 'cooperative') expect(readFileSync(marker, 'utf8')).toBe('cleanup-complete');
    const recovered = jobs.reserve(); expect(await tracked(recovered.run({ mode: 'success' }))).toBe('done');
    lease.release(); recovered.release();
  });

  it('observes a main-thread abort at the synchronous final gate before the worker can process its abort message', async () => {
    const directory = root(), marker = join(directory, 'dispatched.txt');
    const entry = worker(directory, `
      import { writeFileSync } from 'node:fs';
      void runWorkerJob((input, context) => {
        const gate = new Int32Array(input.gate); Atomics.store(gate, 0, 1);
        while (Atomics.load(gate, 1) === 0) { /* authored CPU phase cannot process messages */ }
        context.checkpoint(); writeFileSync(input.marker, 'dispatched'); return 'unexpected';
      });`);
    const jobs = createWorkerJobService(entry, 'cooperative'), abort = controller(), lease = jobs.reserve(abort.signal);
    const gate = new Int32Array(new SharedArrayBuffer(8));
    const pending = tracked(lease.run({ gate: gate.buffer, marker }));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'worker_cancelled' });
    try {
      await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1)); abort.abort(); Atomics.store(gate, 1, 1);
      await rejected; expect(existsSync(marker)).toBe(false);
    } finally { Atomics.store(gate, 1, 1); abort.abort(); await pending.catch(() => undefined); lease.release(); }
  });

  it.each(['throw', 'exit'] as const)('settles worker %s without exposing exceptions and leaves no occupied slot', async failure => {
    const directory = root(), entry = worker(directory, `void runWorkerJob(input => {
      if (input === 'throw') throw new Error('PRIVATE-WORKER-PATH-OR-INPUT');
      if (input === 'exit') process.exit(0); return 'recovered';
    });`);
    const jobs = createWorkerJobService(entry, 'terminate'), lease = jobs.reserve();
    await expect(tracked(lease.run(failure))).rejects.toMatchObject({ code: 'worker_failed', message: 'worker_failed' });
    const next = jobs.reserve(); expect(await tracked(next.run('success'))).toBe('recovered'); next.release(); lease.release();
    const aborted = controller(); aborted.abort(); expect(() => jobs.reserve(aborted.signal)).toThrow('worker_cancelled');
  });

  it('rejects retired typed dispatch in the fixed worker before reading a plan, touching a workspace or calling a provider', async () => {
    const directory = root(), workspace = join(directory, 'absent-workspace'), study = join(directory, 'absent-study');
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume(); request.on('end', () => {
        requests++;
        response.writeHead(500); response.end('Provider must not be called.');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback server.');
    const environment = { OPENAI_API_KEY: 'authored-worker-test-key', OPENAI_BASE_URL: `http://127.0.0.1:${address.port}` };
    const request = { command: 'run', repository, runnerFile: join(repository, 'dist-scripts/bench/knowledge-study.js'), environment,
      values: { '--workspace': workspace, '--study': study, '--slot': 'absent-slot', '--authorize-plan': 'sha256:absent' } };
    try {
      for (let call = 0; call < 2; call++) {
        const rejected = await builtCall(repository, 'cli/runtime/knowledge-study.js', 'executeLocalExtractionStudy', request);
        expect(rejected).toMatchObject({ ok: true, value: { errorCode: 'knowledge_study_generation_unsupported',
          modelCallsByThisCommand: 0, qualityConclusion: 'not_evaluated', exitCode: 1 } });
        expect(rejected.value.message).toContain('observe knowledge generate');
        expect(requests).toBe(0); expect(existsSync(workspace)).toBe(false); expect(existsSync(study)).toBe(false);
      }
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 120_000);

  it('inspects a portable export through the built fixed service and CLI file mode without reading workspace settings', async () => {
    const directory = root(), installation = repository;
    const f = nativeStudyFixture(directory), template = f.prepare();
    const corpusPath = join(directory, 'corpus.json'), configPath = join(directory, 'configuration.json'); writeFileSync(corpusPath, f.corpusRaw);
    writeFileSync(configPath, JSON.stringify({ configurationVersion: 'omk-knowledge-extraction-study-configuration/v1', actor: template.actor,
      changedVariable: 'replication', split: 'development', repeats: 1, criteria: template.criteria, sampling: template.sampling,
      variants: ['baseline', 'candidate'].map(variantId => ({ variantId, executor: 'openai-api', model: 'authored-loopback-test', policy: template.variants[0].policy, maxOutputTokens: 64 })) }));
    const input = { command: 'prepare', repository: installation, runnerFile: join(repository, 'dist-scripts/bench/knowledge-study.js'),
      environment: { OPENAI_API_KEY: 'authored-worker-test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1' },
      values: { '--workspace': f.workspace, '--study': join(directory, 'study'), '--corpus': corpusPath, '--config': configPath } };
    expect((await builtCall(installation, 'cli/runtime/knowledge-study.js', 'executeLocalExtractionStudy', input)).ok).toBe(true);
    const output = join(directory, 'export');
    expect((await builtCall(installation, 'cli/runtime/knowledge-study.js', 'executeLocalExtractionStudy', { ...input, command: 'report', values: { ...input.values, '--output': output } })).ok).toBe(true);
    const inspected = await builtCall(installation, 'knowledge/application/study-inspection-service.js', 'inspectExtractionStudyFiles', { evidence: join(output, 'evidence.json') });
    expect(inspected).toMatchObject({ ok: true, value: { inspectionVersion: 'omk-extraction-study-inspection/v2', modelCallsByThisCommand: 0,
      summary: { unattempted: 2 }, review: { status: 'blocked', reference: { goldReady: false } } } });
    const byteCode = `
      import { readFileSync } from 'node:fs';
      import { reserveExtractionStudyInspection as reserve } from ${JSON.stringify(pathToFileURL(join(installation, 'dist/knowledge/application/study-inspection-service.js')).href)};
      const lease = reserve(); let busy; try { reserve(); } catch (error) { busy = error.code; }
      try {
        const bytes = new Uint8Array(Buffer.from('PRIVATE-HTTP-BYTES invalid JSON'));
        const pending = lease.inspect({ inputKind: 'bytes', bytes: bytes.buffer });
        const detached = bytes.byteLength === 0; let invalid;
        try { await pending; } catch (error) { invalid = error.code; }
        lease.release();
        const next = reserve(), raw = new Uint8Array(Buffer.from(JSON.stringify({ evidence: JSON.parse(readFileSync(process.argv[1], 'utf8')) })));
        try {
          const value = await next.inspect({ inputKind: 'bytes', bytes: raw.buffer });
          process.stdout.write(JSON.stringify({ busy, detached, invalid, summary: value.summary, modelCalls: value.modelCallsByThisCommand }));
        } finally { next.release(); }
      } finally { lease.release(); }
    `;
    const byteResult = await evalCall(installation, ['--input-type', 'module', '-e', byteCode, join(output, 'evidence.json')]);
    expect(JSON.parse(byteResult.stdout)).toMatchObject({ busy: 'knowledge_study_busy', detached: true, invalid: 'invalid_json_body',
      summary: { unattempted: 2 }, modelCalls: 0 });
    const home = join(directory, 'home'); mkdirSync(home); writeFileSync(join(home, 'settings.json'), '{invalid');
    const cli = await runCli(['observe', 'knowledge', 'study', '--evidence', join(output, 'evidence.json'), '--json', '--lang', 'en'],
      { entry: join(repository, 'dist/cli/index.js'), cwd: directory, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, HOME: home, OMK_HOME: home, OMK_SKIP_UPDATE_CHECK: '1', NODE_ENV: 'test' } });
    expect(JSON.parse(cli.stdout)).toMatchObject({ inspectionVersion: 'omk-extraction-study-inspection/v2', modelCallsByThisCommand: 0, summary: { unattempted: 2 } });
    expect(cli.stderr).toBe(''); expect(cli.stdout).not.toContain(directory); expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{invalid');
    const invalid = await builtCall(installation, 'knowledge/application/study-inspection-service.js', 'inspectExtractionStudyFiles', { evidence: join(directory, 'PRIVATE-MISSING-FILE') });
    expect(invalid).toMatchObject({ ok: false, code: 'knowledge_study_file_invalid' });
  }, 120_000);
});
