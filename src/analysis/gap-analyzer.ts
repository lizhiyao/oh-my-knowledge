/**
 * Knowledge gap signal analyzer.
 *
 * Implements the v0.1 detection pipeline defined in
 * docs/knowledge-gap-signal-spec.md:
 *
 *   gap_rate = (samples with ≥1 gap signal) / (successfully-executed samples)
 *
 * Four signal types are extracted per sample:
 *   1. failed_search      — Grep/Read/Bash search that returned empty or failed
 *   2. explicit_marker    — 【推断】【知识缺口】【未知】 markers in agent output
 *   3. hedging            — hedging language in agent output (accepts FP in v0.1)
 *   4. repeated_failure   — ≥3 consecutive failed searches of the same tool type
 *
 * Intentionally does NOT touch report rendering, trends, or CI — those are
 * step-3 work. This module only computes the structured GapReport.
 */

import type { GapReport, GapSignalRef, ResultEntry, ToolCallInfo, TurnInfo, VariantResult } from '../types.js';

export type GapSignalType = GapSignalRef['type'];
export type GapSignal = GapSignalRef;

// ---------- Pattern tables ----------

const EXPLICIT_MARKER_PATTERNS: RegExp[] = [
  /【推断】/g,
  /【知识缺口】/g,
  /【未知】/g,
  /\[inferred\]/gi,
  /\[unknown\]/gi,
  /\[knowledge\s*gap\]/gi,
];

// v0.1 hedging patterns. Known to have false positives (e.g. "可能是" in normal
// speech). Spec Section 4.3 accepts this in v0.1 and plans LLM-assisted
// classification for v0.2.
const HEDGING_PATTERNS: RegExp[] = [
  /我不确定/g,
  /没有足够信息/g,
  /需要查证/g,
  /无法确认/g,
  /\bI['\s]?m not sure\b/gi,
  /\binsufficient information\b/gi,
  /\bneed to verify\b/gi,
  /\bpresumably\b/gi,
];

/** Minimum consecutive failed-search count to trigger a repeated_failure signal. */
const REPEATED_FAILURE_THRESHOLD = 3;

/**
 * v0.2 severity weights (spec §6).
 *
 * Strong (1.0): 硬证据类——agent 工具层真的撞墙了
 *   - failed_search: Grep/Read 返回空或失败,确定性 miss
 *   - repeated_failure: 同一类查询连续 ≥3 次失败,已不是偶然
 *
 * Weak (0.5): 自我陈述类——依赖模型配合,可能假阳
 *   - explicit_marker: 依赖 agent 按约定打【推断】等标记,可能漏标
 *   - hedging: 字符串匹配 "我不确定/可能是"等,假阳率已知较高(spec §2.8)
 *
 * Aggregation: 每个样本取其信号的最高权重作"样本严重度",平均到 weightedGapRate。
 * weightedGapRate ≤ gapRate,差值反映"软信号占比"——读者据此判断结果可信度。
 */
export const SIGNAL_WEIGHTS: Record<GapSignalType, number> = {
  failed_search: 1.0,
  repeated_failure: 1.0,
  explicit_marker: 0.5,
  hedging: 0.5,
};

// ---------- Signal 1: failed searches ----------

/**
 * Decide whether a tool call counts as a "failed search" signal.
 *
 * Covers:
 *   - Read with success: false
 *   - Grep with success: false
 *   - Grep with success but empty/"No matches found" output (still a miss)
 *   - Bash with grep/rg/find in the command and either failure or empty output
 */
export function isFailedSearchTool(tc: ToolCallInfo): boolean {
  const output = typeof tc.output === 'string' ? tc.output : String(tc.output ?? '');
  const emptyOutput = output.trim() === '' || /No matches found/i.test(output);

  if (tc.tool === 'Read') {
    return tc.success === false;
  }

  if (tc.tool === 'Grep') {
    if (tc.success === false) return true;
    return emptyOutput;
  }

  if (tc.tool === 'Bash') {
    const cmd = ((tc.input as { command?: string } | null)?.command) || '';
    if (!/\b(grep|rg|find)\b/.test(cmd)) return false;
    if (tc.success === false) return true;
    return emptyOutput;
  }

  return false;
}

function formatToolEvidence(tc: ToolCallInfo): { pattern: string; path: string; context: string } {
  const input = (tc.input as Record<string, unknown> | null) || {};
  let pattern = '';
  let path = '';
  if (tc.tool === 'Grep') {
    pattern = String(input.pattern ?? '');
    path = String(input.path ?? '');
  } else if (tc.tool === 'Read') {
    path = String(input.file_path ?? '');
  } else if (tc.tool === 'Bash') {
    pattern = String(input.command ?? '').slice(0, 120);
  }
  const context = `${tc.tool}: ${pattern || path}`.slice(0, 160);
  return { pattern, path, context };
}

/**
 * Extract failed-search signals from a flat tool call sequence.
 * Deduplicates consecutive duplicates (same tool + same pattern) so an agent
 * that retries the exact same Grep 5 times counts as one signal, not five.
 */
export function extractFailedSearchSignals(toolCalls: ToolCallInfo[]): GapSignal[] {
  const raw: GapSignal[] = [];
  for (const tc of toolCalls) {
    if (!isFailedSearchTool(tc)) continue;
    const { pattern, path, context } = formatToolEvidence(tc);
    raw.push({
      sampleId: '',
      type: 'failed_search',
      context,
      evidence: { tool: tc.tool, pattern, path, success: tc.success },
      weight: SIGNAL_WEIGHTS.failed_search,
    });
  }
  // Dedup consecutive identical signals
  const deduped: GapSignal[] = [];
  for (const s of raw) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.type === s.type && prev.context === s.context) continue;
    deduped.push(s);
  }
  return deduped;
}

