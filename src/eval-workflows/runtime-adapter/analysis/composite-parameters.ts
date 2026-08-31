import { z } from 'zod';
import {
  IdentifierSchema,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type JsonValue,
} from '../../../evaluation-core/contracts/index.js';
import {
  analysisJsonSchema,
  analysisSchemaIdentity,
  createAnalysisSchemaValidator,
} from './analysis-support.js';

const PARAMETERS_SCHEMA_VERSION = 'omk.parameters.composite/v1' as const;

const FactLayerParameterSchema = z.object({
  layerId: z.literal('fact'),
  analysisResultId: IdentifierSchema,
  sourceKind: z.literal('assertion-layer'),
  selector: z.literal('fact'),
}).strict();

const BehaviorLayerParameterSchema = z.object({
  layerId: z.literal('behavior'),
  analysisResultId: IdentifierSchema,
  sourceKind: z.literal('assertion-layer'),
  selector: z.literal('behavior'),
}).strict();

const EnsembleJudgeLayerParameterSchema = z.object({
  layerId: z.literal('judge'),
  analysisResultId: IdentifierSchema,
  sourceKind: z.literal('judge-ensemble'),
  selector: z.literal('consensus'),
}).strict();

const DimensionJudgeLayerParameterSchema = z.object({
  layerId: z.literal('judge'),
  analysisResultId: IdentifierSchema,
  sourceKind: z.literal('dimension'),
  selector: z.literal('aggregate'),
}).strict();

export const CompositeLayerParameterSchema = z.discriminatedUnion('selector', [
  FactLayerParameterSchema,
  BehaviorLayerParameterSchema,
  EnsembleJudgeLayerParameterSchema,
  DimensionJudgeLayerParameterSchema,
]);

const CompositeParametersSchema = z.object({
  layers: z.array(CompositeLayerParameterSchema).min(1).max(3),
}).strict().superRefine((parameters, context) => {
  const layerIds = parameters.layers.map((layer) => layer.layerId);
  if (new Set(layerIds).size !== layerIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['layers'],
      message: 'Composite layerId values must be unique.',
    });
  }
  const fact = parameters.layers.find((layer) => layer.layerId === 'fact');
  const behavior = parameters.layers.find((layer) => layer.layerId === 'behavior');
  if (fact !== undefined && behavior !== undefined
      && fact.analysisResultId !== behavior.analysisResultId) {
    context.addIssue({
      code: 'custom',
      path: ['layers'],
      message: 'Composite fact and behavior layers must share one assertion-layer result.',
    });
  }
  const sourceKinds = new Map<string, string>();
  for (const layer of parameters.layers) {
    const previous = sourceKinds.get(layer.analysisResultId);
    if (previous !== undefined && previous !== layer.sourceKind) {
      context.addIssue({
        code: 'custom',
        path: ['layers'],
        message: 'One upstream Analysis result cannot have multiple source kinds.',
      });
      break;
    }
    sourceKinds.set(layer.analysisResultId, layer.sourceKind);
  }
});

export type CompositeParameters = z.infer<typeof CompositeParametersSchema>;
export type CompositeLayerParameter = z.infer<typeof CompositeLayerParameterSchema>;

const LAYER_ORDER: Readonly<Record<CompositeLayerParameter['layerId'], number>> = {
  fact: 0,
  behavior: 1,
  judge: 2,
};

export function parseCompositeParameters(value: unknown): CompositeParameters {
  const parsed = CompositeParametersSchema.parse(value);
  return {
    layers: [...parsed.layers].sort((left, right) => (
      LAYER_ORDER[left.layerId] - LAYER_ORDER[right.layerId]
    )),
  };
}

export const COMPOSITE_PARAMETERS_SCHEMA = analysisSchemaIdentity(
  PARAMETERS_SCHEMA_VERSION,
  'urn:omk:parameters:composite:v1',
  analysisJsonSchema(CompositeParametersSchema, [
    'layers are normalized in fact, behavior, judge order before plan sealing',
    'fact, behavior, and judge layer identities are independently unique',
    'fact and behavior selectors bind the same assertion-layer Analysis result when both exist',
    'judge explicitly selects either ensemble consensus or dimension aggregate',
    'one upstream Analysis result has one source schema kind',
    'layer identity and selectors are never inferred from node, result, Metric, or field names',
  ]),
);

export function createCompositeParameterSchemaValidators(): ReadonlyMap<
  string,
  CoreSchemaValidator
> {
  const validator = createAnalysisSchemaValidator(
    COMPOSITE_PARAMETERS_SCHEMA,
    (value) => parseCompositeParameters(value) as JsonValue,
  );
  return new Map([[schemaIdentityKey(validator.schema), validator]]);
}
