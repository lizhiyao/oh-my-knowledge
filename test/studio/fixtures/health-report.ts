import type { CoverageReport } from '../../../src/observability/analysis/coverage-analyzer.js';
import type { GapReport } from '../../../src/observability/analysis/contracts.js';
import type { SkillHealth, SkillHealthReport } from '../../../src/observability/skill-health/analyzer.js';
import type { SkillTrendPoint } from '../../../src/studio/view-models/knowledge-reports.js';

/**
 * 观测健康报告夹具：只造页面口径要读的字段，其余按真实报告的派生关系补齐，
 * 让投影测试锁的是「同一份 JSON 在页面与 CLI 上得到同一个结论」，而不是字段搬运。
 */

export interface SkillOptions {
  readonly segments?: number;
  readonly confidence?: SkillHealth['confidence'];
  readonly gapRate?: number;
  readonly weightedGapRate?: number;
  readonly byType?: Partial<GapReport['byType']>;
  readonly coverage?: CoverageReport | null;
  readonly toolCalls?: number;
  readonly toolFailures?: number;
  readonly toolCancelled?: number;
  readonly toolUnknown?: number;
  /** 缺省时按「已记录调用都可判成败」兜底，用于模拟旧报告。 */
  readonly toolResolved?: number;
  /** true 时整组 tool*Count 细分字段缺席，模拟 toolResolvedCount 之前的旧 JSON。 */
  readonly legacyTools?: boolean;
  readonly stability?: SkillHealth['stability'];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheTokens?: number;
  readonly tokenCoverage?: number;
  readonly durationMs?: number;
  readonly numTurns?: number;
}

/** `[path, accessed]` 清单 → coverage 报告；filesCovered 与之一致。 */
export function coverageOf(
  entries: readonly (readonly [string, boolean])[],
  over: { readonly grepPatternsUsed?: number; readonly type?: CoverageReport['entries'][number]['type'] } = {},
): CoverageReport {
  const filesCovered = entries.filter(([, accessed]) => accessed).length;
  return {
    entries: entries.map(([path, accessed], index) => ({
      path,
      type: over.type ?? 'design',
      accessed,
      accessCount: accessed ? 1 : 0,
      ...(index === 0 ? { lineCount: 12 } : {}),
    })),
    filesCovered,
    filesTotal: entries.length,
    fileCoverageRate: entries.length === 0 ? 0 : filesCovered / entries.length,
    uncoveredFiles: entries.filter(([, accessed]) => !accessed).map(([path]) => path),
    grepPatternsUsed: over.grepPatternsUsed ?? 3,
    overallRate: entries.length === 0 ? 0 : filesCovered / entries.length,
  };
}

export function skillOf(name: string, o: SkillOptions = {}): SkillHealth {
  const segments = o.segments ?? 40;
  const toolCalls = o.toolCalls ?? 10;
  const toolFailures = o.toolFailures ?? 0;
  const cancelled = o.toolCancelled ?? 0;
  const unknown = o.toolUnknown ?? 0;
  const legacy = o.legacyTools ?? false;
  const resolved = o.toolResolved ?? Math.max(0, toolCalls - unknown);
  const comparable = legacy ? toolCalls : Math.max(0, resolved - cancelled);
  const gapRate = o.gapRate ?? 0;
  const byType = { failed_search: 0, explicit_marker: 0, hedging: 0, repeated_failure: 0, ...o.byType };
  const inputTokens = o.inputTokens ?? 0;
  const outputTokens = o.outputTokens ?? 0;
  const cacheTokens = o.cacheTokens ?? 0;
  return {
    skillName: name,
    segmentCount: segments,
    toolCallCount: toolCalls,
    toolFailureCount: toolFailures,
    // 旧报告只有 toolCallCount/toolFailureCount，成败分母由读取侧兜底，这条形状必须能被造出来。
    ...(legacy
      ? {}
      : { toolCancelledCount: cancelled, toolUnknownCount: unknown, toolResolvedCount: resolved }),
    toolFailureRate: comparable === 0 ? 0 : toolFailures / comparable,
    stability: o.stability ?? (comparable === 0 ? 'unknown' : 'stable'),
    confidence: o.confidence ?? (segments < 5 ? 'underpowered' : segments < 20 ? 'low' : 'high'),
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheTokens,
      cacheCreationTokens: 0,
      totalTokens: inputTokens + outputTokens + cacheTokens,
      tokenObservedSegmentCount: segments,
      tokenCoverage: o.tokenCoverage ?? 1,
      durationMs: o.durationMs ?? 0,
      numTurns: o.numTurns ?? 0,
      avgTokensPerSegment: segments === 0 ? 0 : (inputTokens + outputTokens) / segments,
      avgDurationMsPerSegment: segments === 0 ? 0 : (o.durationMs ?? 0) / segments,
    },
    coverage: o.coverage === undefined ? null : o.coverage,
    gap: {
      variant: 'treatment',
      sampleCount: segments,
      samplesWithGap: Math.round(gapRate * segments),
      gapRate,
      weightedGapRate: o.weightedGapRate ?? gapRate,
      signals: [],
      byType,
    },
  };
}

