/**
 * Domain model definitions for oh-my-knowledge.
 * Single source of truth for object structures used across runner, renderer, and server.
 */

import type { ExecResult, GradeResult, JudgeConfig, VariantResult, VariantSummary, TurnInfo, ToolCallInfo } from '../types/index.js';
import { computeJudgeAgreement } from '../grading/judge.js';
import { safeSliceForJson } from '../util/safe-slice.js';

function ratioToScore(ratio: number): number {
  return Number((1 + ratio * 4).toFixed(2));
}

const MAX_TURN_CONTENT = 2000;
const MAX_TOOL_OUTPUT = 1000;

function truncateTurns(turns: TurnInfo[]): TurnInfo[] {
  return turns.map((t) => ({
    ...t,
    content: safeSliceForJson(t.content, MAX_TURN_CONTENT),
    ...(t.toolCalls && { toolCalls: truncateToolCalls(t.toolCalls) }),
  }));
}

function truncateToolCalls(toolCalls: ToolCallInfo[]): ToolCallInfo[] {
  return toolCalls.map((tc) => ({
    ...tc,
    output: typeof tc.output === 'string'
      ? safeSliceForJson(tc.output, MAX_TOOL_OUTPUT)
      : tc.output,
  }));
}

/**
 * Build a VariantResult from execution and grading results.
 */
