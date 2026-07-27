import type {
  AnalysisResult,
  ResultEntry,
  SampleSnapshot,
  VarianceComparisonMetric,
  VarianceData,
  VarianceMetric,
} from '../types/index.js';
import { isJsonValue } from '../shared/json-value.js';
import { sampleContractValidationError } from '../shared/sample-contract.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRate(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isScore(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 5;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

function isSampleSnapshot(value: unknown, expectedId: string): value is SampleSnapshot {
  return sampleContractValidationError(value, expectedId) === undefined;
}

export function isSampleSnapshotRecord(
  value: unknown,
  sampleIds: string[],
): value is Record<string, SampleSnapshot> {
  return isRecord(value)
    && hasExactKeys(value, sampleIds)
    && sampleIds.every((sampleId) => isSampleSnapshot(value[sampleId], sampleId));
}

function isCountRecord(value: unknown): value is Record<string, number> {
  return isRecord(value)
    && Object.keys(value).every((key) => key.length > 0)
    && Object.values(value).every(isNonNegativeInteger);
}

function safeCountSum(value: Record<string, number>): number | undefined {
  let total = 0;
  for (const count of Object.values(value)) {
    total += count;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function isCoverage(value: unknown): boolean {
  if (
    !isRecord(value)
    || !Array.isArray(value.entries)
    || !value.entries.every((entry) =>
      isRecord(entry)
      && typeof entry.path === 'string'
      && entry.path.length > 0
      && (
        entry.type === 'principle'
        || entry.type === 'semantic'
        || entry.type === 'design'
        || entry.type === 'script'
        || entry.type === 'code'
        || entry.type === 'other'
      )
      && typeof entry.accessed === 'boolean'
      && isNonNegativeInteger(entry.accessCount)
      && entry.accessed === (entry.accessCount > 0)
      && (entry.lineCount === undefined || isNonNegativeInteger(entry.lineCount))
    )
    || !isNonNegativeInteger(value.filesCovered)
    || !isNonNegativeInteger(value.filesTotal)
    || !isRate(value.fileCoverageRate)
    || !isStringArray(value.uncoveredFiles)
    || !isNonNegativeInteger(value.grepPatternsUsed)
    || !isRate(value.overallRate)
  ) return false;
  const entries = value.entries as Array<{
    path: string;
    accessed: boolean;
  }>;
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) return false;

  const filesCovered = entries.filter((entry) => entry.accessed).length;
  const uncoveredFiles = entries
    .filter((entry) => !entry.accessed)
    .map((entry) => entry.path);
  if (
    value.filesTotal !== entries.length
    || value.filesCovered !== filesCovered
    || value.uncoveredFiles.length !== uncoveredFiles.length
    || value.uncoveredFiles.some(
      (path, index) => path !== uncoveredFiles[index],
    )
  ) return false;

  const fileCoverageRate = value.filesTotal > 0
    ? Number((filesCovered / value.filesTotal).toFixed(2))
    : 0;
  const grepBonus = value.grepPatternsUsed > 0
    ? Math.min(1, value.grepPatternsUsed / Math.max(5, value.filesTotal))
    : 0;
  const overallRate = Number(
    (fileCoverageRate * 0.6 + grepBonus * 0.4).toFixed(2),
  );
  return value.fileCoverageRate === fileCoverageRate
    && value.overallRate === overallRate;
}

function isGapSignal(value: unknown): boolean {
  return isRecord(value)
    && typeof value.sampleId === 'string'
    && value.sampleId.length > 0
    && (
      value.type === 'failed_search'
      || value.type === 'explicit_marker'
      || value.type === 'hedging'
      || value.type === 'repeated_failure'
    )
    && (value.turn === undefined || isNonNegativeInteger(value.turn))
    && typeof value.context === 'string'
    && (value.evidence === undefined || (isRecord(value.evidence) && isJsonValue(value.evidence)))
    && isRate(value.weight)
    && (
      value.classifierVerdict === undefined
      || (
        isRecord(value.classifierVerdict)
        && typeof value.classifierVerdict.isUncertainty === 'boolean'
        && isRate(value.classifierVerdict.confidence)
        && typeof value.classifierVerdict.reason === 'string'
      )
    );
}

function isGapReport(
  value: unknown,
  variant: string,
  successfulSampleIds: Set<string>,
): boolean {
  const sampleCount = successfulSampleIds.size;
  if (
    !isRecord(value)
    || value.variant !== variant
    || value.sampleCount !== sampleCount
    || !isNonNegativeInteger(value.samplesWithGap)
    || value.samplesWithGap > sampleCount
    || !isRate(value.gapRate)
    || !isRate(value.weightedGapRate)
    || value.weightedGapRate > value.gapRate
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
    || !Array.isArray(value.signals)
    || !value.signals.every(isGapSignal)
    || value.signals.some(
      (signal) =>
        isRecord(signal)
        && typeof signal.sampleId === 'string'
        && !successfulSampleIds.has(signal.sampleId),
    )
    || !isRecord(value.byType)
    || !hasExactKeys(value.byType, [
      'failed_search',
      'explicit_marker',
      'hedging',
      'repeated_failure',
    ])
    || !Object.values(value.byType).every(isNonNegativeInteger)
  ) return false;
  const sampleWeights = new Map<string, number>();
  for (const signal of value.signals as Array<{ sampleId: string; weight: number }>) {
    sampleWeights.set(
      signal.sampleId,
      Math.max(sampleWeights.get(signal.sampleId) ?? 0, signal.weight),
    );
  }
  if (value.samplesWithGap !== sampleWeights.size) return false;
  const expectedRate = sampleCount > 0
    ? Number((value.samplesWithGap / sampleCount).toFixed(4))
    : 0;
  if (Math.abs(value.gapRate - expectedRate) > 1e-9) return false;
  const expectedWeightedRate = sampleCount > 0
    ? Number((
        [...sampleWeights.values()].reduce((sum, weight) => sum + weight, 0)
        / sampleCount
      ).toFixed(4))
    : 0;
  if (Math.abs(value.weightedGapRate - expectedWeightedRate) > 1e-9) return false;
  const observedByType = {
    failed_search: 0,
    explicit_marker: 0,
    hedging: 0,
    repeated_failure: 0,
  };
  for (const signal of value.signals as Array<{ type: keyof typeof observedByType }>) {
    observedByType[signal.type]++;
  }
  return Object.entries(observedByType).every(
    ([type, count]) => (value.byType as Record<string, unknown>)[type] === count,
  );
}

function isSampleQuality(value: unknown, sampleCount: number): boolean {
  if (
    !isRecord(value)
    || !isCountRecord(value.capabilityCoverage)
    || !isRecord(value.difficultyDistribution)
    || !hasExactKeys(value.difficultyDistribution, ['easy', 'medium', 'hard', 'unspecified'])
    || !Object.values(value.difficultyDistribution).every(isNonNegativeInteger)
    || !isCountRecord(value.constructDistribution)
    || !isCountRecord(value.provenanceBreakdown)
    || !isNonNegativeInteger(value.avgRubricLength)
    || !isNonNegativeInteger(value.sampleCountWithCapability)
    || !isNonNegativeInteger(value.sampleCountWithDifficulty)
    || !isNonNegativeInteger(value.sampleCountWithConstruct)
    || !isNonNegativeInteger(value.sampleCountWithProvenance)
    || value.sampleCountWithCapability > sampleCount
    || value.sampleCountWithDifficulty > sampleCount
    || value.sampleCountWithConstruct > sampleCount
    || value.sampleCountWithProvenance > sampleCount
    || safeCountSum(value.difficultyDistribution as Record<string, number>) !== sampleCount
    || safeCountSum(value.constructDistribution) !== sampleCount
    || safeCountSum(value.provenanceBreakdown) !== sampleCount
  ) return false;
  const capabilityCoverage = value.capabilityCoverage as Record<string, number>;
  const sampleCountWithCapability = value.sampleCountWithCapability as number;
  const capabilityCounts = Object.values(capabilityCoverage);
  const capabilityTagCount = safeCountSum(capabilityCoverage);
  if (
    capabilityCounts.some(
      (count) => count <= 0 || count > sampleCountWithCapability,
    )
    || (
      sampleCountWithCapability === 0
        ? capabilityTagCount !== 0
        : capabilityTagCount === undefined
          || capabilityTagCount < sampleCountWithCapability
    )
  ) return false;

  const difficulty = value.difficultyDistribution as Record<string, number>;
  const construct = value.constructDistribution as Record<string, number>;
  const provenance = value.provenanceBreakdown as Record<string, number>;
  const allowedProvenance = new Set([
    'human',
    'llm-generated',
    'production-trace',
    'unspecified',
  ]);
  if (
    value.sampleCountWithDifficulty
      !== difficulty.easy + difficulty.medium + difficulty.hard
    || value.sampleCountWithConstruct
      !== sampleCount - (construct.unspecified ?? 0)
    || value.sampleCountWithProvenance
      !== sampleCount - (provenance.unspecified ?? 0)
    || Object.keys(provenance).some((key) => !allowedProvenance.has(key))
  ) return false;

  if (value.representativeness === undefined) return true;
  const rep = value.representativeness;
  if (
    !isRecord(rep)
    || !isNonNegativeInteger(rep.capabilityCount)
    || rep.capabilityCount !== Object.keys(capabilityCoverage).length
  ) return false;
  if (
    !isRate(rep.capabilityConcentration)
    || (rep.dominantCapability !== undefined && typeof rep.dominantCapability !== 'string')
    || !isRate(rep.difficultyConcentration)
    || !(
      rep.dominantDifficulty === undefined
      || rep.dominantDifficulty === 'easy'
      || rep.dominantDifficulty === 'medium'
      || rep.dominantDifficulty === 'hard'
    )
    || !isRate(rep.constructConcentration)
    || (rep.dominantConstruct !== undefined && typeof rep.dominantConstruct !== 'string')
  ) return false;

  const [dominantCapability, capabilityConcentration] = dominantShare(
    capabilityCoverage,
  );
  const [dominantDifficulty, difficultyConcentration] = dominantShare({
    easy: difficulty.easy,
    medium: difficulty.medium,
    hard: difficulty.hard,
  });
  const declaredConstruct = Object.fromEntries(
    Object.entries(construct).filter(([key]) => key !== 'unspecified'),
  );
  const [dominantConstruct, constructConcentration] = dominantShare(
    declaredConstruct,
  );
  return rep.dominantCapability === dominantCapability
    && closeTo(rep.capabilityConcentration, capabilityConcentration, 1e-12)
    && rep.dominantDifficulty === dominantDifficulty
    && closeTo(rep.difficultyConcentration, difficultyConcentration, 1e-12)
    && rep.dominantConstruct === dominantConstruct
    && closeTo(rep.constructConcentration, constructConcentration, 1e-12);
}

function dominantShare(
  counts: Record<string, number>,
): [string | undefined, number] {
  let label: string | undefined;
  let max = 0;
  let total = 0;
  for (const [key, count] of Object.entries(counts)) {
    total += count;
    if (!Number.isSafeInteger(total)) return [undefined, Number.NaN];
    if (count > max) {
      max = count;
      label = key;
    }
  }
  return total > 0 ? [label, max / total] : [undefined, 0];
}

function isHoldout(value: unknown, variants: string[], sampleCount: number): boolean {
  if (
    !isRecord(value)
    || !isRate(value.ratio)
    || value.ratio <= 0
    || value.ratio >= 1
    || (value.disabled !== undefined && typeof value.disabled !== 'boolean')
    || !isRecord(value.perVariant)
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
  ) return false;
  if (value.disabled === true) return Object.keys(value.perVariant).length === 0;
  if (!hasExactKeys(value.perVariant, variants)) return false;
  return Object.values(value.perVariant).every((entry) =>
    isRecord(entry)
    && isScore(entry.trainScore)
    && isScore(entry.holdoutScore)
    && isNonNegativeInteger(entry.trainCount)
    && isNonNegativeInteger(entry.holdoutCount)
    && entry.trainCount + entry.holdoutCount === sampleCount
    && isNonNegativeInteger(entry.trainScorable)
    && isNonNegativeInteger(entry.holdoutScorable)
    && entry.trainScorable <= entry.trainCount
    && entry.holdoutScorable <= entry.holdoutCount
  );
}

export function isAnalysisResult(
  value: unknown,
  variants: string[],
  results: ResultEntry[],
): value is AnalysisResult {
  const sampleCount = results.length;
  if (
    !isRecord(value)
    || (value.summary !== undefined && typeof value.summary !== 'string')
    || !Array.isArray(value.insights)
    || !value.insights.every((insight) =>
      isRecord(insight)
      && typeof insight.type === 'string'
      && insight.type.length > 0
      && (
        insight.severity === 'error'
        || insight.severity === 'warning'
        || insight.severity === 'info'
      )
      && isJsonValue(insight.details)
    )
    || (
      value.suggestions !== undefined
      && (
        !Array.isArray(value.suggestions)
        || !value.suggestions.every((suggestion) => typeof suggestion === 'string')
      )
    )
    || (
      value.coverage !== undefined
      && (
        !isRecord(value.coverage)
        || !hasOnlyKeys(value.coverage, variants)
        || !Object.values(value.coverage).every(isCoverage)
      )
    )
    || (
      value.gapReports !== undefined
      && (
        !isRecord(value.gapReports)
        || !hasOnlyKeys(value.gapReports, variants)
        || !Object.entries(value.gapReports).every(
          ([variant, report]) => isGapReport(
            report,
            variant,
            new Set(
              results
                .filter((entry) => entry.variants[variant]?.ok === true)
                .map((entry) => entry.sample_id),
            ),
          ),
        )
      )
    )
    || (
      value.sampleQuality !== undefined
      && !isSampleQuality(value.sampleQuality, sampleCount)
    )
    || (
      value.holdout !== undefined
      && !isHoldout(value.holdout, variants, sampleCount)
    )
  ) return false;
  return true;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0)
    / (values.length - 1);
  return Math.sqrt(variance);
}

