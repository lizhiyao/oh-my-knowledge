import {
  RuntimeIdentitySchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
} from '../../../evaluation-core/contracts/index.js';
import type {
  AnalysisMetricRow,
  AnalysisNodeExecutionContext,
  AnalysisNodeImplementation,
  AnalysisNodeInput,
} from '../../../evaluation-core/analysis/index.js';
import {
  ASSERTION_LAYER_PARAMETERS_SCHEMA,
  parseAssertionLayerParameters,
  type AssertionLayerCriterionParameter,
  type AssertionLayerParameters,
} from './assertion-layer-parameters.js';
import {
  ASSERTION_LAYER_SCORE_DECIMALS,
  ASSERTION_LAYER_SCORE_MAX,
  ASSERTION_LAYER_SCORE_MIN,
  ASSERTION_LAYER_TABLE_SCHEMA,
  ASSERTION_LAYER_TABLE_SCHEMA_VERSION,
  ASSERTION_NOT_APPLICABLE_REASON,
  assertionLayerAggregate,
  assertionLayerCoverage,
  assertionLayerGroupId,
  compareAssertionLayerGroups,
  parseAssertionLayerTableValue,
  type AssertionEntry,
  type AssertionLayerGroup,
  type AssertionLayerTableValue,
} from './assertion-layer.js';
import {
  compareStrings,
  createStatelessAnalysisImplementation,
} from './analysis-support.js';

export const ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID =
  'omk.assertion-layer-table/v1' as const;

const ALGORITHM_VERSION = 'omk.assertion-layer-aggregation/v1' as const;

const ASSERTION_LAYER_CAPABILITIES: JsonValue = {
  capabilityKind: 'analysis-node',
  analysisNodeKinds: ['reducer'],
  inputDomains: [{
    inputKind: 'metric-observations',
    valueTypes: ['boolean'],
    missingPolicyIds: ['exclude/v1'],
  }],
  outputSchema: ASSERTION_LAYER_TABLE_SCHEMA,
  parameterSchema: ASSERTION_LAYER_PARAMETERS_SCHEMA,
  inputCardinalities: {
    metricObservations: { min: 1 },
    analysisResults: { min: 0, max: 0 },
    comparisons: { min: 0, max: 0 },
  },
  schemas: [],
};

export const ASSERTION_LAYER_ANALYSIS_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
      algorithmVersion: ALGORITHM_VERSION,
      scoreMapping: {
        min: ASSERTION_LAYER_SCORE_MIN,
        max: ASSERTION_LAYER_SCORE_MAX,
        decimals: ASSERTION_LAYER_SCORE_DECIMALS,
      },
      missingPolicyId: 'exclude/v1',
      metricContract: { scope: 'sample', direction: 'higher-is-better' },
      structuralNotApplicableReason: ASSERTION_NOT_APPLICABLE_REASON,
      samplingUnitLineage: 'preserved-from-analysis-metric-rows',
      criterionDesign: 'sealed-explicit-parameters',
      outputSchema: ASSERTION_LAYER_TABLE_SCHEMA,
      parameterSchema: ASSERTION_LAYER_PARAMETERS_SCHEMA,
      declaredCapabilities: ASSERTION_LAYER_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: ASSERTION_LAYER_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

type MetricInput = Extract<AnalysisNodeInput, { inputKind: 'metric-observations' }>;

function metricInputs(context: AnalysisNodeExecutionContext): readonly MetricInput[] {
  const inputs = context.inputs.filter((input): input is MetricInput => (
    input.inputKind === 'metric-observations'
  ));
  if (inputs.length === 0 || inputs.length !== context.inputs.length) {
    throw new TypeError('Assertion-layer Analysis requires one or more Metric inputs only.');
  }
  for (const input of inputs) {
    if (input.referenceId !== input.metric.metricId
        || input.metric.valueType !== 'boolean'
        || input.metric.scope !== 'sample'
        || input.metric.direction !== 'higher-is-better'
        || input.metric.missingPolicyId !== 'exclude/v1') {
      throw new TypeError(
        'Assertion-layer Analysis requires reference-aligned, sample-scoped, '
          + 'higher-is-better, exclude/v1 Boolean Metrics.',
      );
    }
  }
  return inputs;
}

function baseUnitKey(row: AnalysisMetricRow): string {
  return canonicalizeJson([row.targetId, row.sampleId, row.trialIndex, row.trialId]);
}

function entryFromRow(
  row: AnalysisMetricRow,
  criterion: AssertionLayerCriterionParameter,
): AssertionEntry {
  const base = {
    ...criterion,
    rowId: row.rowId,
    evaluatorId: row.evaluatorId,
    censored: row.censored,
  };
  if (row.rowStatus === 'observed') {
    if (typeof row.value !== 'boolean') {
      throw new TypeError('Observed assertion reading must be Boolean.');
    }
    return { ...base, applicability: 'applicable', rowStatus: 'observed', value: row.value };
  }
  if (row.reasonCode === ASSERTION_NOT_APPLICABLE_REASON) {
    if (row.rowStatus !== 'missing' || row.censored) {
      throw new TypeError('criterion-not-applicable must be a non-censored missing row.');
    }
    return {
      ...base,
      censored: false,
      applicability: 'not-applicable',
      rowStatus: 'missing',
      reasonCode: ASSERTION_NOT_APPLICABLE_REASON,
    };
  }
  return {
    ...base,
    applicability: 'applicable',
    rowStatus: row.rowStatus,
    reasonCode: row.reasonCode,
  };
}

