import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  digestCanonicalJson,
  schemaIdentityKey,
  type JsonValue,
  type SamplingUnitIds,
} from '../../../src/eval-core/contracts/index.js';
import { AnalysisNodeCapabilitiesSchema } from '../../../src/eval-core/compiler/index.js';
import type {
  AnalysisNodeExecutionContext,
  AnalysisNodeExecutionResult,
  AnalysisNodeInput,
} from '../../../src/eval-core/analysis/index.js';
import {
  DIMENSION_ANALYSIS_IDENTITY,
  DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
  createDimensionAnalysisNodes,
} from '../../../src/eval-workflows/runtime-adapter/analysis/dimension-node.js';
import {
  DIMENSION_PARAMETERS_SCHEMA,
  type DimensionParameter,
} from '../../../src/eval-workflows/runtime-adapter/analysis/dimension-parameters.js';
import {
  DIMENSION_TABLE_SCHEMA,
  createDimensionTableSchemaValidators,
} from '../../../src/eval-workflows/runtime-adapter/analysis/dimension-table.js';
import {
  JUDGE_ENSEMBLE_TABLE_SCHEMA,
  JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
  parseJudgeEnsembleTableEnvelope,
} from '../../../src/eval-workflows/runtime-adapter/analysis/judge-aggregation.js';

const ANALYSIS_PLAN_DIGEST = digestCanonicalJson('dimension-analysis-plan');
const EVALUATION_BUNDLE_DIGEST = digestCanonicalJson('dimension-evaluation-bundle');
const TRIAL_ID = digestCanonicalJson('dimension-trial');
const PAIRING_BLOCK_ID = digestCanonicalJson('dimension-pair');

const security: DimensionParameter = {
  dimensionId: 'security',
  metricId: 'rubric-security',
  analysisResultId: 'ensemble-security',
};
const actionability: DimensionParameter = {
  dimensionId: 'actionability',
  metricId: 'rubric-actionability',
  analysisResultId: 'ensemble-actionability',
};

interface SourceOptions {
  sampleId?: string;
  trialId?: string;
  samplingUnitIds?: SamplingUnitIds;
  score?: number;
  missing?: boolean;
  suffix?: string;
  instrumentId?: string;
}

function sourceGroup(dimension: DimensionParameter, options: SourceOptions = {}) {
  const sampleId = options.sampleId ?? 'sample-a';
  const trialId = options.trialId ?? TRIAL_ID;
  const samplingUnitIds = options.samplingUnitIds ?? { pairingBlockId: PAIRING_BLOCK_ID };
  const suffix = options.suffix ?? sampleId;
  const instrumentId = options.instrumentId ?? `instrument-${dimension.dimensionId}`;
  const sourceGroupId = digestCanonicalJson({ dimension: dimension.dimensionId, suffix });
  const sourceRowId = digestCanonicalJson({ row: dimension.dimensionId, suffix });
  const member = options.missing
    ? {
        ensembleMemberId: 'member-a',
        sourceGroupId,
        sourceRowIds: [sourceRowId],
        coverage: {
          planned: 1,
          observed: 0,
          missing: 0,
          invalid: 0,
          evaluationFailed: 1,
          sourceUnavailable: 0,
          notStarted: 0,
          censored: 0,
        },
        memberStatus: 'missing' as const,
        reasonCode: 'judge-replicates-unobserved' as const,
      }
    : {
        ensembleMemberId: 'member-a',
        sourceGroupId,
        sourceRowIds: [sourceRowId],
        coverage: {
          planned: 1,
          observed: 1,
          missing: 0,
          invalid: 0,
          evaluationFailed: 0,
          sourceUnavailable: 0,
          notStarted: 0,
          censored: 0,
        },
        memberStatus: 'observed' as const,
        mean: options.score ?? 4,
        sampleStddev: 0,
      };
  const common = {
    groupId: digestCanonicalJson({
      derivation: JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
      key: [
        'candidate', sampleId, 0, trialId, samplingUnitIds, dimension.metricId,
        instrumentId, 'primary',
      ],
      sourceGroupIds: [sourceGroupId],
    }),
    targetId: 'candidate',
    sampleId,
    trialIndex: 0,
    trialId,
    samplingUnitIds,
    metricId: dimension.metricId,
    instrumentId,
    replicateGroupId: 'primary',
    coverage: {
      plannedMembers: 1,
      observedMembers: options.missing ? 0 : 1,
      missingMembers: options.missing ? 1 : 0,
    },
    members: [member],
    agreement: {
      agreementStatus: 'missing' as const,
      reasonCode: 'judge-agreement-insufficient-members' as const,
      pairCount: 0 as const,
    },
  };
  return options.missing
    ? {
        ...common,
        aggregateStatus: 'missing' as const,
        reasonCode: 'judge-ensemble-unobserved' as const,
      }
    : { ...common, aggregateStatus: 'observed' as const, consensus: options.score ?? 4 };
}

