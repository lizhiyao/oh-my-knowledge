import { compareStrings } from '../primitives/ordering.js';

import { z } from 'zod';
import {
  type EvaluationReport,
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
import type {
  AnalysisBundleSource,} from './analysis-bundle.js';
import type {
  EvaluationBundleSource,} from './evaluation-bundle.js';
import type {
  ExecutionBundleSource,} from './execution-bundle.js';
import {
  type DecisionResultSource,
} from './evaluation-report.js';
import {
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseWireDocument,
  JsonValueSchema,
  type JsonValue,
} from './json.js';
import {
  PlanDigestsSchema,
} from './plans.js';
import {
  ComparabilityAssessmentSchema,
} from './comparability.js';
import type {
  SealedRunPlan,} from './sealed-run-plan.js';

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

export function compareMembers(
  left: Pick<SeriesMemberReference, 'replicateIndex' | 'memberId'>,
  right: Pick<SeriesMemberReference, 'replicateIndex' | 'memberId'>,
): number {
  return left.replicateIndex - right.replicateIndex
    || (compareStrings(left.memberId, right.memberId));
}

export function normalizeSeriesNode(
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

export function normalizeSeriesDecisionPolicy(
  policy: z.infer<typeof SeriesDecisionPolicyDefinitionSchema>,
): z.infer<typeof SeriesDecisionPolicyDefinitionSchema> {
  return {
    ...policy,
    analysisResultIds: [...policy.analysisResultIds].sort(compareStrings),
  };
}

export function assertUniqueMembers(
  members: readonly Pick<SeriesMemberReference, 'replicateIndex' | 'memberId'>[],
): void {
  if (new Set(members.map((member) => member.memberId)).size !== members.length
      || new Set(members.map((member) => member.replicateIndex)).size !== members.length) {
    throw new TypeError('Series members require unique memberId and replicateIndex values.');
  }
}

export function assertSeriesGraph(
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

export function seriesDesignPayload(
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

export interface EvaluationSeriesMemberSource {
  readonly plan: SealedRunPlan;
  readonly reference: SeriesMemberReference;
  readonly report: EvaluationReport;
  readonly sources: {
    execution: ExecutionBundleSource;
    evaluation: EvaluationBundleSource;
    analysis: AnalysisBundleSource;
    decision?: DecisionResultSource;
  };
}
