import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, platform, arch } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITEST_ENTRY = resolve(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

export interface ProfileOptions {
  runs: number;
  warmup: number;
  top: number;
  maxWorkers: string;
  outputDir?: string;
  help: boolean;
}

interface VitestAssertionResult {
  duration?: number | null;
}

interface VitestFileResult {
  name: string;
  startTime: number;
  endTime: number;
  assertionResults: VitestAssertionResult[];
}

interface VitestJsonReport {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: VitestFileResult[];
}

export interface SlowFileMeasurement {
  file: string;
  durationMs: number;
  testTimeMs: number;
}

export interface ProfileRun {
  index: number;
  wallTimeMs: number;
  loadAverageBefore: number[];
  loadAverageAfter: number[];
  reportFile: string;
  fileCount: number;
  testCount: number;
  passedTests: number;
  failedTests: number;
  pendingTests: number;
  aggregateTestTimeMs: number;
  slowFiles: SlowFileMeasurement[];
}

interface MetricSummary {
  min: number;
  median: number;
  max: number;
  range: number;
  mean: number;
  coefficientOfVariation: number;
}

export interface ProfileSummary {
  wallTimeMs: MetricSummary;
  aggregateTestTimeMs: MetricSummary;
  slowFiles: Array<{
    file: string;
    medianDurationMs: number;
    medianTestTimeMs: number;
    durationsMs: number[];
  }>;
}

function positiveInteger(raw: string | undefined, option: string, allowZero = false): number {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${option} 需要整数值。`);
  const value = Number(raw);
  if ((!allowZero && value < 1) || (allowZero && value < 0)) {
    throw new Error(`${option} ${allowZero ? '不能小于 0' : '必须大于 0'}。`);
  }
  return value;
}

function workerSetting(raw: string | undefined): string {
  if (raw === undefined) throw new Error('--max-workers 需要整数或百分比。');
  if (/^[1-9]\d*$/.test(raw)) return raw;
  const match = raw.match(/^([1-9]\d?)%$|^(100)%$/);
  if (match) return raw;
  throw new Error('--max-workers 需要正整数或 1%～100%。');
}

export function parseProfileArgs(argv: string[]): ProfileOptions {
  const options: ProfileOptions = {
    runs: 3,
    warmup: 1,
    top: 15,
    maxWorkers: '55%',
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    switch (arg) {
      case '--runs':
        options.runs = positiveInteger(argv[++index], '--runs');
        break;
      case '--warmup':
        options.warmup = positiveInteger(argv[++index], '--warmup', true);
        break;
      case '--top':
        options.top = positiveInteger(argv[++index], '--top');
        break;
      case '--max-workers':
        options.maxWorkers = workerSetting(argv[++index]);
        break;
      case '--output': {
        const value = argv[++index];
        if (!value) throw new Error('--output 需要目录路径。');
        options.outputDir = value;
        break;
      }
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error('median 需要至少一个值。');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function loadPerCpu(loadAverage: number[], parallelism: number): number {
  if (parallelism < 1) throw new Error('parallelism 必须大于 0。');
  return round((loadAverage[0] ?? 0) / parallelism);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summarizeMetric(values: number[]): MetricSummary {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    min: round(min),
    median: round(median(values)),
    max: round(max),
    range: round(max - min),
    mean: round(mean),
    coefficientOfVariation: round(mean === 0 ? 0 : Math.sqrt(variance) / mean),
  };
}

export function summarizeProfile(runs: ProfileRun[], top: number): ProfileSummary {
  if (runs.length === 0) throw new Error('profile summary 需要至少一轮数据。');
  const byFile = new Map<string, { durations: number[]; testTimes: number[] }>();
  for (const run of runs) {
    for (const file of run.slowFiles) {
      const values = byFile.get(file.file) ?? { durations: [], testTimes: [] };
      values.durations.push(file.durationMs);
      values.testTimes.push(file.testTimeMs);
      byFile.set(file.file, values);
    }
  }
  const slowFiles = [...byFile.entries()]
    .map(([file, values]) => ({
      file,
      medianDurationMs: round(median(values.durations)),
      medianTestTimeMs: round(median(values.testTimes)),
      durationsMs: values.durations.map(round),
    }))
    .sort((a, b) => b.medianDurationMs - a.medianDurationMs || a.file.localeCompare(b.file))
    .slice(0, top);
  return {
    wallTimeMs: summarizeMetric(runs.map((run) => run.wallTimeMs)),
    aggregateTestTimeMs: summarizeMetric(runs.map((run) => run.aggregateTestTimeMs)),
    slowFiles,
  };
}

export function extractRun(
  report: VitestJsonReport,
  index: number,
  wallTimeMs: number,
  reportFile: string,
  loadAverageBefore: number[],
  loadAverageAfter: number[],
): ProfileRun {
  const slowFiles = report.testResults.map((file) => ({
    file: relative(REPO_ROOT, file.name),
    durationMs: round(Math.max(0, file.endTime - file.startTime)),
    testTimeMs: round(file.assertionResults.reduce((sum, assertion) => sum + (assertion.duration ?? 0), 0)),
  })).sort((a, b) => b.durationMs - a.durationMs);
  return {
    index,
    wallTimeMs: round(wallTimeMs),
    loadAverageBefore: loadAverageBefore.map(round),
    loadAverageAfter: loadAverageAfter.map(round),
    reportFile: relative(REPO_ROOT, reportFile),
    fileCount: report.testResults.length,
    testCount: report.numTotalTests,
    passedTests: report.numPassedTests,
    failedTests: report.numFailedTests,
    pendingTests: report.numPendingTests,
    aggregateTestTimeMs: round(slowFiles.reduce((sum, file) => sum + file.testTimeMs, 0)),
    slowFiles,
  };
}

function gitInfo(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !== '';
    return { commit, dirty };
  } catch {
    return { commit: 'unknown', dirty: true };
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function runVitest(reportFile: string, maxWorkers: string): Promise<number> {
  const args = [
    VITEST_ENTRY,
    'run',
    '--reporter=json',
    `--outputFile=${reportFile}`,
    `--maxWorkers=${maxWorkers}`,
  ];
  const start = performance.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Vitest 失败（code=${String(code)}，signal=${String(signal)}）。原始报告：${reportFile}`));
        return;
      }
      resolvePromise(performance.now() - start);
    });
  });
}

