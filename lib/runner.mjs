import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, basename, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createExecutor, DEFAULT_MODEL, JUDGE_MODEL } from './executor.mjs';
import { grade } from './grader.mjs';
import { parseYaml } from './yaml-parser.mjs';
import { analyzeResults } from './analyzer.mjs';
import { mean, stddev, confidenceInterval, tTest } from './statistics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

function hashString(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 12);
}

const DEFAULT_OUTPUT_DIR = join(homedir(), '.oh-my-knowledge', 'reports');

function loadSkills(skillDir, variants, executorName = 'claude') {
  const skills = {};

  if (executorName === 'script') {
    // Script mode: variants are subdirectory names under skillDir
    // Each subdirectory is a complete skill package
    for (const v of variants) {
      const dirPath = resolve(join(skillDir, v));
      if (!existsSync(dirPath)) {
        throw new Error(`skill directory not found: ${dirPath}`);
      }
      // Store the absolute path to the skill directory
      skills[v] = dirPath;
    }
  } else {
    // Model mode: load skill content as system prompt
    // Supports two layouts:
    //   1. skills/v1.md              — variant is a .md file
    //   2. skills/v1/SKILL.md        — variant is a directory with SKILL.md inside
    for (const v of variants) {
      const mdPath = join(skillDir, v + '.md');
      const dirSkillPath = join(skillDir, v, 'SKILL.md');
      if (existsSync(mdPath)) {
        skills[v] = readFileSync(mdPath, 'utf-8').trim();
      } else if (existsSync(dirSkillPath)) {
        skills[v] = readFileSync(dirSkillPath, 'utf-8').trim();
      } else {
        throw new Error(`skill not found: ${mdPath} or ${dirSkillPath}`);
      }
    }
  }

  return skills;
}

