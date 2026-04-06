/**
 * Mixed grading: deterministic assertions + LLM judge + multi-dimensional scoring.
 */

import type { AssertionResults, GradeResult, LayeredScores, DimensionResult, ExecutorFn, Sample, ToolCallInfo, TurnInfo } from '../types.js';
import { ASYNC_ASSERTION_TYPES, ratioToScore, runAssertions, runAsyncAssertions } from './assertions.js';
import { buildTraceSummary, llmJudge } from './judge.js';
import { computeLayeredScores } from './layered-scores.js';

interface GradeOptions {
  output: string;
  sample: Sample;
  executor: ExecutorFn;
  judgeModel: string;
  allowLlmJudge?: boolean;
  execMetrics?: { costUSD?: number; durationMs?: number; numTurns?: number; toolCalls?: ToolCallInfo[]; turns?: TurnInfo[] };
  samplesDir?: string;
}

/**
 * Grade a model output against a sample's criteria.
 */
export async function grade({ output, sample, executor, judgeModel, allowLlmJudge = true, execMetrics = {}, samplesDir = '.' }: GradeOptions): Promise<GradeResult> {
  const results: {
    assertions?: AssertionResults;
    llmScore?: number;
    llmReason?: string;
    dimensions?: Record<string, DimensionResult>;
    judgeCostUSD?: number;
    compositeScore: number;
    layeredScores?: LayeredScores;
  } = { compositeScore: 0 };

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
      results.dimensions[dim] = await llmJudge({
        output,
        rubric,
        prompt: sample.prompt,
        executor,
        model: judgeModel,
        traceSummary,
      });
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
    const judge = await llmJudge({
      output,
      rubric: sample.rubric,
      prompt: sample.prompt,
      executor,
      model: judgeModel,
      traceSummary,
    });
    results.llmScore = judge.score;
    results.llmReason = judge.reason;
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
