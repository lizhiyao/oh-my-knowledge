import type { VariantSummary } from '../types.js';

export interface CiGateResult {
  allPass: boolean;
  lines: string[];
}

/**
 * PR-3 three-gate CI 门禁:事实 / 行为 / LLM 评价 三层各自与 threshold 独立比较,
 * 任一层低于 threshold 即 FAIL。这样某一层崩盘会被暴露,不会被 composite 合成分
 * 均化掩盖。
 *
 * 三层都缺(eval-samples 既没定义断言也没定义 rubric)时直接 FAIL + 引导,
 * 不走 composite fallback——符合 0-1 窗口期不做兼容原则与 PR-3 精神。
 *
 * 抽为纯函数便于单测;handleCi 只负责 IO(读 config、打印、退出码)。
 */
export function evaluateCiGates(
  summary: Record<string, VariantSummary>,
  threshold: number,
): CiGateResult {
  let allPass = true;
  const lines: string[] = [];

  for (const [variant, stats] of Object.entries(summary || {})) {
    const layers: Array<{ label: string; value: number | undefined }> = [
      { label: '事实 / Fact',        value: stats.avgFactScore },
      { label: '行为 / Behavior',    value: stats.avgBehaviorScore },
      { label: 'LLM 评价 / judge',   value: stats.avgJudgeScore },
    ];
    const present = layers.filter((l) => typeof l.value === 'number');

    if (present.length === 0) {
      lines.push(`FAIL: ${variant} · 无分层评分(fact / behavior / judge 三层均缺数据)。请检查 eval-samples 是否定义了断言(assertions)或 LLM 评委(rubric)`);
      allPass = false;
      continue;
    }

    let variantPass = true;
    const parts: string[] = [];
    for (const l of present) {
      const v = l.value ?? 0;
      const pass = v >= threshold;
      if (!pass) variantPass = false;
      parts.push(`${l.label}=${v.toFixed(2)}${pass ? '' : ' ✗'}`);
    }
    const status = variantPass ? 'PASS' : 'FAIL';
    lines.push(`${status}: ${variant} · ${parts.join(' · ')} (threshold=${threshold})`);
    if (!variantPass) allPass = false;
  }

  return { allPass, lines };
}
