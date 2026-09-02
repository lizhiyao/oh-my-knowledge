import { z } from 'zod';
import {
  IdentifierSchema,
  RuntimeIdentitySchema,
  SamplingUnitIdsSchema,
  Sha256DigestSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
} from '../../../eval-core/contracts/index.js';
import type {
  AnalysisMetricRow,
  AnalysisNodeExecutionContext,
  AnalysisNodeImplementation,
  AnalysisNodeInput,
} from '../../../eval-core/analysis/index.js';
import {
  analysisJsonSchema,
  analysisSchemaIdentity,
  compareStrings,
  createAnalysisSchemaValidator,
  createStatelessAnalysisImplementation,
  round,
} from './analysis-support.js';

export const JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID =
  'omk.judge-replicate-table/v2' as const;
export const JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID =
  'omk.judge-ensemble-table/v2' as const;
export const JUDGE_REPLICATE_TABLE_SCHEMA_VERSION =
  'omk.judge-replicate-table/v2' as const;
export const JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION =
  'omk.judge-ensemble-table/v2' as const;

const ALGORITHM_VERSION = 'omk.judge-aggregation/v2' as const;
const MEAN_DECIMALS = 2;
const STANDARD_DEVIATION_DECIMALS = 3;
const AGREEMENT_DECIMALS = 3;

const FiniteNumberSchema = z.number().finite();
const ScoreSchema = FiniteNumberSchema.min(1).max(5);
const CountSchema = z.number().int().nonnegative().safe();
const PositiveCountSchema = z.number().int().positive().safe();
const EmptyParametersSchema = z.object({}).strict();

const CoverageSchema = z.object({
  planned: PositiveCountSchema,
  observed: CountSchema,
  missing: CountSchema,
  invalid: CountSchema,
  evaluationFailed: CountSchema,
  sourceUnavailable: CountSchema,
  notStarted: CountSchema,
  censored: CountSchema,
}).strict();

const ObservedReplicateSchema = z.object({
  rowId: Sha256DigestSchema,
  evaluatorId: IdentifierSchema,
  replicateIndex: CountSchema,
  rowStatus: z.literal('observed'),
  censored: z.boolean(),
  score: ScoreSchema,
}).strict();

const UnobservedReplicateSchema = z.object({
  rowId: Sha256DigestSchema,
  evaluatorId: IdentifierSchema,
  replicateIndex: CountSchema,
  rowStatus: z.enum([
    'missing',
    'invalid',
    'evaluation-failed',
    'source-unavailable',
    'not-started',
  ]),
  censored: z.boolean(),
  reasonCode: IdentifierSchema,
}).strict();

const ReplicateSchema = z.discriminatedUnion('rowStatus', [
  ObservedReplicateSchema,
  UnobservedReplicateSchema,
]);

const ReplicateGroupBaseSchema = z.object({
  groupId: Sha256DigestSchema,
  targetId: IdentifierSchema,
  sampleId: IdentifierSchema,
  trialIndex: CountSchema,
  trialId: Sha256DigestSchema,
  samplingUnitIds: SamplingUnitIdsSchema,
  metricId: IdentifierSchema,
  instrumentId: IdentifierSchema,
  ensembleMemberId: IdentifierSchema,
  replicateGroupId: IdentifierSchema,
  coverage: CoverageSchema,
  replicates: z.array(ReplicateSchema).min(1),
}).strict();

const ObservedReplicateGroupSchema = ReplicateGroupBaseSchema.extend({
  aggregateStatus: z.literal('observed'),
  mean: ScoreSchema,
  sampleStddev: FiniteNumberSchema.nonnegative(),
}).strict();

const MissingReplicateGroupSchema = ReplicateGroupBaseSchema.extend({
  aggregateStatus: z.literal('missing'),
  reasonCode: z.literal('judge-replicates-unobserved'),
}).strict();

const ReplicateGroupSchema = z.discriminatedUnion('aggregateStatus', [
  ObservedReplicateGroupSchema,
  MissingReplicateGroupSchema,
]);

const ReplicateTableValueSchema = z.object({
  schemaVersion: z.literal(JUDGE_REPLICATE_TABLE_SCHEMA_VERSION),
  groups: z.array(ReplicateGroupSchema).min(1),
}).strict();

const ReplicateEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: ReplicateTableValueSchema,
}).strict().superRefine((envelope, context) => {
  validateReplicateTable(envelope.value, (path, message) => {
    context.addIssue({ code: 'custom', path: ['value', ...path], message });
  });
});

const EnsembleMemberBaseSchema = z.object({
  ensembleMemberId: IdentifierSchema,
  sourceGroupId: Sha256DigestSchema,
  sourceRowIds: z.array(Sha256DigestSchema).min(1),
  coverage: CoverageSchema,
}).strict();

const ObservedEnsembleMemberSchema = EnsembleMemberBaseSchema.extend({
  memberStatus: z.literal('observed'),
  mean: ScoreSchema,
  sampleStddev: FiniteNumberSchema.nonnegative(),
}).strict();

const MissingEnsembleMemberSchema = EnsembleMemberBaseSchema.extend({
  memberStatus: z.literal('missing'),
  reasonCode: z.literal('judge-replicates-unobserved'),
}).strict();

const EnsembleMemberSchema = z.discriminatedUnion('memberStatus', [
  ObservedEnsembleMemberSchema,
  MissingEnsembleMemberSchema,
]);

const ObservedAgreementSchema = z.object({
  agreementStatus: z.literal('observed'),
  meanAbsDiff: FiniteNumberSchema.nonnegative(),
  pairCount: PositiveCountSchema,
}).strict();

const MissingAgreementSchema = z.object({
  agreementStatus: z.literal('missing'),
  reasonCode: z.literal('judge-agreement-insufficient-members'),
  pairCount: z.literal(0),
}).strict();

const AgreementSchema = z.discriminatedUnion('agreementStatus', [
  ObservedAgreementSchema,
  MissingAgreementSchema,
]);

const EnsembleCoverageSchema = z.object({
  plannedMembers: PositiveCountSchema,
  observedMembers: CountSchema,
  missingMembers: CountSchema,
}).strict();

const EnsembleGroupBaseSchema = z.object({
  groupId: Sha256DigestSchema,
  targetId: IdentifierSchema,
  sampleId: IdentifierSchema,
  trialIndex: CountSchema,
  trialId: Sha256DigestSchema,
  samplingUnitIds: SamplingUnitIdsSchema,
  metricId: IdentifierSchema,
  instrumentId: IdentifierSchema,
  replicateGroupId: IdentifierSchema,
  coverage: EnsembleCoverageSchema,
  members: z.array(EnsembleMemberSchema).min(1),
  agreement: AgreementSchema,
}).strict();

const ObservedEnsembleGroupSchema = EnsembleGroupBaseSchema.extend({
  aggregateStatus: z.literal('observed'),
  consensus: ScoreSchema,
}).strict();

const MissingEnsembleGroupSchema = EnsembleGroupBaseSchema.extend({
  aggregateStatus: z.literal('missing'),
  reasonCode: z.literal('judge-ensemble-unobserved'),
}).strict();

const EnsembleGroupSchema = z.discriminatedUnion('aggregateStatus', [
  ObservedEnsembleGroupSchema,
  MissingEnsembleGroupSchema,
]);

const EnsembleTableValueSchema = z.object({
  schemaVersion: z.literal(JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION),
  groups: z.array(EnsembleGroupSchema).min(1),
}).strict();

const EnsembleEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: EnsembleTableValueSchema,
}).strict().superRefine((envelope, context) => {
  validateEnsembleTable(envelope.value, (path, message) => {
    context.addIssue({ code: 'custom', path: ['value', ...path], message });
  });
});

type ReplicateTableValue = z.infer<typeof ReplicateTableValueSchema>;
type ReplicateGroup = z.infer<typeof ReplicateGroupSchema>;
type EnsembleTableValue = z.infer<typeof EnsembleTableValueSchema>;
type EnsembleGroup = z.infer<typeof EnsembleGroupSchema>;
export type JudgeEnsembleTableValue = EnsembleTableValue;
export type JudgeEnsembleGroup = EnsembleGroup;
type Issue = (path: Array<string | number>, message: string) => void;

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStddev(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0)
    / (values.length - 1);
  return Math.sqrt(variance);
}

function meanAbsDiff(values: readonly number[]): { value: number; pairCount: number } | undefined {
  if (values.length < 2) return undefined;
  let difference = 0;
  let pairCount = 0;
  for (let left = 0; left < values.length; left++) {
    for (let right = left + 1; right < values.length; right++) {
      difference += Math.abs(values[left] - values[right]);
      pairCount += 1;
    }
  }
  return { value: difference / pairCount, pairCount };
}

