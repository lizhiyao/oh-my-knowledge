



import type {
  EvaluationBundle,
  MetricObservation,} from './artifacts.js';
import {
  Provenance,
  RuntimeIdentity,
} from './common.js';


import type {
  ExecutionBundlePlanContext,} from './execution-bundle.js';

import type {
  JsonValue,
  Sha256Digest,} from './json.js';


export type EvaluationBundleValidationErrorCode =
  | 'EVALUATION_BUNDLE_DUPLICATE_COORDINATE'
  | 'EVALUATION_BUNDLE_IDENTITY_MISMATCH'
  | 'EVALUATION_BUNDLE_RECORD_ORDER_INVALID'
  | 'EVALUATION_BUNDLE_ATTEMPT_ORDER_INVALID'
  | 'EVALUATION_BUNDLE_OBSERVATION_INVALID'
  | 'EVALUATION_BUNDLE_COVERAGE_INVALID'
  | 'EVALUATION_BUNDLE_STATUS_INVALID'
  | 'EVALUATION_BUNDLE_REPLAYABILITY_INVALID'
  | 'EVALUATION_BUNDLE_DIGEST_MISMATCH'
  | 'EVALUATION_BUNDLE_PLAN_MISMATCH'
  | 'EVALUATION_BUNDLE_SOURCE_MISMATCH'
  | 'EVALUATION_BUNDLE_RETRY_POLICY_INVALID'
  | 'EVALUATION_BUNDLE_BINDING_CLOSURE_INVALID'
  | 'EVALUATION_BUNDLE_CACHE_POLICY_INVALID'
  | 'EVALUATION_BUNDLE_PROVIDER_COST_INVALID'
  | 'EVALUATION_BUNDLE_EVIDENCE_POLICY_INVALID'
  | 'EVALUATION_BUNDLE_USAGE_INVALID'
  | 'EVALUATION_BUNDLE_PROVENANCE_INVALID';

export class EvaluationBundleValidationError extends TypeError {
  readonly code: EvaluationBundleValidationErrorCode;

  constructor(code: EvaluationBundleValidationErrorCode, message: string) {
    super(message);
    this.name = 'EvaluationBundleValidationError';
    this.code = code;
  }
}

export interface EvaluationBundlePlanContext
  extends ExecutionBundlePlanContext {
  evaluation: {
    evaluationPlanDigest: string;
    executionPlanDigest: string;
    evaluationInputDigest: string;
    samples: readonly {
      sampleId: string;
      input: unknown;
      executionContext?: unknown;
      expected?: unknown;
      evaluationContext?: unknown;
    }[];
    evaluators: readonly {
      evaluatorId: string;
      measurement: {
        instrumentId: string;
        ensembleMemberId: string;
        replicateGroupId: string;
        replicateIndex: number;
      };
      metricIds: readonly string[];
      inputs: readonly {
        bindingId: string;
        sourceKind: 'output' | 'trace' | 'expected' | 'evaluation-context' | 'execution-facts';
        pointer: string;
      }[];
    }[];
    metrics: readonly {
      metricId: string;
      valueType: MetricObservation['valueType'];
      scope: 'sample' | 'target' | 'comparison' | 'run';
      scale?: { min?: number; max?: number; target?: number };
    }[];
    runtimes: readonly {
      runtimeKind: 'executor' | 'evaluator' | 'analysis-node' | 'missing-policy' | 'decision-policy';
      referenceId: string;
      identity: EvaluationRuntimeIdentity;
    }[];
    policy: {
      evaluationCacheMode: 'disabled' | 'reuse';
      evidence: {
        evidence: 'full' | 'reference' | 'digest' | 'none';
        maximumClassification: 'public' | 'sensitive' | 'secret' | 'gold';
      };
      runtime: {
        retry: {
          maxAttempts: number;
          retryableErrorCodes: readonly string[];
        };
      };
      budget: {
        run: {
          maxInvocations?: number;
          maxProviderCost?: { amount: number; currency: string };
          maxActiveDurationMs?: number;
          maxWallClockMs?: number;
        };
        stages: {
          execution: {
            maxInvocations?: number;
            maxProviderCost?: { amount: number; currency: string };
            maxActiveDurationMs?: number;
          };
          evaluation: {
            maxInvocations?: number;
            maxProviderCost?: { amount: number; currency: string };
            maxActiveDurationMs?: number;
          };
        };
        coordinate: {
          maxInvocations?: number;
          maxProviderCost?: { amount: number; currency: string };
          maxActiveDurationMs?: number;
        };
        attempt: {
          maxProviderCost?: { amount: number; currency: string };
        };
        providerCostAdmission: {
          admissionMode: 'strict-reservation' | 'bounded-overshoot';
          unknownCostMode: 'fail-run' | 'mark-unverifiable';
        };
      };
    };
  };
  digests: ExecutionBundlePlanContext['digests'] & {
    evaluationInputDigest: string;
    evaluationPlanDigest: string;
  };
}

type DeepReadonlyValue<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonlyValue<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonlyValue<T[Key]> }
    : T;

export type EvaluationRuntimeIdentity = DeepReadonlyValue<RuntimeIdentity>;

export interface EvaluationBundleVerificationContext {
  /** Independently verified by a trusted cache boundary, never derived from the Bundle claim. */
  readonly verifiedCacheRecordDigests?: ReadonlySet<Sha256Digest>;
  /** Independently attested by the producing Runtime or a host trust verifier. */
  readonly verifiedProvenanceBundleDigests?: ReadonlySet<Sha256Digest>;
  /** Effective trust observed from the authenticated Execution source at production time. */
  readonly executionSourceTrust?: Provenance['trust'];
}

export interface EvaluationBundlePlanVerification {
  readonly provenanceTrustStatus: 'verified' | 'indeterminate';
  readonly executionSourceTrust: Provenance['trust'];
  readonly cacheReceiptStatus: 'verified' | 'indeterminate';
  readonly invocationBudgetStatus: 'verified' | 'indeterminate';
  readonly providerCostBudgetStatus: 'verified' | 'indeterminate';
  readonly minimumEvaluatorInvocations: number;
  readonly maximumEvaluatorInvocations: number;
  readonly minimumProviderCost?: { readonly amount: number; readonly currency: string };
  readonly maximumProviderCost?: { readonly amount: number; readonly currency: string };
  readonly unverifiedCacheRecordDigests: readonly Sha256Digest[];
}

declare const evaluationBundleSourceBrand: unique symbol;

export interface EvaluationBundleVerificationResult {
  readonly [evaluationBundleSourceBrand]: true;
  readonly bundle: EvaluationBundle;
  readonly planVerification: EvaluationBundlePlanVerification;
}

export type EvaluationBundleSource = EvaluationBundleVerificationResult;

export type EvaluationEvidencePolicy = EvaluationBundlePlanContext['evaluation']['policy']['evidence'];

export type BindingAvailability = 'available' | 'unavailable' | 'indeterminate';
export interface BindingClosure {
  availability: BindingAvailability;
  bindings?: readonly JsonValue[];
}
