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
import { AssertionLayerDispositionSchema } from './assertion-layer-parameters.js';

export const ASSERTION_LAYER_TABLE_SCHEMA_VERSION =
  'omk.assertion-layer-table/v1' as const;

export const ASSERTION_LAYER_SCORE_DECIMALS = 2;
export const ASSERTION_LAYER_SCORE_MIN = 1;
export const ASSERTION_LAYER_SCORE_MAX = 5;
export const ASSERTION_NOT_APPLICABLE_REASON = 'criterion-not-applicable' as const;

const CountSchema = z.number().int().nonnegative().safe();
const FiniteNonnegativeSchema = z.number().finite().nonnegative();
const PositiveWeightSchema = z.number().finite().positive();
const UnobservedRowStatusSchema = z.enum([
  'missing',
  'invalid',
  'evaluation-failed',
  'source-unavailable',
  'not-started',
]);
const EntryBaseSchema = z.object({
  criterionId: IdentifierSchema,
  metricId: IdentifierSchema,
  layerDisposition: AssertionLayerDispositionSchema,
  weight: PositiveWeightSchema,
  rowId: Sha256DigestSchema,
  evaluatorId: IdentifierSchema,
  censored: z.boolean(),
});

const ObservedEntrySchema = EntryBaseSchema.extend({
  applicability: z.literal('applicable'),
  rowStatus: z.literal('observed'),
  value: z.boolean(),
}).strict();

const NotApplicableEntrySchema = EntryBaseSchema.extend({
  applicability: z.literal('not-applicable'),
  rowStatus: z.literal('missing'),
  censored: z.literal(false),
  reasonCode: z.literal(ASSERTION_NOT_APPLICABLE_REASON),
}).strict();

const UnobservedEntrySchema = EntryBaseSchema.extend({
  applicability: z.literal('applicable'),
  rowStatus: UnobservedRowStatusSchema,
  reasonCode: IdentifierSchema,
}).strict();

const AssertionEntrySchema = z.union([
  ObservedEntrySchema,
  NotApplicableEntrySchema,
  UnobservedEntrySchema,
]);

const CoverageSchema = z.object({
  declaredCriteria: CountSchema,
  declaredWeight: FiniteNonnegativeSchema,
  notApplicableCriteria: CountSchema,
  notApplicableWeight: FiniteNonnegativeSchema,
  applicableCriteria: CountSchema,
  plannedWeight: FiniteNonnegativeSchema,
  observedCriteria: CountSchema,
  observedWeight: FiniteNonnegativeSchema,
  passedWeight: FiniteNonnegativeSchema,
  missingCriteria: CountSchema,
  missingWeight: FiniteNonnegativeSchema,
  invalidCriteria: CountSchema,
  invalidWeight: FiniteNonnegativeSchema,
  evaluationFailedCriteria: CountSchema,
  evaluationFailedWeight: FiniteNonnegativeSchema,
  sourceUnavailableCriteria: CountSchema,
  sourceUnavailableWeight: FiniteNonnegativeSchema,
  notStartedCriteria: CountSchema,
  notStartedWeight: FiniteNonnegativeSchema,
  censoredCriteria: CountSchema,
  censoredWeight: FiniteNonnegativeSchema,
}).strict();

const LayerBaseSchema = z.object({ coverage: CoverageSchema }).strict();
const ObservedLayerSchema = LayerBaseSchema.extend({
  layerStatus: z.literal('observed'),
  score: z.number().finite().min(ASSERTION_LAYER_SCORE_MIN).max(ASSERTION_LAYER_SCORE_MAX),
}).strict();
const MissingLayerSchema = LayerBaseSchema.extend({
  layerStatus: z.literal('missing'),
  reasonCode: z.literal('assertion-layer-unobserved'),
}).strict();
const LayerSchema = z.discriminatedUnion('layerStatus', [
  ObservedLayerSchema,
  MissingLayerSchema,
]);

const GroupSchema = z.object({
  groupId: Sha256DigestSchema,
  targetId: IdentifierSchema,
  sampleId: IdentifierSchema,
  trialIndex: CountSchema,
  trialId: Sha256DigestSchema,
  samplingUnitIds: SamplingUnitIdsSchema,
  entries: z.array(AssertionEntrySchema).min(1),
  layers: z.object({
    fact: LayerSchema,
    behavior: LayerSchema,
  }).strict(),
  excludedMixedLayer: z.object({ coverage: CoverageSchema }).strict(),
}).strict();

const AssertionLayerTableValueSchema = z.object({
  schemaVersion: z.literal(ASSERTION_LAYER_TABLE_SCHEMA_VERSION),
  groups: z.array(GroupSchema).min(1),
}).strict();

