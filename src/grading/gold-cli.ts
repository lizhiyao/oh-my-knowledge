/**
 * `omk bench gold` subcommands: init / validate / compare.
 *
 * Kept out of cli.ts to keep that file from growing further; cli.ts only
 * dispatches subcommand strings to the handlers exported here.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Report, ReportHumanAgreement, ResultEntry, VariantResult } from '../types/index.js';
import { persistReport } from '../eval-core/evaluation-reporting.js';
import { loadGoldDataset, dumpYaml, type GoldDataset } from './gold-dataset.js';
import {
  computeAgreementWithCI,
  type RatingPair,
  type AgreementResult,
} from './human-gold.js';

export interface GoldCompareInput {
  report: Report;
  gold: GoldDataset;
  /** Variant to compare against gold. Default: first variant in report.meta.variants. */
  variant?: string;
  /** Bootstrap parameters. */
  samples?: number;
  seed?: number;
}

export interface GoldCompareResult {
  agreement: AgreementResult;
  /** Sample-level comparison rows for the renderer / per-row UI. */
  rows: Array<{
    sample_id: string;
    goldScore: number;
    judgeScore: number;
    diff: number;
  }>;
  /** Sample IDs in the gold set that were missing from the report. */
  missing: string[];
  /** Sample IDs in the gold set whose judge score was missing/non-numeric. */
  unscored: string[];
  /** Contamination warning string if annotator id matches any judge model id. */
  contaminationWarning?: string;
  /** Variant actually used. */
  variant: string;
}

/**
 * Compute agreement between gold annotations and the LLM judge's scores from
 * a finished report.
 *
 * Pure function — does not touch fs or stdout. The CLI handler wraps it.
 */
export function compareGoldToReport(input: GoldCompareInput): GoldCompareResult {
  const { report, gold, samples = 1000, seed } = input;
  const variants = report.meta?.variants ?? [];
  const variant = input.variant ?? variants[0];
  if (!variant) {
    throw new Error('report has no variants — cannot compare to gold');
  }

  // Build sample_id → judge score lookup. We use llmScore (composite mean
  // across dimensions if multi-dim, single score otherwise) — that's the
  // number a single human gold rater is most directly comparable to.
  const judgeScoreById = new Map<string, number>();
  for (const entry of report.results ?? []) {
    const v: VariantResult | undefined = entry.variants?.[variant];
    if (!v) continue;
    const s = v.llmScore;
    if (typeof s === 'number' && Number.isFinite(s)) {
      judgeScoreById.set(entry.sample_id, s);
    }
  }

  const pairs: RatingPair[] = [];
  const rows: GoldCompareResult['rows'] = [];
  const missing: string[] = [];
  const unscored: string[] = [];

  for (const anno of gold.annotations) {
    const judge = judgeScoreById.get(anno.sample_id);
    if (judge === undefined) {
      // Differentiate "sample doesn't exist in this report" vs "sample exists
      // but had no score" (e.g. assertions-only sample, judge skipped).
      const hasEntry = (report.results ?? []).some((r: ResultEntry) => r.sample_id === anno.sample_id);
      if (hasEntry) unscored.push(anno.sample_id);
      else missing.push(anno.sample_id);
      continue;
    }
    pairs.push({ unitId: anno.sample_id, coderA: anno.score, coderB: judge });
    rows.push({
      sample_id: anno.sample_id,
      goldScore: anno.score,
      judgeScore: judge,
      diff: Number((judge - anno.score).toFixed(4)),
    });
  }

  const scaleMeta = gold.metadata.scale ?? { min: 1, max: 5 };
  const agreement = computeAgreementWithCI(pairs, { samples, seed, scale: scaleMeta });

  // Contamination check: gold annotator id matching any judge model id is a
  // statistical hazard (model-judges-itself inflates agreement). We only warn
  // — users may have one model available and proceed knowingly.
  const annotator = gold.metadata.annotator.trim().toLowerCase();
  const judgeIds: string[] = [
    report.meta?.judgeModel ?? '',
    ...(report.meta?.judgeModels ?? []),
  ].filter(Boolean).map((s) => s.toLowerCase());
  const contaminated = judgeIds.find((j) => j.includes(annotator) || annotator.includes(j));
  const contaminationWarning = contaminated
    ? `gold annotator "${gold.metadata.annotator}" overlaps with judge model "${contaminated}" — agreement is inflated; treat α as upper bound only`
    : undefined;

  return {
    agreement,
    rows,
    missing,
    unscored,
    contaminationWarning,
    variant,
  };
}

