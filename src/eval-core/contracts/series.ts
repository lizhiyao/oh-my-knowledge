import { z } from 'zod';
import {
  AssumptionCheckSchema,
  EvaluationStatusSchema,
} from './artifacts.js';
import {
  EvaluationErrorSchema,
  ExtensionsSchema,
  IdentifierSchema,
  ProvenanceSchema,
  RuntimeIdentitySchema,
  SchemaIdentitySchema,
  Sha256DigestSchema,
} from './common.js';
import {
  effectiveAnalysisBundleTrust,
  type AnalysisBundleSource,
} from './analysis-bundle.js';
import {
  effectiveEvaluationBundleTrust,
  type EvaluationBundleSource,
} from './evaluation-bundle.js';
import {
  effectiveExecutionBundleTrust,
  type ExecutionBundleSource,
} from './execution-bundle.js';
import {
  assertDecisionResultSourceChain,
  effectiveDecisionResultTrust,
  parseEvaluationReport,
  type DecisionResultSource,
  type EvaluationReportPlanContext,
} from './evaluation-report.js';
import {
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseWireDocument,
  JsonValueSchema,
  type JsonValue,
  type Sha256Digest,
} from './json.js';
import { PlanDigestsSchema } from './plans.js';
import {
  ComparabilityAssessmentSchema,
  parseComparabilityAssessmentDocument,
} from './comparability.js';
import { assertSealedRunPlan, type SealedRunPlan } from '../internal/sealed-run-plan.js';

export const EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION =
  'omk.evaluation-series-definition/v1' as const;
export const EVALUATION_SERIES_PLAN_SCHEMA_VERSION =
  'omk.evaluation-series-plan/v1' as const;
export const SERIES_ANALYSIS_BUNDLE_SCHEMA_VERSION =
  'omk.series-analysis-bundle/v2' as const;
export const EVALUATION_SERIES_REPORT_SCHEMA_VERSION =
  'omk.evaluation-series-report/v1' as const;

const VersionedSeriesStandardIdSchema = IdentifierSchema.regex(
  /(?:\/|:)v[1-9]\d*$/,
  'Series analysis standard identity must end in an explicit version such as /v1.',
);

export const SeriesMemberSlotSchema = z.object({
  memberId: IdentifierSchema,
  replicateIndex: z.number().int().nonnegative(),
  expectedRunContractDigest: Sha256DigestSchema.optional(),
}).strict();

export const SeriesAnalysisInputReferenceSchema = z.discriminatedUnion('seriesInputKind', [
  z.object({
    seriesInputKind: z.literal('members'),
    referenceId: IdentifierSchema,
  }).strict(),
  z.object({
    seriesInputKind: z.literal('analysis-result'),
    referenceId: IdentifierSchema,
  }).strict(),
]);

export const SeriesAnalysisNodeDefinitionSchema = z.object({
  nodeId: IdentifierSchema,
  implementationId: IdentifierSchema,
  analysisStandardId: VersionedSeriesStandardIdSchema,
  minimumMemberEvidenceStatus: z.enum(['complete', 'partial']),
  inputs: z.array(SeriesAnalysisInputReferenceSchema).min(1),
  outputResultId: IdentifierSchema,
  parameters: JsonValueSchema.optional(),
}).strict();

export const SeriesDecisionPolicyDefinitionSchema = z.object({
  decisionPolicyId: IdentifierSchema,
  implementationId: IdentifierSchema,
  analysisResultIds: z.array(IdentifierSchema).min(1),
  minimumCoverageRatio: z.number().min(0).max(1),
  minimumMemberEvidenceStatus: z.enum(['complete', 'partial']),
  parameters: JsonValueSchema.optional(),
}).strict();

export const EvaluationSeriesDefinitionSchema = z.object({
  schemaVersion: z.literal(EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION),
  seriesId: IdentifierSchema,
  seriesDesignDigest: Sha256DigestSchema,
  analysisMode: z.enum(['preregistered', 'exploratory']),
  experimentalUnit: z.literal('run'),
  members: z.array(SeriesMemberSlotSchema).min(2),
  comparabilityPolicy: z.object({
    designMode: z.literal('exact-measurement-design'),
    comparisonScope: z.enum(['evaluation', 'analysis', 'decision']),
    minimumStatus: z.enum(['compatible', 'conditional']),
  }).strict(),
  analysisGraph: z.object({
    nodes: z.array(SeriesAnalysisNodeDefinitionSchema).min(1),
  }).strict(),
  decisionPolicy: SeriesDecisionPolicyDefinitionSchema.optional(),
  extensions: ExtensionsSchema.optional(),
}).strict().meta({ title: 'OMK Evaluation Series Definition v1' });

