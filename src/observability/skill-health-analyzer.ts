/**
 * Skill health analyzer (v0.18 skill-health).
 *
 * 接 trace-adapter 输出 → 按 skill 维度聚合 coverage + gap,产出 SkillHealthReport。
 * 复用 analysis/coverage-analyzer + analysis/gap-analyzer,跳过对照组逻辑。
 * 定位是"真实使用 trace 的 skill 维度观察",不是通用 APM / 生产监控。
 *
 * 分析流水线:
 *   1. tracesToResultEntries(path) → segments + ResultEntry[]
 *   2. 时间窗 / skill 白名单过滤
 *   3. 按 skill name (variant key) 分别 computeCoverage + computeGapReport
 *   4. 聚合 overall 指标 + 健康度色带
 */

import { buildKnowledgeIndex, computeCoverage, type CoverageReport } from '../analysis/coverage-analyzer.js';
import { computeGapReport } from '../analysis/gap-analyzer.js';
import type { GapReport, ResultEntry, TraceIngestionSummary } from '../types/index.js';
import {
  segmentsToResultEntries,
  skillSegmentTimestampObserved,
  tracesToResultEntries,
  type CcSession,
  type TraceSession,
  type SkillSegment,
} from './trace-adapter.js';
import { legacyCcSessionToTraceSession } from './trace-source.js';
import { createTraceSessionIndex } from './trace-session-index.js';
import { setOwnRecordValue, sumRecordCounts } from '../shared/record-count.js';
import { checkedSumTokenCounts } from '../shared/token-usage.js';

export interface SkillHealth {
  skillName: string;
  segmentCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  toolCancelledCount?: number;
  toolUnknownCount?: number;
  toolResolvedCount?: number;
  toolOutcomeCoverage?: number;
  /** 失败率 = toolFailureCount / 可比较结果数；取消与未知状态不进入分母。 */
  toolFailureRate: number;
  /**
   * 执行稳定性标签。阈值:
   *  - very-unstable: failureRate >= 0.4 (gap 信号极可能是环境问题,不是真知识缺口)
   *  - unstable:      failureRate >= 0.2 (建议排查环境后再看 gap)
   *  - unknown:       有工具调用,但没有可比较的成功 / 失败结果
   *  - stable:        否则
   */
  stability: 'stable' | 'unstable' | 'very-unstable' | 'unknown';
  /**
   * 统计可信度(按 segment 数)。守护「1 段 + 一次失败就判 red」的过度自信:
   *  - underpowered: segmentCount < 5  (样本太少,色带 / gap rate 不可信)
   *  - low:          segmentCount < 20 (只有大缺口可辨)
   *  - high:         >= 20
   * 与 eval 侧 UNDERPOWERED(N<20)同构,渲染层据此弱化低 N 的硬色带。
   */
  confidence: 'high' | 'low' | 'underpowered';
  /** 成本/耗时聚合(来自 SkillSegment.metrics,第四轴). 粒度是 skill 级,非单次调用级 */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    tokenObservedSegmentCount: number;
    tokenCoverage: number;
    durationMs: number;
    numTurns: number;
    avgTokensPerSegment: number;
    avgDurationMsPerSegment: number;
  };
  coverage: CoverageReport | null;
  gap: GapReport;
}

export interface SkillHealthReport {
  /** 顶层判别字段,与 observe-inbox / observe-experience 同属 observe-* 报告族。
   *  可选:历史文件无此字段,reader 靠 meta+overall 识别,不强制(additive,非 BREAKING-SCHEMA)。 */
  kind?: 'observe-health';
  meta: {
    tracePath: string;
    kbPath: string | null;
    sessionCount: number;
    segmentCount: number;
    messageCount: number;
    timestampedSegmentCount?: number;
    timestampCoverage?: number;
    excludedUntimestampedSegmentCount?: number;
    toolCallCount: number;
    toolCancelledCount?: number;
    toolUnknownCount?: number;
    toolResolvedCount?: number;
    toolOutcomeCoverage?: number;
    toolFailureRate: number;
    timeRange: { from: string; to: string };
    generatedAt: string;
    ingestion?: TraceIngestionSummary;
  };
  bySkill: Record<string, SkillHealth>;
  overall: {
    gapRate: number;
    weightedGapRate: number;
    healthBand: 'green' | 'yellow' | 'red';
    /** 整体色带的统计可信度(按总 segment 数)。underpowered/low 时 healthBand 仅供参考。 */
    confidence: 'high' | 'low' | 'underpowered';
  };
}

export interface AnalyzeOptions {
  kbRoot?: string | null;
  from?: string;
  to?: string;
  skills?: string[];
}

function timestampLt(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) ? left < right : a < b;
}