type AnalysisResultInput = Extract<AnalysisNodeInput, { inputKind: 'analysis-result' }>;

function input(dimension: DimensionParameter, options: SourceOptions = {}): AnalysisResultInput {
  const value = {
    schemaVersion: JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
    groups: [sourceGroup(dimension, options)],
  };
  parseJudgeEnsembleTableEnvelope({ resultType: 'table', value });
  return {
    inputKind: 'analysis-result',
    referenceId: dimension.analysisResultId,
    record: {
      analysisStatus: 'completed',
      resultType: 'table',
      value,
      outputSchema: JUDGE_ENSEMBLE_TABLE_SCHEMA,
    } as unknown as AnalysisResultInput['record'],
  };
}

function parameters(dimensions: readonly DimensionParameter[] = [security, actionability]): JsonValue {
  return { dimensions: dimensions.map((dimension) => ({ ...dimension })) };
}

function context(
  inputs: readonly AnalysisResultInput[] = [input(security, { score: 5 }), input(actionability, { score: 3 })],
  dimensions: readonly DimensionParameter[] = [security, actionability],
  signal: AbortSignal = new AbortController().signal,
): AnalysisNodeExecutionContext {
  return {
    node: {
      analysisNodeKind: 'reducer',
      nodeId: 'dimension-table',
      implementationId: DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
      inputs: inputs.map((source) => ({
        inputKind: source.inputKind,
        referenceId: source.referenceId,
      })),
      outputResultId: 'dimension-table',
      parameters: parameters(dimensions),
    } as AnalysisNodeExecutionContext['node'],
    inputs,
    analysisPlanDigest: ANALYSIS_PLAN_DIGEST,
    sampling: {
      experimentalUnit: 'sample',
      repeatedMeasures: false,
      resamplingUnit: 'sample',
      estimatorId: 'bootstrap.mean-percentile/v1',
      seedCoupling: 'independent-by-target',
    } as AnalysisNodeExecutionContext['sampling'],
    rootSeed: 'root-seed',
    samples: [] as unknown as AnalysisNodeExecutionContext['samples'],
    cohorts: [],
    signal,
  };
}

async function execute(
  executionContext: AnalysisNodeExecutionContext,
): Promise<AnalysisNodeExecutionResult> {
  const implementation = createDimensionAnalysisNodes().get(
    DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
  );
  if (implementation === undefined) throw new Error('missing dimension implementation');
  const run = await implementation.openRun({
    runId: 'run-a',
    analysisPlanDigest: ANALYSIS_PLAN_DIGEST,
    evaluationBundleDigest: EVALUATION_BUNDLE_DIGEST,
    analysisMode: 'preregistered',
  });
  try {
    return await run.execute(executionContext);
  } finally {
    await run.dispose();
  }
}