/**
 * Format the comparison result as a human-readable terminal report.
 */
export function formatGoldCompare(result: GoldCompareResult, gold: GoldDataset): string {
  const lines: string[] = [];
  const a = result.agreement;
  lines.push(`\n  人工锚点对比 (variant: ${result.variant})\n`);
  lines.push(`  用例数:           ${a.sampleCount}`);
  if (a.sampleCount === 0) {
    lines.push('  无可比对用例 — 检查 sample_id 是否对应。');
    if (result.missing.length) lines.push(`  报告缺失:         ${result.missing.join(', ')}`);
    return lines.join('\n');
  }
  lines.push(`  Krippendorff α:   ${fmt(a.alpha)}   (主指标，序数加权)`);
  lines.push(`  α 95% CI:         [${fmt(a.alphaCI.low)}, ${fmt(a.alphaCI.high)}]`);
  lines.push(`  加权 κ:           ${fmt(a.weightedKappa)}   (副指标)`);
  lines.push(`  Pearson r:        ${fmt(a.pearson)}   (仅查 rank order)`);
  lines.push('');
  lines.push(`  解读:             ${interpret(a.alpha)}`);
  if (result.missing.length) {
    lines.push(`  报告缺 sample:    ${result.missing.length} 条 (${result.missing.slice(0, 5).join(', ')}${result.missing.length > 5 ? '...' : ''})`);
  }
  if (result.unscored.length) {
    lines.push(`  缺 LLM 分:        ${result.unscored.length} 条 (${result.unscored.slice(0, 5).join(', ')}${result.unscored.length > 5 ? '...' : ''})`);
  }
  if (result.contaminationWarning) {
    lines.push('');
    lines.push(`  ⚠ 污染警告: ${result.contaminationWarning}`);
  }
  lines.push('');
  lines.push(`  gold annotator:   ${gold.metadata.annotator} (${gold.metadata.annotatedAt}, v${gold.metadata.version})`);
  lines.push('');
  return lines.join('\n');
}

function fmt(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  return x.toFixed(3);
}

function interpret(alpha: number): string {
  if (Number.isNaN(alpha)) return 'α 未定义（数据无方差，需要更多评分多样性）';
  if (alpha >= 0.8) return 'α ≥ 0.80 — 高度一致，结论可放心使用';
  if (alpha >= 0.667) return 'α ∈ [0.67, 0.80) — 可接受，但谨慎结论';
  if (alpha >= 0.4) return 'α ∈ [0.40, 0.67) — 较弱一致，结论需配合 CI 与人工抽检';
  if (alpha >= 0) return 'α < 0.40 — 评委与 gold 偏差较大，先排查 rubric / prompt';
  return 'α < 0 — 评委与 gold 系统性反向，必须重新审视判分逻辑';
}

/**
 * Generate a starter dataset directory with a metadata.yaml and an
 * annotations.yaml stub. Errors out if the directory already has yaml files
 * (refuses to clobber).
 */
