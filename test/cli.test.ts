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
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');
const CUSTOM_EXECUTOR = join(PROJECT_ROOT, 'examples', 'custom-executor', 'echo-executor.sh');
const DOCTOR_FIXTURE = `node ${join(PROJECT_ROOT, 'test', 'fixtures', 'doctor-fixture-executor.mjs')}`;

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
    // omk --help 走 oclif,COMMANDS / TOPICS 列出 7 个产品命令。
    const { stdout } = await execFileAsync('node', [CLI, '--help']);
    assert.ok(stdout.includes('oh-my-knowledge'));
    assert.ok(/COMMANDS|TOPICS/i.test(stdout), 'should have oclif COMMANDS / TOPICS block');
    assert.ok(stdout.includes('doctor'));
    assert.ok(stdout.includes('eval'));
    assert.ok(stdout.includes('observe'));
    assert.ok(stdout.includes('evolve'));
    assert.ok(stdout.includes('sample'));
    assert.ok(stdout.includes('studio'));
    assert.ok(!stdout.includes('export '));
    assert.ok(!stdout.includes('improve '));
    assert.ok(!stdout.includes('bench '));
  });

  it('eval --help shows workflow usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--help']);
    assert.ok(stdout.includes('\nUSAGE\n'), 'should have oclif USAGE block');
    assert.ok(stdout.includes('--batch'));
    assert.ok(stdout.includes('--report-only'));
    assert.ok(stdout.includes('--no-gate'));
  });

  it('init --help shows scaffold-specific usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'init', '--help']);
    assert.ok(stdout.includes('\nUSAGE\n'), 'should have oclif USAGE block');
    assert.ok(stdout.includes('init'));
    assert.ok(/TARGETDIR/i.test(stdout), 'should show TARGETDIR positional');
  });

  it('second-level --help routes to subcommand usage', async () => {
    const gold = await execFileAsync('node', [CLI, 'eval', 'gold', '--help']);
    assert.ok(gold.stdout.includes('omk eval gold'));
    assert.ok(!gold.stdout.includes('omk eval --control'));
  });

  it('observe --help shows session observation usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', '--help']);
    assert.ok(stdout.includes('omk observe'));
    assert.ok(stdout.includes('--last'));
  });

  it('evolve --help shows skill auto-iteration usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'evolve', '--help']);
    assert.ok(stdout.includes('omk evolve'));
    assert.ok(stdout.includes('--rounds'));
    assert.ok(stdout.includes('--target'));
  });

  it('sample --help shows test-case generation usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'sample', '--help']);
    assert.ok(stdout.includes('omk sample'));
    assert.ok(stdout.includes('--batch'));
  });

  // 回归: parser 必须用 positionals 取 skill path,不能扫 argv 的非 -- 项
  // (否则 `omk sample --count 3 path.md` 会把 "3" 当 skill path)。
  it('sample 把 flag value 跟 skill 路径区分开', async () => {
    const fakePath = join(tmpdir(), 'omk-sample-flag-test-no-such-skill.md');
    await assert.rejects(
      () => execFileAsync('node', [
        CLI, 'sample',
        '--count', '3',
        '--model', 'sonnet',
        fakePath,
        '--lang', 'zh',
      ]),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 1);
        assert.ok(
          e.stderr.includes(fakePath),
          `error 应当指向真正的 skill 路径 ${fakePath}，得到: ${e.stderr.slice(0, 300)}`,
        );
        assert.ok(
          !/未找到 skill 文件: 3/.test(e.stderr) && !/未找到 skill 文件: sonnet/.test(e.stderr),
          `flag value 不应被当成 skill 路径: ${e.stderr.slice(0, 300)}`,
        );
        return true;
      },
    );
  });

  it('studio --help shows local workbench usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'studio', '--help']);
    assert.ok(stdout.includes('omk studio'));
    assert.ok(stdout.includes('--reports-dir'));
    assert.ok(stdout.includes('--analyses-dir'));
    assert.ok(stdout.includes('--no-open'));
  });

  // dispatcher 检查 --help 时扫整个 argv,不限第一位。
  // 之前 gate 只查 argv[0] === '--help', 中间位置的 --help 会被 parseArgs 拒。
  it('eval --skip-connectivity --help triggers help from any position', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--skip-connectivity', '--help']);
    assert.ok(stdout.includes('omk eval'));
  });

  it('unknown command exits 1 with command-not-found message', async () => {
    // oclif 的 unknown command 信号是 stderr 含 "not found"。
    // exit 1（package.json oclif.exitCodes.default=1）。
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'unknown-domain-xyz']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 1);
        assert.ok(/not found|未知命令/i.test(e.stderr), `stderr should signal command not found: ${e.stderr}`);
        return true;
      },
    );
  });

  it('old bench namespace is not exposed', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'bench', '--help']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 1);
        assert.ok(/not found|未知命令/i.test(e.stderr));
        return true;
      },
    );
  });

  it('old analyze entrypoint is not exposed', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'analyze', '--help']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 1);
        assert.ok(/not found|未知命令/i.test(e.stderr));
        return true;
      },
    );
  });

  it('eval --dry-run exits 0 through eval workflow', async () => {
    const samplesPath = join(PROJECT_ROOT, 'examples', 'code-review', 'eval-samples.json');
    const skillDir = join(PROJECT_ROOT, 'examples', 'code-review', 'skills');
    const { stdout, stderr } = await execFileAsync('node', [
      CLI, 'eval',
      '--dry-run',
      '--samples', samplesPath,
      '--skill-dir', skillDir,
      '--control', 'v1',
      '--treatment', 'v2',
      '--lang', 'zh',
    ]);
    assert.ok(stdout.includes('eval dry-run'));
    assert.ok(stderr.includes('只能识别很大的效果'));
    assert.ok(!stderr.includes('exploration-only'));
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
      '--no-debias-length',
      '--threshold', '3.2',
      '--trivial-diff', '0.2',
      '--no-gate',
      '--lang', 'zh',
    ]);
    assert.ok(stdout.includes('eval dry-run'));
  });

  it('Claude Code SKILL manifest uses current product commands', async () => {
    const body = await readFile(join(PROJECT_ROOT, '.agents', 'skills', 'omk', 'SKILL.md'), 'utf8');
    assert.ok(body.includes('argument-hint: "<doctor|eval|evolve|init|install|list|observe|promote|rollback|sample|studio> [options]"'));
    assert.ok(body.includes('omk eval --batch'));
    assert.ok(body.includes('omk sample --batch'));
    assert.ok(body.includes('omk evolve'));
    assert.ok(body.includes('omk studio'));
    assert.ok(!body.includes('omk bench'));
    assert.ok(!body.includes('omk improve'));
    assert.ok(!body.includes('--each'));
  });

  it('init initializes an omk project from top-level command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-init-'));
    try {
      const { stdout } = await execFileAsync('node', [CLI, 'init', dir]);
      assert.ok(stdout.includes('已初始化 omk 项目'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('doctor auto-detects cwd eval-samples.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-doctor-samples-'));
    try {
      const skillDir = join(dir, 'skills', 'review');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '你是一个测试用的代码审查 skill，内容足够长。');
      await writeFile(join(dir, 'eval-samples.json'), JSON.stringify([
        { sample_id: 's1', prompt: 'review this code' },
      ]));

      const { stderr } = await execFileAsync('node', [CLI, 'doctor', '--executor', DOCTOR_FIXTURE], { cwd: dir });
      assert.ok(stderr.includes('使用评测用例文件'), stderr);
      assert.ok(!stderr.includes('未提供 samples'), stderr);
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
          assert.ok(e.stderr.includes('omk studio'), e.stderr);
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
          assert.ok(e.stderr.includes('omk studio'), e.stderr);
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

});
