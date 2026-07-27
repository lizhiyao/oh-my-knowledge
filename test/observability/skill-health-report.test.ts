import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { computeSkillHealthFromSegments } from '../../src/observability/skill-health-analyzer.js';
import { parseSkillHealthReport } from '../../src/observability/skill-health-report.js';

function legacyReport(): Record<string, unknown> {
  return {
    meta: {
      tracePath: '/tmp/trace',
      kbPath: null,
      sessionCount: 1,
      segmentCount: 2,
      messageCount: 3,
      toolCallCount: 2,
      toolFailureRate: 0.5,
      timeRange: {
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-01T00:01:00.000Z',
      },
      generatedAt: '2026-07-01T00:02:00.000Z',
    },
    overall: {
      gapRate: 0.5,
      weightedGapRate: 0.25,
      healthBand: 'yellow',
    },
    bySkill: {
      audit: {
        skillName: 'audit',
        segmentCount: 2,
        toolCallCount: 2,
        toolFailureCount: 1,
        toolFailureRate: 0.5,
        coverage: null,
        gap: {
          gapRate: 0.5,
          weightedGapRate: 0.25,
          signals: [{
            sampleId: 'audit:1',
            type: 'explicit_marker',
            context: 'missing',
            weight: 0.5,
          }],
        },
      },
    },
  };
}

