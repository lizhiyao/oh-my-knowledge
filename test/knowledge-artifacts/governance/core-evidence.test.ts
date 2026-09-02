import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreManagedEvidenceProjection } from '../../../src/eval-workflows/downstream-projections/index.js';
import { CORE_MANAGED_EVIDENCE_SCHEMA_VERSION } from '../../../src/eval-workflows/downstream-projections/index.js';
import {
  coreEvidenceTargetForContentHash,
  recordCoreEvalEvidence,
  recordCoreEvalEvidenceForRecord,
} from '../../../src/knowledge-artifacts/governance/evidence.js';
import {
  buildManagedArtifactRecord,
  loadManagedRecord,
  managedRecordId,
  upsertManagedRecord,
} from '../../../src/knowledge-artifacts/governance/store.js';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function projection(overrides: Partial<CoreManagedEvidenceProjection> = {}): CoreManagedEvidenceProjection {
  return {
    projectionKind: 'core-managed-evidence',
    schemaVersion: CORE_MANAGED_EVIDENCE_SCHEMA_VERSION,
    runId: 'core-run-1',
    reportId: 'core-run-1.report',
    reportDigest: digest('a'),
    runCreatedAt: '2026-09-01T00:00:00.000Z',
    status: { runStatus: 'completed', evidenceStatus: 'complete', conclusionStatus: 'conclusive' },
    evidenceReadiness: 'decision-ready',
    comparability: {
      runContractDigest: digest('b'),
      datasetRevisionDigest: digest('c'),
      executionPlanDigest: digest('d'),
      evaluationPlanDigest: digest('e'),
      analysisPlanDigest: digest('f'),
      decisionPlanDigest: digest('0'),
    },
    sampleCount: 12,
    targets: [{
      targetId: 'review',
      targetKind: 'skill',
      comparisonRoles: [{ comparisonId: 'comparison-1', comparisonRole: 'treatment' }],
      managedEvidenceEligible: true,
      artifact: {
        resourceId: 'artifact-review',
        digest: digest('1'),
        mediaType: 'text/markdown',
        classification: 'public',
        size: 42,
      },
      executorRuntime: {
        implementationId: 'executor-1',
        fingerprint: digest('2'),
        fingerprintBasis: 'content-derived',
        assuranceLevel: 'verified',
      },
    }],
    decision: {
      decisionStatus: 'decided',
      decisionPolicyId: 'release-gate',
      verdict: 'PROGRESS',
      reasonCodes: ['release-gates-passed'],
      decisionDigest: digest('3'),
    },
    ...overrides,
  };
}

describe('managed Core evidence', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omk-core-evidence-'));
    upsertManagedRecord(dir, buildManagedArtifactRecord({
      name: 'review',
      kind: 'skill',
      source: { sourceKind: 'file', locator: '/skills/review.md', isDirectorySkill: false },
      contentHash: '1'.repeat(64),
      installedAt: '2026-08-31T00:00:00.000Z',
      distribution: [],
    }));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('binds authenticated Core evidence by full artifact digest', () => {
    expect(recordCoreEvalEvidence(projection(), { dir })).toEqual([{
      recordId: managedRecordId('skill', 'review'),
      name: 'review',
      variant: 'review',
      contentHash: '1'.repeat(64),
      bound: true,
    }]);

    const record = loadManagedRecord(dir, managedRecordId('skill', 'review'))!;
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0]).toMatchObject({
      evidenceSource: 'evaluation-core',
      runId: 'core-run-1',
      reportId: 'core-run-1.report',
      reportDigest: digest('a'),
      artifactDigest: digest('1'),
      verdict: 'PROGRESS',
      evidenceReadiness: 'decision-ready',
      sampleCoverage: { count: 12, hash: digest('c') },
    });
  });

  it('does not bind ineligible targets and rejects unauthenticated artifact identities', () => {
    const ineligible = projection({
      targets: [{ ...projection().targets[0], managedEvidenceEligible: false }],
    });
    expect(recordCoreEvalEvidence(ineligible, { dir })).toEqual([]);
    expect(() => recordCoreEvalEvidence(projection({
      targets: [{
        ...projection().targets[0],
        artifact: { ...projection().targets[0].artifact, digest: 'short-hash' },
      }],
    }), { dir })).toThrow('artifact digest is invalid');
  });

  it('prefers exact target identity over an earlier same-content target', () => {
    const base = projection().targets[0];
    const source = projection({
      targets: [
        { ...base, targetId: 'other' },
        { ...base, targetId: 'review' },
      ],
    });
    expect(recordCoreEvalEvidence(source, { dir })).toHaveLength(1);
    expect(loadManagedRecord(dir, managedRecordId('skill', 'review'))?.evidence[0].targetId)
      .toBe('review');
    expect(coreEvidenceTargetForContentHash(source, '1'.repeat(64))).toBeUndefined();
  });

  it('fails closed when content-only target identity is ambiguous', () => {
    const base = projection().targets[0];
    const source = projection({
      targets: [
        { ...base, targetId: 'candidate-a' },
        { ...base, targetId: 'candidate-b' },
      ],
    });
    expect(recordCoreEvalEvidence(source, { dir })).toEqual([]);
    expect(loadManagedRecord(dir, managedRecordId('skill', 'review'))?.evidence).toEqual([]);
  });

  it('binds an exact managed record after source identity disambiguates duplicate content', () => {
    upsertManagedRecord(dir, buildManagedArtifactRecord({
      name: 'same-content',
      kind: 'skill',
      source: { sourceKind: 'file', locator: '/skills/same-content.md', isDirectorySkill: false },
      contentHash: '1'.repeat(64),
      installedAt: '2026-08-31T00:00:00.000Z',
      distribution: [],
    }));
    const source = projection({
      targets: [{ ...projection().targets[0], targetId: 'treatment' }],
    });

    expect(recordCoreEvalEvidence(source, { dir })).toEqual([]);
    expect(recordCoreEvalEvidenceForRecord(
      source,
      managedRecordId('skill', 'review'),
      '1'.repeat(64),
      { dir },
    )).toMatchObject({
      recordId: managedRecordId('skill', 'review'),
      variant: 'treatment',
      bound: true,
    });
    expect(loadManagedRecord(dir, managedRecordId('skill', 'review'))?.evidence).toHaveLength(1);
    expect(loadManagedRecord(dir, managedRecordId('skill', 'same-content'))?.evidence).toEqual([]);
  });
});
