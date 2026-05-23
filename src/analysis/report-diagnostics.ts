/**
 * Auto-analysis: detect patterns and generate insights from evaluation results.
 */

import type { Report, ResultEntry, Insight, AnalysisResult, Sample, SampleQualityAggregate, Lang } from '../types/index.js';
import { normalizeCapability } from './sample-diagnostics.js';

/** opts for `analyzeResults`. Optional because most older callers don't have
 *  samples in scope; new callers (evaluation-pipeline / evolver) pass them in to
 *  populate `analysis.sampleQuality`. */
export interface AnalyzeResultsOptions {
  /** Original Sample[] from eval-samples. Enables `analysis.sampleQuality` aggregation. */
  samples?: Sample[];
}

/**
 * Analyze an evaluation report and produce structured insights.
 */
export function analyzeResults(report: Report, opts: AnalyzeResultsOptions = {}): AnalysisResult {
  const insights: Insight[] = [];
  const variants = report.meta?.variants || [];
  const results = report.results || [];

  // sampleQuality aggregate is built from sample metadata only,
  // independent of result data. Computed even when results.length === 0 or
  // variants.length < 2 (e.g. dry-run / single-variant analysis).
  const sampleQuality: SampleQualityAggregate | undefined = opts.samples
    ? buildSampleQualityAggregate(opts.samples)
    : undefined;

  if (results.length === 0 || variants.length < 2) {
    return { insights, ...(sampleQuality && { sampleQuality }) };
  }

  // 1. Low-discrimination assertions
  detectLowDiscrimination(results, variants, insights);

  // 2. Uniform scores across variants
  detectUniformScores(results, variants, insights);

  // 3. All-pass / all-fail assertions
  detectAllPassFail(results, variants, insights);

  // 4. High-cost samples
  detectHighCost(results, variants, insights);

  // 5. Efficiency gap (turns & cost)
  detectEfficiencyGap(report, variants, insights);

  // 6. Agent tool usage patterns
  detectToolPatterns(report, variants, insights);

  // 7. Tooling / permission issues
  detectToolPermissionIssues(results, variants, insights);

  // 8. Trace integrity
  detectTraceIntegrity(report, variants, insights);

  // 9. Agent assertion discrimination
  detectAgentAssertionDiscrimination(results, variants, insights);

  // 10. Suggest --repeat when score variance is high and no repeat data
  detectNeedRepeat(report, results, variants, insights);

  return {
    insights,
    ...(sampleQuality && { sampleQuality }),
  };
}

/**
 * Build sample design science aggregate from sample metadata.
 *
 * Pure function — no result/score data needed. Reads:
 * - `Sample.capability` (string[], normalized case-insensitive + dash/camel/underscore stripped)
 * - `Sample.difficulty` ('easy' | 'medium' | 'hard')
 * - `Sample.construct` (free-form string)
 * - `Sample.provenance` ('human' | 'llm-generated' | 'production-trace')
 * - `Sample.rubric` (for avgRubricLength)
 *
 * Missing fields are bucketed under the `unspecified` key in the relevant
 * distribution map, so users see "I have N samples without difficulty declared".
 *
 * Persisted on the report so studio can surface coverage gaps. Does NOT
 * participate in grading / judge / verdict. See docs/specs/sample-design-spec.md.
 */
export function buildSampleQualityAggregate(samples: Sample[]): SampleQualityAggregate {
  const capabilityCoverage: Record<string, number> = {};
  const difficultyDistribution: Record<'easy' | 'medium' | 'hard' | 'unspecified', number> = {
    easy: 0, medium: 0, hard: 0, unspecified: 0,
  };
  const constructDistribution: Record<string, number> = {};
  const provenanceBreakdown: Record<string, number> = {};

  let totalRubricLength = 0;
  let rubricCount = 0;
  let withCapability = 0;
  let withDifficulty = 0;
  let withConstruct = 0;
  let withProvenance = 0;

  for (const sample of samples) {
    // capability — normalize case + dash/camel/underscore so 'api-selection' / 'apiSelection' / 'API_Selection' merge.
    if (Array.isArray(sample.capability) && sample.capability.length > 0) {
      withCapability++;
      const seen = new Set<string>();
      for (const rawCap of sample.capability) {
        if (typeof rawCap !== 'string') continue;
        const cap = normalizeCapability(rawCap);
        if (seen.has(cap)) continue; // 同 sample 内同 capability 重复声明只计 1
        seen.add(cap);
        capabilityCoverage[cap] = (capabilityCoverage[cap] || 0) + 1;
      }
    }

    // difficulty
    if (sample.difficulty) {
      withDifficulty++;
      difficultyDistribution[sample.difficulty]++;
    } else {
      difficultyDistribution.unspecified++;
    }

    // construct (free-form)
    if (sample.construct) {
      withConstruct++;
      constructDistribution[sample.construct] = (constructDistribution[sample.construct] || 0) + 1;
    } else {
      constructDistribution.unspecified = (constructDistribution.unspecified || 0) + 1;
    }

    // provenance
    if (sample.provenance) {
      withProvenance++;
      provenanceBreakdown[sample.provenance] = (provenanceBreakdown[sample.provenance] || 0) + 1;
    } else {
      provenanceBreakdown.unspecified = (provenanceBreakdown.unspecified || 0) + 1;
    }

    // rubric length(only counted if present, NaN-safe)
    if (sample.rubric) {
      totalRubricLength += sample.rubric.trim().length;
      rubricCount++;
    }
  }

  return {
    capabilityCoverage,
    difficultyDistribution,
    constructDistribution,
    provenanceBreakdown,
    avgRubricLength: rubricCount > 0 ? Math.round(totalRubricLength / rubricCount) : 0,
    sampleCountWithCapability: withCapability,
    sampleCountWithDifficulty: withDifficulty,
    sampleCountWithConstruct: withConstruct,
    sampleCountWithProvenance: withProvenance,
  };
}

