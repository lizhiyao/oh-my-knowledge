import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  digestCanonicalJson,
} from '../../../../src/eval-core/contracts/index.js';
import {
  ASSERTION_LAYER_TABLE_SCHEMA,
  ASSERTION_LAYER_TABLE_SCHEMA_VERSION,
  assertionLayerAggregate,
  assertionLayerCoverage,
  assertionLayerGroupId,
  type AssertionEntry,
  type AssertionLayerGroup,
  type AssertionLayerTableValue,
} from '../../../../src/eval-workflows/measurement/analysis/assertion-layer.js';
import type { CompositeLayerParameter } from '../../../../src/eval-workflows/measurement/analysis/composite-parameters.js';
import {
  compositeSourceSchema,
  extractCompositeSourceLayers,
} from '../../../../src/eval-workflows/measurement/analysis/composite-source-adapter.js';
import {
  DIMENSION_TABLE_SCHEMA,
  DIMENSION_TABLE_SCHEMA_VERSION,
  dimensionAggregate,
  dimensionCoverage,
  dimensionGroupId,
  type DimensionEntry,
  type DimensionGroup,
  type DimensionTableValue,
} from '../../../../src/eval-workflows/measurement/analysis/dimension-table.js';
import {
  JUDGE_ENSEMBLE_TABLE_SCHEMA,
  JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
  type JudgeEnsembleTableValue,
} from '../../../../src/eval-workflows/measurement/analysis/judge-aggregation.js';

const trialId = digestCanonicalJson('composite-source-trial');
const samplingUnitIds = { pairingBlockId: digestCanonicalJson('composite-source-pair') };

const factBinding: CompositeLayerParameter = {
  layerId: 'fact', analysisResultId: 'assertion-layers',
  sourceKind: 'assertion-layer', selector: 'fact',
};
const behaviorBinding: CompositeLayerParameter = {
  layerId: 'behavior', analysisResultId: 'assertion-layers',
  sourceKind: 'assertion-layer', selector: 'behavior',
};
const ensembleBinding: CompositeLayerParameter = {
  layerId: 'judge', analysisResultId: 'judge-ensemble',
  sourceKind: 'judge-ensemble', selector: 'consensus',
};
const dimensionBinding: CompositeLayerParameter = {
  layerId: 'judge', analysisResultId: 'dimension-table',
  sourceKind: 'dimension', selector: 'aggregate',
};

function assertionEnvelope() {
  const entries: AssertionEntry[] = [{
    criterionId: 'fact-check',
    metricId: 'assert-fact-check',
    layerDisposition: 'fact',
    weight: 1,
    rowId: digestCanonicalJson('assertion-row'),
    evaluatorId: 'assertion-evaluator',
    censored: false,
    applicability: 'applicable',
    rowStatus: 'observed',
    value: true,
  }];
  const withoutGroupId: Omit<AssertionLayerGroup, 'groupId'> = {
    targetId: 'candidate', sampleId: 'sample-a', trialIndex: 0, trialId,
    samplingUnitIds,
    entries,
    layers: {
      fact: assertionLayerAggregate(entries),
      behavior: assertionLayerAggregate([]),
    },
    excludedMixedLayer: { coverage: assertionLayerCoverage([]) },
  };
  return {
    resultType: 'table' as const,
    value: {
      schemaVersion: ASSERTION_LAYER_TABLE_SCHEMA_VERSION,
      groups: [{ groupId: assertionLayerGroupId(withoutGroupId), ...withoutGroupId }],
    } satisfies AssertionLayerTableValue,
  };
}

function ensembleEnvelope() {
  const sourceGroupId = digestCanonicalJson('replicate-group');
  const sourceRowId = digestCanonicalJson('judge-row');
  const group = {
    groupId: digestCanonicalJson({
      derivation: JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
      key: [
        'candidate', 'sample-a', 0, trialId, samplingUnitIds,
        'rubric-quality', 'quality-instrument', 'primary',
      ],
      sourceGroupIds: [sourceGroupId],
    }),
    targetId: 'candidate', sampleId: 'sample-a', trialIndex: 0, trialId,
    samplingUnitIds,
    metricId: 'rubric-quality',
    instrumentId: 'quality-instrument',
    replicateGroupId: 'primary',
    coverage: { plannedMembers: 1, observedMembers: 1, missingMembers: 0 },
    members: [{
      ensembleMemberId: 'member-a', sourceGroupId, sourceRowIds: [sourceRowId],
      coverage: {
        planned: 1, observed: 1, missing: 0, invalid: 0,
        evaluationFailed: 0, sourceUnavailable: 0, notStarted: 0, censored: 0,
      },
      memberStatus: 'observed' as const,
      mean: 4,
      sampleStddev: 0,
    }],
    agreement: {
      agreementStatus: 'missing' as const,
      reasonCode: 'judge-agreement-insufficient-members' as const,
      pairCount: 0 as const,
    },
    aggregateStatus: 'observed' as const,
    consensus: 4,
  };
  return {
    resultType: 'table' as const,
    value: {
      schemaVersion: JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
      groups: [group],
    } satisfies JudgeEnsembleTableValue,
  };
}

