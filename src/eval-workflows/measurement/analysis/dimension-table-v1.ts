import { z } from 'zod';
import { IdentifierSchema, SamplingUnitIdsSchema, Sha256DigestSchema, canonicalizeJson, digestCanonicalJson, type JsonValue } from '../../../eval-core/contracts/index.js';
import { analysisJsonSchema, analysisSchemaIdentity, compareStrings, round } from './analysis-support.js';

export const DIMENSION_TABLE_SCHEMA_VERSION = 'omk.dimension-table/v1' as const;
export const DIMENSION_SCORE_DECIMALS = 2;
export const DIMENSION_SCORE_MIN = 1;
export const DIMENSION_SCORE_MAX = 5;

const CountSchema = z.number().int().nonnegative().safe();
const PositiveCountSchema = z.number().int().positive().safe();
const ScoreSchema = z.number().finite()
  .min(DIMENSION_SCORE_MIN)
  .max(DIMENSION_SCORE_MAX)
  .refine((value) => round(value, DIMENSION_SCORE_DECIMALS) === value, {
    message: 'Dimension scores must use the sealed two-decimal precision.',
  });

const DimensionEntryBaseSchema = z.object({
  dimensionId: IdentifierSchema,
  metricId: IdentifierSchema,
  sourceAnalysisResultId: IdentifierSchema,
  sourceGroupId: Sha256DigestSchema,
});

const ObservedDimensionEntrySchema = DimensionEntryBaseSchema.extend({
  dimensionStatus: z.literal('observed'),
  consensus: ScoreSchema,
}).strict();

const MissingDimensionEntrySchema = DimensionEntryBaseSchema.extend({
  dimensionStatus: z.literal('missing'),
  reasonCode: z.literal('judge-ensemble-unobserved'),
}).strict();

const DimensionEntrySchema = z.discriminatedUnion('dimensionStatus', [
  ObservedDimensionEntrySchema,
  MissingDimensionEntrySchema,
]);

const DimensionCoverageSchema = z.object({
  plannedDimensions: PositiveCountSchema,
  observedDimensions: CountSchema,
  missingDimensions: CountSchema,
}).strict();

const ObservedDimensionAggregateSchema = z.object({
  aggregateStatus: z.literal('observed'),
  mean: ScoreSchema,
}).strict();

const MissingDimensionAggregateSchema = z.object({
  aggregateStatus: z.literal('missing'),
  reasonCode: z.literal('dimension-unobserved'),
}).strict();

const DimensionAggregateSchema = z.discriminatedUnion('aggregateStatus', [
  ObservedDimensionAggregateSchema,
  MissingDimensionAggregateSchema,
]);

const DimensionGroupSchema = z.object({
  groupId: Sha256DigestSchema,
  targetId: IdentifierSchema,
  sampleId: IdentifierSchema,
  trialIndex: CountSchema,
  trialId: Sha256DigestSchema,
  samplingUnitIds: SamplingUnitIdsSchema,
  dimensions: z.array(DimensionEntrySchema).min(1),
  coverage: DimensionCoverageSchema,
  aggregate: DimensionAggregateSchema,
}).strict();

const DimensionTableValueSchema = z.object({
  schemaVersion: z.literal(DIMENSION_TABLE_SCHEMA_VERSION),
  groups: z.array(DimensionGroupSchema).min(1),
}).strict();

export type DimensionEntry = z.infer<typeof DimensionEntrySchema>;
export type DimensionCoverage = z.infer<typeof DimensionCoverageSchema>;
export type DimensionAggregate = z.infer<typeof DimensionAggregateSchema>;
export type DimensionGroup = z.infer<typeof DimensionGroupSchema>;
export type DimensionTableValue = z.infer<typeof DimensionTableValueSchema>;
type Issue = (path: Array<string | number>, message: string) => void;

function unitKey(value: Pick<DimensionGroup,
  'targetId' | 'sampleId' | 'trialIndex' | 'trialId' | 'samplingUnitIds'
>): string {
  return canonicalizeJson([
    value.targetId,
    value.sampleId,
    value.trialIndex,
    value.trialId,
    value.samplingUnitIds,
  ]);
}

function entryKey(entry: Pick<DimensionEntry,
  'sourceAnalysisResultId' | 'metricId' | 'dimensionId'
>): string {
  return canonicalizeJson([
    entry.sourceAnalysisResultId,
    entry.metricId,
    entry.dimensionId,
  ]);
}

export function dimensionCoverage(entries: readonly DimensionEntry[]): DimensionCoverage {
  const observedDimensions = entries.filter((entry) => (
    entry.dimensionStatus === 'observed'
  )).length;
  return {
    plannedDimensions: entries.length,
    observedDimensions,
    missingDimensions: entries.length - observedDimensions,
  };
}

