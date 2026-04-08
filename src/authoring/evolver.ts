import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { runEvaluation } from '../eval-workflows/run-evaluation.js';
import { createExecutor, DEFAULT_MODEL, JUDGE_MODEL } from '../executors/index.js';
import { persistReport, DEFAULT_OUTPUT_DIR, generateRunId } from '../eval-core/evaluation-reporting.js';
import { analyzeResults } from '../analysis/report-diagnostics.js';
import type { ProgressCallback, Report, ResultEntry, VariantResult } from '../types.js';

const IMPROVE_SYSTEM_PROMPT = `你是一个 AI 提示词改进专家。你的任务是分析评测结果中的薄弱环节，针对性地改进 skill（系统提示词），使其在评测中获得更高的分数。

改进原则：
1. 针对低分样本暴露的具体问题做改进，不要泛泛修改
2. 保留当前版本中已经表现良好的部分
3. 保持 skill 的整体结构和格式
4. 改进应该具体、可执行，不要空泛的描述

直接输出改进后的 skill 内容，不要包含 markdown 代码块标记或任何解释说明。`;

interface WeakSample {
  sample_id: string;
  compositeScore: number;
  llmReason: string | null;
  failedAssertions: string[];
  dimensions: Record<string, number> | null;
}

export function extractWeakSamples(report: Report, variantKey: string, count: number = 5): WeakSample[] {
  return report.results
    .map((r) => {
      const v = r.variants[variantKey];
      if (!v || typeof v.compositeScore !== 'number') return null;
      return {
        sample_id: r.sample_id,
        compositeScore: v.compositeScore,
        llmReason: v.llmReason || null,
        failedAssertions: v.assertions?.details?.filter((a) => !a.passed).map((a) => `${a.type}: ${a.value}`) || [],
        dimensions: v.dimensions
          ? Object.fromEntries(Object.entries(v.dimensions).map(([k, info]) => [k, typeof info === 'object' ? info.score : info as number]))
          : null,
      };
    })
    .filter((x): x is WeakSample => x !== null)
    .sort((a, b) => a.compositeScore - b.compositeScore)
    .slice(0, count);
}

export function buildImprovementPrompt(skillContent: string, score: number, weakSamples: WeakSample[]): string {
  const weakDetails = weakSamples.map((s) => {
    const parts = [`### ${s.sample_id}（${s.compositeScore}/5.0）`];
    if (s.llmReason) parts.push(`评委反馈: ${s.llmReason}`);
    if (s.failedAssertions.length > 0) parts.push(`失败断言: ${s.failedAssertions.join(', ')}`);
    if (s.dimensions) {
      const dimStr = Object.entries(s.dimensions).map(([k, v]) => `${k}: ${v}`).join(', ');
      parts.push(`维度分数: ${dimStr}`);
    }
    return parts.join('\n');
  }).join('\n\n');

  return `## 当前 Skill（平均分: ${score.toFixed(2)}/5.0）

${skillContent}

## 低分样本分析

${weakDetails || '（无低分样本）'}

请基于以上分析改进 Skill，使其在这些场景中表现更好。直接输出改进后的完整 Skill 内容。`;
}

function parseImprovedSkill(output: string): string {
  let content = output.trim();
  // Strip markdown code fences if present
  const match = content.match(/```(?:markdown|md)?\s*([\s\S]*?)```/);
  if (match) content = match[1].trim();
  // Strip leading explanation lines before the actual skill content
  if (content.startsWith('以下是') || content.startsWith('改进后')) {
    const lines = content.split('\n');
    const startIdx = lines.findIndex((l) => l.startsWith('#') || l.startsWith('你是'));
    if (startIdx > 0) content = lines.slice(startIdx).join('\n');
  }
  return content;
}

/** @deprecated Use ProgressCallback from evaluation-core.ts */
export type EvolveProgressInfo = Parameters<ProgressCallback>[0];

export interface EvolveRoundProgressInfo {
  round: number;
  totalRounds: number;
  phase: string;
  score?: number;
  delta?: number;
  accepted?: boolean;
  costUSD?: number;
  error?: string;
}

interface EvolveOptions {
  skillPath: string;
  samplesPath: string;
  rounds?: number;
  target?: number | null;
  model?: string;
  judgeModel?: string;
  improveModel?: string;
  executorName?: string;
  concurrency?: number;
  timeoutMs?: number;
  onProgress?: ProgressCallback | null;
  onRoundProgress?: ((progress: EvolveRoundProgressInfo) => void) | null;
}

interface TrajectoryEntry {
  round: number;
  score: number;
  delta: number;
  accepted: boolean;
  costUSD: number;
}