export function generateAnalysisSummary(report: Report, lang: Lang = 'zh'): string | undefined {
  const variants = report.meta?.variants || [];
  if (variants.length < 2) return undefined;
  const stats = report.summary || {};

  // Find control group. experimentRole 是 v0.16 起用户显式声明的 control/treatment
  // 角色(见 docs/specs/terminology-spec.md 三-4),是判定对照组的唯一来源。
  // 老 report(v0.15 及更早)variantConfig 里可能缺 experimentRole 字段,
  // 退化到从 artifactKind === 'baseline' / experimentType 反推——标注为 legacy 路径。
  const configs = report.meta?.variantConfigs || [];
  let controlVariants = configs
    .filter((c) => c.experimentRole === 'control')
    .map((c) => c.variant);
  if (controlVariants.length === 0) {
    // legacy fallback for old reports without experimentRole
    controlVariants = configs
      .filter((c) => c.artifactKind === 'baseline' || c.experimentType === 'runtime-context-only' || c.experimentType === 'baseline')
      .map((c) => c.variant);
  }

  const control = controlVariants[0] || variants[0];
  const test = variants.find((v) => v !== control);
  if (!test || !control) return undefined;

  const cs = stats[control];
  const ts = stats[test];
  if (!cs || !ts) return undefined;

  const lines: string[] = [];

  // ── Section 1: Core verdict ──
  const cScore = cs.avgCompositeScore;
  const tScore = ts.avgCompositeScore;
  const scoreDiff = tScore != null && cScore != null ? tScore - cScore : null;

  if (scoreDiff != null && tScore != null && cScore != null) {
    const absDiff = Math.abs(scoreDiff);
    if (absDiff < 0.1) {
      lines.push(lang === 'zh'
        ? `【结论】${test} 与 ${control} 综合得分持平（${tScore.toFixed(2)} vs ${cScore.toFixed(2)}），质量无显著差异。`
        : `【Conclusion】${test} and ${control} are effectively tied on composite score (${tScore.toFixed(2)} vs ${cScore.toFixed(2)}); no clear quality difference.`);
    } else if (scoreDiff > 0) {
      const tag = lang === 'zh'
        ? (absDiff > 0.3 ? '明显领先' : '略优')
        : (absDiff > 0.3 ? 'clearly ahead' : 'slightly ahead');
      lines.push(lang === 'zh'
        ? `【结论】${test} 综合得分 ${tag}（${tScore.toFixed(2)} vs ${cScore.toFixed(2)}，+${scoreDiff.toFixed(2)}）。`
        : `【Conclusion】${test} is ${tag} on composite score (${tScore.toFixed(2)} vs ${cScore.toFixed(2)}, +${scoreDiff.toFixed(2)}).`);
    } else {
      const tag = lang === 'zh'
        ? (absDiff > 0.3 ? '明显落后' : '略低')
        : (absDiff > 0.3 ? 'clearly behind' : 'slightly lower');
      lines.push(lang === 'zh'
        ? `【结论】${test} 综合得分 ${tag}（${tScore.toFixed(2)} vs ${cScore.toFixed(2)}，${scoreDiff.toFixed(2)}）。`
        : `【Conclusion】${test} is ${tag} on composite score (${tScore.toFixed(2)} vs ${cScore.toFixed(2)}, ${scoreDiff.toFixed(2)}).`);
    }
  }

  // ── Section 2: Key differentiators with concrete numbers ──
  const diffs: string[] = [];

  // Quality sub-scores — only mention when there IS a difference
  const tFact = ts.avgFactScore;
  const cFact = cs.avgFactScore;
  if (tFact != null && cFact != null) {
    if (tFact === cFact) {
      // Both same — don't mention (e.g. both 5/5 is not interesting)
    } else if (tFact > cFact) {
      diffs.push(lang === 'zh'
        ? `事实性 ${tFact.toFixed(1)} vs ${cFact.toFixed(1)}（↑${(tFact - cFact).toFixed(1)}）`
        : `Fact score ${tFact.toFixed(1)} vs ${cFact.toFixed(1)} (up ${(tFact - cFact).toFixed(1)})`);
    } else {
      diffs.push(lang === 'zh'
        ? `事实性 ${tFact.toFixed(1)} vs ${cFact.toFixed(1)}（↓${(cFact - tFact).toFixed(1)}）`
        : `Fact score ${tFact.toFixed(1)} vs ${cFact.toFixed(1)} (down ${(cFact - tFact).toFixed(1)})`);
    }
  }

  const tBehavior = ts.avgBehaviorScore;
  const cBehavior = cs.avgBehaviorScore;
  if (tBehavior != null && cBehavior != null && Math.abs(tBehavior - cBehavior) > 0.3) {
    const dir = tBehavior > cBehavior ? '↑' : '↓';
    diffs.push(lang === 'zh'
      ? `行为合规 ${tBehavior.toFixed(1)} vs ${cBehavior.toFixed(1)}（${dir}${Math.abs(tBehavior - cBehavior).toFixed(1)}）`
      : `Behavior score ${tBehavior.toFixed(1)} vs ${cBehavior.toFixed(1)} (${dir === '↑' ? 'up' : 'down'} ${Math.abs(tBehavior - cBehavior).toFixed(1)})`);
  }

  const tJudge = ts.avgJudgeScore;
  const cJudge = cs.avgJudgeScore;
  if (tJudge != null && cJudge != null && Math.abs(tJudge - cJudge) >= 0.5) {
    const dir = tJudge > cJudge ? '↑' : '↓';
    diffs.push(lang === 'zh'
      ? `LLM 评价 ${tJudge.toFixed(1)} vs ${cJudge.toFixed(1)}（${dir}${Math.abs(tJudge - cJudge).toFixed(1)}）`
      : `LLM judge ${tJudge.toFixed(1)} vs ${cJudge.toFixed(1)} (${dir === '↑' ? 'up' : 'down'} ${Math.abs(tJudge - cJudge).toFixed(1)})`);
  }

  // Efficiency — with percentages
  const cTurns = cs.avgNumTurns;
  const tTurns = ts.avgNumTurns;
  if (cTurns > 0 && tTurns > 0 && cTurns !== tTurns) {
    const pct = Math.abs(((tTurns - cTurns) / cTurns) * 100).toFixed(0);
    if (tTurns < cTurns) {
      diffs.push(lang === 'zh'
        ? `轮次 ${tTurns.toFixed(1)} vs ${cTurns.toFixed(1)}（↓${pct}%，路径更高效）`
        : `Turns ${tTurns.toFixed(1)} vs ${cTurns.toFixed(1)} (down ${pct}%, more efficient path)`);
    } else {
      diffs.push(lang === 'zh'
        ? `轮次 ${tTurns.toFixed(1)} vs ${cTurns.toFixed(1)}（↑${pct}%）`
        : `Turns ${tTurns.toFixed(1)} vs ${cTurns.toFixed(1)} (up ${pct}%)`);
    }
  }

  // Cost — with percentages
  const cCost = cs.avgCostPerSample;
  const tCost = ts.avgCostPerSample;
  if (cCost > 0 && tCost > 0 && Math.abs(tCost - cCost) / cCost > 0.05) {
    const pct = Math.abs(((tCost - cCost) / cCost) * 100).toFixed(0);
    if (tCost < cCost) {
      diffs.push(lang === 'zh'
        ? `单用例成本 $${tCost.toFixed(4)} vs $${cCost.toFixed(4)}（↓${pct}%）`
        : `Cost per sample $${tCost.toFixed(4)} vs $${cCost.toFixed(4)} (down ${pct}%)`);
    } else {
      diffs.push(lang === 'zh'
        ? `单用例成本 $${tCost.toFixed(4)} vs $${cCost.toFixed(4)}（↑${pct}%）`
        : `Cost per sample $${tCost.toFixed(4)} vs $${cCost.toFixed(4)} (up ${pct}%)`);
    }
  }

  // Duration — with percentages
  const cDur = cs.avgDurationMs;
  const tDur = ts.avgDurationMs;
  if (cDur > 0 && tDur > 0 && Math.abs(tDur - cDur) / cDur > 0.1) {
    const pct = Math.abs(((tDur - cDur) / cDur) * 100).toFixed(0);
    const tSec = (tDur / 1000).toFixed(1);
    const cSec = (cDur / 1000).toFixed(1);
    if (tDur < cDur) {
      diffs.push(lang === 'zh'
        ? `耗时 ${tSec}s vs ${cSec}s（↓${pct}%）`
        : `Duration ${tSec}s vs ${cSec}s (down ${pct}%)`);
    } else {
      diffs.push(lang === 'zh'
        ? `耗时 ${tSec}s vs ${cSec}s（↑${pct}%）`
        : `Duration ${tSec}s vs ${cSec}s (up ${pct}%)`);
    }
  }

  // Tool usage difference
  const tTools = ts.avgToolCalls;
  const cTools = cs.avgToolCalls;
  if (tTools != null && cTools != null && Math.abs(tTools - cTools) > 0.5) {
    diffs.push(lang === 'zh'
      ? `工具调用 ${tTools.toFixed(1)} vs ${cTools.toFixed(1)} 次`
      : `Tool calls ${tTools.toFixed(1)} vs ${cTools.toFixed(1)}`);
  }

  if (diffs.length > 0) {
    lines.push(lang === 'zh'
      ? `【关键差异】${diffs.join('；')}。`
      : `【Key differences】${diffs.join('; ')}.`);
  }

  // ── Section 3: Synthesis — connect the dots ──
  const synthesis: string[] = [];

  // Quality-cost tradeoff insight
  if (scoreDiff != null && cCost > 0 && tCost > 0) {
    const costRatio = (tCost - cCost) / cCost;
    if (Math.abs(scoreDiff) < 0.1 && costRatio < -0.15) {
      synthesis.push(lang === 'zh'
        ? `质量相当但成本显著降低，${test} 是更经济的选择`
        : `similar quality with materially lower cost; ${test} is the more economical choice`);
    } else if (scoreDiff > 0.1 && costRatio > 0.15) {
      synthesis.push(lang === 'zh'
        ? '质量提升伴随成本上涨，需权衡投入产出比'
        : 'quality improved, but cost also increased; weigh the return on investment');
    } else if (scoreDiff > 0.1 && costRatio <= 0) {
      synthesis.push(lang === 'zh'
        ? `质量与成本双优，${test} 全面领先`
        : `${test} leads on both quality and cost`);
    } else if (scoreDiff < -0.1 && costRatio < -0.15) {
      synthesis.push(lang === 'zh'
        ? '成本虽降但质量下滑，需评估质量底线是否可接受'
        : 'cost decreased, but quality dropped; check whether the quality floor is still acceptable');
    }
  }

  // Tool success rate concern
  const tToolSuccess = ts.toolSuccessRate;
  if (tToolSuccess != null && tToolSuccess < 1 && tToolSuccess >= 0.5) {
    synthesis.push(lang === 'zh'
      ? `${test} 存在工具调用失败（成功率 ${(tToolSuccess * 100).toFixed(0)}%），可能拉低了得分`
      : `${test} had tool-call failures (${(tToolSuccess * 100).toFixed(0)}% success), which may have pulled the score down`);
  }

  // Variance / significance from --repeat
  if (report.variance) {
    const v = report.variance;
    for (const comp of v.comparisons) {
      if (comp.a === control && comp.b === test || comp.a === test && comp.b === control) {
        const es = comp.effectSize;
        let esText = '';
        if (es && es.primary !== 'none') {
          const primaryVal = es.primary === 'g' ? es.hedgesG : es.cohensD;
          const secondaryLabel = es.primary === 'g' ? 'd' : 'g';
          const secondaryVal = es.primary === 'g' ? es.cohensD : es.hedgesG;
          esText = lang === 'zh'
            ? `，效应量 ${es.primary}=${primaryVal.toFixed(2)}（${es.magnitude}，${secondaryLabel}=${secondaryVal.toFixed(2)}）`
            : `, effect size ${es.primary}=${primaryVal.toFixed(2)} (${es.magnitude}, ${secondaryLabel}=${secondaryVal.toFixed(2)})`;
        }
        if (comp.significant) {
          synthesis.push(lang === 'zh'
            ? `${v.runs} 轮重复评测显示差异具有统计显著性（t=${comp.tStatistic.toFixed(2)}, df=${comp.df.toFixed(1)}, p<0.05${esText}）`
            : `${v.runs} repeated runs show a statistically significant difference (t=${comp.tStatistic.toFixed(2)}, df=${comp.df.toFixed(1)}, p<0.05${esText})`);
        } else {
          synthesis.push(lang === 'zh'
            ? `${v.runs} 轮重复评测未达到统计显著性（t=${comp.tStatistic.toFixed(2)}, df=${comp.df.toFixed(1)}${esText}），差异可能源于随机波动`
            : `${v.runs} repeated runs did not reach statistical significance (t=${comp.tStatistic.toFixed(2)}, df=${comp.df.toFixed(1)}${esText}); the gap may be random variation`);
        }
      }
    }
    const testVd = v.perVariant[test];
    if (testVd) {
      synthesis.push(lang === 'zh'
        ? `${test} 跨轮 95% 置信区间 [${testVd.lower.toFixed(2)}, ${testVd.upper.toFixed(2)}]`
        : `${test} cross-run 95% confidence interval [${testVd.lower.toFixed(2)}, ${testVd.upper.toFixed(2)}]`);
    }
  }

  if (synthesis.length > 0) {
    lines.push(lang === 'zh'
      ? `【综合洞察】${synthesis.join('；')}。`
      : `【Synthesis】${synthesis.join('; ')}.`);
  }

  // Caveats and recommendations are handled by the issues table below,
  // so the summary focuses only on verdict + differentiators + synthesis.

  if (lines.length === 0) return undefined;
  return lines.join('\n');
}

