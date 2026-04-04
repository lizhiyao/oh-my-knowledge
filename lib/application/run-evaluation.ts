import { resolve } from 'node:path';
import { createExecutor, DEFAULT_MODEL, JUDGE_MODEL } from '../executor.js';
import { analyzeResults } from '../analyzer.js';
import { confidenceInterval, tTest } from '../statistics.js';
import { resolveUrls } from '../url-fetcher.js';
import { loadMcpConfig, resolveMcpUrls, stopAllServers } from '../mcp-resolver.js';
import { loadSamples } from '../load-samples.js';
import { discoverEachSkills, resolveArtifacts } from '../skill-loader.js';
import { buildTasksFromArtifacts } from '../task-planner.js';
import { buildVariantConfig } from '../execution-strategy.js';
import {
  buildEvaluationRequest,
  createFailedJob,
  createEvaluationRun,
  createQueuedJob,
  createSucceededJob,
  finalizeEvaluationRun,
  markJobRunning,
  failEvaluationRun,
} from '../evaluation-job.js';
import { createFileJobStore, DEFAULT_JOBS_DIR } from '../job-store.js';
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
  Artifact,
  VariantResult,
  VariantSummary,
  VarianceData,
  McpServers,
  ExecutorFn,
  JobStore,
} from '../types.js';
import type { ProgressCallback } from '../evaluation-core.js';

interface DryRunTask {
  sample_id: string;
  variant: string;
  artifactKind: Artifact['kind'];
  artifactSource: Artifact['source'];
  executionStrategy: string;
  experimentRole: string;
  cwd: string | null;
  promptPreview: string;
  hasRubric: boolean;
  hasAssertions: boolean;
  hasDimensions: boolean;
  hasSystem: boolean;
}

interface DryRunBase {
  dryRun: true;
  model: string;
  judgeModel: string;
  executor: string;
  skillDir: string;
  totalTasks: number;
}

export interface DryRunReport extends DryRunBase {
  variants: string[];
  samplesPath: string;
  tasks: DryRunTask[];
}

export interface RunEvaluationOptions {
  samplesPath: string;
  skillDir: string;
  variants?: string[];
  artifacts?: Artifact[];
  model?: string;
  judgeModel?: string;
  outputDir?: string | null;
  project?: string;
  owner?: string;
  tags?: string[];
  noJudge?: boolean;
  dryRun?: boolean;
  blind?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  noCache?: boolean;
  executorName?: string;
  judgeExecutorName?: string;
  jobStore?: JobStore | null;
  persistJob?: boolean;
  onProgress?: ProgressCallback | null;
  skipPreflight?: boolean;
  mcpConfig?: string;
  verbose?: boolean;
}

