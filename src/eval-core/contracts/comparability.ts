import { z } from 'zod';
import {
  IdentifierSchema,
  RuntimeIdentitySchema,
  SchemaIdentitySchema,
  Sha256DigestSchema,
  type RuntimeIdentity,
} from './common.js';
import {
  assertAnalysisBundleSourceMatchesPlan,
  effectiveAnalysisBundleTrust,
  type AnalysisBundleSource,
} from './analysis-bundle.js';
import {
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  EVALUATION_BUNDLE_SCHEMA_VERSION,
  EVALUATION_EVENT_SCHEMA_VERSION,
  EVALUATION_REPORT_SCHEMA_VERSION,
  EXECUTION_BUNDLE_SCHEMA_VERSION,
} from './artifacts.js';
import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  MEASUREMENT_POLICY_SCHEMA_VERSION,
} from './definition.js';
import {
  assertEvaluationBundleSourceMatchesPlan,
  effectiveEvaluationBundleTrust,
  type EvaluationBundleSource,
} from './evaluation-bundle.js';
import {
  assertExecutionBundleSourceMatchesPlan,
  effectiveExecutionBundleTrust,
  type ExecutionBundleSource,
} from './execution-bundle.js';
import {
  assertDecisionResultSourceChain,
  effectiveDecisionResultTrust,
  type DecisionResultSource,
} from './evaluation-report.js';
import {
  computeRuntimeIdentityDigest,
  computeRuntimeImplementationDigest,
} from './digests.js';
import { derivePlannedExecutionCoordinates } from './execution-identities.js';
import {
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseWireDocument,
  type JsonValue,
  type Sha256Digest,
} from './json.js';
import {
  ANALYSIS_PLAN_SCHEMA_VERSION,
  DECISION_PLAN_SCHEMA_VERSION,
  EVALUATION_PLAN_SCHEMA_VERSION,
  EXECUTION_PLAN_SCHEMA_VERSION,
  PlanDigestsSchema,
  RUN_PLAN_SCHEMA_VERSION,
} from './plans.js';
import {
  assertSealedRunPlan,
  type SealedRunPlan,
} from './sealed-run-plan.js';

export type ComparabilityRunPlan = SealedRunPlan;

export const COMPARABILITY_POLICY_SCHEMA_VERSION = 'omk.comparability-policy/v1' as const;
export const COMPARABILITY_ASSESSMENT_SCHEMA_VERSION = 'omk.comparability-assessment/v2' as const;

export const ComparisonScopeSchema = z.enum(['evaluation', 'analysis', 'decision']);
export const ComparabilityStageSchema = z.enum([
  'execution',
  'evaluation',
  'analysis',
  'decision',
]);

export const ComparabilitySubjectSchema = z.object({
  subjectId: IdentifierSchema,
  leftTargetId: IdentifierSchema,
  rightTargetId: IdentifierSchema,
}).strict();

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareSubjects(
  left: z.infer<typeof ComparabilitySubjectSchema>,
  right: z.infer<typeof ComparabilitySubjectSchema>,
): number {
  return compareStrings(left.subjectId, right.subjectId)
    || compareStrings(left.leftTargetId, right.leftTargetId)
    || compareStrings(left.rightTargetId, right.rightTargetId);
}

function isCanonicalArray<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1], values[index]) >= 0) return false;
  }
  return true;
}

export const ComparabilityPolicySchema = z.object({
  schemaVersion: z.literal(COMPARABILITY_POLICY_SCHEMA_VERSION),
  designMode: z.literal('exact-measurement-design'),
  comparisonScope: ComparisonScopeSchema,
  subjects: z.array(ComparabilitySubjectSchema).min(1),
  policyDigest: Sha256DigestSchema,
}).strict().superRefine((policy, context) => {
  if (!isCanonicalArray(policy.subjects, compareSubjects)) {
    context.addIssue({
      code: 'custom',
      path: ['subjects'],
      message: 'Comparability subjects must be unique and canonical.',
    });
  }
  if (new Set(policy.subjects.map((subject) => subject.subjectId)).size
      !== policy.subjects.length) {
    context.addIssue({
      code: 'custom',
      path: ['subjects'],
      message: 'Comparability subject IDs must be unique.',
    });
  }
  const left = new Set(policy.subjects.map((subject) => subject.leftTargetId));
  const right = new Set(policy.subjects.map((subject) => subject.rightTargetId));
  if (left.size !== policy.subjects.length || right.size !== policy.subjects.length) {
    context.addIssue({
      code: 'custom',
      path: ['subjects'],
      message: 'Comparability subjects must be one-to-one on each side.',
    });
  }
});

const VerificationAxisSchema = z.enum([
  'provenance-attestation',
  'cache-receipt',
  'invocation-budget',
  'provider-cost-budget',
  'policy-execution',
]);

const VerificationAxisFactSchema = z.object({
  verificationFactKind: z.literal('verification-axis'),
  stage: ComparabilityStageSchema,
  sourceDigest: Sha256DigestSchema,
  verificationAxis: VerificationAxisSchema,
  verificationStatus: z.enum(['verified', 'indeterminate']),
}).strict().superRefine((fact, context) => {
  const stageAllowsAxis = fact.stage === 'decision'
    ? fact.verificationAxis === 'policy-execution'
    : fact.stage === 'analysis'
      ? fact.verificationAxis === 'provenance-attestation'
      : fact.verificationAxis !== 'policy-execution';
  if (!stageAllowsAxis) {
    context.addIssue({
      code: 'custom',
      path: ['verificationAxis'],
      message: 'Verification axis does not apply to the declared stage.',
    });
  }
});

const SourceTrustFactSchema = z.object({
  verificationFactKind: z.literal('source-trust'),
  stage: ComparabilityStageSchema,
  sourceDigest: Sha256DigestSchema,
  trustRelation: z.enum(['parent', 'effective']),
  trust: z.enum(['verified', 'declared', 'untrusted', 'unknown']),
}).strict().superRefine((fact, context) => {
  if (fact.stage === 'execution' && fact.trustRelation === 'parent') {
    context.addIssue({
      code: 'custom',
      path: ['trustRelation'],
      message: 'Execution is the root source and cannot claim parent trust.',
    });
  }
});

export const ComparabilitySourceVerificationFactSchema = z.discriminatedUnion(
  'verificationFactKind',
  [VerificationAxisFactSchema, SourceTrustFactSchema],
);

export const RuntimeQualificationFactSchema = z.object({
  stage: ComparabilityStageSchema,
  runtimeKind: z.enum([
    'executor',
    'evaluator',
    'analysis-node',
    'missing-policy',
    'decision-policy',
  ]),
  referenceId: IdentifierSchema,
  runtimeIdentityDigest: Sha256DigestSchema,
  runtimeImplementationDigest: Sha256DigestSchema,
  fingerprintBasis: RuntimeIdentitySchema.shape.fingerprintBasis,
  sealedAssuranceLevel: RuntimeIdentitySchema.shape.assuranceLevel,
  effectiveAssuranceLevel: RuntimeIdentitySchema.shape.assuranceLevel,
  verifiedByAttestationDigest: Sha256DigestSchema.optional(),
}).strict().superRefine((fact, context) => {
  if (fact.verifiedByAttestationDigest !== undefined
      && fact.effectiveAssuranceLevel !== 'verified') {
    context.addIssue({
      code: 'custom',
      path: ['effectiveAssuranceLevel'],
      message: 'An attested Runtime qualification must be effectively verified.',
    });
  }
  if (fact.sealedAssuranceLevel !== 'verified'
      && fact.effectiveAssuranceLevel === 'verified'
      && fact.verifiedByAttestationDigest === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['verifiedByAttestationDigest'],
      message: 'A Runtime assurance upgrade requires an independent attestation.',
    });
  }
  if (fact.verifiedByAttestationDigest === undefined
      && fact.effectiveAssuranceLevel !== fact.sealedAssuranceLevel) {
    context.addIssue({
      code: 'custom',
      path: ['effectiveAssuranceLevel'],
      message: 'Runtime assurance cannot change without an independent attestation.',
    });
  }
});

export const ComparabilityArtifactIdentitySchema = z.object({
  stage: ComparabilityStageSchema,
  artifactDigest: Sha256DigestSchema,
}).strict();

