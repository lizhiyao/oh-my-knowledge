import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCache, cacheKey } from './cache.js';
import { buildVariantResult, buildVariantSummary } from './schema.js';
import { grade } from './grader.js';
import { checkFacts } from './fact-checker.js';
import type { FactCheckResult } from './fact-checker.js';
import { buildVariantConfig, resolveExecutionStrategy } from './execution-strategy.js';

import type {
  Artifact,
  ExecResult,
  ExecutorFn,
  Sample,
  Task,
  Report,
  VariantResult,
  VariantSummary,
  GradeResult,
  ExecutorCache,
  GitInfo,
  EvaluationJob,
  EvaluationRequest,
  EvaluationRun,
} from './types.js';

export interface ProgressStart {
  phase: 'start';
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
}

export interface ProgressExecDone {
  phase: 'exec_done';
  strategy: string;
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  outputPreview: string | null;
}

export interface ProgressGrading {
  phase: 'grading';
  strategy: string;
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
}

export interface ProgressDone {
  phase: 'done';
  strategy: string;
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  score?: number;
}

export interface ProgressPreflight {
  phase: 'preflight';
  jobId?: string;
}

export type ProgressInfo = ProgressStart | ProgressExecDone | ProgressGrading | ProgressDone | ProgressPreflight;

export type ProgressCallback = (info: ProgressInfo) => void;

const __dirname = dirname(fileURLToPath(import.meta.url));

function findPackageJson(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return join(startDir, '..', 'package.json');
}

const PKG: { version: string } = JSON.parse(readFileSync(findPackageJson(__dirname), 'utf-8')) as { version: string };

export const DEFAULT_OUTPUT_DIR: string = join(homedir(), '.oh-my-knowledge', 'reports');

function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 12);
}

function getGitInfo(): GitInfo | null {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trim().length > 0;
    return { commit, commitShort: commit.slice(0, 7), branch, dirty };
  } catch {
    return null;
  }
}

interface ExecuteTasksOptions {
  tasks: Task[];
  executor: ExecutorFn;
  judgeExecutor: ExecutorFn;
  model: string;
  judgeModel: string;
  noJudge: boolean;
  samplesPath: string;
  concurrency: number;
  timeoutMs?: number;
  noCache: boolean;
  verbose: boolean;
  onProgress?: ProgressCallback | null;
}

