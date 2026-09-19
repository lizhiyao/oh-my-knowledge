import {  effectiveAnalysisBundleTrust,
} from './analysis-bundle.js';
import type {
  AnalysisBundleSource,} from '../contracts/analysis-bundle.js';
import {
  parseComparabilityAssessmentDocument,
} from '../contracts/comparability.js';
import {  effectiveEvaluationBundleTrust,
} from './evaluation-bundle.js';
import type {
  EvaluationBundleSource,} from '../contracts/evaluation-bundle.js';
import {  assertDecisionResultSourceChain,
  effectiveDecisionResultTrust,
  parseEvaluationReport,
} from './evaluation-report.js';
import type {
  DecisionResultSource,
  EvaluationReportPlanContext,} from '../contracts/evaluation-report.js';
import {  effectiveExecutionBundleTrust,
} from './execution-bundle.js';
import type {
  ExecutionBundleSource,} from '../contracts/execution-bundle.js';
import {
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseWireDocument,
  type JsonValue,
  type Sha256Digest,
} from '../contracts/json.js';
import {
  assertSealedRunPlan,
  type SealedRunPlan,
} from '../contracts/sealed-run-plan.js';
import {
  EVALUATION_SERIES_PLAN_SCHEMA_VERSION,
  EvaluationSeriesDefinitionSchema,
  EvaluationSeriesMemberSource,
  EvaluationSeriesPlan,
  EvaluationSeriesPlanSchema,
  EvaluationSeriesReport,
  EvaluationSeriesReportSchema,
  SeriesAnalysisBundle,
  SeriesAnalysisBundleSchema,
  SeriesMemberCoverage,
  SeriesMemberReference,
  SeriesMemberReferenceSchema,
  SeriesResolvedRuntimeSchema,
  assertSeriesGraph,
  assertUniqueMembers,
  compareMembers,
  normalizeSeriesDecisionPolicy,
  normalizeSeriesNode,
  seriesDesignPayload,
} from '../contracts/series.js';
import {
  compareStrings,
} from '../primitives/ordering.js';
import {
  TRUST_LEVEL,
  minimumTrust,
} from '../primitives/provenance.js';
import {
  z,
} from 'zod';

export function prepareEvaluationSeriesPlan(
  definitionInput: unknown,
  runtimesInput: unknown,
): EvaluationSeriesPlan {
  const definition = parseWireDocument(EvaluationSeriesDefinitionSchema, definitionInput);
  const runtimes = parseWireDocument(z.array(SeriesResolvedRuntimeSchema), runtimesInput);
  assertUniqueMembers(definition.members);
  if (digestCanonicalJson(seriesDesignPayload(definition)) !== definition.seriesDesignDigest) {
    throw new TypeError('EvaluationSeriesDefinition design digest is invalid.');
  }
  if (definition.analysisMode === 'preregistered'
      && definition.members.some((member) => member.expectedRunContractDigest !== undefined)) {
    throw new TypeError(
      'Preregistered Series slots cannot depend on post-execution Run contract digests.',
    );
  }
  const members = [...definition.members].sort(compareMembers);
  const nodes = [...definition.analysisGraph.nodes]
    .map(normalizeSeriesNode)
    .sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length
      || new Set(nodes.map((node) => node.outputResultId)).size !== nodes.length) {
    throw new TypeError('Series analysis nodes require unique node and result identifiers.');
  }
  assertSeriesGraph(definition.seriesId, nodes);
  const required = new Set(nodes.map((node) => `series-analysis-node\u0000${node.nodeId}`));
  if (definition.decisionPolicy !== undefined) {
    if (new Set(definition.decisionPolicy.analysisResultIds).size
        !== definition.decisionPolicy.analysisResultIds.length) {
      throw new TypeError('Series decision policy requires unique analysis results.');
    }
    required.add(`series-decision-policy\u0000${definition.decisionPolicy.decisionPolicyId}`);
    for (const resultId of definition.decisionPolicy.analysisResultIds) {
      if (!nodes.some((node) => node.outputResultId === resultId)) {
        throw new TypeError('Series decision policy references an unknown analysis result.');
      }
    }
  }
  const runtimeKeys = runtimes.map((runtime) => `${runtime.runtimeKind}\u0000${runtime.referenceId}`);
  if (new Set(runtimeKeys).size !== runtimes.length
      || runtimeKeys.some((key) => !required.has(key))
      || [...required].some((key) => !runtimeKeys.includes(key))) {
    throw new TypeError('Series Runtime bindings must exactly cover the sealed graph and policy.');
  }
  for (const node of nodes) {
    const runtime = runtimes.find((candidate) => (
      candidate.runtimeKind === 'series-analysis-node'
        && candidate.referenceId === node.nodeId
    ));
    const capabilities = runtime?.identity.capabilities;
    if (runtime === undefined
        || runtime.identity.implementationId !== node.implementationId
        || capabilities === null
        || Array.isArray(capabilities)
        || typeof capabilities !== 'object'
        || !('experimentalUnit' in capabilities)
        || capabilities.experimentalUnit !== 'run') {
      throw new TypeError(
        'Series Analysis Runtime must match the declared implementation and run unit.',
      );
    }
  }
  if (definition.decisionPolicy !== undefined) {
    const runtime = runtimes.find((candidate) => (
      candidate.runtimeKind === 'series-decision-policy'
        && candidate.referenceId === definition.decisionPolicy?.decisionPolicyId
    ));
    if (runtime === undefined
        || runtime.identity.implementationId !== definition.decisionPolicy.implementationId) {
      throw new TypeError('Series Decision Runtime must match the declared implementation.');
    }
  }
  const normalized = {
    ...definition,
    members,
    analysisGraph: { nodes },
    ...(definition.decisionPolicy === undefined ? {} : {
      decisionPolicy: normalizeSeriesDecisionPolicy(definition.decisionPolicy),
    }),
  };
  const sortedRuntimes = [...runtimes].sort((left, right) => {
    const leftKey = `${left.runtimeKind}\u0000${left.referenceId}`;
    const rightKey = `${right.runtimeKind}\u0000${right.referenceId}`;
    return compareStrings(leftKey, rightKey);
  });
  const payload = {
    schemaVersion: EVALUATION_SERIES_PLAN_SCHEMA_VERSION,
    definition: normalized,
    runtimes: sortedRuntimes,
  };
  return deepFreezeCanonicalJson(parseWireDocument(EvaluationSeriesPlanSchema, {
    ...payload,
    seriesPlanDigest: digestCanonicalJson(payload),
  }));
}

