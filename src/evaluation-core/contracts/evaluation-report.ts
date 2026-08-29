import {
  DecisionResultSchema,
  EvaluationReportSchema,
  type AnalysisBundle,
  type DecisionResult,
  type EvaluationBundle,
  type EvaluationReport,
  type ExecutionBundle,
  type EvaluationStatus,
} from './artifacts.js';
import type { Provenance } from './common.js';
import {
  parseAnalysisBundle,
  type AnalysisBundlePlanContext,
  type AnalysisBundleValidationContext,
} from './analysis-bundle.js';
import { digestArtifactPayload } from './digests.js';
import { parseEvaluationBundle } from './evaluation-bundle.js';
import { parseExecutionBundle } from './execution-bundle.js';
import { canonicalizeJson, digestCanonicalJson, parseWireDocument } from './json.js';

export type EvaluationReportValidationErrorCode =
  | 'DECISION_RESULT_DIGEST_MISMATCH'
  | 'DECISION_RESULT_PLAN_MISMATCH'
  | 'EVALUATION_REPORT_DIGEST_MISMATCH'
  | 'EVALUATION_REPORT_BUNDLE_REFERENCE_INVALID'
  | 'EVALUATION_REPORT_STATUS_INVALID'
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
  const { decisionDigest, ...payload } = result;
  if (digestCanonicalJson(payload) !== decisionDigest) {
    throw new EvaluationReportValidationError(
      'DECISION_RESULT_DIGEST_MISMATCH',
      'DecisionResult digest does not match its canonical payload.',
    );
  }
  return result;
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

function trustLevel(trust: Provenance['trust']): number {
  return { untrusted: 0, unknown: 1, declared: 2, verified: 3 }[trust];
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

function assertDecision(
  result: DecisionResult,
  plan: EvaluationReportPlanContext,
  analysis: AnalysisBundle,
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
}

export function parseEvaluationReport(
  value: unknown,
  plan: EvaluationReportPlanContext,
  executionValue: unknown,
  evaluationValue: unknown,
  analysisValue: unknown,
  validation: AnalysisBundleValidationContext,
): EvaluationReport {
  const execution = parseExecutionBundle(executionValue, plan);
  const evaluation = parseEvaluationBundle(evaluationValue, plan, execution);
  const analysis = parseAnalysisBundle(
    analysisValue,
    plan,
    execution,
    evaluation,
    validation,
  );
  const report = parseEvaluationReportDocument(value);
  assertBundleReferences(report, execution, evaluation, analysis);
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
  if (report.decision !== undefined) assertDecision(report.decision, plan, analysis);
  const parentDigests = [
    execution.bundleDigest,
    evaluation.bundleDigest,
    analysis.bundleDigest,
  ];
  if (report.decision !== undefined) parentDigests.push(report.decision.decisionDigest);
  const decisionRuntimeTrust = report.decision === undefined
    ? []
    : plan.decision.runtimes.flatMap((runtime) => {
      if (runtime.runtimeKind !== 'decision-policy') return [];
      const identity = runtime.identity;
      const assurance = identity !== null && typeof identity === 'object'
        ? (identity as Record<string, unknown>).assuranceLevel
        : undefined;
      return typeof assurance === 'string'
        && ['untrusted', 'unknown', 'declared', 'verified'].includes(assurance)
        ? [assurance as Provenance['trust']]
        : ['untrusted' as const];
    });
  if (canonicalizeJson(report.provenance.parentDigests)
      !== canonicalizeJson(parentDigests)
      || trustLevel(report.provenance.trust) > Math.min(
        trustLevel(execution.provenance.trust),
        trustLevel(evaluation.provenance.trust),
        trustLevel(analysis.provenance.trust),
        ...decisionRuntimeTrust.map(trustLevel),
      )) {
    throw new EvaluationReportValidationError(
      'EVALUATION_REPORT_PROVENANCE_INVALID',
      'EvaluationReport provenance must bind and cannot upgrade all source facts.',
    );
  }
  return report;
}
