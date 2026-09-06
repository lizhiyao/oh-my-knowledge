import { z } from 'zod';
import {
  IdentifierSchema,
  canonicalizeJson,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type JsonValue,
} from '../../../eval-core/contracts/index.js';
import {
  PAIRED_NORMAL_POWER_METHOD_ID,
  requiredPairedComparisonUnits,
} from '../../analysis/sample-size.js';
import {
  analysisJsonSchema,
  analysisSchemaIdentity,
  compareStrings,
  createAnalysisSchemaValidator,
} from './analysis-support.js';

const PARAMETERS_SCHEMA_V1 = 'omk.parameters.release-decision/v1' as const;
const PARAMETERS_SCHEMA_V2 = 'omk.parameters.release-decision/v2' as const;
const PARAMETERS_SCHEMA_V3 = 'omk.parameters.release-decision/v3' as const;
const PositiveCountSchema = z.number().int().positive().safe();

const JudgeEnsembleSourceSchema = z.object({
  analysisResultId: IdentifierSchema,
  metricId: IdentifierSchema,
  instrumentId: IdentifierSchema,
  replicateGroupId: IdentifierSchema,
}).strict();

const JudgeEnsembleSourceV3Schema = JudgeEnsembleSourceSchema.extend({
  applicableSampleIds: z.array(IdentifierSchema).min(1),
}).strict().superRefine((source, context) => {
  if (new Set(source.applicableSampleIds).size !== source.applicableSampleIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['applicableSampleIds'],
      message: 'Judge Ensemble applicable sample identities must be unique.',
    });
  }
});

const ReleaseDecisionSourcesSchema = z.object({
  compositeResultId: IdentifierSchema,
  bootstrapFamilyResultId: IdentifierSchema,
  judgeEnsemble: JudgeEnsembleSourceSchema.optional(),
}).strict().superRefine((sources, context) => {
  const resultIds = [
    sources.compositeResultId,
    sources.bootstrapFamilyResultId,
    ...(sources.judgeEnsemble === undefined ? [] : [sources.judgeEnsemble.analysisResultId]),
  ];
  if (new Set(resultIds).size !== resultIds.length) {
    context.addIssue({
      code: 'custom',
      path: [],
      message: 'Release Decision source result identities must be distinct.',
    });
  }
});

const ReleaseDecisionSourcesV3Schema = z.object({
  compositeResultId: IdentifierSchema,
  bootstrapFamilyResultId: IdentifierSchema,
  judgeEnsembles: z.array(JudgeEnsembleSourceV3Schema).min(1).optional(),
}).strict().superRefine((sources, context) => {
  const ensembles = sources.judgeEnsembles ?? [];
  const resultIds = [
    sources.compositeResultId,
    sources.bootstrapFamilyResultId,
    ...ensembles.map((source) => source.analysisResultId),
  ];
  if (new Set(resultIds).size !== resultIds.length) {
    context.addIssue({
      code: 'custom',
      path: [],
      message: 'Release Decision source result identities must be distinct.',
    });
  }
  const bindings = ensembles.map((source) => canonicalizeJson([
    source.metricId,
    source.instrumentId,
    source.replicateGroupId,
  ]));
  if (new Set(bindings).size !== bindings.length) {
    context.addIssue({
      code: 'custom',
      path: ['judgeEnsembles'],
      message: 'Judge Ensemble source bindings must be unique.',
    });
  }
});

const SharedThresholdsSchema = z.object({
  layerScore: z.number().finite().min(1).max(5),
  triviallySmallDifference: z.number().finite().nonnegative().max(4),
  judgeDissentPearson: z.number().finite().min(-1).max(1),
  holdoutGap: z.number().finite().nonnegative().max(4),
}).strict();

const V1ThresholdsSchema = z.object({
  layerScore: z.number().finite().min(1).max(5),
  triviallySmallDifference: z.number().finite().nonnegative().max(4),
  minimumSampleCount: z.number().int().positive().safe(),
  judgeDissentPearson: z.number().finite().min(-1).max(1),
  holdoutGap: z.number().finite().nonnegative().max(4),
}).strict();

const HoldoutPartitionSchema = z.object({
  trainSampleIds: z.array(IdentifierSchema).min(1),
  holdoutSampleIds: z.array(IdentifierSchema).min(1),
  minimumScorablePerPartition: z.number().int().positive().safe(),
}).strict();

const MinimumCountRequirementSchema = z.object({
  sampleSizePlanningKind: z.literal('minimum-count'),
  minimumComparisonUnits: PositiveCountSchema,
}).strict();

