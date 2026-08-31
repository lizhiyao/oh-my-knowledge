import {
  EvaluationReportValidationError,
  digestCanonicalJson,
  effectiveAnalysisBundleTrust,
  effectiveDecisionResultTrust,
  effectiveEvaluationBundleTrust,
  effectiveExecutionBundleTrust,
  parseEvaluationReport,
  parseWireDocument,
  verifyAnalysisBundle,
  verifyDecisionResult,
  verifyEvaluationBundle,
  verifyExecutionBundle,
  type CoreSchemaValidator,
  type Provenance,
} from '../../evaluation-core/contracts/index.js';
import { assertSealedRunPlan } from '../../evaluation-core/compiler/index.js';
import {
  CoreRunArtifactStoreError,
  type CoreRunArtifactStore,
} from '../artifact-store/index.js';
import {
  CoreResumeAdmissionError,
  CoreResumeAdmissionPolicySchema,
  CoreResumeLocatorSchema,
  type AdmittedCoreResumeSource,
  type CoreResumeAdmissionAdapter,
  type CoreResumeAdmissionPolicy,
  type CoreResumeAdmissionRequest,
  type CoreResumeAdmissionResult,
  type CoreResumeRejectionReasonCode,
  type RejectedCoreResumeSource,
} from './contracts.js';

const TRUST_RANK: Record<Provenance['trust'], number> = {
  untrusted: 0,
  unknown: 1,
  declared: 2,
  verified: 3,
};

export interface CreateCoreResumeAdmissionAdapterOptions {
  readonly artifactStore: CoreRunArtifactStore;
  readonly schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
}

function minimumTrust(values: readonly Provenance['trust'][]): Provenance['trust'] {
  return values.reduce((minimum, value) => (
    TRUST_RANK[value] < TRUST_RANK[minimum] ? value : minimum
  ), 'verified');
}

function rejected(
  sourceRunId: string,
  reasonCode: CoreResumeRejectionReasonCode,
): RejectedCoreResumeSource {
  return Object.freeze({ disposition: 'start-fresh', sourceRunId, reasonCode });
}

function reject(
  sourceRunId: string,
  policy: CoreResumeAdmissionPolicy,
  reasonCode: CoreResumeRejectionReasonCode,
  message: string,
): RejectedCoreResumeSource {
  if (policy.rejectionMode === 'fail-closed') {
    throw new CoreResumeAdmissionError({
      code: reasonCode,
      sourceRunId,
      message,
    });
  }
  return rejected(sourceRunId, reasonCode);
}

function isComplete(input: {
  executionBundleStatus: string;
  evaluationBundleStatus: string;
  analysisBundleStatus: string;
  reportStatus: {
    runStatus: string;
    evidenceStatus: string;
  };
}): boolean {
  return input.executionBundleStatus === 'completed'
    && input.evaluationBundleStatus === 'completed'
    && input.analysisBundleStatus === 'completed'
    && input.reportStatus.runStatus === 'completed'
    && input.reportStatus.evidenceStatus === 'complete';
}

function admissionDigest(input: Omit<AdmittedCoreResumeSource, 'disposition'
  | 'admissionDigest' | 'artifacts' | 'executionSource' | 'evaluationSource'
  | 'analysisSource' | 'decisionSource' | 'report'> & {
    readonly artifacts: AdmittedCoreResumeSource['artifacts'];
    readonly policy: CoreResumeAdmissionPolicy;
  }): string {
  return digestCanonicalJson({
    derivation: 'omk.core-resume-admission/v1',
    sourceRunId: input.sourceRunId,
    runContractDigest: input.artifacts.plan.digests.runContractDigest,
    executionBundleDigest: input.artifacts.execution.bundleDigest,
    evaluationBundleDigest: input.artifacts.evaluation.bundleDigest,
    analysisBundleDigest: input.artifacts.analysis.bundleDigest,
    reportDigest: input.artifacts.report.reportDigest,
    verification: input.verification,
    policy: input.policy,
  });
}