export const SeriesResolvedRuntimeSchema = z.discriminatedUnion('runtimeKind', [
  z.object({
    runtimeKind: z.literal('series-analysis-node'),
    referenceId: IdentifierSchema,
    identity: RuntimeIdentitySchema,
    outputSchema: SchemaIdentitySchema,
  }).strict(),
  z.object({
    runtimeKind: z.literal('series-decision-policy'),
    referenceId: IdentifierSchema,
    identity: RuntimeIdentitySchema,
  }).strict(),
]);

export const EvaluationSeriesPlanSchema = z.object({
  schemaVersion: z.literal(EVALUATION_SERIES_PLAN_SCHEMA_VERSION),
  definition: EvaluationSeriesDefinitionSchema,
  runtimes: z.array(SeriesResolvedRuntimeSchema),
  seriesPlanDigest: Sha256DigestSchema,
}).strict().meta({ title: 'OMK Evaluation Series Plan v1' });

export const SeriesMemberReferenceSchema = z.object({
  memberId: IdentifierSchema,
  replicateIndex: z.number().int().nonnegative(),
  runContractDigest: Sha256DigestSchema,
  planDigests: PlanDigestsSchema,
  executionBundleDigest: Sha256DigestSchema,
  evaluationBundleDigest: Sha256DigestSchema,
  analysisBundleDigest: Sha256DigestSchema,
  decisionDigest: Sha256DigestSchema.optional(),
  reportDigest: Sha256DigestSchema,
  status: EvaluationStatusSchema,
  effectiveTrust: z.enum(['verified', 'declared', 'untrusted', 'unknown']),
}).strict();

export const SeriesMemberCoverageSchema = z.object({
  planned: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  budgetExhausted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  comparable: z.number().int().nonnegative(),
}).strict();

export const SeriesComparabilityAssessmentSchema = z.object({
  anchorMemberId: IdentifierSchema,
  memberId: IdentifierSchema,
  assessment: ComparabilityAssessmentSchema,
}).strict();

const SeriesAnalysisRecordBaseSchema = z.object({
  resultId: IdentifierSchema,
  nodeId: IdentifierSchema,
  analysisStandardId: IdentifierSchema,
  implementation: RuntimeIdentitySchema,
  outputSchema: SchemaIdentitySchema,
  inputReferences: z.array(SeriesAnalysisInputReferenceSchema).min(1),
  memberIds: z.array(IdentifierSchema),
  coverage: SeriesMemberCoverageSchema,
  assumptionChecks: z.array(AssumptionCheckSchema),
  runtimeExecutionStatus: z.enum(['executed', 'not-executed']),
  analysisMode: z.enum(['preregistered', 'exploratory']),
  parentDigests: z.array(Sha256DigestSchema),
  recordDigest: Sha256DigestSchema,
}).strict();

export const SeriesAnalysisRecordSchema = z.discriminatedUnion('analysisStatus', [
  SeriesAnalysisRecordBaseSchema.extend({
    analysisStatus: z.literal('completed'),
    resultType: z.enum(['scalar', 'interval', 'distribution', 'table', 'matrix', 'curve']),
    value: JsonValueSchema,
  }).strict(),
  SeriesAnalysisRecordBaseSchema.extend({
    analysisStatus: z.literal('inconclusive'),
    reasonCodes: z.array(IdentifierSchema).min(1),
  }).strict(),
  SeriesAnalysisRecordBaseSchema.extend({
    analysisStatus: z.literal('failed'),
    error: EvaluationErrorSchema,
  }).strict(),
]);