function usage(): string {
  return [
    '用法：yarn test:profile [options]',
    '',
    '  --runs <n>          测量轮数（默认 3）',
    '  --warmup <n>        预热轮数（默认 1，可为 0）',
    '  --top <n>           汇总最慢文件数量（默认 15）',
    '  --max-workers <n|%> 固定 Vitest worker 上限（默认 55%）',
    '  --output <dir>      输出目录（默认 .omk/test-profiles/<timestamp>）',
  ].join('\n');
}

function readVitestVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'node_modules', 'vitest', 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

export async function main(argv: string[]): Promise<void> {
  const options = parseProfileArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const outputDir = options.outputDir
    ? resolve(REPO_ROOT, options.outputDir)
    : resolve(REPO_ROOT, '.omk', 'test-profiles', timestamp());
  mkdirSync(outputDir, { recursive: true });
  const total = options.warmup + options.runs;
  const measuredRuns: ProfileRun[] = [];
  const initialLoadAverage = loadavg();
  const parallelism = availableParallelism();

  for (let sequence = 1; sequence <= total; sequence++) {
    const warmup = sequence <= options.warmup;
    const label = warmup ? `预热 ${sequence}/${options.warmup}` : `测量 ${sequence - options.warmup}/${options.runs}`;
    const reportFile = resolve(outputDir, `${warmup ? 'warmup' : 'run'}-${warmup ? sequence : sequence - options.warmup}.json`);
    const loadAverageBefore = loadavg();
    console.log(`[test:profile] ${label} 开始（maxWorkers=${options.maxWorkers}）`);
    const wallTimeMs = await runVitest(reportFile, options.maxWorkers);
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as VitestJsonReport;
    if (!report.success) throw new Error(`Vitest 报告标记为失败：${reportFile}`);
    console.log(`[test:profile] ${label} 完成：${(wallTimeMs / 1000).toFixed(2)} 秒`);
    if (!warmup) {
      measuredRuns.push(extractRun(
        report,
        sequence - options.warmup,
        wallTimeMs,
        reportFile,
        loadAverageBefore,
        loadavg(),
      ));
    }
  }

  const summary = summarizeProfile(measuredRuns, options.top);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    git: gitInfo(),
    command: { warmup: options.warmup, runs: options.runs, top: options.top, maxWorkers: options.maxWorkers },
    environment: {
      nodeVersion: process.version,
      vitestVersion: readVitestVersion(),
      platform: platform(),
      arch: arch(),
      availableParallelism: parallelism,
      logicalCpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      initialLoadAverage: initialLoadAverage.map(round),
      initialLoad1mPerCpu: loadPerCpu(initialLoadAverage, parallelism),
      initiallyContended: loadPerCpu(initialLoadAverage, parallelism) >= 1,
    },
    runs: measuredRuns,
    summary,
  };
  const summaryFile = resolve(outputDir, 'summary.json');
  writeFileSync(summaryFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`[test:profile] wall time 中位数：${(summary.wallTimeMs.median / 1000).toFixed(2)} 秒`);
  console.log(`[test:profile] 范围：${(summary.wallTimeMs.min / 1000).toFixed(2)}～${(summary.wallTimeMs.max / 1000).toFixed(2)} 秒，CV=${summary.wallTimeMs.coefficientOfVariation.toFixed(3)}`);
  const initialLoadRatio = loadPerCpu(initialLoadAverage, parallelism);
  console.log(`[test:profile] 启动负载：${initialLoadAverage[0]?.toFixed(2) ?? '0.00'}（每核 ${initialLoadRatio.toFixed(2)}）`);
  if (initialLoadRatio >= 1) {
    console.log('[test:profile] ⚠ 启动时系统已处于高负载；本报告可定位相对慢项，不宜作为绝对耗时基线。');
  }
  console.log('[test:profile] 最慢测试文件（按多轮中位数）：');
  for (const file of summary.slowFiles) {
    console.log(`  ${(file.medianDurationMs / 1000).toFixed(2)} 秒  ${file.file}`);
  }
  console.log(`[test:profile] 完整报告：${relative(REPO_ROOT, summaryFile)}`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
