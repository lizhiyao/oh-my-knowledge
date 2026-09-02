import type { ManagedEvidenceRef } from '../../src/knowledge-artifacts/governance/contracts.js';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;

/** Minimal authenticated Core evidence fixture. Legacy report refs intentionally do not qualify. */
export function coreManagedEvidence(
  contentHash: string,
  overrides: Partial<ManagedEvidenceRef> = {},
): ManagedEvidenceRef {
  const reportId = overrides.reportId ?? 'core-run-1.report';
  const runId = overrides.runId
    ?? (reportId.endsWith('.report') ? reportId.slice(0, -'.report'.length) : reportId);
  return {
    evidenceSource: 'evaluation-core',
    runId,
    reportId,
    reportDigest: DIGEST_A,
    contentHash,
    artifactDigest: DIGEST_B,
    targetId: 'review',
    recordedAt: '2026-06-07T00:00:00.000Z',
    verdict: 'PROGRESS',
    decisionReasonCodes: ['release-gates-passed'],
    evidenceReadiness: 'decision-ready',
    sampleCoverage: { count: 1, hash: DIGEST_C },
    coreComparability: {
      runContractDigest: DIGEST_A,
      datasetRevisionDigest: DIGEST_B,
      executionPlanDigest: DIGEST_C,
      evaluationPlanDigest: DIGEST_A,
      analysisPlanDigest: DIGEST_B,
      decisionPlanDigest: DIGEST_C,
    },
    ...overrides,
  };
}
