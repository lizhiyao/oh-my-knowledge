/**
 * Auto-analysis: detect patterns and generate insights from evaluation results.
 */

import type { Report, ResultEntry, Insight, AnalysisResult } from './types.js';

/**
 * Analyze an evaluation report and produce insights + suggestions.
 */
export function analyzeResults(report: Report): AnalysisResult {
  const insights: Insight[] = [];
  const suggestions: string[] = [];
  const variants = report.meta?.variants || [];
  const results = report.results || [];

  if (results.length === 0 || variants.length < 2) {
    return { insights, suggestions };
  }

  // 1. Low-discrimination assertions
  detectLowDiscrimination(results, variants, insights, suggestions);

  // 2. Uniform scores across variants
  detectUniformScores(results, variants, insights, suggestions);

  // 3. All-pass / all-fail assertions
  detectAllPassFail(results, variants, insights, suggestions);

  // 4. High-cost samples
  detectHighCost(results, variants, insights);

  // 5. Efficiency gap (turns & cost)
  detectEfficiencyGap(report, variants, insights, suggestions);

  // 6. Agent tool usage patterns
  detectToolPatterns(report, variants, insights, suggestions);

  // 7. Tooling / permission issues
  detectToolPermissionIssues(results, variants, insights, suggestions);

  // 8. Trace integrity
  detectTraceIntegrity(report, variants, insights, suggestions);

  // 9. Agent assertion discrimination
  detectAgentAssertionDiscrimination(results, variants, insights, suggestions);

  // 10. Suggest --repeat when score variance is high and no repeat data
  detectNeedRepeat(report, results, variants, insights, suggestions);

  const summary = generateSummary(report, variants);

  return { summary, insights, suggestions };
}

function generateSummary(report: Report, variants: string[]): string | undefined {
  if (variants.length < 2) return undefined;
  const summary = report.summary || {};

  // Find control and test groups
  const configs = report.meta?.variantConfigs || [];
  const controlVariants = configs
    .filter((c) => c.artifactKind === 'baseline' || c.experimentType === 'runtime-context-only' || c.experimentType === 'baseline')
    .map((c) => c.variant);
  const testVariants = configs
    .filter((c) => !controlVariants.includes(c.variant))
    .map((c) => c.variant);

  const control = controlVariants[0] || variants[0];
  const test = testVariants[0] || variants[1];
  if (!test || !control) return undefined;

  const cs = summary[control];
  const ts = summary[test];
  if (!cs || !ts) return undefined;

  // Collect value judgments, not numbers
  const strengths: string[] = [];
  const weaknesses: string[] = [];

  // Quality judgment
  const cScore = cs.avgCompositeScore;
  const tScore = ts.avgCompositeScore;
  if (cScore != null && tScore != null) {
    const diff = tScore - cScore;
    if (diff > 0.3) strengths.push('质量明显优于对照组');
    else if (diff > 0) strengths.push('质量略优于对照组');
    else if (diff < -0.3) weaknesses.push('质量低于对照组');
    else if (diff < 0) weaknesses.push('质量略低于对照组');
  }

  // Layered highlights — only mention standouts
  const tFact = ts.avgFactScore;
  if (tFact != null && tFact >= 5) strengths.push('事实性满分');
  else if (tFact != null && tFact < 3) weaknesses.push('事实性偏低');

  const tBehavior = ts.avgBehaviorScore;
  const cBehavior = cs.avgBehaviorScore;
  if (tBehavior != null && cBehavior != null && tBehavior > cBehavior + 0.5) strengths.push('行为合规度更高');
  else if (tBehavior != null && cBehavior != null && tBehavior < cBehavior - 0.5) weaknesses.push('行为合规度偏低');

  const tQuality = ts.avgQualityScore;
  const cQuality = cs.avgQualityScore;
  if (tQuality != null && cQuality != null && Math.abs(tQuality - cQuality) < 0.5) {
    // Not a strength or weakness — neutral
  } else if (tQuality != null && cQuality != null && tQuality > cQuality) {
    strengths.push('LLM 评委更认可实验组输出');
  }

  // Cost
  const cCost = cs.avgCostPerSample;
  const tCost = ts.avgCostPerSample;
  if (cCost > 0 && tCost > 0) {
    if (tCost > cCost * 1.1) weaknesses.push('成本更高');
    else if (tCost < cCost * 0.9) strengths.push('成本更低');
  }

  // Efficiency
  const cTurns = cs.avgNumTurns;
  const tTurns = ts.avgNumTurns;
  if (cTurns > 0 && tTurns > 0) {
    if (tTurns < cTurns * 0.8) strengths.push('执行轮次更少，路径更高效');
    else if (tTurns > cTurns * 1.2) weaknesses.push('执行轮次更多');
  }

  const cDur = cs.avgDurationMs;
  const tDur = ts.avgDurationMs;
  if (cDur > 0 && tDur > 0) {
    if (tDur > cDur * 1.1) weaknesses.push('耗时更长');
    else if (tDur < cDur * 0.9) strengths.push('耗时更短');
  }

  // Build conclusion
  const parts: string[] = [];
  if (strengths.length > 0) {
    parts.push(`${test} 的优势：${strengths.join('、')}`);
  }
  if (weaknesses.length > 0) {
    parts.push(`${test} 的不足：${weaknesses.join('、')}`);
  }

  // Overall verdict
  if (strengths.length > 0 && weaknesses.length === 0) {
    parts.push('整体优于对照组');
  } else if (strengths.length === 0 && weaknesses.length > 0) {
    parts.push('整体未体现出优势');
  } else if (strengths.length > 0 && weaknesses.length > 0) {
    if (strengths.length >= weaknesses.length) {
      parts.push('整体有价值，建议优化不足项');
    } else {
      parts.push('优势不显著，建议评估投入产出比');
    }
  }

  if (parts.length === 0) return undefined;
  return parts.join('。') + '。';
}