function replicateGroupKey(value: Pick<ReplicateGroup,
  | 'targetId'
  | 'sampleId'
  | 'trialIndex'
  | 'trialId'
  | 'samplingUnitIds'
  | 'metricId'
  | 'instrumentId'
  | 'ensembleMemberId'
  | 'replicateGroupId'
>): string {
  return canonicalizeJson([
    value.targetId,
    value.sampleId,
    value.trialIndex,
    value.trialId,
    value.samplingUnitIds,
    value.metricId,
    value.instrumentId,
    value.ensembleMemberId,
    value.replicateGroupId,
  ]);
}

function ensembleGroupKey(value: Pick<EnsembleGroup,
  | 'targetId'
  | 'sampleId'
  | 'trialIndex'
  | 'trialId'
  | 'samplingUnitIds'
  | 'metricId'
  | 'instrumentId'
  | 'replicateGroupId'
>): string {
  return canonicalizeJson([
    value.targetId,
    value.sampleId,
    value.trialIndex,
    value.trialId,
    value.samplingUnitIds,
    value.metricId,
    value.instrumentId,
    value.replicateGroupId,
  ]);
}

function rowStatusCounts(replicates: readonly z.infer<typeof ReplicateSchema>[]) {
  return {
    planned: replicates.length,
    observed: replicates.filter((entry) => entry.rowStatus === 'observed').length,
    missing: replicates.filter((entry) => entry.rowStatus === 'missing').length,
    invalid: replicates.filter((entry) => entry.rowStatus === 'invalid').length,
    evaluationFailed: replicates.filter((entry) => entry.rowStatus === 'evaluation-failed').length,
    sourceUnavailable: replicates.filter((entry) => entry.rowStatus === 'source-unavailable').length,
    notStarted: replicates.filter((entry) => entry.rowStatus === 'not-started').length,
    censored: replicates.filter((entry) => entry.censored).length,
  };
}

function validateReplicateTable(value: ReplicateTableValue, issue: Issue): void {
  const keys = value.groups.map(replicateGroupKey);
  if (new Set(keys).size !== keys.length
      || canonicalizeJson(keys) !== canonicalizeJson([...keys].sort(compareStrings))) {
    issue(['groups'], 'Replicate groups must be unique and canonically ordered.');
  }
  const allRowIds = value.groups.flatMap((group) => group.replicates.map((entry) => entry.rowId));
  if (new Set(allRowIds).size !== allRowIds.length) {
    issue(['groups'], 'Replicate source row identities must be globally unique.');
  }
  for (const [groupIndex, group] of value.groups.entries()) {
    const replicateIndices = group.replicates.map((entry) => entry.replicateIndex);
    if (new Set(replicateIndices).size !== replicateIndices.length
        || canonicalizeJson(replicateIndices)
          !== canonicalizeJson([...replicateIndices].sort((left, right) => left - right))) {
      issue(['groups', groupIndex, 'replicates'], 'Replicate indices must be unique and sorted.');
    }
    if (canonicalizeJson(group.coverage)
        !== canonicalizeJson(rowStatusCounts(group.replicates))) {
      issue(['groups', groupIndex, 'coverage'], 'Replicate coverage does not conserve source rows.');
    }
    const expectedGroupId = digestCanonicalJson({
      derivation: JUDGE_REPLICATE_TABLE_SCHEMA_VERSION,
      key: JSON.parse(replicateGroupKey(group)) as JsonValue,
      sourceRowIds: group.replicates.map((entry) => entry.rowId),
    });
    if (group.groupId !== expectedGroupId) {
      issue(['groups', groupIndex, 'groupId'], 'Replicate group identity does not match its lineage.');
    }
    const scores = group.replicates.flatMap((entry) => (
      entry.rowStatus === 'observed' ? [entry.score] : []
    ));
    if (scores.length === 0) {
      if (group.aggregateStatus !== 'missing') {
        issue(['groups', groupIndex], 'An unobserved replicate group must be missing.');
      }
    } else if (group.aggregateStatus !== 'observed'
        || group.mean !== round(mean(scores), MEAN_DECIMALS)
        || group.sampleStddev !== round(sampleStddev(scores), STANDARD_DEVIATION_DECIMALS)) {
      issue(['groups', groupIndex], 'Replicate aggregate does not match observed readings.');
    }
  }
}