const AGENT_ASSERTION_TYPES = new Set([
  'tools_called',
  'tools_not_called',
  'tool_input_contains',
  'tool_input_not_contains',
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
  'tool_input_not_contains',
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

function detectLowDiscrimination(results: ResultEntry[], variants: string[], insights: Insight[]): void {
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
      details: allPassedPatterns,
    });
  }

  if (allFailedPatterns.length > 0) {
    insights.push({
      type: 'low_discrimination_all_failed',
      severity: 'warning',
      details: allFailedPatterns,
    });
  }
}

function detectUniformScores(results: ResultEntry[], variants: string[], insights: Insight[]): void {
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
      details: uniformSamples,
    });
  }
}

function detectAllPassFail(results: ResultEntry[], variants: string[], insights: Insight[]): void {
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
      details: { allPassCount },
    });
  }

  if (allFailCount === totalEntries && totalEntries > 0) {
    insights.push({
      type: 'all_fail',
      severity: 'error',
      details: { allFailCount },
    });
  }
}

function detectNeedRepeat(report: Report, results: ResultEntry[], variants: string[], insights: Insight[]): void {
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
        details: { variant: v, min: s.minCompositeScore, max: s.maxCompositeScore, spread },
      });
      return; // Only suggest once
    }
  }
}

function detectEfficiencyGap(report: Report, variants: string[], insights: Insight[]): void {
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
          ? `单用例成本降低 ${Math.abs(Number(costPct))}%（$${otherCost.toFixed(4)} vs $${baseCost.toFixed(4)}）`
          : `单用例成本增加 ${Math.abs(Number(costPct))}%（$${otherCost.toFixed(4)} vs $${baseCost.toFixed(4)}）`);
      }
    }

    if (details.length > 0) {
      insights.push({
        type: 'efficiency_gap',
        severity: 'info',
        details: { baseline: variants[0], variant: variants[i], baseTurns, otherTurns, baseCost, otherCost },
      });
    }
  }
}

function detectToolPatterns(report: Report, variants: string[], insights: Insight[]): void {
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
        details: { variant: v, toolSuccessRate: s.toolSuccessRate, avgToolCalls: s.avgToolCalls },
      });
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
          details: { baseline: variants[0], variant: variants[i], baseTools: base.avgToolCalls, otherTools: other.avgToolCalls },
        });
      }
    }
  }
}

function detectToolPermissionIssues(results: ResultEntry[], variants: string[], insights: Insight[]): void {
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
    details: permissionErrors.slice(0, 10),
  });
}

function detectTraceIntegrity(report: Report, variants: string[], insights: Insight[]): void {
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
      details: weakCoverage,
    });
  }
}

function detectAgentAssertionDiscrimination(results: ResultEntry[], variants: string[], insights: Insight[]): void {
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
      details: {
        total: evaluated.length,
        discriminative,
        allPass,
        allFail,
        examples: evaluated.slice(0, 10),
      },
    });
  } else {
    insights.push({
      type: 'agent_assertion_discrimination_ok',
      severity: 'info',
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
      details: expensive,
    });
  }
}
