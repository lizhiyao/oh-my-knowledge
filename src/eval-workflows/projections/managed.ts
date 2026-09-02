import {
  deepFreezeCanonicalJson,
  IdentifierSchema,
  Sha256DigestSchema,
  type JsonValue,
} from '../../eval-core/contracts/index.js';
import type { StoredCoreRunArtifacts } from '../artifact-store/index.js';
import {
  CORE_MANAGED_EVIDENCE_SCHEMA_VERSION,
  CoreDownstreamProjectionError,
  type CoreManagedEvidenceProjection,
  type CoreRuntimeIdentityReference,
} from './contracts.js';
import { projectCoreDecision } from './decision.js';
import { assertCoreProjectionSource } from './source.js';

type ArtifactDescriptor = CoreManagedEvidenceProjection['targets'][number]['artifact'];
type ComparisonRoles = CoreManagedEvidenceProjection['targets'][number]['comparisonRoles'];

function freeze<T>(value: T): T {
  return deepFreezeCanonicalJson(value as unknown as JsonValue) as unknown as T;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function artifactDescriptor(config: JsonValue | undefined): ArtifactDescriptor {
  const artifact = record(record(record(config)?.behavior)?.artifact);
  const classification = artifact?.classification;
  const resourceId = IdentifierSchema.safeParse(artifact?.resourceId);
  const digest = Sha256DigestSchema.safeParse(artifact?.digest);
  if (artifact === undefined
      || !resourceId.success
      || !digest.success
      || typeof artifact.mediaType !== 'string'
      || artifact.mediaType.length === 0
      || !['public', 'sensitive', 'secret', 'gold'].includes(String(classification))
      || typeof artifact.size !== 'number'
      || !Number.isInteger(artifact.size)
      || artifact.size < 0) {
    throw new CoreDownstreamProjectionError(
      'CORE_MANAGED_EVIDENCE_SOURCE_INVALID',
      'Managed evidence projection requires each OMK Target to bind one sealed artifact descriptor.',
    );
  }
  return {
    resourceId: resourceId.data,
    digest: digest.data,
    mediaType: artifact.mediaType,
    classification: classification as ArtifactDescriptor['classification'],
    size: artifact.size,
  };
}

function executorRuntime(
  source: Readonly<StoredCoreRunArtifacts>,
  targetId: string,
): CoreRuntimeIdentityReference {
  const runtime = source.plan.execution.runtimes.find((candidate) => (
    candidate.runtimeKind === 'executor' && candidate.referenceId === targetId
  ));
  if (runtime === undefined) {
    throw new CoreDownstreamProjectionError(
      'CORE_MANAGED_EVIDENCE_SOURCE_INVALID',
      'Managed evidence projection requires the sealed Executor identity for every Target.',
    );
  }
  return {
    implementationId: runtime.identity.implementationId,
    ...(runtime.identity.version === undefined ? {} : { version: runtime.identity.version }),
    fingerprint: runtime.identity.fingerprint,
    fingerprintBasis: runtime.identity.fingerprintBasis,
    assuranceLevel: runtime.identity.assuranceLevel,
  };
}

function comparisonRoles(
  source: Readonly<StoredCoreRunArtifacts>,
  targetId: string,
): ComparisonRoles {
  return source.plan.definition.comparisons.flatMap((comparison) => [
    ...(comparison.controlTargetId === targetId ? [{
      comparisonId: comparison.comparisonId,
      comparisonRole: 'control' as const,
    }] : []),
    ...(comparison.treatmentTargetIds.includes(targetId) ? [{
      comparisonId: comparison.comparisonId,
      comparisonRole: 'treatment' as const,
    }] : []),
  ]);
}

/**
 * Projects append-only managed evidence candidates from Core identities. The
 * content-addressed artifact digest replaces legacy short content hashes; no
 * locator, alias, or display score participates in identity matching.
 */
export function projectCoreManagedEvidence(
  source: Readonly<StoredCoreRunArtifacts>,
): CoreManagedEvidenceProjection {
  assertCoreProjectionSource(source);
  const projectedDecision = projectCoreDecision(source.report.decision);
  const evidenceReadiness = source.report.status.evidenceStatus !== 'complete'
    || source.report.status.runStatus !== 'completed'
    ? 'insufficient'
    : projectedDecision?.decisionStatus === 'decided'
      && source.report.status.conclusionStatus === 'conclusive'
      ? 'decision-ready'
      : 'measurement-only';
  return freeze({
    projectionKind: 'core-managed-evidence',
    schemaVersion: CORE_MANAGED_EVIDENCE_SCHEMA_VERSION,
    runId: source.manifest.runId,
    reportId: source.report.reportId,
    reportDigest: source.report.reportDigest,
    runCreatedAt: source.manifest.createdAt,
    status: source.report.status,
    evidenceReadiness,
    comparability: {
      runContractDigest: source.plan.digests.runContractDigest,
      datasetRevisionDigest: source.plan.digests.datasetRevisionDigest,
      executionPlanDigest: source.plan.digests.executionPlanDigest,
      evaluationPlanDigest: source.plan.digests.evaluationPlanDigest,
      analysisPlanDigest: source.plan.digests.analysisPlanDigest,
      decisionPlanDigest: source.plan.digests.decisionPlanDigest,
    },
    sampleCount: source.plan.execution.samples.length,
    targets: source.plan.execution.targets.map((target) => ({
      targetId: target.targetId,
      targetKind: target.targetKind,
      comparisonRoles: comparisonRoles(source, target.targetId),
      managedEvidenceEligible: target.targetKind !== 'baseline',
      artifact: artifactDescriptor(target.config),
      executorRuntime: executorRuntime(source, target.targetId),
    })),
    ...(projectedDecision === undefined ? {} : { decision: projectedDecision }),
  });
}
