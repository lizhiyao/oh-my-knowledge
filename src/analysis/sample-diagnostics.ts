/**
 * Per-sample quality diagnostics.
 *
 * Why this exists
 * ---------------
 * `report-diagnostics.ts` answers "what's wrong with the report overall" —
 * aggregate-level insights about assertions and variant comparisons. This
 * module answers a complementary question: "which specific samples in my
 * eval-samples set are problematic and should be fixed before I trust any
 * conclusion drawn on this report?"
 *
 * Senior-engineer pain point: 100 eval-samples typically have 20-40 that
 * (a) all variants get the same score on (no discriminative power), or
 * (b) are near-duplicates of another sample (data redundancy inflating N), or
 * (c) have ambiguous rubric (judge gives wildly different scores on repeats), or
 * (d) are cost / latency outliers (one sample spikes the budget by itself), or
 * (e) fail across the board (likely broken sample, not a model deficiency).
 *
 * The CLI `omk bench diagnose <reportId>` surfaces these so users can iterate
 * the SAMPLE SET as much as they iterate the SKILL.
 *
 * Output shape: a flat list of issues, each tagged with severity and the
 * minimal evidence needed to act ("here are the matching prompts"). Issues are
 * sorted by severity then by sample_id so the report is stable across runs.
 */

import type { Report, ResultEntry, Sample } from '../types/index.js';
import { rougeN } from '../grading/assertions.js';

export type SampleIssueKind =
  | 'flat_scores'        // all variants within 0.5 score → no discrimination
  | 'all_pass'           // all variants got max score → too easy
  | 'all_fail'           // all variants got min score → too hard / broken
  | 'near_duplicate'     // prompt is ROUGE-1 ≥ threshold with another sample
  | 'ambiguous_rubric'   // judge stddev across repeats high → unclear rubric (后验/runtime 信号)
  | 'cost_outlier'       // sample's cost ≥ k × median cost
  | 'latency_outlier'    // sample's latency ≥ k × median latency
  | 'error_prone'        // sample failed (ok=false) on ≥ 1 variant
  // v0.22 — sample design science signals (先验 / static metadata signal,跟 ambiguous_rubric 是后验 / runtime 信号互补)
  | 'rubric_clarity_low' // rubric 字符 < 20 且不含评分级别词 → static rubric quality signal
  | 'capability_thin';   // 某 capability 只 ≤ max(2, N*0.2) 个 sample 撑(总 N≥10 才检测)

export interface SampleIssue {
  sample_id: string;
  severity: 'error' | 'warning' | 'info';
  kind: SampleIssueKind;
  message: string;
  /** Minimal evidence to make the issue actionable. */
  evidence: Record<string, unknown>;
}

export interface SampleDiagnosticReport {
  /** All issues sorted by (severity desc, sample_id asc). */
  issues: SampleIssue[];
  /** 0-100 quality score for the sample set as a whole. Lower = more issues. */
  healthScore: number;
  /** Sample IDs grouped by issue kind for quick consumption. */
  byKind: Partial<Record<SampleIssueKind, string[]>>;
  /** Quick-glance counters. */
  totals: { samples: number; flagged: number; errors: number; warnings: number; infos: number };
}

export interface DiagnoseOptions {
  /** Minimum ROUGE-1 between two prompts to flag near-duplicate. Default 0.7. */
  duplicateRouge?: number;
  /** Judge stddev threshold (across judgeRepeat samples) to flag ambiguous. Default 1.0. */
  ambiguousStddev?: number;
  /** Cost outlier multiplier vs median. Default 3 (≥ 3× median is flagged). */
  costOutlierK?: number;
  /** Latency outlier multiplier vs median. Default 3. */
  latencyOutlierK?: number;
  /** Score-spread threshold below which a sample is "flat". Default 0.5. */
  flatThreshold?: number;
  /**
   * Original Sample objects, used for near-duplicate detection. When omitted
   * (Report alone) the duplicate check is skipped — Report doesn't carry
   * prompts, only score/cost/latency. The CLI handler reads samples via
   * report.meta.request.samplesPath and passes them in.
   */
  samples?: Sample[];
}

