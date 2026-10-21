import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const USAGE = '用法：yarn test:profile [--top <正整数>] [--workers <正整数>] [--output <新 JSON 文件>] [--raw-dir <仓库外新目录>]';
const digest = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

interface ProfileOptions { top: number; workers: number; output?: string; rawDir?: string }
interface TestExit { code: number | null; signal: string | null; error?: string }
interface TestInvocation { root: string; reportFile: string; logFile: string; workers: number }
interface FileResult { name: string; startTime?: number; endTime?: number; status?: string; assertionResults?: { status?: string }[] }
interface JsonReport { success: boolean; testResults: FileResult[] }

export function parseProfileOptions(argv: string[]): ProfileOptions | undefined {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return undefined;
  const result: ProfileOptions = { top: 15, workers: 1 };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!['--top', '--workers', '--output', '--raw-dir'].includes(flag) || seen.has(flag)
        || !value || value.startsWith('--')) throw new Error(USAGE);
    seen.add(flag);
    if (flag === '--top' || flag === '--workers') {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(USAGE);
      result[flag === '--top' ? 'top' : 'workers'] = Number(value);
    } else result[flag === '--output' ? 'output' : 'rawDir'] = value;
  }
  return result;
}

function sourceState(root: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const worktreeStatus = git('status', '--porcelain=v1', '-z').split('\0').filter(Boolean);
  return { commit: git('rev-parse', 'HEAD').trim(), dirty: worktreeStatus.length > 0, worktreeStatus };
}

function shardManifests(root: string) {
  const assigned = new Map<string, string>();
  const manifests = [1, 2, 3, 4].map(index => {
    const file = `test/shards/source-${index}.txt`, bytes = readFileSync(join(root, file));
    const tests = bytes.toString('utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    for (const test of tests) {
      if (!/^test\/(?!.*(?:^|\/)\.\.(?:\/|$)).+\.test\.tsx?$/.test(test) || assigned.has(test)) {
        throw new Error(`分片清单包含无效或重复测试路径：${file}`);
      }
      assigned.set(test, file);
    }
    return { file, sha256: digest(bytes), fileCount: tests.length };
  });
  return { manifests, assigned, binding: digest(JSON.stringify(manifests)) };
}

function normalizedFiles(report: JsonReport | undefined, root: string, assigned: Map<string, string>) {
  const results = new Map<string, FileResult>();
  for (const result of report?.testResults ?? []) {
    if (typeof result.name !== 'string') throw new Error('报告缺少测试文件名。');
    const absolute = resolve(root, result.name);
    const file = relative(root, join(realpathSync(dirname(absolute)), basename(absolute))).split(sep).join('/');
    if (!/^test\/.+\.test\.tsx?$/.test(file) || file.split('/').includes('..') || results.has(file)) {
      throw new Error('报告包含仓库外或重复的测试文件。');
    }
    results.set(file, result);
  }
  return [...new Set([...assigned.keys(), ...results.keys()])].sort().map(file => {
    const result = results.get(file);
    const assertions = result?.assertionResults?.map(assertion => assertion.status);
    // Vitest 5 reports an all-skipped file as passed with a zero-length fallback span.
    const status = result?.status === 'failed' || assertions?.includes('failed') ? 'failed'
      : assertions?.includes('pending') ? 'pending'
        : assertions?.length && assertions.every(status => status === 'skipped' || status === 'todo') ? 'skipped'
          : result?.status === 'passed' && assertions?.length && assertions.every(status => ['passed', 'skipped', 'todo'].includes(status ?? '')) ? 'passed' : 'unknown';
    const start = result?.startTime, end = result?.endTime;
    const durationMs = (status === 'passed' || status === 'failed') && typeof start === 'number' && Number.isFinite(start) && start > 0
      && typeof end === 'number' && Number.isFinite(end) && end >= start ? end - start : null;
    return { file, shard: assigned.get(file) ?? null, status, durationMs };
  });
}

