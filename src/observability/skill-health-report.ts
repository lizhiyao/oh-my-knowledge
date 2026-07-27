import type { CoverageReport } from '../analysis/coverage-analyzer.js';
import type { GapReport, GapSignalRef } from '../types/index.js';
import { SIGNAL_WEIGHTS } from '../analysis/gap-analyzer.js';
import type { SkillHealth, SkillHealthReport } from './skill-health-analyzer.js';
import { confidenceOf, healthBandOf, toolStabilityOf } from './skill-health-analyzer.js';
import { parseTraceIngestionSummary } from './trace-ingestion.js';
import { sumRecordCounts } from '../shared/record-count.js';
import { normalizeRfc3339Timestamp } from '../shared/timestamp.js';

const TOOL_STABILITIES = new Set<SkillHealth['stability']>([
  'stable',
  'unstable',
  'very-unstable',
  'unknown',
]);
const HEALTH_BANDS = new Set<SkillHealthReport['overall']['healthBand']>([
  'green',
  'yellow',
  'red',
]);
const CONFIDENCE_LEVELS = new Set<SkillHealth['confidence']>([
  'high',
  'low',
  'underpowered',
]);
const GAP_TYPES = new Set<GapSignalRef['type']>([
  'failed_search',
  'explicit_marker',
  'hedging',
  'repeated_failure',
]);
const COVERAGE_ENTRY_TYPES = new Set<CoverageReport['entries'][number]['type']>([
  'principle',
  'semantic',
  'design',
  'script',
  'code',
  'other',
]);

/**
 * Parse persisted observe-health data at the storage boundary.
 *
 * Legacy reports may omit additive fields such as usage, confidence and
 * tool-outcome coverage. Those fields are reconstructed from authoritative
 * counts. Contradictory counts/rates are rejected; derived labels are
 * recomputed because their threshold formula can evolve between releases.
 */
export function parseSkillHealthReport(value: unknown): SkillHealthReport | null {
  if (!isRecord(value)) return null;
  if (value.kind !== undefined && value.kind !== 'observe-health') return null;

  const meta = normalizeMeta(value.meta);
  const overall = normalizeOverall(value.overall, meta?.segmentCount);
  if (!meta || !overall || !isRecord(value.bySkill)) return null;

  const skillEntries: Array<[string, SkillHealth]> = [];
  for (const [key, rawHealth] of Object.entries(value.bySkill)) {
    const health = normalizeSkillHealth(rawHealth, key);
    if (!health) return null;
    skillEntries.push([key, health]);
  }
  const bySkill = Object.fromEntries(skillEntries);
  if (!reportAggregatesAreConsistent(meta, overall, bySkill)) return null;

  return {
    ...(value.kind === 'observe-health' ? { kind: value.kind } : {}),
    meta,
    overall,
    bySkill,
  };
}