describe('parseSkillHealthReport', () => {
  it('accepts an empty report produced by the analyzer', () => {
    const report = computeSkillHealthFromSegments([], [], '/tmp/trace', {}, {
      fileCount: 1,
      sourceRecordCount: 4,
      parsedRecordCount: 2,
      malformedRecordCount: 1,
      ignoredValueCount: 1,
      unknownEventCount: 1,
      filteredSessionCount: 0,
    });
    const parsed = parseSkillHealthReport(report);

    assert.ok(parsed);
    assert.deepEqual(parsed.meta.timeRange, { from: '', to: '' });
    assert.equal(parsed.meta.toolOutcomeCoverage, 1);
    assert.equal(parsed.meta.timestampedSegmentCount, 0);
    assert.equal(parsed.meta.timestampCoverage, 1);
    assert.equal(parsed.meta.excludedUntimestampedSegmentCount, 0);
    assert.deepEqual(parsed.meta.ingestion, report.meta.ingestion);
  });

  it('rejects malformed or internally contradictory ingestion summaries', () => {
    const malformed = legacyReport();
    (malformed.meta as Record<string, unknown>).ingestion = {
      fileCount: 1,
      sourceRecordCount: 2,
      parsedRecordCount: 2,
      malformedRecordCount: 1,
      ignoredValueCount: 0,
      unknownEventCount: 0,
      filteredSessionCount: 0,
    };
    assert.equal(parseSkillHealthReport(malformed), null);

    const nonInteger = legacyReport();
    (nonInteger.meta as Record<string, unknown>).ingestion = {
      fileCount: 1,
      sourceRecordCount: 1,
      parsedRecordCount: 1,
      malformedRecordCount: 0,
      ignoredValueCount: 0,
      unknownEventCount: 0.5,
      filteredSessionCount: 0,
    };
    assert.equal(parseSkillHealthReport(nonInteger), null);
  });

  it('reconstructs additive fields for legacy reports', () => {
    const parsed = parseSkillHealthReport(legacyReport());

    assert.ok(parsed);
    assert.equal(parsed.meta.toolResolvedCount, 2);
    assert.equal(parsed.meta.toolCancelledCount, 0);
    assert.equal(parsed.meta.toolUnknownCount, 0);
    assert.equal(parsed.meta.toolOutcomeCoverage, 1);
    assert.equal(parsed.meta.timestampedSegmentCount, 2);
    assert.equal(parsed.meta.timestampCoverage, 1);
    assert.equal(parsed.meta.excludedUntimestampedSegmentCount, 0);
    assert.equal(parsed.overall.confidence, 'underpowered');
    assert.equal(parsed.bySkill.audit.confidence, 'underpowered');
    assert.equal(parsed.bySkill.audit.stability, 'unstable');
    assert.equal(parsed.bySkill.audit.usage.totalTokens, 0);
    assert.equal(parsed.bySkill.audit.gap.sampleCount, 2);
    assert.deepEqual(parsed.bySkill.audit.gap.byType, {
      failed_search: 0,
      explicit_marker: 1,
      hedging: 0,
      repeated_failure: 0,
    });
  });

  it('returns only normalized fields from the persistence boundary', () => {
    const report = legacyReport();
    report.untrustedTopLevel = { retained: false };
    const signal = (
      (
        (report.bySkill as Record<string, Record<string, unknown>>).audit.gap
      ) as Record<string, unknown>
    ).signals as Array<Record<string, unknown>>;
    signal[0].untrustedSignalField = true;

    const parsed = parseSkillHealthReport(report);
    assert.ok(parsed);
    assert.equal(Object.hasOwn(parsed, 'untrustedTopLevel'), false);
    assert.equal(Object.hasOwn(parsed.bySkill.audit.gap.signals[0], 'untrustedSignalField'), false);
  });

  it('rejects contradictory tool outcome counts and rates', () => {
    const contradictoryCounts = legacyReport();
    const meta = contradictoryCounts.meta as Record<string, unknown>;
    meta.toolResolvedCount = 2;
    meta.toolUnknownCount = 1;
    assert.equal(parseSkillHealthReport(contradictoryCounts), null);

    const contradictoryRate = legacyReport();
    const bySkill = contradictoryRate.bySkill as Record<string, Record<string, unknown>>;
    bySkill.audit.toolFailureRate = 0;
    assert.equal(parseSkillHealthReport(contradictoryRate), null);

    const contradictoryCancellation = legacyReport();
    const cancelledSkill = (
      contradictoryCancellation.bySkill as Record<string, Record<string, unknown>>
    ).audit;
    cancelledSkill.toolResolvedCount = 2;
    cancelledSkill.toolCancelledCount = 3;
    assert.equal(parseSkillHealthReport(contradictoryCancellation), null);
  });

  it('keeps cancellation resolved but outside the comparable denominator', () => {
    const report = legacyReport();
    const meta = report.meta as Record<string, unknown>;
    meta.toolResolvedCount = 2;
    meta.toolCancelledCount = 1;
    meta.toolUnknownCount = 0;
    meta.toolOutcomeCoverage = 1;
    meta.toolFailureRate = 1;
    const skill = (report.bySkill as Record<string, Record<string, unknown>>).audit;
    skill.toolResolvedCount = 2;
    skill.toolCancelledCount = 1;
    skill.toolUnknownCount = 0;
    skill.toolOutcomeCoverage = 1;
    skill.toolFailureRate = 1;

    const parsed = parseSkillHealthReport(report);
    assert.ok(parsed);
    assert.equal(parsed.meta.toolResolvedCount, 2);
    assert.equal(parsed.meta.toolCancelledCount, 1);
    assert.equal(parsed.meta.toolOutcomeCoverage, 1);
    assert.equal(parsed.bySkill.audit.toolFailureRate, 1);
    assert.equal(parsed.bySkill.audit.stability, 'unstable');
  });

  it('rejects invalid timestamps and skill-key mismatches', () => {
    const invalidTimestamp = legacyReport();
    const meta = invalidTimestamp.meta as Record<string, unknown>;
    meta.generatedAt = 'not-a-date';
    assert.equal(parseSkillHealthReport(invalidTimestamp), null);

    const timezoneLess = legacyReport();
    (timezoneLess.meta as Record<string, unknown>).generatedAt = '2026-07-01T00:02:00';
    assert.equal(parseSkillHealthReport(timezoneLess), null);

    const invalidCalendarDate = legacyReport();
    (invalidCalendarDate.meta as Record<string, unknown>).generatedAt = '2026-02-30T00:02:00Z';
    assert.equal(parseSkillHealthReport(invalidCalendarDate), null);

    const mismatchedSkill = legacyReport();
    const bySkill = mismatchedSkill.bySkill as Record<string, Record<string, unknown>>;
    bySkill.audit.skillName = 'other';
    assert.equal(parseSkillHealthReport(mismatchedSkill), null);
  });

  it('accepts explicit partial timestamp coverage and rejects contradictory timestamp metadata', () => {
    const partial = legacyReport();
    const partialMeta = partial.meta as Record<string, unknown>;
    partialMeta.timestampedSegmentCount = 1;
    partialMeta.timestampCoverage = 0.5;
    partialMeta.excludedUntimestampedSegmentCount = 2;
    const parsed = parseSkillHealthReport(partial);
    assert.ok(parsed);
    assert.equal(parsed.meta.timestampedSegmentCount, 1);
    assert.equal(parsed.meta.timestampCoverage, 0.5);
    assert.equal(parsed.meta.excludedUntimestampedSegmentCount, 2);

    const wrongCoverage = legacyReport();
    const wrongCoverageMeta = wrongCoverage.meta as Record<string, unknown>;
    wrongCoverageMeta.timestampedSegmentCount = 1;
    wrongCoverageMeta.timestampCoverage = 1;
    assert.equal(parseSkillHealthReport(wrongCoverage), null);

    const emptyRangeWithObservedSegments = legacyReport();
    const emptyRangeMeta = emptyRangeWithObservedSegments.meta as Record<string, unknown>;
    emptyRangeMeta.timeRange = { from: '', to: '' };
    emptyRangeMeta.timestampedSegmentCount = 1;
    emptyRangeMeta.timestampCoverage = 0.5;
    assert.equal(parseSkillHealthReport(emptyRangeWithObservedSegments), null);

    const rangeWithoutObservedSegments = legacyReport();
    const rangeWithoutObservedMeta = rangeWithoutObservedSegments.meta as Record<string, unknown>;
    rangeWithoutObservedMeta.timestampedSegmentCount = 0;
    rangeWithoutObservedMeta.timestampCoverage = 0;
    assert.equal(parseSkillHealthReport(rangeWithoutObservedSegments), null);
  });

  it('recomputes valid legacy derived labels from authoritative measurements', () => {
    const contradictoryBand = legacyReport();
    (contradictoryBand.overall as Record<string, unknown>).healthBand = 'green';
    assert.equal(parseSkillHealthReport(contradictoryBand)?.overall.healthBand, 'yellow');

    const contradictoryOverallConfidence = legacyReport();
    (contradictoryOverallConfidence.overall as Record<string, unknown>).confidence = 'high';
    assert.equal(
      parseSkillHealthReport(contradictoryOverallConfidence)?.overall.confidence,
      'underpowered',
    );

    const contradictorySkillConfidence = legacyReport();
    const confidenceSkill = (
      contradictorySkillConfidence.bySkill as Record<string, Record<string, unknown>>
    ).audit;
    confidenceSkill.confidence = 'high';
    assert.equal(
      parseSkillHealthReport(contradictorySkillConfidence)?.bySkill.audit.confidence,
      'underpowered',
    );

    const contradictoryStability = legacyReport();
    const stabilitySkill = (
      contradictoryStability.bySkill as Record<string, Record<string, unknown>>
    ).audit;
    stabilitySkill.stability = 'stable';
    assert.equal(
      parseSkillHealthReport(contradictoryStability)?.bySkill.audit.stability,
      'unstable',
    );
  });

  it('rejects contradictory gap, usage, coverage and report aggregates', () => {
    const contradictoryGap = legacyReport();
    const gap = (
      (contradictoryGap.bySkill as Record<string, Record<string, unknown>>).audit.gap
    ) as Record<string, unknown>;
    gap.samplesWithGap = 0;
    assert.equal(parseSkillHealthReport(contradictoryGap), null);

    const contradictoryUsage = legacyReport();
    const usageSkill = (
      contradictoryUsage.bySkill as Record<string, Record<string, unknown>>
    ).audit;
    usageSkill.usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 99,
      durationMs: 20,
      numTurns: 1,
      avgTokensPerSegment: 8,
      avgDurationMsPerSegment: 10,
    };
    assert.equal(parseSkillHealthReport(contradictoryUsage), null);

    const fractionalUsage = legacyReport();
    const fractionalUsageSkill = (
      fractionalUsage.bySkill as Record<string, Record<string, unknown>>
    ).audit;
    fractionalUsageSkill.usage = {
      inputTokens: 0.5,
      outputTokens: 0.5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 1,
      durationMs: 20,
      numTurns: 1,
      avgTokensPerSegment: 1,
      avgDurationMsPerSegment: 10,
    };
    assert.equal(parseSkillHealthReport(fractionalUsage), null);

    const contradictoryCoverage = legacyReport();
    const coverageSkill = (
      contradictoryCoverage.bySkill as Record<string, Record<string, unknown>>
    ).audit;
    coverageSkill.coverage = {
      entries: [{ path: 'a.md', type: 'other', accessed: false, accessCount: 0 }],
      filesCovered: 1,
      filesTotal: 1,
      fileCoverageRate: 1,
      uncoveredFiles: [],
      grepPatternsUsed: 0,
      overallRate: 0.6,
    };
    assert.equal(parseSkillHealthReport(contradictoryCoverage), null);

    const contradictoryOverall = legacyReport();
    const overall = contradictoryOverall.overall as Record<string, unknown>;
    overall.gapRate = 0;
    assert.equal(parseSkillHealthReport(contradictoryOverall), null);
  });

  it('rejects self-consistent reports that alter fixed gap weights or duplicate coverage paths', () => {
    const alteredWeight = legacyReport();
    const alteredOverall = alteredWeight.overall as Record<string, unknown>;
    alteredOverall.weightedGapRate = 0.125;
    const alteredGap = (
      (alteredWeight.bySkill as Record<string, Record<string, unknown>>).audit.gap
    ) as Record<string, unknown>;
    alteredGap.weightedGapRate = 0.125;
    const alteredSignals = alteredGap.signals as Array<Record<string, unknown>>;
    alteredSignals[0].weight = 0.25;
    assert.equal(parseSkillHealthReport(alteredWeight), null);

    const duplicateCoverage = legacyReport();
    const coverageSkill = (
      duplicateCoverage.bySkill as Record<string, Record<string, unknown>>
    ).audit;
    coverageSkill.coverage = {
      entries: [
        { path: 'a.md', type: 'other', accessed: false, accessCount: 0 },
        { path: 'a.md', type: 'other', accessed: false, accessCount: 0 },
      ],
      filesCovered: 0,
      filesTotal: 2,
      fileCoverageRate: 0,
      uncoveredFiles: ['a.md', 'a.md'],
      grepPatternsUsed: 0,
      overallRate: 0,
    };
    assert.equal(parseSkillHealthReport(duplicateCoverage), null);
  });

  it('fails closed when per-skill aggregate counts overflow the safe integer range', () => {
    const report = legacyReport();
    const meta = report.meta as Record<string, unknown>;
    meta.segmentCount = Number.MAX_SAFE_INTEGER;
    meta.messageCount = 0;
    meta.toolCallCount = 0;
    meta.toolFailureRate = 0;
    meta.timestampedSegmentCount = Number.MAX_SAFE_INTEGER;
    meta.timestampCoverage = 1;
    const overall = report.overall as Record<string, unknown>;
    overall.gapRate = 0;
    overall.weightedGapRate = 0;
    overall.healthBand = 'green';
    const health = (name: string) => ({
      skillName: name,
      segmentCount: Number.MAX_SAFE_INTEGER,
      toolCallCount: 0,
      toolFailureCount: 0,
      toolFailureRate: 0,
      coverage: null,
      gap: {
        sampleCount: Number.MAX_SAFE_INTEGER,
        samplesWithGap: 0,
        gapRate: 0,
        weightedGapRate: 0,
        signals: [],
        byType: {
          failed_search: 0,
          explicit_marker: 0,
          hedging: 0,
          repeated_failure: 0,
        },
      },
    });
    report.bySkill = {
      audit: health('audit'),
      review: health('review'),
    };

    assert.doesNotThrow(() => parseSkillHealthReport(report));
    assert.equal(parseSkillHealthReport(report), null);
  });
});
