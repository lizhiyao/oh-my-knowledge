/**
 * Failure clustering — turn a list of "what failed" into "why it failed".
 *
 * Why this exists
 * ---------------
 * Senior-engineer pain point: 50 samples ran, 14 failed. Reading 14 failure
 * cases one by one is tedious; the user wants the tool to say "8 of these
 * are tool-call errors, 4 are refusals, 2 are formatting errors", with a
 * suggested fix per cluster.
 *
 * This module:
 *
 *  1. Selects failed samples from a report (compositeScore < threshold OR
 *     ok=false on at least one variant).
 *  2. Builds a compact failure description per sample (failed assertion
 *     types + judge reason snippet + tool failure pattern).
 *  3. Sends the full set to a single LLM call asking it to (a) propose
 *     N cluster labels, (b) assign each failure to a cluster, (c) suggest
 *     a fix per cluster.
 *  4. Returns the structured cluster report. Pure function — no I/O,
 *     accepts the executor as an argument.
 *
 * Design choice: single-call LLM clustering rather than embedding-based
 * k-means. Reasons:
 *
 *  - Failure descriptions are short (~50-200 tokens each), so 14 of them
 *    fit comfortably in one prompt. A 50-failure batch is also fine.
 *  - The LLM can produce HUMAN-READABLE cluster labels ("tool call error",
 *    "premature refusal") rather than numeric centroids — exactly what
 *    the user needs to act on.
 *  - One call = one judge cost = predictable. Embedding + clustering
 *    needs N+1 calls minimum.
 *  - Acceptable inaccuracy: clusters are advisory, not load-bearing. We
 *    document this clearly and surface raw failures alongside.
 *
 * The clustering prompt is structured to be JSON-only output for parsing
 * stability. We do NOT include length-debias instructions — clustering is
 * a categorization task, not a quality scoring task, so the length-debias
 * directive is inapplicable.
 */

import type { ExecutorFn, Report, ResultEntry, VariantResult } from '../types.js';

export interface FailureClusterRequest {
  report: Report;
  /** Executor for the clustering LLM call. */
  executor: ExecutorFn;
  /** Model id to use for clustering. */
  judgeModel: string;
  /** Max number of clusters. Default 5; the LLM may produce fewer. */
  maxClusters?: number;
  /** compositeScore < this OR ok=false counts as failure. Default 3. */
  failureThreshold?: number;
  /** Cap on how many failures to feed the LLM (selects worst by score). Default 50. */
  maxFailuresFed?: number;
}

export interface FailureCase {
  sample_id: string;
  variant: string;
  /** Composite score (0 if errored). */
  score: number;
  /** Whether the executor itself errored (ok=false). */
  errored: boolean;
  /** Description summarizing what went wrong, fed to the LLM. */
  description: string;
}

export interface FailureCluster {
  /** Human-readable cluster label, in the report's primary language. */
  label: string;
  /** Free-text root cause analysis from the LLM. */
  rootCause: string;
  /** Suggested fix the user can apply. */
  suggestedFix: string;
  /** Sample IDs (with variant) belonging to this cluster. */
  members: Array<{ sample_id: string; variant: string }>;
}

export interface FailureClusterReport {
  /** All failures considered (after threshold + cap). */
  failures: FailureCase[];
  /** Clusters returned by the LLM, sorted by member count desc. */
  clusters: FailureCluster[];
  /** Failures the LLM didn't put in any cluster (label = "other"). */
  unclassified: Array<{ sample_id: string; variant: string }>;
  /** USD cost of the clustering call. */
  clusterCostUSD: number;
  /** Truncation flag — set when more failures existed than maxFailuresFed. */
  truncated: boolean;
  totalFailures: number;
}

interface JudgeClusterResponse {
  clusters?: Array<{
    label?: string;
    rootCause?: string;
    suggestedFix?: string;
    members?: Array<{ sample_id?: string; variant?: string } | string>;
  }>;
}

const DEFAULT_MAX_CLUSTERS = 5;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_MAX_FED = 50;