function normalizeMeta(value: unknown): SkillHealthReport['meta'] | null {
  if (!isRecord(value)) return null;
  const generatedAt = timestamp(value.generatedAt);
  const sessionCount = nonNegativeInteger(value.sessionCount);
  const segmentCount = nonNegativeInteger(value.segmentCount);
  const messageCount = nonNegativeInteger(value.messageCount);
  const toolCallCount = nonNegativeInteger(value.toolCallCount);
  const toolFailureRate = rate(value.toolFailureRate);
  const rawTimeRange = isRecord(value.timeRange) ? value.timeRange : null;
  const timeRange = rawTimeRange
    ? {
        from: rawTimeRange.from === '' ? '' : timestamp(rawTimeRange.from),
        to: rawTimeRange.to === '' ? '' : timestamp(rawTimeRange.to),
      }
    : null;
  if (
    !generatedAt
    || timeRange?.from === undefined
    || timeRange.to === undefined
    || (timeRange.from === '') !== (timeRange.to === '')
    || (
      timeRange.from !== ''
      && timeRange.to !== ''
      && Date.parse(timeRange.from) > Date.parse(timeRange.to)
    )
    || sessionCount == null
    || segmentCount == null
    || messageCount == null
    || toolCallCount == null
    || toolFailureRate == null
    || typeof value.tracePath !== 'string'
    || !(value.kbPath === null || typeof value.kbPath === 'string')
  ) return null;
  const inferredTimestampedSegmentCount = timeRange.from === '' ? 0 : segmentCount;
  const timestampedSegmentCount = value.timestampedSegmentCount === undefined
    ? inferredTimestampedSegmentCount
    : nonNegativeInteger(value.timestampedSegmentCount);
  const excludedUntimestampedSegmentCount = value.excludedUntimestampedSegmentCount === undefined
    ? 0
    : nonNegativeInteger(value.excludedUntimestampedSegmentCount);
  if (
    timestampedSegmentCount == null
    || timestampedSegmentCount > segmentCount
    || excludedUntimestampedSegmentCount == null
    || (timeRange.from === '') !== (timestampedSegmentCount === 0)
  ) return null;
  const expectedTimestampCoverage = segmentCount > 0
    ? Number((timestampedSegmentCount / segmentCount).toFixed(4))
    : 1;
  const timestampCoverage = value.timestampCoverage === undefined
    ? expectedTimestampCoverage
    : rate(value.timestampCoverage);
  if (
    timestampCoverage == null
    || !approximatelyEqual(timestampCoverage, expectedTimestampCoverage)
  ) return null;

  const outcomes = normalizeToolOutcomeCounts(
    toolCallCount,
    value.toolResolvedCount,
    value.toolCancelledCount,
    value.toolUnknownCount,
    value.toolOutcomeCoverage,
  );
  if (!outcomes) return null;
  if (outcomes.comparable === 0 && toolFailureRate !== 0) return null;
  const ingestion = value.ingestion === undefined
    ? undefined
    : parseTraceIngestionSummary(value.ingestion);
  if (value.ingestion !== undefined && !ingestion) return null;

  return {
    tracePath: value.tracePath,
    kbPath: value.kbPath,
    sessionCount,
    segmentCount,
    messageCount,
    timestampedSegmentCount,
    timestampCoverage,
    excludedUntimestampedSegmentCount,
    toolCallCount,
    toolResolvedCount: outcomes.resolved,
    toolCancelledCount: outcomes.cancelled,
    toolUnknownCount: outcomes.unknown,
    toolOutcomeCoverage: outcomes.coverage,
    toolFailureRate,
    timeRange: { from: timeRange.from, to: timeRange.to },
    generatedAt,
    ...(ingestion ? { ingestion } : {}),
  };
}

function normalizeOverall(
  value: unknown,
  segmentCount: number | undefined,
): SkillHealthReport['overall'] | null {
  if (!isRecord(value) || segmentCount == null) return null;
  const gapRate = rate(value.gapRate);
  const weightedGapRate = rate(value.weightedGapRate);
  const healthBand = stringEnum(value.healthBand, HEALTH_BANDS);
  const suppliedConfidence = value.confidence === undefined
    ? undefined
    : stringEnum(value.confidence, CONFIDENCE_LEVELS);
  if (
    gapRate == null
    || weightedGapRate == null
    || weightedGapRate > gapRate
    || !healthBand
    || (value.confidence !== undefined && !suppliedConfidence)
  ) {
    return null;
  }
  return {
    gapRate,
    weightedGapRate,
    healthBand: healthBandOf(weightedGapRate),
    confidence: confidenceOf(segmentCount),
  };
}

