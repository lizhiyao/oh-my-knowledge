


import type {
  ExecutionBundle,} from './artifacts.js';
import {
  RuntimeIdentity,
} from './common.js';

import type {
  ExecutionIdentityPlanContext,} from './execution-identities.js';

import type {
  Sha256Digest,} from './json.js';

export type ExecutionBundleValidationErrorCode =
  | 'EXECUTION_BUNDLE_DUPLICATE_COORDINATE'
  | 'EXECUTION_BUNDLE_IDENTITY_MISMATCH'
  | 'EXECUTION_BUNDLE_RANDOMIZATION_SLOT_INVALID'
  | 'EXECUTION_BUNDLE_RECORD_ORDER_INVALID'
  | 'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID'
  | 'EXECUTION_BUNDLE_BLOCK_ATOMICITY_INVALID'
  | 'EXECUTION_BUNDLE_COVERAGE_INVALID'
  | 'EXECUTION_BUNDLE_STATUS_INVALID'
  | 'EXECUTION_BUNDLE_REPLAYABILITY_INVALID'
  | 'EXECUTION_BUNDLE_EVIDENCE_POLICY_INVALID'
  | 'EXECUTION_BUNDLE_USAGE_INVALID'
  | 'EXECUTION_BUNDLE_BUDGET_SUMMARY_INVALID'
  | 'EXECUTION_BUNDLE_CACHE_POLICY_INVALID'
  | 'EXECUTION_BUNDLE_PROVIDER_COST_INVALID'
  | 'EXECUTION_BUNDLE_PROVENANCE_INVALID'
  | 'EXECUTION_BUNDLE_DIGEST_MISMATCH'
  | 'EXECUTION_BUNDLE_PLAN_MISMATCH'
  | 'EXECUTION_BUNDLE_RETRY_POLICY_INVALID';

export class ExecutionBundleValidationError extends TypeError {
  readonly code: ExecutionBundleValidationErrorCode;

  constructor(code: ExecutionBundleValidationErrorCode, message: string) {
    super(message);
    this.name = 'ExecutionBundleValidationError';
    this.code = code;
  }
}

export interface ExecutionBundlePlanContext extends ExecutionIdentityPlanContext {
  execution: ExecutionIdentityPlanContext['execution'] & {
    executionInputDigest: string;
    runtimes: readonly {
      runtimeKind: 'executor' | 'evaluator' | 'analysis-node' | 'missing-policy' | 'decision-policy';
      referenceId: string;
      identity: ExecutionRuntimeIdentity;
    }[];
    policy: {
      executionCacheMode: 'disabled' | 'replay-only' | 'transparent-deterministic';
      retry: {
        maxAttempts: number;
        retryableErrorCodes: readonly string[];
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
      evidence: {
        output: 'full' | 'reference' | 'digest' | 'none';
        trace: 'full' | 'reference' | 'digest' | 'none';
        maximumClassification: 'public' | 'sensitive' | 'secret' | 'gold';
      };
    };
  };
  digests: {
    datasetRevisionDigest: string;
    executionInputDigest: string;
    executionPlanDigest: string;
    runContractDigest: string;
  };
}

type DeepReadonlyValue<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonlyValue<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonlyValue<T[Key]> }
    : T;

export type ExecutionRuntimeIdentity = DeepReadonlyValue<RuntimeIdentity>;

export interface ExecutionBundleVerificationContext {
  /** Independently verified by a trusted cache boundary, never derived from the Bundle claim. */
  readonly verifiedCacheRecordDigests?: ReadonlySet<Sha256Digest>;
  /** Independently attested by the producing Runtime or a host trust verifier. */
  readonly verifiedProvenanceBundleDigests?: ReadonlySet<Sha256Digest>;
}

export interface ExecutionBundlePlanVerification {
  readonly provenanceTrustStatus: 'verified' | 'indeterminate';
  readonly cacheReceiptStatus: 'verified' | 'indeterminate';
  readonly invocationBudgetStatus: 'verified' | 'indeterminate';
  readonly providerCostBudgetStatus: 'verified' | 'indeterminate';
  readonly minimumTargetInvocations: number;
  readonly maximumTargetInvocations: number;
  readonly minimumProviderCost?: { readonly amount: number; readonly currency: string };
  readonly maximumProviderCost?: { readonly amount: number; readonly currency: string };
  readonly unverifiedCacheRecordDigests: readonly Sha256Digest[];
}

declare const executionBundleSourceBrand: unique symbol;

export interface ExecutionBundleVerificationResult {
  readonly [executionBundleSourceBrand]: true;
  readonly bundle: ExecutionBundle;
  readonly planVerification: ExecutionBundlePlanVerification;
}

export type ExecutionBundleSource = ExecutionBundleVerificationResult;

export type ExecutionEvidencePolicy = ExecutionBundlePlanContext['execution']['policy']['evidence'];