const STAGE_ORDER = {
  execution: 0,
  evaluation: 1,
  analysis: 2,
  decision: 3,
} as const;

const RUNTIME_KIND_ORDER = {
  executor: 0,
  evaluator: 1,
  'analysis-node': 2,
  'missing-policy': 3,
  'decision-policy': 4,
} as const;

const VERIFICATION_AXIS_ORDER = {
  'provenance-attestation': 0,
  'cache-receipt': 1,
  'invocation-budget': 2,
  'provider-cost-budget': 3,
  'policy-execution': 4,
} as const;

function compareArtifacts(
  left: z.infer<typeof ComparabilityArtifactIdentitySchema>,
  right: z.infer<typeof ComparabilityArtifactIdentitySchema>,
): number {
  return STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage]
    || compareStrings(left.artifactDigest, right.artifactDigest);
}

function compareSourceFacts(
  left: z.infer<typeof ComparabilitySourceVerificationFactSchema>,
  right: z.infer<typeof ComparabilitySourceVerificationFactSchema>,
): number {
  const kindOrder = { 'verification-axis': 0, 'source-trust': 1 } as const;
  const base = STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage]
    || kindOrder[left.verificationFactKind] - kindOrder[right.verificationFactKind];
  if (base !== 0) return base;
  if (left.verificationFactKind === 'verification-axis'
      && right.verificationFactKind === 'verification-axis') {
    return VERIFICATION_AXIS_ORDER[left.verificationAxis]
      - VERIFICATION_AXIS_ORDER[right.verificationAxis]
      || compareStrings(left.sourceDigest, right.sourceDigest);
  }
  if (left.verificationFactKind === 'source-trust'
      && right.verificationFactKind === 'source-trust') {
    const relationOrder = { parent: 0, effective: 1 } as const;
    return relationOrder[left.trustRelation] - relationOrder[right.trustRelation]
      || compareStrings(left.sourceDigest, right.sourceDigest);
  }
  return 0;
}

function sourceFactKey(
  fact: z.infer<typeof ComparabilitySourceVerificationFactSchema>,
): string {
  return fact.verificationFactKind === 'verification-axis'
    ? `${fact.stage}\u0000${fact.sourceDigest}\u0000${fact.verificationFactKind}\u0000${fact.verificationAxis}`
    : `${fact.stage}\u0000${fact.sourceDigest}\u0000${fact.verificationFactKind}\u0000${fact.trustRelation}`;
}

function compareRuntimeQualifications(
  left: z.infer<typeof RuntimeQualificationFactSchema>,
  right: z.infer<typeof RuntimeQualificationFactSchema>,
): number {
  return STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage]
    || RUNTIME_KIND_ORDER[left.runtimeKind] - RUNTIME_KIND_ORDER[right.runtimeKind]
    || compareStrings(left.referenceId, right.referenceId)
    || compareStrings(left.runtimeIdentityDigest, right.runtimeIdentityDigest);
}

function runtimeQualificationKey(
  fact: z.infer<typeof RuntimeQualificationFactSchema>,
): string {
  return `${fact.stage}\u0000${fact.runtimeKind}\u0000${fact.referenceId}`;
}

export const ComparabilityRunIdentitySchema = z.object({
  runContractDigest: Sha256DigestSchema,
  planDigests: PlanDigestsSchema,
  randomizationDesignDigest: Sha256DigestSchema,
  artifacts: z.array(ComparabilityArtifactIdentitySchema),
  sourceVerification: z.array(ComparabilitySourceVerificationFactSchema),
  runtimeQualification: z.array(RuntimeQualificationFactSchema),
  runIdentityDigest: Sha256DigestSchema,
}).strict().superRefine((runIdentity, context) => {
  if (!isCanonicalArray(runIdentity.artifacts, compareArtifacts)
      || new Set(runIdentity.artifacts.map((artifact) => artifact.stage)).size
        !== runIdentity.artifacts.length) {
    context.addIssue({ code: 'custom', path: ['artifacts'], message: 'Artifacts must be canonical.' });
  }
  if (runIdentity.runContractDigest !== runIdentity.planDigests.runContractDigest
      || runIdentity.randomizationDesignDigest
        !== runIdentity.planDigests.randomizationDesignDigest) {
    context.addIssue({
      code: 'custom',
      path: ['planDigests'],
      message: 'Run identity digests must equal their Plan digest entries.',
    });
  }
  if (!isCanonicalArray(runIdentity.sourceVerification, compareSourceFacts)
      || new Set(runIdentity.sourceVerification.map(sourceFactKey)).size
        !== runIdentity.sourceVerification.length) {
    context.addIssue({
      code: 'custom',
      path: ['sourceVerification'],
      message: 'Source verification facts must be unique and canonical.',
    });
  }
  if (!isCanonicalArray(runIdentity.runtimeQualification, compareRuntimeQualifications)
      || new Set(runIdentity.runtimeQualification.map(runtimeQualificationKey)).size
        !== runIdentity.runtimeQualification.length) {
    context.addIssue({
      code: 'custom',
      path: ['runtimeQualification'],
      message: 'Runtime qualification facts must be unique and canonical.',
    });
  }
});

export const COMPARABILITY_REASON_CODES = [
  'comparability-identity-declared-subject-change',
  'comparability-design-subject-mapping-invalid',
  'comparability-design-undeclared-subject-change',
  'comparability-design-evaluation-input-mismatch',
  'comparability-design-evaluation-instrument-mismatch',
  'comparability-design-sampling-mismatch',
  'comparability-design-randomization-mismatch',
  'comparability-design-analysis-mismatch',
  'comparability-design-comparison-mismatch',
  'comparability-design-decision-mismatch',
  'comparability-design-schema-mismatch',
  'comparability-design-projection-mismatch',
  'comparability-evidence-source-absent',
  'comparability-evidence-verification-indeterminate',
  'comparability-evidence-assurance-unverified',
  'comparability-evidence-source-untrusted',
  'comparability-evidence-runtime-identity-opaque',
] as const;

export const ComparabilityReasonCodeSchema = z.enum(COMPARABILITY_REASON_CODES);

export const ComparabilityReasonSchema = z.object({
  reasonCode: ComparabilityReasonCodeSchema,
  axis: z.enum(['design', 'evidence', 'identity']),
  severity: z.enum(['info', 'conditional', 'incompatible']),
  scope: ComparisonScopeSchema,
}).strict();

export type ComparabilityReasonCode = z.infer<typeof ComparabilityReasonCodeSchema>;

const REASON_CLASSIFICATION: Record<
ComparabilityReasonCode,
{ axis: 'design' | 'evidence' | 'identity'; severity: 'info' | 'conditional' | 'incompatible' }
> = Object.fromEntries(COMPARABILITY_REASON_CODES.map((reasonCode) => {
  if (reasonCode === 'comparability-identity-declared-subject-change') {
    return [reasonCode, { axis: 'identity', severity: 'info' }];
  }
  if (reasonCode === 'comparability-evidence-source-untrusted') {
    return [reasonCode, { axis: 'evidence', severity: 'incompatible' }];
  }
  if (reasonCode.startsWith('comparability-design-')) {
    return [reasonCode, { axis: 'design', severity: 'incompatible' }];
  }
  return [reasonCode, { axis: 'evidence', severity: 'conditional' }];
})) as Record<ComparabilityReasonCode, {
  axis: 'design' | 'evidence' | 'identity';
  severity: 'info' | 'conditional' | 'incompatible';
}>;

const SEVERITY_ORDER = { incompatible: 0, conditional: 1, info: 2 } as const;
const AXIS_ORDER = { design: 0, evidence: 1, identity: 2 } as const;
const SCOPE_ORDER = { evaluation: 0, analysis: 1, decision: 2 } as const;

function compareReasons(
  left: z.infer<typeof ComparabilityReasonSchema>,
  right: z.infer<typeof ComparabilityReasonSchema>,
): number {
  return SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || AXIS_ORDER[left.axis] - AXIS_ORDER[right.axis]
    || SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope]
    || compareStrings(left.reasonCode, right.reasonCode);
}

