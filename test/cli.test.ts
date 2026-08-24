import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Artifact, Sample, Task, VariantResult } from '../src/types/index.js';
import { reportFileName } from '../src/eval-core/artifact-file-names.js';
import { aggregateReport } from '../src/eval-core/evaluation-reporting.js';
import EvalCommand from '../src/cli/commands/eval/index.js';
import InstallCommand from '../src/cli/commands/install.js';
import { runCommand } from './helpers/run-command.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const FIXTURES_ROOT = join(__dirname, 'fixtures');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');
const CUSTOM_EXECUTOR = join(FIXTURES_ROOT, 'custom-executor', 'echo-executor.sh');

async function runEvalCommand(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCommand(EvalCommand, args, { cwd: options.cwd, env: options.env });
}

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

const buildProductTreeReport = () => {
  const samples: Sample[] = [
    { sample_id: 's1', prompt: 'task one' },
    { sample_id: 's2', prompt: 'task two' },
  ];
  const artifacts: Artifact[] = [
    {
      name: 'baseline',
      kind: 'baseline',
      source: 'baseline',
      content: null,
      contentHash: 'baseline-hash',
      experimentRole: 'control',
      allowedSkills: [],
    },
    {
      name: 'v1',
      kind: 'skill',
      source: 'inline',
      content: 'skill content',
      contentHash: 'v1-hash',
      experimentRole: 'treatment',
    },
  ];
  const tasks: Task[] = samples.flatMap((sample) => artifacts.map((artifact) => ({
    sample_id: sample.sample_id,
    variant: artifact.name,
    artifact,
    prompt: sample.prompt,
    rubric: null,
    assertions: null,
    dimensions: null,
    artifactContent: artifact.content,
    cwd: null,
    _sample: sample,
  })));
  return aggregateReport({
    runId: 'cli-tree-report',
    variants: ['baseline', 'v1'],
    model: 'test-model',
    judgeModel: 'test-model',
    noJudge: true,
    executorName: 'openai-api',
    samples,
    tasks,
    results: {
      s1: { baseline: variantResult(3), v1: variantResult(4) },
      s2: { baseline: variantResult(4), v1: variantResult(5) },
    },
    totalCostUSD: 0,
    artifacts,
  });
};

async function writeProductTreeReport(reportsDir: string): Promise<string> {
  const report = buildProductTreeReport();
  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, reportFileName(report.id)), JSON.stringify(report, null, 2));
  return report.id;
}