/** The wrapper owns isolation and mutation detection; profiling never invokes Vitest directly. */
function runHermeticTests({ root, reportFile, logFile, workers }: TestInvocation): Promise<TestExit> {
  return new Promise(resolvePromise => {
    const log = openSync(logFile, 'wx', 0o600);
    const temporaryRoot = dirname(reportFile);
    const child = spawn(process.execPath, [join(root, 'scripts/ci/test.mjs'), `--maxWorkers=${workers}`,
      '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`], {
      cwd: root, env: { ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot },
      detached: process.platform !== 'win32', stdio: ['inherit', 'pipe', 'pipe'],
    });
    let error: string | undefined;
    let requestedSignal: NodeJS.Signals | undefined;
    const interrupt = (signal: NodeJS.Signals) => {
      requestedSignal = signal;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') error = String(cause); }
    };
    const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
    child.stdout.on('data', (data: Buffer) => { writeSync(log, data); process.stdout.write(data); });
    child.stderr.on('data', (data: Buffer) => { writeSync(log, data); process.stderr.write(data); });
    child.once('error', cause => { error = cause.message; });
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
      closeSync(log); resolvePromise({ code, signal: signal ?? requestedSignal ?? null, ...(error ? { error } : {}) });
    });
  });
}

function assertNewFile(path: string): void {
  realpathSync(dirname(path));
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('输出已存在，profile 不覆盖既有证据。');
}