const AGENT_ASSERTION_TYPES = new Set([
  'tools_called',
  'tools_not_called',
  'tool_input_contains',
  'tool_output_contains',
  'tools_count_min',
  'tools_count_max',
  'turns_min',
  'turns_max',
]);

const TRACE_HEAVY_AGENT_ASSERTION_TYPES = new Set([
  'tools_called',
  'tools_not_called',
  'tool_input_contains',
  'tool_output_contains',
  'tools_count_min',
  'tools_count_max',
]);

function collectAgentAssertionTypes(results: ResultEntry[], variants: string[]): Set<string> {
  const types = new Set<string>();
  for (const result of results) {
    const details = result.variants?.[variants[0]]?.assertions?.details || [];
    for (const detail of details) {
      if (AGENT_ASSERTION_TYPES.has(detail.type)) {
        types.add(detail.type);
      }
    }
  }
  return types;
}

function detectLowDiscrimination(results: ResultEntry[], variants: string[], insights: Insight[], suggestions: string[]): void {
  // For each sample, check if all variants have the same assertion pass/fail pattern
  const allPassedPatterns: Array<{ sample_id: string; type: string; value: string | number; allPassed: boolean }> = [];
  const allFailedPatterns: Array<{ sample_id: string; type: string; value: string | number; allPassed: boolean }> = [];

  for (const r of results) {
    const firstVariantData = r.variants?.[variants[0]];
    if (!firstVariantData?.assertions?.details) continue;

    for (let ai = 0; ai < firstVariantData.assertions.details.length; ai++) {
      const assertion = firstVariantData.assertions.details[ai];
      let allSame = true;

      for (let vi = 1; vi < variants.length; vi++) {
        const otherData = r.variants?.[variants[vi]];
        const otherDetail = otherData?.assertions?.details?.[ai];
        if (!otherDetail || otherDetail.passed !== assertion.passed) {
          allSame = false;
          break;
        }
      }

      if (allSame && variants.length >= 2) {
        const entry = {
          sample_id: r.sample_id,
          type: assertion.type,
          value: assertion.value,
          allPassed: assertion.passed,
        };
        if (assertion.passed) {
          allPassedPatterns.push(entry);
        } else {
          allFailedPatterns.push(entry);
        }
      }
    }
  }

  if (allPassedPatterns.length > 0) {
    insights.push({
      type: 'low_discrimination_all_passed',
      severity: 'info',
      message: `${allPassedPatterns.length} 个断言所有变体均通过，baseline 也能答对，区分度低`,
      details: allPassedPatterns,
    });
    suggestions.push('对于所有变体均通过的断言，考虑替换为检测 skill 文档中独有细节的断言（如特定参数名、配置值）');
  }

  if (allFailedPatterns.length > 0) {
    insights.push({
      type: 'low_discrimination_all_failed',
      severity: 'warning',
      message: `${allFailedPatterns.length} 个断言所有变体均失败，断言可能过于严格或存在配置错误`,
      details: allFailedPatterns,
    });
    suggestions.push('对于所有变体均失败的断言，检查断言条件是否正确，或降低匹配要求');
  }
}

