import { z } from 'zod';
import {
  IdentifierSchema,
  SamplingUnitIdsSchema,
  Sha256DigestSchema,
  canonicalizeJson,
  digestCanonicalJson,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type JsonValue,
} from '../../../eval-core/contracts/index.js';
import {
  analysisJsonSchema,
  analysisSchemaIdentity,
  compareStrings,
  createAnalysisSchemaValidator,
  round,
} from './analysis-support.js';

export const DIMENSION_TABLE_SCHEMA_VERSION = 'omk.dimension-table/v2' as const;
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
  weight: z.number().finite().positive().max(1),
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
  weightedMean: ScoreSchema,
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
  if (entries.some((entry) => entry.dimensionStatus === 'missing')) {
    return { aggregateStatus: 'missing', reasonCode: 'dimension-unobserved' };
  }
  const weightSum = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (Math.abs(weightSum - 1) > 1e-9) {
    return { aggregateStatus: 'missing', reasonCode: 'dimension-unobserved' };
  }
  return {
    aggregateStatus: 'observed',
    weightedMean: round(
      entries.reduce((sum, entry) => (
        sum + (entry.dimensionStatus === 'observed' ? entry.consensus * entry.weight : 0)
      ), 0),
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
      weight: entry.weight,
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

function assertStableSampleWeights(groups: readonly DimensionGroup[], issue: Issue): void {
  const weights = new Map<string, number>();
  for (const group of groups) {
    for (const entry of group.dimensions) {
      const key = canonicalizeJson([group.sampleId, entry.dimensionId]);
      const previous = weights.get(key);
      if (previous !== undefined && previous !== entry.weight) {
        issue(['groups'], 'Dimension weight must remain stable for each sample and dimension.');
        return;
      }
      weights.set(key, entry.weight);
    }
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
  assertStableSampleWeights(value.groups, issue);
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
      issue(['groups', groupIndex, 'aggregate'], 'Dimension weighted mean is not recomputable.');
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
  'urn:omk:analysis-result:dimension-table:v2',
  analysisJsonSchema(DimensionTableEnvelopeSchema, [
    'groups and dimension entries are unique and canonically ordered',
    'dimension, metric, and upstream Analysis result bindings remain stable across groups',
    'each sample and dimension weight remains stable across targets and trials',
    'source ensemble group identities are globally unique',
    'every planned dimension and weight is sealed before execution',
    'coverage exactly conserves observed and missing dimension entries',
    'source consensus scores use the sealed 2-decimal precision',
    'the aggregate is the weighted mean of all planned 1-5 consensus scores rounded to 2 decimals',
    'any missing planned dimension or invalid weight sum fails closed to a missing aggregate',
    'groupId binds the sampling unit, dimension design, and upstream Analysis lineage',
    'raw judge evidence, usage, cost, and direct Metric row membership are not copied',
  ]),
);

export function parseDimensionTableValue(value: unknown): DimensionTableValue {
  return DimensionTableValueSchema.parse(value);
}

export function compareDimensionGroups(left: DimensionGroup, right: DimensionGroup): number {
  return compareStrings(unitKey(left), unitKey(right));
}

export function createDimensionTableSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    DIMENSION_TABLE_SCHEMA,
    (value) => parseDimensionTableEnvelope(value) as JsonValue,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}

export function parseDimensionTableEnvelope(value: unknown): Readonly<{
  resultType: 'table';
  value: DimensionTableValue;
}> {
  return DimensionTableEnvelopeSchema.parse(value);
}
