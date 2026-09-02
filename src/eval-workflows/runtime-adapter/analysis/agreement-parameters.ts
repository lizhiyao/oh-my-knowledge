import { z } from 'zod';
import {
  IdentifierSchema,
  JsonPointerSchema,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type JsonValue,
} from '../../../eval-core/contracts/index.js';
import {
  analysisJsonSchema,
  analysisSchemaIdentity,
  createAnalysisSchemaValidator,
} from './analysis-support.js';

const PARAMETERS_SCHEMA_VERSION = 'omk.parameters.agreement/v1' as const;

const AgreementSourceBindingSchema = z.object({
  analysisResultId: IdentifierSchema,
  sourceKind: z.literal('dimension'),
  selector: z.literal('aggregate'),
  targetId: IdentifierSchema,
}).strict();

const AgreementScaleSchema = z.object({
  min: z.number().finite(),
  max: z.number().finite(),
}).strict().superRefine((scale, context) => {
  if (scale.max <= scale.min) {
    context.addIssue({
      code: 'custom',
      path: ['max'],
      message: 'Agreement scale max must be greater than min.',
    });
  }
});

const AgreementGoldBindingSchema = z.object({
  contextPointer: JsonPointerSchema,
  annotatorId: IdentifierSchema,
  annotationVersion: IdentifierSchema,
  scale: AgreementScaleSchema,
}).strict();

export const AgreementParametersSchema = z.object({
  source: AgreementSourceBindingSchema,
  gold: AgreementGoldBindingSchema,
  sampleIds: z.array(IdentifierSchema).min(1),
  resamples: z.number().int().positive().safe(),
  alpha: z.number().finite().gt(0).lt(1),
  seed: z.number().int().nonnegative().safe(),
}).strict().superRefine((parameters, context) => {
  if (new Set(parameters.sampleIds).size !== parameters.sampleIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['sampleIds'],
      message: 'Agreement sampleIds must be unique.',
    });
  }
});

export type AgreementParameters = z.infer<typeof AgreementParametersSchema>;

export function parseAgreementParameters(value: unknown): AgreementParameters {
  const parsed = AgreementParametersSchema.parse(value);
  return {
    ...parsed,
    source: { ...parsed.source },
    gold: { ...parsed.gold, scale: { ...parsed.gold.scale } },
    sampleIds: [...parsed.sampleIds],
  };
}

export const AGREEMENT_PARAMETERS_SCHEMA = analysisSchemaIdentity(
  PARAMETERS_SCHEMA_VERSION,
  'urn:omk:parameters:agreement:v1',
  analysisJsonSchema(AgreementParametersSchema, [
    'the judge source explicitly selects one target from one Dimension aggregate result',
    'gold ratings are resolved only from Analysis sample context at the sealed JSON pointer',
    'annotator identity, annotation version, numeric scale, and sample order are sealed',
    'sampleIds are unique and their order defines pair-preserving bootstrap order',
    'interval-distance Krippendorff alpha is the only primary agreement standard',
    'resamples, nominal alpha, and the non-negative integer random seed are sealed',
  ]),
);

export function createAgreementParameterSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    AGREEMENT_PARAMETERS_SCHEMA,
    (value) => parseAgreementParameters(value) as JsonValue,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}
