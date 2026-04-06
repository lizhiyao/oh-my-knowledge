import { buildEvaluationRequest, createEvaluationRun, createSucceededJob, finalizeEvaluationRun } from '../evaluation-job.js';
import { generateRunId } from '../infrastructure/index.js';
import type { Report, VariantResult, VariantSummary } from '../types.js';

export interface EachSkillResult {
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

function buildEachOverview(skillResults: EachSkillResult[], totalCostUSD: number) {
  return {
    totalArtifacts: skillResults.length,
    totalSamples: skillResults.reduce((sum, skill) => sum + skill.sampleCount, 0),
    totalCostUSD: Number(totalCostUSD.toFixed(6)),
    artifacts: skillResults.map((skill) => {
      const baselineSummary = skill.summary.baseline;
      const artifactSummary = skill.summary.skill;
      const baselineScore = baselineSummary?.avgCompositeScore ?? baselineSummary?.avgLlmScore ?? null;
      const artifactScore = artifactSummary?.avgCompositeScore ?? artifactSummary?.avgLlmScore ?? null;
      if (typeof baselineScore !== 'number' || typeof artifactScore !== 'number' || baselineScore <= 0) {
        return { name: skill.name, baselineScore, artifactScore, improvement: '-' };
      }
      const delta = ((artifactScore - baselineScore) / baselineScore * 100).toFixed(0);
      const improvement = artifactScore >= baselineScore ? `+${delta}%` : `${delta}%`;
      return { name: skill.name, baselineScore, artifactScore, improvement };
    }),
  };
}

export function buildEachReport({
  skillDir,
  skillEntries,
  skillResults,
  model,
  judgeModel,
  noJudge,
  executorName,
  judgeExecutorName,
  project,
  owner,
  tags,
  dryRun,
  concurrency,
  timeoutMs,
  totalCostUSD,
}: {
  skillDir: string;
  skillEntries: Array<{ name: string; skillPath: string; samplesPath: string }>;
  skillResults: EachSkillResult[];
  model: string;
  judgeModel: string;
  noJudge: boolean;
  executorName: string;
  judgeExecutorName?: string;
  project?: string;
  owner?: string;
  tags?: string[];
  dryRun: boolean;
  concurrency: number;
  timeoutMs?: number;
  totalCostUSD: number;
}) {
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
  const totalSampleCount = skillResults.reduce((sum, skill) => sum + skill.sampleCount, 0);

  return {
    report: {
      id: runId,
      each: true,
      meta: {
        variants: skillEntries.map((entry) => entry.name),
        model,
        judgeModel: noJudge ? null : judgeModel,
        executor: executorName,
        sampleCount: totalSampleCount,
        taskCount: totalSampleCount * 2,
        totalCostUSD: Number(totalCostUSD.toFixed(6)),
        timestamp: new Date().toISOString(),
        cliVersion: '',
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
      overview: buildEachOverview(skillResults, totalCostUSD),
      artifacts: skillResults,
    } satisfies Report,
    job,
  };
}
