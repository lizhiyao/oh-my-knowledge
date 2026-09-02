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

const PARAMETERS_SCHEMA_VERSION = 'omk.parameters.dimension/v1' as const;

export const DimensionParameterSchema = z.object({
  dimensionId: IdentifierSchema,
  metricId: IdentifierSchema,
  analysisResultId: IdentifierSchema,
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
    dimensions: [...parsed.dimensions].sort(compareDimensions),
  };
}

export const DIMENSION_PARAMETERS_SCHEMA = analysisSchemaIdentity(
  PARAMETERS_SCHEMA_VERSION,
  'urn:omk:parameters:dimension:v1',
  analysisJsonSchema(DimensionParametersSchema, [
    'dimensions are normalized by analysisResultId, metricId, and dimensionId before plan sealing',
    'dimensionId, metricId, and analysisResultId are independently unique',
    'every dimension binds one explicit upstream Analysis result and one Metric',
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
