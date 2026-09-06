import { z } from 'zod';
import {
  drawBootstrapIndependentDifferences,
  drawBootstrapPairedDifferences,
  summarizeBootstrapMetric,
  type BootstrapDifferenceDraws,
} from '../../analysis/bootstrap.js';
import { clopperPearsonInterval } from '../../analysis/binomial-confidence.js';
import {
  canonicalizeJson,
  schemaIdentityKey,
  Sha256DigestSchema,
  type CoreSchemaValidationContext,
  type CoreSchemaValidator,
  type JsonValue,
} from '../../../eval-core/contracts/index.js';
import {
  analysisJsonSchema,
  analysisSchemaIdentity,
  createAnalysisSchemaValidator,
  round,
} from './analysis-support.js';
import {
  BootstrapComparisonParameterSchema,
  BootstrapFamilyParametersSchema,
} from './bootstrap-family-parameters.js';
import {
  BootstrapIntervalSchema,
  BootstrapObservationSchema,
  BootstrapTargetIntervalSchema,
  ComparisonCountsSchema,
  prepareBootstrapFamilyFacts,
  type BootstrapObservation,
} from './bootstrap-family-table.js';

export const BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA_VERSION =
  'omk.bootstrap-family-table/v2' as const;
export const BOOTSTRAP_MONTE_CARLO_FAMILY_CONFIDENCE_LEVEL = 0.99;
export const BOOTSTRAP_MONTE_CARLO_METHOD_ID =
  'omk.clopper-pearson-bonferroni/v1' as const;
export const BOOTSTRAP_EXACT_SUPPORT_METHOD_ID =
  'omk.exact-resampling-support/v1' as const;
const MONTE_CARLO_DECIMALS = 12;

const CountSchema = z.number().int().nonnegative().safe();
const ProbabilitySchema = z.number().finite().min(0).max(1).refine(
  (value) => round(value, MONTE_CARLO_DECIMALS) === value,
  { message: 'Monte Carlo probabilities must use twelve-decimal precision.' },
);

const SignificanceEvidenceBaseSchema = z.object({
  significanceThreshold: z.number().finite().gt(0).lt(0.5),
});

const ZeroEstimateEvidenceSchema = SignificanceEvidenceBaseSchema.extend({
  evidenceKind: z.literal('zero-point-estimate'),
  significanceStatus: z.literal('not-significant'),
  direction: z.literal('none'),
}).strict();

const ExactSupportEvidenceSchema = SignificanceEvidenceBaseSchema.extend({
  evidenceKind: z.literal('exact-resampling-support'),
  significanceStatus: z.literal('significant'),
  direction: z.enum(['positive', 'negative']),
  supportMethodId: z.literal(BOOTSTRAP_EXACT_SUPPORT_METHOD_ID),
}).strict();

const MonteCarloTailEvidenceSchema = SignificanceEvidenceBaseSchema.extend({
  evidenceKind: z.literal('monte-carlo-tail'),
  significanceStatus: z.enum(['significant', 'not-significant', 'indeterminate']),
  direction: z.enum(['positive', 'negative']),
  tailKind: z.enum(['non-positive', 'non-negative']),
  tailCount: CountSchema,
  tailProbability: ProbabilitySchema,
  monteCarloMethodId: z.literal(BOOTSTRAP_MONTE_CARLO_METHOD_ID),
  familyConfidenceLevel: z.number().finite().gt(0).lt(1),
  comparisonConfidenceLevel: z.number().finite().gt(0).lt(1),
  probabilityInterval: z.object({
    lower: ProbabilitySchema,
    upper: ProbabilitySchema,
  }).strict(),
}).strict();

const SignificanceEvidenceSchema = z.discriminatedUnion('evidenceKind', [
  ZeroEstimateEvidenceSchema,
  ExactSupportEvidenceSchema,
  MonteCarloTailEvidenceSchema,
]);

const ObservedComparisonV2Schema = z.object({
  binding: BootstrapComparisonParameterSchema,
  comparisonStatus: z.literal('observed'),
  counts: ComparisonCountsSchema,
  includedSourceGroupIds: z.array(Sha256DigestSchema).min(1),
  effectiveAlpha: z.number().finite().gt(0).lt(1),
  interval: BootstrapIntervalSchema,
  significance: SignificanceEvidenceSchema,
}).strict();

const MissingComparisonV2Schema = z.object({
  binding: BootstrapComparisonParameterSchema,
  comparisonStatus: z.literal('missing'),
  counts: ComparisonCountsSchema,
  includedSourceGroupIds: z.tuple([]),
  reasonCode: z.enum([
    'bootstrap-no-complete-pairs',
    'bootstrap-comparison-side-unobserved',
  ]),
}).strict();