function validateEnsembleTable(value: EnsembleTableValue, issue: Issue): void {
  const keys = value.groups.map(ensembleGroupKey);
  if (new Set(keys).size !== keys.length
      || canonicalizeJson(keys) !== canonicalizeJson([...keys].sort(compareStrings))) {
    issue(['groups'], 'Ensemble groups must be unique and canonically ordered.');
  }
  const sourceGroupIds = value.groups.flatMap((group) => (
    group.members.map((member) => member.sourceGroupId)
  ));
  if (new Set(sourceGroupIds).size !== sourceGroupIds.length) {
    issue(['groups'], 'Replicate group lineage must be globally unique in the ensemble table.');
  }
  const sourceRowIds = value.groups.flatMap((group) => (
    group.members.flatMap((member) => member.sourceRowIds)
  ));
  if (new Set(sourceRowIds).size !== sourceRowIds.length) {
    issue(['groups'], 'Replicate source row identities must be globally unique in the ensemble table.');
  }
  for (const [groupIndex, group] of value.groups.entries()) {
    const memberIds = group.members.map((member) => member.ensembleMemberId);
    if (new Set(memberIds).size !== memberIds.length
        || canonicalizeJson(memberIds)
          !== canonicalizeJson([...memberIds].sort(compareStrings))) {
      issue(['groups', groupIndex, 'members'], 'Ensemble members must be unique and sorted.');
    }
    const expectedCoverage = {
      plannedMembers: group.members.length,
      observedMembers: group.members.filter((member) => member.memberStatus === 'observed').length,
      missingMembers: group.members.filter((member) => member.memberStatus === 'missing').length,
    };
    if (canonicalizeJson(group.coverage) !== canonicalizeJson(expectedCoverage)) {
      issue(['groups', groupIndex, 'coverage'], 'Ensemble coverage does not conserve member rows.');
    }
    for (const [memberIndex, member] of group.members.entries()) {
      if (new Set(member.sourceRowIds).size !== member.sourceRowIds.length
          || member.sourceRowIds.length !== member.coverage.planned) {
        issue(
          ['groups', groupIndex, 'members', memberIndex, 'sourceRowIds'],
          'Member source row lineage must uniquely conserve planned replicate rows.',
        );
      }
    }
    const expectedGroupId = digestCanonicalJson({
      derivation: JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
      key: JSON.parse(ensembleGroupKey(group)) as JsonValue,
      sourceGroupIds: group.members.map((member) => member.sourceGroupId),
    });
    if (group.groupId !== expectedGroupId) {
      issue(['groups', groupIndex, 'groupId'], 'Ensemble group identity does not match its lineage.');
    }
    const means = group.members.flatMap((member) => (
      member.memberStatus === 'observed' ? [member.mean] : []
    ));
    if (means.length === 0) {
      if (group.aggregateStatus !== 'missing') {
        issue(['groups', groupIndex], 'An unobserved ensemble group must be missing.');
      }
    } else if (group.aggregateStatus !== 'observed'
        || group.consensus !== round(mean(means), MEAN_DECIMALS)) {
      issue(['groups', groupIndex], 'Ensemble consensus does not match observed member means.');
    }
    const expectedAgreement = meanAbsDiff(means);
    if (expectedAgreement === undefined) {
      if (group.agreement.agreementStatus !== 'missing' || group.agreement.pairCount !== 0) {
        issue(['groups', groupIndex, 'agreement'], 'Insufficient members require missing agreement.');
      }
    } else if (group.agreement.agreementStatus !== 'observed'
        || group.agreement.pairCount !== expectedAgreement.pairCount
        || group.agreement.meanAbsDiff !== round(expectedAgreement.value, AGREEMENT_DECIMALS)) {
      issue(['groups', groupIndex, 'agreement'], 'Agreement does not match observed member means.');
    }
  }
}