export async function runEvaluation({
  samplesPath,
  skillDir,
  variants = ['v1', 'v2'],
  artifacts,
  model = DEFAULT_MODEL,
  judgeModel = JUDGE_MODEL,
  outputDir = DEFAULT_OUTPUT_DIR,
  project,
  owner,
  tags,
  noJudge = false,
  dryRun = false,
  blind = false,
  concurrency = 1,
  timeoutMs,
  noCache = false,
  executorName = 'claude',
  judgeExecutorName,
  jobStore = null,
  persistJob = true,
  onProgress = null,
  skipPreflight = false,
  mcpConfig,
  verbose = false,
}: RunEvaluationOptions): Promise<{ report: Report | DryRunReport; filePath: string | null }> {
  const samples = loadSamples(samplesPath);
  const resolvedArtifacts = artifacts || resolveArtifacts(resolve(skillDir), variants);
  const request = buildEvaluationRequest({
    samplesPath,
    skillDir,
    artifacts: resolvedArtifacts,
    model,
    judgeModel: noJudge ? null : judgeModel,
    executor: executorName,
    judgeExecutor: judgeExecutorName || executorName,
    noJudge,
    concurrency,
    timeoutMs,
    noCache,
    dryRun,
    blind,
    project,
    owner,
    tags,
  });

  if (!dryRun) {
    const mcpServers: McpServers | null = loadMcpConfig(mcpConfig);
    const mcpResolved = mcpServers ? await resolveMcpUrls(samples, mcpServers) : new Set<string>();
    await resolveUrls(samples, mcpResolved);
  }

  if (resolvedArtifacts.length === 0) {
    throw new Error(
      `未发现任何 skill 变体。请检查：\n`
      + `  1. skill 目录是否存在：${resolve(skillDir)}\n`
      + `  2. 目录下是否有 .md 文件或含 SKILL.md 的子目录\n`
      + `  3. 或通过 --variants 显式指定变体`,
    );
  }
  const tasks = buildTasksFromArtifacts(samples, resolvedArtifacts);
  const variantNames = resolvedArtifacts.map((artifact) => artifact.name);

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
        tasks: tasks.map((task) => {
          const config = buildVariantConfig(task.artifact);
          return {
            sample_id: task.sample_id,
            variant: task.variant,
            artifactKind: task.artifact.kind,
            artifactSource: task.artifact.source,
            executionStrategy: config.executionStrategy,
            experimentRole: config.experimentRole,
            cwd: task.cwd,
            promptPreview: task.prompt.slice(0, 100),
            hasRubric: Boolean(task.rubric),
            hasAssertions: Boolean(task.assertions?.length),
            hasDimensions: Boolean(task.dimensions && Object.keys(task.dimensions).length),
            hasSystem: Boolean(task.artifactContent),
          };
        }),
      },
      filePath: null,
    };
  }

  const executor: ExecutorFn = createExecutor(executorName);
  const judgeExecutor: ExecutorFn = createExecutor(judgeExecutorName || executorName);
  const runId = generateRunId(variantNames);
  const createdAt = new Date().toISOString();
  const { run: initialRun, startedAt } = createEvaluationRun(runId, createdAt);
  const jobId = `job-${runId}`;
  const resolvedJobStore = persistJob ? (jobStore ?? createFileJobStore(DEFAULT_JOBS_DIR)) : null;
  const queuedJob = createQueuedJob({ jobId, request, createdAt });
  if (resolvedJobStore) await resolvedJobStore.save(jobId, queuedJob);
  const runningJob = markJobRunning(queuedJob, runId, startedAt);
  if (resolvedJobStore) await resolvedJobStore.save(jobId, runningJob);
  try {
    if (!skipPreflight) {
      if (onProgress) onProgress({ phase: 'preflight', jobId });
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

    const finishedAt = new Date().toISOString();
    const run = finalizeEvaluationRun(initialRun, finishedAt);
    const job = createSucceededJob({
      jobId,
      runId,
      reportId: runId,
      request,
      createdAt,
      startedAt,
      finishedAt,
    });
    const report = aggregateReport({
      runId,
      variants: variantNames,
      model,
      judgeModel,
      noJudge,
      executorName,
      samples,
      tasks,
      results,
      totalCostUSD,
      artifacts: resolvedArtifacts,
      request,
      run,
      job,
    });
    report.analysis = analyzeResults(report);

    if (blind) {
      applyBlindMode(report, variantNames, `${variantNames.join(',')}:${samplesPath}`);
    }

    await stopAllServers();

    const filePath = persistReport(report, outputDir);
    if (resolvedJobStore) await resolvedJobStore.save(jobId, job);
    return { report, filePath };
  } catch (err: unknown) {
    const finishedAt = new Date().toISOString();
    const failedJob = createFailedJob({
      job: { ...runningJob, runId, startedAt, finishedAt: undefined },
      error: err instanceof Error ? err.message : String(err),
      finishedAt,
    });
    void failEvaluationRun(initialRun, finishedAt);
    if (resolvedJobStore) await resolvedJobStore.save(jobId, failedJob);
    await stopAllServers();
    throw err;
  }
}

interface DryRunEachSkill {
  name: string;
  samplesPath: string;
  sampleCount: number;
  taskCount: number;
}

export interface DryRunEachReport extends DryRunBase {
  each: true;
  totalArtifacts: number;
  artifacts: DryRunEachSkill[];
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
  project?: string;
  owner?: string;
  tags?: string[];
  noJudge?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  executorName?: string;
  judgeExecutorName?: string;
  jobStore?: JobStore | null;
  persistJob?: boolean;
  onProgress?: ProgressCallback | null;
  onSkillProgress?: ((info: SkillProgressInfo) => void) | null;
  skipPreflight?: boolean;
  mcpConfig?: string;
  verbose?: boolean;
}

