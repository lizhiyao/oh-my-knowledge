import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderMethodologyAudit } from '../../src/renderer/summary.js';
import type { Report, VariantSummary } from '../../src/types/index.js';

// The "评委一致" methodology-audit badge must read the same pair perspective as the
// verdict's ensemble-dissent gate (worst Pearson across control + treatment). Otherwise
// the hero verdict can downgrade to CAUTIOUS on a low control Pearson while this badge
// stays green on a high treatment Pearson — contradictory signals in one report.
const agreement = (pearson: number): VariantSummary['judgeAgreement'] =>
  ({ pearson, meanAbsDiff: 1, pairCount: 1, sampleCount: 30 });

const reportWith = (baseline: number, skill: number): { report: Report; summary: Record<string, VariantSummary> } => ({
  report: { meta: { variants: ['baseline', 'skill'] } } as unknown as Report,
  summary: {
    baseline: { judgeAgreement: agreement(baseline) },
    skill: { judgeAgreement: agreement(skill) },
  } as unknown as Record<string, VariantSummary>,
});

describe('methodology audit — judge-agreement badge pair perspective', () => {
  it('reflects the worst variant: low control Pearson → 评委分歧大 even when treatment agrees', () => {
    const { report, summary } = reportWith(0.2, 0.85);
    const html = renderMethodologyAudit(report, ['baseline', 'skill'], summary, 'zh');
    // Worst (control 0.2) is in the red band → badge must read "评委分歧大", matching the
    // verdict's "judges disagree on baseline" downgrade. Pre-fix it read "评委一致".
    assert.match(html, /评委分歧大/);
  });

  it('stays green only when every compared variant agrees', () => {
    const { report, summary } = reportWith(0.82, 0.85);
    const html = renderMethodologyAudit(report, ['baseline', 'skill'], summary, 'zh');
    assert.doesNotMatch(html, /评委分歧大/);
  });
});