export const JUDGE_REPLICATE_TABLE_SCHEMA = analysisSchemaIdentity(
  JUDGE_REPLICATE_TABLE_SCHEMA_VERSION,
  'urn:omk:analysis-result:judge-replicate-table:v2',
  analysisJsonSchema(ReplicateEnvelopeSchema, [
    'groups are unique and canonically ordered by the full measurement unit key',
    'sampling-unit lineage is identical across every replicate in a group',
    'replicate indices and source row identities are unique',
    'coverage exactly conserves every source row status',
    'groupId is content-derived from the unit key and source row lineage',
    'mean and sampleStddev are recomputable from observed 1-5 readings',
    'zero observed readings produces a missing group rather than numeric zero',
  ]),
);

export const JUDGE_ENSEMBLE_TABLE_SCHEMA = analysisSchemaIdentity(
  JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
  'urn:omk:analysis-result:judge-ensemble-table:v2',
  analysisJsonSchema(EnsembleEnvelopeSchema, [
    'groups and members are unique and canonically ordered',
    'sampling-unit lineage is identical across every ensemble member in a group',
    'coverage exactly conserves every member row',
    'groupId is content-derived from the unit key and replicate group lineage',
    'consensus is the equal mean of observed member means',
    'agreement is pairwise mean absolute difference over observed members only',
    'fewer than two observed members produces missing agreement',
  ]),
);

const PARAMETERS_SCHEMA = analysisSchemaIdentity(
  'omk.parameters.judge-aggregation-empty/v1',
  'urn:omk:parameters:judge-aggregation-empty:v1',
  analysisJsonSchema(EmptyParametersSchema, ['no ambient aggregation parameters']),
);

function capabilities(input: Readonly<{
  inputKind: 'metric-observations' | 'analysis-result';
  outputSchema: SchemaIdentity;
}>): JsonValue {
  return {
    capabilityKind: 'analysis-node',
    analysisNodeKinds: ['reducer'],
    inputDomains: input.inputKind === 'metric-observations'
      ? [{
          inputKind: 'metric-observations',
          valueTypes: ['numeric'],
          missingPolicyIds: ['exclude/v1'],
        }]
      : [{
          inputKind: 'analysis-result',
          schemaUris: [JUDGE_REPLICATE_TABLE_SCHEMA.schemaUri],
        }],
    outputSchema: input.outputSchema,
    parameterSchema: PARAMETERS_SCHEMA,
    inputCardinalities: input.inputKind === 'metric-observations'
      ? {
          metricObservations: { min: 1, max: 1 },
          analysisResults: { min: 0, max: 0 },
          comparisons: { min: 0, max: 0 },
        }
      : {
          metricObservations: { min: 0, max: 0 },
          analysisResults: { min: 1, max: 1 },
          comparisons: { min: 0, max: 0 },
        },
    schemas: input.inputKind === 'analysis-result'
      ? [JUDGE_REPLICATE_TABLE_SCHEMA]
      : [],
  };
}

function runtimeIdentity(
  implementationId: string,
  declaredCapabilities: JsonValue,
): RuntimeIdentity {
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    implementationId,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      implementationId,
      algorithmVersion: ALGORITHM_VERSION,
      rounding: {
        meanDecimals: MEAN_DECIMALS,
        standardDeviationDecimals: STANDARD_DEVIATION_DECIMALS,
        agreementDecimals: AGREEMENT_DECIMALS,
      },
      measurementContract: {
        scoreScale: { min: 1, max: 5 },
        replicateEstimator: 'arithmetic-mean',
        dispersionEstimator: 'sample-standard-deviation-n-minus-one',
        ensembleEstimator: 'equal-member-mean',
        agreementEstimator: 'pairwise-mean-absolute-difference',
        missingPolicyId: 'exclude/v1',
        samplingUnitLineage: 'preserved-from-analysis-metric-rows',
      },
      declaredCapabilities,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: declaredCapabilities,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }));
}

export const JUDGE_REPLICATE_ANALYSIS_IDENTITY = runtimeIdentity(
  JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
  capabilities({
    inputKind: 'metric-observations',
    outputSchema: JUDGE_REPLICATE_TABLE_SCHEMA,
  }),
);
export const JUDGE_ENSEMBLE_ANALYSIS_IDENTITY = runtimeIdentity(
  JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
  capabilities({
    inputKind: 'analysis-result',
    outputSchema: JUDGE_ENSEMBLE_TABLE_SCHEMA,
  }),
);

function metricInput(context: AnalysisNodeExecutionContext): Extract<
  AnalysisNodeInput,
  { inputKind: 'metric-observations' }