export async function clusterFailures(req: FailureClusterRequest): Promise<FailureClusterReport> {
  const {
    report, executor, judgeModel,
    maxClusters = DEFAULT_MAX_CLUSTERS,
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    maxFailuresFed = DEFAULT_MAX_FED,
  } = req;

  const allFailures = collectFailures(report, failureThreshold);
  // Sort by severity (errored > low score) then take up to maxFailuresFed.
  allFailures.sort((a, b) => {
    if (a.errored !== b.errored) return a.errored ? -1 : 1;
    return a.score - b.score;
  });
  const truncated = allFailures.length > maxFailuresFed;
  const fed = allFailures.slice(0, maxFailuresFed);

  if (fed.length === 0) {
    return {
      failures: [], clusters: [], unclassified: [],
      clusterCostUSD: 0, truncated: false, totalFailures: 0,
    };
  }

  // Need at least 2 failures for clustering to be meaningful — with 1 we
  // simply emit a single trivial cluster without calling the LLM.
  if (fed.length === 1) {
    return {
      failures: fed,
      clusters: [{
        label: '单条失败',
        rootCause: '只有 1 条失败,无法聚类',
        suggestedFix: '直接看下面的失败描述',
        members: [{ sample_id: fed[0].sample_id, variant: fed[0].variant }],
      }],
      unclassified: [],
      clusterCostUSD: 0,
      truncated: false,
      totalFailures: 1,
    };
  }

  const prompt = buildClusterPrompt(fed, maxClusters);
  const result = await executor({
    model: judgeModel,
    system: '你是 LLM 评测失败案例分类员。逐条分类,只返回 JSON。',
    prompt,
  });

  if (!result.ok) {
    return {
      failures: fed,
      clusters: [],
      unclassified: fed.map((f) => ({ sample_id: f.sample_id, variant: f.variant })),
      clusterCostUSD: result.costUSD || 0,
      truncated,
      totalFailures: allFailures.length,
    };
  }

  const parsed = parseClusterResponse(result.output ?? '');
  const clusters = normalizeClusters(parsed, fed);

  // Anything fed but not assigned to a cluster lands in unclassified.
  const claimed = new Set<string>();
  for (const c of clusters) {
    for (const m of c.members) claimed.add(`${m.sample_id}::${m.variant}`);
  }
  const unclassified = fed
    .filter((f) => !claimed.has(`${f.sample_id}::${f.variant}`))
    .map((f) => ({ sample_id: f.sample_id, variant: f.variant }));

  clusters.sort((a, b) => b.members.length - a.members.length);

  return {
    failures: fed,
    clusters,
    unclassified,
    clusterCostUSD: result.costUSD || 0,
    truncated,
    totalFailures: allFailures.length,
  };
}

function collectFailures(report: Report, threshold: number): FailureCase[] {
  const variants = report.meta?.variants ?? [];
  const out: FailureCase[] = [];
  for (const entry of report.results ?? []) {
    for (const v of variants) {
      const r = entry.variants?.[v];
      if (!r) continue;
      const score = typeof r.compositeScore === 'number' ? r.compositeScore : 0;
      const errored = r.ok === false;
      if (!errored && score >= threshold) continue;
      out.push({
        sample_id: entry.sample_id,
        variant: v,
        score,
        errored,
        description: describeFailure(entry, v, r),
      });
    }
  }
  return out;
}

/**
 * Build a compact textual description of one failure for the clustering LLM.
 * Keeps it under ~250 tokens so 50 failures fit in a single ~12k token prompt.
 */
function describeFailure(entry: ResultEntry, variant: string, r: VariantResult): string {
  const parts: string[] = [];
  if (r.ok === false) {
    parts.push(`EXEC_ERROR: ${truncate(r.error ?? 'unknown error', 120)}`);
  }
  if (typeof r.compositeScore === 'number' && r.compositeScore < 3) {
    parts.push(`compositeScore=${r.compositeScore.toFixed(2)}`);
  }
  // Failed assertions — top 5 to keep size bounded.
  const failed = (r.assertions?.details ?? [])
    .filter((d) => !d.passed)
    .slice(0, 5)
    .map((d) => `${d.type}(${truncate(String(d.value), 40)})`);
  if (failed.length > 0) {
    parts.push(`failed_assertions=[${failed.join(', ')}]`);
  }
  // Judge reasoning snippet.
  if (r.llmReason) parts.push(`judge_reason="${truncate(r.llmReason, 200)}"`);
  // Tool failures (agent traces).
  const toolFailures = (r.toolCalls ?? []).filter((tc) => !tc.success).slice(0, 3);
  if (toolFailures.length > 0) {
    parts.push(`failed_tools=[${toolFailures.map((tc) => `${tc.tool}: ${truncate(String(tc.output ?? ''), 80)}`).join('; ')}]`);
  }
  // Output preview if nothing else informative.
  if (parts.length === 0 && r.outputPreview) {
    parts.push(`output_preview="${truncate(r.outputPreview, 200)}"`);
  }
  return `[${entry.sample_id}@${variant}] ${parts.join(' | ')}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function buildClusterPrompt(failures: FailureCase[], maxClusters: number): string {
  const lines: string[] = [];
  lines.push(`分析下面 ${failures.length} 条 LLM 评测失败案例,把它们分到 ≤ ${maxClusters} 个 cluster。`);
  lines.push('');
  lines.push('## 失败案例 (每行一条):');
  for (const f of failures) {
    lines.push(f.description);
  }
  lines.push('');
  lines.push('## 任务');
  lines.push(`1. 根据失败模式提出最多 ${maxClusters} 个 cluster (例如:工具调用错误 / 拒答 / 格式错 / 事实错 / 其它)`);
  lines.push('2. 把每条失败分到一个 cluster (用 sample_id@variant 引用)');
  lines.push('3. 每个 cluster 给出根因 + 一条具体修复建议');
  lines.push('');
  lines.push('## 返回格式 (严格 JSON,不要 markdown 代码块):');
  lines.push('{');
  lines.push('  "clusters": [');
  lines.push('    {');
  lines.push('      "label": "<简短中文标签>",');
  lines.push('      "rootCause": "<根因说明,1-2 句>",');
  lines.push('      "suggestedFix": "<修复建议,1-2 句,要可立即操作>",');
  lines.push('      "members": [{"sample_id": "...", "variant": "..."}, ...]');
  lines.push('    }');
  lines.push('  ]');
  lines.push('}');
  return lines.join('\n');
}

function parseClusterResponse(text: string): JudgeClusterResponse {
  const trimmed = text.trim();
  // Tolerate accidental ```json fences from the model.
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { clusters: [] };
  try {
    return JSON.parse(match[0]) as JudgeClusterResponse;
  } catch {
    return { clusters: [] };
  }
}

