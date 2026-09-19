

import type {
  AnalysisBundle,} from './artifacts.js';
import type {
  CoreSchemaValidator,
  Provenance,} from './common.js';




import type {
  EvaluationBundlePlanContext,} from './evaluation-bundle.js';


import type {
  Sha256Digest,} from './json.js';

export type AnalysisBundleValidationErrorCode =
  | 'ANALYSIS_BUNDLE_DUPLICATE_RECORD'
  | 'ANALYSIS_BUNDLE_RECORD_ORDER_INVALID'
  | 'ANALYSIS_BUNDLE_RECORD_DIGEST_MISMATCH'
  | 'ANALYSIS_BUNDLE_COVERAGE_INVALID'
  | 'ANALYSIS_BUNDLE_STATUS_INVALID'
  | 'ANALYSIS_BUNDLE_ASSUMPTION_INVALID'
  | 'ANALYSIS_BUNDLE_RUNTIME_DEPENDENCY_INVALID'
  | 'ANALYSIS_BUNDLE_DIGEST_MISMATCH'
  | 'ANALYSIS_BUNDLE_PLAN_MISMATCH'
  | 'ANALYSIS_BUNDLE_SOURCE_MISMATCH'
  | 'ANALYSIS_BUNDLE_PROVENANCE_INVALID';

export class AnalysisBundleValidationError extends TypeError {
  readonly code: AnalysisBundleValidationErrorCode;

  constructor(code: AnalysisBundleValidationErrorCode, message: string) {
    super(message);
    this.name = 'AnalysisBundleValidationError';
    this.code = code;
  }
}

export interface AnalysisBundlePlanContext extends EvaluationBundlePlanContext {
  analysis: {
    analysisPlanDigest: string;
    evaluationPlanDigest: string;
    analysisGraph: {
      analysisMode: 'preregistered' | 'exploratory';
      nodes: readonly {
        nodeId: string;
        analysisNodeKind: 'reducer' | 'estimator' | 'correction';
        outputResultId: string;
        parameters?: unknown;
        targetFilter?: { includeTargetIds: readonly string[] };
        cohortFilter?: {
          includeCohortIds?: readonly string[];
          excludeCohortIds?: readonly string[];
        };
        inputs: readonly ({
          inputKind: 'metric-observations' | 'analysis-result';
          referenceId: string;
        } | {
          inputKind: 'comparison';
          referenceId: string;
          treatmentTargetId: string;
          metricId: string;
        })[];
      }[];
    };
    samples: readonly {
      sampleId: string;
      analysis?: { memberships: readonly { cohortId: string }[] };
    }[];
    experiment: {
      sampling: {
        resamplingUnit: 'sample' | 'paired-block' | 'cluster' | 'run';
      };
    };
    metrics: readonly { metricId: string; missingPolicyId: string }[];
    comparisons: readonly {
      comparisonId: string;
      controlTargetId: string;
      treatmentTargetIds: readonly string[];
      metricIds: readonly string[];
    }[];
    runtimes: readonly {
      runtimeKind: 'executor' | 'evaluator' | 'analysis-node' | 'missing-policy' | 'decision-policy';
      referenceId: string;
      identity: unknown;
    }[];
  };
}

export interface AnalysisBundleValidationContext {
  readonly schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
}

export interface AnalysisBundleVerificationContext {
  /** Independently attested by the producing Runtime or a host trust verifier. */
  readonly verifiedProvenanceBundleDigests?: ReadonlySet<Sha256Digest>;
  /** Effective trust independently observed from the Evaluation source at production time. */
  readonly evaluationSourceTrust?: Provenance['trust'];
}

export interface AnalysisBundlePlanVerification {
  readonly provenanceTrustStatus: 'verified' | 'indeterminate';
  readonly evaluationSourceTrust: Provenance['trust'];
}

declare const analysisBundleSourceBrand: unique symbol;

export interface AnalysisBundleVerificationResult {
  readonly [analysisBundleSourceBrand]: true;
  readonly bundle: AnalysisBundle;
  readonly planVerification: AnalysisBundlePlanVerification;
}

export type AnalysisBundleSource = AnalysisBundleVerificationResult;

export interface ExpectedAnalysisRow {
  rowId: string;
  metricId: string;
  targetId: string;
  sampleId: string;
  samplingUnitIds: {
    pairingBlockId?: string;
    clusterId?: string;
  };
  rowStatus: 'observed' | 'missing' | 'invalid' | 'evaluation-failed'
    | 'source-unavailable' | 'not-started';
  censored: boolean;
  reasonCode?: string;
}
