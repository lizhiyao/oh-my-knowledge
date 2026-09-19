
import {
  DecisionResultSchema,
  type DecisionResult,
} from './artifacts.js';
import {
  Provenance,
} from './common.js';
import type {
  AnalysisBundlePlanContext,} from './analysis-bundle.js';



import {
  canonicalizeJson,
  digestCanonicalJson,
  parseWireDocument,
  type Sha256Digest,
} from './json.js';

export type EvaluationReportValidationErrorCode =
  | 'DECISION_RESULT_DIGEST_MISMATCH'
  | 'DECISION_RESULT_REASON_CODES_NON_CANONICAL'
  | 'DECISION_RESULT_PLAN_MISMATCH'
  | 'DECISION_RESULT_VERIFICATION_GATE_FAILED'
  | 'EVALUATION_REPORT_DIGEST_MISMATCH'
  | 'EVALUATION_REPORT_PLAN_MISMATCH'
  | 'EVALUATION_REPORT_BUNDLE_REFERENCE_INVALID'
  | 'EVALUATION_REPORT_STATUS_INVALID'
  | 'EVALUATION_REPORT_BUDGET_SUMMARY_INVALID'
  | 'EVALUATION_REPORT_PROVENANCE_INVALID';

export class EvaluationReportValidationError extends TypeError {
  readonly code: EvaluationReportValidationErrorCode;

  constructor(code: EvaluationReportValidationErrorCode, message: string) {
    super(message);
    this.name = 'EvaluationReportValidationError';
    this.code = code;
  }
}

export function computeDecisionPolicyDigest(input: {
  decisionPlanDigest: string;
  policy: unknown;
  runtime: unknown;
}): string {
  return digestCanonicalJson({
    derivation: 'omk.decision-policy-digest/v1',
    decisionPlanDigest: input.decisionPlanDigest,
    policy: input.policy,
    runtime: input.runtime,
  });
}

export function parseDecisionResultDocument(value: unknown): DecisionResult {
  const result = parseWireDocument(DecisionResultSchema, value);
  if (result.decisionStatus === 'decided' || result.decisionStatus === 'not-decided') {
    const canonicalReasons = [...result.reasonCodes].sort();
    if (new Set(result.reasonCodes).size !== result.reasonCodes.length
        || canonicalizeJson(result.reasonCodes) !== canonicalizeJson(canonicalReasons)) {
      throw new EvaluationReportValidationError(
        'DECISION_RESULT_REASON_CODES_NON_CANONICAL',
        'DecisionResult reason codes must be unique and canonically ordered.',
      );
    }
  }
  const { decisionDigest, ...payload } = result;
  if (digestCanonicalJson(payload) !== decisionDigest) {
    throw new EvaluationReportValidationError(
      'DECISION_RESULT_DIGEST_MISMATCH',
      'DecisionResult digest does not match its canonical payload.',
    );
  }
  return result;
}

export interface DecisionResultVerificationContext {
  /** Independently attested by the executing Decision Runtime or a host trust verifier. */
  readonly verifiedPolicyExecutionDigests?: ReadonlySet<Sha256Digest>;
  /** Effective trust independently observed from the Analysis source at production time. */
  readonly analysisSourceTrust?: Provenance['trust'];
}

export interface DecisionResultPlanVerification {
  readonly policyExecutionStatus: 'verified' | 'indeterminate';
  readonly analysisSourceTrust: Provenance['trust'];
}

declare const decisionResultSourceBrand: unique symbol;

export interface DecisionResultVerificationResult {
  readonly [decisionResultSourceBrand]: true;
  readonly result: DecisionResult;
  readonly planVerification: DecisionResultPlanVerification;
}

export type DecisionResultSource = DecisionResultVerificationResult;

export interface EvaluationReportPlanContext extends AnalysisBundlePlanContext {
  decision: {
    decisionPlanDigest: string;
    analysisPlanDigest: string;
    decisionPolicy?: {
      decisionPolicyId: string;
      analysisResultIds: readonly string[];
    };
    runtimes: readonly {
      runtimeKind: string;
      referenceId: string;
      identity: unknown;
    }[];
  };
}
