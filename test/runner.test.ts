import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  runEvaluation as runEvaluationCore,
  runBatchEvaluation as runBatchEvaluationCore,
} from '../src/eval-workflows/run-evaluation.js';
import { executeBatchEvaluationRuns } from '../src/eval-workflows/batch-evaluation-workflow.js';
import { buildTasks } from '../src/eval-core/task-planner.js';
import { discoverVariants, discoverBatchSkills, loadSkills, variantExprToSkillName } from '../src/inputs/skill-loader.js';
import { generateRunId, persistReport } from '../src/eval-core/evaluation-reporting.js';
import { reportFileName } from '../src/eval-core/artifact-file-names.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { captureStderr, type CapturedStderr } from './helpers/stderr.js';
import type { Report, VariantSpec } from '../src/types/index.js';

const TEST_RUNTIME = {
  model: 'sonnet',
  executorName: 'claude',
} as const;

type RunEvaluationInput = Parameters<typeof runEvaluationCore>[0];
type RunBatchEvaluationInput = Parameters<typeof runBatchEvaluationCore>[0];

function runEvaluation(
  options: Omit<RunEvaluationInput, keyof typeof TEST_RUNTIME>
    & Partial<Pick<RunEvaluationInput, keyof typeof TEST_RUNTIME>>,
) {
  return runEvaluationCore({ ...TEST_RUNTIME, ...options });
}

function runBatchEvaluation(
  options: Omit<RunBatchEvaluationInput, keyof typeof TEST_RUNTIME>
    & Partial<Pick<RunBatchEvaluationInput, keyof typeof TEST_RUNTIME>>,
) {
  return runBatchEvaluationCore({ ...TEST_RUNTIME, ...options });
}

function successfulVariantResult(compositeScore = 4): Report['results'][number]['variants'][string] {
  return {
    ok: true,
    durationMs: 100,
    durationApiMs: 100,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    execCostUSD: 0,
    judgeCostUSD: 0,
    costUSD: 0,
    numTurns: 1,
    outputPreview: 'ok',
    compositeScore,
  };
}

function successfulSummary(totalSamples: number, compositeScore = 4): Report['summary'][string] {
  return {
    totalSamples,
    successCount: totalSamples,
    errorCount: 0,
    errorRate: 0,
    avgDurationMs: 100,
    avgInputTokens: 0,
    avgOutputTokens: 0,
    avgTotalTokens: 0,
    totalCostUSD: 0,
    totalExecCostUSD: 0,
    totalJudgeCostUSD: 0,
    avgCostPerSample: 0,
    avgNumTurns: 1,
    avgCompositeScore: compositeScore,
  };
}

// Test helper: convert a list of variant names into VariantSpec[].
// First name becomes `control`, the rest become `treatment`—mirrors the
// historical `variants: [...]` convention used across legacy fixtures.
function asSpecs(names: string[]): VariantSpec[] {
  return names.map((name, i) => {
    // 测试便捷:把 `expr@cwd` 拆成结构化 cwd(生产已移除 @cwd 编码,cwd 随 spec 结构化携带)。
    const at = name.startsWith('git:') ? -1 : name.indexOf('@');
    const expr = at === -1 ? name : name.slice(0, at);
    const cwd = at === -1 ? undefined : name.slice(at + 1);
    return {
      name: variantExprToSkillName(expr),
      role: i === 0 ? 'control' : 'treatment',
      expr,
      ...(cwd !== undefined && { cwd }),
    };
  });
}

interface DryRunTask {
  sample_id: string;
  variant: string;
  artifactKind: string;
  artifactSource: string;
  executionStrategy: string;
  experimentType: string;
  experimentRole: string;
  cwd: string | null;
  hasRubric: boolean;
  hasAssertions: boolean;
  hasDimensions: boolean;
}

interface DryRunReport {
  dryRun: true;
  totalTasks: number;
  variants: string[];
  executor: string;
  model?: string;
  judgeModels: { executor: string; model: string }[];
  tasks: DryRunTask[];
}

interface BatchDryRunSkill {
  name: string;
  sampleCount: number;
  taskCount: number;
}

interface BatchDryRunReport {
  dryRun: true;
  batch: true;
  totalArtifacts: number;
  totalTasks: number;
  artifacts: BatchDryRunSkill[];
}

function asDryRunReport(value: unknown): DryRunReport {
  return value as DryRunReport;
}