export function parseEvaluationSeriesPlan(value: unknown): EvaluationSeriesPlan {
  const plan = parseWireDocument(EvaluationSeriesPlanSchema, value);
  const { seriesPlanDigest, ...payload } = plan;
  if (digestCanonicalJson(payload) !== seriesPlanDigest) {
    throw new TypeError('EvaluationSeriesPlan digest does not match its canonical payload.');
  }
  assertUniqueMembers(plan.definition.members);
  if (canonicalizeJson(plan.definition.members)
      !== canonicalizeJson([...plan.definition.members].sort(compareMembers))) {
    throw new TypeError('EvaluationSeriesPlan members must use canonical replicate order.');
  }
  const rebuilt = prepareEvaluationSeriesPlan(plan.definition, plan.runtimes);
  if (canonicalizeJson(rebuilt) !== canonicalizeJson(plan)) {
    throw new TypeError('EvaluationSeriesPlan does not satisfy its sealed semantic contract.');
  }
  return plan;
}

const seriesMemberSources = new WeakSet<object>();

export function assertEvaluationSeriesMemberSource(
  value: unknown,
): asserts value is EvaluationSeriesMemberSource {
  if (value === null || typeof value !== 'object' || !seriesMemberSources.has(value)) {
    throw new TypeError('Series analysis requires an authenticated EvaluationSeriesMemberSource.');
  }
}

