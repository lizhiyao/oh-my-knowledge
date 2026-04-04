/**
 * Domain model definitions for oh-my-knowledge.
 * Single source of truth for object structures used across runner, renderer, and server.
 */

import type { ExecResult, GradeResult, VariantResult, VariantSummary, TurnInfo, ToolCallInfo } from './types.js';

const MAX_TURN_CONTENT = 2000;
const MAX_TOOL_OUTPUT = 1000;

function truncateTurns(turns: TurnInfo[]): TurnInfo[] {
  return turns.map((t) => ({
    ...t,
    content: t.content.length > MAX_TURN_CONTENT ? t.content.slice(0, MAX_TURN_CONTENT) + '…' : t.content,
    ...(t.toolCalls && { toolCalls: truncateToolCalls(t.toolCalls) }),
  }));
}

function truncateToolCalls(toolCalls: ToolCallInfo[]): ToolCallInfo[] {
  return toolCalls.map((tc) => ({
    ...tc,
    output: typeof tc.output === 'string' && tc.output.length > MAX_TOOL_OUTPUT
      ? tc.output.slice(0, MAX_TOOL_OUTPUT) + '…'
      : tc.output,
  }));
}

/**
 * Build a VariantResult from execution and grading results.
 */
interface BuildVariantOptions {
  execMs?: number;
  gradeMs?: number;
}

export function buildVariantResult(execResult: ExecResult, gradeResult: GradeResult | null, options?: BuildVariantOptions): VariantResult {
  const execCostUSD = execResult.costUSD || 0;
  const judgeCostUSD = gradeResult?.judgeCostUSD || 0;
  const execMs = options?.execMs || execResult.durationMs;
  const gradeMs = options?.gradeMs || 0;
  const assistantTurns = execResult.turns?.filter((turn) => turn.role === 'assistant').length;
  const toolTurns = execResult.turns?.filter((turn) => turn.role === 'tool').length;
  const numToolFailures = execResult.toolCalls?.filter((tc) => !tc.success).length;
  const traceSignals = [
    execResult.turns && execResult.turns.length > 0,
    execResult.toolCalls && execResult.toolCalls.length > 0,
    Boolean(execResult.output),
    Boolean(execMs > 0),
  ];
  const traceCoverage = Number((traceSignals.filter(Boolean).length / traceSignals.length).toFixed(2));

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
    ...(assistantTurns != null && { assistantTurns }),
    ...(toolTurns != null && { toolTurns }),
    ...(execResult.toolCalls && execResult.toolCalls.length > 0 && {
      numToolCalls: execResult.toolCalls.length,
      numToolFailures,
      toolSuccessRate: Number((execResult.toolCalls.filter((tc) => tc.success).length / execResult.toolCalls.length).toFixed(2)),
      toolNames: [...new Set(execResult.toolCalls.map((tc) => tc.tool))],
    }),
    traceCoverage,
    ...(execResult.error && { error: execResult.error }),
    ...(gradeResult && {
      compositeScore: gradeResult.compositeScore,
      ...(gradeResult.assertions && { assertions: gradeResult.assertions }),
      ...(gradeResult.llmScore != null && { llmScore: gradeResult.llmScore }),
      ...(gradeResult.llmReason && { llmReason: gradeResult.llmReason }),
      ...(gradeResult.dimensions && { dimensions: gradeResult.dimensions }),
    }),
    outputPreview: execResult.output ? execResult.output.slice(0, 200) : null,
    ...(execResult.output && { fullOutput: execResult.output }),
    ...(execResult.turns && execResult.turns.length > 0 && { turns: truncateTurns(execResult.turns) }),
    ...(execResult.toolCalls && execResult.toolCalls.length > 0 && { toolCalls: truncateToolCalls(execResult.toolCalls) }),
    timing: { execMs, gradeMs, totalMs: execMs + gradeMs },
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
    avgDurationMs: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + (e.timing?.totalMs || e.durationMs), 0) / ok.length) : 0,
    avgInputTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.inputTokens, 0) / ok.length) : 0,
    avgOutputTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.outputTokens, 0) / ok.length) : 0,
    avgTotalTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.totalTokens, 0) / ok.length) : 0,
    totalCostUSD: ok.reduce((s, e) => s + (e.costUSD || 0), 0),
    totalExecCostUSD: ok.reduce((s, e) => s + (e.execCostUSD || 0), 0),
    totalJudgeCostUSD: ok.reduce((s, e) => s + (e.judgeCostUSD || 0), 0),
    avgCostPerSample: ok.length > 0 ? Number((ok.reduce((s, e) => s + (e.costUSD || 0), 0) / ok.length).toFixed(6)) : 0,
    avgNumTurns: ok.length > 0 ? Number((ok.reduce((s, e) => s + (e.numTurns || 0), 0) / ok.length).toFixed(1)) : 0,
    ...(() => {
      const withTrace = ok.filter((e) => e.traceCoverage != null);
      if (withTrace.length === 0) return {};
      return {
        avgAssistantTurns: Number((withTrace.reduce((s, e) => s + (e.assistantTurns || 0), 0) / withTrace.length).toFixed(1)),
        avgToolTurns: Number((withTrace.reduce((s, e) => s + (e.toolTurns || 0), 0) / withTrace.length).toFixed(1)),
        traceCoverageRate: Number((withTrace.reduce((s, e) => s + (e.traceCoverage || 0), 0) / withTrace.length).toFixed(2)),
      };
    })(),
    ...(() => {
      const withTools = ok.filter((e) => typeof e.numToolCalls === 'number' && e.numToolCalls! > 0);
      if (withTools.length === 0) return {};
      const totalToolCalls = withTools.reduce((s, e) => s + (e.numToolCalls || 0), 0);
      const avgSuccessRate = withTools.reduce((s, e) => s + (e.toolSuccessRate || 0), 0) / withTools.length;
      const dist: Record<string, number> = {};
      for (const e of withTools) {
        for (const name of (e.toolNames || [])) {
          dist[name] = (dist[name] || 0) + 1;
        }
      }
      return {
        avgToolCalls: Number((totalToolCalls / withTools.length).toFixed(1)),
        avgToolFailures: Number((withTools.reduce((s, e) => s + (e.numToolFailures || 0), 0) / withTools.length).toFixed(1)),
        toolSuccessRate: Number(avgSuccessRate.toFixed(2)),
        toolDistribution: dist,
      };
    })(),
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