export const SeriesAnalysisBundleSchema = z.object({
  schemaVersion: z.literal(SERIES_ANALYSIS_BUNDLE_SCHEMA_VERSION),
  bundleId: IdentifierSchema,
  seriesPlanDigest: Sha256DigestSchema,
  members: z.array(SeriesMemberReferenceSchema),
  comparability: z.array(SeriesComparabilityAssessmentSchema),
  coverage: SeriesMemberCoverageSchema,
  records: z.array(SeriesAnalysisRecordSchema),
  provenance: ProvenanceSchema,
  bundleDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({ title: 'OMK Series Analysis Bundle v2' });

const SeriesDecisionResultBaseSchema = z.object({
  decisionPolicyId: IdentifierSchema,
  implementation: RuntimeIdentitySchema,
  seriesPlanDigest: Sha256DigestSchema,
  analysisBundleDigest: Sha256DigestSchema,
  analysisResultIds: z.array(IdentifierSchema).min(1),
  policyDigest: Sha256DigestSchema,
  policyExecutionStatus: z.enum(['executed', 'not-executed']),
  decisionDigest: Sha256DigestSchema,
}).strict();

export const SeriesDecisionResultSchema = z.discriminatedUnion('decisionStatus', [
  SeriesDecisionResultBaseSchema.extend({
    decisionStatus: z.literal('decided'),
    verdict: IdentifierSchema,
    reasonCodes: z.array(IdentifierSchema).min(1),
  }).strict(),
  SeriesDecisionResultBaseSchema.extend({
    decisionStatus: z.literal('not-decided'),
    reasonCodes: z.array(IdentifierSchema).min(1),
  }).strict(),
  SeriesDecisionResultBaseSchema.extend({
    decisionStatus: z.literal('failed'),
    error: EvaluationErrorSchema,
  }).strict(),
]);

export const EvaluationSeriesReportSchema = z.object({
  schemaVersion: z.literal(EVALUATION_SERIES_REPORT_SCHEMA_VERSION),
  reportId: IdentifierSchema,
  seriesPlanDigest: Sha256DigestSchema,
  analysisBundleDigest: Sha256DigestSchema,
  decision: SeriesDecisionResultSchema.optional(),
  provenance: ProvenanceSchema,
  reportDigest: Sha256DigestSchema,
  extensions: ExtensionsSchema.optional(),
}).strict().meta({ title: 'OMK Evaluation Series Report v1' });

export type EvaluationSeriesDefinition = z.infer<typeof EvaluationSeriesDefinitionSchema>;
export type EvaluationSeriesDefinitionInput = Omit<
  EvaluationSeriesDefinition,
  'seriesDesignDigest'
>;
export type EvaluationSeriesPlan = z.infer<typeof EvaluationSeriesPlanSchema>;
export type SeriesMemberReference = z.infer<typeof SeriesMemberReferenceSchema>;
export type SeriesMemberCoverage = z.infer<typeof SeriesMemberCoverageSchema>;
export type SeriesComparabilityAssessment = z.infer<
  typeof SeriesComparabilityAssessmentSchema
>;
export type SeriesAnalysisRecord = z.infer<typeof SeriesAnalysisRecordSchema>;
export type SeriesAnalysisBundle = z.infer<typeof SeriesAnalysisBundleSchema>;
export type SeriesDecisionResult = z.infer<typeof SeriesDecisionResultSchema>;
export type EvaluationSeriesReport = z.infer<typeof EvaluationSeriesReportSchema>;

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareMembers(
  left: Pick<SeriesMemberReference, 'replicateIndex' | 'memberId'>,
  right: Pick<SeriesMemberReference, 'replicateIndex' | 'memberId'>,
): number {
  return left.replicateIndex - right.replicateIndex
    || (left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0);
}

function normalizeSeriesNode(
  node: z.infer<typeof SeriesAnalysisNodeDefinitionSchema>,
): z.infer<typeof SeriesAnalysisNodeDefinitionSchema> {
  return {
    ...node,
    inputs: [...node.inputs].sort((left, right) => (
      compareStrings(left.seriesInputKind, right.seriesInputKind)
      || compareStrings(left.referenceId, right.referenceId)
    )),
  };
}

function normalizeSeriesDecisionPolicy(
  policy: z.infer<typeof SeriesDecisionPolicyDefinitionSchema>,
): z.infer<typeof SeriesDecisionPolicyDefinitionSchema> {
  return {
    ...policy,
    analysisResultIds: [...policy.analysisResultIds].sort(compareStrings),
  };
}

function assertUniqueMembers(
  members: readonly Pick<SeriesMemberReference, 'replicateIndex' | 'memberId'>[],
): void {
  if (new Set(members.map((member) => member.memberId)).size !== members.length
      || new Set(members.map((member) => member.replicateIndex)).size !== members.length) {
    throw new TypeError('Series members require unique memberId and replicateIndex values.');
  }
}

function assertSeriesGraph(
  seriesId: string,
  nodes: readonly z.infer<typeof SeriesAnalysisNodeDefinitionSchema>[],
): void {
  const producerByResult = new Map(nodes.map((node) => [node.outputResultId, node.nodeId]));
  const dependencies = new Map<string, Set<string>>();
  for (const node of nodes) {
    const nodeDependencies = new Set<string>();
    const inputKeys = node.inputs.map((input) => (
      `${input.seriesInputKind}\u0000${input.referenceId}`
    ));
    if (new Set(inputKeys).size !== inputKeys.length) {
      throw new TypeError('Series analysis node inputs must be unique.');
    }
    for (const input of node.inputs) {
      if (input.seriesInputKind === 'members') {
        if (input.referenceId !== seriesId) {
          throw new TypeError('Series member input must reference the current Series identity.');
        }
      } else {
        const producer = producerByResult.get(input.referenceId);
        if (producer === undefined) {
          throw new TypeError('Series analysis input references an unknown result.');
        }
        nodeDependencies.add(producer);
      }
    }
    dependencies.set(node.nodeId, nodeDependencies);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new TypeError('Series analysis graph must be acyclic.');
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependency of dependencies.get(nodeId) ?? []) visit(dependency);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.nodeId);
}

function seriesDesignPayload(
  definition: EvaluationSeriesDefinitionInput | EvaluationSeriesDefinition,
): JsonValue {
  return {
    schemaVersion: definition.schemaVersion,
    seriesId: definition.seriesId,
    analysisMode: definition.analysisMode,
    experimentalUnit: definition.experimentalUnit,
    members: [...definition.members].sort(compareMembers).map((member) => ({
      memberId: member.memberId,
      replicateIndex: member.replicateIndex,
      ...(member.expectedRunContractDigest === undefined ? {} : {
        expectedRunContractDigest: member.expectedRunContractDigest,
      }),
    })),
    comparabilityPolicy: definition.comparabilityPolicy,
    analysisGraph: {
      nodes: [...definition.analysisGraph.nodes]
        .map(normalizeSeriesNode)
        .sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
    },
    ...(definition.decisionPolicy !== undefined
      ? { decisionPolicy: normalizeSeriesDecisionPolicy(definition.decisionPolicy) }
      : {}),
    ...(definition.extensions !== undefined ? { extensions: definition.extensions } : {}),
  } as JsonValue;
}

export function createEvaluationSeriesDefinition(
  input: EvaluationSeriesDefinitionInput,
): EvaluationSeriesDefinition {
  assertUniqueMembers(input.members);
  if (input.analysisMode === 'preregistered'
      && input.members.some((member) => member.expectedRunContractDigest !== undefined)) {
    throw new TypeError(
      'Preregistered Series slots cannot depend on post-execution Run contract digests.',
    );
  }
  const nodes = [...input.analysisGraph.nodes]
    .map(normalizeSeriesNode)
    .sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length
      || new Set(nodes.map((node) => node.outputResultId)).size !== nodes.length) {
    throw new TypeError('Series analysis nodes require unique node and result identifiers.');
  }
  assertSeriesGraph(input.seriesId, nodes);
  const decisionPolicy = input.decisionPolicy === undefined
    ? undefined
    : normalizeSeriesDecisionPolicy(input.decisionPolicy);
  if (decisionPolicy !== undefined
      && (new Set(decisionPolicy.analysisResultIds).size
        !== decisionPolicy.analysisResultIds.length
        || decisionPolicy.analysisResultIds.some((resultId) => (
          !nodes.some((node) => node.outputResultId === resultId)
        )))) {
    throw new TypeError('Series decision policy requires unique known analysis results.');
  }
  const normalized = {
    ...input,
    members: [...input.members].sort(compareMembers),
    analysisGraph: { nodes },
    ...(decisionPolicy === undefined ? {} : { decisionPolicy }),
  };
  const payload = seriesDesignPayload(normalized);
  return deepFreezeCanonicalJson(parseWireDocument(EvaluationSeriesDefinitionSchema, {
    ...normalized,
    seriesDesignDigest: digestCanonicalJson(payload),
  }));
}

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
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
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