function detectUniformScores(results: ResultEntry[], variants: string[], insights: Insight[], suggestions: string[]): void {
  let uniformCount = 0;
  const uniformSamples: string[] = [];

  for (const r of results) {
    const scores = variants
      .map((v) => r.variants?.[v]?.compositeScore)
      .filter((s): s is number => typeof s === 'number' && s > 0);

    if (scores.length >= 2) {
      const max = Math.max(...scores);
      const min = Math.min(...scores);
      if (max - min < 0.5) {
        uniformCount++;
        uniformSamples.push(r.sample_id);
      }
    }
  }

  if (uniformCount > 0) {
    insights.push({
      type: 'uniform_scores',
      severity: uniformCount === results.length ? 'warning' : 'info',
      message: `${uniformCount}/${results.length} 个样本在各变体间分差 < 0.5，区分度较低`,
      details: uniformSamples,
    });
    if (uniformCount === results.length) {
      suggestions.push('所有样本分数差异都很小，建议增加更有挑战性的测试用例或更严格的评分标准');
    }
  }
}

function detectAllPassFail(results: ResultEntry[], variants: string[], insights: Insight[], suggestions: string[]): void {
  let allPassCount = 0;
  let allFailCount = 0;

  for (const r of results) {
    for (const v of variants) {
      const assertions = r.variants?.[v]?.assertions;
      if (!assertions || assertions.total === 0) continue;
      if (assertions.passed === assertions.total) allPassCount++;
      if (assertions.passed === 0) allFailCount++;
    }
  }

  const totalEntries = results.length * variants.length;
  if (allPassCount === totalEntries && totalEntries > 0) {
    insights.push({
      type: 'all_pass',
      severity: 'warning',
      message: '所有断言在所有变体上全部通过，断言可能过于宽松',
      details: { allPassCount },
    });
    suggestions.push('所有断言都通过了，考虑增加更严格的断言来更好地区分变体质量');
  }

  if (allFailCount === totalEntries && totalEntries > 0) {
    insights.push({
      type: 'all_fail',
      severity: 'error',
      message: '所有断言在所有变体上全部失败，请检查断言配置是否正确',
      details: { allFailCount },
    });
    suggestions.push('所有断言都失败了，请检查评测配置是否有误');
  }
}

function detectNeedRepeat(report: Report, results: ResultEntry[], variants: string[], insights: Insight[], suggestions: string[]): void {
  // Skip if already has variance data (i.e. --repeat was used)
  if (report.variance) return;

  // Check if any variant has high score spread (max - min >= 2)
  for (const v of variants) {
    const s = report.summary?.[v];
    if (!s || s.minCompositeScore == null || s.maxCompositeScore == null) continue;
    const spread = s.maxCompositeScore - s.minCompositeScore;
    if (spread >= 2) {
      insights.push({
        type: 'suggest_repeat',
        severity: 'info',
        message: `${v} 的分数跨度较大（${s.minCompositeScore}~${s.maxCompositeScore}），建议使用 --repeat 3 多轮评测以获取方差分析和统计显著性检验`,
        details: { variant: v, min: s.minCompositeScore, max: s.maxCompositeScore, spread },
      });
      suggestions.push(`运行 omk bench run --repeat 3 获取置信区间和 t 检验结果，量化变体间差异的统计显著性`);
      return; // Only suggest once
    }
  }
}

function detectEfficiencyGap(report: Report, variants: string[], insights: Insight[], suggestions: string[]): void {
  if (variants.length < 2) return;
  const summary = report.summary || {};

  // Compare first variant (usually baseline) with others
  const base = summary[variants[0]];
  if (!base) return;

  for (let i = 1; i < variants.length; i++) {
    const other = summary[variants[i]];
    if (!other) continue;

    const details: string[] = [];

    // Turns comparison
    const baseTurns = base.avgNumTurns;
    const otherTurns = other.avgNumTurns;
    if (baseTurns > 0 && otherTurns > 0 && baseTurns !== otherTurns) {
      const turnsDiff = baseTurns - otherTurns;
      const turnsPct = ((turnsDiff / baseTurns) * 100).toFixed(0);
      if (Math.abs(turnsDiff / baseTurns) > 0.3) {
        details.push(turnsDiff > 0
          ? `${variants[i]} 平均减少 ${turnsDiff.toFixed(1)} 轮对话（↓${Math.abs(Number(turnsPct))}%）`
          : `${variants[i]} 平均增加 ${Math.abs(turnsDiff).toFixed(1)} 轮对话（↑${Math.abs(Number(turnsPct))}%）`);
      }
    }

    // Cost comparison
    const baseCost = base.avgCostPerSample;
    const otherCost = other.avgCostPerSample;
    if (baseCost > 0 && otherCost > 0 && baseCost !== otherCost) {
      const costDiff = baseCost - otherCost;
      const costPct = ((costDiff / baseCost) * 100).toFixed(0);
      if (Math.abs(costDiff / baseCost) > 0.2) {
        details.push(costDiff > 0
          ? `单样本成本降低 ${Math.abs(Number(costPct))}%（$${otherCost.toFixed(4)} vs $${baseCost.toFixed(4)}）`
          : `单样本成本增加 ${Math.abs(Number(costPct))}%（$${otherCost.toFixed(4)} vs $${baseCost.toFixed(4)}）`);
      }
    }

    if (details.length > 0) {
      insights.push({
        type: 'efficiency_gap',
        severity: 'info',
        message: details.join('；'),
        details: { baseline: variants[0], variant: variants[i], baseTurns, otherTurns, baseCost, otherCost },
      });
      suggestions.push(`${variants[i]} 在效率维度与 ${variants[0]} 存在显著差异，这对导航型 Skill 是重要的价值体现`);
    }
  }
}