function sumCounts<T>(items: T[], select: (item: T) => number): number {
  let total = 0;
  for (const item of items) {
    total = sumRecordCounts(total, select(item));
  }
  return total;
}

function sumNonNegativeFinite<T>(items: T[], select: (item: T) => number): number {
  let total = 0;
  for (const item of items) {
    const value = select(item);
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`Health metric must be a non-negative finite number, got ${String(value)}`);
    }
    total += value;
    if (!Number.isFinite(total)) {
      throw new RangeError('Health metric sum exceeds the finite number range');
    }
  }
  return total;
}

/**
 * 判断 segment 是否落在时间窗内(闭区间)。
 */
function withinTimeWindow(seg: SkillSegment, from?: string, to?: string): boolean {
  if ((from || to) && !skillSegmentTimestampObserved(seg)) return false;
  if (from && timestampLt(seg.endTimestamp, from)) return false;
  if (to && timestampLt(to, seg.startTimestamp)) return false;
  return true;
}

/**
 * 健康度色带。阈值对齐 bench ci --max-gap-rate 经验值(spec §五)。observe 报告只在 overall 给 band;
 * #235 受管反哺时 observe CLI 用本函数逐 skill 算 band 传入 managed —— 阈值单一来源,managed 不复制。
 */
export function healthBandOf(weightedGapRate: number): 'green' | 'yellow' | 'red' {
  if (weightedGapRate >= 0.3) return 'red';
  if (weightedGapRate >= 0.1) return 'yellow';
  return 'green';
}

/**
 * 按 per-skill 失败率判定执行稳定性。阈值见 SkillHealth.stability。
 */
export function toolStabilityOf(
  toolFailureRate: number,
  comparableToolCalls: number,
  totalToolCalls: number,
): SkillHealth['stability'] {
  if (totalToolCalls > 0 && comparableToolCalls === 0) return 'unknown';
  if (toolFailureRate >= 0.4 && comparableToolCalls >= 5) return 'very-unstable';
  if (toolFailureRate >= 0.2) return 'unstable';
  return 'stable';
}

/** segment 数低于此值,health 色带 / gap rate 视为大缺口才可辨(low confidence)。对齐 eval UNDERPOWERED。 */
const HEALTH_CONFIDENCE_LOW_N = 20;
/** segment 数低于此值,样本太少,色带不可信(underpowered)。 */
const HEALTH_CONFIDENCE_UNDERPOWERED_N = 5;

/** 统计可信度护栏:按 segment 数判 high / low / underpowered,守护「1 段就判 red」。
 *  导出供 renderer / CLI / server 给历史报告(缺 confidence 字段)做 segmentCount 兜底。 */
export function confidenceOf(segmentCount: number): SkillHealth['confidence'] {
  if (segmentCount < HEALTH_CONFIDENCE_UNDERPOWERED_N) return 'underpowered';
  if (segmentCount < HEALTH_CONFIDENCE_LOW_N) return 'low';
  return 'high';
}

/**
 * 聚合一组 segment 的 tokens / duration / turns. 平均值按 segment 数(非 toolCall 数)算。
 */
function aggregateUsage(skillSegs: SkillSegment[]): SkillHealth['usage'] {
  const observed = skillSegs.filter((segment) => segment.metrics.tokenUsageObserved);
  const inputTokens = checkedSumTokenCounts(...observed.map((s) => s.metrics.inputTokens));
  const outputTokens = checkedSumTokenCounts(...observed.map((s) => s.metrics.outputTokens));
  const cacheReadTokens = checkedSumTokenCounts(...observed.map((s) => s.metrics.cacheReadTokens));
  const cacheCreationTokens = checkedSumTokenCounts(...observed.map((s) => s.metrics.cacheCreationTokens));
  const totalTokens = checkedSumTokenCounts(
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  );
  const tokenAggregateValid = [
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
  ].every((value) => value !== undefined);
  const tokenObservedSegmentCount = tokenAggregateValid ? observed.length : 0;
  const durationMs = sumNonNegativeFinite(skillSegs, (segment) => segment.metrics.durationMs);
  const numTurns = sumCounts(skillSegs, (segment) => segment.metrics.numTurns);
  const n = skillSegs.length || 1;
  const tokenDivisor = tokenObservedSegmentCount || 1;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheCreationTokens: cacheCreationTokens ?? 0,
    totalTokens: totalTokens ?? 0,
    tokenObservedSegmentCount,
    tokenCoverage: skillSegs.length > 0
      ? Number((tokenObservedSegmentCount / skillSegs.length).toFixed(4))
      : 1,
    durationMs,
    numTurns,
    avgTokensPerSegment: Math.round((totalTokens ?? 0) / tokenDivisor),
    avgDurationMsPerSegment: Math.round(durationMs / n),
  };
}

/**
 * 推断 KB root: 没传 --kb 时,取第一个 assistant record 的 cwd。
 * 如果跨多个 cwd,取第一个并 warn。
 */