function validateInputDesign(
  inputs: readonly MetricInput[],
  parameters: AssertionLayerParameters,
): ReadonlyMap<string, AssertionLayerCriterionParameter> {
  const criteriaByMetric = new Map(parameters.criteria.map((criterion) => [
    criterion.metricId,
    criterion,
  ]));
  const inputMetricIds = inputs.map((input) => input.metric.metricId);
  if (new Set(inputMetricIds).size !== inputMetricIds.length
      || canonicalizeJson([...inputMetricIds].sort(compareStrings))
        !== canonicalizeJson(parameters.criteria.map((criterion) => criterion.metricId))) {
    throw new TypeError(
      'Assertion-layer parameters must map every input Metric exactly once and no others.',
    );
  }
  return criteriaByMetric;
}

function buildAssertionLayerTable(
  inputs: readonly MetricInput[],
  parameters: AssertionLayerParameters,
  signal: AbortSignal,
): AssertionLayerTableValue {
  const criteriaByMetric = validateInputDesign(inputs, parameters);
  const groupedRows = new Map<string, AnalysisMetricRow[]>();
  for (const input of inputs) {
    for (const row of input.rows) {
      if (signal.aborted) throw signal.reason;
      if (row.metricId !== input.metric.metricId || row.valueType !== 'boolean') {
        throw new TypeError('Assertion-layer row identity or value type disagrees with its Metric.');
      }
      const key = baseUnitKey(row);
      const members = groupedRows.get(key) ?? [];
      members.push(row);
      groupedRows.set(key, members);
    }
  }
  const groups = [...groupedRows.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, rows]): AssertionLayerGroup => {
      const orderedRows = [...rows].sort((left, right) => (
        compareStrings(left.metricId, right.metricId)
      ));
      const first = orderedRows[0];
      if (orderedRows.length !== parameters.criteria.length
          || new Set(orderedRows.map((row) => row.metricId)).size !== orderedRows.length) {
        throw new TypeError(
          'Every assertion measurement unit must contain exactly one row per Metric.',
        );
      }
      if (new Set(orderedRows.map((row) => canonicalizeJson(row.samplingUnitIds))).size !== 1) {
        throw new TypeError('Assertion rows disagree on sealed sampling-unit lineage.');
      }
      const entries = orderedRows.map((row) => {
        const criterion = criteriaByMetric.get(row.metricId);
        if (criterion === undefined) {
          throw new TypeError(`Assertion Metric "${row.metricId}" is not mapped by parameters.`);
        }
        return entryFromRow(row, criterion);
      });
      const fact = entries.filter((entry) => entry.layerDisposition === 'fact');
      const behavior = entries.filter((entry) => entry.layerDisposition === 'behavior');
      const excluded = entries.filter((entry) => (
        entry.layerDisposition === 'excluded-mixed-layer'
      ));
      const withoutGroupId: Omit<AssertionLayerGroup, 'groupId'> = {
        targetId: first.targetId,
        sampleId: first.sampleId,
        trialIndex: first.trialIndex,
        trialId: first.trialId,
        samplingUnitIds: first.samplingUnitIds,
        entries,
        layers: {
          fact: assertionLayerAggregate(fact),
          behavior: assertionLayerAggregate(behavior),
        },
        excludedMixedLayer: { coverage: assertionLayerCoverage(excluded) },
      };
      return { groupId: assertionLayerGroupId(withoutGroupId), ...withoutGroupId };
    });
  groups.sort(compareAssertionLayerGroups);
  return parseAssertionLayerTableValue({
    schemaVersion: ASSERTION_LAYER_TABLE_SCHEMA_VERSION,
    groups,
  });
}

export function createAssertionLayerAnalysisNodes(): ReadonlyMap<
  string,
  AnalysisNodeImplementation
> {
  const implementation = createStatelessAnalysisImplementation({
    identity: ASSERTION_LAYER_ANALYSIS_IDENTITY,
    outputSchema: ASSERTION_LAYER_TABLE_SCHEMA,
    parseParameters: (parameters) => { parseAssertionLayerParameters(parameters); },
    execute(context) {
      const parameters = parseAssertionLayerParameters(context.node.parameters);
      const inputs = metricInputs(context);
      validateInputDesign(inputs, parameters);
      if (inputs.every((input) => input.rows.length === 0)) {
        return {
          analysisStatus: 'inconclusive',
          reasonCodes: ['assertion-layer-no-planned-rows'],
          includedRowIds: [],
          comparableRowIds: [],
          assumptionChecks: [{
            assumptionId: 'assertion-layer-contract',
            checkStatus: 'failed',
            reasonCode: 'assertion-layer-no-planned-rows',
          }],
        };
      }
      const table = buildAssertionLayerTable(inputs, parameters, context.signal);
      const dispositionByMetric = new Map(parameters.criteria.map((criterion) => [
        criterion.metricId,
        criterion.layerDisposition,
      ]));
      const includedRowIds = inputs.flatMap((input) => input.rows.flatMap((row) => (
        row.rowStatus === 'observed'
          && dispositionByMetric.get(row.metricId) !== 'excluded-mixed-layer'
          ? [row.rowId]
          : []
      ))).sort(compareStrings);
      return {
        analysisStatus: 'completed',
        resultType: 'table',
        value: table,
        includedRowIds,
        comparableRowIds: includedRowIds,
        assumptionChecks: [{
          assumptionId: 'assertion-layer-contract',
          checkStatus: 'passed',
        }],
      };
    },
  });
  return new Map([[ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID, implementation]]);
}
