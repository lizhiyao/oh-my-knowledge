import {
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
} from '../../../eval-core/contracts/index.js';
import {
  BOOTSTRAP_FAMILY_PARAMETERS_SCHEMA,
} from './bootstrap-family-parameters.js';
import {
  BOOTSTRAP_FAMILY_SOURCE_SCHEMAS,
} from './bootstrap-family-source-adapter.js';
import {
  BOOTSTRAP_FAMILY_TABLE_SCHEMA,
  BOOTSTRAP_INTERVAL_DECIMALS,
} from './bootstrap-family-table.js';

export const BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID =
  'omk.bootstrap-family-table/v1' as const;

const ALGORITHM_VERSION = 'omk.legacy-percentile-bootstrap-family/v1' as const;

const BOOTSTRAP_FAMILY_ANALYSIS_CAPABILITIES: JsonValue = {
  capabilityKind: 'analysis-node',
  analysisNodeKinds: ['estimator'],
  inputDomains: [{
    inputKind: 'analysis-result',
    schemaUris: BOOTSTRAP_FAMILY_SOURCE_SCHEMAS.map((schema) => schema.schemaUri),
  }],
  outputSchema: BOOTSTRAP_FAMILY_TABLE_SCHEMA,
  parameterSchema: BOOTSTRAP_FAMILY_PARAMETERS_SCHEMA,
  inputCardinalities: {
    metricObservations: { min: 0, max: 0 },
    analysisResults: { min: 1, max: 1 },
    comparisons: { min: 0, max: 0 },
  },
  sampling: {
    assignmentKinds: ['complete-block'],
    experimentalUnits: ['sample'],
    repeatedMeasures: [false, true],
    resamplingUnits: ['paired-block', 'sample'],
  },
  schemas: [...BOOTSTRAP_FAMILY_SOURCE_SCHEMAS],
};

export const BOOTSTRAP_FAMILY_ANALYSIS_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
    version: '2.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
      algorithmVersion: ALGORITHM_VERSION,
      randomStream: 'mulberry32-fixed-seed-20260616-reset-per-interval',
      estimator: 'percentile-bootstrap-linear-interpolation',
      intervalDecimals: BOOTSTRAP_INTERVAL_DECIMALS,
      significance: 'rounded-bounds-exclude-zero',
      meanResamplingUnit: 'sample-within-target',
      pairedResamplingUnit: 'pairing-block-joint-difference',
      independentResamplingUnit: 'sample-separate-by-target',
      repeatedMeasures: 'mean-within-resampling-unit',
      familyCorrection: 'nominal-alpha-divided-by-observed-comparison-count',
      missingPolicy: 'explicit-no-zero-sentinel',
      sourceSelection: 'explicit-composite-aggregate-binding',
      directMetricRowMembership: 'none-analysis-results-only',
      upstreamSchemas: [...BOOTSTRAP_FAMILY_SOURCE_SCHEMAS],
      outputSchema: BOOTSTRAP_FAMILY_TABLE_SCHEMA,
      parameterSchema: BOOTSTRAP_FAMILY_PARAMETERS_SCHEMA,
      declaredCapabilities: BOOTSTRAP_FAMILY_ANALYSIS_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: BOOTSTRAP_FAMILY_ANALYSIS_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);