export function dimensionAggregate(entries: readonly DimensionEntry[]): DimensionAggregate {
  const values = entries.flatMap((entry) => (
    entry.dimensionStatus === 'observed' ? [entry.consensus] : []
  ));
  if (values.length === 0) {
    return { aggregateStatus: 'missing', reasonCode: 'dimension-unobserved' };
  }
  return {
    aggregateStatus: 'observed',
    mean: round(
      values.reduce((sum, value) => sum + value, 0) / values.length,
      DIMENSION_SCORE_DECIMALS,
    ),
  };
}

export function dimensionGroupId(group: Omit<DimensionGroup, 'groupId'>): string {
  return digestCanonicalJson({
    derivation: DIMENSION_TABLE_SCHEMA_VERSION,
    key: JSON.parse(unitKey(group)) as JsonValue,
    dimensions: group.dimensions.map((entry) => ({
      dimensionId: entry.dimensionId,
      metricId: entry.metricId,
      sourceAnalysisResultId: entry.sourceAnalysisResultId,
      sourceGroupId: entry.sourceGroupId,
    })),
  });
}

function assertStableBinding(
  entries: readonly DimensionEntry[],
  keyField: 'dimensionId' | 'metricId' | 'sourceAnalysisResultId',
  issue: Issue,
): void {
  const bindings = new Map<string, string>();
  for (const entry of entries) {
    const binding = canonicalizeJson({
      dimensionId: entry.dimensionId,
      metricId: entry.metricId,
      sourceAnalysisResultId: entry.sourceAnalysisResultId,
    });
    const previous = bindings.get(entry[keyField]);
    if (previous !== undefined && previous !== binding) {
      issue(['groups'], `Dimension ${keyField} binding must remain stable across groups.`);
      return;
    }
    bindings.set(entry[keyField], binding);
  }
}

function validateDimensionTable(value: DimensionTableValue, issue: Issue): void {
  const groupKeys = value.groups.map(unitKey);
  if (new Set(groupKeys).size !== groupKeys.length
      || canonicalizeJson(groupKeys)
        !== canonicalizeJson([...groupKeys].sort(compareStrings))) {
    issue(['groups'], 'Dimension groups must be unique and canonically ordered.');
  }
  const allEntries = value.groups.flatMap((group) => group.dimensions);
  for (const field of ['dimensionId', 'metricId', 'sourceAnalysisResultId'] as const) {
    assertStableBinding(allEntries, field, issue);
  }
  const sourceGroupIds = allEntries.map((entry) => entry.sourceGroupId);
  if (new Set(sourceGroupIds).size !== sourceGroupIds.length) {
    issue(['groups'], 'Dimension source group identities must be globally unique.');
  }
  for (const [groupIndex, group] of value.groups.entries()) {
    const entryKeys = group.dimensions.map(entryKey);
    if (new Set(entryKeys).size !== entryKeys.length
        || canonicalizeJson(entryKeys)
          !== canonicalizeJson([...entryKeys].sort(compareStrings))) {
      issue(
        ['groups', groupIndex, 'dimensions'],
        'Dimension entries must be unique and canonically ordered.',
      );
    }
    if (canonicalizeJson(group.coverage)
        !== canonicalizeJson(dimensionCoverage(group.dimensions))) {
      issue(['groups', groupIndex, 'coverage'], 'Dimension coverage is not recomputable.');
    }
    if (canonicalizeJson(group.aggregate)
        !== canonicalizeJson(dimensionAggregate(group.dimensions))) {
      issue(['groups', groupIndex, 'aggregate'], 'Dimension mean is not recomputable.');
    }
    if (group.groupId !== dimensionGroupId(group)) {
      issue(['groups', groupIndex, 'groupId'], 'Dimension group identity does not match lineage.');
    }
  }
}

const DimensionTableEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: DimensionTableValueSchema,
}).strict().superRefine((envelope, context) => {
  validateDimensionTable(envelope.value, (path, message) => {
    context.addIssue({ code: 'custom', path: ['value', ...path], message });
  });
});

export const DIMENSION_TABLE_SCHEMA = analysisSchemaIdentity(
  DIMENSION_TABLE_SCHEMA_VERSION,
  'urn:omk:analysis-result:dimension-table:v1',
  analysisJsonSchema(DimensionTableEnvelopeSchema, [
    'groups and dimension entries are unique and canonically ordered',
    'dimension, metric, and upstream Analysis result bindings remain stable across groups',
    'source ensemble group identities are globally unique',
    'only dimensions represented by an upstream group are planned for a measurement unit',
    'coverage exactly conserves observed and missing dimension entries',
    'source consensus scores use the sealed 2-decimal precision',
    'the aggregate is the equal mean of observed 1-5 consensus scores rounded to 2 decimals',
    'zero observed dimensions produces missing rather than numeric zero',
    'groupId binds the sampling unit, dimension design, and upstream Analysis lineage',
    'raw judge evidence, usage, cost, and direct Metric row membership are not copied',
  ]),
);

export function parseDimensionTableEnvelope(value: unknown): Readonly<{
  resultType: 'table';
  value: DimensionTableValue;
}> {
  return DimensionTableEnvelopeSchema.parse(value);
}
