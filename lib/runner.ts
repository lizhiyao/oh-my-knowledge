import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createExecutor, DEFAULT_MODEL, JUDGE_MODEL } from './executor.js';
import { grade } from './grader.js';
import { analyzeResults } from './analyzer.js';
import { confidenceInterval, tTest } from './statistics.js';
import { buildVariantResult, buildVariantSummary } from './schema.js';
import { resolveUrls } from './url-fetcher.js';
import { loadMcpConfig, resolveMcpUrls, stopAllServers } from './mcp-resolver.js';
import { createCache, cacheKey } from './cache.js';
import { loadSamples } from './load-samples.js';
import { discoverEachSkills, loadSkills } from './skill-loader.js';
import { buildTasks } from './task-planner.js';
export { loadSamples } from './load-samples.js';
export { discoverVariants, discoverEachSkills, loadSkills } from './skill-loader.js';
export { buildTasks } from './task-planner.js';

import type {
  ExecResult,
  ExecutorFn,
  Sample,
  Task,
  Report,
  VariantResult,
  VariantSummary,
  GradeResult,
  McpServers,
  ExecutorCache,
  GitInfo,
  VarianceData,
} from './types.js';

type ProgressCallback = (info: Record<string, unknown>) => void;

const __dirname = dirname(fileURLToPath(import.meta.url));
// Walk up until we find package.json (works from both source and dist)
function findPackageJson(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return join(startDir, '..', 'package.json');
}
const PKG: { version: string } = JSON.parse(readFileSync(findPackageJson(__dirname), 'utf-8'));

function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 12);
}

const DEFAULT_OUTPUT_DIR: string = join(homedir(), '.oh-my-knowledge', 'reports');

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

// ---------------------------------------------------------------------------
// Phase 4: Execute tasks
// ---------------------------------------------------------------------------

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

async function executeTasks({ tasks, executor, judgeExecutor, model, judgeModel, noJudge, samplesPath, concurrency, timeoutMs, noCache, verbose, onProgress }: ExecuteTasksOptions): Promise<{ results: Record<string, Record<string, VariantResult>>; totalCostUSD: number }> {
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

    // Check cache
    let execResult: ExecResult;
    const key = cacheKey(model, task.skillContent ?? '', task.prompt);
    const cached = cache?.get(key);
    if (cached) {
      execResult = { ...cached, cached: true };
    } else {
      execResult = await executor({ model, system: task.skillContent, prompt: task.prompt, cwd: task.cwd, timeoutMs, verbose });
      if (cache && execResult.ok) cache.set(key, execResult);
    }
    totalCostUSD += execResult.costUSD;

    // Verbose: log execution result with output preview
    if (verbose && onProgress) {
      onProgress({
        phase: 'exec_done', completed: idx, total,
        sample_id: task.sample_id, variant: task.variant,
        durationMs: execResult.durationMs, inputTokens: execResult.inputTokens,
        outputTokens: execResult.outputTokens, costUSD: execResult.costUSD,
        outputPreview: execResult.output ? execResult.output.slice(0, 200) : null,
      });
    }

    let gradeResult: GradeResult | null = null;
    if (execResult.ok && !noJudge) {
      const hasGradingCriteria = task.rubric || task.assertions?.length || (task.dimensions && Object.keys(task.dimensions).length);
      if (hasGradingCriteria) {
        // Verbose: log grading start
        if (verbose && onProgress) {
          onProgress({
            phase: 'grading', completed: idx, total,
            sample_id: task.sample_id, variant: task.variant,
          });
        }
        gradeResult = await grade({
          output: execResult.output!,
          sample: task._sample,
          executor: judgeExecutor,
          judgeModel,
          execMetrics: { costUSD: execResult.costUSD, durationMs: execResult.durationMs, numTurns: execResult.numTurns },
          samplesDir: dirname(resolve(samplesPath)),
        });
        if (gradeResult.judgeCostUSD) totalCostUSD += gradeResult.judgeCostUSD;
      }
    }

    completed++;
    if (onProgress) {
      onProgress({
        phase: 'done', completed, total,
        sample_id: task.sample_id, variant: task.variant,
        durationMs: execResult.durationMs, inputTokens: execResult.inputTokens,
        outputTokens: execResult.outputTokens, costUSD: execResult.costUSD,
        score: gradeResult?.compositeScore,
      });
    }

    if (!results[task.sample_id]) results[task.sample_id] = {};
    results[task.sample_id][task.variant] = buildVariantResult(execResult, gradeResult);
  }

  await runWithConcurrency(tasks, concurrency, executeTask);

  if (cache) cache.save();

  return { results, totalCostUSD };
}

// ---------------------------------------------------------------------------
// Phase 5: Aggregate report
// ---------------------------------------------------------------------------

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
  skills: Record<string, string | null>;
}