const APrioriPowerRequirementSchema = z.object({
  sampleSizePlanningKind: z.literal('a-priori-power'),
  methodId: z.literal(PAIRED_NORMAL_POWER_METHOD_ID),
  minimumDetectableDifference: z.number().finite().gt(0).max(4),
  expectedDifferenceStandardDeviation: z.number().finite().gt(0).max(4),
  targetPower: z.number().finite().gt(0.5).lt(1),
  familywiseAlpha: z.number().finite().gt(0).lt(1),
  plannedComparisonCount: PositiveCountSchema,
  minimumComparisonUnits: PositiveCountSchema,
  assumptionSource: z.string().trim().min(1),
}).strict().superRefine((requirement, context) => {
  let expected: number;
  try {
    expected = requiredPairedComparisonUnits(requirement);
  } catch {
    context.addIssue({
      code: 'custom',
      path: [],
      message: 'A priori power assumptions cannot be represented safely.',
    });
    return;
  }
  if (requirement.minimumComparisonUnits !== expected) {
    context.addIssue({
      code: 'custom',
      path: ['minimumComparisonUnits'],
      message: 'A priori power requirement is not recomputable from its sealed assumptions.',
    });
  }
});

export const ReleaseSampleSizeRequirementSchema = z.discriminatedUnion(
  'sampleSizePlanningKind',
  [MinimumCountRequirementSchema, APrioriPowerRequirementSchema],
);

