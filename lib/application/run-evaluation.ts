import { resolve } from 'node:path';
import { createExecutor, DEFAULT_MODEL, JUDGE_MODEL } from '../executor.js';
import { analyzeResults } from '../analyzer.js';
import { confidenceInterval, tTest } from '../statistics.js';
import { resolveUrls } from '../url-fetcher.js';
import { loadMcpConfig, resolveMcpUrls, stopAllServers } from '../mcp-resolver.js';
import { loadSamples } from '../load-samples.js';
import { discoverEachSkills, resolveEvaluands } from '../skill-loader.js';
import { buildTasksFromEvaluands } from '../task-planner.js';
import {
  DEFAULT_OUTPUT_DIR,
  executeTasks,
  aggregateReport,
  applyBlindMode,
  persistReport,
  generateRunId,
  preflight,
} from '../evaluation-core.js';

import type {
  Report,
  EvaluandSpec,
  VariantResult,
  VariantSummary,
  VarianceData,
  McpServers,
  ExecutorFn,
} from '../types.js';
import type { ProgressCallback, PersistableReport } from '../evaluation-core.js';

interface DryRunTask {
  sample_id: string;
  variant: string;
  promptPreview: string;
  hasRubric: boolean;
  hasAssertions: boolean;
  hasDimensions: boolean;
  hasSystem: boolean;
}

export interface DryRunReport {
  dryRun: true;
  model: string;
  judgeModel: string;
  variants: string[];
  executor: string;
  samplesPath: string;
  skillDir: string;
  totalTasks: number;
  tasks: DryRunTask[];
}

export interface RunEvaluationOptions {
  samplesPath: string;
  skillDir: string;
  variants?: string[];
  evaluands?: EvaluandSpec[];
  model?: string;
  judgeModel?: string;
  outputDir?: string | null;
  noJudge?: boolean;
  dryRun?: boolean;
  blind?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  noCache?: boolean;
  executorName?: string;
  judgeExecutorName?: string;
  onProgress?: ProgressCallback | null;
  skipPreflight?: boolean;
  mcpConfig?: string;
  verbose?: boolean;
}

export async function runEvaluation({
  samplesPath,
  skillDir,
  variants = ['v1', 'v2'],
  evaluands,
  model = DEFAULT_MODEL,
  judgeModel = JUDGE_MODEL,
  outputDir = DEFAULT_OUTPUT_DIR,
  noJudge = false,
  dryRun = false,
  blind = false,
  concurrency = 1,
  timeoutMs,
  noCache = false,
  executorName = 'claude',
  judgeExecutorName,
  onProgress = null,
  skipPreflight = false,
  mcpConfig,
  verbose = false,
}: RunEvaluationOptions): Promise<{ report: Report | DryRunReport; filePath: string | null }> {
  const samples = loadSamples(samplesPath);
  const resolvedEvaluands = evaluands || resolveEvaluands(resolve(skillDir), variants);

  if (!dryRun) {
    const mcpServers: McpServers | null = loadMcpConfig(mcpConfig);
    if (mcpServers) {
      await resolveMcpUrls(samples, mcpServers);
    }
    await resolveUrls(samples);
  }

  if (resolvedEvaluands.length === 0) {
    throw new Error(
      `未发现任何 skill 变体。请检查：\n`
      + `  1. skill 目录是否存在：${resolve(skillDir)}\n`
      + `  2. 目录下是否有 .md 文件或含 SKILL.md 的子目录\n`
      + `  3. 或通过 --variants 显式指定变体`,
    );
  }
  const tasks = buildTasksFromEvaluands(samples, resolvedEvaluands);
  const variantNames = resolvedEvaluands.map((evaluand) => evaluand.name);

  if (dryRun) {
    return {
      report: {
        dryRun: true,
        model,
        judgeModel,
        variants: variantNames,
        executor: executorName,
        samplesPath,
        skillDir,
        totalTasks: tasks.length,
        tasks: tasks.map((task) => ({
          sample_id: task.sample_id,
          variant: task.variant,
          promptPreview: task.prompt.slice(0, 100),
          hasRubric: Boolean(task.rubric),
          hasAssertions: Boolean(task.assertions?.length),
          hasDimensions: Boolean(task.dimensions && Object.keys(task.dimensions).length),
          hasSystem: Boolean(task.skillContent),
        })),
      },
      filePath: null,
    };
  }

  const executor: ExecutorFn = createExecutor(executorName);
  const judgeExecutor: ExecutorFn = createExecutor(judgeExecutorName || executorName);
  if (!skipPreflight) {
    if (onProgress) onProgress({ phase: 'preflight' });
    await preflight(executor, model);
    if (!noJudge) await preflight(judgeExecutor, judgeModel);
  }

  const { results, totalCostUSD } = await executeTasks({
    tasks,
    executor,
    judgeExecutor,
    model,
    judgeModel,
    noJudge,
    samplesPath,
    concurrency,
    timeoutMs,
    noCache,
    verbose,
    onProgress,
  });

  const runId = generateRunId(variantNames);
  const report = aggregateReport({ runId, variants: variantNames, model, judgeModel, noJudge, executorName, samples, tasks, results, totalCostUSD, evaluands: resolvedEvaluands });
  report.analysis = analyzeResults(report);

  if (blind) {
    applyBlindMode(report, variantNames, `${variantNames.join(',')}:${samplesPath}`);
  }

  await stopAllServers();

  const filePath = persistReport(report, outputDir);
  return { report, filePath };
}