type HealthSession = TraceSession | CcSession;

function inferKbRoot(sessions: HealthSession[]): string | null {
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
 * 主入口：从受支持的 trace 输入生成 SkillHealthReport。
 */
export function computeSkillHealthReport(tracePath: string, opts: AnalyzeOptions = {}): SkillHealthReport {
  const { sessions, segments, ingestion } = tracesToResultEntries(tracePath);
  return computeSkillHealthFromSegments(segments, sessions, tracePath, opts, ingestion);
}

/**
 * 便利入口:直接从已准备好的 segments(跳过 loadCcSessions)算 report。
 * 用于测试 / 已手工组装过 segments 的场景。
 */
export function computeSkillHealthFromSegments(
  segments: SkillSegment[],
  sessions: HealthSession[],
  tracePath: string,
  opts: AnalyzeOptions = {},
  ingestion?: TraceIngestionSummary,
): SkillHealthReport {
  const candidateSegs = segments.filter((segment) => segment.skillName !== 'general');
  const scopedCandidateSegs = opts.skills?.length
    ? candidateSegs.filter((segment) => opts.skills!.includes(segment.skillName))
    : candidateSegs;
  const excludedUntimestampedSegmentCount = opts.from || opts.to
    ? scopedCandidateSegs.filter((segment) => !skillSegmentTimestampObserved(segment)).length
    : 0;
  const finalSegs = scopedCandidateSegs.filter(
    (segment) => withinTimeWindow(segment, opts.from, opts.to),
  );
  const finalEntries = segmentsToResultEntries(finalSegs);
  return buildReport(
    finalSegs,
    finalEntries,
    sessionsForSegments(sessions, finalSegs),
    tracePath,
    opts,
    ingestion,
    excludedUntimestampedSegmentCount,
  );
}

function sessionsForSegments(
  sessions: HealthSession[],
  segments: SkillSegment[],
): HealthSession[] {
  if (segments.length === 0) return [];
  const traceSessions = sessions.map((session) =>
    'events' in session ? session : legacyCcSessionToTraceSession(session)
  );
  const index = createTraceSessionIndex(traceSessions);
  const selectedTraceIds = new Set(
    segments.flatMap((segment) => {
      const session = index.resolve(segment);
      return session ? [session.traceId] : [];
    }),
  );
  return sessions.filter((_, position) => selectedTraceIds.has(traceSessions[position].traceId));
}

function buildReport(
  segments: SkillSegment[],
  entries: ResultEntry[],
  sessions: HealthSession[],
  tracePath: string,
  opts: AnalyzeOptions,
  ingestion?: TraceIngestionSummary,
  excludedUntimestampedSegmentCount = 0,
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
    const skillToolCalls = sumCounts(skillSegs, (segment) => segment.metrics.numToolCalls);
    const skillFailures = sumCounts(skillSegs, (segment) => segment.metrics.numToolFailures);
    const skillCancelled = sumCounts(
      skillSegs,
      (segment) => segment.metrics.numToolCancelled ?? 0,
    );
    const skillUnknown = sumCounts(
      skillSegs,
      (segment) => segment.metrics.numToolUnknown ?? 0,
    );
    const skillResolved = Math.max(0, skillToolCalls - skillUnknown);
    const skillComparable = Math.max(0, skillResolved - skillCancelled);
    const toolFailureRate = skillComparable > 0 ? Number((skillFailures / skillComparable).toFixed(4)) : 0;
    setOwnRecordValue(bySkill, skill, {
      skillName: skill,
      segmentCount: skillSegs.length,
      toolCallCount: skillToolCalls,
      toolFailureCount: skillFailures,
      toolCancelledCount: skillCancelled,
      toolUnknownCount: skillUnknown,
      toolResolvedCount: skillResolved,
      toolOutcomeCoverage: skillToolCalls > 0
        ? Number((skillResolved / skillToolCalls).toFixed(4))
        : 1,
      toolFailureRate,
      stability: toolStabilityOf(toolFailureRate, skillComparable, skillToolCalls),
      confidence: confidenceOf(skillSegs.length),
      usage: aggregateUsage(skillSegs),
      coverage,
      gap,
    });
  }

  const totalSegments = segments.length;
  const healthRows = Object.values(bySkill);
  const totalGap = sumCounts(healthRows, (health) => health.gap.samplesWithGap);
  const totalWeighted = sumNonNegativeFinite(
    healthRows,
    (health) => health.gap.weightedGapRate * health.gap.sampleCount,
  );
  const gapRate = totalSegments > 0 ? Number((totalGap / totalSegments).toFixed(4)) : 0;
  const weightedGapRate = totalSegments > 0 ? Number((totalWeighted / totalSegments).toFixed(4)) : 0;
  const totalToolCalls = sumCounts(segments, (segment) => segment.metrics.numToolCalls);
  const totalFailures = sumCounts(segments, (segment) => segment.metrics.numToolFailures);
  const totalCancelled = sumCounts(
    segments,
    (segment) => segment.metrics.numToolCancelled ?? 0,
  );
  const totalUnknown = sumCounts(
    segments,
    (segment) => segment.metrics.numToolUnknown ?? 0,
  );
  const totalResolved = Math.max(0, totalToolCalls - totalUnknown);
  const totalComparable = Math.max(0, totalResolved - totalCancelled);
  const timestampedSegments = segments.filter(skillSegmentTimestampObserved);
  const timeRange = timestampedSegments.length > 0
    ? {
        from: timestampedSegments.reduce(
          (minimum, segment) =>
            timestampLt(segment.startTimestamp, minimum)
              ? segment.startTimestamp
              : minimum,
          timestampedSegments[0].startTimestamp,
        ),
        to: timestampedSegments.reduce(
          (maximum, segment) =>
            timestampLt(maximum, segment.endTimestamp)
              ? segment.endTimestamp
              : maximum,
          timestampedSegments[0].endTimestamp,
        ),
      }
    : { from: '', to: '' };

  return {
    kind: 'observe-health',
    meta: {
      tracePath,
      kbPath: kbRoot,
      sessionCount: sessions.length,
      segmentCount: totalSegments,
      messageCount: scopedSessionMessageCount(sessions, segments),
      timestampedSegmentCount: timestampedSegments.length,
      timestampCoverage: totalSegments > 0
        ? Number((timestampedSegments.length / totalSegments).toFixed(4))
        : 1,
      excludedUntimestampedSegmentCount,
      toolCallCount: totalToolCalls,
      toolCancelledCount: totalCancelled,
      toolUnknownCount: totalUnknown,
      toolResolvedCount: totalResolved,
      toolOutcomeCoverage: totalToolCalls > 0
        ? Number((totalResolved / totalToolCalls).toFixed(4))
        : 1,
      toolFailureRate: totalComparable > 0 ? Number((totalFailures / totalComparable).toFixed(4)) : 0,
      timeRange,
      generatedAt: new Date().toISOString(),
      ...(ingestion ? { ingestion } : {}),
    },
    bySkill,
    overall: { gapRate, weightedGapRate, healthBand: healthBandOf(weightedGapRate), confidence: confidenceOf(totalSegments) },
  };
}