export const ComparabilityAssessmentSchema = z.object({
  schemaVersion: z.literal(COMPARABILITY_ASSESSMENT_SCHEMA_VERSION),
  policyDigest: Sha256DigestSchema,
  designMode: z.literal('exact-measurement-design'),
  comparisonScope: ComparisonScopeSchema,
  left: ComparabilityRunIdentitySchema,
  right: ComparabilityRunIdentitySchema,
  designStatus: z.enum(['compatible', 'incompatible']),
  evidenceQualificationStatus: z.enum(['verified', 'conditional', 'rejected']),
  comparabilityStatus: z.enum(['compatible', 'conditional', 'incompatible']),
  reasons: z.array(ComparabilityReasonSchema),
  assessmentDigest: Sha256DigestSchema,
}).strict().superRefine((assessment, context) => {
  if (!isCanonicalArray(assessment.reasons, compareReasons)) {
    context.addIssue({
      code: 'custom',
      path: ['reasons'],
      message: 'Comparability reasons must be unique and canonical.',
    });
  }
  for (const [index, reason] of assessment.reasons.entries()) {
    const expected = REASON_CLASSIFICATION[reason.reasonCode];
    if (reason.axis !== expected.axis
        || reason.severity !== expected.severity
        || reason.scope !== assessment.comparisonScope) {
      context.addIssue({
        code: 'custom',
        path: ['reasons', index],
        message: 'Comparability reason classification is invalid.',
      });
    }
  }
  const hasDesignFailure = assessment.reasons.some((reason) => reason.axis === 'design');
  const hasRejectedEvidence = assessment.reasons.some(
    (reason) => reason.reasonCode === 'comparability-evidence-source-untrusted',
  );
  const hasConditionalEvidence = assessment.reasons.some(
    (reason) => reason.axis === 'evidence' && reason.severity === 'conditional',
  );
  const expectedDesignStatus = hasDesignFailure ? 'incompatible' : 'compatible';
  const expectedEvidenceStatus = hasRejectedEvidence
    ? 'rejected'
    : hasConditionalEvidence ? 'conditional' : 'verified';
  const expectedStatus = expectedDesignStatus === 'incompatible'
    || expectedEvidenceStatus === 'rejected'
    ? 'incompatible'
    : expectedEvidenceStatus === 'conditional' ? 'conditional' : 'compatible';
  if (assessment.designStatus !== expectedDesignStatus
      || assessment.evidenceQualificationStatus !== expectedEvidenceStatus
      || assessment.comparabilityStatus !== expectedStatus) {
    context.addIssue({
      code: 'custom',
      path: ['comparabilityStatus'],
      message: 'Comparability statuses do not follow the normative derivation.',
    });
  }
});

export type ComparisonScope = z.infer<typeof ComparisonScopeSchema>;
export type ComparabilityStage = z.infer<typeof ComparabilityStageSchema>;
export type ComparabilitySubject = z.infer<typeof ComparabilitySubjectSchema>;
export type ComparabilityPolicy = z.infer<typeof ComparabilityPolicySchema>;
export type ComparabilitySourceVerificationFact = z.infer<
  typeof ComparabilitySourceVerificationFactSchema
>;
export type RuntimeQualificationFact = z.infer<typeof RuntimeQualificationFactSchema>;
export type ComparabilityRunIdentity = z.infer<
  typeof ComparabilityRunIdentitySchema
>;
export type ComparabilityReason = z.infer<typeof ComparabilityReasonSchema>;
export type ComparabilityAssessment = z.infer<typeof ComparabilityAssessmentSchema>;

export type ComparabilityValidationErrorCode =
  | 'COMPARABILITY_POLICY_DIGEST_MISMATCH'
  | 'COMPARABILITY_RUN_IDENTITY_DIGEST_MISMATCH'
  | 'COMPARABILITY_ASSESSMENT_DIGEST_MISMATCH'
  | 'COMPARABILITY_ASSESSMENT_RECOMPUTATION_MISMATCH'
  | 'COMPARABILITY_SOURCE_PREFIX_INVALID'
  | 'COMPARABILITY_DECISION_SOURCE_PLAN_MISMATCH'
  | 'COMPARABILITY_VERIFICATION_CONTEXT_INVALID';

export class ComparabilityValidationError extends TypeError {
  readonly code: ComparabilityValidationErrorCode;

  constructor(code: ComparabilityValidationErrorCode, message: string) {
    super(message);
    this.name = 'ComparabilityValidationError';
    this.code = code;
  }
}

export interface ComparabilityPolicyInput {
  readonly schemaVersion: typeof COMPARABILITY_POLICY_SCHEMA_VERSION;
  readonly designMode: 'exact-measurement-design';
  readonly comparisonScope: ComparisonScope;
  readonly subjects: readonly ComparabilitySubject[];
}

function computePolicyDigest(
  policy: Omit<ComparabilityPolicy, 'policyDigest'>,
): Sha256Digest {
  return digestCanonicalJson(policy);
}

export function createComparabilityPolicy(input: ComparabilityPolicyInput): ComparabilityPolicy {
  const subjects = [...input.subjects].sort(compareSubjects);
  const payload = {
    schemaVersion: input.schemaVersion,
    designMode: input.designMode,
    comparisonScope: input.comparisonScope,
    subjects,
  };
  return deepFreezeCanonicalJson(parseComparabilityPolicyDocument({
    ...payload,
    policyDigest: computePolicyDigest(payload),
  }));
}

export function parseComparabilityPolicyDocument(value: unknown): ComparabilityPolicy {
  const policy = parseWireDocument(ComparabilityPolicySchema, value);
  const { policyDigest, ...payload } = policy;
  if (computePolicyDigest(payload) !== policyDigest) {
    throw new ComparabilityValidationError(
      'COMPARABILITY_POLICY_DIGEST_MISMATCH',
      'ComparabilityPolicy digest does not match its canonical payload.',
    );
  }
  return policy;
}

function computeRunIdentityDigest(
  runIdentity: Omit<ComparabilityRunIdentity, 'runIdentityDigest'>,
): Sha256Digest {
  return digestCanonicalJson(runIdentity);
}

function assertRunIdentityDigest(runIdentity: ComparabilityRunIdentity): void {
  const { runIdentityDigest, ...payload } = runIdentity;
  if (computeRunIdentityDigest(payload) !== runIdentityDigest) {
    throw new ComparabilityValidationError(
      'COMPARABILITY_RUN_IDENTITY_DIGEST_MISMATCH',
      'Comparability Run identity digest does not match its canonical payload.',
    );
  }
}

function computeAssessmentDigest(
  assessment: Omit<ComparabilityAssessment, 'assessmentDigest'>,
): Sha256Digest {
  return digestCanonicalJson(assessment);
}

export function parseComparabilityAssessmentDocument(value: unknown): ComparabilityAssessment {
  const assessment = parseWireDocument(ComparabilityAssessmentSchema, value);
  assertRunIdentityDigest(assessment.left);
  assertRunIdentityDigest(assessment.right);
  const { assessmentDigest, ...payload } = assessment;
  if (computeAssessmentDigest(payload) !== assessmentDigest) {
    throw new ComparabilityValidationError(
      'COMPARABILITY_ASSESSMENT_DIGEST_MISMATCH',
      'ComparabilityAssessment digest does not match its canonical payload.',
    );
  }
  return assessment;
}

export interface ComparabilitySourcePrefix {
  readonly execution?: ExecutionBundleSource;
  readonly evaluation?: EvaluationBundleSource;
  readonly analysis?: AnalysisBundleSource;
  readonly decision?: DecisionResultSource;
}

export interface ComparabilityRuntimeAttestation {
  readonly attestationDigest: Sha256Digest;
  readonly verifiedAssuranceLevel: 'verified';
}

export interface ComparabilityVerificationContext {
  readonly verifiedRuntimeAttestations?: ReadonlyMap<
    Sha256Digest,
    ComparabilityRuntimeAttestation
  >;
}

export interface ComparabilityAssessmentPlanVerification {
  readonly assessmentComputationStatus: 'verified';
  readonly policyDigest: Sha256Digest;
  readonly leftRunIdentityDigest: Sha256Digest;
  readonly rightRunIdentityDigest: Sha256Digest;
}

export interface ComparabilityAssessmentSource {
  readonly assessment: ComparabilityAssessment;
  readonly planVerification: ComparabilityAssessmentPlanVerification;
}

const comparabilityAssessmentSources = new WeakSet<object>();

