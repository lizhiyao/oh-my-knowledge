import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITEST_ENTRY = resolve(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

interface VitestFileResult {
  name: string;
  startTime: number;
  endTime: number;
}

interface VitestJsonReport {
  success: boolean;
  testResults: VitestFileResult[];
}

export interface SlowTestFile {
  file: string;
  durationMs: number;
}

export function parseTop(argv: string[]): number | undefined {
  if (argv.includes('--help') || argv.includes('-h')) return undefined;
  if (argv.length === 0) return 15;
  if (argv.length !== 2 || argv[0] !== '--top' || !/^[1-9]\d*$/.test(argv[1] ?? '')) {
    throw new Error('用法：yarn test:profile [--top <正整数>]');
  }
  return Number(argv[1]);
}

export function findSlowTestFiles(report: VitestJsonReport, top: number): SlowTestFile[] {
  return report.testResults
    .map((result) => ({
      file: relative(REPO_ROOT, result.name),
      durationMs: Math.max(0, result.endTime - result.startTime),
    }))
    .sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file))
    .slice(0, top);
}

function runVitest(reportFile: string): Promise<number> {
  const start = performance.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      VITEST_ENTRY,
      'run',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${reportFile}`,
    ], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise(performance.now() - start);
      } else {
        reject(new Error(`Vitest 失败（code=${String(code)}，signal=${String(signal)}）。`));
      }
    });
  });
}

export async function main(argv: string[]): Promise<void> {
  const top = parseTop(argv);
  if (top === undefined) {
    console.log('用法：yarn test:profile [--top <正整数>]');
    return;
  }

  const outputDir = mkdtempSync(resolve(tmpdir(), 'omk-test-profile-'));
  const reportFile = resolve(outputDir, 'vitest.json');
  try {
    const wallTimeMs = await runVitest(reportFile);
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as VitestJsonReport;
    if (!report.success) throw new Error('Vitest 报告标记为失败。');

    console.log(`\n[test:profile] 全量测试耗时：${(wallTimeMs / 1000).toFixed(2)} 秒`);
    console.log(`[test:profile] 最慢的 ${Math.min(top, report.testResults.length)} 个测试文件：`);
    for (const result of findSlowTestFiles(report, top)) {
      console.log(`  ${(result.durationMs / 1000).toFixed(2)} 秒  ${result.file}`);
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