export interface EvolveResult {
  startScore: number;
  finalScore: number;
  bestRound: number;
  totalRounds: number;
  totalCostUSD: number;
  trajectory: TrajectoryEntry[];
  bestSkillPath: string;
  allVersions: string[];
  reportId?: string;
}

export interface RoundReport {
  round: number;
  accepted: boolean;
  report: Report;
}

export function mergeEvolveReports(roundReports: RoundReport[], skillName: string, totalCostUSD: number): Report {
  const firstReport = roundReports[0].report;

  // Build variant labels: "round-0", "round-1", "round-2", ...
  const variantLabels = roundReports.map(({ round }) => `round-${round}`);

  // Build summary: map each variant label to its round's summary
  const summary: Record<string, Report['summary'][string]> = {};
  for (let i = 0; i < roundReports.length; i++) {
    const { report } = roundReports[i];
    const originalKey = Object.keys(report.summary)[0];
    summary[variantLabels[i]] = report.summary[originalKey];
  }

  // Build results: merge per-sample variant data across rounds
  const sampleIds = firstReport.results.map((r) => r.sample_id);
  const results: ResultEntry[] = sampleIds.map((sampleId) => {
    const variants: Record<string, VariantResult> = {};
    for (let i = 0; i < roundReports.length; i++) {
      const entry = roundReports[i].report.results.find((r) => r.sample_id === sampleId);
      if (entry) {
        const originalKey = Object.keys(entry.variants)[0];
        variants[variantLabels[i]] = entry.variants[originalKey];
      }
    }
    return { sample_id: sampleId, variants };
  });

  // Build variantConfigs: collect from each round, relabel variant name; mark round-0 as baseline
  const variantConfigs = roundReports.flatMap(({ round, report }, i) =>
    (report.meta.variantConfigs || []).map((cfg) => ({
      ...cfg,
      variant: variantLabels[i],
      ...(round === 0 ? { experimentType: 'baseline' as const, artifactKind: 'baseline' as const, executionStrategy: 'baseline' as const } : {}),
    })),
  );

  // Build artifactHashes: collect from each round, relabel key
  const artifactHashes: Record<string, string> = {};
  for (let i = 0; i < roundReports.length; i++) {
    const hashes = roundReports[i].report.meta.artifactHashes || {};
    const originalKey = Object.keys(hashes)[0];
    if (originalKey) artifactHashes[variantLabels[i]] = hashes[originalKey];
  }

  const runId = `evolve-${skillName}-${generateRunId([skillName]).split('-').slice(-2).join('-')}`;

  const report: Report = {
    id: runId,
    meta: {
      ...firstReport.meta,
      variants: variantLabels,
      variantConfigs,
      artifactHashes,
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      timestamp: new Date().toISOString(),
    },
    summary,
    results,
  };

  report.analysis = analyzeResults(report);

  return report;
}