> {
  const inputs = context.inputs.filter((input): input is Extract<
    AnalysisNodeInput,
    { inputKind: 'metric-observations' }
  > => input.inputKind === 'metric-observations');
  if (inputs.length !== 1 || context.inputs.length !== 1) {
    throw new TypeError('Judge replicate Analysis requires exactly one Metric input.');
  }
  if (inputs[0].metric.valueType !== 'numeric'
      || inputs[0].metric.scale?.min !== 1
      || inputs[0].metric.scale.max !== 5
      || inputs[0].metric.scale.target !== undefined
      || inputs[0].metric.missingPolicyId !== 'exclude/v1') {
    throw new TypeError('Judge replicate Analysis requires an exclude/v1 numeric [1, 5] Metric.');
  }
  return inputs[0];
}

function rowKey(row: AnalysisMetricRow): string {
  return canonicalizeJson([
    row.targetId,
    row.sampleId,
    row.trialIndex,
    row.trialId,
    row.metricId,
    row.measurement.instrumentId,
    row.measurement.ensembleMemberId,
    row.measurement.replicateGroupId,
  ]);
}

function replicateLineageKey(row: AnalysisMetricRow): JsonValue {
  return [
    row.targetId,
    row.sampleId,
    row.trialIndex,
    row.trialId,
    row.samplingUnitIds,
    row.metricId,
    row.measurement.instrumentId,
    row.measurement.ensembleMemberId,
    row.measurement.replicateGroupId,
  ];
}

function replicateFromRow(row: AnalysisMetricRow): z.infer<typeof ReplicateSchema> {
  const base = {
    rowId: row.rowId,
    evaluatorId: row.evaluatorId,
    replicateIndex: row.measurement.replicateIndex,
    censored: row.censored,
  } as const;
  if (row.rowStatus !== 'observed') {
    return { ...base, rowStatus: row.rowStatus, reasonCode: row.reasonCode };
  }
  if (typeof row.value !== 'number' || !Number.isFinite(row.value)
      || row.value < 1 || row.value > 5) {
    throw new TypeError('Observed rubric reading falls outside the sealed 1-5 scale.');
  }
  return { ...base, rowStatus: 'observed', score: row.value };
}

function buildReplicateTable(
  rows: readonly AnalysisMetricRow[],
  signal: AbortSignal,
): ReplicateTableValue {
  const groups = new Map<string, AnalysisMetricRow[]>();
  for (const row of rows) {
    if (signal.aborted) throw signal.reason;
    const key = rowKey(row);
    const members = groups.get(key) ?? [];
    members.push(row);
    groups.set(key, members);
  }
  const output = [...groups.entries()].sort(([left], [right]) => compareStrings(left, right))
    .map(([, sourceRows]): ReplicateGroup => {
      const orderedRows = [...sourceRows].sort((left, right) => (
        left.measurement.replicateIndex - right.measurement.replicateIndex
        || compareStrings(left.evaluatorId, right.evaluatorId)
      ));
      const first = orderedRows[0];
      if (new Set(orderedRows.map((row) => canonicalizeJson(row.samplingUnitIds))).size !== 1) {
        throw new TypeError('Judge replicate rows disagree on sealed sampling-unit lineage.');
      }
      const replicates = orderedRows.map(replicateFromRow);
      const scores = replicates.flatMap((entry) => (
        entry.rowStatus === 'observed' ? [entry.score] : []
      ));
      const common = {
        groupId: digestCanonicalJson({
          derivation: JUDGE_REPLICATE_TABLE_SCHEMA_VERSION,
          key: replicateLineageKey(first),
          sourceRowIds: replicates.map((entry) => entry.rowId),
        }),
        targetId: first.targetId,
        sampleId: first.sampleId,
        trialIndex: first.trialIndex,
        trialId: first.trialId,
        samplingUnitIds: first.samplingUnitIds,
        metricId: first.metricId,
        instrumentId: first.measurement.instrumentId,
        ensembleMemberId: first.measurement.ensembleMemberId,
        replicateGroupId: first.measurement.replicateGroupId,
        coverage: rowStatusCounts(replicates),
        replicates,
      } as const;
      return scores.length === 0
        ? { ...common, aggregateStatus: 'missing', reasonCode: 'judge-replicates-unobserved' }
        : {
            ...common,
            aggregateStatus: 'observed',
            mean: round(mean(scores), MEAN_DECIMALS),
            sampleStddev: round(sampleStddev(scores), STANDARD_DEVIATION_DECIMALS),
          };
    });
  output.sort((left, right) => compareStrings(replicateGroupKey(left), replicateGroupKey(right)));
  return ReplicateTableValueSchema.parse({
    schemaVersion: JUDGE_REPLICATE_TABLE_SCHEMA_VERSION,
    groups: output,
  });
}

