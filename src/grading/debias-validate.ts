/**
 * `omk bench debias-validate length <reportId>` — measure how much the judge's
 * scores shift when the length-debias instruction is toggled.
 *
 * What it actually measures
 * -------------------------
 * Given a finished report, this command re-judges every (sample, variant) pair
 * using the OPPOSITE length-debias setting from the original run. It then
 * compares the two score distributions with a bootstrap CI on the mean
 * difference.
 *
 * If the original report ran with debias-on (v3-cot-length), we re-judge with
 * v2-cot (legacy). If the original ran with debias-off, we re-judge with
 * v3-cot-length. Significant difference → the prompt change moves scores → the
 * judge is sensitive to the length-debias instruction. That's *consistent with*
 * length bias being present, but it doesn't prove it directly — a perfectly
 * length-neutral judge could in principle also be sensitive to the wording for
 * other reasons. We label the verdict accordingly.
 *
 * Cost
 * ----
 * Re-judging is a full second pass over all (sample, variant) cells. Cost
 * doubles vs the original run. The CLI surfaces this so users running on
 * large/expensive evaluations can opt in deliberately.
 */

import type { ExecutorFn, Report, Sample } from '../types/index.js';
import { llmJudge } from './judge.js';
import { bootstrapDiffCI, type BootstrapDiffCI } from '../eval-core/bootstrap.js';

export interface DebiasValidateInput {
  report: Report;
  samples: Sample[];
  judgeExecutor: ExecutorFn;
  judgeModel: string;
  /** Variant to validate. Defaults to first variant. */
  variant?: string;
  /** Bootstrap iterations for the diff CI. Default 1000. */
  bootstrapSamples?: number;
  seed?: number;
  /** Progress hook. */
  onProgress?: (info: { sample_id: string; completed: number; total: number }) => void;
}

export interface DebiasValidateResult {
  variant: string;
  /** Original lengthDebias setting (true if debias-on at run time). */
  originalLengthDebias: boolean;
  /** Pairs of (originalScore, alternateScore) per sample. */
  pairs: Array<{ sample_id: string; originalScore: number; alternateScore: number }>;
  meanOriginal: number;
  meanAlternate: number;
  /** Mean of (alternate - original). Positive = alternate prompt scored higher. */
  diffCI: BootstrapDiffCI;
  /** Verdict in the {未检测, 弱, 中, 强} bucket plus an English shadow. */
  verdict: { zh: string; en: string; level: 'none' | 'weak' | 'medium' | 'strong' };
  /** Total cost burned re-judging. */
  alternateJudgeCostUSD: number;
  /** Sample_ids that the report had but lacked judge scores. */
  unscored: string[];
  /** Sample_ids in the samples file that are missing from the report. */
  missing: string[];
}

/**
 * Map a bootstrap diff CI to a verdict bucket. The ranges are deliberately
 * conservative: we only label "strong" when the CI fully sits >= |0.5| away
 * from zero (about half a point on a 1-5 scale).
 */
function classifyVerdict(diff: BootstrapDiffCI): DebiasValidateResult['verdict'] {
  if (!diff.significant) {
    return { zh: '未检测到显著差异', en: 'no significant shift', level: 'none' };
  }
  const mag = Math.min(Math.abs(diff.low), Math.abs(diff.high));
  if (mag >= 0.5) {
    return { zh: '强差异 — prompt 改动对评分影响大', en: 'strong shift', level: 'strong' };
  }
  if (mag >= 0.2) {
    return { zh: '中等差异 — 校正对结论有实质影响', en: 'medium shift', level: 'medium' };
  }
  return { zh: '弱差异 — 显著但幅度小', en: 'weak shift', level: 'weak' };
}

/**
 * Re-judge every sample of `variant` in the given report with the OPPOSITE
 * lengthDebias setting and compute the bootstrap CI on the mean difference.
 *
 * The judge call uses the rubric from the samples file and the output stored
 * in the report — we do NOT re-execute the model. Only judging is repeated.
 *
 * Multi-dimensional samples currently use the rubric as fallback when there's
 * no top-level rubric. Per-dimension validation can be added later if needed.
 */
