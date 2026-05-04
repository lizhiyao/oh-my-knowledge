import type { ReportDocument, VariantSummary } from '../types/report.js';

/**
 * Sum (sample × variant) trial outcomes across an evaluation report. Used to
 * print an end-of-run tally line so users see "X passed / Y failed" without
 * scrolling back through per-sample progress noise.
 *
 * Per-sample failures are not fatal at the run level — the run continues, the
 * report still writes. This tally separates "the run produced output" (which
 * the ✅ complete line covers) from "how many trials inside it failed" (which
 * scrolling through ⚠ progress lines does poorly).
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
  if (report.kind === 'batch-evaluation') {
    for (const item of report.items) accumulate(item.summary);
  } else {
    accumulate(report.summary);
  }
  return { passed, failed };
}