function aggregateReport({ runId, variants, model, judgeModel, noJudge, executorName, samples, tasks, results, totalCostUSD, skills }: AggregateReportOptions): Report {
  const summary: Record<string, VariantSummary> = {};
  for (const variant of variants) {
    const entries = Object.values(results).map((r) => r[variant]).filter(Boolean);
    summary[variant] = buildVariantSummary(entries);
  }

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
      skillHashes: Object.fromEntries(
        Object.entries(skills).map(([name, content]) => [name, content ? hashString(content) : 'no-skill']),
      ),
      gitInfo: getGitInfo(),
    },
    summary,
    results: Object.entries(results).map(([sample_id, variantData]) => ({
      sample_id,
      variants: variantData,
    })),
  };
}

// ---------------------------------------------------------------------------
// Phase 6: Blind relabeling
// ---------------------------------------------------------------------------

function applyBlindMode(report: Report, variants: string[], blindSeed: string): void {
  const labels = variants.map((_, i) => String.fromCharCode(65 + i));
  // Seed from deterministic input (variants + user-provided seed or samplesPath)
  // so same experiment setup always produces the same blind mapping
  let s = parseInt(hashString(blindSeed).slice(0, 8), 16) | 0;
  const seededRandom = (): number => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
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

  for (const r of report.results) {
    const newVariants: Record<string, VariantResult> = {};
    for (const [v, data] of Object.entries(r.variants)) {
      newVariants[reverseMap[v]] = data;
    }
    r.variants = newVariants;
  }
}

// ---------------------------------------------------------------------------
// Phase 7: Persist
// ---------------------------------------------------------------------------

interface PersistableReport {
  id: string;
}