export function assertComparabilityAssessmentSource(
  value: unknown,
): asserts value is ComparabilityAssessmentSource {
  if (value === null
      || typeof value !== 'object'
      || !comparabilityAssessmentSources.has(value)) {
    throw new TypeError(
      'Automated comparison requires a source returned by assessComparability() or parseComparabilityAssessment().',
    );
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

type TargetReference = {
  targetReferenceKind: 'subject' | 'literal-target';
  referenceId: string;
};

interface SideProjection {
  readonly targetReferences: ReadonlyMap<string, TargetReference>;
  readonly mappedTargetIds: ReadonlySet<string>;
}

function buildSideProjection(
  plan: SealedRunPlan,
  policy: ComparabilityPolicy,
  side: 'left' | 'right',
): { projection: SideProjection; valid: boolean } {
  const targetIds = new Set(plan.execution.targets.map((target) => target.targetId));
  const targetReferences = new Map<string, TargetReference>();
  const mappedTargetIds = new Set<string>();
  let valid = true;
  for (const subject of policy.subjects) {
    const targetId = side === 'left' ? subject.leftTargetId : subject.rightTargetId;
    if (!targetIds.has(targetId) || mappedTargetIds.has(targetId)) valid = false;
    mappedTargetIds.add(targetId);
    targetReferences.set(targetId, {
      targetReferenceKind: 'subject',
      referenceId: subject.subjectId,
    });
  }
  for (const targetId of targetIds) {
    if (!targetReferences.has(targetId)) {
      targetReferences.set(targetId, {
        targetReferenceKind: 'literal-target',
        referenceId: targetId,
      });
    }
  }
  if (new Set([...targetReferences.values()].map(canonicalizeJson)).size
      !== targetReferences.size) valid = false;
  return { projection: { targetReferences, mappedTargetIds }, valid };
}

function targetReference(side: SideProjection, targetId: string): TargetReference {
  return side.targetReferences.get(targetId) ?? {
    targetReferenceKind: 'literal-target',
    referenceId: targetId,
  };
}

function sortedJsonValues<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => (
    compareStrings(canonicalizeJson(left), canonicalizeJson(right))
  ));
}

function runtimeImplementationProjection(
  runtimes: SealedRunPlan['execution']['runtimes'],
  targetProjection?: SideProjection,
): JsonValue[] {
  return sortedJsonValues(runtimes.map((runtime) => ({
    runtimeKind: runtime.runtimeKind,
    reference: runtime.runtimeKind === 'executor' && targetProjection !== undefined
      ? targetReference(targetProjection, runtime.referenceId)
      : runtime.referenceId,
    implementationDigest: computeRuntimeImplementationDigest(
      runtime.identity as unknown as RuntimeIdentity,
    ),
  }))) as JsonValue[];
}

function targetDefinitionWithoutId(
  target: SealedRunPlan['execution']['targets'][number],
): JsonValue {
  return {
    targetKind: target.targetKind,
    protocolId: target.protocolId,
    executorId: target.executorId,
    ...(target.versionConstraint === undefined ? {} : {
      versionConstraint: target.versionConstraint,
    }),
    ...(target.config === undefined ? {} : { config: target.config }),
  } as JsonValue;
}

function undeclaredTargetProjection(plan: SealedRunPlan, side: SideProjection): JsonValue[] {
  const runtimeByTarget = new Map(plan.execution.runtimes
    .filter((runtime) => runtime.runtimeKind === 'executor')
    .map((runtime) => [runtime.referenceId, runtime]));
  return sortedJsonValues(plan.execution.targets
    .filter((target) => !side.mappedTargetIds.has(target.targetId))
    .map((target) => {
      const runtime = runtimeByTarget.get(target.targetId);
      return {
        targetReference: targetReference(side, target.targetId),
        definition: targetDefinitionWithoutId(target),
        ...(runtime === undefined ? {} : {
          runtimeImplementationDigest: computeRuntimeImplementationDigest(
            runtime.identity as unknown as RuntimeIdentity,
          ),
        }),
      };
    })) as JsonValue[];
}

function declaredSubjectChanged(
  policy: ComparabilityPolicy,
  leftPlan: SealedRunPlan,
  rightPlan: SealedRunPlan,
): boolean {
  const leftTargets = new Map(leftPlan.execution.targets.map((target) => [target.targetId, target]));
  const rightTargets = new Map(rightPlan.execution.targets.map((target) => [target.targetId, target]));
  const leftRuntimes = new Map(leftPlan.execution.runtimes
    .filter((runtime) => runtime.runtimeKind === 'executor')
    .map((runtime) => [runtime.referenceId, runtime]));
  const rightRuntimes = new Map(rightPlan.execution.runtimes
    .filter((runtime) => runtime.runtimeKind === 'executor')
    .map((runtime) => [runtime.referenceId, runtime]));
  return policy.subjects.some((subject) => {
    const leftTarget = leftTargets.get(subject.leftTargetId);
    const rightTarget = rightTargets.get(subject.rightTargetId);
    const leftRuntime = leftRuntimes.get(subject.leftTargetId);
    const rightRuntime = rightRuntimes.get(subject.rightTargetId);
    if (leftTarget === undefined || rightTarget === undefined
        || leftRuntime === undefined || rightRuntime === undefined) return false;
    return subject.leftTargetId !== subject.rightTargetId
      || !equalJson(
        targetDefinitionWithoutId(leftTarget),
        targetDefinitionWithoutId(rightTarget),
      )
      || computeRuntimeImplementationDigest(leftRuntime.identity as unknown as RuntimeIdentity)
        !== computeRuntimeImplementationDigest(
          rightRuntime.identity as unknown as RuntimeIdentity,
        );
  });
}

function normalizeExperiment(
  plan: SealedRunPlan,
  side: SideProjection,
): JsonValue {
  const assignment = plan.execution.experiment.assignment;
  return {
    trials: plan.execution.experiment.trials,
    seed: plan.execution.experiment.seed,
    assignment: assignment.assignmentKind === 'complete-block' ? {
      ...assignment,
      randomizationSlotIds: [...assignment.randomizationSlotIds],
    } : {
      ...assignment,
      allocations: assignment.allocations.map((allocation) => ({ ...allocation })),
    },
    assignments: sortedJsonValues(plan.execution.assignments.map((membership) => ({
      sampleId: membership.sampleId,
      targetReference: targetReference(side, membership.targetId),
      randomizationSlotId: membership.randomizationSlotId,
    }))),
    sampling: plan.execution.experiment.sampling,
    scheduling: plan.execution.experiment.scheduling,
    randomizationSlots: sortedJsonValues(plan.execution.experiment.randomizationSlots.map(
      (slot) => ({
        targetReference: targetReference(side, slot.targetId),
        randomizationSlotId: slot.randomizationSlotId,
      }),
    )),
  } as JsonValue;
}

function normalizeSchedulingGroups(
  plan: SealedRunPlan,
  side: SideProjection,
): JsonValue {
  return sortedJsonValues(plan.execution.schedulingTargetGroups.map((group) => (
    sortedJsonValues(group.map((targetId) => targetReference(side, targetId)))
  ))) as JsonValue;
}

function normalizeComparisons(
  plan: SealedRunPlan,
  side: SideProjection,
): JsonValue {
  return plan.analysis.comparisons.map((comparison) => ({
    comparisonId: comparison.comparisonId,
    controlTargetReference: targetReference(side, comparison.controlTargetId),
    treatmentTargetReferences: sortedJsonValues(comparison.treatmentTargetIds.map(
      (targetId) => targetReference(side, targetId),
    )),
    metricIds: [...comparison.metricIds],
  })) as unknown as JsonValue;
}

function normalizeAnalysisGraph(
  plan: SealedRunPlan,
  side: SideProjection,
): JsonValue {
  return {
    ...plan.analysis.analysisGraph,
    nodes: plan.analysis.analysisGraph.nodes.map((node) => ({
      ...node,
      inputs: node.inputs.map((input) => {
        if (input.inputKind !== 'comparison') return input;
        const { treatmentTargetId, ...reference } = input;
        return {
          ...reference,
          treatmentTargetReference: targetReference(side, treatmentTargetId),
        };
      }),
    })),
  } as unknown as JsonValue;
}

