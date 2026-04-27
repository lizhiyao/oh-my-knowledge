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
  executor: ExecutorFn;
  judgeModel: string;
  allowLlmJudge?: boolean;
  execMetrics?: { costUSD?: number; durationMs?: number; numTurns?: number; toolCalls?: ToolCallInfo[]; turns?: TurnInfo[] };
  samplesDir?: string;
  /**
   * Run the LLM judge N times per (sample × dimension) pair and report mean + stddev.
   * Default 1 (single judge call). Useful for measuring judge self-consistency:
   * a high stddev means the judge isn't stable on this rubric and the score is noisy.
   */
  judgeRepeat?: number;
  /**
   * Multi-judge ensemble: if provided with >= 2 judges, every (sample × dimension) is
   * scored by every judge. Each judge can use a different executor (claude/openai/etc)
   * and model. Output gets per-judge breakdown + Pearson/MAD agreement metrics — used
   * to refute "Claude judge Claude same-modality bias" critique.
   */
  judgeModels?: JudgeConfig[];
  /**
   * Map from executor name → ExecutorFn. Required when judgeModels has judges with
   * different executor strings. Pipeline layer pre-creates these so grade() stays pure.
   */
  judgeExecutors?: Record<string, ExecutorFn>;
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
export async function grade({ output, sample, executor, judgeModel, allowLlmJudge = true, execMetrics = {}, samplesDir = '.', judgeRepeat = 1, judgeModels, judgeExecutors, lengthDebias = true }: GradeOptions): Promise<GradeResult> {
  const useEnsemble = !!(judgeModels && judgeModels.length >= 2);
  const results: GradeResult = { compositeScore: 0 };

  // Helper: build a config-keyed function for ensemble pathway. Each judge config
  // names an executor by string; we resolve via judgeExecutors map (set by pipeline).
  const executorByName = (name: string): ExecutorFn => {
    if (judgeExecutors && judgeExecutors[name]) return judgeExecutors[name];
    // Fallback: pipeline only set up the default judgeExecutor and didn't pre-create
    // others. Tests / single-judge callers hit this path. Use the passed-in executor
    // for the base case; ensemble with mismatched executor names should fail loudly.
    if (!judgeExecutors) return executor;
    throw new Error(`No executor registered for "${name}"; pipeline must populate judgeExecutors`);
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
  if (asyncAssertions.length > 0 && executor != null) {
    const asyncResults = await runAsyncAssertions(output, asyncAssertions, {
      executor, judgeModel, sample, samplesDir,
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
  }

  // 2. LLM scoring
  // Build execution trace summary for agent-aware judging
  const traceSummary = buildTraceSummary(execMetrics.turns, execMetrics.toolCalls);

  if (allowLlmJudge && sample.dimensions && Object.keys(sample.dimensions).length > 0) {
    // Multi-dimensional scoring
    results.dimensions = {};
    for (const [dim, rubric] of Object.entries(sample.dimensions)) {
      const dimOptions = { output, rubric, prompt: sample.prompt, executor, model: judgeModel, traceSummary, lengthDebias };
      results.dimensions[dim] = useEnsemble
        ? await llmJudgeEnsemble(dimOptions, judgeModels!, executorByName, judgeRepeat)
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
  } else if (allowLlmJudge && sample.rubric) {
    // Single rubric scoring
    const rubricOptions = { output, rubric: sample.rubric, prompt: sample.prompt, executor, model: judgeModel, traceSummary, lengthDebias };
    const judge = useEnsemble
      ? await llmJudgeEnsemble(rubricOptions, judgeModels!, executorByName, judgeRepeat)
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
  }

  // 3. Layered scores + composite
  const { compositeScore, layeredScores } = computeLayeredScores(results);
  results.compositeScore = compositeScore;
  results.layeredScores = layeredScores;

  return results;
}
export { runAssertions, validateJsonSchema } from './assertions.js';
export { buildTraceSummary } from './judge.js';