export async function validateLengthDebias(input: DebiasValidateInput): Promise<DebiasValidateResult> {
  const { report, samples, judgeExecutor, judgeModel, bootstrapSamples = 1000, seed, onProgress } = input;
  const variant = input.variant ?? report.meta.variants?.[0];
  if (!variant) throw new Error('report has no variants — nothing to validate');

  // Detect original lengthDebias setting from meta. Default to true (v0.21+).
  // Older reports without debiasMode set are treated as legacy (debias-off).
  const debiasModeList = report.meta.debiasMode ?? [];
  const originalLengthDebias = debiasModeList.includes('length');
  const alternateLengthDebias = !originalLengthDebias;

  const sampleById = new Map<string, Sample>();
  for (const s of samples) sampleById.set(s.sample_id, s);

  // Pre-pass: collect (sample_id, output, originalScore) tuples.
  const tasks: Array<{ sample: Sample; output: string; originalScore: number }> = [];
  const unscored: string[] = [];
  const missing: string[] = [];
  for (const entry of report.results ?? []) {
    const v = entry.variants?.[variant];
    if (!v || !v.fullOutput) continue;
    const sample = sampleById.get(entry.sample_id);
    if (!sample) {
      missing.push(entry.sample_id);
      continue;
    }
    if (typeof v.llmScore !== 'number' || v.llmScore <= 0) {
      unscored.push(entry.sample_id);
      continue;
    }
    tasks.push({ sample, output: v.fullOutput, originalScore: v.llmScore });
  }

  // Re-judge with the opposite debias setting. We use the simplest path:
  // single-rubric judge. Multi-dim samples fall back to the explicit rubric
  // string if available. Samples without a rubric are skipped — we have
  // nothing to feed the judge.
  const pairs: DebiasValidateResult['pairs'] = [];
  let alternateJudgeCostUSD = 0;
  let completed = 0;
  for (const t of tasks) {
    completed++;
    onProgress?.({ sample_id: t.sample.sample_id, completed, total: tasks.length });
    const rubric = t.sample.rubric
      ?? (t.sample.dimensions ? Object.values(t.sample.dimensions).join('\n') : '');
    if (!rubric) continue;
    const altResult = await llmJudge({
      output: t.output,
      rubric,
      prompt: t.sample.prompt,
      executor: judgeExecutor,
      model: judgeModel,
      lengthDebias: alternateLengthDebias,
    });
    if (altResult.judgeCostUSD) alternateJudgeCostUSD += altResult.judgeCostUSD;
    if (altResult.score > 0) {
      pairs.push({
        sample_id: t.sample.sample_id,
        originalScore: t.originalScore,
        alternateScore: altResult.score,
      });
    }
  }

  const meanOriginal = avg(pairs.map((p) => p.originalScore));
  const meanAlternate = avg(pairs.map((p) => p.alternateScore));
  const diffCI = bootstrapDiffCI(
    pairs.map((p) => p.originalScore),
    pairs.map((p) => p.alternateScore),
    0.05,
    bootstrapSamples,
    seed,
  );
  const verdict = classifyVerdict(diffCI);

  return {
    variant,
    originalLengthDebias,
    pairs,
    meanOriginal: Number(meanOriginal.toFixed(3)),
    meanAlternate: Number(meanAlternate.toFixed(3)),
    diffCI,
    verdict,
    alternateJudgeCostUSD: Number(alternateJudgeCostUSD.toFixed(6)),
    unscored,
    missing,
  };
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

export function formatDebiasValidate(result: DebiasValidateResult): string {
  const lines: string[] = [];
  const dirOrig = result.originalLengthDebias ? 'on (v3-cot-length)' : 'off (v2-cot)';
  const dirAlt = result.originalLengthDebias ? 'off (v2-cot)' : 'on (v3-cot-length)';
  lines.push(`\n  Length-debias 灵敏度验证 (variant: ${result.variant})\n`);
  lines.push(`  原始 prompt:    ${dirOrig}`);
  lines.push(`  对照 prompt:    ${dirAlt}`);
  lines.push(`  用例数:         ${result.pairs.length}`);
  if (result.pairs.length === 0) {
    lines.push('  无可比对用例 — 检查报告是否含 fullOutput / rubric。');
    return lines.join('\n');
  }
  lines.push(`  原均值:         ${result.meanOriginal.toFixed(3)}`);
  lines.push(`  对照均值:       ${result.meanAlternate.toFixed(3)}`);
  const ci = result.diffCI;
  lines.push(`  差值 (alt-orig): ${ci.estimate >= 0 ? '+' : ''}${ci.estimate}`);
  lines.push(`  95% CI:         [${ci.low}, ${ci.high}]   (${ci.significant ? '显著' : '不显著'})`);
  lines.push('');
  lines.push(`  结论:           ${result.verdict.zh}`);
  lines.push('');
  lines.push(`  注: 该结论反映"prompt 切换是否改变评分"。差异显著 = 评分对 length-debias 指令敏感,`);
  lines.push(`      间接支持 length bias 存在;但 prompt 文本变化也可能因其他原因影响评分。`);
  lines.push(`      重判 cost: ${result.alternateJudgeCostUSD.toFixed(6)} USD`);
  if (result.missing.length) {
    lines.push(`  缺用例 ID:      ${result.missing.length} 条`);
  }
  if (result.unscored.length) {
    lines.push(`  无 LLM 分:      ${result.unscored.length} 条`);
  }
  return lines.join('\n');
}