function normalizeComparisonFamily(
  plan: SealedRunPlan,
  side: SideProjection,
): JsonValue {
  const policy = plan.decision.decisionPolicy;
  if (policy?.comparisonFamily === undefined) return null;
  return {
    comparisonFamily: policy.comparisonFamily.map((member) => {
      const { treatmentTargetId, ...reference } = member;
      return {
        ...reference,
        treatmentTargetReference: targetReference(side, treatmentTargetId),
      };
    }),
    comparisonFamilyResultId: policy.comparisonFamilyResultId ?? null,
    multipleComparisonPolicyId: policy.multipleComparisonPolicyId ?? null,
  } as unknown as JsonValue;
}

function normalizeDecisionPolicy(plan: SealedRunPlan): JsonValue | undefined {
  const policy = plan.decision.decisionPolicy;
  if (policy === undefined) return undefined;
  return Object.fromEntries(Object.entries(policy).filter(([key]) => (
    key !== 'comparisonFamily'
    && key !== 'comparisonFamilyResultId'
    && key !== 'multipleComparisonPolicyId'
  ))) as JsonValue;
}

function normalizedRandomizationCoordinates(
  plan: SealedRunPlan,
  side: SideProjection,
): JsonValue {
  return sortedJsonValues(derivePlannedExecutionCoordinates(plan).map((coordinate) => ({
    targetReference: targetReference(side, coordinate.targetId),
    randomizationSlotId: coordinate.randomizationSlotId,
    sampleId: coordinate.sampleId,
    trialIndex: coordinate.trialIndex,
    trialSeed: coordinate.trialSeed,
  }))) as JsonValue;
}

function isDeterministicRuntime(identity: { readonly capabilities: unknown }): boolean {
  const capabilities = identity.capabilities;
  if (capabilities === null || Array.isArray(capabilities) || typeof capabilities !== 'object') {
    return false;
  }
  const protocols = (capabilities as Record<string, JsonValue>).protocols;
  return Array.isArray(protocols) && protocols.length > 0 && protocols.every((protocol) => {
    if (protocol === null || Array.isArray(protocol) || typeof protocol !== 'object') return false;
    const execution = (protocol as Record<string, JsonValue>).execution;
    return execution !== null && !Array.isArray(execution) && typeof execution === 'object'
      && (execution as Record<string, JsonValue>).determinism === 'deterministic';
  });
}

function hasUncontrolledStochasticSubject(
  plan: SealedRunPlan,
  side: SideProjection,
): boolean {
  if (plan.execution.experiment.sampling.seedCoupling !== 'uncontrolled') return false;
  return plan.execution.runtimes.some((runtime) => (
    runtime.runtimeKind === 'executor'
    && side.mappedTargetIds.has(runtime.referenceId)
    && !isDeterministicRuntime(runtime.identity)
  ));
}

function addReason(codes: Set<ComparabilityReasonCode>, code: ComparabilityReasonCode): void {
  codes.add(code);
}

function consumedWireSchemaProjection(
  plan: SealedRunPlan,
  scope: ComparisonScope,
): JsonValue {
  const versions = new Set<string>([
    EVALUATION_DEFINITION_SCHEMA_VERSION,
    MEASUREMENT_POLICY_SCHEMA_VERSION,
    EXECUTION_PLAN_SCHEMA_VERSION,
    EVALUATION_PLAN_SCHEMA_VERSION,
    RUN_PLAN_SCHEMA_VERSION,
    EVALUATION_EVENT_SCHEMA_VERSION,
    EXECUTION_BUNDLE_SCHEMA_VERSION,
    EVALUATION_BUNDLE_SCHEMA_VERSION,
    ...(scope === 'evaluation' ? [] : [
      ANALYSIS_PLAN_SCHEMA_VERSION,
      ANALYSIS_BUNDLE_SCHEMA_VERSION,
    ]),
    ...(scope === 'decision' ? [
      DECISION_PLAN_SCHEMA_VERSION,
      EVALUATION_REPORT_SCHEMA_VERSION,
    ] : []),
  ]);
  return sortedJsonValues(plan.schemaIdentities.filter(
    (identity) => versions.has(identity.schemaVersion),
  )) as unknown as JsonValue;
}

function collectSchemaIdentities(value: unknown, identities: Map<string, JsonValue>): void {
  const parsed = SchemaIdentitySchema.safeParse(value);
  if (parsed.success) {
    identities.set(canonicalizeJson(parsed.data), parsed.data as JsonValue);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectSchemaIdentities(entry, identities);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const entry of Object.values(value)) collectSchemaIdentities(entry, identities);
}

function consumedRuntimeSchemaProjection(
  plan: SealedRunPlan,
  scope: ComparisonScope,
  side: SideProjection,
): JsonValue {
  const runtimes = relevantRuntimes(plan, scope).filter((runtime) => (
    runtime.runtimeKind !== 'executor' || !side.mappedTargetIds.has(runtime.referenceId)
  ));
  const identities = new Map<string, JsonValue>();
  for (const runtime of runtimes) {
    collectSchemaIdentities(runtime.identity.capabilities, identities);
  }
  return [...identities.values()].sort((left, right) => (
    compareStrings(canonicalizeJson(left), canonicalizeJson(right))
  ));
}

