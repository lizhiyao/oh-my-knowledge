import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Artifact, Sample, Task, VariantResult } from '../src/types/index.js';
import { reportFileName } from '../src/eval-core/artifact-file-names.js';
import { aggregateReport } from '../src/eval-core/evaluation-reporting.js';
import EvalCommand from '../src/cli/commands/eval/index.js';
import EvalGoldCompare from '../src/cli/commands/eval/gold/compare.js';
import EvolveCommand from '../src/cli/commands/evolve.js';
import InstallCommand from '../src/cli/commands/install.js';
import SampleCommand from '../src/cli/commands/sample.js';
import { runCommand } from './helpers/run-command.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const FIXTURES_ROOT = join(__dirname, 'fixtures');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');
const CUSTOM_EXECUTOR = join(FIXTURES_ROOT, 'custom-executor', 'core-fixture-executor.sh');

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

  // 该夹具只验证 Core evidence 的内容身份绑定。自定义命令的身份覆盖并不完整，因此它生成的
  // evidence 必须保持非 decision-ready，不能伪装成可发布证据。
  const samples = Array.from({ length: 5 }, (_, i) => ({
    sample_id: `s${String(i + 1).padStart(2, '0')}`,
    prompt: 'Return the pass token.',
    assertions: [{ type: 'contains', value: 'PASS', weight: 1 }],
  }));
  await writeFile(join(dir, 'samples.json'), JSON.stringify(samples, null, 2));

  const candidateOutput = candidatePasses ? 'PASS' : 'FAIL';
  const baselineOutput = candidatePasses ? 'FAIL' : 'PASS';
  const executor = join(dir, 'executor.sh');
  await writeFile(executor, [
    '#!/bin/sh',
    // Keep this fixture dependency-free: the executor runs once per sample.
    'IFS= read -r request',
    'case "$request" in',
    `  *PROMOTE_TARGET_E2E*) output=${candidateOutput} ;;`,
    `  *) output=${baselineOutput} ;;`,
    'esac',
    'printf \'{"schemaVersion":"omk.custom-command-exchange/v1","resultStatus":"completed","output":{"value":"%s","classification":"public"}}\\n\' "$output"',
  ].join('\n'));
  await chmod(executor, 0o755);

  await writeFile(join(dir, 'eval.yaml'), [
    'samples: ./samples.json',
    `executor: ${JSON.stringify(executor)}`,
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
    assert.fail(`custom-command evidence must not pass a production gate:\n${stderr}`);
  } catch (err) {
    const e = err as ExecError;
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
      () => runCommand(SampleCommand, [
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
        () => runCommand(SampleCommand, [
          'skills/triage',
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
        () => runCommand(SampleCommand, [
          '--batch',
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
        () => runCommand(EvolveCommand, [
          'skills/triage',
          '--executor', 'openai-api',
          '--model', 'gpt-4o-mini',
          '--judge-models', 'openai-api:gpt-4o-mini',
          '--rounds', '1',
          '--skip-doctor',
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
    const projection = JSON.parse(stdout);
    assert.equal(projection.projectionKind, 'core-cli-dry-run');
    assert.equal(projection.experiment.trials, 1);
    assert.equal(projection.targets.length, 2);
    assert.ok(projection.preflight.passed > 0);
    assert.ok(!stderr.includes('exploration-only'));
  });

  it('eval gold compare rejects legacy reports at the Core-only boundary', async () => {
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

      await assert.rejects(() => runCommand(EvalGoldCompare, [
        reportId,
        '--gold-dir', goldDir,
        '--reports-dir', reportsDir,
        '--target', 'v1',
        '--evaluator', 'assertions-v1',
        '--metric', 'assertion-score',
        '--bootstrap-samples', '100',
        '--lang', 'en',
      ]), (error: unknown) => {
        const failure = error as ExecError;
        assert.ok(failure.stderr.includes('legacy evaluation reports are no longer supported'));
        return true;
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval --batch --dry-run exits 0', async () => {
    const skillDir = join(FIXTURES_ROOT, 'multi-skills', 'skills');
    const { stdout } = await runEvalCommand([
      '--batch',
      '--dry-run',
      '--skill-dir', skillDir,
      '--executor', CUSTOM_EXECUTOR,
      '--no-judge',
    ]);
    assert.equal(JSON.parse(stdout).projectionKind, 'core-cli-batch-dry-run');
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
          const parsed = JSON.parse(e.stdout);
          assert.equal(parsed.projectionKind, 'core-cli-run-outcome');
          assert.equal(parsed.gate.exitCode, 1);
          assert.equal(parsed.status.runStatus, 'completed');
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
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.projectionKind, 'core-cli-run-outcome');
      assert.equal(parsed.gate.exitCode, 0);
      assert.equal(parsed.status.runStatus, 'completed');
      assert.ok(stderr.includes('Core 评测产物已保存'), stderr);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval config alias binds Core evidence to the managed skill NAME, not the treatment label', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-promote-target-'));
    try {
      const { stdout, stderr, record } = await runManagedSkillEvalFixture(dir, true);

      const projection = JSON.parse(stdout);
      assert.equal(projection.projectionKind, 'core-cli-run-outcome');
      assert.equal(projection.decision?.decisionStatus, 'not-decided');
      assert.equal(projection.gate.gateStatus, 'blocked');
      assert.ok(stderr.includes('Recorded 1 Core managed evidence reference(s).'), stderr);
      assert.equal(record.evidence?.length, 1, 'eval should append evidence to the managed review record');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval does not suggest default promote for non-PROGRESS managed evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-cli-promote-target-'));
    try {
      const { stdout, stderr, record } = await runManagedSkillEvalFixture(dir, false);

      const projection = JSON.parse(stdout);
      assert.equal(projection.projectionKind, 'core-cli-run-outcome');
      assert.notEqual(projection.decision?.verdict, 'PROGRESS');
      assert.ok(stderr.includes('Recorded 1 Core managed evidence reference(s).'), stderr);
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
          const parsed = JSON.parse(e.stdout);
          assert.equal(parsed.projectionKind, 'core-cli-batch-outcome');
          assert.equal(parsed.gate.exitCode, 1);
          assert.ok(parsed.children.length > 0);
          assert.ok(e.stderr.includes('Core Batch：'), e.stderr);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});