async function runManagedSkillEvalFixture(dir: string, candidatePasses: boolean): Promise<{
  stdout: string;
  stderr: string;
  record: { evidence?: unknown[] };
}> {
  const skillsDir = join(dir, 'skills', 'review');
  await mkdir(skillsDir, { recursive: true });
  await writeFile(join(skillsDir, 'SKILL.md'), [
    '---',
    'name: review',
    'description: e2e promote target fixture',
    '---',
    '# review',
    '',
    'PROMOTE_TARGET_E2E',
  ].join('\n'));

  // 该夹具验证 managed evidence 绑定与提示，不验证统计功效。稳定的全通过/全失败
  // 配对差用 5 条即可得到确定 verdict，避免为每个场景启动 40 个 executor 子进程。
  const samples = Array.from({ length: 5 }, (_, i) => ({
    sample_id: `s${String(i + 1).padStart(2, '0')}`,
    prompt: 'Return the pass token.',
    assertions: [{ type: 'contains', value: 'PASS', weight: 1 }],
  }));
  await writeFile(join(dir, 'samples.json'), JSON.stringify(samples, null, 2));

  const candidateOutput = candidatePasses ? 'PASS' : 'FAIL';
  const baselineOutput = candidatePasses ? 'FAIL' : 'PASS';
  const executor = join(dir, 'executor.mjs');
  await writeFile(executor, [
    'import { readFileSync } from "node:fs";',
    'const req = JSON.parse(readFileSync(0, "utf8"));',
    `const output = req.system.includes("PROMOTE_TARGET_E2E") ? ${JSON.stringify(candidateOutput)} : ${JSON.stringify(baselineOutput)};`,
    'console.log(JSON.stringify({ output }));',
  ].join('\n'));

  await writeFile(join(dir, 'eval.yaml'), [
    'samples: ./samples.json',
    `executor: ${JSON.stringify(`node ${executor}`)}`,
    'noJudge: true',
    'noDiagnostic: true',
    'skipDoctor: true',
    'bootstrap: true',
    'bootstrapSamples: 100',
    'variants:',
    '  - name: baseline',
    '    role: control',
    '    artifact: baseline',
    '    allowedSkills: []',
    '  - name: candidate',
    '    role: treatment',
    '    artifact: ./skills/review',
  ].join('\n'));

  await runCommand(InstallCommand, ['skills/review', '--dest', join(dir, 'dist-skills')], {
    cwd: dir,
    env: { ...process.env, HOME: dir, OMK_SKIP_UPDATE_CHECK: '1' },
  });

  let stdout: string;
  let stderr: string;
  try {
    const result = await runEvalCommand([
      '--config', 'eval.yaml',
      '--output-dir', join(dir, 'reports'),
      '--skip-connectivity',
      '--no-serve',
      '--lang', 'en',
    ], {
      cwd: dir,
      env: { ...process.env, HOME: dir, OMK_SKIP_UPDATE_CHECK: '1' },
    });
    stdout = result.stdout;
    stderr = result.stderr;
    assert.equal(candidatePasses, true, `expected non-PROGRESS eval to exit 1:\n${stderr}`);
  } catch (err) {
    const e = err as ExecError;
    assert.equal(candidatePasses, false, e.stderr);
    assert.equal(e.code, 1, e.stderr);
    stdout = e.stdout;
    stderr = e.stderr;
  }

  const managedDir = join(dir, '.omk', 'managed');
  const managedFiles = (await readdir(managedDir)).filter((file) => file.endsWith('.json'));
  assert.equal(managedFiles.length, 1, `expected one managed record, got ${managedFiles.join(', ')}`);
  const record = JSON.parse(await readFile(join(managedDir, managedFiles[0]), 'utf8')) as { evidence?: unknown[] };
  return { stdout, stderr, record };
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

  it('second-level --help routes to subcommand usage', async () => {
    const gold = await execFileAsync('node', [CLI, 'eval', 'gold', '--help']);
    assert.ok(gold.stdout.includes('omk eval gold'));
    assert.ok(!gold.stdout.includes('omk eval --control'));
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

  it('sample openai-api 缺 key 时给出认证和切换提示', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-sample-auth-hint-'));
    try {
      const skillDir = join(dir, 'skills', 'triage');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), [
        '---',
        'name: triage',
        'description: 判断用户问题优先级并给出处理建议',
        '---',
        '',
        '# Triage',
        '',
        '把用户问题分为 P0、P1、P2，并给出下一步处理建议。',
      ].join('\n'));

      await assert.rejects(
        () => execFileAsync('node', [
          CLI, 'sample', 'skills/triage',
          '--executor', 'openai-api',
          '--model', 'gpt-4o-mini',
          '--count', '1',
          '--lang', 'zh',
        ], { cwd: dir, env: { ...process.env, OPENAI_API_KEY: '', CODEX_HOME: join(dir, '.codex-empty') } }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('OPENAI_API_KEY environment variable is not set'), e.stderr);
          assert.ok(e.stderr.includes('OPENAI_API_KEY / OPENAI_BASE_URL'), e.stderr);
          assert.ok(e.stderr.includes('--executor claude --model sonnet'), e.stderr);
          assert.ok(e.stderr.includes('--executor codex --model <codex-model>'), e.stderr);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sample --batch 生成失败时不误报为无需生成', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-sample-batch-fail-'));
    try {
      const skillDir = join(dir, 'skills', 'triage');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), [
        '---',
        'name: triage',
        'description: 判断用户问题优先级',
        '---',
        '',
        '# Triage',
        '',
        '把用户问题分为 P0、P1、P2。',
      ].join('\n'));

      await assert.rejects(
        () => execFileAsync('node', [
          CLI, 'sample', '--batch',
          '--skill-dir', 'skills',
          '--executor', 'openai-api',
          '--model', 'gpt-4o-mini',
          '--count', '1',
          '--lang', 'zh',
        ], { cwd: dir, env: { ...process.env, OPENAI_API_KEY: '', CODEX_HOME: join(dir, '.codex-empty') } }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('OPENAI_API_KEY / OPENAI_BASE_URL'), e.stderr);
          assert.ok(e.stderr.includes('生成未完成：已生成 0 份，失败 1 份'), e.stderr);
          assert.ok(!e.stdout.includes('没有需要生成的 eval-samples'), e.stdout);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('evolve 自动生成 openai-api 缺 key 时给出认证和切换提示', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-evolve-auth-hint-'));
    try {
      const skillDir = join(dir, 'skills', 'triage');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), [
        '---',
        'name: triage',
        'description: 判断用户问题优先级并给出处理建议',
        '---',
        '',
        '# Triage',
        '',
        '把用户问题分为 P0、P1、P2，并给出下一步处理建议。',
      ].join('\n'));

      await assert.rejects(
        () => execFileAsync('node', [
          CLI, 'evolve', 'skills/triage',
          '--executor', 'openai-api',
          '--model', 'gpt-4o-mini',
          '--judge-models', 'openai-api:gpt-4o-mini',
          '--rounds', '1',
          '--skip-doctor',
          '--skip-connectivity',
          '--lang', 'zh',
        ], { cwd: dir, env: { ...process.env, OPENAI_API_KEY: '', CODEX_HOME: join(dir, '.codex-empty') } }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('未发现评测用例，正在自动生成到'), e.stderr);
          assert.ok(e.stderr.includes('OPENAI_API_KEY environment variable is not set'), e.stderr);
          assert.ok(e.stderr.includes('OPENAI_API_KEY / OPENAI_BASE_URL'), e.stderr);
          assert.ok(e.stderr.includes('--executor claude --model sonnet'), e.stderr);
          assert.ok(e.stderr.includes('--executor codex --model <codex-model>'), e.stderr);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    const samplesPath = join(FIXTURES_ROOT, 'code-review', 'eval-samples.json');
    const skillDir = join(FIXTURES_ROOT, 'code-review', 'skills');
    const { stdout, stderr } = await runEvalCommand([
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
    assert.ok(stdout.includes('去掉 --dry-run 运行正式评测'));
    assert.ok(stderr.includes('只能识别很大的效果'));
    assert.ok(!stderr.includes('exploration-only'));
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
    const skillDir = join(FIXTURES_ROOT, 'multi-skills', 'skills');
    await runEvalCommand([
      '--batch',
      '--dry-run',
      '--skill-dir', skillDir,
    ]);
  });

  it('eval non-dry-run persists a report, prints export hint, and exits by verdict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-eval-'));
    try {
      await assert.rejects(
        () => runEvalCommand([
          '--samples', join(FIXTURES_ROOT, 'custom-executor', 'eval-samples.json'),
          '--skill-dir', join(FIXTURES_ROOT, 'custom-executor', 'skills'),
          '--control', 'baseline',
          '--treatment', 'v1',
          '--executor', CUSTOM_EXECUTOR,
          '--no-judge',
          '--output-dir', join(dir, 'reports'),
          '--skip-connectivity',
          '--bootstrap-samples', '100',
        ], {
          env: { ...process.env, HOME: dir },
        }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          // 非 TTY:verdict 文案走 stderr,stdout 留作纯 report JSON。verdict 随 lang 本地化(判定：/ Verdict:)。
          assert.ok(/判定：|Verdict:/.test(e.stderr), e.stderr);
          assert.ok(/下一步：|Next:/.test(e.stderr), e.stderr);
          const parsed = JSON.parse(e.stdout) as { kind?: unknown };
          assert.ok(typeof parsed.kind === 'string', `stdout 应为纯 report JSON:\n${e.stdout.slice(0, 200)}`);
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
      const { stdout, stderr } = await runEvalCommand([
        '--samples', join(FIXTURES_ROOT, 'custom-executor', 'eval-samples.json'),
        '--skill-dir', join(FIXTURES_ROOT, 'custom-executor', 'skills'),
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
      });
      // 回归(reviewer #290):非 TTY 下 stdout 必须是纯 report JSON,`omk eval | jq` 能直接消费;
      // verdict 文案走 stderr,不再拼到 stdout 末尾把 JSON.parse 噎死。
      const parsed = JSON.parse(stdout) as { kind?: unknown };
      assert.ok(typeof parsed.kind === 'string', `stdout 应为纯 report JSON:\n${stdout.slice(0, 200)}`);
      assert.ok(/判定：|Verdict:/.test(stderr), stderr);
      assert.ok(/下一步：|Next:/.test(stderr), stderr);
      assert.ok(stderr.includes('report-only'), stderr);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval config alias promotes the managed skill NAME, not the treatment label', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-promote-target-'));
    try {
      const { stdout, stderr, record } = await runManagedSkillEvalFixture(dir, true);

      assert.equal((JSON.parse(stdout) as { kind?: unknown }).kind, 'evaluation', `stdout 应为 report JSON:\n${stdout.slice(0, 200)}`);
      assert.match(stderr, /Verdict: PROGRESS/, stderr);
      assert.ok(stderr.includes('omk promote review'), stderr);
      assert.ok(!stderr.includes('omk promote candidate'), stderr);
      assert.ok(stderr.includes('Recorded eval evidence for managed skill "review" → measurable. Run omk promote review to accept this version.'), stderr);
      assert.equal(record.evidence?.length, 1, 'eval should append evidence to the managed review record');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval does not suggest default promote for non-PROGRESS managed evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-promote-target-'));
    try {
      const { stdout, stderr, record } = await runManagedSkillEvalFixture(dir, false);

      assert.equal((JSON.parse(stdout) as { kind?: unknown }).kind, 'evaluation', `stdout 应为 report JSON:\n${stdout.slice(0, 200)}`);
      assert.match(stderr, /Verdict: (REGRESS|CAUTIOUS|NOISE|UNDERPOWERED)/, stderr);
      assert.ok(stderr.includes('Recorded eval evidence for managed skill "review" → measurable'), stderr);
      assert.ok(!stderr.includes('Run omk promote review to accept this version.'), stderr);
      assert.equal(record.evidence?.length, 1, 'eval should still append non-PROGRESS evidence to the managed review record');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval --batch non-dry-run emits aggregate verdict and gates exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-batch-'));
    try {
      await assert.rejects(
        () => runEvalCommand([
          '--batch',
          '--skill-dir', join(FIXTURES_ROOT, 'multi-skills', 'skills'),
          '--executor', CUSTOM_EXECUTOR,
          '--no-judge',
          '--output-dir', join(dir, 'reports'),
          '--skip-connectivity',
          '--bootstrap-samples', '100',
        ], {
          env: { ...process.env, HOME: dir },
        }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          // 非 TTY:批量结论文案走 stderr,stdout 留作纯 batch report JSON(machine 消费)。
          const parsed = JSON.parse(e.stdout) as { kind?: unknown };
          assert.ok(typeof parsed.kind === 'string', `stdout 应为纯 batch report JSON:\n${e.stdout.slice(0, 200)}`);
          assert.ok(e.stderr.includes('批量评测结论：未通过'), e.stderr);
          assert.ok(e.stderr.includes('下一步：先处理未通过的 skill'), e.stderr);
          assert.ok(!e.stderr.includes('Batch verdict:'), e.stderr);
          assert.ok(e.stderr.includes('UNDERPOWERED:'), e.stderr);
          assert.ok(e.stderr.includes('omk studio'), e.stderr);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});
