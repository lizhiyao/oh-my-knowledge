import { z } from 'zod';
import {
  drawBootstrapMetric,
  summarizeBootstrapMetric,
} from '../../analysis/bootstrap.js';
import {
  computeKrippendorffAlpha,
  computePearson,
  computeWeightedKappa,
  type RatingPair,
} from '../../gold/human.js';
import {
  IdentifierSchema,
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
  createAnalysisSchemaValidator,
} from './analysis-support.js';
import {
  AgreementParametersSchema,
  parseAgreementParameters,
  type AgreementParameters,
} from './agreement-parameters.js';

export const AGREEMENT_TABLE_SCHEMA_VERSION = 'omk.agreement-table/v1' as const;
export const AGREEMENT_STATISTIC_DECIMALS = 4;

const CountSchema = z.number().int().nonnegative().safe();
const PositiveCountSchema = z.number().int().positive().safe();
const RatingSchema = z.number().finite();
const RoundedStatisticSchema = z.number().finite().refine(
  (value) => Math.round(value * 10 ** AGREEMENT_STATISTIC_DECIMALS)
    / 10 ** AGREEMENT_STATISTIC_DECIMALS === value,
  { message: 'Agreement statistics must use four-decimal precision.' },
);

const ObservedGoldRatingSchema = z.object({
  ratingStatus: z.literal('observed'),
  score: RatingSchema,
}).strict();

const UnavailableGoldRatingSchema = z.object({
  ratingStatus: z.literal('unavailable'),
  reasonCode: z.literal('gold-rating-unavailable'),
}).strict();

const GoldRatingSchema = z.discriminatedUnion('ratingStatus', [
  ObservedGoldRatingSchema,
  UnavailableGoldRatingSchema,
]);

const JudgeCoverageSchema = z.object({
  plannedGroups: CountSchema,
  observedGroups: CountSchema,
  missingGroups: CountSchema,
}).strict();

const ObservedJudgeRatingSchema = z.object({
  ratingStatus: z.literal('observed'),
  score: RatingSchema,
  sourceGroupIds: z.array(Sha256DigestSchema).min(1),
  coverage: JudgeCoverageSchema,
}).strict();

const MissingJudgeRatingSchema = z.object({
  ratingStatus: z.literal('missing'),
  reasonCode: z.literal('dimension-unobserved'),
  sourceGroupIds: z.array(Sha256DigestSchema).min(1),
  coverage: JudgeCoverageSchema,
}).strict();

const UnavailableJudgeRatingSchema = z.object({
  ratingStatus: z.literal('unavailable'),
  reasonCode: z.literal('dimension-group-unavailable'),
  sourceGroupIds: z.tuple([]),
  coverage: z.object({
    plannedGroups: z.literal(0),
    observedGroups: z.literal(0),
    missingGroups: z.literal(0),
  }).strict(),
}).strict();

const JudgeRatingSchema = z.discriminatedUnion('ratingStatus', [
  ObservedJudgeRatingSchema,
  MissingJudgeRatingSchema,
  UnavailableJudgeRatingSchema,
]);

export const AgreementPairSchema = z.object({
  sampleId: IdentifierSchema,
  gold: GoldRatingSchema,
  judge: JudgeRatingSchema,
}).strict();

const AgreementCoverageSchema = z.object({
  plannedPairs: PositiveCountSchema,
  comparablePairs: CountSchema,
  goldObservedPairs: CountSchema,
  goldUnavailablePairs: CountSchema,
  judgeObservedPairs: CountSchema,
  judgeMissingPairs: CountSchema,
  judgeUnavailablePairs: CountSchema,
}).strict();

const ObservedStatisticSchema = z.object({
  statisticStatus: z.literal('observed'),
  value: RoundedStatisticSchema,
}).strict();

const MissingStatisticSchema = z.object({
  statisticStatus: z.literal('missing'),
  reasonCode: z.enum([
    'agreement-insufficient-pairs',
    'agreement-zero-expected-disagreement',
    'agreement-statistic-undefined',
  ]),
}).strict();

