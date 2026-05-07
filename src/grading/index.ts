/**
 * Mixed grading: deterministic assertions + LLM judge + multi-dimensional scoring.
 */

import type { GradeResult, ExecutorFn, JudgeConfig, Sample, ToolCallInfo, TurnInfo } from '../types/index.js';
import { ASYNC_ASSERTION_TYPES, ratioToScore, runAssertions, runAsyncAssertions } from './assertions.js';
import { buildTraceSummary, llmJudgeEnsemble, llmJudgeRepeat } from './judge.js';
import { computeLayeredScores } from './layered-scores.js';

interface GradeOptions {
  output: string;
  sample: Sample;
  /**
   * Unified judge config — always non-empty. `length === 1` runs the single-judge
   * quick path (one judge per (sample × dimension)), `length >= 2` runs the
   * ensemble path with per-judge breakdown + Pearson/MAD agreement metrics
   * (refutes "judge same-modality bias" critique).
   *
   * The first entry (`judgeModels[0]`) is also used as the "primary judge" for
   * single-call paths (async assertions): one LLM call per assertion, no ensemble
   * aggregation — the primary judge is a deterministic representative.
   */
  judgeModels: JudgeConfig[];
  /**
   * Map `executor name → ExecutorFn`. The map only needs entries for executors
   * actually invoked by this grade call — i.e. when the sample triggers an LLM
   * code path (async assertions, dimension scoring, single rubric, ensemble
   * member). Sync-only samples can pass `{}`. Failures are lazy: missing entry
   * throws only at the call site, not on grade entry.
   */
  judgeExecutors?: Record<string, ExecutorFn>;
  allowLlmJudge?: boolean;
  execMetrics?: { costUSD?: number; durationMs?: number; numTurns?: number; toolCalls?: ToolCallInfo[]; turns?: TurnInfo[]; mockStats?: { hits: number; misses: number; perMock: Record<string, number> } };
  samplesDir?: string;
  /**
   * Run the LLM judge N times per (sample × dimension) pair and report mean + stddev.
   * Default 1 (single judge call). Useful for measuring judge self-consistency:
   * a high stddev means the judge isn't stable on this rubric and the score is noisy.
   */
  judgeRepeat?: number;
  /**
   * v0.21 length-debias toggle. Defaults to true — judge prompt includes the
   * "length is not a quality signal" instruction, prompt template version is
   * v3-cot-length. Set false (via `--no-debias-length`) to revert to the
   * legacy v2-cot prompt for reproducing historical reports.
   */
  lengthDebias?: boolean;
}

/**
 * Grade a model output against a sample's criteria.
 */