function persistReport(report: PersistableReport, outputDir: string | null): string | null {
  if (!outputDir) return null;
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const filePath = join(outputDir, `${report.id}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function generateRunId(variants: string[]): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  const vs = variants.join('-vs-');
  return `${vs}-${date}-${time}`;
}

async function preflight(executor: ExecutorFn, model: string, timeoutMs: number = 15000): Promise<void> {
  const result = await executor({
    model, system: '', prompt: 'hi', cwd: process.cwd(), timeoutMs,
  });
  if (!result.ok) {
    throw new Error(`预检失败 [${model}]: ${result.error}`);
  }
}

interface DryRunTask {
  sample_id: string;
  variant: string;
  promptPreview: string;
  hasRubric: boolean;
  hasAssertions: boolean;
  hasDimensions: boolean;
  hasSystem: boolean;
}

interface DryRunReport {
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

interface RunEvaluationOptions {
  samplesPath: string;
  skillDir: string;
  variants?: string[];
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
  // 1. Load
  const samples = loadSamples(samplesPath);
  const skills = dryRun ? {} : loadSkills(resolve(skillDir), variants);

  // 2. Resolve URLs in prompts/contexts
  if (!dryRun) {
    const mcpServers: McpServers | null = loadMcpConfig(mcpConfig);
    if (mcpServers) {
      await resolveMcpUrls(samples, mcpServers);
    }
    await resolveUrls(samples);
  }

  // 3. Build tasks
  if (variants.length === 0) {
    throw new Error(
      `未发现任何 skill 变体。请检查：\n` +
      `  1. skill 目录是否存在：${resolve(skillDir)}\n` +
      `  2. 目录下是否有 .md 文件或含 SKILL.md 的子目录\n` +
      `  3. 或通过 --variants 显式指定变体`
    );
  }
  const tasks = buildTasks(samples, variants, skills);

  // 4. Dry-run early return
  if (dryRun) {
    return {
      report: {
        dryRun: true,
        model,
        judgeModel,
        variants,
        executor: executorName,
        samplesPath,
        skillDir,
        totalTasks: tasks.length,
        tasks: tasks.map((t) => ({
          sample_id: t.sample_id,
          variant: t.variant,
          promptPreview: t.prompt.slice(0, 100),
          hasRubric: Boolean(t.rubric),
          hasAssertions: Boolean(t.assertions?.length),
          hasDimensions: Boolean(t.dimensions && Object.keys(t.dimensions).length),
          hasSystem: Boolean(t.skillContent),
        })),
      },
      filePath: null,
    };
  }

  // 4. Preflight check
  const executor: ExecutorFn = createExecutor(executorName);
  const judgeExecutor: ExecutorFn = createExecutor(judgeExecutorName || executorName);
  if (!skipPreflight) {
    if (onProgress) onProgress({ phase: 'preflight' });
    await preflight(executor, model);
    if (!noJudge) await preflight(judgeExecutor, judgeModel);
  }

  // 5. Execute
  const { results, totalCostUSD } = await executeTasks({
    tasks, executor, judgeExecutor, model, judgeModel, noJudge, samplesPath, concurrency, timeoutMs, noCache, verbose, onProgress,
  });

  // 6. Aggregate
  const runId = generateRunId(variants);
  const report = aggregateReport({ runId, variants, model, judgeModel, noJudge, executorName, samples, tasks, results, totalCostUSD, skills });

  // 7. Analysis
  report.analysis = analyzeResults(report);

  // 8. Blind
  // Blind seed is deterministic: same variants + same samples = same mapping
  if (blind) applyBlindMode(report, variants, variants.join(',') + ':' + samplesPath);

  // 9. Cleanup MCP connections
  await stopAllServers();

  // 10. Persist
  const filePath = persistReport(report, outputDir);

  return { report, filePath };
}

// ---------------------------------------------------------------------------
// --each orchestrator
// ---------------------------------------------------------------------------

interface DryRunEachSkill {
  name: string;
  samplesPath: string;
  sampleCount: number;
  taskCount: number;
}

interface DryRunEachReport {
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

interface SkillProgressInfo {
  phase: string;
  skill: string;
  current: number;
  total: number;
}

interface RunEachEvaluationOptions {
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
    throw new Error('No skills with paired eval-samples found in: ' + skillDir);
  }

  if (dryRun) {
    const drySkills: DryRunEachSkill[] = [];
    for (const entry of skillEntries) {
      const samples = loadSamples(entry.samplesPath);
      drySkills.push({
        name: entry.name,
        samplesPath: entry.samplesPath,
        sampleCount: samples.length,
        taskCount: samples.length * 2, // baseline + skill
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
        totalTasks: drySkills.reduce((s, sk) => s + sk.taskCount, 0),
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

    const { report } = await runEvaluation({
      samplesPath: entry.samplesPath,
      skillDir,
      variants: ['baseline', entry.skillPath],
      model,
      judgeModel,
      outputDir: null, // don't persist individual reports
      noJudge,
      concurrency,
      timeoutMs,
      executorName,
      judgeExecutorName,
      onProgress,
      skipPreflight: skipPreflight || i > 0, // 只在第一个 skill 时预检
      mcpConfig,
      verbose,
    });

    // Remap variant key from file path to skill name
    const variantKey = entry.skillPath;
    const fullReport = report as Report;
    const skillSummary = fullReport.summary[variantKey] || {};
    const skillHash = fullReport.meta?.skillHashes?.[variantKey] || '';

    skillResults.push({
      name: entry.name,
      skillHash,
      samplesPath: entry.samplesPath,
      sampleCount: fullReport.meta.sampleCount,
      summary: {
        baseline: fullReport.summary.baseline || {},
        skill: skillSummary,
      },
      results: fullReport.results.map((r) => ({
        sample_id: r.sample_id,
        variants: {
          baseline: r.variants.baseline || r.variants['baseline'],
          skill: r.variants[variantKey],
        },
      })),
    });

    totalCostUSD += fullReport.meta.totalCostUSD;

    if (onSkillProgress) {
      onSkillProgress({ phase: 'done', skill: entry.name, current: i + 1, total: skillEntries.length });
    }
  }

  // Build overview
  const overview = {
    totalSkills: skillResults.length,
    totalSamples: skillResults.reduce((s, sk) => s + sk.sampleCount, 0),
    totalCostUSD: Number(totalCostUSD.toFixed(6)),
    skills: skillResults.map((sk) => {
      const bs = (sk.summary.baseline as VariantSummary)?.avgCompositeScore ?? (sk.summary.baseline as VariantSummary)?.avgLlmScore ?? null;
      const ss = (sk.summary.skill as VariantSummary)?.avgCompositeScore ?? (sk.summary.skill as VariantSummary)?.avgLlmScore ?? null;
      let improvement: string | null = null;
      if (typeof bs === 'number' && typeof ss === 'number' && bs > 0) {
        improvement = `${((ss - bs) / bs * 100).toFixed(0)}%`;
        if (ss >= bs) improvement = '+' + improvement;
      }
      return { name: sk.name, baselineScore: bs, skillScore: ss, improvement };
    }),
  };

  // Build combined report
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
      cliVersion: PKG.version,
      nodeVersion: process.version,
    },
    overview,
    skills: skillResults,
  };

  const filePath = persistReport(combinedReport, outputDir);
  return { report: combinedReport as unknown as Report, filePath };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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

interface RunMultipleOptions extends RunEvaluationOptions {
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

  const variants = runs[0].meta?.variants || [];
  const perVariant: Record<string, { scores: number[]; mean: number; lower: number; upper: number; stddev: number }> = {};
  for (const v of variants) {
    const scores = runs.map((r) => r.summary?.[v]?.avgCompositeScore).filter((s): s is number => typeof s === 'number');
    perVariant[v] = { scores, ...confidenceInterval(scores) };
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
