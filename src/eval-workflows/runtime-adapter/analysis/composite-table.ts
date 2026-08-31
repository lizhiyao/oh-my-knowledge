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
} from '../../../evaluation-core/contracts/index.js';
import {
  analysisJsonSchema,
  analysisSchemaIdentity,
  compareStrings,
  createAnalysisSchemaValidator,
  round,
} from './analysis-support.js';
import {
  CompositeLayerParameterSchema,
  type CompositeLayerParameter,
} from './composite-parameters.js';

export const COMPOSITE_TABLE_SCHEMA_VERSION = 'omk.composite-table/v1' as const;
export const COMPOSITE_SCORE_DECIMALS = 2;
export const COMPOSITE_SCORE_MIN = 1;
export const COMPOSITE_SCORE_MAX = 5;

const CountSchema = z.number().int().nonnegative().safe();
const PositiveCountSchema = z.number().int().positive().safe();
const ScoreSchema = z.number().finite()
  .min(COMPOSITE_SCORE_MIN)
  .max(COMPOSITE_SCORE_MAX)
  .refine((value) => round(value, COMPOSITE_SCORE_DECIMALS) === value, {
    message: 'Composite layer scores must use the sealed two-decimal precision.',
  });

const CompositeLayerEntryBaseSchema = z.object({
  binding: CompositeLayerParameterSchema,
  sourceGroupId: Sha256DigestSchema,
});

const ObservedCompositeLayerEntrySchema = CompositeLayerEntryBaseSchema.extend({
  layerStatus: z.literal('observed'),
  score: ScoreSchema,
}).strict();

const MissingCompositeLayerEntrySchema = CompositeLayerEntryBaseSchema.extend({
  layerStatus: z.literal('missing'),
  reasonCode: IdentifierSchema,
}).strict();

const CompositeLayerEntrySchema = z.discriminatedUnion('layerStatus', [
  ObservedCompositeLayerEntrySchema,
  MissingCompositeLayerEntrySchema,
]);

const CompositeCoverageSchema = z.object({
  plannedLayers: PositiveCountSchema,
  observedLayers: CountSchema,
  missingLayers: CountSchema,
}).strict();

const ObservedCompositeAggregateSchema = z.object({
  aggregateStatus: z.literal('observed'),
  score: ScoreSchema,
}).strict();

const MissingCompositeAggregateSchema = z.object({
  aggregateStatus: z.literal('missing'),
  reasonCode: z.literal('composite-unobserved'),
}).strict();

const CompositeAggregateSchema = z.discriminatedUnion('aggregateStatus', [
  ObservedCompositeAggregateSchema,
  MissingCompositeAggregateSchema,
]);

const CompositeGroupSchema = z.object({
  groupId: Sha256DigestSchema,
  targetId: IdentifierSchema,
  sampleId: IdentifierSchema,
  trialIndex: CountSchema,
  trialId: Sha256DigestSchema,
  samplingUnitIds: SamplingUnitIdsSchema,
  layers: z.array(CompositeLayerEntrySchema).min(1).max(3),
  coverage: CompositeCoverageSchema,
  aggregate: CompositeAggregateSchema,
}).strict();

const CompositeTableValueSchema = z.object({
  schemaVersion: z.literal(COMPOSITE_TABLE_SCHEMA_VERSION),
  groups: z.array(CompositeGroupSchema).min(1),
}).strict();

export type CompositeLayerEntry = z.infer<typeof CompositeLayerEntrySchema>;
export type CompositeCoverage = z.infer<typeof CompositeCoverageSchema>;
export type CompositeAggregate = z.infer<typeof CompositeAggregateSchema>;
export type CompositeGroup = z.infer<typeof CompositeGroupSchema>;
export type CompositeTableValue = z.infer<typeof CompositeTableValueSchema>;
type Issue = (path: Array<string | number>, message: string) => void;

const LAYER_ORDER: Readonly<Record<CompositeLayerParameter['layerId'], number>> = {
  fact: 0,
  behavior: 1,
  judge: 2,
};

const MISSING_REASON_BY_SELECTOR: Readonly<Record<
  CompositeLayerParameter['selector'],
  string
>> = {
  fact: 'assertion-layer-unobserved',
  behavior: 'assertion-layer-unobserved',
  consensus: 'judge-ensemble-unobserved',
  aggregate: 'dimension-unobserved',
};