export function createEvaluationSeriesMemberSource(input: {
  memberId: string;
  replicateIndex: number;
  plan: SealedRunPlan;
  execution: ExecutionBundleSource;
  evaluation: EvaluationBundleSource;
  analysis: AnalysisBundleSource;
  decision?: DecisionResultSource;
  report: unknown;
}): EvaluationSeriesMemberSource {
  assertSealedRunPlan(input.plan);
  if (input.decision !== undefined) {
    assertDecisionResultSourceChain(
      input.execution,
      input.evaluation,
      input.analysis,
      input.decision,
    );
  }
  const report = deepFreezeCanonicalJson(parseEvaluationReport(
    input.report,
    input.plan as EvaluationReportPlanContext,
    input.execution,
    input.evaluation,
    input.analysis,
    input.decision,
  ));
  const trusts = [
    effectiveExecutionBundleTrust(input.execution),
    effectiveEvaluationBundleTrust(input.evaluation),
    effectiveAnalysisBundleTrust(input.analysis),
    ...(input.decision === undefined ? [] : [effectiveDecisionResultTrust(input.decision)]),
    report.provenance.trust,
  ];
  const effectiveTrust = minimumTrust(trusts, 'verified');
  const reference = deepFreezeCanonicalJson(parseWireDocument(SeriesMemberReferenceSchema, {
    memberId: input.memberId,
    replicateIndex: input.replicateIndex,
    runContractDigest: input.plan.digests.runContractDigest,
    planDigests: input.plan.digests,
    executionBundleDigest: input.execution.bundle.bundleDigest,
    evaluationBundleDigest: input.evaluation.bundle.bundleDigest,
    analysisBundleDigest: input.analysis.bundle.bundleDigest,
    ...(input.decision !== undefined
      ? { decisionDigest: input.decision.result.decisionDigest }
      : {}),
    reportDigest: report.reportDigest,
    status: report.status,
    effectiveTrust,
  }));
  const source = {
    plan: input.plan,
    reference,
    report,
    sources: Object.freeze({
      execution: input.execution,
      evaluation: input.evaluation,
      analysis: input.analysis,
      ...(input.decision !== undefined ? { decision: input.decision } : {}),
    }),
  };
  seriesMemberSources.add(source);
  return Object.freeze(source);
}

export function deriveSeriesMemberCoverage(
  plan: EvaluationSeriesPlan,
  members: readonly EvaluationSeriesMemberSource[],
  comparableMemberIds: ReadonlySet<string>,
): SeriesMemberCoverage {
  const actual = new Map(members.map((member) => [member.reference.memberId, member.reference]));
  return {
    planned: plan.definition.members.length,
    completed: [...actual.values()].filter((member) => (
      member.status.runStatus === 'completed' && member.status.evidenceStatus === 'complete'
    )).length,
    partial: [...actual.values()].filter((member) => (
      member.status.runStatus === 'completed' && member.status.evidenceStatus !== 'complete'
    )).length,
    cancelled: [...actual.values()].filter((member) => member.status.runStatus === 'cancelled').length,
    budgetExhausted: [...actual.values()].filter(
      (member) => member.status.runStatus === 'budget-exhausted',
    ).length,
    failed: [...actual.values()].filter((member) => member.status.runStatus === 'failed').length,
    missing: plan.definition.members.length - actual.size,
    comparable: comparableMemberIds.size,
  };
}

export function digestSeriesArtifact(
  value: Record<string, JsonValue>,
  digestField: 'bundleDigest' | 'decisionDigest' | 'reportDigest' | 'recordDigest',
): Sha256Digest {
  const payload = { ...value };
  delete payload[digestField];
  return digestCanonicalJson(payload);
}