function generateRunId(variants) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${variants.join('-')}-${rand}`;
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
  executorName = 'claude',
  onProgress = null,
}) {
  const rawContent = readFileSync(resolve(samplesPath), 'utf-8');
  const samples = samplesPath.endsWith('.yaml') || samplesPath.endsWith('.yml')
    ? parseYaml(rawContent)
    : JSON.parse(rawContent);
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(`invalid samples file: ${samplesPath}`);
  }
  // Validate required fields in each sample
  for (const [i, s] of samples.entries()) {
    if (!s.sample_id) throw new Error(`samples[${i}] missing required field: sample_id`);
    if (!s.prompt) throw new Error(`samples[${i}] (${s.sample_id}) missing required field: prompt`);
  }

  const skills = dryRun ? {} : loadSkills(resolve(skillDir), variants, executorName);
  const executor = dryRun ? null : createExecutor(executorName);
  // Judge always uses claude executor, regardless of the task executor
  const judgeExecutor = dryRun ? null : createExecutor('claude');

  // Build tasks: interleaved scheduling (s1-v1, s1-v2, s2-v1, s2-v2, ...)
  const tasks = [];
  for (const sample of samples) {
    for (const variant of variants) {
      const userPrompt = sample.context
        ? `${sample.prompt}\n\n\`\`\`\n${sample.context}\n\`\`\``
        : sample.prompt;
      tasks.push({
        sample_id: sample.sample_id,
        variant,
        prompt: userPrompt,
        rubric: sample.rubric || null,
        assertions: sample.assertions || null,
        dimensions: sample.dimensions || null,
        system: skills[variant] || null,
        _sample: sample,
      });
    }
  }

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
          hasSystem: Boolean(t.system),
        })),
      },
      filePath: null,
    };
  }

  // Execute (with concurrency support)
  const results = {};
  let started = 0;
  let completed = 0;
  let totalCostUSD = 0;

  async function executeTask(task) {
    started++;
    if (onProgress) {
      onProgress({ phase: 'start', completed: started, total: tasks.length, sample_id: task.sample_id, variant: task.variant });
    }

    const execResult = await executor({ model, system: task.system, prompt: task.prompt });
    totalCostUSD += execResult.costUSD;

    // Grade the output
    let gradeResult = null;
    if (execResult.ok && !noJudge) {
      const hasGradingCriteria = task.rubric || task.assertions?.length || (task.dimensions && Object.keys(task.dimensions).length);
      if (hasGradingCriteria) {
        gradeResult = await grade({
          output: execResult.output,
          sample: task._sample,
          executor: judgeExecutor,
          judgeModel,
          execMetrics: { costUSD: execResult.costUSD, durationMs: execResult.durationMs },
          samplesDir: dirname(resolve(samplesPath)),
        });
        if (gradeResult.judgeCostUSD) totalCostUSD += gradeResult.judgeCostUSD;
      }
    }

    completed++;
    if (onProgress) {
      onProgress({
        phase: 'done', completed, total: tasks.length,
        sample_id: task.sample_id, variant: task.variant,
        durationMs: execResult.durationMs, inputTokens: execResult.inputTokens,
        outputTokens: execResult.outputTokens, costUSD: execResult.costUSD,
        score: gradeResult?.compositeScore,
      });
    }

    if (!results[task.sample_id]) results[task.sample_id] = {};
    results[task.sample_id][task.variant] = {
      ok: execResult.ok,
      durationMs: execResult.durationMs,
      durationApiMs: execResult.durationApiMs,
      inputTokens: execResult.inputTokens,
      outputTokens: execResult.outputTokens,
      totalTokens: execResult.inputTokens + execResult.outputTokens,
      cacheReadTokens: execResult.cacheReadTokens,
      cacheCreationTokens: execResult.cacheCreationTokens,
      costUSD: execResult.costUSD,
      numTurns: execResult.numTurns,
      ...(execResult.error && { error: execResult.error }),
      ...(gradeResult && {
        compositeScore: gradeResult.compositeScore,
        ...(gradeResult.assertions && { assertions: gradeResult.assertions }),
        ...(gradeResult.llmScore != null && { llmScore: gradeResult.llmScore }),
        ...(gradeResult.llmReason && { llmReason: gradeResult.llmReason }),
        ...(gradeResult.dimensions && { dimensions: gradeResult.dimensions }),
      }),
      outputPreview: execResult.output ? execResult.output.slice(0, 200) : null,
    };
  }

  await runWithConcurrency(tasks, concurrency, executeTask);

  // Build summary
  const summary = {};
  for (const variant of variants) {
    const entries = Object.values(results).map((r) => r[variant]).filter(Boolean);
    const ok = entries.filter((e) => e.ok);
    const compositeScores = entries.filter((e) => typeof e.compositeScore === 'number' && e.compositeScore > 0).map((e) => e.compositeScore);
    const assertionScores = entries.filter((e) => e.assertions?.score > 0).map((e) => e.assertions.score);
    const llmScores = entries.filter((e) => typeof e.llmScore === 'number' && e.llmScore > 0).map((e) => e.llmScore);

    const errorCount = entries.length - ok.length;

    summary[variant] = {
      // Stability
      totalSamples: entries.length,
      successCount: ok.length,
      errorCount,
      errorRate: entries.length > 0 ? Number((errorCount / entries.length * 100).toFixed(1)) : 0,
      // Efficiency
      avgDurationMs: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.durationMs, 0) / ok.length) : 0,
      // Cost
      avgInputTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.inputTokens, 0) / ok.length) : 0,
      avgOutputTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.outputTokens, 0) / ok.length) : 0,
      avgTotalTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.totalTokens, 0) / ok.length) : 0,
      totalCostUSD: ok.reduce((s, e) => s + (e.costUSD || 0), 0),
      // Quality
      ...(compositeScores.length > 0 && {
        avgCompositeScore: Number((compositeScores.reduce((s, v) => s + v, 0) / compositeScores.length).toFixed(2)),
        minCompositeScore: Number(Math.min(...compositeScores).toFixed(2)),
        maxCompositeScore: Number(Math.max(...compositeScores).toFixed(2)),
      }),
      ...(assertionScores.length > 0 && {
        avgAssertionScore: Number((assertionScores.reduce((s, v) => s + v, 0) / assertionScores.length).toFixed(2)),
      }),
      ...(llmScores.length > 0 && {
        avgLlmScore: Number((llmScores.reduce((s, v) => s + v, 0) / llmScores.length).toFixed(2)),
        minLlmScore: Math.min(...llmScores),
        maxLlmScore: Math.max(...llmScores),
      }),
    };
  }

  const runId = generateRunId(variants);
  const report = {
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
        Object.entries(skills).map(([name, content]) => {
          if (executorName === 'script' && existsSync(join(content, 'SKILL.md'))) {
            // In script mode, hash the SKILL.md content for traceability
            return [name, hashString(readFileSync(join(content, 'SKILL.md'), 'utf-8'))];
          }
          return [name, hashString(content)];
        }),
      ),
    },
    summary,
    results: Object.entries(results).map(([sample_id, variantData]) => ({
      sample_id,
      variants: variantData,
    })),
  };

  // Auto-analysis
  report.analysis = analyzeResults(report);

  // Blind A/B: relabel variants to hide real names
  if (blind) {
    const labels = variants.map((_, i) => String.fromCharCode(65 + i)); // A, B, C, ...
    // Seeded Fisher-Yates shuffle for reproducibility (seed = runId hash)
    // mulberry32 PRNG seeded from hash
    let s = parseInt(hashString(runId).slice(0, 8), 16) | 0;
    const seededRandom = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const shuffled = [...variants];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const blindMap = Object.fromEntries(shuffled.map((v, i) => [labels[i], v]));
    const reverseMap = Object.fromEntries(Object.entries(blindMap).map(([label, v]) => [v, label]));

    report.meta.blind = true;
    report.meta.blindMap = blindMap;
    report.meta.variants = labels;

    // Relabel summary
    const newSummary = {};
    for (const [v, stats] of Object.entries(report.summary)) {
      newSummary[reverseMap[v]] = stats;
    }
    report.summary = newSummary;

    // Relabel per-sample results
    for (const r of report.results) {
      const newVariants = {};
      for (const [v, data] of Object.entries(r.variants)) {
        newVariants[reverseMap[v]] = data;
      }
      r.variants = newVariants;
    }
  }

  // Persist
  if (outputDir) {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    const filePath = join(outputDir, `${runId}.json`);
    writeFileSync(filePath, JSON.stringify(report, null, 2));
    return { report, filePath };
  }

  return { report, filePath: null };
}