function normalizeSkillHealth(value: unknown, key: string): SkillHealth | null {
  if (!isRecord(value) || typeof value.skillName !== 'string' || value.skillName !== key) return null;
  const segmentCount = nonNegativeInteger(value.segmentCount);
  const toolCallCount = nonNegativeInteger(value.toolCallCount);
  const toolFailureCount = nonNegativeInteger(value.toolFailureCount);
  const toolFailureRate = rate(value.toolFailureRate);
  if (
    segmentCount == null
    || toolCallCount == null
    || toolFailureCount == null
    || toolFailureRate == null
  ) return null;

  const outcomes = normalizeToolOutcomeCounts(
    toolCallCount,
    value.toolResolvedCount,
    value.toolCancelledCount,
    value.toolUnknownCount,
    value.toolOutcomeCoverage,
  );
  if (!outcomes || toolFailureCount > outcomes.comparable) return null;
  const expectedFailureRate = outcomes.comparable > 0
    ? Number((toolFailureCount / outcomes.comparable).toFixed(4))
    : 0;
  if (!approximatelyEqual(toolFailureRate, expectedFailureRate)) return null;

  const gap = normalizeGap(value.gap, key, segmentCount);
  const coverage = value.coverage === null || value.coverage === undefined
    ? null
    : normalizeCoverage(value.coverage);
  const usage = value.usage === undefined ? emptyUsage() : normalizeUsage(value.usage, segmentCount);
  const suppliedConfidence = value.confidence === undefined
    ? undefined
    : stringEnum(value.confidence, CONFIDENCE_LEVELS);
  const suppliedStability = value.stability === undefined
    ? undefined
    : stringEnum(value.stability, TOOL_STABILITIES);
  if (
    !gap
    || coverage === undefined
    || !usage
    || (value.confidence !== undefined && !suppliedConfidence)
    || (value.stability !== undefined && !suppliedStability)
  ) return null;
  const confidence = confidenceOf(segmentCount);
  const stability = toolStabilityOf(toolFailureRate, outcomes.comparable, toolCallCount);

  if (
    value.testSetPath !== undefined
    && value.testSetPath !== null
    && typeof value.testSetPath !== 'string'
  ) return null;
  if (
    value.testSetHash !== undefined
    && value.testSetHash !== null
    && typeof value.testSetHash !== 'string'
  ) return null;
  return {
    skillName: key,
    segmentCount,
    toolCallCount,
    toolFailureCount,
    toolResolvedCount: outcomes.resolved,
    toolCancelledCount: outcomes.cancelled,
    toolUnknownCount: outcomes.unknown,
    toolOutcomeCoverage: outcomes.coverage,
    toolFailureRate,
    stability,
    confidence,
    usage,
    coverage,
    gap,
  };
}

function normalizeToolOutcomeCounts(
  total: number,
  rawResolved: unknown,
  rawCancelled: unknown,
  rawUnknown: unknown,
  rawCoverage: unknown,
): {
  resolved: number;
  comparable: number;
  cancelled: number;
  unknown: number;
  coverage: number;
} | null {
  const suppliedResolved = rawResolved === undefined ? undefined : nonNegativeInteger(rawResolved);
  const suppliedCancelled = rawCancelled === undefined ? undefined : nonNegativeInteger(rawCancelled);
  const suppliedUnknown = rawUnknown === undefined ? undefined : nonNegativeInteger(rawUnknown);
  if (
    (rawResolved !== undefined && suppliedResolved == null)
    || (rawCancelled !== undefined && suppliedCancelled == null)
    || (rawUnknown !== undefined && suppliedUnknown == null)
  ) return null;

  const resolved = suppliedResolved ?? (suppliedUnknown === undefined ? total : total - suppliedUnknown);
  const cancelled = suppliedCancelled ?? 0;
  const unknown = suppliedUnknown ?? total - resolved;
  const comparable = resolved - cancelled;
  if (
    resolved < 0
    || cancelled < 0
    || unknown < 0
    || comparable < 0
    || resolved + unknown !== total
  ) return null;

  const coverage = total > 0 ? Number((resolved / total).toFixed(4)) : 1;
  if (rawCoverage !== undefined) {
    const suppliedCoverage = rate(rawCoverage);
    if (suppliedCoverage == null || !approximatelyEqual(suppliedCoverage, coverage)) return null;
  }
  return { resolved, comparable, cancelled, unknown, coverage };
}

