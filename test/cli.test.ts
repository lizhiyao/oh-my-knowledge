import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Report, VariantResult, VariantSummary } from '../src/types/index.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CLI = join(PROJECT_ROOT, 'dist', 'src', 'cli', 'index.js');
const CUSTOM_EXECUTOR = join(PROJECT_ROOT, 'examples', 'custom-executor', 'echo-executor.sh');

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}

const variantResult = (score: number): VariantResult => ({
  ok: true,
  durationMs: 0,
  durationApiMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  execCostUSD: 0,
  judgeCostUSD: 0,
  costUSD: 0,
  numTurns: 1,
  compositeScore: score,
  llmScore: score,
  layeredScores: { factScore: score, behaviorScore: score, judgeScore: score },
  outputPreview: null,
});

const variantSummary = (score: number): VariantSummary => ({
  totalSamples: 30,
  successCount: 30,
  errorCount: 0,
  errorRate: 0,
  avgDurationMs: 0,
  avgInputTokens: 0,
  avgOutputTokens: 0,
  avgTotalTokens: 0,
  totalCostUSD: 0,
  totalExecCostUSD: 0,
  totalJudgeCostUSD: 0,
  avgCostPerSample: 0,
  avgNumTurns: 1,
  avgFactScore: score,
  avgBehaviorScore: score,
  avgJudgeScore: score,
  avgCompositeScore: score,
});

const buildProductTreeReport = (): Report => ({
  kind: 'evaluation',
  id: 'cli-tree-report',
  meta: {
    variants: ['baseline', 'v1'],
    model: 'sonnet',
    judgeModels: [{ executor: 'claude', model: 'haiku' }],
    executor: 'claude',
    sampleCount: 30,
    taskCount: 60,
    totalCostUSD: 0,
    timestamp: '2026-05-05T00:00:00.000Z',
    cliVersion: 'test',
    nodeVersion: process.version,
    artifactHashes: { baseline: 'baseline-hash', v1: 'v1-hash' },
    evaluationFramework: 'bootstrap',
    pairComparisons: [{
      control: 'baseline',
      treatment: 'v1',
      diffBootstrapCI: { estimate: 0.4, low: 0.2, high: 0.6, samples: 1000, significant: true },
    }],
  },
  summary: {
    baseline: variantSummary(3.8),
    v1: variantSummary(4.2),
  },
  results: [
    {
      sample_id: 's1',
      variants: { baseline: variantResult(3), v1: variantResult(4) },
    },
    {
      sample_id: 's2',
      variants: { baseline: variantResult(4), v1: variantResult(5) },
    },
  ],
  variance: {
    runs: 2,
    perVariant: {
      baseline: { scores: [3.7, 3.9], mean: 3.8, lower: 3.7, upper: 3.9, stddev: 0.1 },
      v1: { scores: [4.1, 4.3], mean: 4.2, lower: 4.1, upper: 4.3, stddev: 0.1 },
    },
    comparisons: [],
    saturation: {
      checkpointSampleCounts: [30, 60],
      perVariant: {
        baseline: [
          { n: 30, mean: 3.8, ciLow: 3.7, ciHigh: 3.9 },
          { n: 60, mean: 3.8, ciLow: 3.75, ciHigh: 3.85 },
        ],
        v1: [
          { n: 30, mean: 4.2, ciLow: 4.1, ciHigh: 4.3 },
          { n: 60, mean: 4.2, ciLow: 4.15, ciHigh: 4.25 },
        ],
      },
      verdicts: {
        v1: {
          saturated: true,
          atN: 60,
          confidence: 'medium',
          method: 'bootstrap-ci-width',
          threshold: 0.05,
          reason: 'test fixture',
        },
      },
    },
  },
});

async function writeProductTreeReport(reportsDir: string): Promise<string> {
  const report = buildProductTreeReport();
  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, `${report.id}.json`), JSON.stringify(report, null, 2));
  return report.id;
}