function detectToolPatterns(report: Report, variants: string[], insights: Insight[], suggestions: string[]): void {
  const summary = report.summary || {};
  const hasTools = variants.some((v) => summary[v]?.avgToolCalls != null && summary[v].avgToolCalls! > 0);
  if (!hasTools) return;

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const s = summary[v];
    if (!s) continue;

    // Low tool success rate
    if (s.toolSuccessRate != null && s.toolSuccessRate < 0.8 && s.avgToolCalls != null && s.avgToolCalls > 0) {
      insights.push({
        type: 'low_tool_success_rate',
        severity: 'warning',
        message: `${v} 的工具调用成功率仅 ${(s.toolSuccessRate * 100).toFixed(0)}%，可能存在工具选择或参数问题`,
        details: { variant: v, toolSuccessRate: s.toolSuccessRate, avgToolCalls: s.avgToolCalls },
      });
      suggestions.push(`检查 ${v} 的工具调用失败模式，考虑在 skill 中增加工具使用指导`);
    }
  }

  // Compare tool counts between variants
  if (variants.length >= 2) {
    const base = summary[variants[0]];
    for (let i = 1; i < variants.length; i++) {
      const other = summary[variants[i]];
      if (!base?.avgToolCalls || !other?.avgToolCalls) continue;
      const diff = other.avgToolCalls - base.avgToolCalls;
      if (Math.abs(diff) > 2) {
        insights.push({
          type: 'tool_count_gap',
          severity: 'info',
          message: diff > 0
            ? `${variants[i]} 平均多调用 ${diff.toFixed(1)} 次工具（${other.avgToolCalls} vs ${base.avgToolCalls}）`
            : `${variants[i]} 平均少调用 ${Math.abs(diff).toFixed(1)} 次工具（${other.avgToolCalls} vs ${base.avgToolCalls}）`,
          details: { baseline: variants[0], variant: variants[i], baseTools: base.avgToolCalls, otherTools: other.avgToolCalls },
        });
      }
    }
  }
}

function detectToolPermissionIssues(results: ResultEntry[], variants: string[], insights: Insight[], suggestions: string[]): void {
  const permissionErrors: Array<{ variant: string; tool: string; sample_id: string; output: string }> = [];

  for (const result of results) {
    for (const variant of variants) {
      const calls = result.variants?.[variant]?.toolCalls || [];
      for (const call of calls) {
        if (call.success) continue;
        const output = String(call.output || '');
        if (/EACCES|permission denied/i.test(output)) {
          permissionErrors.push({
            variant,
            tool: call.tool,
            sample_id: result.sample_id,
            output: output.slice(0, 200),
          });
        }
      }
    }
  }

  if (permissionErrors.length === 0) return;

  insights.push({
    type: 'tool_permission_error',
    severity: 'warning',
    message: `检测到 ${permissionErrors.length} 次工具权限错误，实验结论可能被环境问题污染`,
    details: permissionErrors.slice(0, 10),
  });
  suggestions.push('先处理工具权限错误，再解读 agent 分数差异；若是 Glob/rg 权限问题，优先避免在控制实验中依赖该工具');
}

