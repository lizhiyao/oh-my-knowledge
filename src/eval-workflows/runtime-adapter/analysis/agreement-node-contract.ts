import {
  RuntimeIdentitySchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
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
  AGREEMENT_STATISTIC_DECIMALS,
  AGREEMENT_TABLE_SCHEMA,
} from './agreement-table.js';

export const AGREEMENT_ANALYSIS_IMPLEMENTATION_ID = 'omk.agreement-table/v1' as const;

const ALGORITHM_VERSION = 'omk.interval-agreement/v1' as const;

const AGREEMENT_ANALYSIS_CAPABILITIES: JsonValue = {
  capabilityKind: 'analysis-node',
  analysisNodeKinds: ['estimator'],
  inputDomains: [{
    inputKind: 'analysis-result',
    schemaUris: AGREEMENT_SOURCE_SCHEMAS.map((schema) => schema.schemaUri),
  }],
  outputSchema: AGREEMENT_TABLE_SCHEMA,
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
  schemas: [...AGREEMENT_SOURCE_SCHEMAS],
};

export const AGREEMENT_ANALYSIS_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
      algorithmVersion: ALGORITHM_VERSION,
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

export function agreementAnalysisResultInput(
  inputs: readonly AnalysisNodeInput[],
  parameters: AgreementParameters,
): AgreementAnalysisResultInput {
  if (inputs.length !== 1 || inputs[0].inputKind !== 'analysis-result') {
    throw new TypeError('Agreement Analysis requires exactly one Analysis result input.');
  }
  const input = inputs[0];
  if (input.referenceId !== parameters.source.analysisResultId) {
    throw new TypeError('Agreement source input does not match its sealed parameter binding.');
  }
  if (input.record.resultType !== 'table'
      || canonicalizeJson(input.record.outputSchema) !== canonicalizeJson(agreementSourceSchema())) {
    throw new TypeError('Agreement source input does not match the Dimension table schema.');
  }
  return input;
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
