import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  digestCanonicalJson,
  type JsonValue,
  type SchemaIdentity,
} from '../../../../src/eval-core/contracts/index.js';
import { AnalysisNodeCapabilitiesSchema } from '../../../../src/eval-core/compiler/index.js';
import type {
  AnalysisNodeExecutionContext,
  AnalysisNodeInput,
} from '../../../../src/eval-core/analysis/index.js';
import {
  AGREEMENT_ANALYSIS_IDENTITY,
  AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
  AGREEMENT_ANALYSIS_V2_IDENTITY,
  AGREEMENT_ANALYSIS_V2_IMPLEMENTATION_ID,
  AGREEMENT_ANALYSIS_V1_IDENTITY,
  AGREEMENT_ANALYSIS_V1_IMPLEMENTATION_ID,
  createAgreementAnalysisNodes,
} from '../../../../src/eval-workflows/measurement/analysis/agreement-node.js';
import { AGREEMENT_PARAMETERS_SCHEMA } from '../../../../src/eval-workflows/measurement/analysis/agreement-parameters.js';
import { AGREEMENT_SOURCE_SCHEMAS } from '../../../../src/eval-workflows/measurement/analysis/agreement-source-adapter.js';
import { extractAgreementPairs } from '../../../../src/eval-workflows/measurement/analysis/agreement-source-adapter.js';
import { extractAgreementPairs as extractAgreementPairsV1 } from '../../../../src/eval-workflows/measurement/analysis/agreement-source-adapter-v1.js';
import * as legacyDimension from '../../../../src/eval-workflows/measurement/analysis/dimension-table-v1.js';
import { AGREEMENT_TABLE_SCHEMA } from '../../../../src/eval-workflows/measurement/analysis/agreement-table.js';
import {
  DIMENSION_TABLE_SCHEMA,
  DIMENSION_TABLE_SCHEMA_VERSION,
  compareDimensionGroups,
  dimensionAggregate,
  dimensionCoverage,
  dimensionGroupId,
  type DimensionEntry,
  type DimensionGroup,
} from '../../../../src/eval-workflows/measurement/analysis/dimension-table.js';

const planDigest = digestCanonicalJson('agreement-plan');
const bundleDigest = digestCanonicalJson('agreement-bundle');

function dimensionGroup(
  sampleId: string,
  trialIndex: number,
  score?: number,
): DimensionGroup {
  const trialId = digestCanonicalJson({ targetId: 'treatment', sampleId, trialIndex });
  const entry: DimensionEntry = score === undefined ? {
    dimensionId: 'quality',
    metricId: 'rubric-quality',
    sourceAnalysisResultId: 'judge-quality',
    sourceGroupId: digestCanonicalJson({ sampleId, trialIndex, source: 'judge' }),
    weight: 1,
    dimensionStatus: 'missing',
    reasonCode: 'judge-ensemble-unobserved',
  } : {
    dimensionId: 'quality',
    metricId: 'rubric-quality',
    sourceAnalysisResultId: 'judge-quality',
    sourceGroupId: digestCanonicalJson({ sampleId, trialIndex, source: 'judge' }),
    weight: 1,
    dimensionStatus: 'observed',
    consensus: score,
  };
  const withoutGroupId: Omit<DimensionGroup, 'groupId'> = {
    targetId: 'treatment',
    sampleId,
    trialIndex,
    trialId,
    samplingUnitIds: {},
    dimensions: [entry],
    coverage: dimensionCoverage([entry]),
    aggregate: dimensionAggregate([entry]),
  };
  return { groupId: dimensionGroupId(withoutGroupId), ...withoutGroupId };
}

function dimensionValue(): JsonValue {
  return {
    schemaVersion: DIMENSION_TABLE_SCHEMA_VERSION,
    groups: [
      dimensionGroup('sample-0', 1),
      dimensionGroup('sample-1', 0, 2),
      dimensionGroup('sample-0', 0, 1),
    ].sort(compareDimensionGroups),
  };
}

function input(
  referenceId = 'dimension-table',
  outputSchema: SchemaIdentity = DIMENSION_TABLE_SCHEMA,
): Extract<AnalysisNodeInput, { inputKind: 'analysis-result' }> {
  return {
    inputKind: 'analysis-result',
    referenceId,
    record: {
      analysisStatus: 'completed',
      resultType: 'table',
      value: dimensionValue(),
      outputSchema,
    } as Extract<AnalysisNodeInput, { inputKind: 'analysis-result' }>['record'],
  };
}