function dimensionEnvelope(missing = false) {
  const entry: DimensionEntry = missing
    ? {
        dimensionId: 'quality', metricId: 'rubric-quality',
        sourceAnalysisResultId: 'judge-ensemble',
        sourceGroupId: digestCanonicalJson('dimension-source'),
        weight: 1,
        dimensionStatus: 'missing', reasonCode: 'judge-ensemble-unobserved',
      }
    : {
        dimensionId: 'quality', metricId: 'rubric-quality',
        sourceAnalysisResultId: 'judge-ensemble',
        sourceGroupId: digestCanonicalJson('dimension-source'),
        weight: 1,
        dimensionStatus: 'observed', consensus: 3.5,
      };
  const withoutGroupId: Omit<DimensionGroup, 'groupId'> = {
    targetId: 'candidate', sampleId: 'sample-a', trialIndex: 0, trialId,
    samplingUnitIds,
    dimensions: [entry],
    coverage: dimensionCoverage([entry]),
    aggregate: dimensionAggregate([entry]),
  };
  return {
    resultType: 'table' as const,
    value: {
      schemaVersion: DIMENSION_TABLE_SCHEMA_VERSION,
      groups: [{ groupId: dimensionGroupId(withoutGroupId), ...withoutGroupId }],
    } satisfies DimensionTableValue,
  };
}

describe('composite source adapter', () => {
  it('binds every source kind to its exact sealed schema', () => {
    expect(canonicalizeJson(compositeSourceSchema(factBinding)))
      .toBe(canonicalizeJson(ASSERTION_LAYER_TABLE_SCHEMA));
    expect(canonicalizeJson(compositeSourceSchema(ensembleBinding)))
      .toBe(canonicalizeJson(JUDGE_ENSEMBLE_TABLE_SCHEMA));
    expect(canonicalizeJson(compositeSourceSchema(dimensionBinding)))
      .toBe(canonicalizeJson(DIMENSION_TABLE_SCHEMA));
  });

  it('selects fact and behavior independently from one assertion source group', () => {
    const fact = extractCompositeSourceLayers(factBinding, assertionEnvelope())[0];
    const behavior = extractCompositeSourceLayers(behaviorBinding, assertionEnvelope())[0];
    expect(fact.layer).toMatchObject({
      binding: factBinding,
      sourceGroupId: behavior.layer.sourceGroupId,
      layerStatus: 'observed',
      score: 5,
    });
    expect(behavior.layer).toMatchObject({
      binding: behaviorBinding,
      layerStatus: 'missing',
      reasonCode: 'assertion-layer-unobserved',
    });
  });

  it('maps ensemble consensus and dimension aggregate without normalization', () => {
    expect(extractCompositeSourceLayers(ensembleBinding, ensembleEnvelope())[0].layer)
      .toMatchObject({ layerStatus: 'observed', score: 4 });
    expect(extractCompositeSourceLayers(dimensionBinding, dimensionEnvelope())[0].layer)
      .toMatchObject({ layerStatus: 'observed', score: 3.5 });
    expect(extractCompositeSourceLayers(dimensionBinding, dimensionEnvelope(true))[0].layer)
      .toMatchObject({ layerStatus: 'missing', reasonCode: 'dimension-unobserved' });
  });

  it('validates upstream semantics and never infers a source schema from payload shape', () => {
    const forged = structuredClone(dimensionEnvelope());
    const aggregate = forged.value.groups[0].aggregate;
    if (aggregate.aggregateStatus === 'observed') aggregate.weightedMean = 4.5;
    expect(() => extractCompositeSourceLayers(dimensionBinding, forged)).toThrow();
    expect(() => extractCompositeSourceLayers(ensembleBinding, dimensionEnvelope())).toThrow();
  });

  it('propagates cancellation before converting source groups', () => {
    const controller = new AbortController();
    const reason = new Error('cancel composite extraction');
    controller.abort(reason);
    expect(() => extractCompositeSourceLayers(
      dimensionBinding,
      dimensionEnvelope(),
      controller.signal,
    )).toThrow(reason);
  });
});