export type AssertionEntry = z.infer<typeof AssertionEntrySchema>;
export type AssertionLayerGroup = z.infer<typeof GroupSchema>;
export type AssertionLayerTableValue = z.infer<typeof AssertionLayerTableValueSchema>;
export type AssertionLayerCoverage = z.infer<typeof CoverageSchema>;
type Issue = (path: Array<string | number>, message: string) => void;

function unitKey(value: Pick<AssertionLayerGroup,
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

function entryKey(entry: Pick<AssertionEntry, 'metricId' | 'criterionId'>): string {
  return canonicalizeJson([entry.metricId, entry.criterionId]);
}

function criterionDesignKey(entries: readonly AssertionEntry[]): string {
  return canonicalizeJson(entries.map((entry) => ({
    criterionId: entry.criterionId,
    metricId: entry.metricId,
    layerDisposition: entry.layerDisposition,
    weight: entry.weight,
  })));
}

function emptyCoverage(): AssertionLayerCoverage {
  return {
    declaredCriteria: 0,
    declaredWeight: 0,
    notApplicableCriteria: 0,
    notApplicableWeight: 0,
    applicableCriteria: 0,
    plannedWeight: 0,
    observedCriteria: 0,
    observedWeight: 0,
    passedWeight: 0,
    missingCriteria: 0,
    missingWeight: 0,
    invalidCriteria: 0,
    invalidWeight: 0,
    evaluationFailedCriteria: 0,
    evaluationFailedWeight: 0,
    sourceUnavailableCriteria: 0,
    sourceUnavailableWeight: 0,
    notStartedCriteria: 0,
    notStartedWeight: 0,
    censoredCriteria: 0,
    censoredWeight: 0,
  };
}

export function assertionLayerCoverage(
  entries: readonly AssertionEntry[],
): AssertionLayerCoverage {
  const coverage = emptyCoverage();
  for (const entry of entries) {
    coverage.declaredCriteria += 1;
    coverage.declaredWeight += entry.weight;
    if (entry.applicability === 'not-applicable') {
      coverage.notApplicableCriteria += 1;
      coverage.notApplicableWeight += entry.weight;
      continue;
    }
    coverage.applicableCriteria += 1;
    coverage.plannedWeight += entry.weight;
    if (entry.censored) {
      coverage.censoredCriteria += 1;
      coverage.censoredWeight += entry.weight;
    }
    if (entry.rowStatus === 'observed') {
      coverage.observedCriteria += 1;
      coverage.observedWeight += entry.weight;
      if (entry.value) coverage.passedWeight += entry.weight;
      continue;
    }
    const prefix = entry.rowStatus === 'evaluation-failed'
      ? 'evaluationFailed'
      : entry.rowStatus === 'source-unavailable'
        ? 'sourceUnavailable'
        : entry.rowStatus === 'not-started'
          ? 'notStarted'
          : entry.rowStatus;
    const countKey = `${prefix}Criteria` as keyof AssertionLayerCoverage;
    const weightKey = `${prefix}Weight` as keyof AssertionLayerCoverage;
    coverage[countKey] += 1;
    coverage[weightKey] += entry.weight;
  }
  return coverage;
}

export function assertionLayerAggregate(
  entries: readonly AssertionEntry[],
): z.infer<typeof LayerSchema> {
  const coverage = assertionLayerCoverage(entries);
  if (coverage.observedWeight === 0) {
    return {
      layerStatus: 'missing',
      reasonCode: 'assertion-layer-unobserved',
      coverage,
    };
  }
  return {
    layerStatus: 'observed',
    score: round(
      ASSERTION_LAYER_SCORE_MIN
        + (coverage.passedWeight / coverage.observedWeight)
          * (ASSERTION_LAYER_SCORE_MAX - ASSERTION_LAYER_SCORE_MIN),
      ASSERTION_LAYER_SCORE_DECIMALS,
    ),
    coverage,
  };
}

export function assertionLayerGroupId(group: Omit<AssertionLayerGroup, 'groupId'>): string {
  return digestCanonicalJson({
    derivation: ASSERTION_LAYER_TABLE_SCHEMA_VERSION,
    key: JSON.parse(unitKey(group)) as JsonValue,
    criteria: group.entries.map((entry) => ({
      criterionId: entry.criterionId,
      metricId: entry.metricId,
      layerDisposition: entry.layerDisposition,
      weight: entry.weight,
      rowId: entry.rowId,
    })),
  });
}

function validateAssertionLayerTable(value: AssertionLayerTableValue, issue: Issue): void {
  const groupKeys = value.groups.map(unitKey);
  if (new Set(groupKeys).size !== groupKeys.length
      || canonicalizeJson(groupKeys)
        !== canonicalizeJson([...groupKeys].sort(compareStrings))) {
    issue(['groups'], 'Assertion-layer groups must be unique and canonically ordered.');
  }
  const rowIds = value.groups.flatMap((group) => group.entries.map((entry) => entry.rowId));
  if (new Set(rowIds).size !== rowIds.length) {
    issue(['groups'], 'Assertion source row identities must be globally unique.');
  }
  const sealedCriterionDesign = criterionDesignKey(value.groups[0].entries);
  for (const [groupIndex, group] of value.groups.entries()) {
    const entryKeys = group.entries.map(entryKey);
    if (new Set(entryKeys).size !== entryKeys.length
        || canonicalizeJson(entryKeys)
          !== canonicalizeJson([...entryKeys].sort(compareStrings))) {
      issue(['groups', groupIndex, 'entries'], 'Assertion entries must be unique and sorted.');
    }
    if (criterionDesignKey(group.entries) !== sealedCriterionDesign) {
      issue(
        ['groups', groupIndex, 'entries'],
        'Every measurement group must use the same sealed criterion design.',
      );
    }
    const fact = group.entries.filter((entry) => entry.layerDisposition === 'fact');
    const behavior = group.entries.filter((entry) => entry.layerDisposition === 'behavior');
    const excluded = group.entries.filter((entry) => (
      entry.layerDisposition === 'excluded-mixed-layer'
    ));
    if (canonicalizeJson(group.layers.fact) !== canonicalizeJson(assertionLayerAggregate(fact))) {
      issue(['groups', groupIndex, 'layers', 'fact'], 'Fact score or coverage is not recomputable.');
    }
    if (canonicalizeJson(group.layers.behavior)
        !== canonicalizeJson(assertionLayerAggregate(behavior))) {
      issue(
        ['groups', groupIndex, 'layers', 'behavior'],
        'Behavior score or coverage is not recomputable.',
      );
    }
    if (canonicalizeJson(group.excludedMixedLayer.coverage)
        !== canonicalizeJson(assertionLayerCoverage(excluded))) {
      issue(
        ['groups', groupIndex, 'excludedMixedLayer', 'coverage'],
        'Excluded mixed-layer coverage is not recomputable.',
      );
    }
    if (group.groupId !== assertionLayerGroupId(group)) {
      issue(['groups', groupIndex, 'groupId'], 'Assertion-layer identity does not match lineage.');
    }
  }
}

const AssertionLayerEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: AssertionLayerTableValueSchema,
}).strict().superRefine((envelope, context) => {
  validateAssertionLayerTable(envelope.value, (path, message) => {
    context.addIssue({ code: 'custom', path: ['value', ...path], message });
  });
});