export function createCoreResumeAdmissionAdapter(
  options: Readonly<CreateCoreResumeAdmissionAdapterOptions>,
): CoreResumeAdmissionAdapter {
  async function admit(
    request: Readonly<CoreResumeAdmissionRequest>,
  ): Promise<CoreResumeAdmissionResult> {
    const sourceRunId = typeof request?.locator?.runId === 'string'
      ? request.locator.runId
      : 'invalid-resume-source';
    const parsedPolicy = CoreResumeAdmissionPolicySchema.safeParse(request?.policy);
    if (!parsedPolicy.success) {
      throw new CoreResumeAdmissionError({
        code: 'CORE_RESUME_REQUEST_INVALID',
        sourceRunId,
        message: 'Core resume admission policy is invalid.',
      });
    }
    const policy = parsedPolicy.data;
    try {
      parseWireDocument(CoreResumeLocatorSchema, request.locator);
      assertSealedRunPlan(request.plan);
    } catch {
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_REQUEST_INVALID',
        'Core resume locator or sealed Plan capability is invalid.',
      );
    }

    let artifacts;
    try {
      artifacts = await options.artifactStore.get(sourceRunId);
    } catch (error: unknown) {
      if (error instanceof CoreRunArtifactStoreError
          && (error.code === 'CORE_RUN_ARTIFACT_CONTENT_RESOLVER_REQUIRED'
            || error.code === 'CORE_RUN_ARTIFACT_CONTENT_INVALID')) {
        return reject(
          sourceRunId,
          policy,
          'CORE_RESUME_EVIDENCE_UNAVAILABLE',
          'Core resume source evidence is unavailable or invalid.',
        );
      }
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_SOURCE_INVALID',
        'Core resume source cannot be loaded and verified.',
      );
    }
    if (artifacts === undefined) {
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_SOURCE_NOT_FOUND',
        'Core resume source was not found.',
      );
    }
    if (artifacts.plan.digests.runContractDigest
        !== request.plan.digests.runContractDigest) {
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_CONTRACT_MISMATCH',
        'Core resume source does not match the freshly sealed RunContract.',
      );
    }
    if (!isComplete({
      executionBundleStatus: artifacts.execution.executionBundleStatus,
      evaluationBundleStatus: artifacts.evaluation.evaluationBundleStatus,
      analysisBundleStatus: artifacts.analysis.analysisBundleStatus,
      reportStatus: artifacts.report.status,
    })) {
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_SOURCE_INCOMPLETE',
        'Core resume requires a completed run with complete evidence.',
      );
    }

    let executionSource;
    let evaluationSource;
    let analysisSource;
    try {
      executionSource = verifyExecutionBundle(
        artifacts.execution,
        request.plan,
        request.verification?.execution,
      );
      evaluationSource = verifyEvaluationBundle(
        artifacts.evaluation,
        request.plan,
        executionSource,
        request.verification?.evaluation,
      );
      analysisSource = verifyAnalysisBundle(
        artifacts.analysis,
        request.plan,
        executionSource,
        evaluationSource,
        { schemaValidators: options.schemaValidators },
        request.verification?.analysis,
      );
    } catch {
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_SOURCE_INVALID',
        'Core resume source failed plan-aware verification.',
      );
    }

    if (policy.cacheReceiptMode === 'require-verified'
        && (executionSource.planVerification.cacheReceiptStatus !== 'verified'
          || evaluationSource.planVerification.cacheReceiptStatus !== 'verified')) {
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_CACHE_RECEIPT_INDETERMINATE',
        'Core resume source contains cache lineage without verified receipts.',
      );
    }
    if (policy.budgetVerificationMode === 'require-verified'
        && (executionSource.planVerification.invocationBudgetStatus !== 'verified'
          || executionSource.planVerification.providerCostBudgetStatus !== 'verified'
          || evaluationSource.planVerification.invocationBudgetStatus !== 'verified'
          || evaluationSource.planVerification.providerCostBudgetStatus !== 'verified')) {
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_BUDGET_INDETERMINATE',
        'Core resume source has indeterminate invocation or provider-cost accounting.',
      );
    }

    const upstreamSourceTrust = minimumTrust([
      effectiveExecutionBundleTrust(executionSource),
      effectiveEvaluationBundleTrust(evaluationSource),
      effectiveAnalysisBundleTrust(analysisSource),
      artifacts.report.provenance.trust,
    ]);
    if (TRUST_RANK[upstreamSourceTrust]
        < TRUST_RANK[policy.minimumSourceTrust]) {
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_PROVENANCE_BELOW_POLICY',
        'Core resume source provenance is below the explicit admission policy.',
      );
    }

    let decisionSource;
    let report;
    try {
      decisionSource = artifacts.report.decision === undefined
        ? undefined
        : verifyDecisionResult(
          artifacts.report.decision,
          request.plan,
          executionSource,
          evaluationSource,
          analysisSource,
          request.verification?.decision,
        );
      report = parseEvaluationReport(
        artifacts.report,
        request.plan,
        executionSource,
        evaluationSource,
        analysisSource,
        decisionSource,
      );
    } catch (error: unknown) {
      if (error instanceof EvaluationReportValidationError
          && error.code === 'DECISION_RESULT_VERIFICATION_GATE_FAILED') {
        return reject(
          sourceRunId,
          policy,
          'CORE_RESUME_VERIFICATION_INDETERMINATE',
          'Core resume Decision requires verification facts not established by the host.',
        );
      }
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_SOURCE_INVALID',
        'Core resume Decision or Report failed plan-aware verification.',
      );
    }
    const effectiveSourceTrust = minimumTrust([
      upstreamSourceTrust,
      ...(decisionSource === undefined ? [] : [effectiveDecisionResultTrust(decisionSource)]),
    ]);
    if (TRUST_RANK[effectiveSourceTrust]
        < TRUST_RANK[policy.minimumSourceTrust]) {
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_PROVENANCE_BELOW_POLICY',
        'Core resume Decision provenance is below the explicit admission policy.',
      );
    }

    const verification = Object.freeze({
      execution: executionSource.planVerification,
      evaluation: evaluationSource.planVerification,
      analysis: analysisSource.planVerification,
      ...(decisionSource === undefined
        ? {}
        : { decision: decisionSource.planVerification }),
      effectiveSourceTrust,
    });
    const digest = admissionDigest({
      sourceRunId,
      artifacts,
      verification,
      policy,
    });
    return Object.freeze({
      disposition: 'reuse' as const,
      sourceRunId,
      admissionDigest: digest,
      artifacts,
      executionSource,
      evaluationSource,
      analysisSource,
      ...(decisionSource === undefined ? {} : { decisionSource }),
      report,
      verification,
    });
  }

  return Object.freeze({ admit });
}