function analysisResultInput(context: AnalysisNodeExecutionContext): Extract<
  AnalysisNodeInput,
  { inputKind: 'analysis-result' }
> {
  const inputs = context.inputs.filter((input): input is Extract<
    AnalysisNodeInput,
    { inputKind: 'analysis-result' }
  > => input.inputKind === 'analysis-result');
  if (inputs.length !== 1 || context.inputs.length !== 1) {
    throw new TypeError('Judge ensemble Analysis requires exactly one replicate table input.');
  }
  if (inputs[0].record.resultType !== 'table'
      || canonicalizeJson(inputs[0].record.outputSchema)
        !== canonicalizeJson(JUDGE_REPLICATE_TABLE_SCHEMA)) {
    throw new TypeError('Judge ensemble Analysis requires the sealed replicate table schema.');
  }
  return inputs[0];
}

function ensembleKey(group: ReplicateGroup): string {
  return canonicalizeJson([
    group.targetId,
    group.sampleId,
    group.trialIndex,
    group.trialId,
    group.metricId,
    group.instrumentId,
    group.replicateGroupId,
  ]);
}

function ensembleLineageKey(group: ReplicateGroup): JsonValue {
  return [
    group.targetId,
    group.sampleId,
    group.trialIndex,
    group.trialId,
    group.samplingUnitIds,
    group.metricId,
    group.instrumentId,
    group.replicateGroupId,
  ];
}

function buildEnsembleTable(
  replicateTable: ReplicateTableValue,
  signal: AbortSignal,
): EnsembleTableValue {
  const groups = new Map<string, ReplicateGroup[]>();
  for (const group of replicateTable.groups) {
    if (signal.aborted) throw signal.reason;
    const key = ensembleKey(group);
    const members = groups.get(key) ?? [];
    members.push(group);
    groups.set(key, members);
  }
  const output = [...groups.entries()].sort(([left], [right]) => compareStrings(left, right))
    .map(([, sourceGroups]): EnsembleGroup => {
      const orderedGroups = [...sourceGroups].sort((left, right) => (
        compareStrings(left.ensembleMemberId, right.ensembleMemberId)
      ));
      const first = orderedGroups[0];
      if (new Set(orderedGroups.map((group) => (
        canonicalizeJson(group.samplingUnitIds)
      ))).size !== 1) {
        throw new TypeError('Judge ensemble members disagree on sealed sampling-unit lineage.');
      }
      const members = orderedGroups.map((group) => {
        const common = {
          ensembleMemberId: group.ensembleMemberId,
          sourceGroupId: group.groupId,
          sourceRowIds: group.replicates.map((entry) => entry.rowId),
          coverage: group.coverage,
        } as const;
        return group.aggregateStatus === 'observed'
          ? {
              ...common,
              memberStatus: 'observed' as const,
              mean: group.mean,
              sampleStddev: group.sampleStddev,
            }
          : {
              ...common,
              memberStatus: 'missing' as const,
              reasonCode: group.reasonCode,
            };
      });
      const memberMeans = members.flatMap((member) => (
        member.memberStatus === 'observed' ? [member.mean] : []
      ));
      const difference = meanAbsDiff(memberMeans);
      const agreement = difference === undefined
        ? {
            agreementStatus: 'missing' as const,
            reasonCode: 'judge-agreement-insufficient-members' as const,
            pairCount: 0 as const,
          }
        : {
            agreementStatus: 'observed' as const,
            meanAbsDiff: round(difference.value, AGREEMENT_DECIMALS),
            pairCount: difference.pairCount,
          };
      const common = {
        groupId: digestCanonicalJson({
          derivation: JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
          key: ensembleLineageKey(first),
          sourceGroupIds: members.map((member) => member.sourceGroupId),
        }),
        targetId: first.targetId,
        sampleId: first.sampleId,
        trialIndex: first.trialIndex,
        trialId: first.trialId,
        samplingUnitIds: first.samplingUnitIds,
        metricId: first.metricId,
        instrumentId: first.instrumentId,
        replicateGroupId: first.replicateGroupId,
        coverage: {
          plannedMembers: members.length,
          observedMembers: members.filter((member) => member.memberStatus === 'observed').length,
          missingMembers: members.filter((member) => member.memberStatus === 'missing').length,
        },
        members,
        agreement,
      } as const;
      return memberMeans.length === 0
        ? { ...common, aggregateStatus: 'missing', reasonCode: 'judge-ensemble-unobserved' }
        : {
            ...common,
            aggregateStatus: 'observed',
            consensus: round(mean(memberMeans), MEAN_DECIMALS),
          };
    });
  output.sort((left, right) => compareStrings(ensembleGroupKey(left), ensembleGroupKey(right)));
  return EnsembleTableValueSchema.parse({
    schemaVersion: JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
    groups: output,
  });
}

