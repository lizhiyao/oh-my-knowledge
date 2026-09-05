import {
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
} from '../../../eval-core/contracts/index.js';
import type { AnalysisNodeImplementation } from '../../../eval-core/analysis/index.js';
import { createStatelessAnalysisImplementation } from './analysis-support.js';
import {
  BOOTSTRAP_FAMILY_PARAMETERS_SCHEMA,
  parseBootstrapFamilyParameters,
} from './bootstrap-family-parameters.js';
import {
  BOOTSTRAP_FAMILY_SOURCE_SCHEMAS,
  extractBootstrapObservations,
} from './bootstrap-family-source-adapter.js';
import {
  BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
  BOOTSTRAP_MONTE_CARLO_FAMILY_CONFIDENCE_LEVEL,
  buildBootstrapFamilyTableV2,
  parseBootstrapFamilyTableV2Envelope,
} from './bootstrap-family-table-v2.js';
import {
  bootstrapFamilyAnalysisResultInput,
  validateBootstrapExecutionDesign,
} from './bootstrap-family-node-support.js';

export const BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID =
  'omk.bootstrap-family-table/v2' as const;

const BOOTSTRAP_FAMILY_V2_CAPABILITIES: JsonValue = {
  capabilityKind: 'analysis-node',
  analysisNodeKinds: ['estimator'],
  inputDomains: [{
    inputKind: 'analysis-result',
    schemaUris: BOOTSTRAP_FAMILY_SOURCE_SCHEMAS.map((schema) => schema.schemaUri),
  }],
  outputSchema: BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
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

export const BOOTSTRAP_FAMILY_ANALYSIS_V2_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
    version: '3.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
      algorithmVersion: 'omk.percentile-bootstrap-family/v2',
      randomStream: 'mulberry32-fixed-seed-20260616-reset-per-interval',
      estimator: 'percentile-bootstrap-linear-interpolation',
      intervalRole: 'four-decimal-descriptive-only',
      significance: 'unrounded-draw-relevant-zero-tail',
      monteCarloError:
        'exact-clopper-pearson-with-bonferroni-simultaneous-family-confidence',
      monteCarloFamilyConfidenceLevel: BOOTSTRAP_MONTE_CARLO_FAMILY_CONFIDENCE_LEVEL,
      monteCarloBoundary: 'crossing-alpha-over-two-is-indeterminate',
      exactSupport: 'strictly-signed-complete-resampling-support',
      meanResamplingUnit: 'sample-within-target',
      pairedResamplingUnit: 'pairing-block-joint-difference',
      independentResamplingUnit: 'sample-separate-by-target',
      repeatedMeasures: 'mean-within-resampling-unit',
      familyCorrection: 'nominal-alpha-divided-by-planned-comparison-count',
      missingPolicy: 'explicit-no-zero-sentinel',
      sourceSelection: 'explicit-composite-aggregate-binding',
      directMetricRowMembership: 'none-analysis-results-only',
      upstreamSchemas: [...BOOTSTRAP_FAMILY_SOURCE_SCHEMAS],
      outputSchema: BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
      parameterSchema: BOOTSTRAP_FAMILY_PARAMETERS_SCHEMA,
      declaredCapabilities: BOOTSTRAP_FAMILY_V2_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: BOOTSTRAP_FAMILY_V2_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export function createBootstrapFamilyV2AnalysisNodes(): ReadonlyMap<
  string,
  AnalysisNodeImplementation
> {
  const implementation = createStatelessAnalysisImplementation({
    identity: BOOTSTRAP_FAMILY_ANALYSIS_V2_IDENTITY,
    outputSchema: BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
    parseParameters: (parameters) => { parseBootstrapFamilyParameters(parameters); },
    execute(context) {
      const parameters = parseBootstrapFamilyParameters(context.node.parameters);
      validateBootstrapExecutionDesign(context, parameters);
      const input = bootstrapFamilyAnalysisResultInput(context.inputs, parameters);
      const observations = extractBootstrapObservations({
        resultType: input.record.resultType,
        value: input.record.value,
      }, context.signal);
      const table = buildBootstrapFamilyTableV2(parameters, observations);
      return {
        analysisStatus: 'completed',
        resultType: 'table',
        value: parseBootstrapFamilyTableV2Envelope({ resultType: 'table', value: table }).value,
        includedRowIds: [],
        comparableRowIds: [],
        assumptionChecks: [{
          assumptionId: 'bootstrap-family-v2-contract',
          checkStatus: 'passed',
        }],
      };
    },
  });
  return new Map([[BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID, implementation]]);
}
