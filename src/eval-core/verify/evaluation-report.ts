import {  assertAnalysisBundleSourceChain,
  assertAnalysisBundleSourceMatchesPlan,
  effectiveAnalysisBundleTrust,
} from './analysis-bundle.js';
import type {
  AnalysisBundleSource,} from '../contracts/analysis-bundle.js';
import {
  EvaluationReportSchema,
  type AnalysisBundle,
  type DecisionResult,
  type EvaluationBundle,
  type EvaluationReport,
  type EvaluationStatus,
  type ExecutionBundle,
} from '../contracts/artifacts.js';
import {
  Provenance,
} from '../contracts/common.js';
import {
  digestArtifactPayload,
} from '../contracts/digests.js';
import {  effectiveEvaluationBundleTrust,
} from './evaluation-bundle.js';
import type {
  EvaluationBundleSource,} from '../contracts/evaluation-bundle.js';
import {
  DecisionResultSource,
  DecisionResultVerificationContext,
  DecisionResultVerificationResult,
  EvaluationReportPlanContext,
  EvaluationReportValidationError,
  computeDecisionPolicyDigest,
  parseDecisionResultDocument,
} from '../contracts/evaluation-report.js';
import {  effectiveExecutionBundleTrust,
} from './execution-bundle.js';
import type {
  ExecutionBundleSource,} from '../contracts/execution-bundle.js';
import {
  canonicalizeJson,
  deepFreezeCanonicalJson,
  parseWireDocument,
  type Sha256Digest,
} from '../contracts/json.js';
import {
  TRUST_LEVEL,
  minimumTrust,
} from '../primitives/provenance.js';

const decisionResultSources = new WeakSet<object>();

export function assertDecisionResultSource(
  value: unknown,
): asserts value is DecisionResultSource {
  if (value === null || typeof value !== 'object' || !decisionResultSources.has(value)) {
    throw new TypeError(
      'Report stage requires a source returned by verifyDecisionResult() or the Runtime.',
    );
  }
}

export function effectiveDecisionResultTrust(
  source: DecisionResultSource,
): Provenance['trust'] {
  assertDecisionResultSource(source);
  const values: Provenance['trust'][] = [
    source.result.implementation.assuranceLevel,
    source.planVerification.analysisSourceTrust,
    source.planVerification.policyExecutionStatus === 'verified' ? 'verified' : 'unknown',
  ];
  return minimumTrust(values, 'verified');
}

export function assertDecisionResultSourceChain(
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  analysisSource: AnalysisBundleSource,
  decisionSource: DecisionResultSource,
): void {
  assertAnalysisBundleSourceChain(executionSource, evaluationSource, analysisSource);
  assertDecisionResultSource(decisionSource);
  if (decisionSource.result.analysisBundleDigest
      !== analysisSource.bundle.bundleDigest) {
    throw new EvaluationReportValidationError(
      'DECISION_RESULT_PLAN_MISMATCH',
      'Decision source is not bound to the supplied Analysis source.',
    );
  }
}

function assertBundleReferences(
  report: EvaluationReport,
  execution: ExecutionBundle,
  evaluation: EvaluationBundle,
  analysis: AnalysisBundle,
): void {
  const expected = [
    {
      bundleKind: 'execution' as const,
      schemaVersion: execution.schemaVersion,
      bundleDigest: execution.bundleDigest,
    },
    {
      bundleKind: 'evaluation' as const,
      schemaVersion: evaluation.schemaVersion,
      bundleDigest: evaluation.bundleDigest,
    },
    {
      bundleKind: 'analysis' as const,
      schemaVersion: analysis.schemaVersion,
      bundleDigest: analysis.bundleDigest,
    },
  ];
  const actual = report.bundles.map(({ bundleKind, schemaVersion, bundleDigest }) => ({
    bundleKind,
    schemaVersion,
    bundleDigest,
  }));
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    throw new EvaluationReportValidationError(
      'EVALUATION_REPORT_BUNDLE_REFERENCE_INVALID',
      'EvaluationReport must reference the exact canonical source Bundle set.',
    );
  }
}