function designReasons(
  policy: ComparabilityPolicy,
  leftPlan: SealedRunPlan,
  rightPlan: SealedRunPlan,
): { codes: Set<ComparabilityReasonCode>; left: SideProjection; right: SideProjection } {
  const codes = new Set<ComparabilityReasonCode>();
  const leftResult = buildSideProjection(leftPlan, policy, 'left');
  const rightResult = buildSideProjection(rightPlan, policy, 'right');
  const left = leftResult.projection;
  const right = rightResult.projection;
  if (!leftResult.valid || !rightResult.valid) {
    addReason(codes, 'comparability-design-subject-mapping-invalid');
  }
  if (declaredSubjectChanged(policy, leftPlan, rightPlan)) {
    addReason(codes, 'comparability-identity-declared-subject-change');
  }
  if (!equalJson(
    undeclaredTargetProjection(leftPlan, left),
    undeclaredTargetProjection(rightPlan, right),
  )) {
    addReason(codes, 'comparability-design-undeclared-subject-change');
  }
  if (!equalJson(leftPlan.evaluation.samples, rightPlan.evaluation.samples)
      || leftPlan.evaluation.evaluationInputDigest
        !== rightPlan.evaluation.evaluationInputDigest) {
    addReason(codes, 'comparability-design-evaluation-input-mismatch');
  }
  const leftEvaluationInstrument = {
    evaluators: leftPlan.evaluation.evaluators,
    metrics: leftPlan.evaluation.metrics,
    runtimes: runtimeImplementationProjection(leftPlan.evaluation.runtimes),
    policy: leftPlan.evaluation.policy,
  };
  const rightEvaluationInstrument = {
    evaluators: rightPlan.evaluation.evaluators,
    metrics: rightPlan.evaluation.metrics,
    runtimes: runtimeImplementationProjection(rightPlan.evaluation.runtimes),
    policy: rightPlan.evaluation.policy,
  };
  if (!equalJson(leftEvaluationInstrument, rightEvaluationInstrument)) {
    addReason(codes, 'comparability-design-evaluation-instrument-mismatch');
  }
  const leftSampling = {
    experiment: normalizeExperiment(leftPlan, left),
    schedulingTargetGroups: normalizeSchedulingGroups(leftPlan, left),
  };
  const rightSampling = {
    experiment: normalizeExperiment(rightPlan, right),
    schedulingTargetGroups: normalizeSchedulingGroups(rightPlan, right),
  };
  if (!equalJson(leftSampling, rightSampling)) {
    addReason(codes, 'comparability-design-sampling-mismatch');
  }
  if (leftPlan.execution.randomizationDesignDigest
        !== rightPlan.execution.randomizationDesignDigest
      || !equalJson(
        normalizedRandomizationCoordinates(leftPlan, left),
        normalizedRandomizationCoordinates(rightPlan, right),
      )
      || hasUncontrolledStochasticSubject(leftPlan, left)
      || hasUncontrolledStochasticSubject(rightPlan, right)) {
    addReason(codes, 'comparability-design-randomization-mismatch');
  }
  const leftProjection = {
    executionInputDigest: leftPlan.execution.executionInputDigest,
    policy: leftPlan.execution.policy,
    eventDelivery: leftPlan.measurementPolicy.eventDelivery,
    extensions: leftPlan.extensions ?? null,
  };
  const rightProjection = {
    executionInputDigest: rightPlan.execution.executionInputDigest,
    policy: rightPlan.execution.policy,
    eventDelivery: rightPlan.measurementPolicy.eventDelivery,
    extensions: rightPlan.extensions ?? null,
  };
  if (!equalJson(leftProjection, rightProjection)) {
    addReason(codes, 'comparability-design-projection-mismatch');
  }
  const consumedStages: ComparabilityStage[] = policy.comparisonScope === 'evaluation'
    ? ['execution', 'evaluation']
    : policy.comparisonScope === 'analysis'
      ? ['execution', 'evaluation', 'analysis']
      : ['execution', 'evaluation', 'analysis', 'decision'];
  const leftExtensions = consumedStages.map((stage) => ({
    stage,
    extensions: leftPlan[stage].extensions ?? null,
  }));
  const rightExtensions = consumedStages.map((stage) => ({
    stage,
    extensions: rightPlan[stage].extensions ?? null,
  }));
  if (!equalJson(
    consumedWireSchemaProjection(leftPlan, policy.comparisonScope),
    consumedWireSchemaProjection(rightPlan, policy.comparisonScope),
  )
      || !equalJson(
        consumedRuntimeSchemaProjection(leftPlan, policy.comparisonScope, left),
        consumedRuntimeSchemaProjection(rightPlan, policy.comparisonScope, right),
      )
      || !equalJson(leftExtensions, rightExtensions)) {
    addReason(codes, 'comparability-design-schema-mismatch');
  }
  if (policy.comparisonScope !== 'evaluation') {
    const leftAnalysis = {
      graph: normalizeAnalysisGraph(leftPlan, left),
      estimatorId: leftPlan.analysis.experiment.sampling.estimatorId,
      runtimes: runtimeImplementationProjection(leftPlan.analysis.runtimes),
    };
    const rightAnalysis = {
      graph: normalizeAnalysisGraph(rightPlan, right),
      estimatorId: rightPlan.analysis.experiment.sampling.estimatorId,
      runtimes: runtimeImplementationProjection(rightPlan.analysis.runtimes),
    };
    if (!equalJson(leftAnalysis, rightAnalysis)) {
      addReason(codes, 'comparability-design-analysis-mismatch');
    }
    const leftComparison = {
      definitions: normalizeComparisons(leftPlan, left),
      family: normalizeComparisonFamily(leftPlan, left),
    };
    const rightComparison = {
      definitions: normalizeComparisons(rightPlan, right),
      family: normalizeComparisonFamily(rightPlan, right),
    };
    if (!equalJson(leftComparison, rightComparison)) {
      addReason(codes, 'comparability-design-comparison-mismatch');
    }
  }
  if (policy.comparisonScope === 'decision') {
    const leftDecision = {
      policy: normalizeDecisionPolicy(leftPlan) ?? null,
      runtimes: runtimeImplementationProjection(leftPlan.decision.runtimes),
    };
    const rightDecision = {
      policy: normalizeDecisionPolicy(rightPlan) ?? null,
      runtimes: runtimeImplementationProjection(rightPlan.decision.runtimes),
    };
    if (!equalJson(leftDecision, rightDecision)) {
      addReason(codes, 'comparability-design-decision-mismatch');
    }
  }
  return { codes, left, right };
}

function digestIsValid(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validateVerificationContext(
  verification: ComparabilityVerificationContext | undefined,
): ReadonlyMap<Sha256Digest, ComparabilityRuntimeAttestation> {
  const input = verification?.verifiedRuntimeAttestations;
  if (input === undefined) return new Map();
  const attestations = new Map<Sha256Digest, ComparabilityRuntimeAttestation>();
  try {
    if (input === null || typeof input !== 'object') {
      throw new ComparabilityValidationError(
        'COMPARABILITY_VERIFICATION_CONTEXT_INVALID',
        'Comparability Runtime attestations must be a ReadonlyMap-compatible iterable.',
      );
    }
    const mapLike = input as {
      get?: unknown;
      has?: unknown;
      [Symbol.iterator]?: unknown;
    };
    const get = mapLike.get;
    const has = mapLike.has;
    const iteratorMethod = mapLike[Symbol.iterator];
    if (typeof get !== 'function'
        || typeof has !== 'function'
        || typeof iteratorMethod !== 'function') {
      throw new ComparabilityValidationError(
        'COMPARABILITY_VERIFICATION_CONTEXT_INVALID',
        'Comparability Runtime attestations must be a ReadonlyMap-compatible iterable.',
      );
    }
    const iterator = Reflect.apply(iteratorMethod, input, []) as unknown;
    if (iterator === null || typeof iterator !== 'object') {
      throw new ComparabilityValidationError(
        'COMPARABILITY_VERIFICATION_CONTEXT_INVALID',
        'Comparability Runtime attestations must provide a valid iterator.',
      );
    }
    const next = (iterator as { next?: unknown }).next;
    if (typeof next !== 'function') {
      throw new ComparabilityValidationError(
        'COMPARABILITY_VERIFICATION_CONTEXT_INVALID',
        'Comparability Runtime attestations must provide a valid iterator.',
      );
    }
    while (true) {
      const step = Reflect.apply(next, iterator, []) as unknown;
      if (step === null || typeof step !== 'object') {
        throw new ComparabilityValidationError(
          'COMPARABILITY_VERIFICATION_CONTEXT_INVALID',
          'Comparability verification context contains a malformed iterator result.',
        );
      }
      const { done, value: entry } = step as { done?: unknown; value?: unknown };
      if (done === true) break;
      if (done !== false) {
        throw new ComparabilityValidationError(
          'COMPARABILITY_VERIFICATION_CONTEXT_INVALID',
          'Comparability verification context contains a malformed iterator result.',
        );
      }
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new ComparabilityValidationError(
          'COMPARABILITY_VERIFICATION_CONTEXT_INVALID',
          'Comparability verification context contains a malformed Runtime attestation entry.',
        );
      }
      const [identityDigest, value] = entry;
      if (!digestIsValid(identityDigest)
          || value === null
          || typeof value !== 'object') {
        throw new ComparabilityValidationError(
          'COMPARABILITY_VERIFICATION_CONTEXT_INVALID',
          'Comparability verification context contains an invalid Runtime attestation.',
        );
      }
      const attestation = value as Record<string, unknown>;
      if (!digestIsValid(attestation.attestationDigest)
          || attestation.verifiedAssuranceLevel !== 'verified'
          || attestations.has(identityDigest)) {
        throw new ComparabilityValidationError(
          'COMPARABILITY_VERIFICATION_CONTEXT_INVALID',
          'Comparability verification context contains an invalid Runtime attestation.',
        );
      }
      attestations.set(identityDigest, {
        attestationDigest: attestation.attestationDigest,
        verifiedAssuranceLevel: 'verified',
      });
    }
  } catch (error) {
    if (error instanceof ComparabilityValidationError) throw error;
    throw new ComparabilityValidationError(
      'COMPARABILITY_VERIFICATION_CONTEXT_INVALID',
      'Comparability Runtime attestations could not be read as a stable snapshot.',
    );
  }
  return attestations;
}

function relevantRuntimes(
  plan: SealedRunPlan,
  scope: ComparisonScope,
): Array<{
  stage: ComparabilityStage;
  runtimeKind: RuntimeQualificationFact['runtimeKind'];
  referenceId: string;
  identity: RuntimeIdentity;
}> {
  const values = [
    ...plan.execution.runtimes.map((runtime) => ({ stage: 'execution' as const, ...runtime })),
    ...plan.evaluation.runtimes.map((runtime) => ({ stage: 'evaluation' as const, ...runtime })),
    ...(scope === 'evaluation' ? [] : plan.analysis.runtimes.map((runtime) => ({
      stage: 'analysis' as const,
      ...runtime,
    }))),
    ...(scope === 'decision' ? plan.decision.runtimes.map((runtime) => ({
      stage: 'decision' as const,
      ...runtime,
    })) : []),
  ];
  return values as Array<{
    stage: ComparabilityStage;
    runtimeKind: RuntimeQualificationFact['runtimeKind'];
    referenceId: string;
    identity: RuntimeIdentity;
  }>;
}