export function initGoldDataset(targetDir: string, options: { annotator?: string } = {}): string[] {
  const abs = resolve(targetDir);
  if (existsSync(abs)) {
    const present = readdirSync(abs).filter((f) => /\.ya?ml$/.test(f));
    if (present.length > 0) {
      throw new Error(`target directory already contains YAML files (${present.join(', ')}); use a different directory to avoid overwriting`);
    }
  } else {
    mkdirSync(abs, { recursive: true });
  }

  const today = new Date().toISOString().slice(0, 10);
  const metadata = {
    annotator: options.annotator ?? 'YOUR-MODEL-OR-TEAM-ID',
    annotatedAt: today,
    version: '0.1',
    scale: { min: 1, max: 5 },
    notes: 'omk gold dataset — 标注者 id 与 omk 默认 judge 不同时（如 sonnet judge + opus gold），CLI 自动检查污染。',
  };
  const annotations = {
    annotations: [
      { sample_id: 'EXAMPLE_001', score: 4, reason: '示例：替换为真实标注或删除' },
      { sample_id: 'EXAMPLE_002', score: 2 },
    ],
  };

  const metaPath = join(abs, 'metadata.yaml');
  const annoPath = join(abs, 'annotations.yaml');
  writeFileSync(metaPath, dumpYaml({ metadata }));
  writeFileSync(annoPath, dumpYaml(annotations));

  const readme = [
    '# Gold dataset',
    '',
    'omk 用此目录作为人工锚点 (human gold) 与 LLM judge 对比。',
    '',
    '## 文件说明',
    '- `metadata.yaml`: annotator / 时间 / 版本 / 评分量程',
    '- `annotations.yaml`: 每条 `{ sample_id, score, reason? }`，按 sample_id 拼接',
    '',
    '## 重要约束',
    '1. annotator 不应与 omk judge 模型同名 — CLI 检测到会警告',
    '2. 单标注者只反映一个视角；30 条以下的 demo 不构成基准',
    '3. score 必须在 metadata.scale 范围内 (默认 1-5)',
    '',
    '## 校验',
    '```bash',
    'omk bench gold validate <this-dir>',
    'omk bench gold compare <reportId> --gold-dir <this-dir>',
    '```',
    '',
  ].join('\n');
  const readmePath = join(abs, 'README.md');
  if (!existsSync(readmePath)) writeFileSync(readmePath, readme);

  return [metaPath, annoPath, readmePath];
}

/**
 * Convert an in-memory comparison result into the persisted ReportMeta shape.
 */
export function toPersistedAgreement(
  result: GoldCompareResult,
  gold: GoldDataset,
): ReportHumanAgreement {
  const a = result.agreement;
  return {
    alpha: a.alpha,
    alphaCI: a.alphaCI,
    weightedKappa: a.weightedKappa,
    pearson: a.pearson,
    sampleCount: a.sampleCount,
    variant: result.variant,
    goldAnnotator: gold.metadata.annotator,
    goldVersion: gold.metadata.version,
    contaminationWarning: result.contaminationWarning,
    missingCount: result.missing.length,
    unscoredCount: result.unscored.length,
  };
}

/**
 * Side-effecting helper for `omk bench run --gold-dir`: load gold, compute
 * agreement, mutate report.meta.humanAgreement, re-persist the report file,
 * print the human-readable comparison to stderr.
 *
 * Returns the comparison result so the CLI can also surface contamination
 * warnings programmatically.
 */
export function attachGoldAgreementToReport(input: {
  report: Report;
  goldDir: string;
  outputDir: string;
  samples?: number;
  seed?: number;
  variant?: string;
}): { result?: GoldCompareResult; gold?: GoldDataset; loadIssues: string[] } {
  const { report, goldDir, outputDir, samples, seed, variant } = input;
  const { dataset, issues } = loadGoldDataset(goldDir);
  const loadIssues = issues.map((i) => i.message);
  if (!dataset) return { loadIssues };

  const result = compareGoldToReport({ report, gold: dataset, samples, seed, variant });
  report.meta.humanAgreement = toPersistedAgreement(result, dataset);
  persistReport(report, outputDir);
  return { result, gold: dataset, loadIssues };
}

/**
 * Validate-only entry point. Returns issues; CLI exits non-zero if any.
 */
export function validateGoldDataset(dir: string): { ok: boolean; issues: string[]; sampleCount: number } {
  const { dataset, issues } = loadGoldDataset(dir);
  const formatted = issues.map((i) => {
    const at = i.path ? ` (${i.path}${i.index !== undefined ? `:${i.index}` : ''})` : '';
    return `${i.message}${at}`;
  });
  return {
    ok: !!dataset && issues.length === 0,
    issues: formatted,
    sampleCount: dataset?.annotations.length ?? 0,
  };
}