function asBatchDryRunReport(value: unknown): BatchDryRunReport {
  return value as BatchDryRunReport;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_PATH = join(__dirname, 'fixtures', 'code-review', 'eval-samples.json');
const SKILL_DIR = join(__dirname, 'fixtures', 'code-review', 'skills');
const AGENT_CONTROL_DIR = join(__dirname, 'fixtures', 'agent-eval', 'control-experiments');
const AGENT_SKILL_DIR = join(__dirname, 'fixtures', 'agent-eval', 'skills');
const CUSTOM_EXECUTOR_SAMPLES = join(__dirname, 'fixtures', 'custom-executor', 'eval-samples.json');
const CUSTOM_EXECUTOR_SKILL_DIR = join(__dirname, 'fixtures', 'custom-executor', 'skills');
const CUSTOM_EXECUTOR_PATH = join(__dirname, 'fixtures', 'custom-executor', 'fixture-executor.sh');

let stderrCapture: CapturedStderr;

// Runner tests intentionally discard expected progress / warning noise
// (power warnings, batch skip notices, git fixture misses). Individual specs
// assert the resulting reports/errors; keeping stderr quiet makes real test
// failures easier to read.
beforeEach(() => {
  stderrCapture = captureStderr();
});

afterEach(() => {
  stderrCapture.restore();
});

describe('runEvaluation', () => {
  it('uses a same-process executor override supplied by an embedding host', async () => {
    let calls = 0;
    const outputDir = mkdtempSync(join(tmpdir(), 'omk-dsh-host-report-'));
    try {
      const hostExecutor = Object.assign(async () => {
        calls += 1;
        return {
          ok: true,
          output: 'host result',
          durationMs: 1,
          durationApiMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUSD: 0,
          costReportedByExecutor: false,
          stopReason: 'completed',
          numTurns: 1,
        };
      }, {
        runtimeFingerprint: (model: string) => ({
          executor: 'dsh-host',
          model,
          runtimeKind: 'agent-sdk' as const,
          fingerprint: 'host-runtime-override',
          binary: { name: '@deepseek-ai/dsh', source: 'path' as const, version: 'test' },
          sdk: { name: 'oh-my-knowledge', version: 'test' },
          auditability: { status: 'partial' as const, reasons: ['test host'] },
          capabilities: {
            systemPrompt: 'native' as const,
            costUSD: 'not-reported' as const,
            trace: 'native' as const,
            skillIsolation: 'full-no-partial' as const,
          },
        }),
      });
      const result = await runEvaluation({
        samplesPath: SAMPLES_PATH,
        skillDir: SKILL_DIR,
        variantSpecs: asSpecs(['v1']),
        executorName: 'dsh-host',
        executorOverrides: {
          'dsh-host': hostExecutor,
        },
        noJudge: true,
        noDiagnostic: true,
        skipConnectivity: true,
        skipDoctor: true,
        noCache: true,
        outputDir,
      });

      assert.equal(calls, 5);
      const report = result.report as Report;
      assert.equal(report.meta.executor, 'dsh-host');
      assert.equal(report.meta.executorRuntime?.fingerprint, 'host-runtime-override');
      assert.equal(report.meta.executorRuntimes?.v1?.fingerprint, 'host-runtime-override');
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('dry-run: experimentRole 从 variantSpecs 正确穿透到每个 task (非默认排序)', async () => {
    // 显式颠倒顺序(v2 在前,v1 在后)+ 自定义 role 分配,验证 experimentRole 来自 spec
    // 而非 asSpecs 的位置约定或下游 kind 反推。这是 spec"唯一来源"的端到端保护。
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: [
        { name: 'v2', role: 'control', expr: 'v2' },
        { name: 'v1', role: 'treatment', expr: 'v1' },
      ],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    const v1Task = report.tasks.find((t) => t.variant === 'v1');
    const v2Task = report.tasks.find((t) => t.variant === 'v2');
    assert.equal(v1Task?.experimentRole, 'treatment', 'v1 应当保持 spec 指定的 treatment,不被位置/kind 反推覆盖');
    assert.equal(v2Task?.experimentRole, 'control', 'v2 应当保持 spec 指定的 control');
  });

  it('dry-run: returns correct task schedule', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs(['v1', 'v2']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

    assert.equal(report.dryRun, true);
    assert.equal(report.totalTasks, 10); // 5 samples × 2 variants
    assert.deepEqual(report.variants, ['v1', 'v2']);
    assert.equal(report.executor, 'claude');
  });

  it('dry-run: rejects sample mocks unsupported by the selected executor', async () => {
    const samplesPath = join(tmpdir(), `omk-codex-mocks-${Date.now()}.json`);
    writeFileSync(samplesPath, JSON.stringify([{
      sample_id: 'codex-impossible',
      prompt: 'read the fixture',
      mocks: [{ tool: 'Read', return: 'fixture' }],
      mocksStrict: true,
      assertions: [{ type: 'mock_hit', value: 'Read:1' }],
    }]));
    try {
      await assert.rejects(
        () => runEvaluation({
          samplesPath,
          skillDir: SKILL_DIR,
          variantSpecs: asSpecs(['v1']),
          executorName: 'codex',
          dryRun: true,
        }),
        /不支持 Sample\.mocks.*伪证据.*codex-impossible/,
      );
    } finally {
      rmSync(samplesPath, { force: true });
    }
  });

  it('dry-run: interleaved scheduling order', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs(['v1', 'v2']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

    const schedule = report.tasks.map((t: { sample_id: string; variant: string }) => `${t.sample_id}-${t.variant}`);
    assert.deepEqual(schedule, [
      'code-review-sql-injection-v1', 'code-review-sql-injection-v2',
      'code-review-fetch-robustness-v1', 'code-review-fetch-robustness-v2',
      'code-review-xss-v1', 'code-review-xss-v2',
      'code-review-authorization-v1', 'code-review-authorization-v2',
      'code-review-secret-logging-v1', 'code-review-secret-logging-v2',
    ]);
  });

  it('dry-run: reports assertion and dimension presence', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs(['v1', 'v2']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

    for (const task of report.tasks) {
      assert.equal(task.hasRubric, true);
      assert.equal(task.hasAssertions, true);
      assert.equal(task.hasDimensions, true);
    }
  });

  it('dry-run: supports 3+ variants', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs(['v1', 'v2']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

    assert.equal(report.totalTasks, 10);
  });

  it('dry-run: custom model and judge model', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs(['v1', 'v2']),
      model: 'opus',
      judgeModels: [{ executor: 'claude', model: 'sonnet' }],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

    assert.equal(report.model, 'opus');
    assert.deepEqual(report.judgeModels, [{ executor: 'claude', model: 'sonnet' }]);
  });

  it('dry-run: surfaces multi-judge ensemble without legacy single judge model', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs(['v1', 'v2']),
      judgeModels: [
        { executor: 'claude', model: 'sonnet' },
        { executor: 'codex', model: 'gpt-5.5' },
      ],
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

    assert.deepEqual(report.judgeModels, [
      { executor: 'claude', model: 'sonnet' },
      { executor: 'codex', model: 'gpt-5.5' },
    ]);
  });

  it('dry-run: programmatic judge fallback stays on the selected runtime', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs(['v1', 'v2']),
      executorName: 'codex',
      model: 'gpt-5.5',
      dryRun: true,
    });
    const report = asDryRunReport(result.report);

    assert.deepEqual(report.judgeModels, [{ executor: 'codex', model: 'gpt-5.5' }]);
  });

  it('throws on missing samples file', async () => {
    await assert.rejects(
      () => runEvaluation({
        samplesPath: '/nonexistent/file.json',
        skillDir: SKILL_DIR,
        variantSpecs: asSpecs(['v1', 'v2']),
      }),
      /ENOENT|invalid/,
    );
  });

  it('throws on missing skill file (non-dry-run)', async () => {
    await assert.rejects(
      () => runEvaluation({
        samplesPath: SAMPLES_PATH,
        skillDir: SKILL_DIR,
        variantSpecs: asSpecs(['v1', 'v99_nonexistent']),
      }),
      /skill not found/,
    );
  });

  it('dry-run: meta includes traceability fields', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs(['v1', 'v2']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    // dry-run still has model info
    assert.ok(report.model);
  });

  it('dry-run: includes artifact/runtime context semantics', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs(['baseline', 'project-env@/tmp/project-a', 'v1']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    const baselineTask = report.tasks.find((task) => task.variant === 'baseline');
    const projectEnvTask = report.tasks.find((task) => task.variant === 'project-env');
    const artifactTask = report.tasks.find((task) => task.variant === 'v1');
    assert.equal(baselineTask?.experimentType, 'baseline');
    assert.equal(projectEnvTask?.experimentType, 'runtime-context-only');
    assert.equal(projectEnvTask?.cwd, '/tmp/project-a');
    assert.equal(artifactTask?.executionStrategy, 'system-prompt');
  });

  it('loads SKILL.md from subdirectories', async () => {
    const classifierSamples = join(__dirname, 'fixtures', 'multi-skills', 'skills', 'classifier', '.omk');
    const multiSkillsDir = join(__dirname, 'fixtures', 'multi-skills', 'skills');
    const result = await runEvaluation({
      samplesPath: classifierSamples,
      skillDir: multiSkillsDir,
      variantSpecs: asSpecs(['classifier']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    assert.equal(report.totalTasks, 2); // 2 samples × 1 variant
  });

  it('validates required sample fields', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const tmpSamples = join(__dirname, 'tmp-bad-samples.json');
    writeFileSync(tmpSamples, JSON.stringify([{ rubric: 'test' }]));
    try {
      await assert.rejects(
        () => runEvaluation({
          samplesPath: tmpSamples,
          skillDir: SKILL_DIR,
          variantSpecs: asSpecs(['v1', 'v2']),
        }),
        /required field: sample_id/,
      );
    } finally {
      try { unlinkSync(tmpSamples); } catch { /* ignore */ }
    }
  });

  it('loads env-isolation control template in dry-run', async () => {
    const result = await runEvaluation({
      samplesPath: join(AGENT_CONTROL_DIR, 'env-isolation.eval-samples.json'),
      skillDir: AGENT_SKILL_DIR,
      variantSpecs: asSpecs(['baseline', 'project-a-env@/tmp/project-a', 'project-b-env@/tmp/project-b']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    assert.equal(report.totalTasks, 6);
    assert.ok(report.tasks.some((task) => task.experimentType === 'runtime-context-only'));
  });

  it('loads artifact-injection control template in dry-run', async () => {
    const result = await runEvaluation({
      samplesPath: join(AGENT_CONTROL_DIR, 'artifact-injection.eval-samples.json'),
      skillDir: AGENT_SKILL_DIR,
      variantSpecs: asSpecs(['baseline', 'v1@/tmp/project-a']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    const injected = report.tasks.find((task) => task.variant === 'v1');
    assert.equal(report.totalTasks, 4);
    assert.equal(injected?.experimentType, 'artifact-injection');
    assert.equal(injected?.cwd, '/tmp/project-a');
  });

  it('loads assertion-discrimination control template in dry-run', async () => {
    const result = await runEvaluation({
      samplesPath: join(AGENT_CONTROL_DIR, 'assertion-discrimination.eval-samples.json'),
      skillDir: AGENT_SKILL_DIR,
      variantSpecs: asSpecs(['baseline', 'project-env@/tmp/project-a', 'v1@/tmp/project-a']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    assert.equal(report.totalTasks, 6);
    assert.ok(report.tasks.every((task) => task.hasAssertions));
  });

  it('no-judge still keeps deterministic assertion scores', async () => {
    const result = await runEvaluation({
      samplesPath: CUSTOM_EXECUTOR_SAMPLES,
      skillDir: CUSTOM_EXECUTOR_SKILL_DIR,
      variantSpecs: asSpecs(['baseline', 'v1']),
      executorName: CUSTOM_EXECUTOR_PATH,
      noJudge: true,
      outputDir: null,
      persistJob: false,
    });
    const report = result.report as Report;
    const baseline = report.results[0]?.variants?.baseline;
    const v1 = report.results[0]?.variants?.v1;
    assert.equal(report.meta.noJudge, true);
    assert.equal(baseline?.assertions?.total, 1);
    assert.equal(baseline?.assertions?.passed, 0);
    assert.equal(baseline?.assertions?.score, 1);
    assert.equal(v1?.assertions?.total, 1);
    assert.equal(v1?.assertions?.passed, 0);
    assert.equal(v1?.assertions?.score, 1);
  });
});

describe('discoverVariants', () => {
  it('discovers .md files as variants', () => {
    const variants = discoverVariants(SKILL_DIR);
    assert.ok(variants.includes('v1'));
    assert.ok(variants.includes('v2'));
  });

  it('discovers subdirectories with SKILL.md', () => {
    const multiSkillsDir = join(__dirname, 'fixtures', 'multi-skills', 'skills');
    const variants = discoverVariants(multiSkillsDir);
    assert.ok(variants.includes('classifier'));
  });

  it('returns sorted variants', () => {
    const variants = discoverVariants(SKILL_DIR);
    const sorted = [...variants].filter(v => v !== 'baseline').sort();
    assert.deepEqual(variants.filter(v => v !== 'baseline'), sorted);
  });

  it('adds baseline when only one skill found', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const tmpDir = join(__dirname, 'tmp-single-skill');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'only.md'), 'test skill');
    try {
      const variants = discoverVariants(tmpDir);
      assert.deepEqual(variants, ['baseline', 'only']);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns empty for nonexistent directory', () => {
    const variants = discoverVariants('/nonexistent/dir');
    assert.deepEqual(variants, []);
  });
});

describe('baseline variant', () => {
  it('loadSkills: baseline returns null without file lookup', () => {
    const skills = loadSkills(SKILL_DIR, ['baseline', 'v1']);
    assert.equal(skills.baseline, null);
    assert.equal(typeof skills.v1, 'string');
    assert.ok((skills.v1 as string).length > 0);
  });

  it('loadSkills: baseline-only does not need skill dir', () => {
    const skills = loadSkills('/nonexistent/dir', ['baseline']);
    assert.deepEqual(skills, { baseline: null });
  });

  it('buildTasks: baseline variant has null artifactContent', () => {
    const samples = [{ sample_id: 's1', prompt: 'hello' }];
    const skills: Record<string, string | null> = { baseline: null, v1: 'system prompt' };
    const tasks = buildTasks(samples, ['baseline', 'v1'], skills);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].artifactContent, null);
    assert.equal(tasks[1].artifactContent, 'system prompt');
  });

  it('dry-run: baseline variant included in task schedule', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs(['baseline', 'v1']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    assert.equal(report.totalTasks, 10); // 5 samples × 2 variants
    assert.deepEqual(report.variants, ['baseline', 'v1']);
  });
});

describe('generateRunId', () => {
  it('sanitizes file-path variants for filesystem-safe ids', () => {
    const runId = generateRunId(['baseline', 'fixtures/agent-eval/skills/v1.md@fixtures/code-review']);
    assert.doesNotMatch(runId, /[\\/]/);
    assert.match(runId, /fixtures-agent-eval-skills-v1\.md@fixtures-code-review/);
  });
});

describe('git: variant', () => {
  it('loadSkills: git:name loads skill from HEAD', () => {
    const skills = loadSkills(SKILL_DIR, ['git:v1']);
    assert.equal(typeof skills['git:v1'], 'string');
    assert.ok((skills['git:v1'] as string).length > 0);
  });

  it('loadSkills: git:ref:name loads skill from specific commit', () => {
    const skills = loadSkills(SKILL_DIR, ['git:HEAD:v1']);
    assert.equal(typeof skills['git:HEAD:v1'], 'string');
    assert.ok((skills['git:HEAD:v1'] as string).length > 0);
  });

  it('loadSkills: git:name throws on missing skill', () => {
    assert.throws(
      () => loadSkills(SKILL_DIR, ['git:nonexistent']),
      /skill not found in git HEAD/,
    );
  });

  it('loadSkills: git:name and file variant can coexist', () => {
    const skills = loadSkills(SKILL_DIR, ['git:v1', 'v2']);
    assert.equal(typeof skills['git:v1'], 'string');
    assert.equal(typeof skills['v2'], 'string');
  });

  it('dry-run: git variant included in task schedule', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs(['git:v1', 'v1']),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    assert.equal(report.totalTasks, 10);
    assert.deepEqual(report.variants, ['git:v1', 'v1']);
  });
});

describe('file path variant', () => {
  const v1Path = join(SKILL_DIR, 'v1.md');
  const v2Path = join(SKILL_DIR, 'v2.md');

  it('loadSkills: loads skill from file path', () => {
    const skills = loadSkills(SKILL_DIR, [v1Path]);
    assert.equal(typeof skills['v1'], 'string');
    assert.ok((skills['v1'] as string).length > 0);
  });

  it('loadSkills: file path and name variant can coexist', () => {
    const skills = loadSkills(SKILL_DIR, [v1Path, 'v2']);
    assert.equal(typeof skills['v1'], 'string');
    assert.equal(typeof skills['v2'], 'string');
  });

  it('loadSkills: throws on missing file path', () => {
    assert.throws(
      () => loadSkills(SKILL_DIR, ['/nonexistent/skill.md']),
      /skill file not found/,
    );
  });

  it('dry-run: file path variant in task schedule', async () => {
    const result = await runEvaluation({
      samplesPath: SAMPLES_PATH,
      skillDir: SKILL_DIR,
      variantSpecs: asSpecs([v1Path, v2Path]),
      dryRun: true,
    });
    const report = asDryRunReport(result.report);
    assert.equal(report.totalTasks, 10);
  });
});

describe('discoverBatchSkills', () => {
  const MULTI_SKILLS_DIR = join(__dirname, 'fixtures', 'multi-skills', 'skills');

  it('discovers skills with paired eval-samples', () => {
    const skills = discoverBatchSkills(MULTI_SKILLS_DIR);
    assert.ok(skills.length >= 2);
    const names = skills.map((s) => s.name);
    assert.ok(names.includes('summarizer'));
    assert.ok(names.includes('translator'));
  });

  it('batch entry has name, skillPath, samplesPath', () => {
    const skills = discoverBatchSkills(MULTI_SKILLS_DIR);
    for (const sk of skills) {
      assert.ok(sk.name);
      assert.ok(sk.skillPath);
      assert.ok(sk.samplesPath);
    }
  });

  it('returns sorted by name', () => {
    const skills = discoverBatchSkills(MULTI_SKILLS_DIR);
    const names = skills.map((s) => s.name);
    assert.deepEqual(names, [...names].sort());
  });

  it('skips skills without paired eval-samples', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const tmpDir = join(__dirname, 'tmp-batch-skills');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'has-pair.md'), 'skill content');
    writeFileSync(join(tmpDir, 'has-pair.eval-samples.json'), JSON.stringify([{ sample_id: 's1', prompt: 'test' }]));
    writeFileSync(join(tmpDir, 'no-pair.md'), 'skill content');
    try {
      const skills = discoverBatchSkills(tmpDir);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'has-pair');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('discovers directory skill samples from .omk namespace', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const tmpDir = join(__dirname, 'tmp-batch-skill-local');
    const skillRoot = join(tmpDir, 'release-readiness');
    mkdirSync(join(skillRoot, '.omk'), { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '你是一个发布检查 skill，内容足够长。');
    writeFileSync(join(skillRoot, '.omk', 'samples.json'), JSON.stringify([{ sample_id: 's1', prompt: 'test' }]));
    try {
      const skills = discoverBatchSkills(tmpDir);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'release-readiness');
      assert.equal(skills[0].samplesPath, join(skillRoot, '.omk'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('batch discovery skips directory skill when same-name flat skill takes precedence', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const tmpDir = join(__dirname, 'tmp-batch-dual-shape');
    mkdirSync(join(tmpDir, 'dual', '.omk'), { recursive: true });
    writeFileSync(join(tmpDir, 'dual.md'), '你是一个扁平 skill，内容足够长。');
    writeFileSync(join(tmpDir, 'dual.eval-samples.json'), JSON.stringify([{ sample_id: 'f1', prompt: 'flat' }]));
    writeFileSync(join(tmpDir, 'dual', 'SKILL.md'), '你是一个目录 skill，内容也足够长。');
    writeFileSync(join(tmpDir, 'dual', '.omk', 'samples.json'), JSON.stringify([{ sample_id: 'd1', prompt: 'dir' }]));
    try {
      const skills = discoverBatchSkills(tmpDir);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'dual');
      assert.equal(skills[0].skillPath, join(tmpDir, 'dual.md'));
      assert.equal(skills[0].samplesPath, join(tmpDir, 'dual.eval-samples.json'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty for nonexistent directory', () => {
    const skills = discoverBatchSkills('/nonexistent/dir');
    assert.deepEqual(skills, []);
  });
});

describe('runBatchEvaluation', () => {
  const MULTI_SKILLS_DIR = join(__dirname, 'fixtures', 'multi-skills', 'skills');

  it('dry-run: returns correct structure', async () => {
    const result = await runBatchEvaluation({
      skillDir: MULTI_SKILLS_DIR,
      dryRun: true,
    });
    const report = asBatchDryRunReport(result.report);
    assert.equal(report.dryRun, true);
    assert.equal(report.batch, true);
    assert.ok(report.totalArtifacts >= 2);
    assert.ok(report.artifacts.length >= 2);
    for (const sk of report.artifacts) {
      assert.ok(sk.name);
      assert.ok(sk.sampleCount > 0);
      assert.equal(sk.taskCount, sk.sampleCount * 2);
    }
  });

  it('dry-run: totalTasks is sum of all skill tasks', async () => {
    const result = await runBatchEvaluation({
      skillDir: MULTI_SKILLS_DIR,
      dryRun: true,
    });
    const report = asBatchDryRunReport(result.report);
    const expectedTotal = report.artifacts.reduce((s: number, sk: { taskCount: number }) => s + sk.taskCount, 0);
    assert.equal(report.totalTasks, expectedTotal);
  });

  it('non-dry-run: returns batch evaluation and persists child EvaluationReport', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'omk-batch-evaluation-'));
    try {
      const skillPath = join(tmpDir, 'alpha.md');
      const samplesPath = join(tmpDir, 'alpha.eval-samples.json');
      const outputDir = join(tmpDir, 'reports');
      writeFileSync(skillPath, 'skill content');
      writeFileSync(samplesPath, JSON.stringify([{ sample_id: 's1', prompt: 'p' }, { sample_id: 's2', prompt: 'p' }]));

      let capturedSpecs: import('../src/types/index.js').VariantSpec[] = [];
      const result = await executeBatchEvaluationRuns({
        skillDir: tmpDir,
        skillEntries: [{ name: 'alpha', skillPath, samplesPath }],
        model: 'm',
        judgeModel: 'j',
        outputDir,
        noJudge: true,
        concurrency: 1,
        noCache: true,
        executorName: 'claude',
        persistJob: false,
        runSingleEvaluation: async (options) => {
          assert.equal(options.noCache, true);
          capturedSpecs = options.variantSpecs;
          // #183 回归:batch 必须真有一个 treatment-role spec(此前误绑成 control,两个都 control)。
          // 不兜底——find 落空就 undefined.name 抛错,把误绑暴露成测试失败。
          const treatment = options.variantSpecs.find((spec) => spec.role === 'treatment')!.name;
          const report: Report = {
            kind: 'evaluation',
            id: options.runId!,
            meta: {
              variants: ['baseline', treatment],
              model: options.model,
              judgeModels: [{ executor: options.executorName, model: 'haiku' }],
              noJudge: true,
              executor: options.executorName,
              sampleCount: 2,
              taskCount: 4,
              totalCostUSD: 0,
              timestamp: '2026-05-01T00:00:00.000Z',
              cliVersion: 'test',
              nodeVersion: 'test',
              artifactHashes: { baseline: 'no-skill', [treatment]: 'hash-alpha' },
              request: {
                samplesPath: options.samplesPath,
                skillDir: options.skillDir,
                artifacts: [
                  {
                    name: 'baseline',
                    kind: 'baseline',
                    source: 'baseline',
                    content: null,
                  },
                  {
                    name: treatment,
                    kind: 'skill',
                    source: 'file-path',
                    content: 'skill content',
                    locator: skillPath,
                  },
                ],
                model: options.model,
                judgeModels: [{ executor: options.judgeExecutorName || options.executorName, model: 'haiku' }],
                executor: options.executorName,
                noJudge: options.noJudge,
                concurrency: options.concurrency,
                timeoutMs: options.timeoutMs,
                noCache: options.noCache,
                dryRun: false,
                batch: true,
              },
            },
            summary: { baseline: successfulSummary(2, 3), [treatment]: successfulSummary(2, 4) },
            results: ['s1', 's2'].map((sample_id) => ({
              sample_id,
              variants: {
                baseline: successfulVariantResult(3),
                [treatment]: successfulVariantResult(4),
              },
            })),
          };
          return { report, filePath: persistReport(report, options.outputDir) };
        },
      });

      assert.equal(result.report.kind, 'batch-evaluation');
      assert.equal(result.report.mode, 'skill');
      assert.equal(result.report.meta.request?.batch, true);
      assert.equal(result.report.meta.request?.noCache, true);
      assert.equal(result.report.items.length, 1);
      assert.equal(result.report.items[0].name, 'alpha');
      assert.equal(result.report.items[0].artifactHash, 'hash-alpha');
      assert.ok(result.report.items[0].summary.alpha);
      assert.equal(result.report.items[0].summary.skill, undefined);
      assert.ok(result.report.items[0].reportId.startsWith(`${result.report.id}-01-alpha`));
      assert.ok(result.filePath);
      assert.ok(existsSync(result.filePath!));
      const childPath = join(outputDir, reportFileName(result.report.items[0].reportId));
      assert.ok(existsSync(childPath));
      const childReport = JSON.parse(readFileSync(childPath, 'utf-8')) as Report;
      assert.deepEqual(childReport.meta.variants, ['baseline', 'alpha']);
      assert.equal(childReport.meta.request?.noCache, true);
      assert.equal(childReport.meta.request?.batch, true);
      assert.equal(childReport.meta.artifactHashes.alpha, 'hash-alpha');
      assert.ok(childReport.summary.alpha);
      assert.equal(childReport.summary.skill, undefined);

      // #183 回归:batch 构造的 spec 必须 baseline=control、当前 skill=treatment(对齐 entry 名)。
      // 旧实现自管 artifact 拼装、按 `artifact.name === entry.skillPath`(短名 vs 全路径,永 false)
      // 误标,两个都成 control;现在交给 spec-based 解析,role 由 spec 唯一声明。
      const baselineSpec = capturedSpecs.find((s) => s.expr === 'baseline');
      const treatmentSpec = capturedSpecs.find((s) => s.expr !== 'baseline');
      assert.equal(baselineSpec?.role, 'control');
      assert.equal(treatmentSpec?.role, 'treatment');
      assert.equal(treatmentSpec?.name, 'alpha', 'treatment spec 对齐到 entry 的逻辑名');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('#183: per-variant allowedSkills 从 eval.yaml(按 entry.name 查)挂到 treatment spec 上', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'omk-batch-allowed-'));
    try {
      const skillPath = join(tmpDir, 'greeter.md');
      const samplesPath = join(tmpDir, 'greeter.eval-samples.json');
      writeFileSync(skillPath, 'skill content');
      writeFileSync(samplesPath, JSON.stringify([{ sample_id: 's1', prompt: 'p' }]));

      let capturedSpecs: import('../src/types/index.js').VariantSpec[] = [];
      await executeBatchEvaluationRuns({
        skillDir: tmpDir,
        skillEntries: [{ name: 'greeter', skillPath, samplesPath }],
        model: 'm',
        judgeModel: 'j',
        outputDir: join(tmpDir, 'reports'),
        noJudge: true,
        concurrency: 1,
        noCache: true,
        executorName: 'claude',
        persistJob: false,
        strictBaseline: true,
        variantAllowedSkills: { greeter: [] },
        runSingleEvaluation: async (options) => {
          capturedSpecs = options.variantSpecs;
          const report: Report = {
            kind: 'evaluation',
            id: options.runId!,
            meta: {
              variants: ['baseline', 'greeter'],
              model: options.model,
              judgeModels: [{ executor: options.executorName, model: 'haiku' }],
              noJudge: true,
              executor: options.executorName,
              sampleCount: 1,
              taskCount: 2,
              totalCostUSD: 0,
              timestamp: '2026-05-01T00:00:00.000Z',
              cliVersion: 'test',
              nodeVersion: 'test',
              artifactHashes: { baseline: 'no-skill', greeter: 'h' },
            },
            summary: {
              baseline: successfulSummary(1),
              greeter: successfulSummary(1),
            },
            results: [{
              sample_id: 's1',
              variants: {
                baseline: successfulVariantResult(),
                greeter: successfulVariantResult(),
              },
            }],
          };
          return { report, filePath: null };
        },
      });

      // 这里 eval.yaml 只声明 greeter 的 allowedSkills([]),baseline 未声明 → treatment
      // spec 挂 []、baseline spec 不带(隔离交给 strict-baseline 默认)。后续 spec→artifact
      // 绑定由 prepareEvaluationRun 完成(golden case 1 + collision 测试覆盖)。
      const treatmentSpec = capturedSpecs.find((s) => s.expr !== 'baseline');
      const baselineSpec = capturedSpecs.find((s) => s.expr === 'baseline');
      assert.deepEqual(treatmentSpec?.allowedSkills, [], 'eval.yaml per-variant allowedSkills([]) 挂到 treatment spec');
      assert.equal(baselineSpec?.allowedSkills, undefined, '未声明 baseline → 不带 allowedSkills,隔离交给 strict-baseline');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('batch 下 eval.yaml 显式给 baseline 配 allowedSkills([]) 不被漏挂', async () => {
    // 回归:batch 迁 spec 后,baseline 的 eval.yaml 隔离声明([])不能被漏挂——
    // variant.allowedSkills 透传不被 strictBaseline 默认覆盖丢失,否则 `--batch --config` 的 baseline 隔离静默失效。
    const tmpDir = mkdtempSync(join(tmpdir(), 'omk-batch-baseline-allowed-'));
    try {
      const skillPath = join(tmpDir, 'greeter.md');
      const samplesPath = join(tmpDir, 'greeter.eval-samples.json');
      writeFileSync(skillPath, 'skill content');
      writeFileSync(samplesPath, JSON.stringify([{ sample_id: 's1', prompt: 'p' }]));

      let capturedSpecs: import('../src/types/index.js').VariantSpec[] = [];
      await executeBatchEvaluationRuns({
        skillDir: tmpDir,
        skillEntries: [{ name: 'greeter', skillPath, samplesPath }],
        model: 'm',
        judgeModel: 'j',
        outputDir: join(tmpDir, 'reports'),
        noJudge: true,
        concurrency: 1,
        noCache: true,
        executorName: 'claude',
        persistJob: false,
        strictBaseline: true,
        variantAllowedSkills: { baseline: [], greeter: [] },
        runSingleEvaluation: async (options) => {
          capturedSpecs = options.variantSpecs;
          const report: Report = {
            kind: 'evaluation',
            id: options.runId!,
            meta: {
              variants: ['baseline', 'greeter'],
              model: options.model,
              judgeModels: [{ executor: options.executorName, model: 'haiku' }],
              noJudge: true,
              executor: options.executorName,
              sampleCount: 1,
              taskCount: 2,
              totalCostUSD: 0,
              timestamp: '2026-05-01T00:00:00.000Z',
              cliVersion: 'test',
              nodeVersion: 'test',
              artifactHashes: { baseline: 'no-skill', greeter: 'h' },
            },
            summary: {
              baseline: successfulSummary(1),
              greeter: successfulSummary(1),
            },
            results: [{
              sample_id: 's1',
              variants: {
                baseline: successfulVariantResult(),
                greeter: successfulVariantResult(),
              },
            }],
          };
          return { report, filePath: null };
        },
      });

      const baselineSpec = capturedSpecs.find((s) => s.expr === 'baseline');
      const treatmentSpec = capturedSpecs.find((s) => s.expr !== 'baseline');
      assert.deepEqual(baselineSpec?.allowedSkills, [], 'eval.yaml baseline 显式 [] 隔离声明被透传,不被漏挂');
      assert.deepEqual(treatmentSpec?.allowedSkills, [], '显式给 treatment 配 [] 也透传');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('runEvaluation credibility', () => {
  const MOCK_SAMPLES_PATH = join(__dirname, 'tmp-mock-samples.json');

  async function writeMockSamples(): Promise<void> {
    const { writeFileSync: wf } = await import('node:fs');
    wf(MOCK_SAMPLES_PATH, JSON.stringify([
      { sample_id: 's1', prompt: 'test prompt 1' },
      { sample_id: 's2', prompt: 'test prompt 2' },
    ]));
  }
  async function cleanMockSamples(): Promise<void> {
    try { (await import('node:fs')).unlinkSync(MOCK_SAMPLES_PATH); } catch { /* ignore */ }
  }

  it('buildTasks: 每样本每变体确定性建任务（顺序稳定）', async () => {
    await writeMockSamples();
    try {
      const { loadSamples } = await import('../src/inputs/load-samples.js');
      const { buildTasks } = await import('../src/eval-core/task-planner.js');
      const { samples } = loadSamples(MOCK_SAMPLES_PATH);
      const skills: Record<string, string | null> = { v1: 'skill content v1', v2: 'skill content v2' };
      const tasks = buildTasks(samples, ['v1', 'v2'], skills);

      // tasks 按 variant 顺序稳定建出（2 样本 × 2 变体）
      assert.equal(tasks.length, 4); // 2 samples × 2 variants
      assert.equal(tasks[0].variant, 'v1');
      assert.equal(tasks[1].variant, 'v2');
    } finally {
      await cleanMockSamples();
    }
  });

  it('dry-run: task count correct for multiple variants', async () => {
    await writeMockSamples();
    try {
      const result = await runEvaluation({
        samplesPath: MOCK_SAMPLES_PATH,
        skillDir: SKILL_DIR,
        variantSpecs: asSpecs(['v1', 'v2']),
        dryRun: true,
      });
      const report = asDryRunReport(result.report);
      assert.equal(report.totalTasks, 4); // 2 samples × 2 variants
    } finally {
      await cleanMockSamples();
    }
  });
});