function normalizeGap(value: unknown, skillName: string, segmentCount: number): GapReport | null {
  if (!isRecord(value)) return null;
  const gapRate = rate(value.gapRate);
  const weightedGapRate = rate(value.weightedGapRate);
  if (gapRate == null || weightedGapRate == null || weightedGapRate > gapRate) return null;

  if (!Array.isArray(value.signals)) return null;
  const signals = value.signals.map(normalizeGapSignal);
  if (signals.some((signal) => signal === null)) return null;
  const typedSignals = signals as GapSignalRef[];

  const sampleCount = value.sampleCount === undefined
    ? segmentCount
    : nonNegativeInteger(value.sampleCount);
  const signalSampleIds = new Set(typedSignals.map((signal) => signal.sampleId));
  const derivedSamplesWithGap = signalSampleIds.size;
  const samplesWithGap = value.samplesWithGap === undefined
    ? derivedSamplesWithGap
    : nonNegativeInteger(value.samplesWithGap);
  if (
    sampleCount == null
    || sampleCount !== segmentCount
    || samplesWithGap == null
    || samplesWithGap > sampleCount
    || samplesWithGap !== derivedSamplesWithGap
  ) return null;
  const expectedGapRate = sampleCount > 0
    ? Number((samplesWithGap / sampleCount).toFixed(4))
    : 0;
  const maxWeightBySample = new Map<string, number>();
  for (const signal of typedSignals) {
    maxWeightBySample.set(
      signal.sampleId,
      Math.max(maxWeightBySample.get(signal.sampleId) ?? 0, signal.weight),
    );
  }
  const expectedWeightedGapRate = sampleCount > 0
    ? Number((
        [...maxWeightBySample.values()].reduce((sum, weight) => sum + weight, 0)
        / sampleCount
      ).toFixed(4))
    : 0;
  if (
    !approximatelyEqual(gapRate, expectedGapRate)
    || !approximatelyEqual(weightedGapRate, expectedWeightedGapRate)
  ) return null;

  const byType = normalizeGapCounts(value.byType, typedSignals);
  if (!byType) return null;
  if (
    (value.variant !== undefined && value.variant !== skillName)
    || (
      value.testSetPath !== undefined
      && value.testSetPath !== null
      && typeof value.testSetPath !== 'string'
    )
    || (
      value.testSetHash !== undefined
      && value.testSetHash !== null
      && typeof value.testSetHash !== 'string'
    )
  ) return null;
  return {
    variant: skillName,
    sampleCount,
    samplesWithGap,
    gapRate,
    weightedGapRate,
    ...(value.testSetPath === null || typeof value.testSetPath === 'string'
      ? { testSetPath: value.testSetPath }
      : {}),
    ...(value.testSetHash === null || typeof value.testSetHash === 'string'
      ? { testSetHash: value.testSetHash }
      : {}),
    signals: typedSignals,
    byType,
  };
}

function normalizeGapSignal(value: unknown): GapSignalRef | null {
  if (!isRecord(value)) return null;
  const type = stringEnum(value.type, GAP_TYPES);
  const weight = rate(value.weight);
  if (
    typeof value.sampleId !== 'string'
    || !type
    || typeof value.context !== 'string'
    || weight == null
    || !approximatelyEqual(weight, SIGNAL_WEIGHTS[type])
    || (value.turn !== undefined && nonNegativeInteger(value.turn) == null)
    || (value.evidence !== undefined && !isRecord(value.evidence))
  ) return null;
  if (value.classifierVerdict !== undefined) {
    if (
      !isRecord(value.classifierVerdict)
      || typeof value.classifierVerdict.isUncertainty !== 'boolean'
      || rate(value.classifierVerdict.confidence) == null
      || typeof value.classifierVerdict.reason !== 'string'
    ) return null;
  }
  return {
    sampleId: value.sampleId,
    type,
    context: value.context,
    weight,
    ...(value.turn !== undefined ? { turn: value.turn as number } : {}),
    ...(value.evidence !== undefined
      ? { evidence: value.evidence as Record<string, unknown> }
      : {}),
    ...(value.classifierVerdict !== undefined
      ? {
          classifierVerdict: {
            isUncertainty: value.classifierVerdict.isUncertainty as boolean,
            confidence: value.classifierVerdict.confidence as number,
            reason: value.classifierVerdict.reason as string,
          },
        }
      : {}),
  };
}

function normalizeGapCounts(
  value: unknown,
  signals: GapSignalRef[],
): GapReport['byType'] | null {
  if (value === undefined) {
    return {
      failed_search: signals.filter((signal) => signal.type === 'failed_search').length,
      explicit_marker: signals.filter((signal) => signal.type === 'explicit_marker').length,
      hedging: signals.filter((signal) => signal.type === 'hedging').length,
      repeated_failure: signals.filter((signal) => signal.type === 'repeated_failure').length,
    };
  }
  if (!isRecord(value)) return null;
  const failedSearch = nonNegativeInteger(value.failed_search);
  const explicitMarker = nonNegativeInteger(value.explicit_marker);
  const hedging = nonNegativeInteger(value.hedging);
  const repeatedFailure = nonNegativeInteger(value.repeated_failure);
  if (failedSearch == null || explicitMarker == null || hedging == null || repeatedFailure == null) return null;
  const normalized = {
    failed_search: failedSearch,
    explicit_marker: explicitMarker,
    hedging,
    repeated_failure: repeatedFailure,
  };
  const expected = normalizeGapCounts(undefined, signals);
  return expected
    && Object.keys(normalized).every((key) =>
      normalized[key as keyof typeof normalized] === expected[key as keyof typeof expected]
    )
    ? normalized
    : null;
}