const BootstrapComparisonV2Schema = z.discriminatedUnion('comparisonStatus', [
  ObservedComparisonV2Schema,
  MissingComparisonV2Schema,
]);

const BootstrapFamilyTableV2ValueSchema = z.object({
  schemaVersion: z.literal(BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA_VERSION),
  configuration: BootstrapFamilyParametersSchema,
  observations: z.array(BootstrapObservationSchema),
  targetIntervals: z.array(BootstrapTargetIntervalSchema).min(1),
  comparisons: z.array(BootstrapComparisonV2Schema),
  family: z.object({
    plannedComparisons: CountSchema,
    observedComparisons: CountSchema,
    missingComparisons: CountSchema,
    nominalAlpha: z.number().finite().gt(0).lt(1),
    effectiveAlpha: z.number().finite().gt(0).lt(1).nullable(),
    monteCarloFamilyConfidenceLevel: z.number().finite().gt(0).lt(1),
  }).strict(),
}).strict();

export type BootstrapSignificanceEvidence = z.infer<typeof SignificanceEvidenceSchema>;
export type BootstrapComparisonV2 = z.infer<typeof BootstrapComparisonV2Schema>;
export type BootstrapFamilyTableV2Value = z.infer<typeof BootstrapFamilyTableV2ValueSchema>;

function roundedProbability(value: number): number {
  return round(value, MONTE_CARLO_DECIMALS);
}

function lowerProbability(value: number): number {
  const scale = 10 ** MONTE_CARLO_DECIMALS;
  return Math.floor(value * scale) / scale;
}

function upperProbability(value: number): number {
  const scale = 10 ** MONTE_CARLO_DECIMALS;
  return Math.ceil(value * scale) / scale;
}

export function bootstrapSignificanceEvidence(input: Readonly<{
  distribution: BootstrapDifferenceDraws;
  effectiveAlpha: number;
  plannedComparisons: number;
}>): BootstrapSignificanceEvidence {
  const { distribution, effectiveAlpha, plannedComparisons } = input;
  if (distribution.draws.length === 0 || plannedComparisons < 1) {
    throw new TypeError('Bootstrap significance evidence requires draws and a planned family.');
  }
  const direction = distribution.estimate > 0
    ? 'positive' as const
    : distribution.estimate < 0 ? 'negative' as const : 'none' as const;
  const threshold = effectiveAlpha / 2;
  if (direction === 'none') {
    return {
      evidenceKind: 'zero-point-estimate',
      significanceStatus: 'not-significant',
      direction,
      significanceThreshold: threshold,
    };
  }
  const tailKind = direction === 'positive' ? 'non-positive' as const : 'non-negative' as const;
  const tailCount = distribution.draws.filter((draw) => (
    direction === 'positive' ? draw <= 0 : draw >= 0
  )).length;
  if (distribution.exactSign === direction) {
    return {
      evidenceKind: 'exact-resampling-support',
      significanceStatus: 'significant',
      direction,
      significanceThreshold: threshold,
      supportMethodId: BOOTSTRAP_EXACT_SUPPORT_METHOD_ID,
    };
  }
  const comparisonConfidenceLevel = 1
    - (1 - BOOTSTRAP_MONTE_CARLO_FAMILY_CONFIDENCE_LEVEL) / plannedComparisons;
  const rawInterval = clopperPearsonInterval(
    tailCount,
    distribution.draws.length,
    comparisonConfidenceLevel,
  );
  const probabilityInterval = {
    lower: lowerProbability(rawInterval.lower),
    upper: upperProbability(rawInterval.upper),
  };
  return {
    evidenceKind: 'monte-carlo-tail',
    significanceStatus: probabilityInterval.upper < threshold
      ? 'significant'
      : probabilityInterval.lower >= threshold ? 'not-significant' : 'indeterminate',
    direction,
    tailKind,
    tailCount,
    tailProbability: roundedProbability(tailCount / distribution.draws.length),
    significanceThreshold: threshold,
    monteCarloMethodId: BOOTSTRAP_MONTE_CARLO_METHOD_ID,
    familyConfidenceLevel: BOOTSTRAP_MONTE_CARLO_FAMILY_CONFIDENCE_LEVEL,
    comparisonConfidenceLevel,
    probabilityInterval,
  };
}

function interval(
  estimate: ReturnType<typeof summarizeBootstrapMetric>,
  alpha: number,
): z.infer<typeof BootstrapIntervalSchema> {
  return {
    lower: estimate.low,
    upper: estimate.high,
    estimate: estimate.estimate,
    samples: estimate.samples,
    confidenceLevel: 1 - alpha,
  };
}