const AgreementStatisticSchema = z.discriminatedUnion('statisticStatus', [
  ObservedStatisticSchema,
  MissingStatisticSchema,
]);

const DrawCoverageSchema = z.object({
  plannedDraws: PositiveCountSchema,
  observedDraws: CountSchema,
  missingDraws: CountSchema,
}).strict();

const ObservedAlphaIntervalSchema = z.object({
  intervalStatus: z.literal('observed'),
  lower: RoundedStatisticSchema,
  upper: RoundedStatisticSchema,
  estimate: RoundedStatisticSchema,
  samples: PositiveCountSchema,
  confidenceLevel: z.number().finite().gt(0).lt(1),
  drawCoverage: DrawCoverageSchema,
}).strict();

const MissingAlphaIntervalSchema = z.object({
  intervalStatus: z.literal('missing'),
  reasonCode: z.enum([
    'agreement-point-unobserved',
    'agreement-no-valid-bootstrap-draws',
  ]),
  drawCoverage: DrawCoverageSchema,
}).strict();

const AlphaIntervalSchema = z.discriminatedUnion('intervalStatus', [
  ObservedAlphaIntervalSchema,
  MissingAlphaIntervalSchema,
]);

const AgreementStatisticsSchema = z.object({
  krippendorffAlpha: AgreementStatisticSchema,
  alphaInterval: AlphaIntervalSchema,
  weightedKappa: AgreementStatisticSchema,
  pearson: AgreementStatisticSchema,
}).strict();

const AgreementTableValueSchema = z.object({
  schemaVersion: z.literal(AGREEMENT_TABLE_SCHEMA_VERSION),
  configuration: AgreementParametersSchema,
  pairs: z.array(AgreementPairSchema).min(1),
  coverage: AgreementCoverageSchema,
  statistics: AgreementStatisticsSchema,
}).strict();

export type AgreementPair = z.infer<typeof AgreementPairSchema>;
export type AgreementCoverage = z.infer<typeof AgreementCoverageSchema>;
export type AgreementStatistics = z.infer<typeof AgreementStatisticsSchema>;
export type AgreementTableValue = z.infer<typeof AgreementTableValueSchema>;

function legacyRound4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function parsePairs(
  parameters: AgreementParameters,
  rawPairs: readonly AgreementPair[],
): AgreementPair[] {
  const pairs = rawPairs.map((pair) => AgreementPairSchema.parse(pair));
  const order = new Map(parameters.sampleIds.map((sampleId, index) => [sampleId, index]));
  const pairIds = pairs.map((pair) => pair.sampleId);
  if (new Set(pairIds).size !== pairIds.length
      || canonicalizeJson([...pairIds].sort())
        !== canonicalizeJson([...parameters.sampleIds].sort())) {
    throw new TypeError('Agreement pairs must map every sealed sample exactly once.');
  }
  const sourceGroupIds = pairs.flatMap((pair) => pair.judge.sourceGroupIds);
  if (new Set(sourceGroupIds).size !== sourceGroupIds.length) {
    throw new TypeError('Agreement judge source group identities must be globally unique.');
  }
  for (const pair of pairs) {
    for (const rating of [pair.gold, pair.judge]) {
      if (rating.ratingStatus === 'observed'
          && (rating.score < parameters.gold.scale.min
            || rating.score > parameters.gold.scale.max)) {
        throw new TypeError('Agreement ratings must stay inside the sealed scale.');
      }
    }
    const coverage = pair.judge.coverage;
    if (coverage.observedGroups + coverage.missingGroups !== coverage.plannedGroups
        || pair.judge.sourceGroupIds.length !== coverage.plannedGroups
        || (pair.judge.ratingStatus === 'observed' && coverage.observedGroups === 0)
        || (pair.judge.ratingStatus === 'missing'
          && (coverage.plannedGroups === 0 || coverage.observedGroups !== 0))
        || (pair.judge.ratingStatus === 'unavailable' && coverage.plannedGroups !== 0)) {
      throw new TypeError('Agreement judge coverage does not match its rating status.');
    }
  }
  return pairs.sort((left, right) => (
    (order.get(left.sampleId) ?? -1) - (order.get(right.sampleId) ?? -1)
  ));
}

