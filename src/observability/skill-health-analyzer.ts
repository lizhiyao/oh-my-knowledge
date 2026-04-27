/**
 * Skill health analyzer (v0.18 skill-health).
 *
 * 接 trace-adapter 输出 → 按 skill 维度聚合 coverage + gap,产出 SkillHealthReport。
 * 复用 analysis/coverage-analyzer + analysis/gap-analyzer,跳过对照组逻辑。
 * 定位是"真实使用 trace 的 skill 维度观察",不是通用 APM / 生产监控。
 *
 * 分析流水线:
 *   1. ccTracesToResultEntries(path) → segments + ResultEntry[]
 *   2. 时间窗 / skill 白名单过滤
 *   3. 按 skill name (variant key) 分别 computeCoverage + computeGapReport
 *   4. 聚合 overall 指标 + 健康度色带
 */

import { buildKnowledgeIndex, computeCoverage, type CoverageReport } from '../analysis/coverage-analyzer.js';
import { computeGapReport } from '../analysis/gap-analyzer.js';
import type { GapReport, ResultEntry } from '../types/index.js';
import {
  ccTracesToResultEntries,
  segmentsToResultEntries,
  type CcSession,
  type SkillSegment,
} from './trace-adapter.js';

export interface SkillHealth {
  skillName: string;
  segmentCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  /** 失败率 = toolFailureCount / toolCallCount; toolCallCount=0 时为 0 */
  toolFailureRate: number;
  /**
   * 执行稳定性标签。阈值:
   *  - very-unstable: failureRate >= 0.4 (gap 信号极可能是环境问题,不是真知识缺口)
   *  - unstable:      failureRate >= 0.2 (建议排查环境后再看 gap)
   *  - stable:        否则
   */
  stability: 'stable' | 'unstable' | 'very-unstable';
  /** 成本/耗时聚合(来自 SkillSegment.metrics,第四轴). 粒度是 skill 级,非单次调用级 */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    durationMs: number;
    numTurns: number;
    avgTokensPerSegment: number;
    avgDurationMsPerSegment: number;
  };
  coverage: CoverageReport | null;
  gap: GapReport;
}

export interface SkillHealthReport {
  meta: {
    tracePath: string;
    kbPath: string | null;
    sessionCount: number;
    segmentCount: number;
    messageCount: number;
    toolCallCount: number;
    toolFailureRate: number;
    timeRange: { from: string; to: string };
    generatedAt: string;
  };
  bySkill: Record<string, SkillHealth>;
  overall: {
    gapRate: number;
    weightedGapRate: number;
    healthBand: 'green' | 'yellow' | 'red';
  };
}

export interface AnalyzeOptions {
  kbRoot?: string | null;
  from?: string;
  to?: string;
  skills?: string[];
}

/**
 * 从时间戳字符串比较。ISO8601 字典序即时序,直接用字符串比较。
 */
function timestampLt(a: string, b: string): boolean {
  return a < b;
}

/**
 * 判断 segment 是否落在时间窗内(闭区间)。
 */
function withinTimeWindow(seg: SkillSegment, from?: string, to?: string): boolean {
  if (from && timestampLt(seg.startTimestamp, from)) return false;
  if (to && timestampLt(to, seg.startTimestamp)) return false;
  return true;
}

/**
 * overall 健康度色带。阈值对齐 bench ci --max-gap-rate 经验值(spec §五)。
 */
function healthBandOf(weightedGapRate: number): 'green' | 'yellow' | 'red' {
  if (weightedGapRate >= 0.3) return 'red';
  if (weightedGapRate >= 0.1) return 'yellow';
  return 'green';
}

/**
 * 按 per-skill 失败率判定执行稳定性。阈值见 SkillHealth.stability。
 */
function stabilityOf(toolFailureRate: number): SkillHealth['stability'] {
  if (toolFailureRate >= 0.4) return 'very-unstable';
  if (toolFailureRate >= 0.2) return 'unstable';
  return 'stable';
}

/**
 * 聚合一组 segment 的 tokens / duration / turns. 平均值按 segment 数(非 toolCall 数)算。
 */