function detectTraceIntegrity(report: Report, variants: string[], insights: Insight[], suggestions: string[]): void {
  const summary = report.summary || {};
  const agentAssertionTypes = collectAgentAssertionTypes(report.results || [], variants);
  const needsTraceHeavyCoverage = [...agentAssertionTypes].some((type) => TRACE_HEAVY_AGENT_ASSERTION_TYPES.has(type));
  const hasAgentLikeData = variants.some((variant) => {
    const stats = summary[variant];
    return Boolean(stats?.avgToolCalls || stats?.avgNumTurns > 1);
  });
  if (!hasAgentLikeData || !needsTraceHeavyCoverage) return;

  const weakCoverage = variants
    .map((variant) => ({
      variant,
      traceCoverageRate: summary[variant]?.traceCoverageRate ?? 0,
      avgAssistantTurns: summary[variant]?.avgAssistantTurns ?? 0,
      avgToolTurns: summary[variant]?.avgToolTurns ?? 0,
      avgToolFailures: summary[variant]?.avgToolFailures ?? 0,
    }))
    .filter((item) => item.traceCoverageRate < 0.75);

  if (weakCoverage.length > 0) {
    insights.push({
      type: 'trace_integrity_gap',
      severity: 'warning',
      message: `${weakCoverage.length} 个 variant 的 trace 覆盖率低于 75%，报告可能不足以解释 agent 行为差异`,
      details: weakCoverage,
    });
    suggestions.push('优先补齐 turns、toolCalls、timing、full output 的采集与落盘，确保报告能解释工具路径和错误恢复过程');
  }
}

function detectAgentAssertionDiscrimination(results: ResultEntry[], variants: string[], insights: Insight[], suggestions: string[]): void {
  const assertionTypes = collectAgentAssertionTypes(results, variants);
  const hasTraceHeavyAssertions = [...assertionTypes].some((type) => TRACE_HEAVY_AGENT_ASSERTION_TYPES.has(type));
  if (!hasTraceHeavyAssertions) return;

  const evaluated: Array<{ sample_id: string; type: string; value: string | number; pattern: string }> = [];
  let discriminative = 0;
  let allPass = 0;
  let allFail = 0;

  for (const result of results) {
    const firstDetails = result.variants?.[variants[0]]?.assertions?.details;
    if (!firstDetails) continue;

    for (let index = 0; index < firstDetails.length; index++) {
      const first = firstDetails[index];
      if (!AGENT_ASSERTION_TYPES.has(first.type)) continue;

      const states: boolean[] = [];
      for (const variant of variants) {
        const detail = result.variants?.[variant]?.assertions?.details?.[index];
        if (!detail) continue;
        states.push(detail.passed);
      }
      if (states.length < 2) continue;

      const pattern = states.map((state) => (state ? 'T' : 'F')).join('/');
      evaluated.push({
        sample_id: result.sample_id,
        type: first.type,
        value: first.value,
        pattern,
      });

      const unique = new Set(states);
      if (unique.size > 1) discriminative++;
      else if (states.every(Boolean)) allPass++;
      else allFail++;
    }
  }

  if (evaluated.length < 4) return;

  const discriminationRate = Number((discriminative / evaluated.length).toFixed(2));
  if (discriminationRate < 0.3) {
    insights.push({
      type: 'agent_assertion_discrimination_low',
      severity: 'warning',
      message: `agent 断言区分度偏低，只有 ${(discriminationRate * 100).toFixed(0)}% 的断言真正拉开了变体差异`,
      details: {
        total: evaluated.length,
        discriminative,
        allPass,
        allFail,
        examples: evaluated.slice(0, 10),
      },
    });
    suggestions.push('重写 agent 断言时，优先约束工具路径、关键文件读取和 turns 上限，避免大量“全过”或“全挂”的弱断言');
  } else {
    insights.push({
      type: 'agent_assertion_discrimination_ok',
      severity: 'info',
      message: `agent 断言区分度达标，${(discriminationRate * 100).toFixed(0)}% 的断言能区分变体差异`,
      details: {
        total: evaluated.length,
        discriminative,
        allPass,
        allFail,
      },
    });
  }
}

function detectHighCost(results: ResultEntry[], variants: string[], insights: Insight[]): void {
  const costs: Array<{ sample_id: string; costUSD: number }> = [];
  for (const r of results) {
    let sampleCost = 0;
    for (const v of variants) {
      sampleCost += r.variants?.[v]?.costUSD || 0;
    }
    costs.push({ sample_id: r.sample_id, costUSD: sampleCost });
  }

  if (costs.length < 2) return;

  const avg = costs.reduce((s, c) => s + c.costUSD, 0) / costs.length;
  if (avg === 0) return;

  const expensive = costs.filter((c) => c.costUSD > avg * 2);
  if (expensive.length > 0) {
    insights.push({
      type: 'high_cost_sample',
      severity: 'info',
      message: `${expensive.length} 个样本成本显著高于平均值 (>${(avg * 2).toFixed(4)} USD)`,
      details: expensive,
    });
  }
}