export function createJudgeAggregationAnalysisNodes(): ReadonlyMap<
  string,
  AnalysisNodeImplementation
> {
  const replicate = createStatelessAnalysisImplementation({
    identity: JUDGE_REPLICATE_ANALYSIS_IDENTITY,
    outputSchema: JUDGE_REPLICATE_TABLE_SCHEMA,
    parseParameters: (parameters) => { EmptyParametersSchema.parse(parameters ?? {}); },
    execute(context) {
      const input = metricInput(context);
      if (input.rows.length === 0) {
        return {
          analysisStatus: 'inconclusive',
          reasonCodes: ['judge-analysis-no-planned-rows'],
          includedRowIds: [],
          comparableRowIds: [],
          assumptionChecks: [{
            assumptionId: 'judge-replicate-contract',
            checkStatus: 'failed',
            reasonCode: 'judge-analysis-no-planned-rows',
          }],
        };
      }
      const table = buildReplicateTable(input.rows, context.signal);
      const includedRowIds = input.rows.flatMap((row) => (
        row.rowStatus === 'observed' ? [row.rowId] : []
      )).sort(compareStrings);
      return {
        analysisStatus: 'completed',
        resultType: 'table',
        value: table,
        includedRowIds,
        comparableRowIds: includedRowIds,
        assumptionChecks: [{
          assumptionId: 'judge-replicate-contract',
          checkStatus: 'passed',
        }],
      };
    },
  });
  const ensemble = createStatelessAnalysisImplementation({
    identity: JUDGE_ENSEMBLE_ANALYSIS_IDENTITY,
    outputSchema: JUDGE_ENSEMBLE_TABLE_SCHEMA,
    parseParameters: (parameters) => { EmptyParametersSchema.parse(parameters ?? {}); },
    execute(context) {
      const input = analysisResultInput(context);
      const parsed = ReplicateEnvelopeSchema.parse({
        resultType: input.record.resultType,
        value: input.record.value,
      });
      const table = buildEnsembleTable(parsed.value, context.signal);
      return {
        analysisStatus: 'completed',
        resultType: 'table',
        value: table,
        includedRowIds: [],
        comparableRowIds: [],
        assumptionChecks: [{
          assumptionId: 'judge-ensemble-contract',
          checkStatus: 'passed',
        }],
      };
    },
  });
  return new Map([
    [JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, replicate],
    [JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID, ensemble],
  ]);
}

export function createJudgeAggregationSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validators = [
    createAnalysisSchemaValidator(
      JUDGE_REPLICATE_TABLE_SCHEMA,
      (value) => ReplicateEnvelopeSchema.parse(value) as JsonValue,
    ),
    createAnalysisSchemaValidator(
      JUDGE_ENSEMBLE_TABLE_SCHEMA,
      (value) => EnsembleEnvelopeSchema.parse(value) as JsonValue,
    ),
    createAnalysisSchemaValidator(
      PARAMETERS_SCHEMA,
      (value) => EmptyParametersSchema.parse(value) as JsonValue,
    ),
  ];
  return new Map(validators.map((candidate) => [
    schemaIdentityKey(candidate.schema),
    candidate,
  ]));
}

export function parseJudgeEnsembleTableEnvelope(value: unknown): Readonly<{
  resultType: 'table';
  value: JudgeEnsembleTableValue;
}> {
  return EnsembleEnvelopeSchema.parse(value);
}