const DEFAULTS: Required<Omit<DiagnoseOptions, 'samples'>> = {
  duplicateRouge: 0.7,
  ambiguousStddev: 1.0,
  costOutlierK: 3,
  latencyOutlierK: 3,
  flatThreshold: 0.5,
};

const SEVERITY_RANK: Record<SampleIssue['severity'], number> = { error: 0, warning: 1, info: 2 };

export function diagnoseSamples(report: Report, options: DiagnoseOptions = {}): SampleDiagnosticReport {
  const opt = { ...DEFAULTS, ...options };
  const variants = report.meta?.variants ?? [];
  const results = report.results ?? [];

  const issues: SampleIssue[] = [];

  if (results.length === 0) {
    return emptyReport(0);
  }

  // Pass 1: per-sample score & cost statistics, plus issue detection that
  // depends only on a single sample's data.
  const sampleStats: Array<{
    entry: ResultEntry;
    scores: number[];        // composite scores per variant (only positive)
    cost: number;            // total cost across all variants for this sample
    latencyMs: number;       // total exec+grade time across variants
    errors: number;          // variants that didn't finish
    judgeStddevs: number[];  // per-variant judge-repeat stddev (when present)
  }> = [];

  for (const entry of results) {
    const scores: number[] = [];
    let cost = 0;
    let latencyMs = 0;
    let errors = 0;
    const judgeStddevs: number[] = [];
    for (const v of variants) {
      const r = entry.variants?.[v];
      if (!r) continue;
      if (typeof r.compositeScore === 'number' && r.compositeScore > 0) scores.push(r.compositeScore);
      cost += r.costUSD ?? 0;
      latencyMs += (r.timing?.totalMs ?? r.durationMs ?? 0);
      if (r.ok === false) errors++;
      if (typeof r.llmScoreStddev === 'number' && r.llmScoreStddev > 0) judgeStddevs.push(r.llmScoreStddev);
    }
    sampleStats.push({ entry, scores, cost, latencyMs, errors, judgeStddevs });

    // Flat / all-pass / all-fail (within-sample score spread).
    if (scores.length >= 2) {
      const max = Math.max(...scores);
      const min = Math.min(...scores);
      if (max === 5 && min === 5) {
        issues.push({
          sample_id: entry.sample_id, severity: 'info', kind: 'all_pass',
          message: `所有 variant 得分均为 5 — 用例可能太简单或断言过宽`,
          evidence: { scores: scoresMap(entry, variants) },
        });
      } else if (max === 1 && min === 1) {
        issues.push({
          sample_id: entry.sample_id, severity: 'error', kind: 'all_fail',
          message: `所有 variant 得分均为 1 — 用例可能 broken / rubric 不可达`,
          evidence: { scores: scoresMap(entry, variants) },
        });
      } else if (max - min < opt.flatThreshold) {
        issues.push({
          sample_id: entry.sample_id, severity: 'warning', kind: 'flat_scores',
          message: `分差 ${(max - min).toFixed(2)} < ${opt.flatThreshold} — 区分度低,该用例对结论贡献小`,
          evidence: { scores: scoresMap(entry, variants), spread: Number((max - min).toFixed(2)) },
        });
      }
    }

    // Errored on at least one variant — sample may be broken (env / executor / fixture).
    if (errors > 0) {
      issues.push({
        sample_id: entry.sample_id, severity: errors === variants.length ? 'error' : 'warning', kind: 'error_prone',
        message: `${errors}/${variants.length} variant 执行失败 — 检查用例配置 / 环境依赖`,
        evidence: { errorCount: errors, variantCount: variants.length },
      });
    }

    // Ambiguous rubric — high judge stddev (only available when judgeRepeat > 1).
    const maxStddev = judgeStddevs.length > 0 ? Math.max(...judgeStddevs) : 0;
    if (maxStddev >= opt.ambiguousStddev) {
      issues.push({
        sample_id: entry.sample_id, severity: 'warning', kind: 'ambiguous_rubric',
        message: `LLM 评委多次评分 stddev ${maxStddev.toFixed(2)} ≥ ${opt.ambiguousStddev} — rubric 可能存在歧义`,
        evidence: { maxStddev: Number(maxStddev.toFixed(2)), stddevs: judgeStddevs.map((s) => Number(s.toFixed(2))) },
      });
    }
  }

  // Pass 2: cost / latency outliers via median-multiplier.
  const costs = sampleStats.map((s) => s.cost).filter((c) => c > 0).sort((a, b) => a - b);
  const latencies = sampleStats.map((s) => s.latencyMs).filter((l) => l > 0).sort((a, b) => a - b);
  const medianCost = costs.length > 0 ? costs[Math.floor(costs.length / 2)] : 0;
  const medianLatency = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : 0;

  for (const s of sampleStats) {
    if (medianCost > 0 && s.cost >= opt.costOutlierK * medianCost) {
      issues.push({
        sample_id: s.entry.sample_id, severity: 'info', kind: 'cost_outlier',
        message: `用例总成本 $${s.cost.toFixed(4)} ≥ ${opt.costOutlierK}× 中位数 $${medianCost.toFixed(4)}`,
        evidence: { cost: Number(s.cost.toFixed(4)), medianCost: Number(medianCost.toFixed(4)) },
      });
    }
    if (medianLatency > 0 && s.latencyMs >= opt.latencyOutlierK * medianLatency) {
      issues.push({
        sample_id: s.entry.sample_id, severity: 'info', kind: 'latency_outlier',
        message: `用例总耗时 ${(s.latencyMs / 1000).toFixed(1)}s ≥ ${opt.latencyOutlierK}× 中位数 ${(medianLatency / 1000).toFixed(1)}s`,
        evidence: { latencyMs: s.latencyMs, medianMs: medianLatency },
      });
    }
  }

  // Pass 3: near-duplicate prompts. Requires the caller to pass `samples`
  // (the original Sample[] from the eval-samples file) — the Report alone
  // doesn't carry prompts. CLI handler reads samples on the fly. To avoid
  // O(N²) blowup on huge sets we cap at 500 samples.
  if (options.samples && options.samples.length > 0 && options.samples.length <= 500) {
    const samplesById = new Map<string, Sample>();
    for (const s of options.samples) samplesById.set(s.sample_id, s);
    const prompts: Array<{ id: string; text: string }> = [];
    for (const entry of results) {
      const sample = samplesById.get(entry.sample_id);
      if (sample?.prompt) prompts.push({ id: entry.sample_id, text: sample.prompt });
    }
    const seenPair = new Set<string>();
    for (let i = 0; i < prompts.length; i++) {
      for (let j = i + 1; j < prompts.length; j++) {
        const score = rougeN(prompts[i].text, prompts[j].text, 1);
        if (score >= opt.duplicateRouge) {
          const key = [prompts[i].id, prompts[j].id].sort().join('|');
          if (seenPair.has(key)) continue;
          seenPair.add(key);
          issues.push({
            sample_id: prompts[i].id, severity: 'warning', kind: 'near_duplicate',
            message: `prompt ROUGE-1 ${score.toFixed(2)} ≥ ${opt.duplicateRouge} 与用例 "${prompts[j].id}" 高度相似`,
            evidence: { duplicateOf: prompts[j].id, rouge1: Number(score.toFixed(2)) },
          });
        }
      }
    }
  }

  // v0.22 — Pass 4: sample design science signals (跟 sample metadata 的 rubric / capability
  // 字段相关,只在 caller 提供 options.samples 时才能跑).
  if (options.samples && options.samples.length > 0) {
    const samplesById = new Map<string, Sample>();
    for (const s of options.samples) samplesById.set(s.sample_id, s);

    // 4a. rubric_clarity_low — static rubric quality signal.
    // 判定:rubric 字符长度 < 20 AND 不含任何评分级别词。两条件 AND 避免长 rubric 没用关键词被误报。
    for (const entry of results) {
      const sample = samplesById.get(entry.sample_id);
      if (!sample?.rubric) continue;
      const rubric = sample.rubric.trim();
      if (rubric.length >= 20) continue;
      if (containsRubricGradeKeyword(rubric)) continue;
      issues.push({
        sample_id: entry.sample_id, severity: 'info', kind: 'rubric_clarity_low',
        message: `rubric 仅 ${rubric.length} 字且未含评分级别词 — 评委标准模糊,可能 judge 分数不稳`,
        evidence: { rubricLength: rubric.length, rubricSnippet: rubric.slice(0, 80) },
      });
    }

    // 4b. capability_thin — 某 capability 只被 ≤ max(2, N*0.2) sample 声明 → 该维度 thin coverage。
    // small-N guard:总 sample < 10 时 completely skip(避免 N=5 全报)。
    if (options.samples.length >= 10) {
      const threshold = Math.max(2, Math.floor(options.samples.length * 0.2));
      const capabilityCount: Record<string, { count: number; sampleIds: string[] }> = {};
      for (const sample of options.samples) {
        if (!Array.isArray(sample.capability)) continue;
        for (const rawCap of sample.capability) {
          if (typeof rawCap !== 'string') continue;
          const cap = normalizeCapability(rawCap);
          if (!capabilityCount[cap]) capabilityCount[cap] = { count: 0, sampleIds: [] };
          capabilityCount[cap].count++;
          capabilityCount[cap].sampleIds.push(sample.sample_id);
        }
      }
      for (const [cap, info] of Object.entries(capabilityCount)) {
        if (info.count > threshold) continue;
        // 报警挂在该 capability 的第一个 sample 上(便于定位),其他在 evidence 里列。
        const primarySampleId = info.sampleIds[0];
        issues.push({
          sample_id: primarySampleId, severity: 'warning', kind: 'capability_thin',
          message: `capability "${cap}" 只 ${info.count} 个 sample 撑(阈值 ${threshold},N=${options.samples.length}) — 单 sample 失败会让该维度结论不稳`,
          evidence: { capability: cap, sampleCount: info.count, threshold, sampleIds: info.sampleIds },
        });
      }
    }
  }

  // Sort and roll up.
  issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.sample_id.localeCompare(b.sample_id));

  const byKind: SampleDiagnosticReport['byKind'] = {};
  for (const i of issues) {
    if (!byKind[i.kind]) byKind[i.kind] = [];
    if (!byKind[i.kind]!.includes(i.sample_id)) byKind[i.kind]!.push(i.sample_id);
  }

  const totals = {
    samples: results.length,
    flagged: new Set(issues.map((i) => i.sample_id)).size,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    infos: issues.filter((i) => i.severity === 'info').length,
  };

  // Health score: 100 minus weighted issue counts, normalized to N samples.
  // Each error costs 8 points, warning 3, info 1 — capped at 100 deduction.
  const rawDeduction = totals.errors * 8 + totals.warnings * 3 + totals.infos * 1;
  const normalized = results.length > 0 ? rawDeduction / results.length : 0;
  // Map to 0-100. Most healthy: deduction near 0 → score ~100.
  // Heavily flagged: deduction > 5 per sample → score → 0.
  const healthScore = Math.max(0, Math.min(100, Math.round(100 - normalized * 20)));

  return { issues, healthScore, byKind, totals };
}