function closeTo(left: number, right: number, tolerance = 1e-4): boolean {
  return Math.abs(left - right) <= tolerance;
}

function isVarianceMetric(
  value: unknown,
  runs: number,
  scoreDomain: boolean,
): value is VarianceMetric {
  if (
    !isRecord(value)
    || !Array.isArray(value.scores)
    || value.scores.length === 0
    || value.scores.length > runs
    || !value.scores.every(scoreDomain ? isScore : isNonNegativeNumber)
    || !isFiniteNumber(value.mean)
    || !isFiniteNumber(value.lower)
    || !isFiniteNumber(value.upper)
    || value.lower > value.mean
    || value.mean > value.upper
    || !isNonNegativeNumber(value.stddev)
  ) return false;
  return closeTo(value.mean, Number(mean(value.scores).toFixed(4)))
    && closeTo(value.stddev, Number(sampleStddev(value.scores).toFixed(4)));
}

function isEffectSize(
  value: unknown,
  leftCount: number,
  rightCount: number,
): boolean {
  return isRecord(value)
    && isFiniteNumber(value.cohensD)
    && isFiniteNumber(value.hedgesG)
    && (
      value.primary === 'd'
      || value.primary === 'g'
      || value.primary === 'none'
    )
    && (
      value.magnitude === 'negligible'
      || value.magnitude === 'small'
      || value.magnitude === 'medium'
      || value.magnitude === 'large'
      || value.magnitude === 'none'
    )
    && isNonNegativeNumber(value.pooledStddev)
    && value.n1 === leftCount
    && value.n2 === rightCount;
}