interface DryRunEachSkill {
  name: string;
  samplesPath: string;
  sampleCount: number;
  taskCount: number;
}

export interface DryRunEachReport {
  dryRun: true;
  each: true;
  model: string;
  judgeModel: string;
  executor: string;
  skillDir: string;
  totalSkills: number;
  totalTasks: number;
  skills: DryRunEachSkill[];
}

export interface SkillProgressInfo {
  phase: string;
  skill: string;
  current: number;
  total: number;
}

export interface RunEachEvaluationOptions {
  skillDir: string;
  model?: string;
  judgeModel?: string;
  outputDir?: string | null;
  noJudge?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  executorName?: string;
  judgeExecutorName?: string;
  onProgress?: ProgressCallback | null;
  onSkillProgress?: ((info: SkillProgressInfo) => void) | null;
  skipPreflight?: boolean;
  mcpConfig?: string;
  verbose?: boolean;
}

interface SkillResult {
  name: string;
  skillHash: string;
  samplesPath: string;
  sampleCount: number;
  summary: {
    baseline: VariantSummary | Record<string, never>;
    skill: VariantSummary | Record<string, never>;
  };
  results: Array<{
    sample_id: string;
    variants: {
      baseline: VariantResult;
      skill: VariantResult;
    };
  }>;
}