interface SkillResult {
  name: string;
  artifactHash: string;
  samplesPath: string;
  sampleCount: number;
  summary: Record<string, VariantSummary>;
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
  project,
  owner,
  tags,
  noJudge = false,
  dryRun = false,
  concurrency = 1,
  timeoutMs,
  executorName = 'claude',
  judgeExecutorName,
  jobStore = null,
  persistJob = true,
  onProgress = null,
  onSkillProgress = null,
  skipPreflight = false,
  mcpConfig,
  verbose = false,
}: RunEachEvaluationOptions): Promise<{ report: Report | DryRunEachReport; filePath: string | null }> {
  const skillEntries = discoverEachSkills(resolve(skillDir));
  if (skillEntries.length === 0) {
    throw new Error(`未发现带配对 eval-samples 的 skill：${skillDir}`);
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
        totalArtifacts: drySkills.length,
        totalTasks: drySkills.reduce((sum, skill) => sum + skill.taskCount, 0),
        artifacts: drySkills,
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

    const skillArtifacts = resolveArtifacts(resolve(skillDir), ['baseline', entry.skillPath]).map((artifact) => (
      artifact.name === entry.skillPath ? { ...artifact, name: 'skill' } : artifact
    ));

    const { report } = await runEvaluation({
      samplesPath: entry.samplesPath,
      skillDir,
      artifacts: skillArtifacts,
      model,
      judgeModel,
      outputDir: null,
      noJudge,
      concurrency,
      timeoutMs,
      executorName,
      judgeExecutorName,
      jobStore: null,
      persistJob: false,
      onProgress,
      skipPreflight: skipPreflight || i > 0,
      mcpConfig,
      verbose,
    });

    const variantKey = 'skill';
    const fullReport = report as Report;
    const skillSummary = fullReport.summary[variantKey] || {};
    const artifactHash = fullReport.meta.artifactHashes?.[variantKey] || '';

    skillResults.push({
      name: entry.name,
      artifactHash,
      samplesPath: entry.samplesPath,
      sampleCount: fullReport.meta.sampleCount,
      summary: {
        baseline: fullReport.summary.baseline || ({} as VariantSummary),
        skill: skillSummary as VariantSummary,
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
    totalArtifacts: skillResults.length,
    totalSamples: skillResults.reduce((sum, skill) => sum + skill.sampleCount, 0),
    totalCostUSD: Number(totalCostUSD.toFixed(6)),
    artifacts: skillResults.map((skill) => {
      const bs = skill.summary.baseline;
      const ss = skill.summary.skill;
      const baselineScore = bs?.avgCompositeScore ?? bs?.avgLlmScore ?? null;
      const artifactScore = ss?.avgCompositeScore ?? ss?.avgLlmScore ?? null;
      let improvement: string | null = null;
      if (typeof baselineScore === 'number' && typeof artifactScore === 'number' && baselineScore > 0) {
        improvement = `${((artifactScore - baselineScore) / baselineScore * 100).toFixed(0)}%`;
        if (artifactScore >= baselineScore) improvement = `+${improvement}`;
      }
      return { name: skill.name, baselineScore, artifactScore, improvement: improvement ?? '-' };
    }),
  };

  const runId = generateRunId(['each']);
  const request = buildEvaluationRequest({
    samplesPath: '',
    skillDir,
    artifacts: skillEntries.map((entry) => ({
      name: entry.name,
      kind: 'skill',
      source: 'file-path',
      content: null,
      locator: entry.skillPath,
    })),
    model,
    judgeModel: noJudge ? null : judgeModel,
    executor: executorName,
    judgeExecutor: judgeExecutorName || executorName,
    noJudge,
    concurrency,
    timeoutMs,
    noCache: false,
    dryRun,
    blind: false,
    project,
    owner,
    tags,
  });
  const createdAt = new Date().toISOString();
  const { run: initialRun, startedAt } = createEvaluationRun(runId, createdAt);
  const finishedAt = new Date().toISOString();
  const run = finalizeEvaluationRun(initialRun, finishedAt);
  const job = createSucceededJob({
    jobId: `job-${runId}`,
    runId,
    reportId: runId,
    request,
    createdAt,
    startedAt,
    finishedAt,
  });
  const allVariantNames = skillEntries.map((entry) => entry.name);
  const totalSampleCount = skillResults.reduce((sum, skill) => sum + skill.sampleCount, 0);
  const combinedReport: Report = {
    id: runId,
    each: true,
    meta: {
      variants: allVariantNames,
      model,
      judgeModel: noJudge ? null : judgeModel,
      executor: executorName,
      sampleCount: totalSampleCount,
      taskCount: totalSampleCount * 2, // baseline + skill per sample
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      timestamp: new Date().toISOString(),
      cliVersion: '',  // populated by individual runs
      nodeVersion: process.version,
      artifactHashes: Object.fromEntries(
        skillResults.map((skill) => [skill.name, skill.artifactHash || 'no-skill']),
      ),
      request,
      run,
      job,
    },
    summary: {},
    results: [],
    overview,
    artifacts: skillResults,
  };

  const filePath = persistReport(combinedReport, outputDir);
  const resolvedJobStore = persistJob ? (jobStore ?? createFileJobStore(DEFAULT_JOBS_DIR)) : null;
  if (resolvedJobStore) await resolvedJobStore.save(job.jobId, job);
  return { report: combinedReport, filePath };
}

export interface RunMultipleOptions extends RunEvaluationOptions {
  repeat?: number;
  onRepeatProgress?: ((info: { run: number; total: number }) => void) | null;
}

export async function runMultiple({ repeat = 1, onRepeatProgress, ...config }: RunMultipleOptions): Promise<{ report: Report; aggregated: VarianceData | null; filePath: string | null }> {
  const runs: Report[] = [];
  const savedOutputDir = config.outputDir;
  for (let i = 0; i < repeat; i++) {
    if (onRepeatProgress) onRepeatProgress({ run: i + 1, total: repeat });
    // Only persist the last run's report; intermediate runs skip persistence and job tracking
    const isLast = i === repeat - 1;
    const { report } = await runEvaluation({
      ...config,
      outputDir: isLast ? savedOutputDir : null,
      persistJob: isLast,
    });
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