export interface ReportOptions {
  readonly segments?: number;
  readonly sessions?: number;
  readonly confidence?: SkillHealthReport['overall']['confidence'];
  readonly band?: SkillHealthReport['overall']['healthBand'];
  readonly gapRate?: number;
  readonly weightedGapRate?: number;
  readonly tracePath?: string;
  readonly kbPath?: string | null;
  readonly generatedAt?: string;
  readonly timeRange?: { from: string; to: string };
  readonly ingestion?: SkillHealthReport['meta']['ingestion'];
  readonly timestampCoverage?: number;
  readonly excludedUntimestampedSegmentCount?: number;
}

export function reportOf(bySkill: Record<string, SkillHealth>, o: ReportOptions = {}): SkillHealthReport {
  const segments = o.segments ?? Object.values(bySkill).reduce((sum, skill) => sum + skill.segmentCount, 0);
  const gapRate = o.gapRate ?? 0;
  return {
    kind: 'observe-health',
    meta: {
      tracePath: o.tracePath ?? '/tmp/trace.jsonl',
      kbPath: o.kbPath ?? '/tmp/kb',
      sessionCount: o.sessions ?? 1,
      segmentCount: segments,
      messageCount: 0,
      toolCallCount: Object.values(bySkill).reduce((sum, skill) => sum + skill.toolCallCount, 0),
      toolFailureRate: 0,
      timeRange: o.timeRange ?? { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' },
      generatedAt: o.generatedAt ?? '2026-09-02T08:30:00Z',
      ...(o.ingestion ? { ingestion: o.ingestion } : {}),
      ...(o.timestampCoverage === undefined ? {} : { timestampCoverage: o.timestampCoverage }),
      ...(o.excludedUntimestampedSegmentCount === undefined ? {} : { excludedUntimestampedSegmentCount: o.excludedUntimestampedSegmentCount }),
    },
    bySkill,
    overall: {
      gapRate,
      weightedGapRate: o.weightedGapRate ?? gapRate,
      healthBand: o.band ?? (gapRate >= 0.3 ? 'red' : gapRate >= 0.1 ? 'yellow' : 'green'),
      confidence: o.confidence ?? (segments < 5 ? 'underpowered' : segments < 20 ? 'low' : 'high'),
    },
  };
}

export function trendPointOf(over: Partial<SkillTrendPoint> & { analysisId: string }): SkillTrendPoint {
  return {
    generatedAt: '2026-09-02T08:30:00Z',
    gapRate: 0,
    weightedGapRate: 0,
    failureRate: 0,
    toolCallCount: 0,
    toolResolvedCount: 0,
    toolComparableCount: 0,
    toolCancelledCount: 0,
    toolOutcomeCoverage: null,
    coverageRate: null,
    billableTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    avgTokensPerSegment: 0,
    tokenCoverage: 1,
    durationMs: 0,
    segmentCount: 1,
    stability: 'stable',
    ...over,
  };
}
