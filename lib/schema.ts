/**
 * Domain model definitions for oh-my-knowledge.
 * Single source of truth for object structures used across runner, renderer, and server.
 */

import type { ExecResult, GradeResult, VariantResult, VariantSummary } from './types.js';

/**
 * Build a VariantResult from execution and grading results.
 */
export function buildVariantResult(execResult: ExecResult, gradeResult: GradeResult | null): VariantResult {
  const execCostUSD = execResult.costUSD || 0;
  const judgeCostUSD = gradeResult?.judgeCostUSD || 0;

  return {
    ok: execResult.ok,
    durationMs: execResult.durationMs,
    durationApiMs: execResult.durationApiMs,
    inputTokens: execResult.inputTokens,
    outputTokens: execResult.outputTokens,
    totalTokens: execResult.inputTokens + execResult.outputTokens,
    cacheReadTokens: execResult.cacheReadTokens,
    cacheCreationTokens: execResult.cacheCreationTokens,
    execCostUSD,
    judgeCostUSD,
    costUSD: execCostUSD + judgeCostUSD, // Total = execution + grading
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

/**
 * Build a VariantSummary from an array of VariantResults.
 */
export function buildVariantSummary(entries: VariantResult[]): VariantSummary {
  const ok = entries.filter((e) => e.ok);
  const compositeScores = entries.filter((e) => typeof e.compositeScore === 'number' && e.compositeScore! > 0).map((e) => e.compositeScore!);
  const assertionScores = entries.filter((e) => e.assertions?.score != null && e.assertions.score > 0).map((e) => e.assertions!.score);
  const llmScores = entries.filter((e) => typeof e.llmScore === 'number' && e.llmScore! > 0).map((e) => e.llmScore!);
  const errorCount = entries.length - ok.length;

  return {
    totalSamples: entries.length,
    successCount: ok.length,
    errorCount,
    errorRate: entries.length > 0 ? Number((errorCount / entries.length * 100).toFixed(1)) : 0,
    avgDurationMs: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.durationMs, 0) / ok.length) : 0,
    avgInputTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.inputTokens, 0) / ok.length) : 0,
    avgOutputTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.outputTokens, 0) / ok.length) : 0,
    avgTotalTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.totalTokens, 0) / ok.length) : 0,
    totalCostUSD: ok.reduce((s, e) => s + (e.costUSD || 0), 0),
    totalExecCostUSD: ok.reduce((s, e) => s + (e.execCostUSD || 0), 0),
    totalJudgeCostUSD: ok.reduce((s, e) => s + (e.judgeCostUSD || 0), 0),
    avgCostPerSample: ok.length > 0 ? Number((ok.reduce((s, e) => s + (e.costUSD || 0), 0) / ok.length).toFixed(6)) : 0,
    avgNumTurns: ok.length > 0 ? Number((ok.reduce((s, e) => s + (e.numTurns || 0), 0) / ok.length).toFixed(1)) : 0,
    ...(compositeScores.length > 0 && {
      avgCompositeScore: Number((compositeScores.reduce((s, v) => s + v, 0) / compositeScores.length).toFixed(2)),
      minCompositeScore: Number(Math.min(...compositeScores).toFixed(2)),
      maxCompositeScore: Number(Math.max(...compositeScores).toFixed(2)),
      ...(compositeScores.length >= 2 && (() => {
        const mean = compositeScores.reduce((s, v) => s + v, 0) / compositeScores.length;
        const variance = compositeScores.reduce((s, v) => s + (v - mean) ** 2, 0) / compositeScores.length;
        const stddev = Math.sqrt(variance);
        const cv = mean > 0 ? stddev / mean : 0;
        return { scoreStddev: Number(stddev.toFixed(2)), scoreCV: Number(cv.toFixed(3)) };
      })()),
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