export const ASSERTION_LAYER_TABLE_SCHEMA = analysisSchemaIdentity(
  ASSERTION_LAYER_TABLE_SCHEMA_VERSION,
  'urn:omk:analysis-result:assertion-layer-table:v1',
  analysisJsonSchema(AssertionLayerEnvelopeSchema, [
    'groups and criterion entries are unique and canonically ordered',
    'sampling-unit lineage is identical across every criterion in a measurement unit',
    'criterion identity, metric identity, layer disposition, and positive weight are explicit',
    'every measurement group uses the same sealed criterion design',
    'criterion-not-applicable is structural and excluded from planned and observed coverage',
    'coverage exactly conserves every applicable source row status and weight',
    'mixed-layer criteria remain visible but are excluded from fact and behavior scores',
    'fact and behavior scores map observed weighted pass ratio onto 1-5 and round to 2 decimals',
    'zero observed weight produces a missing layer rather than numeric zero',
    'groupId binds the sampling unit, criterion design, and source row lineage',
  ]),
);

export function parseAssertionLayerTableValue(value: unknown): AssertionLayerTableValue {
  return AssertionLayerTableValueSchema.parse(value);
}

export function compareAssertionLayerGroups(
  left: AssertionLayerGroup,
  right: AssertionLayerGroup,
): number {
  return compareStrings(unitKey(left), unitKey(right));
}

export function createAssertionLayerTableSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    ASSERTION_LAYER_TABLE_SCHEMA,
    (value) => parseAssertionLayerTableEnvelope(value) as JsonValue,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}

export function parseAssertionLayerTableEnvelope(value: unknown): Readonly<{
  resultType: 'table';
  value: AssertionLayerTableValue;
}> {
  return AssertionLayerEnvelopeSchema.parse(value);
}
