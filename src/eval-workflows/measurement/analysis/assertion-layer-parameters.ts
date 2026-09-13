import { z } from 'zod';
import {
  IdentifierSchema,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type JsonValue,
} from '../../../eval-core/contracts/index.js';
import {
  analysisJsonSchema,
  analysisSchemaIdentity,
  compareStrings,
  createAnalysisSchemaValidator,
} from './analysis-support.js';

const PARAMETERS_SCHEMA_VERSION = 'omk.parameters.assertion-layer/v2' as const;

export const AssertionLayerDispositionSchema = z.enum([
  'fact',
  'behavior',
  'excluded-mixed-layer',
]);

export const AssertionLayerCriterionParameterSchema = z.object({
  criterionId: IdentifierSchema,
  metricId: IdentifierSchema,
  layerDisposition: AssertionLayerDispositionSchema,
  weight: z.number().finite().positive(),
  applicableSampleIds: z.array(IdentifierSchema).min(1).refine((ids) => new Set(ids).size === ids.length, {
    message: 'Applicable sample IDs must be unique.',
  }).optional(),
}).strict();

const AssertionLayerParametersSchema = z.object({
  criteria: z.array(AssertionLayerCriterionParameterSchema).min(1),
}).strict().superRefine((parameters, context) => {
  for (const field of ['criterionId', 'metricId'] as const) {
    const values = parameters.criteria.map((criterion) => criterion[field]);
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: 'custom',
        path: ['criteria'],
        message: `Assertion-layer ${field} values must be unique.`,
      });
    }
  }
});

export type AssertionLayerParameters = z.infer<typeof AssertionLayerParametersSchema>;
export type AssertionLayerCriterionParameter = z.infer<
  typeof AssertionLayerCriterionParameterSchema
>;

function compareCriteria(
  left: AssertionLayerCriterionParameter,
  right: AssertionLayerCriterionParameter,
): number {
  return compareStrings(left.metricId, right.metricId)
    || compareStrings(left.criterionId, right.criterionId);
}

export function parseAssertionLayerParameters(value: unknown): AssertionLayerParameters {
  const parsed = AssertionLayerParametersSchema.parse(value);
  return {
    criteria: parsed.criteria.map((criterion) => ({
      ...criterion,
      ...(criterion.applicableSampleIds === undefined ? {} : {
        applicableSampleIds: [...criterion.applicableSampleIds].sort(compareStrings),
      }),
    })).sort(compareCriteria),
  };
}

export const ASSERTION_LAYER_PARAMETERS_SCHEMA = analysisSchemaIdentity(
  PARAMETERS_SCHEMA_VERSION,
  'urn:omk:parameters:assertion-layer:v2',
  analysisJsonSchema(AssertionLayerParametersSchema, [
    'criteria are normalized by metricId and criterionId before plan sealing',
    'criterionId and metricId are independently unique',
    'layer disposition is explicit and never inferred from evaluator or assertion strings',
    'weights are finite and strictly positive',
    'omitted sample scope means all samples; an explicit scope is nonempty, unique, and canonically ordered',
  ]),
);

export function createAssertionLayerParameterSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    ASSERTION_LAYER_PARAMETERS_SCHEMA,
    (value) => parseAssertionLayerParameters(value) as JsonValue,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}