function scopedSessionMessageCount(
  sessions: HealthSession[],
  segments: SkillSegment[],
): number {
  const traceSessions = sessions.map((session) =>
    'events' in session ? session : legacyCcSessionToTraceSession(session)
  );
  const index = createTraceSessionIndex(traceSessions);
  const rangesByTraceId = new Map<string, Array<{ start: number; end: number }>>();
  const unboundedTraceIds = new Set<string>();
  for (const segment of segments) {
    const session = index.resolve(segment);
    if (!session) continue;
    if (
      segment.startRecordIndex === undefined
      || segment.endRecordIndex === undefined
    ) {
      unboundedTraceIds.add(session.traceId);
      continue;
    }
    const ranges = rangesByTraceId.get(session.traceId) ?? [];
    ranges.push({
      start: segment.startRecordIndex,
      end: segment.endRecordIndex,
    });
    rangesByTraceId.set(session.traceId, ranges);
  }

  let total = 0;
  for (const [position, session] of sessions.entries()) {
    if (!('events' in session)) {
      total = sumRecordCounts(total, sessionMessageCount(session));
      continue;
    }
    const traceId = traceSessions[position].traceId;
    const ranges = unboundedTraceIds.has(traceId)
      ? undefined
      : rangesByTraceId.get(traceId);
    const count = !ranges
      ? sessionMessageCount(session)
      : session.events.filter((event) =>
      event.eventKind === 'message'
      && ranges.some((range) =>
        event.sourceIndex >= range.start && event.sourceIndex <= range.end
      )
    ).length;
    total = sumRecordCounts(total, count);
  }
  return total;
}

function sessionMessageCount(session: HealthSession): number {
  if ('events' in session) {
    return session.events.filter((event) => event.eventKind === 'message').length;
  }
  return session.records.filter((record) => {
    if (!record || typeof record !== 'object') return false;
    const typed = record as {
      type?: unknown;
      message?: { content?: unknown };
    };
    if (typed.type !== 'user' && typed.type !== 'assistant') return false;
    const content = typed.message?.content;
    if (typeof content === 'string') return content.trim().length > 0;
    if (!Array.isArray(content)) return false;
    return content.some((part) =>
      part
      && typeof part === 'object'
      && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string'
      && Boolean((part as { text: string }).text.trim())
    );
  }).length;
}
