import { z } from 'zod';
import {
  bootstrapDiffCI,
  bootstrapMeanCI,
  bootstrapPairedDiffCI,
} from '../../../shared/statistics/bootstrap.js';
import {
  IdentifierSchema,
  SamplingUnitIdsSchema,
  Sha256DigestSchema,
  canonicalizeJson,
  schemaIdentityKey,
  type CoreSchemaValidationContext,
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
import {
  BootstrapComparisonParameterSchema,
  BootstrapFamilyParametersSchema,
  parseBootstrapFamilyParameters,
  type BootstrapComparisonParameter,
  type BootstrapFamilyParameters,
} from './bootstrap-family-parameters.js';

export const BOOTSTRAP_FAMILY_TABLE_SCHEMA_VERSION = 'omk.bootstrap-family-table/v1' as const;
export const BOOTSTRAP_INTERVAL_DECIMALS = 4;

const CountSchema = z.number().int().nonnegative().safe();
const PositiveCountSchema = z.number().int().positive().safe();
const ScoreSchema = z.number().finite().min(1).max(5).refine(
  (value) => round(value, 2) === value,
  { message: 'Bootstrap source scores must use Composite two-decimal precision.' },
);
const RoundedStatisticSchema = z.number().finite().refine(
  (value) => round(value, BOOTSTRAP_INTERVAL_DECIMALS) === value,
  { message: 'Bootstrap interval statistics must use four-decimal precision.' },
);

const BootstrapObservationBaseSchema = z.object({
  sourceGroupId: Sha256DigestSchema,
  targetId: IdentifierSchema,
  sampleId: IdentifierSchema,
  trialIndex: CountSchema,
  trialId: Sha256DigestSchema,
  samplingUnitIds: SamplingUnitIdsSchema,
});

const ObservedBootstrapObservationSchema = BootstrapObservationBaseSchema.extend({
  observationStatus: z.literal('observed'),
  score: ScoreSchema,
}).strict();

const MissingBootstrapObservationSchema = BootstrapObservationBaseSchema.extend({
  observationStatus: z.literal('missing'),
  reasonCode: z.literal('composite-unobserved'),
}).strict();

export const BootstrapObservationSchema = z.discriminatedUnion('observationStatus', [
  ObservedBootstrapObservationSchema,
  MissingBootstrapObservationSchema,
]);

const BootstrapIntervalSchema = z.object({
  lower: RoundedStatisticSchema,
  upper: RoundedStatisticSchema,
  estimate: RoundedStatisticSchema,
  samples: CountSchema,
  confidenceLevel: z.number().finite().gt(0).lt(1),
}).strict();

const ObservedTargetIntervalSchema = z.object({
  targetId: IdentifierSchema,
  intervalStatus: z.literal('observed'),
  unitCount: PositiveCountSchema,
  sourceGroupIds: z.array(Sha256DigestSchema).min(1),
  interval: BootstrapIntervalSchema,
}).strict();

const MissingTargetIntervalSchema = z.object({
  targetId: IdentifierSchema,
  intervalStatus: z.literal('missing'),
  reasonCode: z.literal('bootstrap-no-observed-units'),
  unitCount: z.literal(0),
  sourceGroupIds: z.tuple([]),
}).strict();

const BootstrapTargetIntervalSchema = z.discriminatedUnion('intervalStatus', [
  ObservedTargetIntervalSchema,
  MissingTargetIntervalSchema,
]);

const ComparisonCountsSchema = z.object({
  controlUnits: CountSchema,
  treatmentUnits: CountSchema,
  comparableUnits: CountSchema.nullable(),
}).strict();

const ObservedComparisonSchema = z.object({
  binding: BootstrapComparisonParameterSchema,
  comparisonStatus: z.literal('observed'),
  counts: ComparisonCountsSchema,
  includedSourceGroupIds: z.array(Sha256DigestSchema).min(1),
  effectiveAlpha: z.number().finite().gt(0).lt(1),
  interval: BootstrapIntervalSchema.extend({ significant: z.boolean() }).strict(),
}).strict();

const MissingComparisonSchema = z.object({
  binding: BootstrapComparisonParameterSchema,
  comparisonStatus: z.literal('missing'),
  counts: ComparisonCountsSchema,
  includedSourceGroupIds: z.tuple([]),
  reasonCode: z.enum([
    'bootstrap-no-complete-pairs',
    'bootstrap-comparison-side-unobserved',
  ]),
}).strict();

const BootstrapComparisonSchema = z.discriminatedUnion('comparisonStatus', [
  ObservedComparisonSchema,
  MissingComparisonSchema,
]);

const BootstrapFamilyCoverageSchema = z.object({
  plannedComparisons: CountSchema,
  observedComparisons: CountSchema,
  missingComparisons: CountSchema,
  nominalAlpha: z.number().finite().gt(0).lt(1),
  effectiveAlpha: z.number().finite().gt(0).lt(1).nullable(),
}).strict();

const BootstrapFamilyTableValueSchema = z.object({
  schemaVersion: z.literal(BOOTSTRAP_FAMILY_TABLE_SCHEMA_VERSION),
  configuration: BootstrapFamilyParametersSchema,
  observations: z.array(BootstrapObservationSchema),
  targetIntervals: z.array(BootstrapTargetIntervalSchema).min(1),
  comparisons: z.array(BootstrapComparisonSchema),
  family: BootstrapFamilyCoverageSchema,
}).strict();

export type BootstrapObservation = z.infer<typeof BootstrapObservationSchema>;
type ObservedBootstrapObservation = z.infer<typeof ObservedBootstrapObservationSchema>;
export type BootstrapTargetInterval = z.infer<typeof BootstrapTargetIntervalSchema>;
export type BootstrapComparison = z.infer<typeof BootstrapComparisonSchema>;
export type BootstrapFamilyTableValue = z.infer<typeof BootstrapFamilyTableValueSchema>;

interface ResamplingUnit {
  value: number;
  sourceGroupIds: string[];
}

interface ComparisonFacts {
  binding: BootstrapComparisonParameter;
  counts: z.infer<typeof ComparisonCountsSchema>;
  includedSourceGroupIds: string[];
  controlValues: number[];
  treatmentValues: number[];
  pairs: Array<{ a: number; b: number }>;
  observed: boolean;
}

function isObservedObservation(
  observation: BootstrapObservation,
): observation is ObservedBootstrapObservation {
  return observation.observationStatus === 'observed';
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function observationCoordinate(observation: BootstrapObservation): string {
  return canonicalizeJson([
    observation.targetId,
    observation.sampleId,
    observation.trialIndex,
    observation.trialId,
  ]);
}

function compareObservations(
  parameters: BootstrapFamilyParameters,
  left: BootstrapObservation,
  right: BootstrapObservation,
): number {
  const targetOrder = new Map(parameters.targetIds.map((targetId, index) => [targetId, index]));
  const sampleOrder = new Map(parameters.sampleIds.map((sampleId, index) => [sampleId, index]));
  const targetDifference = (targetOrder.get(left.targetId) ?? -1)
    - (targetOrder.get(right.targetId) ?? -1);
  if (targetDifference !== 0) return targetDifference;
  const sampleDifference = (sampleOrder.get(left.sampleId) ?? -1)
    - (sampleOrder.get(right.sampleId) ?? -1);
  if (sampleDifference !== 0) return sampleDifference;
  if (left.trialIndex !== right.trialIndex) return left.trialIndex - right.trialIndex;
  return compareStrings(left.sourceGroupId, right.sourceGroupId);
}

function parseObservations(
  parameters: BootstrapFamilyParameters,
  observations: readonly BootstrapObservation[],
): BootstrapObservation[] {
  const parsed = observations.map((observation) => BootstrapObservationSchema.parse(observation));
  const targets = new Set(parameters.targetIds);
  const samples = new Set(parameters.sampleIds);
  for (const observation of parsed) {
    if (!targets.has(observation.targetId) || !samples.has(observation.sampleId)) {
      throw new TypeError('Bootstrap observations must belong to sealed targets and samples.');
    }
  }
  const sourceGroupIds = parsed.map((observation) => observation.sourceGroupId);
  const coordinates = parsed.map(observationCoordinate);
  if (new Set(sourceGroupIds).size !== sourceGroupIds.length) {
    throw new TypeError('Bootstrap source group identities must be globally unique.');
  }
  if (new Set(coordinates).size !== coordinates.length) {
    throw new TypeError('Bootstrap observation coordinates must be globally unique.');
  }
  return parsed.sort((left, right) => compareObservations(parameters, left, right));
}

function sampleUnits(
  parameters: BootstrapFamilyParameters,
  observations: readonly BootstrapObservation[],
  targetId: string,
): ResamplingUnit[] {
  return parameters.sampleIds.flatMap((sampleId) => {
    const members = observations.filter(isObservedObservation).filter((observation) => (
      observation.targetId === targetId && observation.sampleId === sampleId
    ));
    return members.length === 0 ? [] : [{
      value: mean(members.map((member) => member.score)),
      sourceGroupIds: members.map((member) => member.sourceGroupId),
    }];
  });
}

function pairedFacts(
  parameters: BootstrapFamilyParameters,
  observations: readonly BootstrapObservation[],
  binding: BootstrapComparisonParameter,
): ComparisonFacts {
  const blocks = new Map<string, BootstrapObservation[]>();
  for (const observation of observations) {
    if (!isObservedObservation(observation)) continue;
    if (observation.targetId !== binding.controlTargetId
        && observation.targetId !== binding.treatmentTargetId) continue;
    const blockId = observation.samplingUnitIds.pairingBlockId;
    if (blockId === undefined) continue;
    const members = blocks.get(blockId) ?? [];
    members.push(observation);
    blocks.set(blockId, members);
  }
  let controlUnits = 0;
  let treatmentUnits = 0;
  const pairs: Array<{ a: number; b: number }> = [];
  const includedSourceGroupIds: string[] = [];
  const sampleOrder = new Map(parameters.sampleIds.map((sampleId, index) => [sampleId, index]));
  const blockOrder = ([blockId, members]: [string, BootstrapObservation[]]): [number, string] => [
    Math.min(...members.map((member) => sampleOrder.get(member.sampleId) ?? Number.MAX_SAFE_INTEGER)),
    blockId,
  ];
  for (const [, members] of [...blocks.entries()].sort((left, right) => {
    const leftOrder = blockOrder(left);
    const rightOrder = blockOrder(right);
    return leftOrder[0] - rightOrder[0] || compareStrings(leftOrder[1], rightOrder[1]);
  })) {
    const observedMembers = members.filter(isObservedObservation);
    const control = observedMembers.filter(
      (member) => member.targetId === binding.controlTargetId,
    );
    const treatment = observedMembers.filter(
      (member) => member.targetId === binding.treatmentTargetId,
    );
    if (control.length > 0) controlUnits += 1;
    if (treatment.length > 0) treatmentUnits += 1;
    if (control.length === 0 || treatment.length === 0) continue;
    pairs.push({
      a: mean(control.map((member) => member.score)),
      b: mean(treatment.map((member) => member.score)),
    });
    includedSourceGroupIds.push(
      ...control.map((member) => member.sourceGroupId),
      ...treatment.map((member) => member.sourceGroupId),
    );
  }
  return {
    binding,
    counts: { controlUnits, treatmentUnits, comparableUnits: pairs.length },
    includedSourceGroupIds,
    controlValues: [],
    treatmentValues: [],
    pairs,
    observed: pairs.length > 0,
  };
}

function independentFacts(
  parameters: BootstrapFamilyParameters,
  observations: readonly BootstrapObservation[],
  binding: BootstrapComparisonParameter,
): ComparisonFacts {
  const control = sampleUnits(parameters, observations, binding.controlTargetId);
  const treatment = sampleUnits(parameters, observations, binding.treatmentTargetId);
  return {
    binding,
    counts: {
      controlUnits: control.length,
      treatmentUnits: treatment.length,
      comparableUnits: null,
    },
    includedSourceGroupIds: [
      ...control.flatMap((unit) => unit.sourceGroupIds),
      ...treatment.flatMap((unit) => unit.sourceGroupIds),
    ],
    controlValues: control.map((unit) => unit.value),
    treatmentValues: treatment.map((unit) => unit.value),
    pairs: [],
    observed: control.length > 0 && treatment.length > 0,
  };
}

function interval(value: Readonly<{
  low: number;
  high: number;
  estimate: number;
  samples: number;
}>, alpha: number): z.infer<typeof BootstrapIntervalSchema> {
  return {
    lower: value.low,
    upper: value.high,
    estimate: value.estimate,
    samples: value.samples,
    confidenceLevel: 1 - alpha,
  };
}

export function buildBootstrapFamilyTable(
  rawParameters: unknown,
  rawObservations: readonly BootstrapObservation[],
): BootstrapFamilyTableValue {
  const parameters = parseBootstrapFamilyParameters(rawParameters);
  const observations = parseObservations(parameters, rawObservations);
  const targetIntervals: BootstrapTargetInterval[] = parameters.targetIds.map((targetId) => {
    const units = sampleUnits(parameters, observations, targetId);
    if (units.length === 0) {
      return {
        targetId,
        intervalStatus: 'missing',
        reasonCode: 'bootstrap-no-observed-units',
        unitCount: 0,
        sourceGroupIds: [],
      };
    }
    const estimate = bootstrapMeanCI(
      units.map((unit) => unit.value),
      parameters.alpha,
      parameters.resamples,
      parameters.seed,
    );
    return {
      targetId,
      intervalStatus: 'observed',
      unitCount: units.length,
      sourceGroupIds: units.flatMap((unit) => unit.sourceGroupIds),
      interval: interval(estimate, parameters.alpha),
    };
  });
  const facts = parameters.comparisons.map((binding) => (
    binding.comparisonDesign === 'paired'
      ? pairedFacts(parameters, observations, binding)
      : independentFacts(parameters, observations, binding)
  ));
  const familySize = facts.filter((entry) => entry.observed).length;
  const effectiveAlpha = familySize === 0 ? null : parameters.alpha / familySize;
  const comparisons: BootstrapComparison[] = facts.map((entry) => {
    if (!entry.observed || effectiveAlpha === null) {
      return {
        binding: entry.binding,
        comparisonStatus: 'missing',
        counts: entry.counts,
        includedSourceGroupIds: [],
        reasonCode: entry.binding.comparisonDesign === 'paired'
          ? 'bootstrap-no-complete-pairs'
          : 'bootstrap-comparison-side-unobserved',
      };
    }
    const estimate = entry.binding.comparisonDesign === 'paired'
      ? bootstrapPairedDiffCI(
        entry.pairs,
        effectiveAlpha,
        parameters.resamples,
        parameters.seed,
      )
      : bootstrapDiffCI(
        entry.controlValues,
        entry.treatmentValues,
        effectiveAlpha,
        parameters.resamples,
        parameters.seed,
      );
    return {
      binding: entry.binding,
      comparisonStatus: 'observed',
      counts: entry.counts,
      includedSourceGroupIds: entry.includedSourceGroupIds,
      effectiveAlpha,
      interval: {
        ...interval(estimate, effectiveAlpha),
        significant: estimate.significant,
      },
    };
  });
  return {
    schemaVersion: BOOTSTRAP_FAMILY_TABLE_SCHEMA_VERSION,
    configuration: parameters,
    observations,
    targetIntervals,
    comparisons,
    family: {
      plannedComparisons: comparisons.length,
      observedComparisons: familySize,
      missingComparisons: comparisons.length - familySize,
      nominalAlpha: parameters.alpha,
      effectiveAlpha,
    },
  };
}

function validateBootstrapFamilyTable(
  value: BootstrapFamilyTableValue,
  context: z.RefinementCtx,
): void {
  let expected: BootstrapFamilyTableValue;
  try {
    expected = buildBootstrapFamilyTable(value.configuration, value.observations);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      path: ['observations'],
      message: error instanceof Error ? error.message : 'Bootstrap observations are invalid.',
    });
    return;
  }
  if (canonicalizeJson(value) !== canonicalizeJson(expected)) {
    context.addIssue({
      code: 'custom',
      path: [],
      message: 'Bootstrap family table is not canonically ordered or statistically recomputable.',
    });
  }
}

const BootstrapFamilyTableEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: BootstrapFamilyTableValueSchema,
}).strict().superRefine((envelope, context) => {
  validateBootstrapFamilyTable(envelope.value, context);
});

export const BOOTSTRAP_FAMILY_TABLE_SCHEMA = analysisSchemaIdentity(
  BOOTSTRAP_FAMILY_TABLE_SCHEMA_VERSION,
  'urn:omk:analysis-result:bootstrap-family-table:v1',
  analysisJsonSchema(BootstrapFamilyTableEnvelopeSchema, [
    'configuration exactly records the sealed Composite source, target and sample order, comparisons, resamples, alpha, and random stream',
    'observations preserve every present Composite group as observed or explicit missing evidence',
    'repeated trials are averaged within the sealed sample resampling unit before estimation',
    'paired comparisons align only by pairingBlockId and never fall back to independent sampling',
    'independent comparisons resample sealed control and treatment sample units separately',
    'the observed comparison family determines K before every interval uses nominal alpha divided by K',
    'Mulberry32 draws, linearly interpolated percentile bounds, four-decimal rounding, and rounded-bound significance match the legacy estimator',
    'one mean unit yields a point interval with zero resamples and one complete pair performs the sealed resample count',
    'zero observed units or comparable units produces structured missing rather than a numeric zero sentinel',
    'all target intervals, comparison intervals, coverage, ordering, and source-group lineage are recomputable from the table',
  ]),
);

export function parseBootstrapFamilyTableValue(value: unknown): BootstrapFamilyTableValue {
  return BootstrapFamilyTableValueSchema.superRefine(validateBootstrapFamilyTable).parse(value);
}

export function parseBootstrapFamilyTableEnvelope(value: unknown): Readonly<{
  resultType: 'table';
  value: BootstrapFamilyTableValue;
}> {
  return BootstrapFamilyTableEnvelopeSchema.parse(value);
}

function validateSealedConfiguration(
  value: unknown,
  context?: Readonly<CoreSchemaValidationContext>,
): JsonValue {
  const parsed = parseBootstrapFamilyTableEnvelope(value);
  if (context?.validationKind !== 'analysis-output') {
    throw new TypeError('Bootstrap Analysis output validation requires sealed node parameters.');
  }
  const sealed = parseBootstrapFamilyParameters(context.parameters);
  if (canonicalizeJson(parsed.value.configuration) !== canonicalizeJson(sealed)) {
    throw new TypeError('Bootstrap table configuration does not match sealed node parameters.');
  }
  return parsed as JsonValue;
}

export function createBootstrapFamilyTableSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    BOOTSTRAP_FAMILY_TABLE_SCHEMA,
    validateSealedConfiguration,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}