// ---------- Signals 2 & 3: text-based (markers + hedging) ----------

function collectAssistantText(vr: VariantResult): string {
  const parts: string[] = [];
  if (vr.turns) {
    for (const turn of vr.turns) {
      if (turn.role === 'assistant' && turn.content) parts.push(turn.content);
    }
  }
  // Fallback: fullOutput if turns are missing (some executors only emit final text)
  if (parts.length === 0 && vr.fullOutput) parts.push(vr.fullOutput);
  return parts.join('\n');
}

/**
 * Find explicit "I'm inferring / I don't know" markers in agent output text.
 * Each marker occurrence produces one signal; dedupe is at the sample level
 * (handled by the aggregator, not here).
 */
export function extractMarkerSignals(text: string): GapSignal[] {
  const signals: GapSignal[] = [];
  if (!text) return signals;
  for (const pat of EXPLICIT_MARKER_PATTERNS) {
    let match: RegExpExecArray | null;
    // Reset lastIndex for the global regex to be safe on reuse
    pat.lastIndex = 0;
    while ((match = pat.exec(text)) !== null) {
      const idx = match.index;
      const snippet = text.slice(Math.max(0, idx - 20), Math.min(text.length, idx + match[0].length + 60));
      signals.push({
        sampleId: '',
        type: 'explicit_marker',
        context: snippet.replace(/\s+/g, ' ').trim().slice(0, 160),
        evidence: { marker: match[0] },
        weight: SIGNAL_WEIGHTS.explicit_marker,
      });
    }
  }
  return signals;
}

/**
 * Match hedging-language phrases in agent output text.
 * v0.1 emits at most one hedging signal per sample — the aggregator upgrades
 * this from "per pattern" to "per sample", since multiple hedges in the same
 * turn are usually coming from the same epistemic state.
 */
export function extractHedgingSignals(text: string): GapSignal[] {
  if (!text) return [];
  for (const pat of HEDGING_PATTERNS) {
    pat.lastIndex = 0;
    const match = pat.exec(text);
    if (!match) continue;
    const idx = match.index;
    const snippet = text.slice(Math.max(0, idx - 15), Math.min(text.length, idx + match[0].length + 50));
    return [{
      sampleId: '',
      type: 'hedging',
      context: snippet.replace(/\s+/g, ' ').trim().slice(0, 160),
      evidence: { matched: match[0] },
      weight: SIGNAL_WEIGHTS.hedging,
    }];
  }
  return [];
}

// ---------- Signal 4: repeated failure pattern ----------

/**
 * Detect ≥N consecutive failed searches of the same tool type within a turn
 * sequence. Each qualifying run emits exactly one signal anchored at the
 * first failure in the run.
 */