export function deriveEvaluationStatus(input: {
  execution: ExecutionBundle;
  evaluation: EvaluationBundle;
  analysis: AnalysisBundle;
  decision?: DecisionResult;
}): EvaluationStatus {
  const statuses = [
    input.execution.executionBundleStatus,
    input.evaluation.evaluationBundleStatus,
    input.analysis.analysisBundleStatus,
  ];
  const runStatus: EvaluationStatus['runStatus'] = statuses.includes('failed')
    || input.decision?.decisionStatus === 'failed'
    ? 'failed'
    : statuses.includes('cancelled')
      ? 'cancelled'
      : statuses.includes('budget-exhausted')
        ? 'budget-exhausted'
        : 'completed';
  const observationCoverage = input.analysis.records.map((record) => record.coverage);
  const unresolvable = input.execution.replayability === 'summary-only'
    || input.evaluation.replayability === 'summary-only'
    || observationCoverage.some((coverage) => coverage.sourceUnavailable > 0);
  const partial = runStatus !== 'completed'
    || observationCoverage.some((coverage) => (
      coverage.missing > 0
      || coverage.invalid > 0
      || coverage.evaluationFailed > 0
      || coverage.notStarted > 0
      || coverage.censored > 0
    ))
    || input.analysis.coverage.inconclusive > 0
    || input.analysis.coverage.notStarted > 0;
  const evidenceStatus: EvaluationStatus['evidenceStatus'] = unresolvable
    ? 'unresolvable'
    : partial ? 'partial' : 'complete';
  const conclusionStatus: EvaluationStatus['conclusionStatus'] = input.decision === undefined
    ? 'not-evaluated'
    : input.decision.decisionStatus === 'decided' ? 'conclusive' : 'inconclusive';
  return { runStatus, evidenceStatus, conclusionStatus };
}

export function parseEvaluationReportDocument(value: unknown): EvaluationReport {
  const report = parseWireDocument(EvaluationReportSchema, value);
  if (report.decision !== undefined) parseDecisionResultDocument(report.decision);
  if (digestArtifactPayload(report, 'reportDigest') !== report.reportDigest) {
    throw new EvaluationReportValidationError(
      'EVALUATION_REPORT_DIGEST_MISMATCH',
      'EvaluationReport digest does not match its canonical payload.',
    );
  }
  return report;
}

function assertDecision(
  result: DecisionResult,
  plan: EvaluationReportPlanContext,
  analysis: AnalysisBundle,
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  analysisSource: AnalysisBundleSource,
  decisionSource: DecisionResultSource,
): void {
  const policy = plan.decision.decisionPolicy;
  const runtime = plan.decision.runtimes.find((candidate) => (
    candidate.runtimeKind === 'decision-policy'
    && candidate.referenceId === policy?.decisionPolicyId
  ));
  if (policy === undefined
      || runtime === undefined
      || result.decisionPolicyId !== policy.decisionPolicyId
      || result.analysisBundleDigest !== analysis.bundleDigest
      || result.decisionPlanDigest !== plan.decision.decisionPlanDigest
      || canonicalizeJson(result.implementation) !== canonicalizeJson(runtime.identity)
      || canonicalizeJson(result.analysisResultIds)
        !== canonicalizeJson([...policy.analysisResultIds].sort())) {
    throw new EvaluationReportValidationError(
      'DECISION_RESULT_PLAN_MISMATCH',
      'DecisionResult does not match its sealed DecisionPlan and AnalysisBundle.',
    );
  }
  const expectedPolicyDigest = computeDecisionPolicyDigest({
    decisionPlanDigest: plan.decision.decisionPlanDigest,
    policy,
    runtime: runtime.identity,
  });
  if (result.policyDigest !== expectedPolicyDigest) {
    throw new EvaluationReportValidationError(
      'DECISION_RESULT_PLAN_MISMATCH',
      'DecisionResult policy digest does not match the sealed policy.',
    );
  }
  if (result.decisionStatus === 'decided'
      && (Object.values(executionSource.planVerification).includes('indeterminate')
        || Object.values(evaluationSource.planVerification).includes('indeterminate')
        || Object.values(analysisSource.planVerification).includes('indeterminate')
        || Object.values(decisionSource.planVerification).includes('indeterminate'))) {
    throw new EvaluationReportValidationError(
      'DECISION_RESULT_VERIFICATION_GATE_FAILED',
      'A directional DecisionResult requires conclusive source verification.',
    );
  }
}

