import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  digestCanonicalJson,
  type JsonValue,
  type SamplingUnitIds,
  type SchemaIdentity,
} from '../../../src/eval-core/contracts/index.js';
import { AnalysisNodeCapabilitiesSchema } from '../../../src/eval-core/compiler/index.js';
import type {
  AnalysisNodeExecutionContext,
  AnalysisNodeExecutionResult,
  AnalysisNodeInput,
} from '../../../src/eval-core/analysis/index.js';
import {
  ASSERTION_LAYER_TABLE_SCHEMA,
  ASSERTION_LAYER_TABLE_SCHEMA_VERSION,
  assertionLayerAggregate,
  assertionLayerCoverage,
  assertionLayerGroupId,
  type AssertionEntry,
  type AssertionLayerGroup,
  type AssertionLayerTableValue,
} from '../../../src/eval-workflows/runtime-adapter/analysis/assertion-layer.js';
import {
  COMPOSITE_ANALYSIS_IDENTITY,
  COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
  createCompositeAnalysisNodes,
} from '../../../src/eval-workflows/runtime-adapter/analysis/composite-node.js';
import {
  COMPOSITE_PARAMETERS_SCHEMA,
  type CompositeLayerParameter,
} from '../../../src/eval-workflows/runtime-adapter/analysis/composite-parameters.js';
import { COMPOSITE_SOURCE_SCHEMAS } from '../../../src/eval-workflows/runtime-adapter/analysis/composite-source-adapter.js';
import { COMPOSITE_TABLE_SCHEMA } from '../../../src/eval-workflows/runtime-adapter/analysis/composite-table.js';
import {
  DIMENSION_TABLE_SCHEMA,
  DIMENSION_TABLE_SCHEMA_VERSION,
  dimensionAggregate,
  dimensionCoverage,
  dimensionGroupId,
  type DimensionEntry,
  type DimensionGroup,
  type DimensionTableValue,
} from '../../../src/eval-workflows/runtime-adapter/analysis/dimension-table.js';
import {
  JUDGE_ENSEMBLE_TABLE_SCHEMA,
  JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
  type JudgeEnsembleGroup,
  type JudgeEnsembleTableValue,
} from '../../../src/eval-workflows/runtime-adapter/analysis/judge-aggregation.js';

const planDigest = digestCanonicalJson('composite-plan');
const bundleDigest = digestCanonicalJson('composite-bundle');
const trialId = digestCanonicalJson('composite-trial');
const defaultSampling = { pairingBlockId: digestCanonicalJson('composite-pair') };

const fact: CompositeLayerParameter = {
  layerId: 'fact', analysisResultId: 'assertion-layers',
  sourceKind: 'assertion-layer', selector: 'fact',
};
const behavior: CompositeLayerParameter = {
  layerId: 'behavior', analysisResultId: 'assertion-layers',
  sourceKind: 'assertion-layer', selector: 'behavior',
};
const dimensionJudge: CompositeLayerParameter = {
  layerId: 'judge', analysisResultId: 'dimension-table',
  sourceKind: 'dimension', selector: 'aggregate',
};
const ensembleJudge: CompositeLayerParameter = {
  layerId: 'judge', analysisResultId: 'judge-ensemble',
  sourceKind: 'judge-ensemble', selector: 'consensus',
};

