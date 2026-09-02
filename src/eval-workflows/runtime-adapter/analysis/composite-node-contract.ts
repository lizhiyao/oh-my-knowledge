import {
  RuntimeIdentitySchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
} from '../../../eval-core/contracts/index.js';
import type { AnalysisNodeInput } from '../../../eval-core/analysis/index.js';
import {
  COMPOSITE_PARAMETERS_SCHEMA,
  type CompositeLayerParameter,
  type CompositeParameters,
} from './composite-parameters.js';
import {
  COMPOSITE_SOURCE_SCHEMAS,
  compositeSourceSchema,
} from './composite-source-adapter.js';
import {
  COMPOSITE_SCORE_DECIMALS,
  COMPOSITE_SCORE_MAX,
  COMPOSITE_SCORE_MIN,
  COMPOSITE_TABLE_SCHEMA,
} from './composite-table.js';
import { compareStrings } from './analysis-support.js';

export const COMPOSITE_ANALYSIS_IMPLEMENTATION_ID = 'omk.composite-table/v1' as const;

const ALGORITHM_VERSION = 'omk.composite-aggregation/v1' as const;

const COMPOSITE_ANALYSIS_CAPABILITIES: JsonValue = {
  capabilityKind: 'analysis-node',
  analysisNodeKinds: ['reducer'],
  inputDomains: [{
    inputKind: 'analysis-result',
    schemaUris: COMPOSITE_SOURCE_SCHEMAS.map((schema) => schema.schemaUri),
  }],
  outputSchema: COMPOSITE_TABLE_SCHEMA,
  parameterSchema: COMPOSITE_PARAMETERS_SCHEMA,
  inputCardinalities: {
    metricObservations: { min: 0, max: 0 },
    analysisResults: { min: 1, max: 3 },
    comparisons: { min: 0, max: 0 },
  },
  schemas: [...COMPOSITE_SOURCE_SCHEMAS],
};

export const COMPOSITE_ANALYSIS_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
      algorithmVersion: ALGORITHM_VERSION,
      estimator: 'equal-observed-layer-mean',
      scoreScale: { min: COMPOSITE_SCORE_MIN, max: COMPOSITE_SCORE_MAX },
      decimals: COMPOSITE_SCORE_DECIMALS,
      missingPolicyId: 'exclude/v1',
      applicability: 'upstream-group-presence',
      sourceSelection: 'explicit-parameter-binding',
      samplingUnitLineage: 'equal-across-upstream-layers',
      directMetricRowMembership: 'none-analysis-results-only',
      upstreamSchemas: [...COMPOSITE_SOURCE_SCHEMAS],
      outputSchema: COMPOSITE_TABLE_SCHEMA,
      parameterSchema: COMPOSITE_PARAMETERS_SCHEMA,
      declaredCapabilities: COMPOSITE_ANALYSIS_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: COMPOSITE_ANALYSIS_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export type CompositeAnalysisResultInput = Extract<
  AnalysisNodeInput,
  { inputKind: 'analysis-result' }
>;

export function compositeAnalysisResultInputs(
  inputs: readonly AnalysisNodeInput[],
): readonly CompositeAnalysisResultInput[] {
  const results = inputs.filter((input): input is CompositeAnalysisResultInput => (
    input.inputKind === 'analysis-result'
  ));
  if (results.length === 0 || results.length !== inputs.length) {
    throw new TypeError('Composite Analysis requires one or more Analysis result inputs only.');
  }
  return results;
}

export function validateCompositeInputDesign(
  inputs: readonly CompositeAnalysisResultInput[],
  parameters: CompositeParameters,
): ReadonlyMap<string, readonly CompositeLayerParameter[]> {
  const bindingsByResult = new Map<string, CompositeLayerParameter[]>();
  for (const binding of parameters.layers) {
    const bindings = bindingsByResult.get(binding.analysisResultId) ?? [];
    bindings.push(binding);
    bindingsByResult.set(binding.analysisResultId, bindings);
  }
  const inputIds = inputs.map((input) => input.referenceId);
  const parameterIds = [...bindingsByResult.keys()].sort(compareStrings);
  if (new Set(inputIds).size !== inputIds.length
      || canonicalizeJson([...inputIds].sort(compareStrings)) !== canonicalizeJson(parameterIds)) {
    throw new TypeError(
      'Composite parameters must map every upstream Analysis result exactly once and no others.',
    );
  }
  for (const input of inputs) {
    const bindings = bindingsByResult.get(input.referenceId);
    if (bindings === undefined) throw new TypeError('Composite input is not explicitly bound.');
    const expectedSchema = compositeSourceSchema(bindings[0]);
    if (input.record.resultType !== 'table'
        || bindings.some((binding) => (
          canonicalizeJson(compositeSourceSchema(binding)) !== canonicalizeJson(expectedSchema)
        ))
        || canonicalizeJson(input.record.outputSchema) !== canonicalizeJson(expectedSchema)) {
      throw new TypeError('Composite Analysis input does not match its sealed source schema.');
    }
  }
  return bindingsByResult;
}