export function parseSeriesAnalysisBundleDocument(value: unknown): SeriesAnalysisBundle {
  const bundle = parseWireDocument(SeriesAnalysisBundleSchema, value);
  assertUniqueMembers(bundle.members);
  if (canonicalizeJson(bundle.members)
      !== canonicalizeJson([...bundle.members].sort(compareMembers))) {
    throw new TypeError('SeriesAnalysisBundle members must use canonical replicate order.');
  }
  const accounted = bundle.coverage.completed
    + bundle.coverage.partial
    + bundle.coverage.cancelled
    + bundle.coverage.budgetExhausted
    + bundle.coverage.failed;
  if (accounted !== bundle.members.length
      || bundle.coverage.planned !== accounted + bundle.coverage.missing
      || bundle.coverage.comparable > bundle.members.length) {
    throw new TypeError('SeriesAnalysisBundle coverage is internally inconsistent.');
  }
  const memberIds = new Set(bundle.members.map((member) => member.memberId));
  const memberById = new Map(bundle.members.map((member) => [member.memberId, member]));
  const recordByResult = new Map(bundle.records.map((record) => [record.resultId, record]));
  if (recordByResult.size !== bundle.records.length) {
    throw new TypeError('Series analysis records require unique result identity.');
  }
  const anchorMemberId = bundle.members[0]?.memberId;
  const expectedComparedIds = bundle.members.slice(1).map((member) => member.memberId);
  if (bundle.comparability.length !== expectedComparedIds.length
      || canonicalizeJson(bundle.comparability.map((entry) => entry.memberId))
        !== canonicalizeJson(expectedComparedIds)) {
    throw new TypeError('Series comparability facts must cover every non-anchor member.');
  }
  for (const entry of bundle.comparability) {
    if (entry.anchorMemberId !== anchorMemberId || entry.memberId === anchorMemberId) {
      throw new TypeError('Series comparability fact has an invalid member binding.');
    }
    const assessment = parseComparabilityAssessmentDocument(entry.assessment);
    const anchor = memberById.get(entry.anchorMemberId);
    const candidate = memberById.get(entry.memberId);
    if (anchor === undefined || candidate === undefined
        || assessment.left.runContractDigest !== anchor.runContractDigest
        || assessment.right.runContractDigest !== candidate.runContractDigest
        || canonicalizeJson(assessment.left.planDigests)
          !== canonicalizeJson(anchor.planDigests)
        || canonicalizeJson(assessment.right.planDigests)
          !== canonicalizeJson(candidate.planDigests)) {
      throw new TypeError('Series comparability assessment is bound to different Runs.');
    }
    const expectedArtifactDigest = (
      member: SeriesMemberReference,
      stage: 'execution' | 'evaluation' | 'analysis' | 'decision',
    ): string | undefined => ({
      execution: member.executionBundleDigest,
      evaluation: member.evaluationBundleDigest,
      analysis: member.analysisBundleDigest,
      decision: member.decisionDigest,
    })[stage];
    if ([assessment.left, assessment.right].some((side, sideIndex) => {
      const member = sideIndex === 0 ? anchor : candidate;
      return side.artifacts.some((artifact) => (
        artifact.artifactDigest !== expectedArtifactDigest(member, artifact.stage)
      ));
    })) {
      throw new TypeError('Series comparability assessment has mismatched artifact lineage.');
    }
  }
  for (let index = 0; index < bundle.records.length; index += 1) {
    const record = bundle.records[index];
    const previous = bundle.records[index - 1];
    if (previous !== undefined && compareStrings(previous.nodeId, record.nodeId) >= 0) {
      throw new TypeError('Series analysis records require unique canonical node order.');
    }
    if (record.memberIds.some((memberId) => !memberIds.has(memberId))
        || canonicalizeJson(record.memberIds)
          !== canonicalizeJson([...record.memberIds].sort(compareStrings))
        || new Set(record.memberIds).size !== record.memberIds.length) {
      throw new TypeError('Series analysis record member references are invalid.');
    }
    if (record.memberIds.length > record.coverage.comparable
        || canonicalizeJson(record.coverage) !== canonicalizeJson(bundle.coverage)) {
      throw new TypeError('Series analysis record coverage exceeds its source Bundle coverage.');
    }
    const inputKeys = record.inputReferences.map((input) => (
      `${input.seriesInputKind}\u0000${input.referenceId}`
    ));
    if (new Set(inputKeys).size !== inputKeys.length
        || canonicalizeJson(record.inputReferences)
          !== canonicalizeJson([...record.inputReferences].sort((left, right) => (
            compareStrings(left.seriesInputKind, right.seriesInputKind)
            || compareStrings(left.referenceId, right.referenceId)
          )))) {
      throw new TypeError('Series analysis record inputs must be unique and canonical.');
    }
    const expectedRecordParents = new Set<Sha256Digest>();
    for (const input of record.inputReferences) {
      if (input.seriesInputKind === 'members') {
        for (const memberId of record.memberIds) {
          const member = memberById.get(memberId);
          if (member === undefined) throw new TypeError('Series analysis member is missing.');
          expectedRecordParents.add(member.reportDigest as Sha256Digest);
        }
      } else {
        const parent = recordByResult.get(input.referenceId);
        if (parent === undefined || parent.recordDigest === record.recordDigest) {
          throw new TypeError('Series analysis result parent is missing or self-referential.');
        }
        expectedRecordParents.add(parent.recordDigest as Sha256Digest);
      }
    }
    if (canonicalizeJson(record.parentDigests)
        !== canonicalizeJson([...expectedRecordParents].sort(compareStrings))) {
      throw new TypeError('Series analysis record lineage does not match its declared inputs.');
    }
    const assumptionIds = new Set<string>();
    if (record.assumptionChecks.some((check) => check.nodeId !== record.nodeId)) {
      throw new TypeError('Series assumption checks must bind their Analysis node.');
    }
    for (const check of record.assumptionChecks) {
      if (assumptionIds.has(check.assumptionId)
          || (check.checkStatus === 'passed' && check.reasonCode !== undefined)
          || (check.checkStatus !== 'passed' && check.reasonCode === undefined)) {
        throw new TypeError('Series assumption checks are not internally consistent.');
      }
      assumptionIds.add(check.assumptionId);
    }
    if (canonicalizeJson(record.assumptionChecks)
        !== canonicalizeJson([...record.assumptionChecks].sort((left, right) => (
          compareStrings(left.assumptionId, right.assumptionId)
        )))) {
      throw new TypeError('Series assumption checks must use canonical identity order.');
    }
    if (record.analysisStatus === 'inconclusive'
        && (new Set(record.reasonCodes).size !== record.reasonCodes.length
          || canonicalizeJson(record.reasonCodes)
            !== canonicalizeJson([...record.reasonCodes].sort(compareStrings)))) {
      throw new TypeError('Series inconclusive reasons must be unique and canonical.');
    }
    if (record.analysisStatus === 'completed'
        && record.assumptionChecks.some((check) => check.checkStatus !== 'passed')) {
      throw new TypeError('Completed Series analysis requires every assumption to pass.');
    }
    if ((record.analysisStatus === 'completed' || record.analysisStatus === 'failed')
        && record.runtimeExecutionStatus !== 'executed') {
      throw new TypeError('Completed or failed Series analysis requires Runtime execution.');
    }
    if (digestSeriesArtifact(
      record as unknown as Record<string, JsonValue>,
      'recordDigest',
    ) !== record.recordDigest) {
      throw new TypeError('Series analysis record digest does not match its canonical payload.');
    }
  }
  const expectedParents = bundle.members
    .map((member) => member.reportDigest)
    .sort(compareStrings);
  const trustInputs = [
    ...bundle.members.map((member) => member.effectiveTrust),
    ...bundle.records
      .filter((record) => record.runtimeExecutionStatus === 'executed')
      .map((record) => record.implementation.assuranceLevel),
  ];
  const trustCeiling = minimumTrust(trustInputs, 'unknown');
  if (canonicalizeJson(bundle.provenance.parentDigests)
      !== canonicalizeJson(expectedParents)
      || TRUST_LEVEL[bundle.provenance.trust] > TRUST_LEVEL[trustCeiling]
      || digestSeriesArtifact(
        bundle as unknown as Record<string, JsonValue>,
        'bundleDigest',
      ) !== bundle.bundleDigest) {
    throw new TypeError('SeriesAnalysisBundle provenance or digest is invalid.');
  }
  return bundle;
}