export async function grade({ output, sample, judgeModels, judgeExecutors, allowLlmJudge = true, execMetrics = {}, samplesDir = '.', judgeRepeat = 1, lengthDebias = true }: GradeOptions): Promise<GradeResult> {
  if (!judgeModels || judgeModels.length === 0) {
    throw new Error('grade(): judgeModels must be non-empty');
  }
  const useEnsemble = judgeModels.length >= 2;
  const primaryJudge = judgeModels[0];
  const judgeModel = primaryJudge.model;
  const judgeExecutorMap = judgeExecutors ?? {};
  const results: GradeResult = { compositeScore: 0 };

  // Lazy executor resolution: only throw when the sample actually triggers a
  // code path that needs the executor. Sync-only samples never invoke these
  // helpers, so they can pass `judgeExecutors: {}` (or omit it entirely).
  const requirePrimaryExecutor = (): ExecutorFn => {
    const exec = judgeExecutorMap[primaryJudge.executor];
    if (!exec) {
      throw new Error(`grade(): judgeExecutors missing entry for primary judge "${primaryJudge.executor}"`);
    }
    return exec;
  };
  const executorByName = (name: string): ExecutorFn => {
    const exec = judgeExecutorMap[name];
    if (!exec) {
      throw new Error(`No executor registered for "${name}"; pipeline must populate judgeExecutors for every judge`);
    }
    return exec;
  };

  // 1. Deterministic assertions (pure, no LLM)
  const allAssertions = sample.assertions || [];
  const syncAssertions = allAssertions.filter((a) => !ASYNC_ASSERTION_TYPES.has(a.type));
  const asyncAssertions = allAssertions.filter((assertion) => {
    if (!ASYNC_ASSERTION_TYPES.has(assertion.type)) return false;
    if (allowLlmJudge) return true;
    return assertion.type === 'custom';
  });

  if (syncAssertions.length > 0) {
    results.assertions = runAssertions(output, syncAssertions, { ...execMetrics });
  }

  // 1b. Async assertions (custom JS, semantic_similarity)
  // Async assertions are single-judge calls (no ensemble aggregation):
  // we use the primary judge as a deterministic representative.
  if (asyncAssertions.length > 0) {
    const asyncResults = await runAsyncAssertions(output, asyncAssertions, {
      executor: requirePrimaryExecutor(), judgeModel, sample, samplesDir,
    });
    if (results.assertions) {
      // Merge async results into sync results
      results.assertions.details.push(...asyncResults.details);
      results.assertions.total += asyncResults.total;
      results.assertions.passed += asyncResults.passed;
      // Recompute score from merged details
      const allDetails = results.assertions.details;
      const totalWeight = allDetails.reduce((s, d) => s + d.weight, 0);
      const passedWeight = allDetails.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
      const ratio = totalWeight > 0 ? passedWeight / totalWeight : 0;
      results.assertions.score = ratioToScore(ratio);
    } else {
      results.assertions = asyncResults;
    }
    // Accumulate async assertion judge cost
    if (asyncResults.judgeCostUSD && asyncResults.judgeCostUSD > 0) {
      results.judgeCostUSD = (results.judgeCostUSD || 0) + asyncResults.judgeCostUSD;
    }
    // 透传 cost reported flag。async assertion 调 judge executor 时,该 executor 若不报 cost
    // (codex)→ asyncResults.judgeCostReportedByExecutor=false → GradeResult 整体也不可信。
    if (asyncResults.judgeCostReportedByExecutor === false) {
      results.judgeCostReportedByExecutor = false;
    }
  }

  // 2. LLM scoring
  // Build execution trace summary for agent-aware judging
  const traceSummary = buildTraceSummary(execMetrics.turns, execMetrics.toolCalls);

  if (allowLlmJudge && sample.dimensions && Object.keys(sample.dimensions).length > 0) {
    // Multi-dimensional scoring
    results.dimensions = {};
    for (const [dim, rubric] of Object.entries(sample.dimensions)) {
      const dimOptions = { output, rubric, prompt: sample.prompt, executor: requirePrimaryExecutor(), model: judgeModel, traceSummary, lengthDebias };
      results.dimensions[dim] = useEnsemble
        ? await llmJudgeEnsemble(dimOptions, judgeModels, executorByName, judgeRepeat)
        : await llmJudgeRepeat(dimOptions, judgeRepeat);
    }
    const dimValues = Object.values(results.dimensions);
    const dimScores = dimValues.map((d) => d.score).filter((s) => s > 0);
    if (dimScores.length > 0) {
      results.llmScore = Number((dimScores.reduce((a, b) => a + b, 0) / dimScores.length).toFixed(2));
    }
    // Accumulate judge cost from all dimensions (add to any existing async assertion cost)
    const dimCost = dimValues.reduce((s, d) => s + (d.judgeCostUSD || 0), 0);
    if (dimCost > 0) results.judgeCostUSD = (results.judgeCostUSD || 0) + dimCost;
    if (dimValues.some((d) => d.judgeCostReportedByExecutor === false)) {
      results.judgeCostReportedByExecutor = false;
    }
  } else if (allowLlmJudge && sample.rubric) {
    // Single rubric scoring
    const rubricOptions = { output, rubric: sample.rubric, prompt: sample.prompt, executor: requirePrimaryExecutor(), model: judgeModel, traceSummary, lengthDebias };
    const judge = useEnsemble
      ? await llmJudgeEnsemble(rubricOptions, judgeModels, executorByName, judgeRepeat)
      : await llmJudgeRepeat(rubricOptions, judgeRepeat);
    results.llmScore = judge.score;
    results.llmReason = judge.reason;
    if (judge.reasoning) results.llmReasoning = judge.reasoning;
    if (judge.scoreSamples && judge.scoreSamples.length > 1) {
      results.llmScoreSamples = judge.scoreSamples;
      results.llmScoreStddev = judge.scoreStddev;
      if (judge.judgeFailureCount && judge.judgeFailureCount > 0) {
        results.llmScoreFailures = judge.judgeFailureCount;
      }
    }
    if (judge.ensemble) {
      results.llmEnsemble = judge.ensemble;
      results.llmAgreement = judge.agreement;
    }
    results.judgeCostUSD = (results.judgeCostUSD || 0) + (judge.judgeCostUSD || 0);
    if (judge.judgeCostReportedByExecutor === false) {
      results.judgeCostReportedByExecutor = false;
    }
  }

  // 3. Layered scores + composite
  const { compositeScore, layeredScores } = computeLayeredScores(results);
  results.compositeScore = compositeScore;
  results.layeredScores = layeredScores;

  return results;
}
export { runAssertions, validateJsonSchema } from './assertions.js';
export { buildTraceSummary } from './judge.js';
