export interface ExclusiveInputTokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Provider counters are untrusted protocol input. Token metrics are integer counts. */
export function tokenCount(value: unknown): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : 0;
}

export function optionalTokenCount(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

/** Sum untrusted provider counters without exposing an unsafe integer. */
export function sumTokenCounts(...values: unknown[]): number {
  return checkedSumTokenCounts(...values) ?? 0;
}

/** Validate and sum provider counters while preserving invalid/overflow as unknown. */
export function checkedSumTokenCounts(...values: unknown[]): number | undefined {
  let total = 0;
  for (const value of values) {
    const count = optionalTokenCount(value);
    if (count === undefined || total > Number.MAX_SAFE_INTEGER - count) return undefined;
    total += count;
  }
  return total;
}

export function nonNegativeMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Split providers whose input total includes cache reads/writes into mutually
 * exclusive buckets. Invalid cache counters are bounded by the authoritative
 * input total so one malformed response cannot inflate cross-runtime totals.
 */
export function splitInclusiveInputTokens(
  rawInput: unknown,
  rawCacheRead: unknown,
  rawCacheCreation: unknown = 0,
): ExclusiveInputTokenUsage {
  const totalInput = tokenCount(rawInput);
  const cacheReadTokens = Math.min(tokenCount(rawCacheRead), totalInput);
  const cacheCreationTokens = Math.min(
    tokenCount(rawCacheCreation),
    totalInput - cacheReadTokens,
  );
  return {
    inputTokens: totalInput - cacheReadTokens - cacheCreationTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}