export function parseEvaluationSeriesReportDocument(value: unknown): EvaluationSeriesReport {
  const report = parseWireDocument(EvaluationSeriesReportSchema, value);
  if (report.decision !== undefined) {
    const resultIds = [...report.decision.analysisResultIds].sort(compareStrings);
    const reasons = report.decision.decisionStatus === 'decided'
      || report.decision.decisionStatus === 'not-decided'
      ? [...report.decision.reasonCodes].sort(compareStrings)
      : [];
    if (report.decision.seriesPlanDigest !== report.seriesPlanDigest
        || report.decision.analysisBundleDigest !== report.analysisBundleDigest
        || canonicalizeJson(report.decision.analysisResultIds) !== canonicalizeJson(resultIds)
        || new Set(report.decision.analysisResultIds).size
          !== report.decision.analysisResultIds.length
        || ((report.decision.decisionStatus === 'decided'
          || report.decision.decisionStatus === 'not-decided')
          && (canonicalizeJson(report.decision.reasonCodes) !== canonicalizeJson(reasons)
            || new Set(reasons).size !== reasons.length))
        || ((report.decision.decisionStatus === 'decided'
          || report.decision.decisionStatus === 'failed')
          && report.decision.policyExecutionStatus !== 'executed')
        || digestSeriesArtifact(
          report.decision as unknown as Record<string, JsonValue>,
          'decisionDigest',
        ) !== report.decision.decisionDigest) {
      throw new TypeError('EvaluationSeriesReport decision binding or digest is invalid.');
    }
  }
  const expectedParents = [
    report.analysisBundleDigest,
    ...(report.decision === undefined ? [] : [report.decision.decisionDigest]),
  ];
  if (canonicalizeJson(report.provenance.parentDigests)
      !== canonicalizeJson(expectedParents)
      || (report.decision?.policyExecutionStatus === 'executed'
        && TRUST_LEVEL[report.provenance.trust]
          > TRUST_LEVEL[report.decision.implementation.assuranceLevel])
      || digestSeriesArtifact(
        report as unknown as Record<string, JsonValue>,
        'reportDigest',
      ) !== report.reportDigest) {
    throw new TypeError('EvaluationSeriesReport provenance or digest is invalid.');
  }
  return report;
}