function assertionEnvelope() {
  const designs = [
    ['fact-a', 'assert-a', 'fact', 2, true],
    ['fact-b', 'assert-b', 'fact', 3, false],
    ['fact-c', 'assert-c', 'fact', 2, true],
    ['behavior-a', 'assert-d', 'behavior', 1, true],
  ] as const;
  const entries: AssertionEntry[] = designs.map(([
    criterionId, metricId, layerDisposition, weight, value,
  ]) => ({
    criterionId, metricId, layerDisposition, weight, value,
    rowId: digestCanonicalJson({ criterionId }),
    evaluatorId: `evaluator-${criterionId}`,
    censored: false,
    applicability: 'applicable',
    rowStatus: 'observed',
  }));
  const withoutGroupId: Omit<AssertionLayerGroup, 'groupId'> = {
    targetId: 'candidate', sampleId: 'sample-a', trialIndex: 0, trialId,
    samplingUnitIds: defaultSampling,
    entries,
    layers: {
      fact: assertionLayerAggregate(entries.filter((entry) => (
        entry.layerDisposition === 'fact'
      ))),
      behavior: assertionLayerAggregate(entries.filter((entry) => (
        entry.layerDisposition === 'behavior'
      ))),
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

interface DimensionOptions {
  sampleId?: string;
  trialId?: string;
  samplingUnitIds?: SamplingUnitIds;
  score?: number;
  missing?: boolean;
}

function dimensionEnvelope(options: DimensionOptions = {}) {
  const sampleId = options.sampleId ?? 'sample-a';
  const entry: DimensionEntry = options.missing === true
    ? {
        dimensionId: 'quality', metricId: 'rubric-quality',
        sourceAnalysisResultId: 'judge-quality',
        sourceGroupId: digestCanonicalJson({ source: sampleId }),
        dimensionStatus: 'missing', reasonCode: 'judge-ensemble-unobserved',
      }
    : {
        dimensionId: 'quality', metricId: 'rubric-quality',
        sourceAnalysisResultId: 'judge-quality',
        sourceGroupId: digestCanonicalJson({ source: sampleId }),
        dimensionStatus: 'observed', consensus: options.score ?? 4,
      };
  const withoutGroupId: Omit<DimensionGroup, 'groupId'> = {
    targetId: 'candidate', sampleId, trialIndex: 0,
    trialId: options.trialId ?? trialId,
    samplingUnitIds: options.samplingUnitIds ?? defaultSampling,
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

function ensembleGroup(metricId = 'rubric-quality'): JudgeEnsembleGroup {
  const sourceGroupId = digestCanonicalJson({ replicate: metricId });
  const instrumentId = `instrument-${metricId}`;
  return {
    groupId: digestCanonicalJson({
      derivation: JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
      key: [
        'candidate', 'sample-a', 0, trialId, defaultSampling,
        metricId, instrumentId, 'primary',
      ],
      sourceGroupIds: [sourceGroupId],
    }),
    targetId: 'candidate', sampleId: 'sample-a', trialIndex: 0, trialId,
    samplingUnitIds: defaultSampling,
    metricId,
    instrumentId,
    replicateGroupId: 'primary',
    coverage: { plannedMembers: 1, observedMembers: 1, missingMembers: 0 },
    members: [{
      ensembleMemberId: 'member-a', sourceGroupId,
      sourceRowIds: [digestCanonicalJson({ row: metricId })],
      coverage: {
        planned: 1, observed: 1, missing: 0, invalid: 0,
        evaluationFailed: 0, sourceUnavailable: 0, notStarted: 0, censored: 0,
      },
      memberStatus: 'observed', mean: 4, sampleStddev: 0,
    }],
    agreement: {
      agreementStatus: 'missing',
      reasonCode: 'judge-agreement-insufficient-members',
      pairCount: 0,
    },
    aggregateStatus: 'observed',
    consensus: 4,
  };
}

function ensembleEnvelope(groups: JudgeEnsembleGroup[] = [ensembleGroup()]) {
  return {
    resultType: 'table' as const,
    value: {
      schemaVersion: JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
      groups,
    } satisfies JudgeEnsembleTableValue,
  };
}

type AnalysisResultInput = Extract<AnalysisNodeInput, { inputKind: 'analysis-result' }>;

function input(
  referenceId: string,
  envelope: Readonly<{ resultType: 'table'; value: JsonValue }>,
  outputSchema: SchemaIdentity,
): AnalysisResultInput {
  return {
    inputKind: 'analysis-result',
    referenceId,
    record: {
      analysisStatus: 'completed',
      resultType: envelope.resultType,
      value: envelope.value,
      outputSchema,
    } as AnalysisResultInput['record'],
  };
}

function context(
  inputs: readonly AnalysisNodeInput[],
  layers: readonly CompositeLayerParameter[],
  signal: AbortSignal = new AbortController().signal,
): AnalysisNodeExecutionContext {
  return {
    node: {
      analysisNodeKind: 'reducer',
      nodeId: 'composite-table',
      implementationId: COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
      inputs: inputs.map((source) => ({
        inputKind: source.inputKind,
        referenceId: source.referenceId,
      })),
      outputResultId: 'composite-table',
      parameters: { layers },
    } as AnalysisNodeExecutionContext['node'],
    inputs,
    analysisPlanDigest: planDigest,
    sampling: {
      experimentalUnit: 'sample', repeatedMeasures: false,
      resamplingUnit: 'sample', estimatorId: 'bootstrap.mean-percentile/v1',
      seedCoupling: 'independent-by-target',
    } as AnalysisNodeExecutionContext['sampling'],
    rootSeed: 'root-seed',
    samples: [] as unknown as AnalysisNodeExecutionContext['samples'],
    cohorts: [],
    signal,
  };
}

async function execute(value: AnalysisNodeExecutionContext): Promise<AnalysisNodeExecutionResult> {
  const implementation = createCompositeAnalysisNodes().get(COMPOSITE_ANALYSIS_IMPLEMENTATION_ID);
  if (implementation === undefined) throw new Error('missing composite implementation');
  const run = await implementation.openRun({
    runId: 'run-a', analysisPlanDigest: planDigest,
    evaluationBundleDigest: bundleDigest, analysisMode: 'preregistered',
  });
  try {
    return await run.execute(value);
  } finally {
    await run.dispose();
  }
}

describe('composite Analysis node', () => {
  it('declares a compiler-valid, fingerprint-bound Analysis-result reducer', () => {
    const capabilities = AnalysisNodeCapabilitiesSchema.parse(
      COMPOSITE_ANALYSIS_IDENTITY.capabilities,
    );
    expect(capabilities.inputDomains).toEqual([{
      inputKind: 'analysis-result',
      schemaUris: COMPOSITE_SOURCE_SCHEMAS.map((schema) => schema.schemaUri),
    }]);
    expect(capabilities.outputSchema).toEqual(COMPOSITE_TABLE_SCHEMA);
    expect(capabilities.parameterSchema).toEqual(COMPOSITE_PARAMETERS_SCHEMA);
    expect(Object.isFrozen(COMPOSITE_ANALYSIS_IDENTITY)).toBe(true);
  });

  it('reproduces 3.29 + 5 + 4 → 4.1 independent of input order', async () => {
    const assertion = input('assertion-layers', assertionEnvelope(), ASSERTION_LAYER_TABLE_SCHEMA);
    const dimension = input('dimension-table', dimensionEnvelope(), DIMENSION_TABLE_SCHEMA);
    const layers = [fact, behavior, dimensionJudge];
    const forward = await execute(context([assertion, dimension], layers));
    const reverse = await execute(context([dimension, assertion], layers));
    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({
      analysisStatus: 'completed',
      includedRowIds: [],
      comparableRowIds: [],
      assumptionChecks: [{ assumptionId: 'composite-contract', checkStatus: 'passed' }],
      value: {
        groups: [{
          aggregate: { aggregateStatus: 'observed', score: 4.1 },
          coverage: { plannedLayers: 3, observedLayers: 3, missingLayers: 0 },
        }],
      },
    });
  });

  it('supports an explicit single-rubric judge-only composite', async () => {
    const source = input('judge-ensemble', ensembleEnvelope(), JUDGE_ENSEMBLE_TABLE_SCHEMA);
    const result = await execute(context([source], [ensembleJudge]));
    expect(result).toMatchObject({
      value: { groups: [{ aggregate: { aggregateStatus: 'observed', score: 4 } }] },
    });
  });

  it('excludes missing layers, preserves all-missing, and treats absent groups structurally', async () => {
    const observed = input('assertion-layers', assertionEnvelope(), ASSERTION_LAYER_TABLE_SCHEMA);
    const missing = input(
      'dimension-table', dimensionEnvelope({ missing: true }), DIMENSION_TABLE_SCHEMA,
    );
    expect(await execute(context([observed, missing], [fact, dimensionJudge]))).toMatchObject({
      value: { groups: [{
        aggregate: { aggregateStatus: 'observed', score: 3.29 },
        coverage: { plannedLayers: 2, observedLayers: 1, missingLayers: 1 },
      }] },
    });
    expect(await execute(context([missing], [dimensionJudge]))).toMatchObject({
      value: { groups: [{
        aggregate: { aggregateStatus: 'missing', reasonCode: 'composite-unobserved' },
      }] },
    });
    const otherUnit = input('dimension-table', dimensionEnvelope({
      sampleId: 'sample-b',
      samplingUnitIds: { pairingBlockId: digestCanonicalJson('pair-b') },
    }), DIMENSION_TABLE_SCHEMA);
    const separated = await execute(context([observed, otherUnit], [fact, dimensionJudge]));
    if (separated.analysisStatus !== 'completed') throw new Error('expected completed result');
    expect((separated.value as { groups: Array<{ coverage: unknown }> }).groups
      .map((group) => group.coverage)).toEqual([
      { plannedLayers: 1, observedLayers: 1, missingLayers: 0 },
      { plannedLayers: 1, observedLayers: 1, missingLayers: 0 },
    ]);
  });

  it('rejects incomplete mappings, extra inputs, and mismatched source schemas', async () => {
    const assertion = input('assertion-layers', assertionEnvelope(), ASSERTION_LAYER_TABLE_SCHEMA);
    const dimension = input('dimension-table', dimensionEnvelope(), DIMENSION_TABLE_SCHEMA);
    await expect(execute(context([assertion], [fact, dimensionJudge]))).rejects.toThrow(
      'map every upstream Analysis result exactly once',
    );
    await expect(execute(context([assertion, dimension], [fact]))).rejects.toThrow(
      'map every upstream Analysis result exactly once',
    );
    await expect(execute(context([
      assertion, structuredClone(assertion), dimension,
    ], [fact, dimensionJudge]))).rejects.toThrow(
      'map every upstream Analysis result exactly once',
    );
    const wrong = structuredClone(dimension);
    wrong.record.outputSchema = ASSERTION_LAYER_TABLE_SCHEMA;
    await expect(execute(context([wrong], [dimensionJudge]))).rejects.toThrow(
      'sealed source schema',
    );
    const scalar = structuredClone(dimension);
    scalar.record.resultType = 'scalar';
    await expect(execute(context([scalar], [dimensionJudge]))).rejects.toThrow(
      'sealed source schema',
    );
    const comparison = {
      inputKind: 'comparison',
      referenceId: 'comparison-a',
      contrast: {
        comparisonId: 'comparison-a', controlTargetId: 'control',
        treatmentTargetId: 'candidate', metricId: 'quality',
      },
    } satisfies AnalysisNodeInput;
    await expect(execute(context([assertion, comparison], [fact]))).rejects.toThrow(
      'Analysis result inputs only',
    );
  });

  it('rejects duplicate per-unit judge groups and conflicting unit lineage', async () => {
    const duplicateEnvelope = ensembleEnvelope([
      ensembleGroup('rubric-a'),
      ensembleGroup('rubric-b'),
    ]);
    await expect(execute(context([
      input('judge-ensemble', duplicateEnvelope, JUDGE_ENSEMBLE_TABLE_SCHEMA),
    ], [ensembleJudge]))).rejects.toThrow('duplicate upstream layer groups');

    const assertion = input('assertion-layers', assertionEnvelope(), ASSERTION_LAYER_TABLE_SCHEMA);
    const conflict = input('dimension-table', dimensionEnvelope({
      trialId: digestCanonicalJson('other-trial'),
    }), DIMENSION_TABLE_SCHEMA);
    await expect(execute(context([assertion, conflict], [fact, dimensionJudge])))
      .rejects.toThrow('disagree on sealed measurement-unit lineage');
  });

  it('propagates cancellation and does not mutate source envelopes', async () => {
    const inputs = [
      input('assertion-layers', assertionEnvelope(), ASSERTION_LAYER_TABLE_SCHEMA),
      input('dimension-table', dimensionEnvelope(), DIMENSION_TABLE_SCHEMA),
    ];
    const before = canonicalizeJson(inputs);
    await execute(context(inputs, [fact, behavior, dimensionJudge]));
    expect(canonicalizeJson(inputs)).toBe(before);

    const controller = new AbortController();
    controller.abort(new Error('composite-cancelled'));
    await expect(execute(context(inputs, [fact, behavior, dimensionJudge], controller.signal)))
      .rejects.toThrow('composite-cancelled');
  });
});