interface BuildVariantOptions {
  execMs?: number;
  gradeMs?: number;
  factCheck?: { verifiedCount: number; totalCount: number; verifiedRate: number; claims: Array<{ type: string; value: string; verified: boolean; evidence?: string }> };
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
    // 初值 = exec + judge。diagnostic 在 evaluation-execution.ts 跑完后会把
    // diagnostic.costUSD 加回 `variantResult.costUSD` 并写入 `diagnosticCostUSD` —
    // 让 per-sample budget 检查跟 summary.totalCostUSD 都按"三段合计"语义工作。
    // 没有 failed assertion 的 sample 不触发 diagnostic,这里就是最终值。
    costUSD: execCostUSD + judgeCostUSD,
    // 透传 executor 是否报告了 cost。undefined 当 reported(向后兼容)。
    // false 时 renderer 应显示「—」而不是 $0.0000;codex 0.125 binary 不报 cost。
    ...(execResult.costReportedByExecutor === false && { costReportedByExecutor: false }),
    // judge 同理:任一 dim/single/async assertion 走了不报 cost 的 judge executor → grade 整体也不可信
    ...(gradeResult?.judgeCostReportedByExecutor === false && { judgeCostReportedByExecutor: false }),
    numTurns: execResult.numTurns,
    ...(execResult.fullNumTurns != null && { fullNumTurns: execResult.fullNumTurns }),
    ...(execResult.numSubAgents != null && { numSubAgents: execResult.numSubAgents }),
    ...(assistantTurns != null && { assistantTurns }),
    ...(toolTurns != null && { toolTurns }),
    ...(execResult.toolCalls && execResult.toolCalls.length > 0 && {
      numToolCalls: execResult.toolCalls.length,
      numToolFailures,
      toolSuccessRate: Number((execResult.toolCalls.filter((tc) => tc.success).length / execResult.toolCalls.length).toFixed(2)),
      toolNames: [...new Set(execResult.toolCalls.map((tc) => tc.tool))],
      toolDistribution: execResult.toolCalls.reduce<Record<string, number>>((d, tc) => {
        d[tc.tool] = (d[tc.tool] || 0) + 1;
        return d;
      }, {}),
    }),
    traceCoverage,
    ...(execResult.error && { error: execResult.error }),
    ...(gradeResult && (() => {
      // Integrate fact check into layered scores
      const layeredScores = gradeResult.layeredScores ? { ...gradeResult.layeredScores } : undefined;
      let compositeScore = gradeResult.compositeScore;

      if (options?.factCheck && options.factCheck.totalCount > 0 && layeredScores) {
        const hardScore = ratioToScore(options.factCheck.verifiedRate);
        const assertionFact = layeredScores.factScore;
        // Combine: assertion fact + hard verification
        layeredScores.factScore = assertionFact != null
          ? Number(((assertionFact + hardScore) / 2).toFixed(2))
          : hardScore;
        // Recompute composite from updated layers (保留 0 分,仅过滤真正缺失)
        const scores = [layeredScores.factScore, layeredScores.behaviorScore, layeredScores.judgeScore].filter((s): s is number => s != null);
        compositeScore = scores.length > 0 ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : compositeScore;
      }

      return {
        compositeScore,
        ...(layeredScores && { layeredScores }),
        ...(gradeResult.assertions && { assertions: gradeResult.assertions }),
        ...(gradeResult.llmScore != null && { llmScore: gradeResult.llmScore }),
        ...(gradeResult.llmReason && { llmReason: gradeResult.llmReason }),
        ...(gradeResult.llmReasoning && { llmReasoning: gradeResult.llmReasoning }),
        ...(gradeResult.llmScoreStddev != null && { llmScoreStddev: gradeResult.llmScoreStddev }),
        ...(gradeResult.llmScoreSamples && { llmScoreSamples: gradeResult.llmScoreSamples }),
        ...(gradeResult.llmScoreFailures != null && { llmScoreFailures: gradeResult.llmScoreFailures }),
        ...(gradeResult.llmEnsemble && { llmEnsemble: gradeResult.llmEnsemble }),
        ...(gradeResult.llmAgreement && { llmAgreement: gradeResult.llmAgreement }),
        ...(gradeResult.dimensions && { dimensions: gradeResult.dimensions }),
      };
    })()),
    ...(options?.factCheck && options.factCheck.totalCount > 0 && { factCheck: options.factCheck }),
    outputPreview: execResult.output ? safeSliceForJson(execResult.output, 200, '') : null,
    ...(execResult.output && { fullOutput: execResult.output }),
    ...(execResult.turns && execResult.turns.length > 0 && { turns: truncateTurns(execResult.turns) }),
    ...(execResult.toolCalls && execResult.toolCalls.length > 0 && { toolCalls: truncateToolCalls(execResult.toolCalls) }),
    ...(execResult.mockStats && { mockStats: execResult.mockStats }),
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
    // diagnostic 触发概率 = 有 failed assertion 的 sample 比例,大多数 ok variant 是 0。
    // 把字段做成 optional + "全是 0 时省略" 是为了让旧 report-roundtrip 测试 / 报告 diff
    // 在没 diagnostic 的运行下看不到新字段,跨版本对比器不需要兼容 "0 vs missing"。
    ...(() => {
      const total = ok.reduce((s, e) => s + (e.diagnosticCostUSD || 0), 0);
      return total > 0 ? { totalDiagnosticCostUSD: Number(total.toFixed(6)) } : {};
    })(),
    avgCostPerSample: ok.length > 0 ? Number((ok.reduce((s, e) => s + (e.costUSD || 0), 0) / ok.length).toFixed(6)) : 0,
    // 任一 sample(含失败 sample)exec cost 未报告 → variant 整体标 false。
    // 用 entries 而不是 ok:codex 全 error 的场景 ok=[],但 entries 里 every 个都是
    // codex 不报 cost,这种"executor 能力 cap"事实跟 sample 是否成功无关 — 全错时
    // 也应该标 false,否则 renderer 会显示 $0.0000(执行 cost 列空 + summary 卡片
    // 已用 hasCost gate 兜住,但 list 页累计 / detail meta-tag 无该 gate,会泄漏)。
    ...(entries.some((e) => e.costReportedByExecutor === false) && { execCostReported: false }),
    // judge 同理:任一 sample 走了不报 cost 的 judge executor → totalJudgeCostUSD 不可信
    ...(entries.some((e) => e.judgeCostReportedByExecutor === false) && { judgeCostReported: false }),
    avgNumTurns: ok.length > 0 ? Number((ok.reduce((s, e) => s + (e.numTurns || 0), 0) / ok.length).toFixed(1)) : 0,
    ...(() => {
      const withFullTurns = ok.filter((e) => e.fullNumTurns != null);
      if (withFullTurns.length > 0) {
        return {
          avgFullNumTurns: Number((withFullTurns.reduce((s, e) => s + (e.fullNumTurns || 0), 0) / withFullTurns.length).toFixed(1)),
          avgNumSubAgents: Number((withFullTurns.reduce((s, e) => s + (e.numSubAgents || 0), 0) / withFullTurns.length).toFixed(1)),
        };
      }
      return {};
    })(),
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
      // sum per-sample toolDistribution(真实 call count),
      // 不再用 dedup 后的 toolNames 累加(那只统计"出现该 tool 的 sample 数",不是调用次数)。
      // 旧报告没 toolDistribution 字段时 fallback 到 toolNames 老语义,保兼容性。
      const dist: Record<string, number> = {};
      for (const e of withTools) {
        if (e.toolDistribution) {
          for (const [name, count] of Object.entries(e.toolDistribution)) {
            dist[name] = (dist[name] || 0) + count;
          }
        } else {
          for (const name of (e.toolNames || [])) {
            dist[name] = (dist[name] || 0) + 1;
          }
        }
      }
      return {
        avgToolCalls: Number((totalToolCalls / withTools.length).toFixed(1)),
        avgToolFailures: Number((withTools.reduce((s, e) => s + (e.numToolFailures || 0), 0) / withTools.length).toFixed(1)),
        toolSuccessRate: Number(avgSuccessRate.toFixed(2)),
        toolDistribution: dist,
      };
    })(),
    ...(() => {
      // 保留 0 分用例(评委打"完全不合格"是合法低分,不是缺失)。
      // 仅 filter null / undefined(真正缺数据,如该 sample 无对应断言或未配 judge)。
      const factScores = ok.map((e) => e.layeredScores?.factScore).filter((s): s is number => s != null);
      const behaviorScores = ok.map((e) => e.layeredScores?.behaviorScore).filter((s): s is number => s != null);
      const judgeScores = ok.map((e) => e.layeredScores?.judgeScore).filter((s): s is number => s != null);
      const factVerifiedRates = ok.map((e) => e.factCheck?.verifiedRate).filter((r): r is number => r != null);
      return {
        ...(factScores.length > 0 && { avgFactScore: Number((factScores.reduce((a, b) => a + b, 0) / factScores.length).toFixed(2)) }),
        ...(behaviorScores.length > 0 && { avgBehaviorScore: Number((behaviorScores.reduce((a, b) => a + b, 0) / behaviorScores.length).toFixed(2)) }),
        ...(judgeScores.length > 0 && { avgJudgeScore: Number((judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length).toFixed(2)) }),
        ...(factVerifiedRates.length > 0 && { avgFactVerifiedRate: Number((factVerifiedRates.reduce((a, b) => a + b, 0) / factVerifiedRates.length).toFixed(2)) }),
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
    ...buildEnsembleAggregate(ok),
  };
}

/**
 * Aggregate-level multi-judge agreement across all samples in this variant.
 *
 * Per-sample (single rubric) ensemble gives one score per judge. With M samples we
 * have an M-point series per judge. Pearson is well-defined when M >= 2 — that
 * answers "do these two judges agree on RANK ORDER" — vs MAD on a single sample
 * which only answers "how far apart are these two specific scores".
 *
 * For multi-dimensional ensembles, we currently aggregate ONLY single-rubric mode
 * (entries with llmEnsemble at the top level). Per-dimension aggregate Pearson is
 * a future extension — most blog narratives use single rubric so we'd be over-
 * engineering to do dimensions on day one.
 */
function buildEnsembleAggregate(ok: VariantResult[]): Pick<VariantSummary, 'judgeAgreement' | 'judgeModels'> {
  // Collect per-judge score series across samples that have ensemble data.
  const judgeScores = new Map<string, number[]>();
  let samplesWithEnsemble = 0;

  for (const entry of ok) {
    const ensemble = entry.llmEnsemble;
    if (!ensemble || ensemble.length < 2) continue;
    samplesWithEnsemble++;
    for (const e of ensemble) {
      if (e.score <= 0) continue; // exclude failed-judge samples from agreement
      if (!judgeScores.has(e.judge)) judgeScores.set(e.judge, []);
      judgeScores.get(e.judge)!.push(e.score);
    }
  }

  // Skip entirely if no ensemble data at all, or if we somehow only saw 1 judge.
  if (samplesWithEnsemble === 0 || judgeScores.size < 2) return {};

  // Use samples where every judge produced a valid score, so series align.
  // Recompute aligned matrix instead of trusting per-judge length.
  const judges = [...judgeScores.keys()];
  const alignedMatrix: number[][] = judges.map(() => []);
  for (const entry of ok) {
    const ensemble = entry.llmEnsemble;
    if (!ensemble || ensemble.length < 2) continue;
    const scoreByJudge = new Map<string, number>();
    for (const e of ensemble) scoreByJudge.set(e.judge, e.score);
    // Skip rows where any judge missing or scored 0
    const allValid = judges.every((j) => {
      const s = scoreByJudge.get(j);
      return typeof s === 'number' && s > 0;
    });
    if (!allValid) continue;
    judges.forEach((j, i) => alignedMatrix[i].push(scoreByJudge.get(j)!));
  }

  // EnsembleJudgeResult.judge stores "executor:model" strings; reverse-parse into structured form.
  const judgeConfigs: JudgeConfig[] = judges.map((j) => {
    const idx = j.indexOf(':');
    return idx > 0 ? { executor: j.slice(0, idx), model: j.slice(idx + 1) } : { executor: '', model: j };
  });
  if (alignedMatrix[0].length < 2) return { judgeModels: judgeConfigs }; // not enough aligned points
  const agreement = computeJudgeAgreement(alignedMatrix);
  return {
    judgeModels: judgeConfigs,
    judgeAgreement: { ...agreement, sampleCount: alignedMatrix[0].length },
  };
}
