import {
  RuntimeIdentitySchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
} from '../../../eval-core/contracts/index.js';
import type {
  AnalysisNodeExecutionContext,
  AnalysisNodeInput,
} from '../../../eval-core/analysis/index.js';
import {
  AGREEMENT_PARAMETERS_SCHEMA,
  type AgreementParameters,
} from './agreement-parameters.js';
import {
  AGREEMENT_SOURCE_SCHEMAS,
  agreementSourceSchema,
} from './agreement-source-adapter.js';
import {
  AGREEMENT_SOURCE_SCHEMAS as AGREEMENT_V1_SOURCE_SCHEMAS,
  agreementSourceSchema as agreementV1SourceSchema,
} from './agreement-source-adapter-v1.js';
import {
  AGREEMENT_STATISTIC_DECIMALS,
  AGREEMENT_TABLE_SCHEMA,
  AGREEMENT_TABLE_V1_SCHEMA,
} from './agreement-table.js';

export const AGREEMENT_ANALYSIS_V1_IMPLEMENTATION_ID = 'omk.agreement-table/v1' as const;
export const AGREEMENT_ANALYSIS_V2_IMPLEMENTATION_ID = 'omk.agreement-table/v2' as const;
export const AGREEMENT_ANALYSIS_IMPLEMENTATION_ID = 'omk.agreement-table/v3' as const;

const ALGORITHM_V1_VERSION = 'omk.interval-agreement/v1' as const;
const ALGORITHM_V2_VERSION = 'omk.interval-agreement/v2' as const;
const ALGORITHM_VERSION = 'omk.interval-agreement/v3' as const;

function agreementAnalysisCapabilities(
  outputSchema: Readonly<SchemaIdentity>,
  sourceSchemas: readonly SchemaIdentity[],
): JsonValue {
  return {
    capabilityKind: 'analysis-node',
    analysisNodeKinds: ['estimator'],
    inputDomains: [{
      inputKind: 'analysis-result',
      schemaUris: sourceSchemas.map((schema) => schema.schemaUri),
    }],
    outputSchema,
    parameterSchema: AGREEMENT_PARAMETERS_SCHEMA,
    inputCardinalities: {
      metricObservations: { min: 0, max: 0 },
      analysisResults: { min: 1, max: 1 },
      comparisons: { min: 0, max: 0 },
    },
    sampling: {
      experimentalUnits: ['sample'],
      repeatedMeasures: [false, true],
      resamplingUnits: ['paired-block', 'sample'],
    },
    schemas: [...sourceSchemas],
  };
}

const AGREEMENT_ANALYSIS_CAPABILITIES = agreementAnalysisCapabilities(
  AGREEMENT_TABLE_SCHEMA,
  AGREEMENT_SOURCE_SCHEMAS,
);
const AGREEMENT_ANALYSIS_V1_CAPABILITIES = agreementAnalysisCapabilities(
  AGREEMENT_TABLE_V1_SCHEMA,
  AGREEMENT_V1_SOURCE_SCHEMAS,
);
const AGREEMENT_ANALYSIS_V2_CAPABILITIES = agreementAnalysisCapabilities(
  AGREEMENT_TABLE_SCHEMA,
  AGREEMENT_V1_SOURCE_SCHEMAS,
);