async function runWithConcurrency<T>(tasks: T[], concurrency: number, fn: (task: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      await fn(tasks[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
}

export async function executeTasks({ tasks, executor, judgeExecutor, model, judgeModel, noJudge, samplesPath, concurrency, timeoutMs, noCache, verbose, onProgress }: ExecuteTasksOptions): Promise<{ results: Record<string, Record<string, VariantResult>>; totalCostUSD: number }> {
  const results: Record<string, Record<string, VariantResult>> = {};
  let started = 0;
  let completed = 0;
  let totalCostUSD = 0;

  const cacheDir = join(homedir(), '.oh-my-knowledge', 'cache');
  const cache: ExecutorCache | null = noCache ? null : createCache(cacheDir);

  async function executeTask(task: Task): Promise<void> {
    started++;
    const idx = started;
    const total = tasks.length;
    if (onProgress) {
      onProgress({ phase: 'start', completed: idx, total, sample_id: task.sample_id, variant: task.variant });
    }

    const executionPlan = resolveExecutionStrategy(task, model, timeoutMs, verbose);

    let execResult: ExecResult;
    const key = cacheKey(model, executionPlan.cacheSystem, executionPlan.input.prompt, executionPlan.input.cwd);
    const cached = cache?.get(key);
    const execStart = Date.now();
    if (cached) {
      execResult = { ...cached, cached: true };
    } else {
      execResult = await executor(executionPlan.input);
      if (cache && execResult.ok) cache.set(key, execResult);
    }
    const execMs = Date.now() - execStart;
    totalCostUSD += execResult.costUSD;

    if (verbose && onProgress) {
      onProgress({
        phase: 'exec_done',
        strategy: executionPlan.strategy,
        completed: idx,
        total,
        sample_id: task.sample_id,
        variant: task.variant,
        durationMs: execResult.durationMs,
        inputTokens: execResult.inputTokens,
        outputTokens: execResult.outputTokens,
        costUSD: execResult.costUSD,
        outputPreview: execResult.output ? execResult.output.slice(0, 200) : null,
      });
    }

    let gradeResult: GradeResult | null = null;
    let gradeMs = 0;
    if (execResult.ok && !noJudge) {
      const hasGradingCriteria = task.rubric || task.assertions?.length || (task.dimensions && Object.keys(task.dimensions).length);
      if (hasGradingCriteria) {
        if (verbose && onProgress) {
          onProgress({
            phase: 'grading',
            strategy: executionPlan.strategy,
            completed: idx,
            total,
            sample_id: task.sample_id,
            variant: task.variant,
          });
        }
        const gradeStart = Date.now();
        gradeResult = await grade({
          output: execResult.output!,
          sample: task._sample,
          executor: judgeExecutor,
          judgeModel,
          execMetrics: { costUSD: execResult.costUSD, durationMs: execResult.durationMs, numTurns: execResult.numTurns, toolCalls: execResult.toolCalls, turns: execResult.turns },
          samplesDir: dirname(resolve(samplesPath)),
        });
        gradeMs = Date.now() - gradeStart;
        if (gradeResult.judgeCostUSD) totalCostUSD += gradeResult.judgeCostUSD;
      }
    }

    completed++;
    if (onProgress) {
      onProgress({
        phase: 'done',
        strategy: executionPlan.strategy,
        completed,
        total,
        sample_id: task.sample_id,
        variant: task.variant,
        durationMs: execResult.durationMs,
        inputTokens: execResult.inputTokens,
        outputTokens: execResult.outputTokens,
        costUSD: execResult.costUSD,
        score: gradeResult?.compositeScore,
      });
    }

    // Fact check — verify file paths in agent output
    let factCheck: FactCheckResult | undefined;
    if (execResult.ok && execResult.output && task.cwd) {
      factCheck = checkFacts(execResult.output, resolve(task.cwd));
    }

    if (!results[task.sample_id]) results[task.sample_id] = {};
    results[task.sample_id][task.variant] = buildVariantResult(execResult, gradeResult, { execMs, gradeMs, factCheck });
  }

  try {
    await runWithConcurrency(tasks, concurrency, executeTask);
  } finally {
    // Persist cache even on partial failure to preserve successful results
    if (cache) cache.save();
  }

  return { results, totalCostUSD };
}

interface AggregateReportOptions {
  runId: string;
  variants: string[];
  model: string;
  judgeModel: string;
  noJudge: boolean;
  executorName: string;
  samples: Sample[];
  tasks: Task[];
  results: Record<string, Record<string, VariantResult>>;
  totalCostUSD: number;
  artifacts: Artifact[];
  request?: EvaluationRequest;
  run?: EvaluationRun;
  job?: EvaluationJob;
}

export function aggregateReport({ runId, variants, model, judgeModel, noJudge, executorName, samples, tasks, results, totalCostUSD, artifacts, request, run, job }: AggregateReportOptions): Report {
  const summary: Record<string, VariantSummary> = {};
  for (const variant of variants) {
    const entries = Object.values(results).map((r) => r[variant]).filter(Boolean);
    summary[variant] = buildVariantSummary(entries);
  }

  const artifactHashes = Object.fromEntries(
    artifacts.map((artifact) => [artifact.name, artifact.content ? hashString(artifact.content) : 'no-skill']),
  );

  return {
    id: runId,
    meta: {
      variants,
      model,
      judgeModel: noJudge ? null : judgeModel,
      executor: executorName,
      sampleCount: samples.length,
      taskCount: tasks.length,
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      timestamp: new Date().toISOString(),
      cliVersion: PKG.version,
      nodeVersion: process.version,
      artifactHashes,
      variantConfigs: artifacts.map(buildVariantConfig),
      request,
      run,
      job,
      gitInfo: getGitInfo(),
    },
    summary,
    results: Object.entries(results).map(([sample_id, variantData]) => ({
      sample_id,
      variants: variantData,
    })),
  };
}

export function applyBlindMode(report: Report, variants: string[], blindSeed: string): void {
  const labels = variants.map((_, i) => String.fromCharCode(65 + i));
  let s = parseInt(hashString(blindSeed).slice(0, 8), 16) | 0;
  const seededRandom = (): number => {
    s |= 0;
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const shuffled = [...variants];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(seededRandom() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const blindMap: Record<string, string> = Object.fromEntries(shuffled.map((v, i) => [labels[i], v]));
  const reverseMap: Record<string, string> = Object.fromEntries(Object.entries(blindMap).map(([label, v]) => [v, label]));

  report.meta.blind = true;
  report.meta.blindMap = blindMap;
  report.meta.variants = labels;

  const newSummary: Record<string, VariantSummary> = {};
  for (const [v, stats] of Object.entries(report.summary)) {
    newSummary[reverseMap[v]] = stats;
  }
  report.summary = newSummary;

  for (const result of report.results) {
    const newVariants: Record<string, VariantResult> = {};
    for (const [v, data] of Object.entries(result.variants)) {
      newVariants[reverseMap[v]] = data;
    }
    result.variants = newVariants;
  }
}

export interface PersistableReport {
  id: string;
}

export function persistReport(report: PersistableReport, outputDir: string | null): string | null {
  if (!outputDir) return null;
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const filePath = join(outputDir, `${report.id}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

export function generateRunId(variants: string[]): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  const vs = variants
    .map((variant) => variant.replaceAll(/[\\/:]/g, '-').replaceAll(/[^a-zA-Z0-9._@-]/g, '_'))
    .join('-vs-');
  return `${vs}-${date}-${time}`;
}

export async function preflight(executor: ExecutorFn, model: string, timeoutMs: number = 15000): Promise<void> {
  const result = await executor({
    model,
    system: '',
    prompt: 'hi',
    cwd: process.cwd(),
    timeoutMs,
  });
  if (!result.ok) {
    throw new Error(`预检失败 [${model}]: ${result.error}`);
  }
}
