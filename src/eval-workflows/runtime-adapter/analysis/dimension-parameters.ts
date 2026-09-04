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

const PARAMETERS_SCHEMA_VERSION = 'omk.parameters.dimension/v2' as const;

const DimensionSampleWeightSchema = z.object({
  sampleId: IdentifierSchema,
  weight: z.number().finite().positive().max(1),
}).strict();

export const DimensionParameterSchema = z.object({
  dimensionId: IdentifierSchema,
  metricId: IdentifierSchema,
  analysisResultId: IdentifierSchema,
  sampleWeights: z.array(DimensionSampleWeightSchema).min(1),
}).strict();

const DimensionParametersSchema = z.object({
  dimensions: z.array(DimensionParameterSchema).min(1),
}).strict().superRefine((parameters, context) => {
  for (const field of ['dimensionId', 'metricId', 'analysisResultId'] as const) {
    const values = parameters.dimensions.map((dimension) => dimension[field]);
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: 'custom',
        path: ['dimensions'],
        message: `Dimension ${field} values must be unique.`,
      });
    }
  }
  const weightSums = new Map<string, number>();
  for (const [dimensionIndex, dimension] of parameters.dimensions.entries()) {
    const sampleIds = dimension.sampleWeights.map((sample) => sample.sampleId);
    if (new Set(sampleIds).size !== sampleIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['dimensions', dimensionIndex, 'sampleWeights'],
        message: 'Dimension sampleId values must be unique.',
      });
    }
    for (const sample of dimension.sampleWeights) {
      weightSums.set(sample.sampleId, (weightSums.get(sample.sampleId) ?? 0) + sample.weight);
    }
  }
  for (const [sampleId, sum] of weightSums) {
    if (Math.abs(sum - 1) > 1e-9) {
      context.addIssue({
        code: 'custom',
        path: ['dimensions'],
        message: `Dimension weights for sample "${sampleId}" must sum to 1.`,
      });
    }
  }
});

export type DimensionParameters = z.infer<typeof DimensionParametersSchema>;
export type DimensionParameter = z.infer<typeof DimensionParameterSchema>;

function compareDimensions(left: DimensionParameter, right: DimensionParameter): number {
  return compareStrings(left.analysisResultId, right.analysisResultId)
    || compareStrings(left.metricId, right.metricId)
    || compareStrings(left.dimensionId, right.dimensionId);
}

export function parseDimensionParameters(value: unknown): DimensionParameters {
  const parsed = DimensionParametersSchema.parse(value);
  return {
    dimensions: [...parsed.dimensions].sort(compareDimensions).map((dimension) => ({
      ...dimension,
      sampleWeights: [...dimension.sampleWeights].sort((left, right) => (
        compareStrings(left.sampleId, right.sampleId)
      )),
    })),
  };
}

export const DIMENSION_PARAMETERS_SCHEMA = analysisSchemaIdentity(
  PARAMETERS_SCHEMA_VERSION,
  'urn:omk:parameters:dimension:v2',
  analysisJsonSchema(DimensionParametersSchema, [
    'dimensions and per-dimension sample weights are canonically normalized before plan sealing',
    'dimensionId, metricId, and analysisResultId are independently unique',
    'every dimension binds one explicit upstream Analysis result and one Metric',
    'every sample has explicit positive dimension weights that sum to one within 1e-9',
    'dimension identity is never inferred from evaluator, instrument, rubric, or evidence strings',
  ]),
);

export function createDimensionParameterSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    DIMENSION_PARAMETERS_SCHEMA,
    (value) => parseDimensionParameters(value) as JsonValue,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}