function runtimeQualifications(
  plan: SealedRunPlan,
  scope: ComparisonScope,
  attestations: ReadonlyMap<Sha256Digest, ComparabilityRuntimeAttestation>,
): RuntimeQualificationFact[] {
  return relevantRuntimes(plan, scope).map((runtime) => {
    const runtimeIdentityDigest = computeRuntimeIdentityDigest(
      runtime.identity as unknown as RuntimeIdentity,
    );
    const attestation = attestations.get(runtimeIdentityDigest);
    return {
      stage: runtime.stage,
      runtimeKind: runtime.runtimeKind,
      referenceId: runtime.referenceId,
      runtimeIdentityDigest,
      runtimeImplementationDigest: computeRuntimeImplementationDigest(
        runtime.identity as unknown as RuntimeIdentity,
      ),
      fingerprintBasis: runtime.identity.fingerprintBasis,
      sealedAssuranceLevel: runtime.identity.assuranceLevel,
      effectiveAssuranceLevel: attestation === undefined
        ? runtime.identity.assuranceLevel
        : 'verified',
      ...(attestation === undefined ? {} : {
        verifiedByAttestationDigest: attestation.attestationDigest,
      }),
    };
  }).sort(compareRuntimeQualifications);
}

function sourceDigest(source: ComparabilitySourcePrefix, stage: ComparabilityStage): Sha256Digest {
  if (stage === 'execution') return source.execution?.bundle.bundleDigest as Sha256Digest;
  if (stage === 'evaluation') return source.evaluation?.bundle.bundleDigest as Sha256Digest;
  if (stage === 'analysis') return source.analysis?.bundle.bundleDigest as Sha256Digest;
  return source.decision?.result.decisionDigest as Sha256Digest;
}

function validateSourcePrefix(
  plan: SealedRunPlan,
  scope: ComparisonScope,
  source: ComparabilitySourcePrefix | undefined,
): ComparabilitySourcePrefix {
  const prefix = source ?? {};
  const execution = prefix.execution;
  const evaluation = prefix.evaluation;
  const analysis = prefix.analysis;
  const decision = prefix.decision;
  if ((scope === 'evaluation' && (analysis !== undefined || decision !== undefined))
      || (scope === 'analysis' && decision !== undefined)) {
    throw new ComparabilityValidationError(
      'COMPARABILITY_SOURCE_PREFIX_INVALID',
      'Comparability sources cannot extend beyond the requested comparison scope.',
    );
  }
  if ((evaluation !== undefined && execution === undefined)
      || (scope !== 'evaluation' && analysis !== undefined && evaluation === undefined)
      || (scope === 'decision' && decision !== undefined && analysis === undefined)) {
    throw new ComparabilityValidationError(
      'COMPARABILITY_SOURCE_PREFIX_INVALID',
      'Comparability sources must form an exact authenticated stage prefix.',
    );
  }
  if (execution !== undefined) assertExecutionBundleSourceMatchesPlan(execution, plan);
  if (evaluation !== undefined && execution !== undefined) {
    assertEvaluationBundleSourceMatchesPlan(plan, execution, evaluation);
  }
  if (scope !== 'evaluation'
      && analysis !== undefined
      && execution !== undefined
      && evaluation !== undefined) {
    assertAnalysisBundleSourceMatchesPlan(plan, execution, evaluation, analysis);
  }
  if (scope === 'decision'
      && decision !== undefined
      && execution !== undefined
      && evaluation !== undefined
      && analysis !== undefined) {
    assertDecisionResultSourceChain(execution, evaluation, analysis, decision);
    if (decision.result.decisionPlanDigest !== plan.decision.decisionPlanDigest) {
      throw new ComparabilityValidationError(
        'COMPARABILITY_DECISION_SOURCE_PLAN_MISMATCH',
        'Decision source does not match the sealed DecisionPlan.',
      );
    }
  }
  return prefix;
}

function sourceFacts(
  scope: ComparisonScope,
  source: ComparabilitySourcePrefix,
): ComparabilitySourceVerificationFact[] {
  const facts: ComparabilitySourceVerificationFact[] = [];
  if (source.execution !== undefined) {
    const digest = source.execution.bundle.bundleDigest as Sha256Digest;
    const verification = source.execution.planVerification;
    facts.push(
      {
        verificationFactKind: 'verification-axis',
        stage: 'execution',
        sourceDigest: digest,
        verificationAxis: 'provenance-attestation',
        verificationStatus: verification.provenanceTrustStatus,
      },
      {
        verificationFactKind: 'verification-axis',
        stage: 'execution',
        sourceDigest: digest,
        verificationAxis: 'cache-receipt',
        verificationStatus: verification.cacheReceiptStatus,
      },
      {
        verificationFactKind: 'verification-axis',
        stage: 'execution',
        sourceDigest: digest,
        verificationAxis: 'invocation-budget',
        verificationStatus: verification.invocationBudgetStatus,
      },
      {
        verificationFactKind: 'verification-axis',
        stage: 'execution',
        sourceDigest: digest,
        verificationAxis: 'provider-cost-budget',
        verificationStatus: verification.providerCostBudgetStatus,
      },
      {
        verificationFactKind: 'source-trust',
        stage: 'execution',
        sourceDigest: digest,
        trustRelation: 'effective',
        trust: effectiveExecutionBundleTrust(source.execution),
      },
    );
  }
  if (source.evaluation !== undefined) {
    const digest = source.evaluation.bundle.bundleDigest as Sha256Digest;
    const verification = source.evaluation.planVerification;
    facts.push(
      {
        verificationFactKind: 'verification-axis',
        stage: 'evaluation',
        sourceDigest: digest,
        verificationAxis: 'provenance-attestation',
        verificationStatus: verification.provenanceTrustStatus,
      },
      {
        verificationFactKind: 'verification-axis',
        stage: 'evaluation',
        sourceDigest: digest,
        verificationAxis: 'cache-receipt',
        verificationStatus: verification.cacheReceiptStatus,
      },
      {
        verificationFactKind: 'verification-axis',
        stage: 'evaluation',
        sourceDigest: digest,
        verificationAxis: 'invocation-budget',
        verificationStatus: verification.invocationBudgetStatus,
      },
      {
        verificationFactKind: 'verification-axis',
        stage: 'evaluation',
        sourceDigest: digest,
        verificationAxis: 'provider-cost-budget',
        verificationStatus: verification.providerCostBudgetStatus,
      },
      {
        verificationFactKind: 'source-trust',
        stage: 'evaluation',
        sourceDigest: digest,
        trustRelation: 'parent',
        trust: verification.executionSourceTrust,
      },
      {
        verificationFactKind: 'source-trust',
        stage: 'evaluation',
        sourceDigest: digest,
        trustRelation: 'effective',
        trust: effectiveEvaluationBundleTrust(source.evaluation),
      },
    );
  }
  if (scope !== 'evaluation' && source.analysis !== undefined) {
    const digest = source.analysis.bundle.bundleDigest as Sha256Digest;
    const verification = source.analysis.planVerification;
    facts.push(
      {
        verificationFactKind: 'verification-axis',
        stage: 'analysis',
        sourceDigest: digest,
        verificationAxis: 'provenance-attestation',
        verificationStatus: verification.provenanceTrustStatus,
      },
      {
        verificationFactKind: 'source-trust',
        stage: 'analysis',
        sourceDigest: digest,
        trustRelation: 'parent',
        trust: verification.evaluationSourceTrust,
      },
      {
        verificationFactKind: 'source-trust',
        stage: 'analysis',
        sourceDigest: digest,
        trustRelation: 'effective',
        trust: effectiveAnalysisBundleTrust(source.analysis),
      },
    );
  }
  if (scope === 'decision' && source.decision !== undefined) {
    const digest = source.decision.result.decisionDigest as Sha256Digest;
    const verification = source.decision.planVerification;
    facts.push(
      {
        verificationFactKind: 'verification-axis',
        stage: 'decision',
        sourceDigest: digest,
        verificationAxis: 'policy-execution',
        verificationStatus: verification.policyExecutionStatus,
      },
      {
        verificationFactKind: 'source-trust',
        stage: 'decision',
        sourceDigest: digest,
        trustRelation: 'parent',
        trust: verification.analysisSourceTrust,
      },
      {
        verificationFactKind: 'source-trust',
        stage: 'decision',
        sourceDigest: digest,
        trustRelation: 'effective',
        trust: effectiveDecisionResultTrust(source.decision),
      },
    );
  }
  return facts.sort(compareSourceFacts);
}

