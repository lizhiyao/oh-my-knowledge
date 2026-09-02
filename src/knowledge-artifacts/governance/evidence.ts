import type { CoreManagedEvidenceProjection } from '../../eval-workflows/downstream-projections/index.js';
import type { ManagedEvidenceRef } from './contracts.js';
import {
  appendManagedEvidence,
  loadAllManagedRecords,
  managedDir,
  resolveManagedDir,
} from './store.js';

export interface RecordedEvidence {
  recordId: string;
  name: string;
  variant: string;
  contentHash: string;
  bound: boolean;
}

function contentHashOfDigest(digest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new TypeError('Core managed evidence artifact digest is invalid.');
  }
  return digest.slice('sha256:'.length);
}

type ProjectionTarget = CoreManagedEvidenceProjection['targets'][number];

function evidenceRefForTarget(
  projection: Readonly<CoreManagedEvidenceProjection>,
  target: Readonly<ProjectionTarget>,
): ManagedEvidenceRef {
  const contentHash = contentHashOfDigest(target.artifact.digest);
  const decision = projection.decision;
  return {
    evidenceSource: 'evaluation-core',
    runId: projection.runId,
    reportId: projection.reportId,
    reportDigest: projection.reportDigest,
    artifactDigest: target.artifact.digest,
    targetId: target.targetId,
    contentHash,
    recordedAt: projection.runCreatedAt,
    ...(decision?.decisionStatus === 'decided' ? {
      verdict: decision.verdict,
      decisionReasonCodes: [...decision.reasonCodes],
    } : {}),
    evidenceReadiness: projection.evidenceReadiness,
    sampleCoverage: {
      count: projection.sampleCount,
      hash: projection.comparability.datasetRevisionDigest,
    },
    coreComparability: { ...projection.comparability },
  };
}

function appendTargetEvidence(
  directory: string,
  record: Readonly<ReturnType<typeof loadAllManagedRecords>[number]>,
  projection: Readonly<CoreManagedEvidenceProjection>,
  target: Readonly<ProjectionTarget>,
): RecordedEvidence | undefined {
  const contentHash = contentHashOfDigest(target.artifact.digest);
  const merged = appendManagedEvidence(
    directory,
    record.id,
    evidenceRefForTarget(projection, target),
  );
  return merged === null ? undefined : {
    recordId: record.id,
    name: record.name,
    variant: target.targetId,
    contentHash,
    bound: contentHash === merged.contentHash,
  };
}

/** Returns one unambiguous non-baseline target for an artifact content hash. */
export function coreEvidenceTargetForContentHash(
  projection: Readonly<CoreManagedEvidenceProjection>,
  contentHash: string,
): ProjectionTarget | undefined {
  const matches = projection.targets.filter((target) => (
    target.managedEvidenceEligible
      && contentHashOfDigest(target.artifact.digest) === contentHash
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Appends authenticated Evaluation Core evidence to already-managed artifacts. */
export function recordCoreEvalEvidence(
  projection: Readonly<CoreManagedEvidenceProjection>,
  options: { dir?: string } = {},
): RecordedEvidence[] {
  if (projection.projectionKind !== 'core-managed-evidence') {
    throw new TypeError('Managed evidence requires an Evaluation Core projection.');
  }
  const directory = resolveManagedDir(options.dir ?? managedDir());
  const records = loadAllManagedRecords(directory);
  const targets = projection.targets.filter((candidate) => candidate.managedEvidenceEligible).map((target) => ({
    target,
    contentHash: contentHashOfDigest(target.artifact.digest),
  }));
  const targetByRecord = new Map<string, ProjectionTarget>();
  const claimedTargets = new Set<ProjectionTarget>();

  // Strong identity first: exact target name plus content digest.
  for (const record of records) {
    const exact = targets.filter(({ target, contentHash }) => (
      contentHash === record.contentHash && target.targetId === record.name
    ));
    if (exact.length === 1) {
      targetByRecord.set(record.id, exact[0].target);
      claimedTargets.add(exact[0].target);
    }
  }

  // Content-only fallback is allowed only when both sides are unique.
  for (const record of records) {
    if (targetByRecord.has(record.id)) continue;
    const recordsWithHash = records.filter((candidate) => candidate.contentHash === record.contentHash);
    const candidates = targets.filter(({ target, contentHash }) => (
      contentHash === record.contentHash && !claimedTargets.has(target)
    ));
    if (recordsWithHash.length === 1 && candidates.length === 1) {
      targetByRecord.set(record.id, candidates[0].target);
      claimedTargets.add(candidates[0].target);
    }
  }
  const written: RecordedEvidence[] = [];
  for (const record of records) {
    const target = targetByRecord.get(record.id);
    if (target === undefined) continue;
    const appended = appendTargetEvidence(directory, record, projection, target);
    if (appended !== undefined) written.push(appended);
  }
  return written;
}

/**
 * Appends evidence to a caller-authenticated managed record identity. Unlike the generic eval
 * binder, identical content in another managed record is not ambiguous because recordId is sealed
 * by the caller's source lookup; the Core target must still be unique by artifact digest.
 */
export function recordCoreEvalEvidenceForRecord(
  projection: Readonly<CoreManagedEvidenceProjection>,
  recordId: string,
  contentHash: string,
  options: { dir?: string } = {},
): RecordedEvidence | undefined {
  if (projection.projectionKind !== 'core-managed-evidence') {
    throw new TypeError('Managed evidence requires an Evaluation Core projection.');
  }
  const target = coreEvidenceTargetForContentHash(projection, contentHash);
  if (target === undefined) return undefined;
  const directory = resolveManagedDir(options.dir ?? managedDir());
  const record = loadAllManagedRecords(directory).find((candidate) => (
    candidate.id === recordId && candidate.contentHash === contentHash
  ));
  return record === undefined
    ? undefined
    : appendTargetEvidence(directory, record, projection, target);
}
