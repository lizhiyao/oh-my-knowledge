import { z } from 'zod';
import { DEFAULT_BOOTSTRAP_SEED } from '../../../shared/statistics/bootstrap.js';
import {
  IdentifierSchema,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type JsonValue,
} from '../../../evaluation-core/contracts/index.js';
import {
  analysisJsonSchema,
  analysisSchemaIdentity,
  compareStrings,
  createAnalysisSchemaValidator,
} from './analysis-support.js';

const PARAMETERS_SCHEMA_VERSION = 'omk.parameters.bootstrap-family/v1' as const;

const BootstrapSourceBindingSchema = z.object({
  analysisResultId: IdentifierSchema,
  sourceKind: z.literal('composite'),
  selector: z.literal('aggregate'),
}).strict();

export const BootstrapComparisonParameterSchema = z.object({
  comparisonId: IdentifierSchema,
  controlTargetId: IdentifierSchema,
  treatmentTargetId: IdentifierSchema,
  comparisonDesign: z.enum(['paired', 'independent']),
}).strict().superRefine((comparison, context) => {
  if (comparison.controlTargetId === comparison.treatmentTargetId) {
    context.addIssue({
      code: 'custom',
      path: ['treatmentTargetId'],
      message: 'Bootstrap comparison targets must be distinct.',
    });
  }
});

export const BootstrapFamilyParametersSchema = z.object({
  source: BootstrapSourceBindingSchema,
  targetIds: z.array(IdentifierSchema).min(1),
  sampleIds: z.array(IdentifierSchema).min(1),
  comparisons: z.array(BootstrapComparisonParameterSchema),
  resamples: z.number().int().positive().safe(),
  alpha: z.number().finite().gt(0).lt(1),
  seed: z.literal(DEFAULT_BOOTSTRAP_SEED),
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
  const comparisonIds = parameters.comparisons.map((comparison) => comparison.comparisonId);
  if (new Set(comparisonIds).size !== comparisonIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['comparisons'],
      message: 'Bootstrap comparisonId values must be unique.',
    });
  }
  const targets = new Set(parameters.targetIds);
  const comparisonDesigns = new Set(
    parameters.comparisons.map((comparison) => comparison.comparisonDesign),
  );
  if (comparisonDesigns.size > 1) {
    context.addIssue({
      code: 'custom',
      path: ['comparisons'],
      message: 'One Bootstrap comparison family must use one comparison design.',
    });
  }
  const contrasts = parameters.comparisons.map((comparison) => JSON.stringify([
    comparison.comparisonDesign,
    comparison.controlTargetId,
    comparison.treatmentTargetId,
  ]));
  if (new Set(contrasts).size !== contrasts.length) {
    context.addIssue({
      code: 'custom',
      path: ['comparisons'],
      message: 'Bootstrap comparison contrasts must be unique within one family.',
    });
  }
  for (const [index, comparison] of parameters.comparisons.entries()) {
    if (!targets.has(comparison.controlTargetId)
        || !targets.has(comparison.treatmentTargetId)) {
      context.addIssue({
        code: 'custom',
        path: ['comparisons', index],
        message: 'Bootstrap comparison targets must be declared in targetIds.',
      });
    }
  }
});

export type BootstrapFamilyParameters = z.infer<typeof BootstrapFamilyParametersSchema>;
export type BootstrapComparisonParameter = z.infer<typeof BootstrapComparisonParameterSchema>;

export function parseBootstrapFamilyParameters(value: unknown): BootstrapFamilyParameters {
  const parsed = BootstrapFamilyParametersSchema.parse(value);
  return {
    ...parsed,
    source: { ...parsed.source },
    targetIds: [...parsed.targetIds],
    sampleIds: [...parsed.sampleIds],
    comparisons: [...parsed.comparisons]
      .map((comparison) => ({ ...comparison }))
      .sort((left, right) => compareStrings(left.comparisonId, right.comparisonId)),
  };
}

export const BOOTSTRAP_FAMILY_PARAMETERS_SCHEMA = analysisSchemaIdentity(
  PARAMETERS_SCHEMA_VERSION,
  'urn:omk:parameters:bootstrap-family:v1',
  analysisJsonSchema(BootstrapFamilyParametersSchema, [
    'the source explicitly selects aggregate values from one Composite Analysis result',
    'targetIds and sampleIds are unique and their sealed order defines the resampling order',
    'comparisonId values are unique and normalized into identifier order before plan sealing',
    'one comparison family uses exactly one paired or independent design and has unique contrasts',
    'control and treatment targets are distinct members of the sealed target set',
    'comparison design is explicit and paired comparisons never fall back to independent sampling',
    'resamples and nominal alpha are sealed before Evaluation begins',
    `the v1 random stream is fixed to Mulberry32 seed ${DEFAULT_BOOTSTRAP_SEED}`,
  ]),
);

export function createBootstrapFamilyParameterSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    BOOTSTRAP_FAMILY_PARAMETERS_SCHEMA,
    (value) => parseBootstrapFamilyParameters(value) as JsonValue,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}