function emptyReport(samples: number): SampleDiagnosticReport {
  return {
    issues: [],
    healthScore: 100,
    byKind: {},
    totals: { samples, flagged: 0, errors: 0, warnings: 0, infos: 0 },
  };
}

function scoresMap(entry: ResultEntry, variants: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of variants) {
    const r = entry.variants?.[v];
    if (r && typeof r.compositeScore === 'number') {
      out[v] = Number(r.compositeScore.toFixed(2));
    }
  }
  return out;
}

// v0.22 — rubric grade-level keywords (中英)。
// 这是 static rubric quality signal,跟 ambiguous_rubric (judge stddev runtime 信号) 互补。
//
// 关键词选择原则:**指向"评分级别 / 评分维度 / 评分阈值"的强语义词**,不要过宽的字典词。
// 反例:'分数' (会误命中"打 5 分"等无关用法)、'标准' (会误命中"标准答案")、'应该' (太通用)。
// 改用组合词 / 评分专用词,提高召回精度。
const RUBRIC_GRADE_KEYWORDS_ZH: readonly string[] = [
  '优秀', '良好', '合格', '不合格', '及格',
  '满分', '零分', '扣分', '加分', '得分',
  '评分标准', '判分标准', '评分要点', '评分级别', '判定标准',
  '至少包含', '必须包含', '不应包含', '应当', '应识别',
];
const RUBRIC_GRADE_KEYWORDS_EN: readonly string[] = [
  'excellent', 'good', 'poor', 'fail', 'pass',
  'rubric', 'criterion', 'criteria',
  'must include', 'must contain', 'should include', 'should contain',
  'at least', 'at most', 'no more than',
  'scored as', 'graded as', 'full marks', 'full score',
];

