import {
  canonicalizeJson,
  parseEvaluationSeriesPlan,
  parseEvaluationSeriesReportDocument,
  parseSeriesAnalysisBundleDocument,
  type EvaluationSeriesPlan,
  type EvaluationSeriesReport,
  type SeriesAnalysisBundle,
} from '../../eval-core/contracts/index.js';
import {
  CORE_EVOLUTION_EVIDENCE_SCHEMA_VERSION,
  CoreDownstreamProjectionError,
  type CoreEvolutionAnalysisEvidence,
  type CoreEvolutionEvidence,
} from './contracts.js';
import { projectCoreDecision } from './decision.js';

export interface ProjectCoreEvolutionEvidenceInput {
  readonly plan: Readonly<EvaluationSeriesPlan>;
  readonly analysis: Readonly<SeriesAnalysisBundle>;
  readonly report: Readonly<EvaluationSeriesReport>;
}

function fail(): never {
  throw new CoreDownstreamProjectionError(
    'CORE_SERIES_SOURCE_INVALID',
    'Evolution projection requires one exact Evaluation Series Plan, Analysis Bundle, and Report chain.',
  );
}

/**
 * Project immutable cross-run evidence for authoring/evolve consumers. The
 * Series contract keeps `run` as the experimental unit; this view never ranks
 * members or invents a winner outside the registered Decision result.
 */
export function projectCoreEvolutionEvidence(
  input: Readonly<ProjectCoreEvolutionEvidenceInput>,
): CoreEvolutionEvidence {
  let plan: EvaluationSeriesPlan;
  let analysis: SeriesAnalysisBundle;
  let report: EvaluationSeriesReport;
  try {
    plan = parseEvaluationSeriesPlan(input.plan);
    analysis = parseSeriesAnalysisBundleDocument(input.analysis);
    report = parseEvaluationSeriesReportDocument(input.report);
  } catch {
    fail();
  }
  if (analysis.seriesPlanDigest !== plan.seriesPlanDigest
      || report.seriesPlanDigest !== plan.seriesPlanDigest
      || report.analysisBundleDigest !== analysis.bundleDigest
      || analysis.coverage.planned !== plan.definition.members.length) {
    fail();
  }

  const slots = new Map(plan.definition.members.map((member) => [member.memberId, member]));
  if (analysis.members.some((member) => {
    const slot = slots.get(member.memberId);
    return slot === undefined
      || slot.replicateIndex !== member.replicateIndex
      || (slot.expectedRunContractDigest !== undefined
        && slot.expectedRunContractDigest !== member.runContractDigest);
  })) {
    fail();
  }
  const nodeById = new Map(plan.definition.analysisGraph.nodes.map((node) => [node.nodeId, node]));
  if (analysis.records.length !== nodeById.size
      || analysis.records.some((record) => {
        const node = nodeById.get(record.nodeId);
        const runtime = plan.runtimes.find((entry) => entry.referenceId === record.nodeId);
        if (node === undefined || runtime?.runtimeKind !== 'series-analysis-node') return true;
        return node.outputResultId !== record.resultId
          || node.analysisStandardId !== record.analysisStandardId
          || node.implementationId !== record.implementation.implementationId
          || canonicalizeJson(runtime.identity) !== canonicalizeJson(record.implementation)
          || canonicalizeJson(runtime.outputSchema) !== canonicalizeJson(record.outputSchema)
          || record.analysisMode !== plan.definition.analysisMode;
      })) {
    fail();
  }
  const policy = plan.definition.decisionPolicy;
  const decisionRuntime = plan.runtimes.find((entry) => (
    entry.runtimeKind === 'series-decision-policy'
      && entry.referenceId === policy?.decisionPolicyId
  ));
  if ((policy === undefined) !== (report.decision === undefined)
      || (policy !== undefined && report.decision !== undefined
        && (decisionRuntime === undefined
          || policy.decisionPolicyId !== report.decision.decisionPolicyId
          || policy.implementationId !== report.decision.implementation.implementationId
          || canonicalizeJson(decisionRuntime.identity)
            !== canonicalizeJson(report.decision.implementation)
          || policy.analysisResultIds.length !== report.decision.analysisResultIds.length
          || policy.analysisResultIds.some((resultId, index) => (
            resultId !== report.decision?.analysisResultIds[index]
          ))
          || report.decision.analysisResultIds.some((resultId) => (
            !analysis.records.some((record) => record.resultId === resultId)
          ))))) {
    fail();
  }

  const comparability = new Map(analysis.comparability.map((entry) => [
    entry.memberId,
    entry.assessment.comparabilityStatus,
  ]));
  const anchorId = analysis.comparability[0]?.anchorMemberId
    ?? analysis.members[0]?.memberId;
  const members = analysis.members.map((member) => ({
    memberId: member.memberId,
    replicateIndex: member.replicateIndex,
    reportDigest: member.reportDigest,
    runContractDigest: member.runContractDigest,
    status: member.status,
    effectiveTrust: member.effectiveTrust,
    comparabilityStatus: member.memberId === anchorId
      ? 'anchor' as const
      : comparability.get(member.memberId) ?? 'incompatible' as const,
  }));
  const analyses: CoreEvolutionAnalysisEvidence[] = analysis.records.map((record) => {
    const base = {
      resultId: record.resultId,
      nodeId: record.nodeId,
      analysisStandardId: record.analysisStandardId,
      memberIds: [...record.memberIds],
      coverage: record.coverage,
      assumptionChecks: record.assumptionChecks.map((check) => ({
        assumptionId: check.assumptionId,
        checkStatus: check.checkStatus,
        ...(check.reasonCode === undefined ? {} : { reasonCode: check.reasonCode }),
      })),
      recordDigest: record.recordDigest,
    };
    if (record.analysisStatus === 'completed') {
      return {
        ...base,
        analysisStatus: record.analysisStatus,
        resultType: record.resultType,
        value: record.value,
      };
    }
    if (record.analysisStatus === 'inconclusive') {
      return {
        ...base,
        analysisStatus: record.analysisStatus,
        reasonCodes: [...record.reasonCodes],
      };
    }
    return {
      ...base,
      analysisStatus: record.analysisStatus,
      errorCode: record.error.code,
    };
  });
  const decision = projectCoreDecision(report.decision);
  const evidenceReadiness = decision?.decisionStatus === 'decided'
    ? 'decision-ready'
    : analyses.some((record) => record.analysisStatus === 'completed')
      ? 'analysis-only'
      : 'insufficient';

  return {
    projectionKind: 'core-evolution-evidence',
    schemaVersion: CORE_EVOLUTION_EVIDENCE_SCHEMA_VERSION,
    seriesId: plan.definition.seriesId,
    seriesPlanDigest: plan.seriesPlanDigest,
    analysisBundleDigest: analysis.bundleDigest,
    reportDigest: report.reportDigest,
    analysisMode: plan.definition.analysisMode,
    experimentalUnit: plan.definition.experimentalUnit,
    evidenceReadiness,
    coverage: analysis.coverage,
    members,
    analyses,
    ...(decision === undefined ? {} : { decision }),
  };
}
