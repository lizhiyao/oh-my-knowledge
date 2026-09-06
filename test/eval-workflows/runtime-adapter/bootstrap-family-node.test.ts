import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOTSTRAP_SEED } from '../../../src/eval-workflows/analysis/bootstrap.js';
import {
  canonicalizeJson,
  digestCanonicalJson,
  type JsonValue,
  type SchemaIdentity,
} from '../../../src/eval-core/contracts/index.js';
import { AnalysisNodeCapabilitiesSchema } from '../../../src/eval-core/compiler/index.js';
import type {
  AnalysisNodeExecutionContext,
  AnalysisNodeInput,
} from '../../../src/eval-core/analysis/index.js';
import {
  BOOTSTRAP_FAMILY_ANALYSIS_IDENTITY,
  BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
  createBootstrapFamilyAnalysisNodes,
} from '../../../src/eval-workflows/measurement/analysis/bootstrap-family-node.js';
import {
  BOOTSTRAP_FAMILY_PARAMETERS_SCHEMA,
} from '../../../src/eval-workflows/measurement/analysis/bootstrap-family-parameters.js';
import {
  BOOTSTRAP_FAMILY_SOURCE_SCHEMAS,
} from '../../../src/eval-workflows/measurement/analysis/bootstrap-family-source-adapter.js';
import {
  BOOTSTRAP_FAMILY_TABLE_SCHEMA,
} from '../../../src/eval-workflows/measurement/analysis/bootstrap-family-table.js';
import {
  BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
} from '../../../src/eval-workflows/measurement/analysis/bootstrap-family-table-v2.js';
import {
  BOOTSTRAP_FAMILY_ANALYSIS_V2_IDENTITY,
  BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
  createBootstrapFamilyV2AnalysisNodes,
} from '../../../src/eval-workflows/measurement/analysis/bootstrap-family-node-v2.js';
import {
  COMPOSITE_TABLE_SCHEMA,
  COMPOSITE_TABLE_SCHEMA_VERSION,
  compositeAggregate,
  compositeCoverage,
  compositeGroupId,
  type CompositeGroup,
  type CompositeLayerEntry,
} from '../../../src/eval-workflows/measurement/analysis/composite-table.js';

const planDigest = digestCanonicalJson('bootstrap-plan');
const bundleDigest = digestCanonicalJson('bootstrap-bundle');
const pairId = digestCanonicalJson('bootstrap-pair');

function compositeValue(): JsonValue {
  const groups = ['control', 'treatment'].map((targetId): CompositeGroup => {
    const trialId = digestCanonicalJson({ targetId, sampleId: 'sample-1', trialIndex: 0 });
    const layers: CompositeLayerEntry[] = [{
      binding: {
        layerId: 'fact', analysisResultId: 'assertion-layer-table',
        sourceKind: 'assertion-layer', selector: 'fact',
      },
      sourceGroupId: digestCanonicalJson({ targetId, source: 'assertion' }),
      layerStatus: 'observed',
      score: targetId === 'control' ? 3 : 4,
    }];
    const withoutGroupId: Omit<CompositeGroup, 'groupId'> = {
      targetId,
      sampleId: 'sample-1',
      trialIndex: 0,
      trialId,
      samplingUnitIds: { pairingBlockId: pairId },
      layers,
      coverage: compositeCoverage(layers),
      aggregate: compositeAggregate(layers),
    };
    return { groupId: compositeGroupId(withoutGroupId), ...withoutGroupId };
  });
  return { schemaVersion: COMPOSITE_TABLE_SCHEMA_VERSION, groups };
}

function input(
  referenceId = 'composite-table',
  outputSchema: SchemaIdentity = COMPOSITE_TABLE_SCHEMA,
): Extract<AnalysisNodeInput, { inputKind: 'analysis-result' }> {
  return {
    inputKind: 'analysis-result',
    referenceId,
    record: {
      analysisStatus: 'completed',
      resultType: 'table',
      value: compositeValue(),
      outputSchema,
    } as Extract<AnalysisNodeInput, { inputKind: 'analysis-result' }>['record'],
  };
}

function parameters() {
  return {
    source: {
      analysisResultId: 'composite-table',
      sourceKind: 'composite' as const,
      selector: 'aggregate' as const,
    },
    targetIds: ['control', 'treatment'],
    sampleIds: ['sample-1'],
    comparisons: [{
      comparisonId: 'control-vs-treatment',
      controlTargetId: 'control',
      treatmentTargetId: 'treatment',
      comparisonDesign: 'paired' as const,
    }],
    resamples: 100,
    alpha: 0.05,
    seed: DEFAULT_BOOTSTRAP_SEED,
  };
}

