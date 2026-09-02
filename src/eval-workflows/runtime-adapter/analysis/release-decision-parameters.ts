import { z } from 'zod';
import {
  IdentifierSchema,
  canonicalizeJson,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type JsonValue,
} from '../../../eval-core/contracts/index.js';
import {
  analysisJsonSchema,
  analysisSchemaIdentity,
  createAnalysisSchemaValidator,
} from './analysis-support.js';

const PARAMETERS_SCHEMA_VERSION = 'omk.parameters.release-decision/v1' as const;

const JudgeEnsembleSourceSchema = z.object({
  analysisResultId: IdentifierSchema,
  metricId: IdentifierSchema,
  instrumentId: IdentifierSchema,
  replicateGroupId: IdentifierSchema,
}).strict();

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

const ReleaseDecisionThresholdsSchema = z.object({
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

export const ReleaseDecisionParametersSchema = z.object({
  sources: ReleaseDecisionSourcesSchema,
  targetIds: z.array(IdentifierSchema).min(1),
  sampleIds: z.array(IdentifierSchema).min(1),
  thresholds: ReleaseDecisionThresholdsSchema,
  holdout: HoldoutPartitionSchema.optional(),
}).strict().superRefine((parameters, context) => {
  for (const [field, values] of [
    ['targetIds', parameters.targetIds],
    ['sampleIds', parameters.sampleIds],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} values must be unique.`,
      });
    }
  }
  if (parameters.holdout === undefined) return;
  const train = parameters.holdout.trainSampleIds;
  const holdout = parameters.holdout.holdoutSampleIds;
  if (new Set(train).size !== train.length || new Set(holdout).size !== holdout.length) {
    context.addIssue({
      code: 'custom',
      path: ['holdout'],
      message: 'Holdout partition sample identities must be unique.',
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
});

export type ReleaseDecisionParameters = z.infer<typeof ReleaseDecisionParametersSchema>;

export function parseReleaseDecisionParameters(value: unknown): ReleaseDecisionParameters {
  const parsed = ReleaseDecisionParametersSchema.parse(value);
  return {
    ...parsed,
    sources: {
      ...parsed.sources,
      ...(parsed.sources.judgeEnsemble === undefined ? {} : {
        judgeEnsemble: { ...parsed.sources.judgeEnsemble },
      }),
    },
    targetIds: [...parsed.targetIds],
    sampleIds: [...parsed.sampleIds],
    thresholds: { ...parsed.thresholds },
    ...(parsed.holdout === undefined ? {} : {
      holdout: {
        ...parsed.holdout,
        trainSampleIds: [...parsed.holdout.trainSampleIds],
        holdoutSampleIds: [...parsed.holdout.holdoutSampleIds],
      },
    }),
  };
}

export const RELEASE_DECISION_PARAMETERS_SCHEMA = analysisSchemaIdentity(
  PARAMETERS_SCHEMA_VERSION,
  'urn:omk:parameters:release-decision:v1',
  analysisJsonSchema(ReleaseDecisionParametersSchema, [
    'Composite, Bootstrap Family, and optional Judge Ensemble result identities are explicit',
    'target and sample order are sealed before Evaluation begins',
    'layer, practical-effect, sample-size, judge-dissent, and holdout thresholds are explicit',
    'optional train and holdout sample partitions are disjoint and cover the sealed sample set',
    'single-run decision parameters contain no cross-run stability evidence',
  ]),
);

export function createReleaseDecisionParameterSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    RELEASE_DECISION_PARAMETERS_SCHEMA,
    (value) => parseReleaseDecisionParameters(value) as JsonValue,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}