export function agreementCoverage(pairs: readonly AgreementPair[]): AgreementCoverage {
  return {
    plannedPairs: pairs.length,
    comparablePairs: pairs.filter((pair) => (
      pair.gold.ratingStatus === 'observed' && pair.judge.ratingStatus === 'observed'
    )).length,
    goldObservedPairs: pairs.filter((pair) => pair.gold.ratingStatus === 'observed').length,
    goldUnavailablePairs: pairs.filter((pair) => pair.gold.ratingStatus === 'unavailable').length,
    judgeObservedPairs: pairs.filter((pair) => pair.judge.ratingStatus === 'observed').length,
    judgeMissingPairs: pairs.filter((pair) => pair.judge.ratingStatus === 'missing').length,
    judgeUnavailablePairs: pairs.filter((pair) => pair.judge.ratingStatus === 'unavailable').length,
  };
}

function observedOrMissing(
  value: number,
  insufficient: boolean,
  undefinedReason: 'agreement-zero-expected-disagreement' | 'agreement-statistic-undefined',
): z.infer<typeof AgreementStatisticSchema> {
  if (insufficient) {
    return { statisticStatus: 'missing', reasonCode: 'agreement-insufficient-pairs' };
  }
  return Number.isFinite(value)
    ? { statisticStatus: 'observed', value: legacyRound4(value) }
    : { statisticStatus: 'missing', reasonCode: undefinedReason };
}

export function agreementStatistics(
  parameters: AgreementParameters,
  pairs: readonly AgreementPair[],
): AgreementStatistics {
  const ratings: RatingPair[] = pairs.flatMap((pair) => (
    pair.gold.ratingStatus === 'observed' && pair.judge.ratingStatus === 'observed'
      ? [{ unitId: pair.sampleId, coderA: pair.gold.score, coderB: pair.judge.score }]
      : []
  ));
  const insufficient = ratings.length < 2;
  const rawAlpha = insufficient ? Number.NaN : computeKrippendorffAlpha(ratings);
  const krippendorffAlpha = observedOrMissing(
    rawAlpha,
    insufficient,
    'agreement-zero-expected-disagreement',
  );
  const weightedKappa = observedOrMissing(
    insufficient ? Number.NaN : computeWeightedKappa(ratings, parameters.gold.scale),
    insufficient,
    'agreement-statistic-undefined',
  );
  const pearson = observedOrMissing(
    insufficient ? Number.NaN : computePearson(ratings),
    insufficient,
    'agreement-statistic-undefined',
  );
  const emptyDrawCoverage = {
    plannedDraws: parameters.resamples,
    observedDraws: 0,
    missingDraws: parameters.resamples,
  };
  if (krippendorffAlpha.statisticStatus !== 'observed') {
    return {
      krippendorffAlpha,
      alphaInterval: {
        intervalStatus: 'missing',
        reasonCode: 'agreement-point-unobserved',
        drawCoverage: emptyDrawCoverage,
      },
      weightedKappa,
      pearson,
    };
  }
  const indices = ratings.map((_, index) => index);
  const distribution = drawBootstrapMetric(
    indices,
    (resampled) => computeKrippendorffAlpha(resampled.map((index) => ratings[index])),
    parameters.resamples,
    parameters.seed,
  );
  const finiteDraws = distribution.draws.filter(Number.isFinite);
  const drawCoverage = {
    plannedDraws: parameters.resamples,
    observedDraws: finiteDraws.length,
    missingDraws: parameters.resamples - finiteDraws.length,
  };
  const alphaInterval = finiteDraws.length === 0
    ? {
        intervalStatus: 'missing' as const,
        reasonCode: 'agreement-no-valid-bootstrap-draws' as const,
        drawCoverage,
      }
    : (() => {
        const interval = summarizeBootstrapMetric(
          rawAlpha,
          finiteDraws,
          parameters.alpha,
          finiteDraws.length,
        );
        return {
          intervalStatus: 'observed' as const,
          lower: interval.low,
          upper: interval.high,
          estimate: interval.estimate,
          samples: interval.samples,
          confidenceLevel: 1 - parameters.alpha,
          drawCoverage,
        };
      })();
  return { krippendorffAlpha, alphaInterval, weightedKappa, pearson };
}

