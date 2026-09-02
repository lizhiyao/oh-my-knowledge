import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  checkedSumTokenCounts,
  nonNegativeMetric,
  optionalTokenCount,
  splitInclusiveInputTokens,
  sumTokenCounts,
  tokenCount,
} from '../../../src/executors/core/token-usage.js';

describe('source-neutral token usage normalization', () => {
  it('keeps inclusive input buckets mutually exclusive', () => {
    assert.deepEqual(splitInclusiveInputTokens(120, 40, 2), {
      inputTokens: 78,
      cacheReadTokens: 40,
      cacheCreationTokens: 2,
    });
  });

  it('bounds malformed cache counters by the authoritative input total', () => {
    assert.deepEqual(splitInclusiveInputTokens(10, 20, 5), {
      inputTokens: 0,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
    });
    assert.deepEqual(splitInclusiveInputTokens(-10, 2, 3), {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('normalizes counters and continuous metrics independently', () => {
    assert.equal(tokenCount(3.9), 0);
    assert.equal(tokenCount(-1), 0);
    assert.equal(tokenCount(Number.MAX_VALUE), 0);
    assert.equal(optionalTokenCount(3.9), undefined);
    assert.equal(optionalTokenCount(-1), undefined);
    assert.equal(optionalTokenCount(Number.MAX_VALUE), undefined);
    assert.equal(nonNegativeMetric(3.9), 3.9);
    assert.equal(nonNegativeMetric(Number.NaN), undefined);
  });

  it('does not expose an unsafe aggregate token count', () => {
    assert.equal(sumTokenCounts(10, 20, 30), 60);
    assert.equal(sumTokenCounts(Number.MAX_SAFE_INTEGER, 1), 0);
  });

  it('preserves invalid or overflowing checked aggregates as undefined', () => {
    assert.equal(checkedSumTokenCounts(1, 2, 3), 6);
    assert.equal(checkedSumTokenCounts(1, -1), undefined);
    assert.equal(checkedSumTokenCounts(Number.MAX_SAFE_INTEGER, 1), undefined);
  });
});