export async function evolveSkill({
  skillPath,
  samplesPath,
  rounds = 5,
  target = null,
  model = DEFAULT_MODEL,
  judgeModel = JUDGE_MODEL,
  improveModel = DEFAULT_MODEL,
  executorName = 'claude',
  concurrency = 1,
  timeoutMs,
  onProgress = null,
  onRoundProgress = null,
}: EvolveOptions): Promise<EvolveResult> {
  const absSkillPath = resolve(skillPath);
  const absSamplesPath = resolve(samplesPath);
  const skillDir = dirname(absSkillPath);
  const skillName = basename(absSkillPath, '.md');
  const evolveDir = join(skillDir, 'evolve');

  if (!existsSync(absSkillPath)) throw new Error(`skill 文件未找到: ${absSkillPath}`);
  if (!existsSync(absSamplesPath)) throw new Error(`样本文件未找到: ${absSamplesPath}`);
  mkdirSync(evolveDir, { recursive: true });

  // Save original as r0
  let currentBest = readFileSync(absSkillPath, 'utf-8').trim();
  const r0Path = join(evolveDir, `${skillName}.r0.md`);
  writeFileSync(r0Path, currentBest);
  const allVersions: string[] = [r0Path];

  let bestScore = 0;
  let bestRound = 0;
  let totalCostUSD = 0;
  let consecutiveRejects = 0;
  const trajectory: TrajectoryEntry[] = [];
  const roundReports: RoundReport[] = [];

  // Round 0: baseline evaluation
  const baselineReport = await evaluate(r0Path, {
    samplesPath: absSamplesPath, skillDir, model, judgeModel, executorName, concurrency, timeoutMs, onProgress,
  });
  const baselineVariantKey = Object.keys(baselineReport.summary)[0];
  bestScore = baselineReport.summary[baselineVariantKey]?.avgCompositeScore ?? 0;
  const baselineCost = baselineReport.meta.totalCostUSD;
  totalCostUSD += baselineCost;

  trajectory.push({ round: 0, score: bestScore, delta: 0, accepted: true, costUSD: baselineCost });
  roundReports.push({ round: 0, accepted: true, report: baselineReport });
  if (onRoundProgress) onRoundProgress({ round: 0, totalRounds: rounds, phase: 'baseline', score: bestScore, costUSD: baselineCost });

  // Evolution loop
  for (let round = 1; round <= rounds; round++) {
    // Extract weak samples from last accepted evaluation
    const lastReport = round === 1 ? baselineReport : await evaluate(allVersions[bestRound], {
      samplesPath: absSamplesPath, skillDir, model, judgeModel, executorName, concurrency, timeoutMs, onProgress,
    });
    const lastVariantKey = Object.keys(lastReport.summary)[0];
    const weakSamples = extractWeakSamples(lastReport, lastVariantKey);

    // Generate improvement
    const improvePrompt = buildImprovementPrompt(currentBest, bestScore, weakSamples);
    const executor = createExecutor(executorName);
    const improveResult = await executor({ model: improveModel, system: IMPROVE_SYSTEM_PROMPT, prompt: improvePrompt, timeoutMs });

    if (!improveResult.ok) {
      if (onRoundProgress) onRoundProgress({ round, totalRounds: rounds, phase: 'error', error: improveResult.error });
      consecutiveRejects++;
      trajectory.push({ round, score: bestScore, delta: 0, accepted: false, costUSD: improveResult.costUSD });
      totalCostUSD += improveResult.costUSD;
      if (consecutiveRejects >= 2) break;
      continue;
    }

    const candidateContent = parseImprovedSkill(improveResult.output!);
    const candidatePath = join(evolveDir, `${skillName}.r${round}.md`);
    writeFileSync(candidatePath, candidateContent);
    allVersions.push(candidatePath);

    // Evaluate candidate
    const candidateReport = await evaluate(candidatePath, {
      samplesPath: absSamplesPath, skillDir, model, judgeModel, executorName, concurrency, timeoutMs, onProgress,
    });
    const candidateVariantKey = Object.keys(candidateReport.summary)[0];
    const candidateScore = candidateReport.summary[candidateVariantKey]?.avgCompositeScore ?? 0;
    const roundCost = improveResult.costUSD + candidateReport.meta.totalCostUSD;
    totalCostUSD += roundCost;

    const delta = candidateScore - bestScore;
    const accepted = candidateScore > bestScore;
    roundReports.push({ round, accepted, report: candidateReport });

    if (accepted) {
      currentBest = candidateContent;
      bestScore = candidateScore;
      bestRound = round;
      consecutiveRejects = 0;
    } else {
      consecutiveRejects++;
    }

    trajectory.push({ round, score: candidateScore, delta, accepted, costUSD: roundCost });
    if (onRoundProgress) onRoundProgress({ round, totalRounds: rounds, phase: 'done', score: candidateScore, delta, accepted, costUSD: roundCost });

    // Early stop
    if (target && bestScore >= target) break;
    if (consecutiveRejects >= 2) break;
  }

  // Write best version back to original file
  writeFileSync(absSkillPath, currentBest);

  // Merge all round reports into one and persist
  let reportId: string | undefined;
  if (roundReports.length > 0) {
    const mergedReport = mergeEvolveReports(roundReports, skillName, totalCostUSD);
    persistReport(mergedReport, DEFAULT_OUTPUT_DIR);
    reportId = mergedReport.id;
  }

  return {
    startScore: trajectory[0].score,
    finalScore: bestScore,
    bestRound,
    totalRounds: trajectory.length - 1, // excluding baseline
    totalCostUSD: Number(totalCostUSD.toFixed(6)),
    trajectory,
    bestSkillPath: allVersions[bestRound],
    allVersions,
    reportId,
  };
}

interface EvaluateOptions {
  samplesPath: string;
  skillDir: string;
  model: string;
  judgeModel: string;
  executorName: string;
  concurrency: number;
  timeoutMs?: number;
  onProgress: ((progress: EvolveProgressInfo) => void) | null;
}

async function evaluate(skillFilePath: string, { samplesPath, skillDir, model, judgeModel, executorName, concurrency, timeoutMs, onProgress }: EvaluateOptions): Promise<Report> {
  const { report } = await runEvaluation({
    samplesPath,
    skillDir,
    variants: [skillFilePath],
    model,
    judgeModel,
    outputDir: null, // don't persist intermediate reports
    concurrency,
    timeoutMs,
    executorName,
    onProgress,
  });
  return report as Report;
}
