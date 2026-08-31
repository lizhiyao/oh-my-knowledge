import {
  RuntimeIdentitySchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
} from '../../../evaluation-core/contracts/index.js';
import type {
  AnalysisNodeExecutionContext,
  AnalysisNodeImplementation,
  AnalysisNodeInput,
} from '../../../evaluation-core/analysis/index.js';
import {
  DIMENSION_PARAMETERS_SCHEMA,
  parseDimensionParameters,
  type DimensionParameter,
  type DimensionParameters,
} from './dimension-parameters.js';
import {
  DIMENSION_SCORE_DECIMALS,
  DIMENSION_SCORE_MAX,
  DIMENSION_SCORE_MIN,
  DIMENSION_TABLE_SCHEMA,
  DIMENSION_TABLE_SCHEMA_VERSION,
  compareDimensionGroups,
  dimensionAggregate,
  dimensionCoverage,
  dimensionGroupId,
  parseDimensionTableValue,
  type DimensionEntry,
  type DimensionGroup,
  type DimensionTableValue,
} from './dimension-table.js';
import {
  JUDGE_ENSEMBLE_TABLE_SCHEMA,
  parseJudgeEnsembleTableEnvelope,
  type JudgeEnsembleGroup,
} from './judge-aggregation.js';
import {
  compareStrings,
  createStatelessAnalysisImplementation,
} from './analysis-support.js';

export const DIMENSION_ANALYSIS_IMPLEMENTATION_ID = 'omk.dimension-table/v1' as const;

const ALGORITHM_VERSION = 'omk.dimension-aggregation/v1' as const;

const DIMENSION_ANALYSIS_CAPABILITIES: JsonValue = {
  capabilityKind: 'analysis-node',
  analysisNodeKinds: ['reducer'],
  inputDomains: [{
    inputKind: 'analysis-result',
    schemaUris: [JUDGE_ENSEMBLE_TABLE_SCHEMA.schemaUri],
  }],
  outputSchema: DIMENSION_TABLE_SCHEMA,
  parameterSchema: DIMENSION_PARAMETERS_SCHEMA,
  inputCardinalities: {
    metricObservations: { min: 0, max: 0 },
    analysisResults: { min: 1 },
    comparisons: { min: 0, max: 0 },
  },
  schemas: [JUDGE_ENSEMBLE_TABLE_SCHEMA],
};

export const DIMENSION_ANALYSIS_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
      algorithmVersion: ALGORITHM_VERSION,
      estimator: 'equal-observed-dimension-mean',
      scoreScale: { min: DIMENSION_SCORE_MIN, max: DIMENSION_SCORE_MAX },
      decimals: DIMENSION_SCORE_DECIMALS,
      missingPolicyId: 'exclude/v1',
      applicability: 'upstream-group-presence',
      samplingUnitLineage: 'equal-across-upstream-dimensions',
      directMetricRowMembership: 'none-analysis-results-only',
      upstreamSchema: JUDGE_ENSEMBLE_TABLE_SCHEMA,
      outputSchema: DIMENSION_TABLE_SCHEMA,
      parameterSchema: DIMENSION_PARAMETERS_SCHEMA,
      declaredCapabilities: DIMENSION_ANALYSIS_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: DIMENSION_ANALYSIS_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

type AnalysisResultInput = Extract<AnalysisNodeInput, { inputKind: 'analysis-result' }>;

function analysisResultInputs(
  context: AnalysisNodeExecutionContext,
): readonly AnalysisResultInput[] {
  const inputs = context.inputs.filter((input): input is AnalysisResultInput => (
    input.inputKind === 'analysis-result'
  ));
  if (inputs.length === 0 || inputs.length !== context.inputs.length) {
    throw new TypeError('Dimension Analysis requires one or more Analysis result inputs only.');
  }
  for (const input of inputs) {
    if (input.record.resultType !== 'table'
        || canonicalizeJson(input.record.outputSchema)
          !== canonicalizeJson(JUDGE_ENSEMBLE_TABLE_SCHEMA)) {
      throw new TypeError('Dimension Analysis requires sealed judge ensemble table inputs.');
    }
  }
  return inputs;
}

function validateInputDesign(
  inputs: readonly AnalysisResultInput[],
  parameters: DimensionParameters,
): ReadonlyMap<string, DimensionParameter> {
  const dimensionsByResult = new Map(parameters.dimensions.map((dimension) => [
    dimension.analysisResultId,
    dimension,
  ]));
  const inputIds = inputs.map((input) => input.referenceId);
  if (new Set(inputIds).size !== inputIds.length
      || canonicalizeJson([...inputIds].sort(compareStrings))
        !== canonicalizeJson(parameters.dimensions.map((dimension) => (
          dimension.analysisResultId
        )))) {
    throw new TypeError(
      'Dimension parameters must map every upstream Analysis result exactly once and no others.',
    );
  }
  return dimensionsByResult;
}

