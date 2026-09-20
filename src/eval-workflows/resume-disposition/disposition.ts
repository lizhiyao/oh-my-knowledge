import { TRUST_LEVEL, minimumTrust } from '../../eval-core/primitives/provenance.js';
import {
  EvaluationReportValidationError,
  digestCanonicalJson,
  parseWireDocument,
  type CoreSchemaValidator,
} from '../../eval-core/contracts/index.js';
import {  effectiveAnalysisBundleTrust,
  verifyAnalysisBundle,
} from '../../eval-core/verify/index.js';
import {  effectiveEvaluationBundleTrust,
  verifyEvaluationBundle,
} from '../../eval-core/verify/index.js';
import {  effectiveDecisionResultTrust,
  parseEvaluationReport,
  verifyDecisionResult,
} from '../../eval-core/verify/index.js';
import {  effectiveExecutionBundleTrust,
  verifyExecutionBundle,
} from '../../eval-core/verify/index.js';
import { assertSealedRunPlan } from '../../eval-core/compiler/index.js';
import {
  CoreRunArtifactStoreError,
  type CoreRunArtifactStore,
} from '../artifact-store/index.js';
import {
  CoreResumeDispositionError,
  CoreResumeDispositionPolicySchema,
  CoreResumeLocatorSchema,
  type AcceptedCoreResumeSource,
  type CoreResumeDispositionAdapter,
  type CoreResumeDispositionPolicy,
  type CoreResumeDispositionRequest,
  type CoreResumeDispositionResult,
  type CoreResumeRejectionReasonCode,
  type RejectedCoreResumeSource,
} from './contracts.js';


export interface CreateCoreResumeDispositionAdapterOptions {
  readonly artifactStore: CoreRunArtifactStore;
  readonly schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
}


function rejected(
  sourceRunId: string,
  reasonCode: CoreResumeRejectionReasonCode,
): RejectedCoreResumeSource {
  return Object.freeze({ disposition: 'start-fresh', sourceRunId, reasonCode });
}

function reject(
  sourceRunId: string,
  policy: CoreResumeDispositionPolicy,
  reasonCode: CoreResumeRejectionReasonCode,
  message: string,
): RejectedCoreResumeSource {
  if (policy.rejectionMode === 'fail-closed') {
    throw new CoreResumeDispositionError({
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

function dispositionDigest(input: Omit<AcceptedCoreResumeSource, 'disposition'
  | 'dispositionDigest' | 'artifacts' | 'executionSource' | 'evaluationSource'
  | 'analysisSource' | 'decisionSource' | 'report'> & {
    readonly artifacts: AcceptedCoreResumeSource['artifacts'];
    readonly policy: CoreResumeDispositionPolicy;
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

export function createCoreResumeDispositionAdapter(
  options: Readonly<CreateCoreResumeDispositionAdapterOptions>,
): CoreResumeDispositionAdapter {
  async function decide(
    request: Readonly<CoreResumeDispositionRequest>,
  ): Promise<CoreResumeDispositionResult> {
    const sourceRunId = typeof request?.locator?.runId === 'string'
      ? request.locator.runId
      : 'invalid-resume-source';
    const parsedPolicy = CoreResumeDispositionPolicySchema.safeParse(request?.policy);
    if (!parsedPolicy.success) {
      throw new CoreResumeDispositionError({
        code: 'CORE_RESUME_REQUEST_INVALID',
        sourceRunId,
        message: 'Core resume disposition policy is invalid.',
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
    ], 'verified');
    if (TRUST_LEVEL[upstreamSourceTrust]
        < TRUST_LEVEL[policy.minimumSourceTrust]) {
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_PROVENANCE_BELOW_POLICY',
        'Core resume source provenance is below the explicit disposition policy.',
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
    ], 'verified');
    if (TRUST_LEVEL[effectiveSourceTrust]
        < TRUST_LEVEL[policy.minimumSourceTrust]) {
      return reject(
        sourceRunId,
        policy,
        'CORE_RESUME_PROVENANCE_BELOW_POLICY',
        'Core resume Decision provenance is below the explicit disposition policy.',
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
    const digest = dispositionDigest({
      sourceRunId,
      artifacts,
      verification,
      policy,
    });
    return Object.freeze({
      disposition: 'reuse' as const,
      sourceRunId,
      dispositionDigest: digest,
      artifacts,
      executionSource,
      evaluationSource,
      analysisSource,
      ...(decisionSource === undefined ? {} : { decisionSource }),
      report,
      verification,
    });
  }

  return Object.freeze({ decide });
}