export function buildAgreementTable(
  rawParameters: unknown,
  rawPairs: readonly AgreementPair[],
): AgreementTableValue {
  const parameters = parseAgreementParameters(rawParameters);
  const pairs = parsePairs(parameters, rawPairs);
  return {
    schemaVersion: AGREEMENT_TABLE_SCHEMA_VERSION,
    configuration: parameters,
    pairs,
    coverage: agreementCoverage(pairs),
    statistics: agreementStatistics(parameters, pairs),
  };
}

function validateAgreementTable(value: AgreementTableValue, context: z.RefinementCtx): void {
  let expected: AgreementTableValue;
  try {
    expected = buildAgreementTable(value.configuration, value.pairs);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      path: ['pairs'],
      message: error instanceof Error ? error.message : 'Agreement pairs are invalid.',
    });
    return;
  }
  if (canonicalizeJson(value) !== canonicalizeJson(expected)) {
    context.addIssue({
      code: 'custom',
      path: [],
      message: 'Agreement table is not canonically ordered or statistically recomputable.',
    });
  }
}

const AgreementTableEnvelopeSchema = z.object({
  resultType: z.literal('table'),
  value: AgreementTableValueSchema,
}).strict().superRefine((envelope, context) => {
  validateAgreementTable(envelope.value, context);
});

export const AGREEMENT_TABLE_SCHEMA = analysisSchemaIdentity(
  AGREEMENT_TABLE_SCHEMA_VERSION,
  'urn:omk:analysis-result:agreement-table:v1',
  analysisJsonSchema(AgreementTableEnvelopeSchema, [
    'pairs map every sealed sample exactly once and preserve gold and Dimension availability separately',
    'judge group coverage, globally unique source lineage, pair coverage, and sample ordering are recomputable',
    'all observed ratings stay within the sealed external-annotation scale',
    'Krippendorff alpha uses interval distance squared and requires at least two comparable rating pairs',
    'quadratic-weighted kappa and Pearson are auxiliary statistics over the identical comparable pair set',
    'bootstrap resamples complete pair indices using the sealed Mulberry32 stream',
    'undefined alpha draws are excluded from interval quantiles and retained as missing draw coverage',
    'zero finite draws, zero expected disagreement, and insufficient pairs produce structured missing rather than NaN or zero',
    'finite point estimates and percentile bounds use the legacy four-decimal persistence rounding',
    'the complete table is statistically recomputable during live and transported validation',
  ]),
);

export function parseAgreementTableEnvelope(value: unknown): Readonly<{
  resultType: 'table';
  value: AgreementTableValue;
}> {
  return AgreementTableEnvelopeSchema.parse(value);
}

function validateSealedConfiguration(
  value: unknown,
  context?: Readonly<CoreSchemaValidationContext>,
): JsonValue {
  const parsed = parseAgreementTableEnvelope(value);
  if (context?.validationKind !== 'analysis-output') {
    throw new TypeError('Agreement Analysis output validation requires sealed node parameters.');
  }
  const sealed = parseAgreementParameters(context.parameters);
  if (canonicalizeJson(parsed.value.configuration) !== canonicalizeJson(sealed)) {
    throw new TypeError('Agreement table configuration does not match sealed node parameters.');
  }
  return parsed as JsonValue;
}

export function createAgreementTableSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    AGREEMENT_TABLE_SCHEMA,
    validateSealedConfiguration,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}