describe('CLI', () => {
  it('--help shows usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, '--help']);
    assert.ok(stdout.includes('oh-my-knowledge'));
    assert.ok(stdout.includes('omk doctor'));
    assert.ok(stdout.includes('omk eval'));
    assert.ok(stdout.includes('omk observe'));
    assert.ok(stdout.includes('omk improve'));
    assert.ok(stdout.includes('omk export'));
    assert.ok(stdout.includes('omk studio'));
    assert.ok(!stdout.includes(['omk', 'bench', 'run'].join(' ')));
  });

  it('eval --help shows workflow usage without parsing run config', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--help']);
    assert.ok(stdout.includes('omk eval'));
    assert.ok(stdout.includes('--batch'));
    assert.ok(stdout.includes('--report-only'));
    assert.ok(stdout.includes('--no-gate'));
    assert.ok(stdout.includes('omk eval gold'));
    assert.ok(stdout.includes('omk eval debias'));
    assert.ok(!stdout.includes(['--', 'each'].join('')));
  });

  it('second-level --help routes to subcommand usage', async () => {
    const gold = await execFileAsync('node', [CLI, 'eval', 'gold', '--help']);
    assert.ok(gold.stdout.includes('omk eval gold'));
    assert.ok(!gold.stdout.includes('omk eval --control'));

    const failures = await execFileAsync('node', [CLI, 'improve', 'failures', '--help']);
    assert.ok(failures.stdout.includes('omk improve failures'));
    assert.ok(!failures.stdout.includes('omk improve samples'));

    const diff = await execFileAsync('node', [CLI, 'export', 'diff', '--help', '--lang', 'en']);
    assert.ok(diff.stdout.includes('omk export diff'));
    assert.ok(!diff.stdout.includes('github-summary'));
  });

  it('observe --help shows session observation usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', '--help']);
    assert.ok(stdout.includes('omk observe'));
    assert.ok(stdout.includes('--last'));
  });

  it('improve --help shows improvement workflow usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'improve', '--help']);
    assert.ok(stdout.includes('omk improve'));
    assert.ok(stdout.includes('samples'));
    assert.ok(stdout.includes('failures'));
  });

  it('export --help shows evidence export usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'export', '--help']);
    assert.ok(stdout.includes('omk export'));
    assert.ok(stdout.includes('github-summary'));
    assert.ok(stdout.includes('omk export diff'));
    assert.ok(stdout.includes('omk export verdict'));
    assert.ok(stdout.includes('omk export saturation'));
    assert.ok(!stdout.includes('omk export serve'));
  });

  it('studio --help shows local workbench usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'studio', '--help']);
    assert.ok(stdout.includes('omk studio'));
    assert.ok(stdout.includes('--reports-dir'));
    assert.ok(stdout.includes('--analyses-dir'));
  });

  // dispatcher 检查 --help 时扫整个 argv,不限第一位。
  // 之前 gate 只查 argv[0] === '--help', 中间位置的 --help 会被 parseArgs 拒。
  it('eval --skip-connectivity --help triggers help from any position', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--skip-connectivity', '--help']);
    assert.ok(stdout.includes('omk eval'));
  });

  it('unknown domain exits with error (--lang en)', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'unknown', '--lang', 'en']),
      (err: unknown) => {
        assert.ok((err as { stderr: string }).stderr.includes('Unknown command'));
        return true;
      },
    );
  });

  it('unknown domain in zh (default) prints 中文', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'unknown']),
      (err: unknown) => {
        assert.ok((err as { stderr: string }).stderr.includes('未知命令'));
        return true;
      },
    );
  });

  it('old bench namespace is not exposed', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'bench', '--help']),
      (err: unknown) => {
        assert.ok((err as { stderr: string }).stderr.includes('未知命令'));
        return true;
      },
    );
  });

  it('old analyze entrypoint is not exposed', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'analyze', '--help']),
      (err: unknown) => {
        assert.ok((err as { stderr: string }).stderr.includes('未知命令'));
        return true;
      },
    );
  });

  it('eval --dry-run exits 0 through eval workflow', async () => {
    const samplesPath = join(PROJECT_ROOT, 'examples', 'code-review', 'eval-samples.json');
    const skillDir = join(PROJECT_ROOT, 'examples', 'code-review', 'skills');
    const { stdout } = await execFileAsync('node', [
      CLI, 'eval',
      '--dry-run',
      '--samples', samplesPath,
      '--skill-dir', skillDir,
      '--control', 'v1',
      '--treatment', 'v2',
    ]);
    assert.ok(stdout.includes('Eval dry-run'));
  });

  it('eval dry-run accepts product workflow options on the unified runner', async () => {
    const samplesPath = join(PROJECT_ROOT, 'examples', 'code-review', 'eval-samples.json');
    const skillDir = join(PROJECT_ROOT, 'examples', 'code-review', 'skills');
    const { stdout } = await execFileAsync('node', [
      CLI, 'eval',
      '--dry-run',
      '--samples', samplesPath,
      '--skill-dir', skillDir,
      '--control', 'v1',
      '--treatment', 'v2',
      '--repeat', '2',
      '--blind',
      '--no-debias-length',
      '--threshold', '3.2',
      '--trivial-diff', '0.2',
      '--no-gate',
    ]);
    assert.ok(stdout.includes('Eval dry-run'));
  });

  it('Claude Code SKILL manifest uses current product commands', async () => {
    const body = await readFile(join(PROJECT_ROOT, 'SKILL.md'), 'utf8');
    assert.ok(body.includes('argument-hint: "<init|doctor|eval|observe|improve|export|studio> [options]"'));
    assert.ok(body.includes('omk eval --batch'));
    assert.ok(body.includes('omk improve samples --batch'));
    assert.ok(body.includes('omk studio'));
    assert.ok(!body.includes('omk bench'));
    assert.ok(!body.includes('--each'));
    assert.ok(!body.includes('gen-samples'));
  });

  it('init scaffolds eval project from top-level command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-init-'));
    try {
      const { stdout } = await execFileAsync('node', [CLI, 'init', dir]);
      assert.ok(stdout.includes('已初始化测评项目'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval gold init and validate are available under the eval workflow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-gold-'));
    try {
      const goldDir = join(dir, 'gold-dataset');
      const init = await execFileAsync('node', [CLI, 'eval', 'gold', 'init', '--out', goldDir, '--annotator', 'human-team']);
      assert.ok(init.stdout.includes('metadata.yaml'));

      const validate = await execFileAsync('node', [CLI, 'eval', 'gold', 'validate', goldDir]);
      assert.ok(validate.stdout.includes('gold dataset OK'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval gold compare reads reports through the eval workflow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-gold-compare-'));
    try {
      const reportsDir = join(dir, 'reports');
      const goldDir = join(dir, 'gold');
      const reportId = await writeProductTreeReport(reportsDir);
      await mkdir(goldDir, { recursive: true });
      await writeFile(join(goldDir, 'metadata.yaml'), [
        'metadata:',
        '  annotator: human-team',
        '  annotatedAt: "2026-05-05"',
        '  version: "1"',
      ].join('\n'));
      await writeFile(join(goldDir, 'annotations.yaml'), [
        'annotations:',
        '  - sample_id: s1',
        '    score: 4',
        '  - sample_id: s2',
        '    score: 5',
      ].join('\n'));

      const { stdout } = await execFileAsync('node', [
        CLI, 'eval', 'gold', 'compare', reportId,
        '--gold-dir', goldDir,
        '--reports-dir', reportsDir,
        '--variant', 'v1',
        '--bootstrap-samples', '100',
      ]);
      assert.ok(stdout.includes('Krippendorff'), stdout);
      assert.ok(stdout.includes('human-team'), stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval --batch --dry-run exits 0', async () => {
    const skillDir = join(PROJECT_ROOT, 'examples', 'multi-skills', 'skills');
    await execFileAsync('node', [
      CLI, 'eval',
      '--batch',
      '--dry-run',
      '--skill-dir', skillDir,
    ]);
  });

  it('eval non-dry-run persists a report, prints export hint, and exits by verdict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-eval-'));
    try {
      await assert.rejects(
        () => execFileAsync('node', [
          CLI, 'eval',
          '--samples', join(PROJECT_ROOT, 'examples', 'custom-executor', 'eval-samples.json'),
          '--skill-dir', join(PROJECT_ROOT, 'examples', 'custom-executor', 'skills'),
          '--control', 'baseline',
          '--treatment', 'v1',
          '--executor', CUSTOM_EXECUTOR,
          '--no-judge',
          '--output-dir', join(dir, 'reports'),
          '--skip-connectivity',
          '--bootstrap-samples', '100',
        ], {
          env: { ...process.env, HOME: dir },
          maxBuffer: 2 * 1024 * 1024,
        }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stdout.includes('Verdict:'), e.stdout);
          assert.ok(e.stderr.includes('omk export '), e.stderr);
          assert.ok(e.stderr.includes(`--reports-dir ${join(dir, 'reports')}`), e.stderr);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval --report-only persists report and bypasses verdict exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-report-only-'));
    try {
      const { stdout, stderr } = await execFileAsync('node', [
        CLI, 'eval',
        '--samples', join(PROJECT_ROOT, 'examples', 'custom-executor', 'eval-samples.json'),
        '--skill-dir', join(PROJECT_ROOT, 'examples', 'custom-executor', 'skills'),
        '--control', 'baseline',
        '--treatment', 'v1',
        '--executor', CUSTOM_EXECUTOR,
        '--no-judge',
        '--output-dir', join(dir, 'reports'),
        '--skip-connectivity',
        '--bootstrap-samples', '100',
        '--report-only',
      ], {
        env: { ...process.env, HOME: dir },
        maxBuffer: 2 * 1024 * 1024,
      });
      assert.ok(stdout.includes('Verdict:'), stdout);
      assert.ok(stderr.includes('report-only'), stderr);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval --batch non-dry-run emits aggregate verdict and gates exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-batch-'));
    try {
      await assert.rejects(
        () => execFileAsync('node', [
          CLI, 'eval',
          '--batch',
          '--skill-dir', join(PROJECT_ROOT, 'examples', 'multi-skills', 'skills'),
          '--executor', CUSTOM_EXECUTOR,
          '--no-judge',
          '--output-dir', join(dir, 'reports'),
          '--skip-connectivity',
          '--bootstrap-samples', '100',
        ], {
          env: { ...process.env, HOME: dir },
          maxBuffer: 2 * 1024 * 1024,
        }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stdout.includes('批量评测结论：未通过'), e.stdout);
          assert.ok(!e.stdout.includes('Batch verdict:'), e.stdout);
          assert.ok(e.stdout.includes('UNDERPOWERED:'), e.stdout);
          assert.ok(e.stderr.includes('omk export '), e.stderr);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // 回归: eval runner 的 try/catch 不能吞 CliExit(0)。dry-run / PROGRESS / SOLO PASS
  // 路径都在 try 内 throw CliExit(0),catch 必须 instanceof 守卫透传,
  // 否则 `omk eval && deploy` 在 PASS 时也会挡住部署。
  it('eval --dry-run keeps CliExit(0) passing through catch', async () => {
    const samplesPath = join(PROJECT_ROOT, 'examples', 'code-review', 'eval-samples.json');
    const skillDir = join(PROJECT_ROOT, 'examples', 'code-review', 'skills');
    // execFile 默认 reject on non-zero exit; resolve = exit 0.
    await execFileAsync('node', [
      CLI, 'eval',
      '--dry-run',
      '--samples', samplesPath,
      '--skill-dir', skillDir,
      '--control', 'v1',
      '--treatment', 'v2',
    ]);
  });

  it('export product subtree keeps diff, verdict, and saturation capabilities', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-export-tree-'));
    try {
      const reportsDir = join(dir, 'reports');
      const reportId = await writeProductTreeReport(reportsDir);

      const diff = await execFileAsync('node', [
        CLI, 'export', 'diff',
        '--reports-dir', reportsDir,
        '--regressions-only',
        reportId,
      ]);
      assert.ok(diff.stdout.includes('Sample-level diff'), diff.stdout);

      const verdict = await execFileAsync('node', [
        CLI, 'export', 'verdict', reportId,
        '--reports-dir', reportsDir,
      ]);
      assert.ok(verdict.stdout.includes('Verdict: PROGRESS'), verdict.stdout);

      const saturation = await execFileAsync('node', [
        CLI, 'export', 'saturation', reportId,
        '--reports-dir', reportsDir,
        '--variant', 'v1',
      ]);
      assert.ok(saturation.stdout.includes('Saturation'), saturation.stdout);
      assert.ok(saturation.stdout.includes('saturated@N=60'), saturation.stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