function validateSharedParameters(
  parameters: Readonly<{
    targetIds: readonly string[];
    sampleIds: readonly string[];
    holdout?: z.infer<typeof HoldoutPartitionSchema>;
  }>,
  context: z.RefinementCtx,
): void {
  for (const [field, values] of [
    ['targetIds', parameters.targetIds],
    ['sampleIds', parameters.sampleIds],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} values must be unique.` });
    }
  }
  if (parameters.holdout === undefined) return;
  const train = parameters.holdout.trainSampleIds;
  const holdout = parameters.holdout.holdoutSampleIds;
  if (new Set(train).size !== train.length || new Set(holdout).size !== holdout.length) {
    context.addIssue({
      code: 'custom', path: ['holdout'], message: 'Holdout partition sample identities must be unique.',
    });
  }
  const partition = [...train, ...holdout];
  if (new Set(partition).size !== partition.length
      || canonicalizeJson([...partition].sort())
        !== canonicalizeJson([...parameters.sampleIds].sort())) {
    context.addIssue({
      code: 'custom',
      path: ['holdout'],
      message: 'Train and holdout partitions must be disjoint and cover every sealed sample.',
    });
  }
}

const ParameterBaseSchema = z.object({
  sources: ReleaseDecisionSourcesSchema,
  targetIds: z.array(IdentifierSchema).min(1),
  sampleIds: z.array(IdentifierSchema).min(1),
  holdout: HoldoutPartitionSchema.optional(),
});

export const ReleaseDecisionParametersV1Schema = z.object({
  sources: ReleaseDecisionSourcesSchema,
  targetIds: z.array(IdentifierSchema).min(1),
  sampleIds: z.array(IdentifierSchema).min(1),
  thresholds: V1ThresholdsSchema,
  holdout: HoldoutPartitionSchema.optional(),
}).strict().superRefine(validateSharedParameters);

export const ReleaseDecisionParametersSchema = ParameterBaseSchema.extend({
  thresholds: SharedThresholdsSchema,
  sampleSizeRequirement: ReleaseSampleSizeRequirementSchema,
}).strict().superRefine(validateSharedParameters);

export const ReleaseDecisionParametersV3Schema = z.object({
  sources: ReleaseDecisionSourcesV3Schema,
  targetIds: z.array(IdentifierSchema).min(1),
  sampleIds: z.array(IdentifierSchema).min(1),
  thresholds: SharedThresholdsSchema,
  sampleSizeRequirement: ReleaseSampleSizeRequirementSchema,
  holdout: HoldoutPartitionSchema.optional(),
}).strict().superRefine((parameters, context) => {
  validateSharedParameters(parameters, context);
  const sampleIds = new Set(parameters.sampleIds);
  for (const [sourceIndex, source] of (parameters.sources.judgeEnsembles ?? []).entries()) {
    if (source.applicableSampleIds.some((sampleId) => !sampleIds.has(sampleId))) {
      context.addIssue({
        code: 'custom',
        path: ['sources', 'judgeEnsembles', sourceIndex, 'applicableSampleIds'],
        message: 'Judge Ensemble applicability must be a subset of sealed sampleIds.',
      });
    }
  }
});

export type ReleaseDecisionParametersV1 = z.infer<typeof ReleaseDecisionParametersV1Schema>;
export type ReleaseDecisionParameters = z.infer<typeof ReleaseDecisionParametersSchema>;
export type ReleaseDecisionParametersV3 = z.infer<typeof ReleaseDecisionParametersV3Schema>;
export type AnyReleaseDecisionParameters = ReleaseDecisionParametersV1
  | ReleaseDecisionParameters
  | ReleaseDecisionParametersV3;

function copyParameters<Parameters extends AnyReleaseDecisionParameters>(
  parsed: Parameters,
): Parameters {
  return {
    ...parsed,
    sources: 'judgeEnsembles' in parsed.sources
      ? {
          ...parsed.sources,
          ...(parsed.sources.judgeEnsembles === undefined ? {} : {
            judgeEnsembles: parsed.sources.judgeEnsembles.map((source) => ({
              ...source,
              applicableSampleIds: [...source.applicableSampleIds],
            })),
          }),
        }
      : 'judgeEnsemble' in parsed.sources ? {
          ...parsed.sources,
          ...(parsed.sources.judgeEnsemble === undefined ? {} : {
            judgeEnsemble: { ...parsed.sources.judgeEnsemble },
          }),
        } : parsed.sources,
    targetIds: [...parsed.targetIds],
    sampleIds: [...parsed.sampleIds],
    thresholds: { ...parsed.thresholds },
    ...('sampleSizeRequirement' in parsed
      ? { sampleSizeRequirement: { ...parsed.sampleSizeRequirement } }
      : {}),
    ...(parsed.holdout === undefined ? {} : {
      holdout: {
        ...parsed.holdout,
        trainSampleIds: [...parsed.holdout.trainSampleIds],
        holdoutSampleIds: [...parsed.holdout.holdoutSampleIds],
      },
    }),
  } as Parameters;
}

export function parseReleaseDecisionParametersV1(value: unknown): ReleaseDecisionParametersV1 {
  return copyParameters(ReleaseDecisionParametersV1Schema.parse(value));
}

export function parseReleaseDecisionParameters(value: unknown): ReleaseDecisionParameters {
  return copyParameters(ReleaseDecisionParametersSchema.parse(value));
}

export function parseReleaseDecisionParametersV3(value: unknown): ReleaseDecisionParametersV3 {
  const parsed = copyParameters(ReleaseDecisionParametersV3Schema.parse(value));
  return {
    ...parsed,
    sources: {
      ...parsed.sources,
      ...(parsed.sources.judgeEnsembles === undefined ? {} : {
        judgeEnsembles: [...parsed.sources.judgeEnsembles].map((source) => ({
          ...source,
          applicableSampleIds: [...source.applicableSampleIds].sort(compareStrings),
        })).sort((left, right) => (
          compareStrings(left.analysisResultId, right.analysisResultId)
          || compareStrings(left.metricId, right.metricId)
          || compareStrings(left.instrumentId, right.instrumentId)
          || compareStrings(left.replicateGroupId, right.replicateGroupId)
        )),
      }),
    },
  };
}

export const RELEASE_DECISION_PARAMETERS_V1_SCHEMA = analysisSchemaIdentity(
  PARAMETERS_SCHEMA_V1,
  'urn:omk:parameters:release-decision:v1',
  analysisJsonSchema(ReleaseDecisionParametersV1Schema, [
    'Composite, Bootstrap Family, and optional Judge Ensemble result identities are explicit',
    'target and sample order are sealed before Evaluation begins',
    'layer, practical-effect, sample-size, judge-dissent, and holdout thresholds are explicit',
    'optional train and holdout sample partitions are disjoint and cover the sealed sample set',
    'single-run decision parameters contain no cross-run stability evidence',
  ]),
);

export const RELEASE_DECISION_PARAMETERS_SCHEMA = analysisSchemaIdentity(
  PARAMETERS_SCHEMA_V2,
  'urn:omk:parameters:release-decision:v2',
  analysisJsonSchema(ReleaseDecisionParametersSchema, [
    'Composite, Bootstrap Family, and optional Judge Ensemble result identities are explicit',
    'target and sample order are sealed before Evaluation begins',
    'the sample-size requirement is either an explicit minimum or a recomputable a priori power plan',
    'power assumptions are sealed before outcomes and never use observed run variance',
    'layer, practical-effect, judge-dissent, and holdout thresholds are explicit',
    'optional train and holdout sample partitions are disjoint and cover every sealed sample',
    'single-run decision parameters contain no cross-run stability evidence',
  ]),
);

export const RELEASE_DECISION_PARAMETERS_V3_SCHEMA = analysisSchemaIdentity(
  PARAMETERS_SCHEMA_V3,
  'urn:omk:parameters:release-decision:v3',
  analysisJsonSchema(ReleaseDecisionParametersV3Schema, [
    'Composite, Bootstrap Family, and every applicable Judge Ensemble result identity are explicit',
    'Judge Ensemble sources are distinct and canonically ordered before plan sealing',
    'target and sample order are sealed before Evaluation begins',
    'the sample-size requirement is either an explicit minimum or a recomputable a priori power plan',
    'every configured Judge Ensemble participates in dissent and uncertainty gates',
    'optional train and holdout sample partitions are disjoint and cover every sealed sample',
  ]),
);

export function createReleaseDecisionParameterSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validators = [
    createAnalysisSchemaValidator(
      RELEASE_DECISION_PARAMETERS_V1_SCHEMA,
      (value) => parseReleaseDecisionParametersV1(value) as JsonValue,
    ),
    createAnalysisSchemaValidator(
      RELEASE_DECISION_PARAMETERS_SCHEMA,
      (value) => parseReleaseDecisionParameters(value) as JsonValue,
    ),
    createAnalysisSchemaValidator(
      RELEASE_DECISION_PARAMETERS_V3_SCHEMA,
      (value) => parseReleaseDecisionParametersV3(value) as JsonValue,
    ),
  ];
  return new Map(validators.map((validator) => [schemaIdentityKey(validator.schema), validator]));
}