export function verifyDecisionResult(
  value: unknown,
  plan: EvaluationReportPlanContext,
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  analysisSource: AnalysisBundleSource,
  verification?: DecisionResultVerificationContext,
): DecisionResultSource {
  assertAnalysisBundleSourceMatchesPlan(
    plan,
    executionSource,
    evaluationSource,
    analysisSource,
  );
  const result = parseDecisionResultDocument(value);
  const provisional = {
    result,
    planVerification: {
      policyExecutionStatus: verification?.verifiedPolicyExecutionDigests?.has(
        result.decisionDigest as Sha256Digest,
      ) === true
        ? 'verified' as const
        : 'indeterminate' as const,
      analysisSourceTrust: verification?.analysisSourceTrust
        ?? effectiveAnalysisBundleTrust(analysisSource),
    },
  } as DecisionResultVerificationResult;
  decisionResultSources.add(provisional);
  const source = deepFreezeCanonicalJson(provisional);
  assertDecision(
    result,
    plan,
    analysisSource.bundle,
    executionSource,
    evaluationSource,
    analysisSource,
    source,
  );
  return source;
}

export function parseEvaluationReport(
  value: unknown,
  plan: EvaluationReportPlanContext,
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  analysisSource: AnalysisBundleSource,
  decisionSource: DecisionResultSource | undefined,
): EvaluationReport {
  assertAnalysisBundleSourceMatchesPlan(
    plan,
    executionSource,
    evaluationSource,
    analysisSource,
  );
  const execution = executionSource.bundle;
  const evaluation = evaluationSource.bundle;
  const analysis = analysisSource.bundle;
  const report = parseEvaluationReportDocument(value);
  if (report.runContractDigest !== plan.digests.runContractDigest) {
    throw new EvaluationReportValidationError(
      'EVALUATION_REPORT_PLAN_MISMATCH',
      'EvaluationReport does not match the current RunContract.',
    );
  }
  if ((report.decision === undefined) !== (decisionSource === undefined)) {
    throw new EvaluationReportValidationError(
      'DECISION_RESULT_PLAN_MISMATCH',
      'EvaluationReport decision presence must match its Decision source.',
    );
  }
  if (decisionSource !== undefined) {
    assertDecisionResultSourceChain(
      executionSource,
      evaluationSource,
      analysisSource,
      decisionSource,
    );
    if (canonicalizeJson(report.decision) !== canonicalizeJson(decisionSource.result)) {
      throw new EvaluationReportValidationError(
        'DECISION_RESULT_PLAN_MISMATCH',
        'EvaluationReport decision must equal its authenticated Decision source.',
      );
    }
  }
  assertBundleReferences(report, execution, evaluation, analysis);
  if (canonicalizeJson(report.budgetSummary)
      !== canonicalizeJson(evaluation.budgetSummary)) {
    throw new EvaluationReportValidationError(
      'EVALUATION_REPORT_BUDGET_SUMMARY_INVALID',
      'EvaluationReport must retain the final authenticated Run budget summary.',
    );
  }
  const expectedStatus = deriveEvaluationStatus({
    execution,
    evaluation,
    analysis,
    ...(report.decision !== undefined ? { decision: report.decision } : {}),
  });
  if (canonicalizeJson(report.status) !== canonicalizeJson(expectedStatus)) {
    throw new EvaluationReportValidationError(
      'EVALUATION_REPORT_STATUS_INVALID',
      'EvaluationReport status does not match its source facts and decision.',
    );
  }
  if (report.decision !== undefined) {
    assertDecision(
      report.decision,
      plan,
      analysis,
      executionSource,
      evaluationSource,
      analysisSource,
      decisionSource as DecisionResultSource,
    );
  }
  const parentDigests = [
    execution.bundleDigest,
    evaluation.bundleDigest,
    analysis.bundleDigest,
  ];
  if (report.decision !== undefined) parentDigests.push(report.decision.decisionDigest);
  const decisionTrust = decisionSource === undefined
    ? []
    : [effectiveDecisionResultTrust(decisionSource)];
  if (canonicalizeJson(report.provenance.parentDigests)
      !== canonicalizeJson(parentDigests)
      || TRUST_LEVEL[report.provenance.trust] > Math.min(
        TRUST_LEVEL[effectiveExecutionBundleTrust(executionSource)],
        TRUST_LEVEL[effectiveEvaluationBundleTrust(evaluationSource)],
        TRUST_LEVEL[effectiveAnalysisBundleTrust(analysisSource)],
        ...decisionTrust.map((trust) => TRUST_LEVEL[trust]),
      )) {
    throw new EvaluationReportValidationError(
      'EVALUATION_REPORT_PROVENANCE_INVALID',
      'EvaluationReport provenance must bind and cannot upgrade all source facts.',
    );
  }
  return report;
}