function normalizeCoverage(value: unknown): CoverageReport | undefined {
  if (!isRecord(value) || !Array.isArray(value.entries) || !Array.isArray(value.uncoveredFiles)) return undefined;
  const entries = value.entries.map((entry) => {
    const type = isRecord(entry) ? stringEnum(entry.type, COVERAGE_ENTRY_TYPES) : undefined;
    if (
      !isRecord(entry)
      || typeof entry.path !== 'string'
      || !type
      || typeof entry.accessed !== 'boolean'
      || nonNegativeInteger(entry.accessCount) == null
      || (entry.lineCount !== undefined && nonNegativeInteger(entry.lineCount) == null)
      || (entry.accessed && entry.accessCount === 0)
      || (!entry.accessed && entry.accessCount !== 0)
    ) return null;
    return {
      path: entry.path,
      type,
      accessed: entry.accessed,
      accessCount: entry.accessCount as number,
      ...(entry.lineCount !== undefined ? { lineCount: entry.lineCount as number } : {}),
    };
  });
  const filesCovered = nonNegativeInteger(value.filesCovered);
  const filesTotal = nonNegativeInteger(value.filesTotal);
  const fileCoverageRate = rate(value.fileCoverageRate);
  const grepPatternsUsed = nonNegativeInteger(value.grepPatternsUsed);
  const overallRate = rate(value.overallRate);
  if (
    entries.some((entry) => entry === null)
    || value.uncoveredFiles.some((path) => typeof path !== 'string')
    || filesCovered == null
    || filesTotal == null
    || filesCovered > filesTotal
    || fileCoverageRate == null
    || grepPatternsUsed == null
    || overallRate == null
  ) return undefined;
  const typedEntries = entries as CoverageReport['entries'];
  if (
    new Set(typedEntries.map((entry) => entry.path)).size !== typedEntries.length
    || new Set(value.uncoveredFiles as string[]).size !== value.uncoveredFiles.length
  ) return undefined;
  const derivedCovered = typedEntries.filter((entry) => entry.accessed).length;
  const derivedUncovered = typedEntries.filter((entry) => !entry.accessed).map((entry) => entry.path);
  const expectedFileCoverageRate = filesTotal > 0
    ? Number((filesCovered / filesTotal).toFixed(2))
    : 0;
  const grepBonus = grepPatternsUsed > 0
    ? Math.min(1, grepPatternsUsed / Math.max(5, filesTotal))
    : 0;
  const expectedOverallRate = Number((fileCoverageRate * 0.6 + grepBonus * 0.4).toFixed(2));
  if (
    filesTotal !== typedEntries.length
    || filesCovered !== derivedCovered
    || !approximatelyEqual(fileCoverageRate, expectedFileCoverageRate)
    || !sameStringSet(value.uncoveredFiles as string[], derivedUncovered)
    || !approximatelyEqual(overallRate, expectedOverallRate)
  ) return undefined;
  return {
    entries: typedEntries,
    filesCovered,
    filesTotal,
    fileCoverageRate,
    uncoveredFiles: derivedUncovered,
    grepPatternsUsed,
    overallRate,
  };
}

function normalizeUsage(value: unknown, segmentCount: number): SkillHealth['usage'] | null {
  if (!isRecord(value)) return null;
  const integerFields: Array<keyof SkillHealth['usage']> = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'totalTokens',
    'numTurns',
    'avgTokensPerSegment',
    'avgDurationMsPerSegment',
  ];
  const normalized = Object.fromEntries(
    integerFields.map((field) => [field, nonNegativeInteger(value[field])]),
  );
  const durationMs = nonNegativeNumber(value.durationMs);
  if (Object.values(normalized).some((entry) => entry == null) || durationMs == null) return null;
  const hasTokenCoverage = value.tokenObservedSegmentCount !== undefined
    || value.tokenCoverage !== undefined;
  const tokenObservedSegmentCount = hasTokenCoverage
    ? nonNegativeInteger(value.tokenObservedSegmentCount)
    : 0;
  const tokenCoverage = hasTokenCoverage
    ? rate(value.tokenCoverage)
    : 0;
  if (
    tokenObservedSegmentCount == null
    || tokenCoverage == null
    || tokenObservedSegmentCount > segmentCount
  ) return null;
  const usage = {
    ...normalized,
    durationMs,
    tokenObservedSegmentCount,
    tokenCoverage,
  } as unknown as SkillHealth['usage'];
  const expectedTotal = usage.inputTokens
    + usage.outputTokens
    + usage.cacheReadTokens
    + usage.cacheCreationTokens;
  const tokenDivisor = usage.tokenObservedSegmentCount || 1;
  const durationDivisor = segmentCount || 1;
  if (
    !Number.isSafeInteger(expectedTotal)
    || usage.totalTokens !== expectedTotal
    || (
      hasTokenCoverage
      && usage.avgTokensPerSegment !== Math.round(expectedTotal / tokenDivisor)
    )
    || usage.avgDurationMsPerSegment !== Math.round(usage.durationMs / durationDivisor)
    || (
      hasTokenCoverage
      && !approximatelyEqual(
        usage.tokenCoverage,
        segmentCount > 0 ? usage.tokenObservedSegmentCount / segmentCount : 1,
      )
    )
  ) return null;
  return usage;
}

