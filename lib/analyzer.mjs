/**
 * Auto-analysis: detect patterns and generate insights from evaluation results.
 */

/**
 * Analyze an evaluation report and produce insights + suggestions.
 *
 * @param {object} report - Full evaluation report
 * @returns {{ insights: Array<{type, severity, message, details}>, suggestions: string[] }}
 */
export function analyzeResults(report) {
  const insights = [];
  const suggestions = [];
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

  return { insights, suggestions };
}

function detectLowDiscrimination(results, variants, insights, suggestions) {
  // For each sample, check if all variants have the same assertion pass/fail pattern
  const assertionPatterns = new Map(); // key: "sampleIdx-assertionIdx" -> Set of pass/fail patterns

  for (const r of results) {
    const firstVariantData = r.variants?.[variants[0]];
    if (!firstVariantData?.assertions?.details) continue;

    for (let ai = 0; ai < firstVariantData.assertions.details.length; ai++) {
      const key = `${r.sample_id}-${ai}`;
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
        assertionPatterns.set(key, {
          sample_id: r.sample_id,
          type: assertion.type,
          value: assertion.value,
          allPassed: assertion.passed,
        });
      }
    }
  }

  if (assertionPatterns.size > 0) {
    const count = assertionPatterns.size;
    insights.push({
      type: 'low_discrimination_assertion',
      severity: 'warning',
      message: `${count} 个断言在所有变体上结果完全相同，无法区分变体差异`,
      details: [...assertionPatterns.values()],
    });
    suggestions.push('考虑移除或加强低区分度断言，使评测更能体现变体差异');
  }
}

function detectUniformScores(results, variants, insights, suggestions) {
  let uniformCount = 0;
  const uniformSamples = [];

  for (const r of results) {
    const scores = variants
      .map((v) => r.variants?.[v]?.compositeScore)
      .filter((s) => typeof s === 'number' && s > 0);

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

function detectAllPassFail(results, variants, insights, suggestions) {
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

function detectHighCost(results, variants, insights) {
  const costs = [];
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