function aggregateUsage(skillSegs: SkillSegment[]): SkillHealth['usage'] {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let durationMs = 0;
  let numTurns = 0;
  for (const s of skillSegs) {
    inputTokens += s.metrics.inputTokens ?? 0;
    outputTokens += s.metrics.outputTokens ?? 0;
    cacheReadTokens += s.metrics.cacheReadTokens ?? 0;
    cacheCreationTokens += s.metrics.cacheCreationTokens ?? 0;
    durationMs += s.metrics.durationMs ?? 0;
    numTurns += s.metrics.numTurns ?? 0;
  }
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  const n = skillSegs.length || 1;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    durationMs,
    numTurns,
    avgTokensPerSegment: Math.round(totalTokens / n),
    avgDurationMsPerSegment: Math.round(durationMs / n),
  };
}

/**
 * 推断 KB root: 没传 --kb 时,取第一个 assistant record 的 cwd。
 * 如果跨多个 cwd,取第一个并 warn。
 */
function inferKbRoot(sessions: CcSession[]): string | null {
  const cwds = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) cwds.add(s.cwd);
  }
  if (cwds.size === 0) return null;
  if (cwds.size > 1) {
    process.stderr.write(`[omk] analyze: trace spans ${cwds.size} projects, coverage defaults to first cwd. Pass --kb explicitly for cross-project analysis.\n`);
  }
  return cwds.values().next().value ?? null;
}

/**
 * 主入口:从 cc trace 目录生成 SkillHealthReport。
 */
export function computeSkillHealthReport(tracePath: string, opts: AnalyzeOptions = {}): SkillHealthReport {
  const { sessions, segments } = ccTracesToResultEntries(tracePath);

  // 时间窗 + skill 白名单过滤
  let filtered = segments.filter((s) => withinTimeWindow(s, opts.from, opts.to));
  if (opts.skills?.length) {
    const allow = new Set(opts.skills);
    filtered = filtered.filter((s) => allow.has(s.skillName));
  }
  const filteredEntries = segmentsToResultEntries(filtered);

  // 推断 KB root
  const kbRoot = opts.kbRoot ?? inferKbRoot(sessions);
  const index = kbRoot ? buildKnowledgeIndex(kbRoot) : null;

  // 按 skill 分组聚合
  const skillNames = [...new Set(filtered.map((s) => s.skillName))];
  const bySkill: Record<string, SkillHealth> = {};
  for (const skill of skillNames) {
    const skillSegs = filtered.filter((s) => s.skillName === skill);
    const coverage = index ? computeCoverage(filteredEntries, skill, index, kbRoot) : null;
    const gap = computeGapReport(filteredEntries, skill);
    // 挂 trace 源作水印(spec §六)
    gap.testSetPath = tracePath;
    const skillToolCalls = skillSegs.reduce((a, s) => a + s.metrics.numToolCalls, 0);
    const skillFailures = skillSegs.reduce((a, s) => a + s.metrics.numToolFailures, 0);
    const toolFailureRate = skillToolCalls > 0 ? Number((skillFailures / skillToolCalls).toFixed(4)) : 0;
    bySkill[skill] = {
      skillName: skill,
      segmentCount: skillSegs.length,
      toolCallCount: skillToolCalls,
      toolFailureCount: skillFailures,
      toolFailureRate,
      stability: stabilityOf(toolFailureRate),
      usage: aggregateUsage(skillSegs),
      coverage,
      gap,
    };
  }

  // Overall 聚合(加权平均,权重 = 每个 skill 的 segment 数)
  const totalSegments = filtered.length;
  const totalGap = Object.values(bySkill).reduce((a, h) => a + h.gap.samplesWithGap, 0);
  const totalWeighted = Object.values(bySkill).reduce(
    (a, h) => a + h.gap.weightedGapRate * h.gap.sampleCount,
    0,
  );
  const gapRate = totalSegments > 0 ? Number((totalGap / totalSegments).toFixed(4)) : 0;
  const weightedGapRate = totalSegments > 0 ? Number((totalWeighted / totalSegments).toFixed(4)) : 0;

  // meta
  const totalToolCalls = filtered.reduce((a, s) => a + s.metrics.numToolCalls, 0);
  const totalFailures = filtered.reduce((a, s) => a + s.metrics.numToolFailures, 0);
  const timeRange = filtered.length > 0
    ? {
        from: filtered.reduce((m, s) => (timestampLt(s.startTimestamp, m) ? s.startTimestamp : m), filtered[0].startTimestamp),
        to: filtered.reduce((m, s) => (timestampLt(m, s.endTimestamp) ? s.endTimestamp : m), filtered[0].endTimestamp),
      }
    : { from: '', to: '' };

  return {
    meta: {
      tracePath,
      kbPath: kbRoot,
      sessionCount: sessions.length,
      segmentCount: totalSegments,
      messageCount: sessions.reduce((a, s) => a + s.records.length, 0),
      toolCallCount: totalToolCalls,
      toolFailureRate: totalToolCalls > 0 ? Number((totalFailures / totalToolCalls).toFixed(4)) : 0,
      timeRange,
      generatedAt: new Date().toISOString(),
    },
    bySkill,
    overall: { gapRate, weightedGapRate, healthBand: healthBandOf(weightedGapRate) },
  };
}