function reportAggregatesAreConsistent(
  meta: SkillHealthReport['meta'],
  overall: SkillHealthReport['overall'],
  bySkill: Record<string, SkillHealth>,
): boolean {
  const skills = Object.values(bySkill);
  const segmentCount = safeCountSum(skills.map((health) => health.segmentCount));
  const toolCallCount = safeCountSum(skills.map((health) => health.toolCallCount));
  const toolResolvedCount = safeCountSum(
    skills.map((health) => health.toolResolvedCount ?? health.toolCallCount),
  );
  const toolCancelledCount = safeCountSum(
    skills.map((health) => health.toolCancelledCount ?? 0),
  );
  const toolUnknownCount = safeCountSum(
    skills.map((health) => health.toolUnknownCount ?? 0),
  );
  const toolFailureCount = safeCountSum(skills.map((health) => health.toolFailureCount));
  const gapSampleCount = safeCountSum(skills.map((health) => health.gap.sampleCount));
  const samplesWithGap = safeCountSum(skills.map((health) => health.gap.samplesWithGap));
  const weightedGapTotal = safeFiniteSum(
    skills.map((health) => health.gap.weightedGapRate * health.gap.sampleCount),
  );
  if (
    segmentCount === undefined
    || toolCallCount === undefined
    || toolResolvedCount === undefined
    || toolCancelledCount === undefined
    || toolUnknownCount === undefined
    || toolFailureCount === undefined
    || gapSampleCount === undefined
    || samplesWithGap === undefined
    || weightedGapTotal === undefined
  ) return false;
  const comparable = toolResolvedCount - toolCancelledCount;
  const expectedFailureRate = comparable > 0
    ? Number((toolFailureCount / comparable).toFixed(4))
    : 0;
  const expectedGapRate = segmentCount > 0
    ? Number((samplesWithGap / segmentCount).toFixed(4))
    : 0;
  const expectedWeightedGapRate = segmentCount > 0
    ? Number((weightedGapTotal / segmentCount).toFixed(4))
    : 0;
  return segmentCount === meta.segmentCount
    && gapSampleCount === meta.segmentCount
    && toolCallCount === meta.toolCallCount
    && toolResolvedCount === meta.toolResolvedCount
    && toolCancelledCount === meta.toolCancelledCount
    && toolUnknownCount === meta.toolUnknownCount
    && approximatelyEqual(meta.toolFailureRate, expectedFailureRate)
    && approximatelyEqual(overall.gapRate, expectedGapRate)
    && approximatelyEqual(overall.weightedGapRate, expectedWeightedGapRate);
}

function safeCountSum(values: number[]): number | undefined {
  try {
    return sumRecordCounts(...values);
  } catch {
    return undefined;
  }
}

function safeFiniteSum(values: number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) return undefined;
    total += value;
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) return undefined;
  }
  return total;
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((entry) => right.includes(entry))
    && right.every((entry) => left.includes(entry));
}

function emptyUsage(): SkillHealth['usage'] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    tokenObservedSegmentCount: 0,
    tokenCoverage: 0,
    durationMs: 0,
    numTurns: 0,
    avgTokensPerSegment: 0,
    avgDurationMsPerSegment: 0,
  };
}

function timestamp(value: unknown): string | undefined {
  return normalizeRfc3339Timestamp(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function rate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.0001;
}

function stringEnum<T extends string>(value: unknown, values: Set<T>): T | undefined {
  return typeof value === 'string' && values.has(value as T) ? value as T : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
