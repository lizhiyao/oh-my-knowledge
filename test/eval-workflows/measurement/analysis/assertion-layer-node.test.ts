import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  digestCanonicalJson,
  schemaIdentityKey,
  type JsonValue,
  type SamplingUnitIds,
} from '../../../../src/eval-core/contracts/index.js';
import { AnalysisNodeCapabilitiesSchema } from '../../../../src/eval-core/compiler/index.js';
import type {
  AnalysisMetricRow,
  AnalysisNodeExecutionContext,
  AnalysisNodeExecutionResult,
  AnalysisNodeInput,
} from '../../../../src/eval-core/analysis/index.js';
import {
  ASSERTION_LAYER_ANALYSIS_IDENTITY,
  ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
  createAssertionLayerAnalysisNodes,
} from '../../../../src/eval-workflows/measurement/analysis/assertion-layer-node.js';
import {
  ASSERTION_LAYER_PARAMETERS_SCHEMA,
  type AssertionLayerCriterionParameter,
} from '../../../../src/eval-workflows/measurement/analysis/assertion-layer-parameters.js';
import {
  ASSERTION_LAYER_TABLE_SCHEMA,
  createAssertionLayerTableSchemaValidators,
} from '../../../../src/eval-workflows/measurement/analysis/assertion-layer.js';

const ANALYSIS_PLAN_DIGEST = digestCanonicalJson({ fixture: 'assertion-plan' });
const EVALUATION_BUNDLE_DIGEST = digestCanonicalJson({ fixture: 'assertion-evaluation' });
const TRIAL_ID = digestCanonicalJson({ fixture: 'assertion-trial' });
const PAIRING_BLOCK_ID = digestCanonicalJson({ fixture: 'assertion-pair' });

interface Criterion extends AssertionLayerCriterionParameter {
  value?: boolean;
  rowStatus?: Exclude<AnalysisMetricRow['rowStatus'], 'observed'>;
  reasonCode?: string;
  censored?: boolean;
}

const criteria: Criterion[] = [{
  criterionId: 'contains-hello',
  metricId: 'assert-contains-hello',
  layerDisposition: 'fact',
  weight: 2,
  value: true,
}, {
  criterionId: 'contains-missing',
  metricId: 'assert-contains-missing',
  layerDisposition: 'fact',
  weight: 3,
  value: false,
}, {
  criterionId: 'fact-set',
  metricId: 'assert-fact-set',
  layerDisposition: 'fact',
  weight: 2,
  value: true,
}, {
  criterionId: 'max-length',
  metricId: 'assert-max-length',
  layerDisposition: 'behavior',
  weight: 1,
  value: true,
}, {
  criterionId: 'mixed-set',
  metricId: 'assert-mixed-set',
  layerDisposition: 'excluded-mixed-layer',
  weight: 4,
  value: true,
}];

function parameters(source: readonly Criterion[] = criteria): JsonValue {
  return {
    criteria: source.map((criterion) => ({
      criterionId: criterion.criterionId,
      metricId: criterion.metricId,
      layerDisposition: criterion.layerDisposition,
      weight: criterion.weight,
    })),
  };
}

function row(
  criterion: Criterion,
  samplingUnitIds: SamplingUnitIds = { pairingBlockId: PAIRING_BLOCK_ID },
): AnalysisMetricRow {
  const common = {
    rowId: digestCanonicalJson({ criterionId: criterion.criterionId }),
    targetId: 'target-a',
    sampleId: 'sample-a',
    trialIndex: 0,
    trialId: TRIAL_ID,
    evaluatorId: `evaluator-${criterion.criterionId}`,
    measurement: {
      instrumentId: criterion.criterionId,
      ensembleMemberId: 'deterministic',
      replicateGroupId: 'primary',
      replicateIndex: 0,
    },
    cohortIds: [],
    metricId: criterion.metricId,
    valueType: 'boolean' as const,
    samplingUnitIds,
    censored: criterion.censored ?? false,
  };
  return criterion.rowStatus === undefined
    ? { ...common, rowStatus: 'observed', value: criterion.value ?? false }
    : {
        ...common,
        rowStatus: criterion.rowStatus,
        reasonCode: criterion.reasonCode ?? 'assertion-evaluation-failed',
      };
}

function metricInput(criterion: Criterion): Extract<
  AnalysisNodeInput,
  { inputKind: 'metric-observations' }
> {
  return {
    inputKind: 'metric-observations',
    referenceId: criterion.metricId,
    metric: {
      metricId: criterion.metricId,
      valueType: 'boolean',
      scope: 'sample',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    },
    rows: [row(criterion)],
  } as Extract<AnalysisNodeInput, { inputKind: 'metric-observations' }>;
}