export interface EvaluationSeriesMemberSource {
  readonly plan: SealedRunPlan;
  readonly reference: SeriesMemberReference;
  readonly report: ReturnType<typeof parseEvaluationReport>;
  readonly sources: {
    execution: ExecutionBundleSource;
    evaluation: EvaluationBundleSource;
    analysis: AnalysisBundleSource;
    decision?: DecisionResultSource;
  };
}

const seriesMemberSources = new WeakSet<object>();

export function assertEvaluationSeriesMemberSource(
  value: unknown,
): asserts value is EvaluationSeriesMemberSource {
  if (value === null || typeof value !== 'object' || !seriesMemberSources.has(value)) {
    throw new TypeError('Series analysis requires an authenticated EvaluationSeriesMemberSource.');
  }
}

function trustLevel(value: SeriesMemberReference['effectiveTrust']): number {
  return { untrusted: 0, unknown: 1, declared: 2, verified: 3 }[value];
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
  const effectiveTrust = [...trusts].sort((left, right) => trustLevel(left) - trustLevel(right))[0];
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
  const trustCeiling = [...trustInputs].sort((left, right) => (
    trustLevel(left) - trustLevel(right)
  ))[0] ?? 'unknown';
  if (canonicalizeJson(bundle.provenance.parentDigests)
      !== canonicalizeJson(expectedParents)
      || trustLevel(bundle.provenance.trust) > trustLevel(trustCeiling)
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
        && trustLevel(report.provenance.trust)
          > trustLevel(report.decision.implementation.assuranceLevel))
      || digestSeriesArtifact(
        report as unknown as Record<string, JsonValue>,
        'reportDigest',
      ) !== report.reportDigest) {
    throw new TypeError('EvaluationSeriesReport provenance or digest is invalid.');
  }
  return report;
}