function isVarianceComparisonMetric(
  value: unknown,
  left: VarianceMetric,
  right: VarianceMetric,
): value is VarianceComparisonMetric {
  return isRecord(value)
    && isFiniteNumber(value.meanDiff)
    && closeTo(value.meanDiff, Number((left.mean - right.mean).toFixed(4)))
    && isFiniteNumber(value.tStatistic)
    && isNonNegativeInteger(value.df)
    && typeof value.significant === 'boolean'
    && isEffectSize(value.effectSize, left.scores.length, right.scores.length);
}

function metricMapIsValid(
  value: unknown,
  keys: string[],
  runs: number,
  scoreDomain: boolean,
): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, keys)
    && Object.values(value).every((metric) =>
      isVarianceMetric(metric, runs, scoreDomain)
    );
}

function comparisonMetricMapIsValid(
  value: unknown,
  keys: string[],
  left: Record<string, VarianceMetric> | undefined,
  right: Record<string, VarianceMetric> | undefined,
): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) return false;
  return Object.entries(value).every(([key, metric]) => {
    const leftMetric = left?.[key];
    const rightMetric = right?.[key];
    return leftMetric !== undefined
      && rightMetric !== undefined
      && isVarianceComparisonMetric(metric, leftMetric, rightMetric);
  });
}