export function buildBootstrapFamilyTableV2(
  rawParameters: unknown,
  rawObservations: readonly BootstrapObservation[],
): BootstrapFamilyTableV2Value {
  const prepared = prepareBootstrapFamilyFacts(rawParameters, rawObservations);
  const {
    parameters,
    observations,
    targetIntervals,
    comparisons: facts,
  } = prepared;
  const plannedComparisons = facts.length;
  const observedComparisons = facts.filter((entry) => entry.observed).length;
  const effectiveAlpha = plannedComparisons === 0 ? null : parameters.alpha / plannedComparisons;
  const comparisons: BootstrapComparisonV2[] = facts.map((entry) => {
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
    const distribution = entry.binding.comparisonDesign === 'paired'
      ? drawBootstrapPairedDifferences(entry.pairs, parameters.resamples, parameters.seed)
      : drawBootstrapIndependentDifferences(
        entry.controlValues,
        entry.treatmentValues,
        parameters.resamples,
        parameters.seed,
      );
    const estimate = summarizeBootstrapMetric(
      distribution.estimate,
      distribution.draws,
      effectiveAlpha,
      parameters.resamples,
    );
    return {
      binding: entry.binding,
      comparisonStatus: 'observed',
      counts: entry.counts,
      includedSourceGroupIds: entry.includedSourceGroupIds,
      effectiveAlpha,
      interval: interval(estimate, effectiveAlpha),
      significance: bootstrapSignificanceEvidence({
        distribution,
        effectiveAlpha,
        plannedComparisons,
      }),
    };
  });
  return BootstrapFamilyTableV2ValueSchema.parse({
    schemaVersion: BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA_VERSION,
    configuration: parameters,
    observations,
    targetIntervals,
    comparisons,
    family: {
      plannedComparisons,
      observedComparisons,
      missingComparisons: plannedComparisons - observedComparisons,
      nominalAlpha: parameters.alpha,
      effectiveAlpha,
      monteCarloFamilyConfidenceLevel: BOOTSTRAP_MONTE_CARLO_FAMILY_CONFIDENCE_LEVEL,
    },
  });
}

function validateBootstrapFamilyTableV2(
  value: BootstrapFamilyTableV2Value,
  context: z.RefinementCtx,
): void {
  let expected: BootstrapFamilyTableV2Value;
  try {
    expected = buildBootstrapFamilyTableV2(value.configuration, value.observations);
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
      message: 'Bootstrap family v2 table is not canonically ordered or recomputable.',
    });
  }
}

const BootstrapFamilyTableV2EnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: BootstrapFamilyTableV2ValueSchema,
}).strict().superRefine((envelope, context) => {
  validateBootstrapFamilyTableV2(envelope.value, context);
});

export const BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA = analysisSchemaIdentity(
  BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA_VERSION,
  'urn:omk:analysis-result:bootstrap-family-table:v2',
  analysisJsonSchema(BootstrapFamilyTableV2EnvelopeSchema, [
    'planned comparisons determine K before outcomes or missingness are observed',
    'every comparison uses nominal alpha divided by planned K',
    'four-decimal percentile intervals are descriptive and never decide significance',
    'significance uses the unrounded deterministic draw stream and its relevant zero tail',
    'finite-resample tail uncertainty uses an exact Clopper-Pearson interval',
    'Bonferroni allocation gives tail intervals a simultaneous family confidence of 99 percent',
    'a tail interval crossing alpha over two produces indeterminate rather than significance',
    'strictly signed resampling support proves significance without Monte Carlo approximation',
    'all observations, lineage, family coverage, intervals, and significance evidence recompute',
  ]),
);

export function parseBootstrapFamilyTableV2Envelope(value: unknown): Readonly<{
  resultType: 'table';
  value: BootstrapFamilyTableV2Value;
}> {
  return BootstrapFamilyTableV2EnvelopeSchema.parse(value);
}

function validateSealedConfiguration(
  value: unknown,
  context?: Readonly<CoreSchemaValidationContext>,
): JsonValue {
  const parsed = parseBootstrapFamilyTableV2Envelope(value);
  if (context?.validationKind !== 'analysis-output') {
    throw new TypeError('Bootstrap Analysis output validation requires sealed node parameters.');
  }
  const expected = buildBootstrapFamilyTableV2(context.parameters, parsed.value.observations);
  if (canonicalizeJson(parsed.value) !== canonicalizeJson(expected)) {
    throw new TypeError('Bootstrap v2 table does not match sealed node parameters.');
  }
  return parsed as JsonValue;
}

export function createBootstrapFamilyTableV2SchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
    validateSealedConfiguration,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}