function parameters() {
  return {
    source: {
      analysisResultId: 'dimension-table',
      sourceKind: 'dimension' as const,
      selector: 'aggregate' as const,
      targetId: 'treatment',
    },
    gold: {
      contextPointer: '/goldScore',
      annotatorId: 'human-a',
      annotationVersion: 'v1',
      scale: { min: 1, max: 5 },
    },
    sampleIds: ['sample-0', 'sample-1'],
    resamples: 100,
    alpha: 0.05,
    seed: 42,
  };
}

function samples(classification: 'gold' | 'sensitive' = 'gold') {
  return [1, 2].map((goldScore, index) => ({
    sampleId: `sample-${index}`,
    analysis: {
      memberships: [],
      context: { value: { goldScore }, classification },
    },
  })) as AnalysisNodeExecutionContext['samples'];
}

function context(
  inputs: readonly AnalysisNodeInput[] = [input()],
  overrides: Partial<AnalysisNodeExecutionContext> = {},
): AnalysisNodeExecutionContext {
  return {
    node: {
      analysisNodeKind: 'estimator',
      nodeId: 'agreement-table',
      implementationId: AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
      inputs: [{ inputKind: 'analysis-result', referenceId: 'dimension-table' }],
      outputResultId: 'agreement-table',
      parameters: parameters(),
    } as AnalysisNodeExecutionContext['node'],
    inputs,
    analysisPlanDigest: planDigest,
    sampling: {
      experimentalUnit: 'sample', repeatedMeasures: true,
      resamplingUnit: 'sample', estimatorId: AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
      seedCoupling: 'independent-by-target',
    },
    rootSeed: 'agreement-root-seed',
    samples: samples(),
    cohorts: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function execute(value: AnalysisNodeExecutionContext) {
  const implementation = createAgreementAnalysisNodes().get(AGREEMENT_ANALYSIS_IMPLEMENTATION_ID);
  if (implementation === undefined) throw new Error('missing Agreement implementation');
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

describe('Agreement Analysis node', () => {
  it('preserves legacy mean versus weighted mean and rejects cross-version envelopes', () => {
    const base = dimensionGroup('sample-0', 0, 1);
    const dimensions = [1, 5].map((consensus, index) => ({
      dimensionId: `quality-${index}`,
      metricId: `rubric-quality-${index}`,
      sourceAnalysisResultId: `judge-quality-${index}`,
      sourceGroupId: digestCanonicalJson({ source: 'judge', index }),
      weight: index === 0 ? 0.25 : 0.75,
      dimensionStatus: 'observed' as const,
      consensus,
    }));
    const current = {
      ...base, dimensions,
      coverage: dimensionCoverage(dimensions),
      aggregate: dimensionAggregate(dimensions),
    };
    current.groupId = dimensionGroupId(current);
    const oldDimensions = dimensions.map((entry) => ({
      dimensionId: entry.dimensionId,
      metricId: entry.metricId,
      sourceAnalysisResultId: entry.sourceAnalysisResultId,
      sourceGroupId: entry.sourceGroupId,
      dimensionStatus: entry.dimensionStatus,
      consensus: entry.consensus,
    }));
    const legacy = {
      ...base, dimensions: oldDimensions,
      coverage: legacyDimension.dimensionCoverage(oldDimensions),
      aggregate: legacyDimension.dimensionAggregate(oldDimensions),
    };
    legacy.groupId = legacyDimension.dimensionGroupId(legacy);
    const modernEnvelope = { resultType: 'table', value: { schemaVersion: DIMENSION_TABLE_SCHEMA_VERSION, groups: [current] } };
    const legacyEnvelope = { resultType: 'table', value: { schemaVersion: legacyDimension.DIMENSION_TABLE_SCHEMA_VERSION, groups: [legacy] } };

    expect(extractAgreementPairs(parameters(), modernEnvelope, samples())[0].judge)
      .toMatchObject({ ratingStatus: 'observed', score: 4 });
    expect(extractAgreementPairsV1(parameters(), legacyEnvelope, samples())[0].judge)
      .toMatchObject({ ratingStatus: 'observed', score: 3 });
    expect(() => extractAgreementPairs(parameters(), legacyEnvelope, samples())).toThrow();
    expect(() => extractAgreementPairsV1(parameters(), modernEnvelope, samples())).toThrow();
  });

  it.each([
    ['/scores/0/a~1b/~0', 4],
    ['/scores/01/a~1b/~0', undefined],
    ['/scores/-/a~1b/~0', undefined],
    ['/toString', undefined],
    ['/missing', undefined],
  ] as const)('resolves gold pointers without inherited fields: %s', (contextPointer, score) => {
    const configuration = parameters();
    configuration.gold.contextPointer = contextPointer;
    const sampleData = samples();
    const updatedSamples = sampleData.map((sample) => ({
      ...sample,
      analysis: { memberships: [], context: { classification: 'gold' as const, value: { scores: [{ 'a/b': { '~': 4 } }] } } },
    }));
    const pairs = extractAgreementPairs(configuration, { resultType: 'table', value: dimensionValue() }, updatedSamples);
    expect(pairs[0].gold).toEqual(score === undefined
      ? { ratingStatus: 'unavailable', reasonCode: 'gold-rating-unavailable' }
      : { ratingStatus: 'observed', score });
  });

  it('declares canonical capabilities and aggregates Dimension trials by sealed sample', async () => {
    const capabilities = AnalysisNodeCapabilitiesSchema.parse(AGREEMENT_ANALYSIS_IDENTITY.capabilities);
    expect(capabilities.inputDomains).toEqual([{
      inputKind: 'analysis-result',
      schemaUris: AGREEMENT_SOURCE_SCHEMAS.map((schema) => schema.schemaUri),
    }]);
    expect(capabilities.outputSchema).toEqual(AGREEMENT_TABLE_SCHEMA);
    expect(capabilities.parameterSchema).toEqual(AGREEMENT_PARAMETERS_SCHEMA);
    expect(Object.isFrozen(AGREEMENT_ANALYSIS_IDENTITY)).toBe(true);
    expect(AGREEMENT_ANALYSIS_V2_IDENTITY.fingerprint).toBe(
      'sha256:f93712cdf9b2cadc19d049291b458a72f670fcd7f4a9b2873a0b4ecc11229581',
    );
    expect(AGREEMENT_ANALYSIS_IDENTITY.implementationId).toBe('omk.agreement-table/v3');
    expect(AGREEMENT_ANALYSIS_IDENTITY.fingerprint).toBe(
      'sha256:4de30b1ec1e3a19ec92d9f34b503ba755649230de49550e79c9d77b0060101b1',
    );

    const result = await execute(context());
    expect(result).toMatchObject({
      analysisStatus: 'completed',
      resultType: 'table',
      includedRowIds: [],
      comparableRowIds: [],
      value: {
        pairs: [{
          sampleId: 'sample-0',
          gold: { ratingStatus: 'observed', score: 1 },
          judge: {
            ratingStatus: 'observed', score: 1,
            coverage: { plannedGroups: 2, observedGroups: 1, missingGroups: 1 },
          },
        }, {
          sampleId: 'sample-1',
          gold: { ratingStatus: 'observed', score: 2 },
          judge: {
            ratingStatus: 'observed', score: 2,
            coverage: { plannedGroups: 1, observedGroups: 1, missingGroups: 0 },
          },
        }],
        statistics: {
          krippendorffAlpha: { statisticStatus: 'observed', value: 1 },
          weightedKappa: { statisticStatus: 'observed', value: 1 },
          pearson: { statisticStatus: 'observed', value: 1 },
        },
      },
    });
  });

  it('registers the explicitly versioned assignment-aware runtime identities', () => {
    expect(AGREEMENT_ANALYSIS_V1_IDENTITY.fingerprint).toBe(
      'sha256:c88a9d4fcc67c892da96ce7e4baec35e9ec8bf04da4afd7fb966c3f0dbb03373',
    );
    expect(createAgreementAnalysisNodes().get(
      AGREEMENT_ANALYSIS_V1_IMPLEMENTATION_ID,
    )?.identity).toEqual(AGREEMENT_ANALYSIS_V1_IDENTITY);
    expect(createAgreementAnalysisNodes().get(
      AGREEMENT_ANALYSIS_V2_IMPLEMENTATION_ID,
    )?.identity).toEqual(AGREEMENT_ANALYSIS_V2_IDENTITY);
  });

  it('rejects source, sample-order, Gold classification, and cancellation drift', async () => {
    await expect(execute(context([input('wrong-result')]))).rejects.toThrow(/sealed parameter/);
    await expect(execute(context([input('dimension-table', AGREEMENT_TABLE_SCHEMA)])))
      .rejects.toThrow(/Dimension table schema/);
    await expect(execute(context(undefined, {
      samples: [...samples()].reverse() as AnalysisNodeExecutionContext['samples'],
    }))).rejects.toThrow(/sample order/);
    await expect(execute(context(undefined, { samples: samples('sensitive') })))
      .rejects.toThrow(/gold classification/);

    const controller = new AbortController();
    controller.abort(new Error('cancel-agreement'));
    await expect(execute(context(undefined, { signal: controller.signal })))
      .rejects.toThrow('cancel-agreement');
    expect(canonicalizeJson(AGREEMENT_SOURCE_SCHEMAS))
      .toBe(canonicalizeJson([DIMENSION_TABLE_SCHEMA]));
  });
});