function isSaturation(value: unknown, variants: string[], runs: number): boolean {
  if (
    !isRecord(value)
    || !Array.isArray(value.checkpointSampleCounts)
    || value.checkpointSampleCounts.length !== runs
    || !value.checkpointSampleCounts.every(isNonNegativeInteger)
    || value.checkpointSampleCounts.some(
      (count, index, all) => index > 0 && count < all[index - 1],
    )
    || !isRecord(value.perVariant)
    || !hasExactKeys(value.perVariant, variants)
  ) return false;
  const checkpointSampleCounts = value.checkpointSampleCounts as number[];
  for (const traces of Object.values(value.perVariant)) {
    if (
      !Array.isArray(traces)
      || traces.length !== runs
      || traces.some(
        (trace, index, all) =>
          isRecord(trace)
          && index > 0
          && isRecord(all[index - 1])
          && isNonNegativeInteger(trace.n)
          && isNonNegativeInteger(all[index - 1].n)
          && trace.n < all[index - 1].n,
      )
      || !traces.every((trace) =>
        isRecord(trace)
        && isNonNegativeInteger(trace.n)
        && isScore(trace.mean)
        && isScore(trace.ciLow)
        && isScore(trace.ciHigh)
        && trace.ciLow <= trace.mean
        && trace.mean <= trace.ciHigh
      )
    ) return false;
  }
  if (value.verdicts === undefined) return true;
  if (
    runs < 5
    || !isRecord(value.verdicts)
    || !hasOnlyKeys(value.verdicts, variants)
  ) return false;
  return Object.values(value.verdicts).every((verdict) =>
    isRecord(verdict)
    && typeof verdict.saturated === 'boolean'
    && (
      verdict.atN === null
      || (
        Number.isSafeInteger(verdict.atN)
        && (verdict.atN as number) > 0
        && (verdict.atN as number) <= (checkpointSampleCounts.at(-1) ?? 0)
      )
    )
    && (
      verdict.confidence === 'high'
      || verdict.confidence === 'medium'
      || verdict.confidence === 'low'
    )
    && (
      verdict.method === 'slope'
      || verdict.method === 'bootstrap-ci-width'
      || verdict.method === 'plateau-height'
    )
    && isNonNegativeNumber(verdict.threshold)
    && typeof verdict.reason === 'string'
  );
}