export function extractRepeatedFailureSignals(turns: TurnInfo[] | undefined): GapSignal[] {
  if (!turns || turns.length === 0) return [];
  const signals: GapSignal[] = [];
  let run: { tool: string; count: number; startTurn: number } | null = null;
  let emittedForThisRun = false;

  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti];
    if (!turn.toolCalls || turn.toolCalls.length === 0) continue;

    for (const tc of turn.toolCalls) {
      if (isFailedSearchTool(tc)) {
        if (run && run.tool === tc.tool) {
          run.count += 1;
        } else {
          run = { tool: tc.tool, count: 1, startTurn: ti };
          emittedForThisRun = false;
        }
        if (!emittedForThisRun && run.count >= REPEATED_FAILURE_THRESHOLD) {
          signals.push({
            sampleId: '',
            type: 'repeated_failure',
            turn: run.startTurn,
            context: `${run.tool}: 连续失败 ≥${REPEATED_FAILURE_THRESHOLD} 次`,
            evidence: { tool: run.tool, count: run.count, startTurn: run.startTurn },
            weight: SIGNAL_WEIGHTS.repeated_failure,
          });
          emittedForThisRun = true;
        }
      } else {
        run = null;
        emittedForThisRun = false;
      }
    }
  }
  return signals;
}

// ---------- Per-sample aggregation ----------

/**
 * Run all four signal extractors on a single variant's result for one sample.
 * Output signals carry the provided sampleId.
 */
export function extractGapSignalsFromSample(variantResult: VariantResult, sampleId: string): GapSignal[] {
  // 1. Failed searches — flatten all tool calls across turns + top-level fallback
  const toolCalls: ToolCallInfo[] = [];
  if (variantResult.turns) {
    for (const turn of variantResult.turns) {
      if (turn.toolCalls) toolCalls.push(...turn.toolCalls);
    }
  }
  if (toolCalls.length === 0 && variantResult.toolCalls) {
    toolCalls.push(...variantResult.toolCalls);
  }
  const failedSearchSignals = extractFailedSearchSignals(toolCalls);

  // 2 & 3. Text-based signals
  const assistantText = collectAssistantText(variantResult);
  const markerSignals = extractMarkerSignals(assistantText);
  const hedgingSignals = extractHedgingSignals(assistantText);

  // 4. Repeated failure (turn-ordered, so we need turns not flat toolCalls)
  const repeatedFailureSignals = extractRepeatedFailureSignals(variantResult.turns);

  const all = [...failedSearchSignals, ...markerSignals, ...hedgingSignals, ...repeatedFailureSignals];
  return all.map((s) => ({ ...s, sampleId }));
}

// ---------- Report-level aggregation ----------

/**
 * Compute the gap report for one variant across all samples in a report.
 *
 * Denominator rule (spec §5): samples with `ok: false` (the variant completely
 * failed to execute) are EXCLUDED from both numerator and denominator.
 * gap_rate is computed only on samples that actually produced a trace.
 */
export function computeGapReport(results: ResultEntry[], variant: string): GapReport {
  const signals: GapSignal[] = [];
  const sampleIdsWithGap = new Set<string>();
  // 每样本取信号中的最强权重,用于 weightedGapRate(v0.2 §6)。
  // 无信号样本 sampleWeight 隐含为 0,自然不计入 weighted 和。
  const sampleMaxWeight = new Map<string, number>();
  let sampleCount = 0;

  for (const entry of results) {
    const vr = entry.variants?.[variant];
    if (!vr || vr.ok === false) continue;
    sampleCount += 1;

    const sampleSignals = extractGapSignalsFromSample(vr, entry.sample_id);
    if (sampleSignals.length > 0) {
      sampleIdsWithGap.add(entry.sample_id);
      signals.push(...sampleSignals);
      const maxW = sampleSignals.reduce((m, s) => (s.weight > m ? s.weight : m), 0);
      sampleMaxWeight.set(entry.sample_id, maxW);
    }
  }

  const samplesWithGap = sampleIdsWithGap.size;
  const gapRate = sampleCount > 0 ? Number((samplesWithGap / sampleCount).toFixed(4)) : 0;

  const weightSum = Array.from(sampleMaxWeight.values()).reduce((a, b) => a + b, 0);
  const weightedGapRate = sampleCount > 0 ? Number((weightSum / sampleCount).toFixed(4)) : 0;

  const byType: Record<GapSignalType, number> = {
    failed_search: 0,
    explicit_marker: 0,
    hedging: 0,
    repeated_failure: 0,
  };
  for (const s of signals) byType[s.type] += 1;

  return {
    variant,
    sampleCount,
    samplesWithGap,
    gapRate,
    weightedGapRate,
    testSetPath: null,
    testSetHash: null,
    signals,
    byType,
  };
}

/**
 * Compute gap reports for every variant in a Report. Convenience wrapper.
 */
export function computeReportGapRates(results: ResultEntry[], variants: string[]): Record<string, GapReport> {
  const out: Record<string, GapReport> = {};
  for (const v of variants) {
    out[v] = computeGapReport(results, v);
  }
  return out;
}