/**
 * Run tasks with bounded concurrency.
 * Workers pick tasks in order (preserving interleaved scheduling).
 */
async function runWithConcurrency(tasks, concurrency, fn) {
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      await fn(tasks[i]);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
}

/**
 * Run evaluation multiple times and aggregate results with variance analysis.
 *
 * @param {object} config - Same as runEvaluation config, plus `repeat`
 * @returns {{ report, aggregated, filePath }}
 */
export async function runMultiple({ repeat = 1, onRepeatProgress, ...config }) {
  const runs = [];
  for (let i = 0; i < repeat; i++) {
    if (onRepeatProgress) onRepeatProgress({ run: i + 1, total: repeat });
    const { report } = await runEvaluation(config);
    runs.push(report);
  }

  if (runs.length === 1) {
    return { report: runs[0], aggregated: null, filePath: null };
  }

  const variants = runs[0].meta?.variants || [];

  // Collect per-variant composite scores across runs
  const perVariant = {};
  for (const v of variants) {
    const scores = runs
      .map((r) => r.summary?.[v]?.avgCompositeScore)
      .filter((s) => typeof s === 'number');
    perVariant[v] = {
      scores,
      ...confidenceInterval(scores),
    };
  }

  // Pairwise t-tests
  const comparisons = [];
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const a = perVariant[variants[i]].scores;
      const b = perVariant[variants[j]].scores;
      comparisons.push({
        a: variants[i],
        b: variants[j],
        ...tTest(a, b),
      });
    }
  }

  const aggregated = {
    runs: repeat,
    perVariant,
    comparisons,
  };

  // Return last run's report with aggregated data attached
  const report = runs[runs.length - 1];
  report.variance = aggregated;

  return { report, aggregated, filePath: null };
}
