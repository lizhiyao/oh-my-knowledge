import { z } from 'zod';
import { IdentifierSchema } from '../../eval-core/contracts/index.js';
import type {
  AnalysisBundleVerificationContext,
  AnalysisBundleSource,
  DecisionResultSource,
  DecisionResultVerificationContext,
  EvaluationBundleSource,
  EvaluationBundleVerificationContext,
  EvaluationReport,
  ExecutionBundleSource,
  ExecutionBundleVerificationContext,
  Provenance,
} from '../../eval-core/contracts/index.js';
import type { SealedRunPlan } from '../../eval-core/compiler/index.js';
import type { StoredCoreRunArtifacts } from '../artifact-store/index.js';

export const CoreResumeAdmissionPolicySchema = z.object({
  rejectionMode: z.enum(['fail-closed', 'start-fresh']),
  minimumSourceTrust: z.enum(['untrusted', 'unknown', 'declared', 'verified']),
  cacheReceiptMode: z.enum(['require-verified', 'allow-indeterminate']),
  budgetVerificationMode: z.enum(['require-verified', 'allow-indeterminate']),
}).strict();

export const CoreResumeLocatorSchema = z.object({
  locatorKind: z.literal('core-run'),
  runId: IdentifierSchema,
}).strict();

export type CoreResumeAdmissionPolicy = z.infer<typeof CoreResumeAdmissionPolicySchema>;
export type CoreResumeRejectionMode = CoreResumeAdmissionPolicy['rejectionMode'];
export type CoreResumeLocator = z.infer<typeof CoreResumeLocatorSchema>;

export interface CoreResumeAdmissionRequest {
  readonly locator: CoreResumeLocator;
  readonly plan: SealedRunPlan;
  readonly policy: CoreResumeAdmissionPolicy;
  readonly verification?: CoreResumeVerificationContexts;
}

export interface CoreResumeVerificationContexts {
  readonly execution?: ExecutionBundleVerificationContext;
  readonly evaluation?: EvaluationBundleVerificationContext;
  readonly analysis?: AnalysisBundleVerificationContext;
  readonly decision?: DecisionResultVerificationContext;
}

export type CoreResumeRejectionReasonCode =
  | 'CORE_RESUME_REQUEST_INVALID'
  | 'CORE_RESUME_SOURCE_NOT_FOUND'
  | 'CORE_RESUME_SOURCE_INVALID'
  | 'CORE_RESUME_EVIDENCE_UNAVAILABLE'
  | 'CORE_RESUME_CONTRACT_MISMATCH'
  | 'CORE_RESUME_SOURCE_INCOMPLETE'
  | 'CORE_RESUME_CACHE_RECEIPT_INDETERMINATE'
  | 'CORE_RESUME_BUDGET_INDETERMINATE'
  | 'CORE_RESUME_VERIFICATION_INDETERMINATE'
  | 'CORE_RESUME_PROVENANCE_BELOW_POLICY';

export interface CoreResumeVerificationSummary {
  readonly execution: ExecutionBundleSource['planVerification'];
  readonly evaluation: EvaluationBundleSource['planVerification'];
  readonly analysis: AnalysisBundleSource['planVerification'];
  readonly decision?: DecisionResultSource['planVerification'];
  readonly effectiveSourceTrust: Provenance['trust'];
}

export interface AdmittedCoreResumeSource {
  readonly disposition: 'reuse';
  readonly sourceRunId: string;
  readonly admissionDigest: string;
  readonly artifacts: StoredCoreRunArtifacts;
  readonly executionSource: ExecutionBundleSource;
  readonly evaluationSource: EvaluationBundleSource;
  readonly analysisSource: AnalysisBundleSource;
  readonly decisionSource?: DecisionResultSource;
  readonly report: EvaluationReport;
  readonly verification: CoreResumeVerificationSummary;
}

export interface RejectedCoreResumeSource {
  readonly disposition: 'start-fresh';
  readonly sourceRunId: string;
  readonly reasonCode: CoreResumeRejectionReasonCode;
}

export type CoreResumeAdmissionResult =
  | AdmittedCoreResumeSource
  | RejectedCoreResumeSource;

export interface CoreResumeAdmissionAdapter {
  admit(request: Readonly<CoreResumeAdmissionRequest>): Promise<CoreResumeAdmissionResult>;
}

export class CoreResumeAdmissionError extends TypeError {
  readonly code: CoreResumeRejectionReasonCode;
  readonly sourceRunId: string;

  constructor(input: {
    code: CoreResumeRejectionReasonCode;
    sourceRunId: string;
    message: string;
  }) {
    super(input.message);
    this.name = 'CoreResumeAdmissionError';
    this.code = input.code;
    this.sourceRunId = input.sourceRunId;
  }
}