describe('dimension Analysis node', () => {
  it('declares a compiler-valid, fingerprint-bound Analysis-result reducer contract', () => {
    const capabilities = AnalysisNodeCapabilitiesSchema.parse(
      DIMENSION_ANALYSIS_IDENTITY.capabilities,
    );
    expect(capabilities.inputDomains).toEqual([{
      inputKind: 'analysis-result',
      schemaUris: [JUDGE_ENSEMBLE_TABLE_SCHEMA.schemaUri],
    }]);
    expect(capabilities.outputSchema).toEqual(DIMENSION_TABLE_SCHEMA);
    expect(capabilities.parameterSchema).toEqual(DIMENSION_PARAMETERS_SCHEMA);
    expect(Object.isFrozen(DIMENSION_ANALYSIS_IDENTITY)).toBe(true);
    expect(Object.isFrozen(DIMENSION_ANALYSIS_IDENTITY.capabilities)).toBe(true);
  });

  it('builds a canonical 5 + 3 → 4 table without direct Metric row membership', async () => {
    const forward = await execute(context());
    const reverse = await execute(context([
      input(actionability, { score: 3 }),
      input(security, { score: 5 }),
    ]));
    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({
      analysisStatus: 'completed',
      includedRowIds: [],
      comparableRowIds: [],
      assumptionChecks: [{ assumptionId: 'dimension-contract', checkStatus: 'passed' }],
      value: {
        groups: [{
          aggregate: { aggregateStatus: 'observed', mean: 4 },
          coverage: { plannedDimensions: 2, observedDimensions: 2, missingDimensions: 0 },
        }],
      },
    });
    if (forward.analysisStatus !== 'completed') return;
    const validator = createDimensionTableSchemaValidators().get(
      schemaIdentityKey(DIMENSION_TABLE_SCHEMA),
    );
    expect(() => validator?.parse({ resultType: 'table', value: forward.value })).not.toThrow();
  });

  it('excludes missing dimensions and preserves all-missing as missing', async () => {
    const partial = await execute(context([
      input(security, { missing: true }),
      input(actionability, { score: 3 }),
    ]));
    expect(partial).toMatchObject({
      value: { groups: [{ aggregate: { aggregateStatus: 'observed', mean: 3 } }] },
    });
    const missing = await execute(context([
      input(security, { missing: true }),
      input(actionability, { missing: true }),
    ]));
    expect(missing).toMatchObject({
      value: {
        groups: [{
          aggregate: { aggregateStatus: 'missing', reasonCode: 'dimension-unobserved' },
          coverage: { plannedDimensions: 2, observedDimensions: 0, missingDimensions: 2 },
        }],
      },
    });
  });

  it('treats absent upstream groups as structural non-applicability per unit', async () => {
    const result = await execute(context([
      input(security, { sampleId: 'sample-a', score: 5 }),
      input(actionability, {
        sampleId: 'sample-b',
        score: 3,
        samplingUnitIds: { pairingBlockId: digestCanonicalJson('pair-b') },
      }),
    ]));
    if (result.analysisStatus !== 'completed') throw new Error('expected completed result');
    const groups = (result.value as { groups: Array<{ coverage: unknown }> }).groups;
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.coverage)).toEqual([
      { plannedDimensions: 1, observedDimensions: 1, missingDimensions: 0 },
      { plannedDimensions: 1, observedDimensions: 1, missingDimensions: 0 },
    ]);
  });

  it('rejects incomplete input mappings, wrong schemas, and mismatched Metrics', async () => {
    await expect(execute(context([input(security)], [security, actionability]))).rejects.toThrow(
      'map every upstream Analysis result exactly once',
    );
    const wrongSchema = structuredClone(input(security));
    wrongSchema.record.outputSchema = DIMENSION_TABLE_SCHEMA;
    await expect(execute(context([wrongSchema], [security]))).rejects.toThrow(
      'sealed judge ensemble table inputs',
    );
    const wrongMetric = input({ ...security, metricId: 'rubric-security-v2' });
    await expect(execute(context([wrongMetric], [security]))).rejects.toThrow(
      'Upstream ensemble Metric disagrees with dimension parameters',
    );
  });

  it('rejects duplicate dimension groups and conflicting unit lineage', async () => {
    const duplicate = input(security);
    const duplicateValue = duplicate.record.value as { groups: unknown[] };
    duplicateValue.groups.push(sourceGroup(security, {
      suffix: 'duplicate',
      instrumentId: 'instrument-security-v2',
    }));
    await expect(execute(context([duplicate], [security]))).rejects.toThrow(
      'duplicate upstream dimension groups',
    );

    await expect(execute(context([
      input(security),
      input(actionability, {
        trialId: digestCanonicalJson('other-trial'),
      }),
    ]))).rejects.toThrow('disagree on sealed measurement-unit lineage');
  });

  it('cooperatively aborts before building source groups', async () => {
    const controller = new AbortController();
    controller.abort(new Error('dimension-cancelled'));
    await expect(execute(context(undefined, undefined, controller.signal))).rejects.toThrow(
      'dimension-cancelled',
    );
  });

  it('does not mutate source envelopes while aggregating', async () => {
    const inputs = [input(security, { score: 5 }), input(actionability, { score: 3 })];
    const before = canonicalizeJson(inputs);
    await execute(context(inputs));
    expect(canonicalizeJson(inputs)).toBe(before);
  });
});
