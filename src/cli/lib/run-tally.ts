import type { ReportDocument, VariantSummary } from '../../types/report.js';

/**
 * Sum (sample × variant) trial outcomes across an evaluation report. Each
 * sample is run against every variant, so a 10-sample × 2-variant run has
 * 20 trials — passed/failed counts trials, not unique sample IDs. The
 * end-of-run tally line uses "试次 / Trials" to make this explicit and
 * avoid users reading the number as "samples that failed".
 *
 * Per-trial failures are not fatal at the run level — the run continues, the
 * report still writes. This tally separates "the run produced output" (which
 * the ✅ complete line covers) from "how many trials inside it failed" (which
 * scrolling through ⚠️ progress lines does poorly).
 */
export function computeRunTally(report: ReportDocument): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  const accumulate = (summaries: Record<string, VariantSummary>): void => {
    for (const s of Object.values(summaries)) {
      passed += s.successCount;
      failed += s.errorCount;
    }
  };
  if (report.reportKind === 'batch-evaluation') {
    for (const item of report.items) accumulate(item.summary);
  } else {
    accumulate(report.summary);
  }
  return { passed, failed };
}
