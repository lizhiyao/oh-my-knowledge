import { compareStrings } from '../primitives/ordering.js';
import { z } from 'zod';
import {
  IdentifierSchema,
  RuntimeIdentitySchema,
  Sha256DigestSchema,
} from './common.js';
import type {
  AnalysisBundleSource,} from './analysis-bundle.js';
import type {
  EvaluationBundleSource,} from './evaluation-bundle.js';
import type {
  ExecutionBundleSource,} from './execution-bundle.js';
import type {
  DecisionResultSource,} from './evaluation-report.js';
import {
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseWireDocument,
  type Sha256Digest,
} from './json.js';
import {
  PlanDigestsSchema,
} from './plans.js';
import type {
  SealedRunPlan,} from './sealed-run-plan.js';

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

export function compareArtifacts(
  left: z.infer<typeof ComparabilityArtifactIdentitySchema>,
  right: z.infer<typeof ComparabilityArtifactIdentitySchema>,
): number {
  return STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage]
    || compareStrings(left.artifactDigest, right.artifactDigest);
}

export function compareSourceFacts(
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

export function compareRuntimeQualifications(
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

export const REASON_CLASSIFICATION: Record<
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

export function compareReasons(
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

export function computeRunIdentityDigest(
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

export function computeAssessmentDigest(
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