function coordinateKey(group: JudgeEnsembleGroup): string {
  return canonicalizeJson([group.targetId, group.sampleId, group.trialIndex]);
}

function entryFromGroup(
  group: JudgeEnsembleGroup,
  dimension: DimensionParameter,
): DimensionEntry {
  const common = {
    dimensionId: dimension.dimensionId,
    metricId: dimension.metricId,
    sourceAnalysisResultId: dimension.analysisResultId,
    sourceGroupId: group.groupId,
  } as const;
  return group.aggregateStatus === 'observed'
    ? { ...common, dimensionStatus: 'observed', consensus: group.consensus }
    : { ...common, dimensionStatus: 'missing', reasonCode: group.reasonCode };
}

interface PendingGroup {
  targetId: string;
  sampleId: string;
  trialIndex: number;
  trialId: JudgeEnsembleGroup['trialId'];
  samplingUnitIds: JudgeEnsembleGroup['samplingUnitIds'];
  dimensions: DimensionEntry[];
}

function buildDimensionTable(
  inputs: readonly AnalysisResultInput[],
  parameters: DimensionParameters,
  signal: AbortSignal,
): DimensionTableValue {
  const dimensionsByResult = validateInputDesign(inputs, parameters);
  const pending = new Map<string, PendingGroup>();
  for (const input of inputs) {
    const dimension = dimensionsByResult.get(input.referenceId);
    if (dimension === undefined) {
      throw new TypeError(`Upstream Analysis result "${input.referenceId}" is not mapped.`);
    }
    const source = parseJudgeEnsembleTableEnvelope({
      resultType: input.record.resultType,
      value: input.record.value,
    }).value;
    for (const group of source.groups) {
      if (signal.aborted) throw signal.reason;
      if (group.metricId !== dimension.metricId) {
        throw new TypeError('Upstream ensemble Metric disagrees with dimension parameters.');
      }
      const key = coordinateKey(group);
      const existing = pending.get(key);
      if (existing === undefined) {
        pending.set(key, {
          targetId: group.targetId,
          sampleId: group.sampleId,
          trialIndex: group.trialIndex,
          trialId: group.trialId,
          samplingUnitIds: group.samplingUnitIds,
          dimensions: [entryFromGroup(group, dimension)],
        });
        continue;
      }
      if (existing.trialId !== group.trialId
          || canonicalizeJson(existing.samplingUnitIds)
            !== canonicalizeJson(group.samplingUnitIds)) {
        throw new TypeError('Upstream dimensions disagree on sealed measurement-unit lineage.');
      }
      if (existing.dimensions.some((entry) => entry.dimensionId === dimension.dimensionId)) {
        throw new TypeError('A measurement unit contains duplicate upstream dimension groups.');
      }
      existing.dimensions.push(entryFromGroup(group, dimension));
    }
  }
  const groups = [...pending.values()].map((source): DimensionGroup => {
    const dimensions = [...source.dimensions].sort((left, right) => (
      compareStrings(left.sourceAnalysisResultId, right.sourceAnalysisResultId)
      || compareStrings(left.metricId, right.metricId)
      || compareStrings(left.dimensionId, right.dimensionId)
    ));
    const withoutGroupId: Omit<DimensionGroup, 'groupId'> = {
      ...source,
      dimensions,
      coverage: dimensionCoverage(dimensions),
      aggregate: dimensionAggregate(dimensions),
    };
    return { groupId: dimensionGroupId(withoutGroupId), ...withoutGroupId };
  });
  groups.sort(compareDimensionGroups);
  return parseDimensionTableValue({ schemaVersion: DIMENSION_TABLE_SCHEMA_VERSION, groups });
}

export function createDimensionAnalysisNodes(): ReadonlyMap<
  string,
  AnalysisNodeImplementation
> {
  const implementation = createStatelessAnalysisImplementation({
    identity: DIMENSION_ANALYSIS_IDENTITY,
    outputSchema: DIMENSION_TABLE_SCHEMA,
    parseParameters: (parameters) => { parseDimensionParameters(parameters); },
    execute(context) {
      const parameters = parseDimensionParameters(context.node.parameters);
      const inputs = analysisResultInputs(context);
      validateInputDesign(inputs, parameters);
      const table = buildDimensionTable(inputs, parameters, context.signal);
      return {
        analysisStatus: 'completed',
        resultType: 'table',
        value: table,
        includedRowIds: [],
        comparableRowIds: [],
        assumptionChecks: [{
          assumptionId: 'dimension-contract',
          checkStatus: 'passed',
        }],
      };
    },
  });
  return new Map([[DIMENSION_ANALYSIS_IMPLEMENTATION_ID, implementation]]);
}