function context(
  source: readonly Criterion[] = criteria,
  signal: AbortSignal = new AbortController().signal,
): AnalysisNodeExecutionContext {
  const inputs = source.map(metricInput);
  return {
    node: {
      analysisNodeKind: 'reducer',
      nodeId: 'assertion-layer-table',
      implementationId: ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
      inputs: inputs.map((input) => ({
        inputKind: input.inputKind,
        referenceId: input.referenceId,
      })),
      outputResultId: 'assertion-layer-table',
      parameters: parameters(source),
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
  const implementation = createAssertionLayerAnalysisNodes().get(
    ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
  );
  if (implementation === undefined) throw new Error('missing assertion-layer implementation');
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

function completedValue(result: AnalysisNodeExecutionResult): JsonValue {
  if (result.analysisStatus !== 'completed') throw new Error('expected completed result');
  return result.value;
}

describe('assertion-layer Analysis node', () => {
  it('declares a compiler-valid, fingerprint-bound Boolean reducer contract', () => {
    const capabilities = AnalysisNodeCapabilitiesSchema.parse(
      ASSERTION_LAYER_ANALYSIS_IDENTITY.capabilities,
    );
    expect(capabilities.inputDomains).toEqual([{
      inputKind: 'metric-observations',
      valueTypes: ['boolean'],
      missingPolicyIds: ['exclude/v1'],
    }]);
    expect(capabilities.outputSchema).toEqual(ASSERTION_LAYER_TABLE_SCHEMA);
    expect(capabilities.parameterSchema).toEqual(ASSERTION_LAYER_PARAMETERS_SCHEMA);
    expect(Object.isFrozen(ASSERTION_LAYER_ANALYSIS_IDENTITY)).toBe(true);
    expect(Object.isFrozen(ASSERTION_LAYER_ANALYSIS_IDENTITY.capabilities)).toBe(true);
  });

  it('builds canonical layer evidence and excludes mixed-layer rows from included lineage', async () => {
    const forward = await execute(context());
    expect(forward).toMatchObject({
      analysisStatus: 'completed',
      includedRowIds: expect.any(Array),
      assumptionChecks: [{
        assumptionId: 'assertion-layer-contract',
        checkStatus: 'passed',
      }],
    });
    if (forward.analysisStatus !== 'completed') return;
    expect(forward.includedRowIds).toHaveLength(4);
    expect(forward.comparableRowIds).toEqual(forward.includedRowIds);
    expect(forward.value).toMatchObject({
      groups: [{
        samplingUnitIds: { pairingBlockId: PAIRING_BLOCK_ID },
        layers: {
          fact: expect.objectContaining({ layerStatus: 'observed', score: 3.29 }),
          behavior: expect.objectContaining({ layerStatus: 'observed', score: 5 }),
        },
        excludedMixedLayer: { coverage: expect.objectContaining({ declaredWeight: 4 }) },
      }],
    });
    const validator = createAssertionLayerTableSchemaValidators().get(
      schemaIdentityKey(ASSERTION_LAYER_TABLE_SCHEMA),
    );
    expect(() => validator?.parse({ resultType: 'table', value: forward.value })).not.toThrow();

    const reverse = await execute(context([...criteria].reverse()));
    expect(canonicalizeJson(completedValue(reverse))).toBe(canonicalizeJson(forward.value));
  });

  it('keeps structural non-applicability distinct from applicable failures', async () => {
    const source: Criterion[] = [{
      ...criteria[0],
      value: undefined,
      rowStatus: 'missing',
      reasonCode: 'criterion-not-applicable',
    }, {
      ...criteria[1],
      value: undefined,
      rowStatus: 'evaluation-failed',
      reasonCode: 'provider-failed',
    }];
    const result = await execute(context(source));
    expect(completedValue(result)).toMatchObject({
      groups: [{
        layers: {
          fact: {
            layerStatus: 'missing',
            reasonCode: 'assertion-layer-unobserved',
            coverage: expect.objectContaining({
              notApplicableCriteria: 1,
              applicableCriteria: 1,
              evaluationFailedCriteria: 1,
              observedWeight: 0,
            }),
          },
          behavior: expect.objectContaining({ layerStatus: 'missing' }),
        },
      }],
    });
    expect(result.includedRowIds).toEqual([]);
    expect(result.notApplicableRowIds).toHaveLength(1);
  });

  it.each([{
    name: 'all-pass fact-only',
    source: [
      { ...criteria[0], weight: 1, value: true },
      { ...criteria[2], weight: 4, value: true },
    ],
    layer: 'fact' as const,
    expected: {
      layerStatus: 'observed',
      score: 5,
      coverage: { observedCriteria: 2, observedWeight: 5, passedWeight: 5 },
    },
    included: 2,
  }, {
    name: 'all-fail behavior-only',
    source: [
      { ...criteria[3], criterionId: 'behavior-a', metricId: 'behavior-a', weight: 1, value: false },
      { ...criteria[3], criterionId: 'behavior-b', metricId: 'behavior-b', weight: 3, value: false },
    ],
    layer: 'behavior' as const,
    expected: {
      layerStatus: 'observed',
      score: 1,
      coverage: { observedCriteria: 2, observedWeight: 4, passedWeight: 0 },
    },
    included: 2,
  }, {
    name: 'missing fact-only',
    source: [{
      ...criteria[0],
      value: undefined,
      rowStatus: 'missing' as const,
      reasonCode: 'assertion-input-missing',
    }],
    layer: 'fact' as const,
    expected: {
      layerStatus: 'missing',
      reasonCode: 'assertion-layer-unobserved',
      coverage: { missingCriteria: 1, missingWeight: 2, observedWeight: 0 },
    },
    included: 0,
  }, {
    name: 'invalid behavior-only',
    source: [{
      ...criteria[3],
      value: undefined,
      rowStatus: 'invalid' as const,
      reasonCode: 'assertion-reading-invalid',
    }],
    layer: 'behavior' as const,
    expected: {
      layerStatus: 'missing',
      reasonCode: 'assertion-layer-unobserved',
      coverage: { invalidCriteria: 1, invalidWeight: 1, observedWeight: 0 },
    },
    included: 0,
  }, {
    name: 'budget-censored observed fact',
    source: [{ ...criteria[0], value: true, censored: true }],
    layer: 'fact' as const,
    expected: {
      layerStatus: 'observed',
      score: 5,
      coverage: { censoredCriteria: 1, censoredWeight: 2, observedWeight: 2 },
    },
    included: 1,
  }])('covers the $name golden', async ({ source, layer, expected, included }) => {
    const result = await execute(context(source));
    const value = completedValue(result) as {
      groups: Array<{ layers: Record<'fact' | 'behavior', JsonValue> }>;
    };
    expect(value.groups[0].layers[layer]).toMatchObject(expected);
    const otherLayer = layer === 'fact' ? 'behavior' : 'fact';
    expect(value.groups[0].layers[otherLayer]).toMatchObject({ layerStatus: 'missing' });
    expect(result.includedRowIds).toHaveLength(included);
  });

  it('fails closed on mapping ambiguity, incomplete units, and sampling disagreement', async () => {
    const mismatchBase = context();
    const mismatch = {
      ...mismatchBase,
      node: {
        ...mismatchBase.node,
        parameters: parameters(criteria.slice(1)),
      },
    };
    await expect(execute(mismatch)).rejects.toThrow('map every input Metric exactly once');

    const incomplete = context();
    incomplete.inputs = incomplete.inputs.slice(1);
    await expect(execute(incomplete)).rejects.toThrow('map every input Metric exactly once');

    const disagreement = context();
    const second = disagreement.inputs[1] as Extract<
      AnalysisNodeInput,
      { inputKind: 'metric-observations' }
    >;
    disagreement.inputs = [
      disagreement.inputs[0],
      { ...second, rows: [row(criteria[1], {})] },
      ...disagreement.inputs.slice(2),
    ];
    await expect(execute(disagreement)).rejects.toThrow('sampling-unit lineage');

    const wrongDomain = context();
    const first = wrongDomain.inputs[0] as Extract<
      AnalysisNodeInput,
      { inputKind: 'metric-observations' }
    >;
    wrongDomain.inputs = [{
      ...first,
      metric: { ...first.metric, direction: 'lower-is-better' },
    }, ...wrongDomain.inputs.slice(1)];
    await expect(execute(wrongDomain)).rejects.toThrow('higher-is-better');

    const wrongReading = context();
    const readingInput = wrongReading.inputs[0] as Extract<
      AnalysisNodeInput,
      { inputKind: 'metric-observations' }
    >;
    const reading = readingInput.rows[0];
    wrongReading.inputs = [{
      ...readingInput,
      rows: [{ ...reading, rowStatus: 'observed', value: 'true' }],
    }, ...wrongReading.inputs.slice(1)];
    await expect(execute(wrongReading)).rejects.toThrow('must be Boolean');
  });

  it('returns inconclusive for no rows and honors cancellation before parameter parsing', async () => {
    const empty = context();
    empty.inputs = empty.inputs.map((input) => ({
      ...input,
      rows: [],
    })) as AnalysisNodeExecutionContext['inputs'];
    await expect(execute(empty)).resolves.toMatchObject({
      analysisStatus: 'inconclusive',
      reasonCodes: ['assertion-layer-no-planned-rows'],
    });

    const emptyMismatch = {
      ...empty,
      node: { ...empty.node, parameters: parameters(criteria.slice(1)) },
    };
    await expect(execute(emptyMismatch)).rejects.toThrow('map every input Metric exactly once');

    const cancelledBase = context();
    const controller = new AbortController();
    controller.abort(new Error('cancelled-fixture'));
    const cancelled = {
      ...cancelledBase,
      node: { ...cancelledBase.node, parameters: { invalid: true } },
      signal: controller.signal,
    };
    await expect(execute(cancelled)).rejects.toThrow('cancelled-fixture');
  });
});