/**
 * 便利入口:直接从已准备好的 segments(跳过 loadCcSessions)算 report。
 * 用于测试 / 已手工组装过 segments 的场景。
 */
export function computeSkillHealthFromSegments(
  segments: SkillSegment[],
  sessions: CcSession[],
  tracePath: string,
  opts: AnalyzeOptions = {},
): SkillHealthReport {
  const filteredSegs = segments.filter((s) => withinTimeWindow(s, opts.from, opts.to));
  const finalSegs = opts.skills?.length
    ? filteredSegs.filter((s) => opts.skills!.includes(s.skillName))
    : filteredSegs;
  const finalEntries = segmentsToResultEntries(finalSegs);
  return buildReport(finalSegs, finalEntries, sessions, tracePath, opts);
}

function buildReport(
  segments: SkillSegment[],
  entries: ResultEntry[],
  sessions: CcSession[],
  tracePath: string,
  opts: AnalyzeOptions,
): SkillHealthReport {
  const kbRoot = opts.kbRoot ?? inferKbRoot(sessions);
  const index = kbRoot ? buildKnowledgeIndex(kbRoot) : null;

  const skillNames = [...new Set(segments.map((s) => s.skillName))];
  const bySkill: Record<string, SkillHealth> = {};
  for (const skill of skillNames) {
    const skillSegs = segments.filter((s) => s.skillName === skill);
    const coverage = index ? computeCoverage(entries, skill, index, kbRoot) : null;
    const gap = computeGapReport(entries, skill);
    gap.testSetPath = tracePath;
    const skillToolCalls = skillSegs.reduce((a, s) => a + s.metrics.numToolCalls, 0);
    const skillFailures = skillSegs.reduce((a, s) => a + s.metrics.numToolFailures, 0);
    const toolFailureRate = skillToolCalls > 0 ? Number((skillFailures / skillToolCalls).toFixed(4)) : 0;
    bySkill[skill] = {
      skillName: skill,
      segmentCount: skillSegs.length,
      toolCallCount: skillToolCalls,
      toolFailureCount: skillFailures,
      toolFailureRate,
      stability: stabilityOf(toolFailureRate),
      usage: aggregateUsage(skillSegs),
      coverage,
      gap,
    };
  }

  const totalSegments = segments.length;
  const totalGap = Object.values(bySkill).reduce((a, h) => a + h.gap.samplesWithGap, 0);
  const totalWeighted = Object.values(bySkill).reduce(
    (a, h) => a + h.gap.weightedGapRate * h.gap.sampleCount,
    0,
  );
  const gapRate = totalSegments > 0 ? Number((totalGap / totalSegments).toFixed(4)) : 0;
  const weightedGapRate = totalSegments > 0 ? Number((totalWeighted / totalSegments).toFixed(4)) : 0;
  const totalToolCalls = segments.reduce((a, s) => a + s.metrics.numToolCalls, 0);
  const totalFailures = segments.reduce((a, s) => a + s.metrics.numToolFailures, 0);
  const timeRange = segments.length > 0
    ? {
        from: segments.reduce((m, s) => (timestampLt(s.startTimestamp, m) ? s.startTimestamp : m), segments[0].startTimestamp),
        to: segments.reduce((m, s) => (timestampLt(m, s.endTimestamp) ? s.endTimestamp : m), segments[0].endTimestamp),
      }
    : { from: '', to: '' };

  return {
    meta: {
      tracePath,
      kbPath: kbRoot,
      sessionCount: sessions.length,
      segmentCount: totalSegments,
      messageCount: sessions.reduce((a, s) => a + s.records.length, 0),
      toolCallCount: totalToolCalls,
      toolFailureRate: totalToolCalls > 0 ? Number((totalFailures / totalToolCalls).toFixed(4)) : 0,
      timeRange,
      generatedAt: new Date().toISOString(),
    },
    bySkill,
    overall: { gapRate, weightedGapRate, healthBand: healthBandOf(weightedGapRate) },
  };
}