function containsRubricGradeKeyword(rubric: string): boolean {
  const lower = rubric.toLowerCase();
  for (const kw of RUBRIC_GRADE_KEYWORDS_ZH) {
    if (rubric.includes(kw)) return true;
  }
  for (const kw of RUBRIC_GRADE_KEYWORDS_EN) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

/** v0.22 — case-insensitive + dash/camel/underscore normalize:
 *  `api-selection`, `apiSelection`, `API_Selection` 都归到 `apiselection`。
 *  让 capability_thin / capabilityCoverage 不受拼写风格差异影响。 */
export function normalizeCapability(raw: string): string {
  return raw.trim().toLowerCase().replace(/[-_\s]+/g, '');
}

/**
 * Plain-text formatter for `omk bench diagnose <reportId>`.
 */
export function formatSampleDiagnostics(diag: SampleDiagnosticReport, options: { topN?: number } = {}): string {
  const lines: string[] = [];
  const { topN } = options;
  lines.push('');
  lines.push(`  用例质量诊断 — health score ${diag.healthScore}/100`);
  lines.push(`  用例总数: ${diag.totals.samples}, flagged: ${diag.totals.flagged} (errors=${diag.totals.errors}, warnings=${diag.totals.warnings}, infos=${diag.totals.infos})`);
  lines.push('');

  if (diag.issues.length === 0) {
    lines.push('  ✓ 未检测到用例质量问题');
    lines.push('');
    return lines.join('\n');
  }

  // Group by kind for readability.
  const kinds = Object.keys(diag.byKind) as SampleIssueKind[];
  for (const kind of kinds) {
    const ids = diag.byKind[kind] ?? [];
    if (ids.length === 0) continue;
    lines.push(`  [${kind}] ${ids.length} sample(s)`);
    const matching = diag.issues.filter((i) => i.kind === kind);
    const display = topN ? matching.slice(0, topN) : matching;
    for (const issue of display) {
      const sev = issue.severity === 'error' ? '✗' : issue.severity === 'warning' ? '⚠' : 'ℹ';
      lines.push(`    ${sev} ${issue.sample_id}: ${issue.message}`);
    }
    if (topN && matching.length > topN) {
      lines.push(`    ... 还有 ${matching.length - topN} 个,加 --top 0 看全部`);
    }
    lines.push('');
  }

  // Recommendations based on dominant issue kinds.
  lines.push('  建议:');
  if (diag.byKind.all_pass && diag.byKind.all_pass.length > diag.totals.samples * 0.3) {
    lines.push('  - 用例太简单 (>30% all-pass) — 加难度 / 加更严断言来拉开 variant 差距');
  }
  if (diag.byKind.flat_scores && diag.byKind.flat_scores.length > diag.totals.samples * 0.3) {
    lines.push('  - 多数用例区分度低 — 当前评分维度可能与 skill 差异不正交');
  }
  if (diag.byKind.near_duplicate) {
    lines.push('  - 删除或改写 near-duplicate 用例,避免数据有效维度被挤压');
  }
  if (diag.byKind.ambiguous_rubric) {
    lines.push('  - rubric 在这些用例上歧义大 — 改写 rubric 或加更多确定性断言锚定');
  }
  if (diag.byKind.error_prone) {
    lines.push('  - 这些用例执行失败 — 检查环境依赖 / executor 配置 / 用例本身是否过期');
  }
  // v0.22 — sample design science signals
  if (diag.byKind.rubric_clarity_low) {
    lines.push('  - rubric 太短 / 无评分级别词 — 把 rubric 写成"应识别 X / 必须包含 Y / 至少 N 项"这样的判分细则,让 judge 有可执行标准');
  }
  if (diag.byKind.capability_thin) {
    lines.push('  - 某 capability 维度只 1-2 用例撑 — 要么补 sample 加厚该维度,要么删该 capability(明确不在测试范围),避免单 sample 失败让该维度结论不稳');
  }

  lines.push('');
  return lines.join('\n');
}