export async function profileTestRun(options: ProfileOptions, dependencies: {
  root?: string; temporaryParent?: string; runTests?: (invocation: TestInvocation) => Promise<TestExit>;
} = {}) {
  const root = realpathSync(dependencies.root ?? REPO_ROOT);
  const temporaryParent = realpathSync(dependencies.temporaryParent ?? tmpdir());
  const temporaryLocation = relative(root, temporaryParent);
  if (!temporaryLocation.startsWith(`..${sep}`) && temporaryLocation !== '..' && !isAbsolute(temporaryLocation)) throw new Error('运行临时根必须在仓库外。');
  const output = options.output ? resolve(options.output) : undefined;
  if (output) assertNewFile(output);
  const rawDir = options.rawDir ? resolve(options.rawDir) : undefined;
  if (rawDir) {
    assertNewFile(rawDir);
    const parent = realpathSync(dirname(rawDir)), location = relative(root, parent);
    if (!location.startsWith(`..${sep}`) && location !== '..' && !isAbsolute(location)) throw new Error('原始 profile 证据必须保存在仓库外。');
    if (output && output === rawDir) throw new Error('JSON 输出与原始目录不能相同。');
  }
  const source = sourceState(root), shards = shardManifests(root);
  const evidenceDirectory = rawDir ?? mkdtempSync(join(tmpdir(), 'omk-test-profile-evidence-'));
  if (rawDir) mkdirSync(rawDir, { mode: 0o700 });
  const temporaryRoot = mkdtempSync(join(temporaryParent, 'omk-test-profile-run-'));
  const reportFile = join(temporaryRoot, 'vitest.json'), logFile = join(temporaryRoot, 'runner.log');
  const startedAt = new Date().toISOString(), start = performance.now();
  try {
    let exit: TestExit;
    try { exit = await (dependencies.runTests ?? runHermeticTests)({ root, reportFile, logFile, workers: options.workers }); }
    catch (error) { exit = { code: null, signal: null, error: error instanceof Error ? error.message : String(error) }; }
    const wallTimeMs = performance.now() - start, finishedAt = new Date().toISOString();
    // Save before interpreting the report: malformed/missing reports and later failures remain inspectable.
    for (const file of [reportFile, logFile]) if (existsSync(file)) copyFileSync(file, join(evidenceDirectory, file === reportFile ? 'vitest.json' : 'runner.log'));
    writeFileSync(join(evidenceDirectory, 'process.json'), `${JSON.stringify({ exit, startedAt, finishedAt, wallTimeMs }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    let report: JsonReport | undefined, reportIssue: string | null = null;
    try {
      const parsed = JSON.parse(readFileSync(reportFile, 'utf8')) as JsonReport;
      if (typeof parsed.success !== 'boolean' || !Array.isArray(parsed.testResults)) throw new Error();
      report = parsed;
    } catch { reportIssue = existsSync(reportFile) ? 'invalid_report' : 'missing_report'; }
    let files;
    try { files = normalizedFiles(report, root, shards.assigned); }
    catch { reportIssue = 'invalid_report'; files = normalizedFiles(undefined, root, shards.assigned); }
    const sourceAfter = sourceState(root), manifestsAfter = shardManifests(root);
    const sourceMetadataChanged = JSON.stringify(source) !== JSON.stringify(sourceAfter) || shards.binding !== manifestsAfter.binding;
    const complete = reportIssue === null && files.some(file => file.durationMs !== null)
      && files.every(file => (file.status === 'skipped' || file.status === 'passed' && file.durationMs !== null) && file.shard !== null);
    const status = exit.signal ? 'interrupted' : exit.error ? 'unknown' : exit.code !== 0 || report?.success === false
      || files.some(file => file.status === 'failed') ? 'failed' : complete && !sourceMetadataChanged ? 'passed' : 'incomplete';
    const profile = {
      profileVersion: 'omk-test-profile/v1', source, sourceAfter, sourceMetadataChanged,
      environment: { os: platform(), osRelease: release(), architecture: arch(), nodeVersion: process.version, workers: options.workers },
      command: ['node', 'scripts/ci/test.mjs', `--maxWorkers=${options.workers}`, '--reporter=default', '--reporter=json', '--outputFile.json=<temporary>/vitest.json'],
      startedAt, finishedAt, wallTimeMs, status, exit: { code: exit.code, signal: exit.signal, spawnError: exit.error !== undefined }, reportIssue,
      manifestBinding: shards.binding, manifests: shards.manifests, files,
      shards: shards.manifests.map(manifest => {
        const members = files.filter(file => file.shard === manifest.file), measured = members.filter(file => file.durationMs !== null);
        return { manifest: manifest.file, fileCount: members.length, measuredFiles: measured.length,
          unknownDurationFiles: members.length - measured.length, skippedFiles: members.filter(file => file.status === 'skipped').length,
          failedFiles: members.filter(file => file.status === 'failed').length,
          observedFileDurationSumMs: measured.length ? measured.reduce((sum, file) => sum + file.durationMs!, 0) : null };
      }),
      durationMeaning: 'Vitest JSON endTime minus startTime spans assertion execution, excluding transform/import. All-skipped files have no measured duration. Shard sums are local observed assertion-span sums, not CI step/job wall-clock times or optimization benefits.',
      rawEvidence: { report: existsSync(reportFile) ? { file: 'vitest.json', sha256: digest(readFileSync(reportFile)) } : null,
        log: existsSync(logFile) ? { file: 'runner.log', sha256: digest(readFileSync(logFile)) } : null, process: 'process.json' },
    };
    if (output) writeFileSync(output, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { profile, evidenceDirectory };
  } catch (error) {
    if (error instanceof Error) error.message += `\n原始 profile 证据：${evidenceDirectory}`;
    throw error;
  } finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
}

export async function main(argv: string[]): Promise<void> {
  const options = parseProfileOptions(argv);
  if (!options) { console.log(USAGE); return; }
  const { profile, evidenceDirectory } = await profileTestRun(options);
  console.log(`\n[test:profile] 测试包装器墙钟：${(profile.wallTimeMs / 1000).toFixed(2)} 秒；状态：${profile.status}；workers=${options.workers}`);
  const measured = profile.files.filter(file => file.durationMs !== null).sort((a, b) => b.durationMs! - a.durationMs! || a.file.localeCompare(b.file));
  console.log(`[test:profile] 最慢的 ${Math.min(options.top, measured.length)} 个测试文件：`);
  for (const result of measured.slice(0, options.top)) console.log(`  ${(result.durationMs! / 1000).toFixed(2)} 秒  ${result.file}  ${result.status}`);
  console.log(`[test:profile] 原始证据：${evidenceDirectory}`);
  if (profile.status !== 'passed') throw new Error(`Profile 未完整通过：${profile.status}（${profile.reportIssue ?? '查看原始证据'}）。`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
});