function context(
  inputs: readonly AnalysisNodeInput[] = [input()],
  overrides: Partial<AnalysisNodeExecutionContext> = {},
): AnalysisNodeExecutionContext {
  return {
    node: {
      analysisNodeKind: 'estimator',
      nodeId: 'bootstrap-family-table',
      implementationId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
      inputs: [{ inputKind: 'analysis-result', referenceId: 'composite-table' }],
      outputResultId: 'bootstrap-family-table',
      parameters: parameters(),
    } as AnalysisNodeExecutionContext['node'],
    inputs,
    analysisPlanDigest: planDigest,
    sampling: {
      experimentalUnit: 'sample',
      repeatedMeasures: false,
      resamplingUnit: 'paired-block',
      estimatorId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
      seedCoupling: 'shared-within-block',
      pairingKey: '/input/pair',
    },
    rootSeed: 'ignored-by-fixed-bootstrap-v1',
    samples: [{ sampleId: 'sample-1' }] as AnalysisNodeExecutionContext['samples'],
    cohorts: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function execute(value: AnalysisNodeExecutionContext) {
  const implementation = createBootstrapFamilyAnalysisNodes().get(
    BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
  );
  if (implementation === undefined) throw new Error('missing Bootstrap implementation');
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

async function executeV2(): Promise<Awaited<ReturnType<typeof execute>>> {
  const implementation = createBootstrapFamilyV2AnalysisNodes().get(
    BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
  );
  if (implementation === undefined) throw new Error('missing Bootstrap v2 implementation');
  const run = await implementation.openRun({
    runId: 'run-v2', analysisPlanDigest: planDigest,
    evaluationBundleDigest: bundleDigest, analysisMode: 'preregistered',
  });
  try {
    const value = context();
    return await run.execute({
      ...value,
      node: {
        ...value.node,
        implementationId: BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
      },
      sampling: {
        ...value.sampling,
        estimatorId: BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
      },
    });
  } finally {
    await run.dispose();
  }
}

describe('Bootstrap family Analysis node', () => {
  it('declares canonical compiler capabilities and executes the Composite source contract', async () => {
    const capabilities = AnalysisNodeCapabilitiesSchema.parse(
      BOOTSTRAP_FAMILY_ANALYSIS_IDENTITY.capabilities,
    );
    expect(capabilities.inputDomains).toEqual([{
      inputKind: 'analysis-result',
      schemaUris: BOOTSTRAP_FAMILY_SOURCE_SCHEMAS.map((schema) => schema.schemaUri),
    }]);
    expect(capabilities.outputSchema).toEqual(BOOTSTRAP_FAMILY_TABLE_SCHEMA);
    expect(capabilities.parameterSchema).toEqual(BOOTSTRAP_FAMILY_PARAMETERS_SCHEMA);
    expect(capabilities.sampling?.resamplingUnits).toEqual(['paired-block', 'sample']);
    expect(Object.isFrozen(BOOTSTRAP_FAMILY_ANALYSIS_IDENTITY)).toBe(true);

    const result = await execute(context());
    expect(result).toMatchObject({
      analysisStatus: 'completed',
      resultType: 'table',
      includedRowIds: [],
      comparableRowIds: [],
      value: {
        targetIntervals: [{ interval: { estimate: 3 } }, { interval: { estimate: 4 } }],
        comparisons: [{ interval: { estimate: 1, samples: 100, significant: true } }],
      },
    });
  });

  it('rejects source, sampling, sample-order, and cancellation drift', async () => {
    await expect(execute(context([input('wrong-result')]))).rejects.toThrow(/sealed parameter/);
    await expect(execute(context([input('composite-table', BOOTSTRAP_FAMILY_TABLE_SCHEMA)])))
      .rejects.toThrow(/Composite table schema/);
    await expect(execute(context(undefined, {
      sampling: {
        ...context().sampling,
        resamplingUnit: 'sample',
      },
    }))).rejects.toThrow(/paired-block/);
    await expect(execute(context(undefined, {
      samples: [{ sampleId: 'wrong-sample' }] as AnalysisNodeExecutionContext['samples'],
    }))).rejects.toThrow(/sample order/);

    const controller = new AbortController();
    controller.abort(new Error('cancel-bootstrap'));
    await expect(execute(context(undefined, { signal: controller.signal })))
      .rejects.toThrow('cancel-bootstrap');
    expect(canonicalizeJson(BOOTSTRAP_FAMILY_SOURCE_SCHEMAS))
      .toBe(canonicalizeJson([COMPOSITE_TABLE_SCHEMA]));
  });

  it('registers v2 with explicit Monte Carlo evidence', async () => {
    const capabilities = AnalysisNodeCapabilitiesSchema.parse(
      BOOTSTRAP_FAMILY_ANALYSIS_V2_IDENTITY.capabilities,
    );
    expect(capabilities.outputSchema).toEqual(BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA);
    expect(Object.isFrozen(BOOTSTRAP_FAMILY_ANALYSIS_V2_IDENTITY)).toBe(true);
    expect(BOOTSTRAP_FAMILY_ANALYSIS_V2_IDENTITY.fingerprint).toBe(
      'sha256:d4f3e63bab6e71173686d2f5b94ca736a64d3d8ef52038d2108eb7c90de7664a',
    );
    await expect(executeV2()).resolves.toMatchObject({
      analysisStatus: 'completed',
      value: {
        comparisons: [{
          interval: { estimate: 1, samples: 100 },
          significance: {
            significanceStatus: 'significant',
            evidenceKind: 'exact-resampling-support',
            supportMethodId: 'omk.exact-resampling-support/v1',
          },
        }],
      },
    });
  });
});