export function isVarianceData(
  value: unknown,
  variants: string[],
): value is VarianceData {
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value.runs)
    || (value.runs as number) < 2
    || !isRecord(value.perVariant)
    || !hasOnlyKeys(value.perVariant, variants)
  ) return false;
  const runs = value.runs as number;
  for (const variant of Object.values(value.perVariant)) {
    const extended = variant as Record<string, unknown>;
    if (
      !isVarianceMetric(variant, runs, true)
      || (
        extended.byMetric !== undefined
        && !metricMapIsValid(extended.byMetric, ['cost', 'efficiency'], runs, false)
      )
      || (
        extended.byLayer !== undefined
        && !metricMapIsValid(extended.byLayer, ['fact', 'behavior', 'judge'], runs, true)
      )
    ) return false;
  }
  if (!Array.isArray(value.comparisons)) return false;
  const pairs = new Set<string>();
  for (const comparison of value.comparisons) {
    if (
      !isRecord(comparison)
      || typeof comparison.a !== 'string'
      || typeof comparison.b !== 'string'
      || comparison.a === comparison.b
      || !variants.includes(comparison.a)
      || !variants.includes(comparison.b)
    ) return false;
    const pair = [comparison.a, comparison.b].sort().join('\u0000');
    if (pairs.has(pair)) return false;
    pairs.add(pair);
    const left = value.perVariant[comparison.a] as unknown as VarianceMetric & {
      byMetric?: Record<string, VarianceMetric>;
      byLayer?: Record<string, VarianceMetric>;
    };
    const right = value.perVariant[comparison.b] as unknown as typeof left;
    if (
      !left
      || !right
      || !isVarianceComparisonMetric(comparison, left, right)
      || (
        comparison.byMetric !== undefined
        && !comparisonMetricMapIsValid(
          comparison.byMetric,
          ['cost', 'efficiency'],
          left.byMetric,
          right.byMetric,
        )
      )
      || (
        comparison.byLayer !== undefined
        && !comparisonMetricMapIsValid(
          comparison.byLayer,
          ['fact', 'behavior', 'judge'],
          left.byLayer,
          right.byLayer,
        )
      )
    ) return false;
  }
  return value.saturation === undefined
    || isSaturation(value.saturation, variants, runs);
}