export const AGREEMENT_ANALYSIS_V1_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: AGREEMENT_ANALYSIS_V1_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: AGREEMENT_ANALYSIS_V1_IMPLEMENTATION_ID,
      algorithmVersion: ALGORITHM_V1_VERSION,
      primaryStatistic: 'krippendorff-alpha-interval-distance-squared',
      auxiliaryStatistics: ['pearson', 'quadratic-weighted-kappa'],
      pairUnit: 'sealed-sample-gold-and-dimension-aggregate',
      repeatedMeasures: 'mean-observed-dimension-groups-within-sample',
      bootstrap: 'mulberry32-pair-resampling-finite-draw-percentile',
      statisticDecimals: AGREEMENT_STATISTIC_DECIMALS,
      missingPolicy: 'structured-insufficient-zero-expected-and-undefined-draws',
      goldSource: 'analysis-sample-context-classification-gold-only',
      sourceSelection: 'explicit-dimension-result-target-and-aggregate',
      directMetricRowMembership: 'none-analysis-results-and-analysis-context-only',
      upstreamSchemas: [...AGREEMENT_V1_SOURCE_SCHEMAS],
      outputSchema: AGREEMENT_TABLE_V1_SCHEMA,
      parameterSchema: AGREEMENT_PARAMETERS_SCHEMA,
      declaredCapabilities: AGREEMENT_ANALYSIS_V1_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: AGREEMENT_ANALYSIS_V1_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export const AGREEMENT_ANALYSIS_V2_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: AGREEMENT_ANALYSIS_V2_IMPLEMENTATION_ID,
    version: '2.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: AGREEMENT_ANALYSIS_V2_IMPLEMENTATION_ID,
      algorithmVersion: ALGORITHM_V2_VERSION,
      primaryStatistic: 'krippendorff-alpha-interval-distance-squared',
      auxiliaryStatistics: ['pearson', 'quadratic-weighted-kappa'],
      pairUnit: 'sealed-sample-gold-and-dimension-aggregate',
      repeatedMeasures: 'mean-observed-dimension-groups-within-sample',
      bootstrap: 'mulberry32-pair-resampling-observed-disagreement-fixed-original-expected-disagreement-percentile',
      statisticDecimals: AGREEMENT_STATISTIC_DECIMALS,
      missingPolicy: 'structured-point-unobserved-perfect-nonapplicable-and-incomplete-draws',
      goldSource: 'analysis-sample-context-classification-gold-only',
      sourceSelection: 'explicit-dimension-result-target-and-aggregate',
      directMetricRowMembership: 'none-analysis-results-and-analysis-context-only',
      upstreamSchemas: [...AGREEMENT_V1_SOURCE_SCHEMAS],
      outputSchema: AGREEMENT_TABLE_SCHEMA,
      parameterSchema: AGREEMENT_PARAMETERS_SCHEMA,
      declaredCapabilities: AGREEMENT_ANALYSIS_V2_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: AGREEMENT_ANALYSIS_V2_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export const AGREEMENT_ANALYSIS_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
    version: '3.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
      algorithmVersion: ALGORITHM_VERSION,
      primaryStatistic: 'krippendorff-alpha-interval-distance-squared',
      auxiliaryStatistics: ['pearson', 'quadratic-weighted-kappa'],
      pairUnit: 'sealed-sample-gold-and-weighted-dimension-aggregate',
      repeatedMeasures: 'mean-observed-weighted-dimension-groups-within-sample',
      bootstrap: 'mulberry32-pair-resampling-observed-disagreement-fixed-original-expected-disagreement-percentile',
      statisticDecimals: AGREEMENT_STATISTIC_DECIMALS,
      missingPolicy: 'structured-point-unobserved-perfect-nonapplicable-and-incomplete-draws',
      goldSource: 'analysis-sample-context-classification-gold-only',
      sourceSelection: 'explicit-dimension-result-target-and-aggregate',
      directMetricRowMembership: 'none-analysis-results-and-analysis-context-only',
      upstreamSchemas: [...AGREEMENT_SOURCE_SCHEMAS],
      outputSchema: AGREEMENT_TABLE_SCHEMA,
      parameterSchema: AGREEMENT_PARAMETERS_SCHEMA,
      declaredCapabilities: AGREEMENT_ANALYSIS_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: AGREEMENT_ANALYSIS_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export type AgreementAnalysisResultInput = Extract<
  AnalysisNodeInput,
  { inputKind: 'analysis-result' }
>;

function analysisResultInput(
  inputs: readonly AnalysisNodeInput[],
  parameters: AgreementParameters,
  schema: SchemaIdentity,
): AgreementAnalysisResultInput {
  if (inputs.length !== 1 || inputs[0].inputKind !== 'analysis-result') {
    throw new TypeError('Agreement Analysis requires exactly one Analysis result input.');
  }
  const input = inputs[0];
  if (input.referenceId !== parameters.source.analysisResultId) {
    throw new TypeError('Agreement source input does not match its sealed parameter binding.');
  }
  if (input.record.resultType !== 'table'
      || canonicalizeJson(input.record.outputSchema) !== canonicalizeJson(schema)) {
    throw new TypeError('Agreement source input does not match the Dimension table schema.');
  }
  return input;
}

export function agreementAnalysisResultInput(
  inputs: readonly AnalysisNodeInput[],
  parameters: AgreementParameters,
): AgreementAnalysisResultInput {
  return analysisResultInput(inputs, parameters, agreementSourceSchema());
}

export function agreementAnalysisResultInputV1(
  inputs: readonly AnalysisNodeInput[],
  parameters: AgreementParameters,
): AgreementAnalysisResultInput {
  return analysisResultInput(inputs, parameters, agreementV1SourceSchema());
}

export function validateAgreementExecutionDesign(
  context: Pick<AnalysisNodeExecutionContext, 'sampling' | 'samples'>,
  parameters: AgreementParameters,
): void {
  if (context.sampling.experimentalUnit !== 'sample'
      || (context.sampling.resamplingUnit !== 'sample'
        && context.sampling.resamplingUnit !== 'paired-block')) {
    throw new TypeError('Agreement Analysis requires sample-based experimental units.');
  }
  const sampleIds = context.samples.map((sample) => sample.sampleId);
  if (canonicalizeJson(sampleIds) !== canonicalizeJson(parameters.sampleIds)) {
    throw new TypeError('Agreement sample order must exactly match the sealed Analysis plan.');
  }
}