export async function runEachEvaluation({
  skillDir,
  model = DEFAULT_MODEL,
  judgeModel = JUDGE_MODEL,
  outputDir = DEFAULT_OUTPUT_DIR,
  noJudge = false,
  dryRun = false,
  concurrency = 1,
  timeoutMs,
  executorName = 'claude',
  judgeExecutorName,
  onProgress = null,
  onSkillProgress = null,
  skipPreflight = false,
  mcpConfig,
  verbose = false,
}: RunEachEvaluationOptions): Promise<{ report: Report | DryRunEachReport; filePath: string | null }> {
  const skillEntries = discoverEachSkills(resolve(skillDir));
  if (skillEntries.length === 0) {
    throw new Error(`No skills with paired eval-samples found in: ${skillDir}`);
  }

  if (dryRun) {
    const drySkills: DryRunEachSkill[] = [];
    for (const entry of skillEntries) {
      const samples = loadSamples(entry.samplesPath);
      drySkills.push({
        name: entry.name,
        samplesPath: entry.samplesPath,
        sampleCount: samples.length,
        taskCount: samples.length * 2,
      });
    }
    return {
      report: {
        dryRun: true,
        each: true,
        model,
        judgeModel,
        executor: executorName,
        skillDir,
        totalSkills: drySkills.length,
        totalTasks: drySkills.reduce((sum, skill) => sum + skill.taskCount, 0),
        skills: drySkills,
      },
      filePath: null,
    };
  }

  const skillResults: SkillResult[] = [];
  let totalCostUSD = 0;

  for (let i = 0; i < skillEntries.length; i++) {
    const entry = skillEntries[i];
    if (onSkillProgress) {
      onSkillProgress({ phase: 'start', skill: entry.name, current: i + 1, total: skillEntries.length });
    }

    const skillEvaluands = resolveEvaluands(resolve(skillDir), ['baseline', entry.skillPath]).map((evaluand) => (
      evaluand.name === entry.skillPath ? { ...evaluand, name: 'skill' } : evaluand
    ));

    const { report } = await runEvaluation({
      samplesPath: entry.samplesPath,
      skillDir,
      evaluands: skillEvaluands,
      model,
      judgeModel,
      outputDir: null,
      noJudge,
      concurrency,
      timeoutMs,
      executorName,
      judgeExecutorName,
      onProgress,
      skipPreflight: skipPreflight || i > 0,
      mcpConfig,
      verbose,
    });

    const variantKey = 'skill';
    const fullReport = report as Report;
    const skillSummary = fullReport.summary[variantKey] || {};
    const skillHash = fullReport.meta.skillHashes?.[variantKey] || '';

    skillResults.push({
      name: entry.name,
      skillHash,
      samplesPath: entry.samplesPath,
      sampleCount: fullReport.meta.sampleCount,
      summary: {
        baseline: fullReport.summary.baseline || {},
        skill: skillSummary,
      },
      results: fullReport.results.map((result) => ({
        sample_id: result.sample_id,
        variants: {
          baseline: result.variants.baseline || result.variants['baseline'],
          skill: result.variants[variantKey],
        },
      })),
    });

    totalCostUSD += fullReport.meta.totalCostUSD;

    if (onSkillProgress) {
      onSkillProgress({ phase: 'done', skill: entry.name, current: i + 1, total: skillEntries.length });
    }
  }

  const overview = {
    totalSkills: skillResults.length,
    totalSamples: skillResults.reduce((sum, skill) => sum + skill.sampleCount, 0),
    totalCostUSD: Number(totalCostUSD.toFixed(6)),
    skills: skillResults.map((skill) => {
      const baselineScore = (skill.summary.baseline as VariantSummary)?.avgCompositeScore ?? (skill.summary.baseline as VariantSummary)?.avgLlmScore ?? null;
      const skillScore = (skill.summary.skill as VariantSummary)?.avgCompositeScore ?? (skill.summary.skill as VariantSummary)?.avgLlmScore ?? null;
      let improvement: string | null = null;
      if (typeof baselineScore === 'number' && typeof skillScore === 'number' && baselineScore > 0) {
        improvement = `${((skillScore - baselineScore) / baselineScore * 100).toFixed(0)}%`;
        if (skillScore >= baselineScore) improvement = `+${improvement}`;
      }
      return { name: skill.name, baselineScore, skillScore, improvement };
    }),
  };

  const runId = generateRunId(['each']);
  const combinedReport: PersistableReport & Record<string, unknown> = {
    id: runId,
    each: true,
    meta: {
      model,
      judgeModel: noJudge ? null : judgeModel,
      executor: executorName,
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      timestamp: new Date().toISOString(),
    },
    overview,
    skills: skillResults,
  };

  const filePath = persistReport(combinedReport, outputDir);
  return { report: combinedReport as unknown as Report, filePath };
}

export interface RunMultipleOptions extends RunEvaluationOptions {
  repeat?: number;
  onRepeatProgress?: ((info: { run: number; total: number }) => void) | null;
}

export async function runMultiple({ repeat = 1, onRepeatProgress, ...config }: RunMultipleOptions): Promise<{ report: Report; aggregated: VarianceData | null; filePath: string | null }> {
  const runs: Report[] = [];
  for (let i = 0; i < repeat; i++) {
    if (onRepeatProgress) onRepeatProgress({ run: i + 1, total: repeat });
    const { report } = await runEvaluation(config);
    runs.push(report as Report);
  }

  if (runs.length === 1) {
    return { report: runs[0], aggregated: null, filePath: null };
  }

  const variants = runs[0].meta.variants || [];
  const perVariant: Record<string, { scores: number[]; mean: number; lower: number; upper: number; stddev: number }> = {};
  for (const variant of variants) {
    const scores = runs.map((run) => run.summary?.[variant]?.avgCompositeScore).filter((score): score is number => typeof score === 'number');
    perVariant[variant] = { scores, ...confidenceInterval(scores) };
  }

  const comparisons: Array<{ a: string; b: string; tStatistic: number; df: number; significant: boolean }> = [];
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      comparisons.push({
        a: variants[i],
        b: variants[j],
        ...tTest(perVariant[variants[i]].scores, perVariant[variants[j]].scores),
      });
    }
  }

  const report = runs[runs.length - 1];
  report.variance = { runs: repeat, perVariant, comparisons };

  return { report, aggregated: report.variance, filePath: null };
}