function requiredStages(scope: ComparisonScope): ComparabilityStage[] {
  if (scope === 'evaluation') return ['execution', 'evaluation'];
  if (scope === 'analysis') return ['execution', 'evaluation', 'analysis'];
  return ['execution', 'evaluation', 'analysis', 'decision'];
}

function comparabilityRunIdentity(
  plan: SealedRunPlan,
  scope: ComparisonScope,
  source: ComparabilitySourcePrefix,
  attestations: ReadonlyMap<Sha256Digest, ComparabilityRuntimeAttestation>,
): ComparabilityRunIdentity {
  const artifacts = requiredStages(scope)
    .filter((stage) => source[stage] !== undefined)
    .map((stage) => ({ stage, artifactDigest: sourceDigest(source, stage) }))
    .sort(compareArtifacts);
  const payload = {
    runContractDigest: plan.digests.runContractDigest,
    planDigests: plan.digests,
    randomizationDesignDigest: plan.digests.randomizationDesignDigest,
    artifacts,
    sourceVerification: sourceFacts(scope, source),
    runtimeQualification: runtimeQualifications(plan, scope, attestations),
  };
  return {
    ...payload,
    runIdentityDigest: computeRunIdentityDigest(payload),
  };
}

function evidenceReasons(
  scope: ComparisonScope,
  leftRunIdentity: ComparabilityRunIdentity,
  rightRunIdentity: ComparabilityRunIdentity,
  leftProjection: SideProjection,
  rightProjection: SideProjection,
): Set<ComparabilityReasonCode> {
  const codes = new Set<ComparabilityReasonCode>();
  const required = requiredStages(scope);
  const leftStages = new Set(leftRunIdentity.artifacts.map((artifact) => artifact.stage));
  const rightStages = new Set(rightRunIdentity.artifacts.map((artifact) => artifact.stage));
  if (required.some((stage) => !leftStages.has(stage) || !rightStages.has(stage))) {
    addReason(codes, 'comparability-evidence-source-absent');
  }
  const facts = [...leftRunIdentity.sourceVerification, ...rightRunIdentity.sourceVerification];
  if (facts.some((fact) => fact.verificationFactKind === 'verification-axis'
      && fact.verificationStatus === 'indeterminate')) {
    addReason(codes, 'comparability-evidence-verification-indeterminate');
  }
  const trustFacts = facts.filter((fact): fact is Extract<
    ComparabilitySourceVerificationFact,
    { verificationFactKind: 'source-trust' }
  > => fact.verificationFactKind === 'source-trust');
  if (trustFacts.some((fact) => fact.trust === 'untrusted')) {
    addReason(codes, 'comparability-evidence-source-untrusted');
  }
  const runtimes = [
    ...leftRunIdentity.runtimeQualification,
    ...rightRunIdentity.runtimeQualification,
  ];
  if (trustFacts.some((fact) => fact.trust === 'declared' || fact.trust === 'unknown')
      || runtimes.some((runtime) => runtime.effectiveAssuranceLevel !== 'verified')) {
    addReason(codes, 'comparability-evidence-assurance-unverified');
  }
  const opaqueInvariantRuntime = (
    runIdentity: ComparabilityRunIdentity,
    projection: SideProjection,
  ): boolean => runIdentity.runtimeQualification.some((runtime) => (
    runtime.fingerprintBasis === 'opaque'
    && !(runtime.runtimeKind === 'executor' && projection.mappedTargetIds.has(runtime.referenceId))
  ));
  if (opaqueInvariantRuntime(leftRunIdentity, leftProjection)
      || opaqueInvariantRuntime(rightRunIdentity, rightProjection)) {
    addReason(codes, 'comparability-evidence-runtime-identity-opaque');
  }
  return codes;
}

function makeReasons(
  scope: ComparisonScope,
  codes: ReadonlySet<ComparabilityReasonCode>,
): ComparabilityReason[] {
  return [...codes].map((reasonCode) => ({
    reasonCode,
    ...REASON_CLASSIFICATION[reasonCode],
    scope,
  })).sort(compareReasons);
}

function makeAssessmentSource(assessment: ComparabilityAssessment): ComparabilityAssessmentSource {
  const source = deepFreezeCanonicalJson({
    assessment,
    planVerification: {
      assessmentComputationStatus: 'verified' as const,
      policyDigest: assessment.policyDigest as Sha256Digest,
      leftRunIdentityDigest: assessment.left.runIdentityDigest as Sha256Digest,
      rightRunIdentityDigest: assessment.right.runIdentityDigest as Sha256Digest,
    },
  });
  comparabilityAssessmentSources.add(source);
  return source;
}

export function assessComparability(
  policyInput: ComparabilityPolicy,
  leftPlan: SealedRunPlan,
  rightPlan: SealedRunPlan,
  leftSource?: ComparabilitySourcePrefix,
  rightSource?: ComparabilitySourcePrefix,
  verification?: ComparabilityVerificationContext,
): ComparabilityAssessmentSource {
  assertSealedRunPlan(leftPlan);
  assertSealedRunPlan(rightPlan);
  const policy = parseComparabilityPolicyDocument(policyInput);
  const attestations = validateVerificationContext(verification);
  const normalizedLeftSource = validateSourcePrefix(
    leftPlan,
    policy.comparisonScope,
    leftSource,
  );
  const normalizedRightSource = validateSourcePrefix(
    rightPlan,
    policy.comparisonScope,
    rightSource,
  );
  const design = designReasons(policy, leftPlan, rightPlan);
  const left = comparabilityRunIdentity(
    leftPlan,
    policy.comparisonScope,
    normalizedLeftSource,
    attestations,
  );
  const right = comparabilityRunIdentity(
    rightPlan,
    policy.comparisonScope,
    normalizedRightSource,
    attestations,
  );
  const codes = new Set(design.codes);
  for (const code of evidenceReasons(
    policy.comparisonScope,
    left,
    right,
    design.left,
    design.right,
  )) codes.add(code);
  const reasons = makeReasons(policy.comparisonScope, codes);
  const designStatus = reasons.some((reason) => reason.axis === 'design')
    ? 'incompatible' as const
    : 'compatible' as const;
  const evidenceQualificationStatus = reasons.some(
    (reason) => reason.reasonCode === 'comparability-evidence-source-untrusted',
  )
    ? 'rejected' as const
    : reasons.some((reason) => reason.axis === 'evidence')
      ? 'conditional' as const
      : 'verified' as const;
  const comparabilityStatus = designStatus === 'incompatible'
    || evidenceQualificationStatus === 'rejected'
    ? 'incompatible' as const
    : evidenceQualificationStatus === 'conditional'
      ? 'conditional' as const
      : 'compatible' as const;
  const payload = {
    schemaVersion: COMPARABILITY_ASSESSMENT_SCHEMA_VERSION,
    policyDigest: policy.policyDigest,
    designMode: policy.designMode,
    comparisonScope: policy.comparisonScope,
    left,
    right,
    designStatus,
    evidenceQualificationStatus,
    comparabilityStatus,
    reasons,
  };
  const assessment = deepFreezeCanonicalJson(parseComparabilityAssessmentDocument({
    ...payload,
    assessmentDigest: computeAssessmentDigest(payload),
  }));
  return makeAssessmentSource(assessment);
}

export function parseComparabilityAssessment(
  value: unknown,
  policy: ComparabilityPolicy,
  leftPlan: SealedRunPlan,
  rightPlan: SealedRunPlan,
  leftSource?: ComparabilitySourcePrefix,
  rightSource?: ComparabilitySourcePrefix,
  verification?: ComparabilityVerificationContext,
): ComparabilityAssessmentSource {
  const document = parseComparabilityAssessmentDocument(value);
  const expected = assessComparability(
    policy,
    leftPlan,
    rightPlan,
    leftSource,
    rightSource,
    verification,
  );
  if (!equalJson(document, expected.assessment)) {
    throw new ComparabilityValidationError(
      'COMPARABILITY_ASSESSMENT_RECOMPUTATION_MISMATCH',
      'ComparabilityAssessment does not match the authenticated Plans and sources.',
    );
  }
  return expected;
}