function unitKey(value: Pick<CompositeGroup,
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

export function compareCompositeLayerEntries(
  left: CompositeLayerEntry,
  right: CompositeLayerEntry,
): number {
  return LAYER_ORDER[left.binding.layerId] - LAYER_ORDER[right.binding.layerId];
}

export function compositeCoverage(entries: readonly CompositeLayerEntry[]): CompositeCoverage {
  const observedLayers = entries.filter((entry) => entry.layerStatus === 'observed').length;
  return {
    plannedLayers: entries.length,
    observedLayers,
    missingLayers: entries.length - observedLayers,
  };
}

export function compositeAggregate(entries: readonly CompositeLayerEntry[]): CompositeAggregate {
  const scores = entries.flatMap((entry) => (
    entry.layerStatus === 'observed' ? [entry.score] : []
  ));
  if (scores.length === 0) {
    return { aggregateStatus: 'missing', reasonCode: 'composite-unobserved' };
  }
  return {
    aggregateStatus: 'observed',
    score: round(
      scores.reduce((sum, score) => sum + score, 0) / scores.length,
      COMPOSITE_SCORE_DECIMALS,
    ),
  };
}

export function compositeGroupId(group: Omit<CompositeGroup, 'groupId'>): string {
  return digestCanonicalJson({
    derivation: COMPOSITE_TABLE_SCHEMA_VERSION,
    key: JSON.parse(unitKey(group)) as JsonValue,
    layers: group.layers.map((entry) => ({
      binding: entry.binding,
      sourceGroupId: entry.sourceGroupId,
    })),
  });
}

function validateCompositeTable(value: CompositeTableValue, issue: Issue): void {
  const groupKeys = value.groups.map(unitKey);
  if (new Set(groupKeys).size !== groupKeys.length
      || canonicalizeJson(groupKeys)
        !== canonicalizeJson([...groupKeys].sort(compareStrings))) {
    issue(['groups'], 'Composite groups must be unique and canonically ordered.');
  }
  const bindings = new Map<string, string>();
  const sourceSelectors = new Set<string>();
  for (const [groupIndex, group] of value.groups.entries()) {
    const layerIds = group.layers.map((entry) => entry.binding.layerId);
    if (new Set(layerIds).size !== layerIds.length
        || canonicalizeJson(layerIds)
          !== canonicalizeJson([...layerIds].sort((left, right) => (
            LAYER_ORDER[left] - LAYER_ORDER[right]
          )))) {
      issue(['groups', groupIndex, 'layers'], 'Composite layers must be unique and ordered.');
    }
    for (const [entryIndex, entry] of group.layers.entries()) {
      const binding = canonicalizeJson(entry.binding);
      const previous = bindings.get(entry.binding.layerId);
      if (previous !== undefined && previous !== binding) {
        issue(
          ['groups', groupIndex, 'layers', entryIndex, 'binding'],
          'Composite layer binding must remain stable across groups.',
        );
      }
      bindings.set(entry.binding.layerId, binding);
      const sourceSelector = canonicalizeJson([
        entry.binding.analysisResultId,
        entry.sourceGroupId,
        entry.binding.selector,
      ]);
      if (sourceSelectors.has(sourceSelector)) {
        issue(
          ['groups', groupIndex, 'layers', entryIndex, 'sourceGroupId'],
          'Composite source group selector lineage must be globally unique.',
        );
      }
      sourceSelectors.add(sourceSelector);
      if (entry.layerStatus === 'missing'
          && entry.reasonCode !== MISSING_REASON_BY_SELECTOR[entry.binding.selector]) {
        issue(
          ['groups', groupIndex, 'layers', entryIndex, 'reasonCode'],
          'Composite missing reason must match the selected upstream aggregate.',
        );
      }
    }
    if (canonicalizeJson(group.coverage)
        !== canonicalizeJson(compositeCoverage(group.layers))) {
      issue(['groups', groupIndex, 'coverage'], 'Composite coverage is not recomputable.');
    }
    if (canonicalizeJson(group.aggregate)
        !== canonicalizeJson(compositeAggregate(group.layers))) {
      issue(['groups', groupIndex, 'aggregate'], 'Composite score is not recomputable.');
    }
    if (group.groupId !== compositeGroupId(group)) {
      issue(['groups', groupIndex, 'groupId'], 'Composite group identity does not match lineage.');
    }
  }
}

const CompositeTableEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: CompositeTableValueSchema,
}).strict().superRefine((envelope, context) => {
  validateCompositeTable(envelope.value, (path, message) => {
    context.addIssue({ code: 'custom', path: ['value', ...path], message });
  });
});

export const COMPOSITE_TABLE_SCHEMA = analysisSchemaIdentity(
  COMPOSITE_TABLE_SCHEMA_VERSION,
  'urn:omk:analysis-result:composite-table:v1',
  analysisJsonSchema(CompositeTableEnvelopeSchema, [
    'groups and layer entries are unique and canonically ordered',
    'fact, behavior, and judge bindings remain stable across groups',
    'source Analysis result, group, and selector lineage is explicit and unique',
    'only layers represented by an upstream group are planned for a measurement unit',
    'missing reason codes exactly match the selected upstream aggregate',
    'coverage exactly conserves observed and missing layer entries',
    'layer scores use the sealed 1-5 scale and 2-decimal precision',
    'the aggregate is the equal mean of observed layer scores rounded to 2 decimals',
    'zero observed layers produces missing rather than numeric zero',
    'groupId binds the sampling unit, layer design, and upstream Analysis lineage',
    'raw evidence, usage, cost, and direct Metric row membership are not copied',
  ]),
);

export function parseCompositeTableValue(value: unknown): CompositeTableValue {
  return CompositeTableValueSchema.parse(value);
}

export function compareCompositeGroups(left: CompositeGroup, right: CompositeGroup): number {
  return compareStrings(unitKey(left), unitKey(right));
}

export function createCompositeTableSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    COMPOSITE_TABLE_SCHEMA,
    (value) => CompositeTableEnvelopeSchema.parse(value) as JsonValue,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}