function normalizeClusters(parsed: JudgeClusterResponse, fed: FailureCase[]): FailureCluster[] {
  const validIds = new Set(fed.map((f) => `${f.sample_id}::${f.variant}`));
  const clusters = parsed.clusters ?? [];
  const out: FailureCluster[] = [];
  for (const c of clusters) {
    const label = typeof c.label === 'string' && c.label ? c.label : '未命名';
    const rootCause = typeof c.rootCause === 'string' ? c.rootCause : '';
    const suggestedFix = typeof c.suggestedFix === 'string' ? c.suggestedFix : '';
    const memberArr = Array.isArray(c.members) ? c.members : [];
    const members: FailureCluster['members'] = [];
    for (const m of memberArr) {
      let sample_id: string | undefined;
      let variant: string | undefined;
      if (typeof m === 'string') {
        // Tolerate "sample_id@variant" string form.
        const parts = m.split('@');
        if (parts.length === 2) { sample_id = parts[0]; variant = parts[1]; }
      } else if (m && typeof m === 'object') {
        sample_id = typeof m.sample_id === 'string' ? m.sample_id : undefined;
        variant = typeof m.variant === 'string' ? m.variant : undefined;
      }
      if (!sample_id || !variant) continue;
      if (!validIds.has(`${sample_id}::${variant}`)) continue; // hallucinated member
      members.push({ sample_id, variant });
    }
    if (members.length > 0) {
      out.push({ label, rootCause, suggestedFix, members });
    }
  }
  return out;
}

export function formatFailureClusterReport(r: FailureClusterReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  失败聚类 — ${r.totalFailures} 条失败${r.truncated ? ` (取最差 ${r.failures.length} 条做聚类)` : ''}`);
  lines.push('');
  if (r.clusters.length === 0) {
    lines.push('  (聚类失败,以下是原始失败列表)');
    for (const f of r.failures.slice(0, 10)) {
      lines.push(`    ${f.sample_id}@${f.variant}: ${truncate(f.description, 120)}`);
    }
    if (r.failures.length > 10) lines.push(`    ... 还有 ${r.failures.length - 10} 条`);
    lines.push('');
    return lines.join('\n');
  }
  for (const c of r.clusters) {
    lines.push(`  [${c.label}] ${c.members.length} 条`);
    if (c.rootCause) lines.push(`    根因: ${c.rootCause}`);
    if (c.suggestedFix) lines.push(`    建议: ${c.suggestedFix}`);
    const display = c.members.slice(0, 5);
    for (const m of display) {
      lines.push(`      - ${m.sample_id}@${m.variant}`);
    }
    if (c.members.length > display.length) {
      lines.push(`      ... 还有 ${c.members.length - display.length} 条`);
    }
    lines.push('');
  }
  if (r.unclassified.length > 0) {
    lines.push(`  [未分类] ${r.unclassified.length} 条`);
    for (const m of r.unclassified.slice(0, 5)) {
      lines.push(`      - ${m.sample_id}@${m.variant}`);
    }
    if (r.unclassified.length > 5) lines.push(`      ... 还有 ${r.unclassified.length - 5} 条`);
    lines.push('');
  }
  lines.push(`  聚类调用 cost: $${r.clusterCostUSD.toFixed(6)}`);
  lines.push('');
  return lines.join('\n');
}
