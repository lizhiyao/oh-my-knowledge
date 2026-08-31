import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOTSTRAP_SEED } from '../../../src/eval-core/bootstrap.js';
import type { DecisionPolicyContext } from '../../../src/evaluation-core/analysis/index.js';
import {
  canonicalizeJson,
  digestCanonicalJson,
  type JsonValue,
} from '../../../src/evaluation-core/contracts/index.js';
import { DecisionPolicyCapabilitiesSchema } from '../../../src/evaluation-core/compiler/index.js';
import {
  BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
  BOOTSTRAP_FAMILY_TABLE_SCHEMA,
  COMPOSITE_TABLE_SCHEMA,
  JUDGE_ENSEMBLE_TABLE_SCHEMA,
  JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
  RELEASE_DECISION_PARAMETERS_SCHEMA,
  RELEASE_DECISION_POLICY,
  RELEASE_DECISION_POLICY_IDENTITY,
  buildBootstrapFamilyTable,
  compareCompositeGroups,
  compositeAggregate,
  compositeCoverage,
  compositeGroupId,
  parseCompositeTableEnvelope,
  parseJudgeEnsembleTableEnvelope,
  parseReleaseDecisionParameters,
  type BootstrapFamilyParameters,
  type BootstrapObservation,
  type CompositeGroup,
  type CompositeLayerEntry,
  type ReleaseDecisionParameters,
} from '../../../src/eval-workflows/runtime-adapter/analysis/index.js';

const CONTROL = 'control';
const TREATMENT = 'treatment';

function parameters(input: Readonly<{
  sampleIds: string[];
  targetIds?: string[];
  holdout?: ReleaseDecisionParameters['holdout'];
}>): ReleaseDecisionParameters {
  return parseReleaseDecisionParameters({
    sources: {
      compositeResultId: 'composite-table',
      bootstrapFamilyResultId: 'bootstrap-family',
    },
    targetIds: input.targetIds ?? [CONTROL, TREATMENT],
    sampleIds: input.sampleIds,
    thresholds: {
      layerScore: 3.5,
      triviallySmallDifference: 0.1,
      minimumSampleCount: 20,
      judgeDissentPearson: 0.4,
      holdoutGap: 0.5,
    },
    ...(input.holdout === undefined ? {} : { holdout: input.holdout }),
  });
}

function group(
  targetId: string,
  sampleId: string,
  scores: Readonly<Partial<Record<'fact' | 'behavior' | 'judge', number>>>,
): CompositeGroup {
  const trialIndex = 0;
  const trialId = digestCanonicalJson({ targetId, sampleId, trialIndex });
  const layers: CompositeLayerEntry[] = (['fact', 'behavior', 'judge'] as const).flatMap((layerId) => {
    const score = scores[layerId];
    if (score === undefined) return [];
    const binding: CompositeLayerEntry['binding'] = layerId === 'judge'
      ? {
          layerId: 'judge',
          analysisResultId: 'ensemble-table',
          sourceKind: 'judge-ensemble',
          selector: 'consensus',
        }
      : layerId === 'fact'
        ? {
            layerId: 'fact',
            analysisResultId: 'assertion-layer',
            sourceKind: 'assertion-layer',
            selector: 'fact',
          }
        : {
            layerId: 'behavior',
            analysisResultId: 'assertion-layer',
            sourceKind: 'assertion-layer',
            selector: 'behavior',
          };
    return [{
      binding,
      sourceGroupId: digestCanonicalJson({ targetId, sampleId, layerId }),
      layerStatus: 'observed' as const,
      score,
    } satisfies CompositeLayerEntry];
  });
  if (layers.length === 0) {
    layers.push({
      binding: {
        layerId: 'judge',
        analysisResultId: 'ensemble-table',
        sourceKind: 'judge-ensemble',
        selector: 'consensus',
      },
      sourceGroupId: digestCanonicalJson({ targetId, sampleId, layerId: 'judge' }),
      layerStatus: 'missing',
      reasonCode: 'judge-ensemble-unobserved',
    });
  }
  const withoutId: Omit<CompositeGroup, 'groupId'> = {
    targetId,
    sampleId,
    trialIndex,
    trialId,
    samplingUnitIds: { pairingBlockId: digestCanonicalJson({ pair: sampleId }) },
    layers,
    coverage: compositeCoverage(layers),
    aggregate: compositeAggregate(layers),
  };
  return { groupId: compositeGroupId(withoutId), ...withoutId };
}

function tables(input: Readonly<{
  sampleIds: string[];
  targetScores: Readonly<Record<string, readonly (number | undefined)[]>>;
  layerScores?: Readonly<Record<string, Readonly<Partial<
    Record<'fact' | 'behavior' | 'judge', number>
  >>>>;
  comparisons?: BootstrapFamilyParameters['comparisons'];
}>) {
  const targetIds = Object.keys(input.targetScores);
  const groups = targetIds.flatMap((targetId) => input.sampleIds.map((sampleId, index) => {
    const score = input.targetScores[targetId]?.[index];
    return group(
      targetId,
      sampleId,
      input.layerScores?.[targetId] ?? (score === undefined ? {} : { judge: score }),
    );
  })).sort(compareCompositeGroups);
  const composite = parseCompositeTableEnvelope({
    resultType: 'table',
    value: { schemaVersion: 'omk.composite-table/v1', groups },
  }).value;
  const groupByCoordinate = new Map(groups.map((entry) => [
    canonicalizeJson([entry.targetId, entry.sampleId]),
    entry,
  ]));
  const observations: BootstrapObservation[] = targetIds.flatMap((targetId) => (
    input.sampleIds.map((sampleId) => {
      const source = groupByCoordinate.get(canonicalizeJson([targetId, sampleId]));
      if (source === undefined) {
        throw new Error('missing source fixture');
      }
      const lineage = {
        sourceGroupId: source.groupId,
        targetId,
        sampleId,
        trialIndex: source.trialIndex,
        trialId: source.trialId,
        samplingUnitIds: source.samplingUnitIds,
      };
      return source.aggregate.aggregateStatus === 'observed' ? {
        ...lineage,
        observationStatus: 'observed' as const,
        score: source.aggregate.score,
      } : {
        ...lineage,
        observationStatus: 'missing' as const,
        reasonCode: 'composite-unobserved' as const,
      };
    })
  ));
  const bootstrapParameters: BootstrapFamilyParameters = {
    source: {
      analysisResultId: 'composite-table',
      sourceKind: 'composite',
      selector: 'aggregate',
    },
    targetIds,
    sampleIds: input.sampleIds,
    comparisons: input.comparisons ?? (targetIds.length < 2 ? [] : [{
      comparisonId: 'control-vs-treatment',
      controlTargetId: CONTROL,
      treatmentTargetId: TREATMENT,
      comparisonDesign: 'paired',
    }]),
    resamples: 1_000,
    alpha: 0.05,
    seed: DEFAULT_BOOTSTRAP_SEED,
  };
  return {
    composite,
    bootstrap: buildBootstrapFamilyTable(bootstrapParameters, observations),
  };
}

function completedResult(resultId: string, schema: typeof COMPOSITE_TABLE_SCHEMA, value: JsonValue) {
  return {
    analysisStatus: 'completed',
    resultId,
    resultType: 'table',
    outputSchema: schema,
    value,
    assumptionChecks: [],
  } as unknown as DecisionPolicyContext['results'][number];
}

function dissentingEnsemble(composite: ReturnType<typeof tables>['composite']) {
  const groupKey = (group: CompositeGroup) => canonicalizeJson([
    group.targetId,
    group.sampleId,
    group.trialIndex,
    group.trialId,
    group.samplingUnitIds,
    'rubric-score',
    'rubric-correctness',
    'primary',
  ]);
  const groups = composite.groups.map((source, index) => {
    const sampleIndex = Number(source.sampleId.split('-').at(-1)) - 1;
    const alpha = [1, 2, 3, 4][sampleIndex];
    const beta = source.targetId === TREATMENT ? [4, 3, 2, 1][sampleIndex] : alpha;
    if (alpha === undefined || beta === undefined) throw new Error('invalid ensemble fixture');
    const coverage = {
      planned: 1,
      observed: 1,
      missing: 0,
      invalid: 0,
      evaluationFailed: 0,
      sourceUnavailable: 0,
      notStarted: 0,
      censored: 0,
    };
    const members = [
      { ensembleMemberId: 'alpha', mean: alpha },
      { ensembleMemberId: 'beta', mean: beta },
    ].map((member) => ({
      ...member,
      sourceGroupId: digestCanonicalJson({ source: index, member: member.ensembleMemberId }),
      sourceRowIds: [digestCanonicalJson({ row: index, member: member.ensembleMemberId })],
      coverage,
      memberStatus: 'observed' as const,
      sampleStddev: 0,
    }));
    const meanAbsDiff = Math.abs(alpha - beta);
    const withoutId = {
      targetId: source.targetId,
      sampleId: source.sampleId,
      trialIndex: source.trialIndex,
      trialId: source.trialId,
      samplingUnitIds: source.samplingUnitIds,
      metricId: 'rubric-score',
      instrumentId: 'rubric-correctness',
      replicateGroupId: 'primary',
      coverage: { plannedMembers: 2, observedMembers: 2, missingMembers: 0 },
      members,
      agreement: { agreementStatus: 'observed' as const, meanAbsDiff, pairCount: 1 },
      aggregateStatus: 'observed' as const,
      consensus: (alpha + beta) / 2,
    };
    return {
      groupId: digestCanonicalJson({
        derivation: JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
        key: JSON.parse(groupKey(source)) as JsonValue,
        sourceGroupIds: members.map((member) => member.sourceGroupId),
      }),
      ...withoutId,
    };
  });
  return parseJudgeEnsembleTableEnvelope({
    resultType: 'table',
    value: { schemaVersion: JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION, groups },
  }).value;
}

function context(
  releaseParameters: ReleaseDecisionParameters,
  values: ReturnType<typeof tables>,
): DecisionPolicyContext {
  const comparisons = values.bootstrap.configuration.comparisons;
  return {
    runId: 'release-run',
    policy: {
      decisionPolicyId: 'release-decision',
      implementationId: RELEASE_DECISION_POLICY.identity.implementationId,
      analysisResultIds: ['composite-table', 'bootstrap-family'],
      ...(comparisons.length === 0 ? {} : {
        comparisonFamily: comparisons.map((comparison) => ({
          comparisonId: comparison.comparisonId,
          treatmentTargetId: comparison.treatmentTargetId,
          metricId: 'composite-score',
          analysisResultId: 'bootstrap-family',
        })),
        comparisonFamilyResultId: 'bootstrap-family',
        ...(comparisons.length > 1 ? {
          multipleComparisonPolicyId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
        } : {}),
      }),
      minimumEvidenceStatus: 'complete',
      parameters: releaseParameters,
    },
    analysisBundleDigest: digestCanonicalJson('release-analysis'),
    analysisCoverage: {
      planned: 2, started: 2, completed: 2, inconclusive: 0, failed: 0, notStarted: 0,
    },
    results: [
      completedResult('composite-table', COMPOSITE_TABLE_SCHEMA, values.composite as JsonValue),
      completedResult(
        'bootstrap-family',
        BOOTSTRAP_FAMILY_TABLE_SCHEMA as typeof COMPOSITE_TABLE_SCHEMA,
        values.bootstrap as JsonValue,
      ),
    ],
    contrasts: comparisons.map((comparison) => ({
      analysisResultId: 'bootstrap-family',
      comparisonId: comparison.comparisonId,
      controlTargetId: comparison.controlTargetId,
      treatmentTargetId: comparison.treatmentTargetId,
      metricId: 'composite-score',
    })),
    evidenceStatus: 'complete',
    signal: new AbortController().signal,
  } as DecisionPolicyContext;
}

async function decide(
  releaseParameters: ReleaseDecisionParameters,
  values: ReturnType<typeof tables>,
) {
  return RELEASE_DECISION_POLICY.decide(context(releaseParameters, values));
}

describe('OMK Release DecisionPolicy', () => {
  it('declares the sealed table and comparison-family capabilities', () => {
    const capabilities = DecisionPolicyCapabilitiesSchema.parse(
      RELEASE_DECISION_POLICY_IDENTITY.capabilities,
    );
    expect(capabilities.analysisResultSchemaUris).toEqual([
      BOOTSTRAP_FAMILY_TABLE_SCHEMA.schemaUri,
      COMPOSITE_TABLE_SCHEMA.schemaUri,
      JUDGE_ENSEMBLE_TABLE_SCHEMA.schemaUri,
    ].sort());
    expect(capabilities.multipleComparisonPolicyIds).toEqual([
      BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
    ]);
    expect(capabilities.parameterSchema).toEqual(RELEASE_DECISION_PARAMETERS_SCHEMA);
    expect(Object.isFrozen(RELEASE_DECISION_POLICY_IDENTITY)).toBe(true);
  });

  it.each([
    {
      verdict: 'SOLO',
      count: 4,
      targetScores: { control: [4, 4, 4, 4] },
      reasons: ['single-target-no-comparison', 'solo-layer-gate-passed'],
    },
    {
      verdict: 'PROGRESS',
      count: 4,
      targetScores: { control: [3.5, 3.5, 3.5, 3.5], treatment: [4.5, 4.5, 4.5, 4.5] },
      reasons: ['comparison-significant-progress', 'release-gates-passed'],
    },
    {
      verdict: 'REGRESSION',
      count: 4,
      targetScores: { control: [4, 4, 4, 4], treatment: [3, 3, 3, 3] },
      reasons: ['comparison-significant-regression'],
    },
    {
      verdict: 'CAUTIOUS',
      count: 4,
      targetScores: { control: [4, 4, 4, 4], treatment: [4.05, 4.05, 4.05, 4.05] },
      reasons: ['comparison-effect-practically-trivial', 'comparison-significant-progress'],
    },
    {
      verdict: 'UNDERPOWERED',
      count: 4,
      targetScores: { control: [3, 4, 3, 4], treatment: [3, 4, 3, 4] },
      reasons: ['comparison-interval-overlaps-zero', 'comparison-sample-size-below-minimum'],
    },
    {
      verdict: 'NOISE',
      count: 20,
      targetScores: {
        control: Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? 3 : 4),
        treatment: Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? 3 : 4),
      },
      reasons: ['comparison-interval-overlaps-zero', 'comparison-sample-size-sufficient'],
    },
  ])('emits $verdict with exact golden reasons', async ({ verdict, count, targetScores, reasons }) => {
    const sampleIds = Array.from({ length: count }, (_, index) => `sample-${index + 1}`);
    const targetIds = Object.keys(targetScores);
    const releaseParameters = parameters({ sampleIds, targetIds });
    await expect(decide(releaseParameters, tables({
      sampleIds,
      targetScores: targetScores as Readonly<Record<string, readonly number[]>>,
    })))
      .resolves.toEqual({ decisionStatus: 'decided', verdict, reasonCodes: reasons });
  });

  it('rolls a corrected multi-treatment family up by sealed worst-case precedence', async () => {
    const sampleIds = ['sample-1', 'sample-2', 'sample-3', 'sample-4'];
    const targetIds = [CONTROL, TREATMENT, 'treatment-secondary'];
    const comparisons: BootstrapFamilyParameters['comparisons'] = [
      {
        comparisonId: 'control-vs-secondary',
        controlTargetId: CONTROL,
        treatmentTargetId: 'treatment-secondary',
        comparisonDesign: 'paired',
      },
      {
        comparisonId: 'control-vs-treatment',
        controlTargetId: CONTROL,
        treatmentTargetId: TREATMENT,
        comparisonDesign: 'paired',
      },
    ];
    const values = tables({
      sampleIds,
      targetScores: {
        control: [4, 4, 4, 4],
        treatment: [4, 4, 4, 4],
        'treatment-secondary': [4.05, 4.05, 4.05, 4.05],
      },
      comparisons,
    });

    await expect(decide(parameters({ sampleIds, targetIds }), values)).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'CAUTIOUS',
      reasonCodes: [
        'comparison-effect-practically-trivial',
        'comparison-significant-progress',
      ],
    });
  });

  it('gates a real gain on a treatment layer failure', async () => {
    const sampleIds = ['sample-1', 'sample-2', 'sample-3', 'sample-4'];
    const releaseParameters = parameters({ sampleIds });
    const values = tables({
      sampleIds,
      targetScores: {
        control: [4, 4, 4, 4],
        treatment: [4.33, 4.33, 4.33, 4.33],
      },
      layerScores: {
        control: { fact: 4, behavior: 4, judge: 4 },
        treatment: { fact: 5, behavior: 3, judge: 5 },
      },
    });
    await expect(decide(releaseParameters, values)).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'CAUTIOUS',
      reasonCodes: ['comparison-significant-progress', 'treatment-layer-gate-failed'],
    });
  });

  it('gates a real gain on a sealed holdout generalization gap', async () => {
    const sampleIds = Array.from({ length: 6 }, (_, index) => `sample-${index + 1}`);
    const releaseParameters = parameters({
      sampleIds,
      holdout: {
        trainSampleIds: sampleIds.slice(0, 3),
        holdoutSampleIds: sampleIds.slice(3),
        minimumScorablePerPartition: 3,
      },
    });
    const values = tables({
      sampleIds,
      targetScores: {
        control: [3, 3, 3, 3, 3, 3],
        treatment: [5, 5, 5, 4, 4, 4],
      },
    });
    await expect(decide(releaseParameters, values)).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'CAUTIOUS',
      reasonCodes: [
        'comparison-significant-progress',
        'holdout-generalization-gap',
      ],
    });
  });

  it('gates a real gain when either selected judge ensemble strongly dissents', async () => {
    const sampleIds = ['sample-1', 'sample-2', 'sample-3', 'sample-4'];
    const values = tables({
      sampleIds,
      targetScores: {
        control: [3, 3, 3, 3],
        treatment: [4, 4, 4, 4],
      },
    });
    const releaseParameters = parseReleaseDecisionParameters({
      ...parameters({ sampleIds }),
      sources: {
        compositeResultId: 'composite-table',
        bootstrapFamilyResultId: 'bootstrap-family',
        judgeEnsemble: {
          analysisResultId: 'ensemble-table',
          metricId: 'rubric-score',
          instrumentId: 'rubric-correctness',
          replicateGroupId: 'primary',
        },
      },
    });
    const baseContext = context(releaseParameters, values);
    const decisionContext: DecisionPolicyContext = {
      ...baseContext,
      policy: {
        ...baseContext.policy,
        analysisResultIds: [...baseContext.policy.analysisResultIds, 'ensemble-table'],
      },
      results: [
        ...baseContext.results,
        completedResult(
          'ensemble-table',
          JUDGE_ENSEMBLE_TABLE_SCHEMA as typeof COMPOSITE_TABLE_SCHEMA,
          dissentingEnsemble(values.composite) as JsonValue,
        ),
      ],
    };

    await expect(RELEASE_DECISION_POLICY.decide(decisionContext)).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'CAUTIOUS',
      reasonCodes: ['comparison-significant-progress', 'judge-ensemble-dissent'],
    });
  });

  it('fails closed on incomplete evidence, source drift, missing intervals, and cancellation', async () => {
    const sampleIds = ['sample-1', 'sample-2', 'sample-3', 'sample-4'];
    const releaseParameters = parameters({ sampleIds });
    const values = tables({
      sampleIds,
      targetScores: { control: [3, 3, 3, 3], treatment: [4, 4, 4, 4] },
    });
    await expect(RELEASE_DECISION_POLICY.decide({
      ...context(releaseParameters, values),
      evidenceStatus: 'partial',
    })).resolves.toEqual({
      decisionStatus: 'not-decided', reasonCodes: ['release-evidence-incomplete'],
    });
    const driftBase = context(releaseParameters, values);
    const drift: DecisionPolicyContext = {
      ...driftBase,
      policy: { ...driftBase.policy, analysisResultIds: ['composite-table'] },
    };
    await expect(RELEASE_DECISION_POLICY.decide(drift)).resolves.toEqual({
      decisionStatus: 'not-decided',
      reasonCodes: ['release-analysis-result-binding-mismatch'],
    });
    const familyDriftBase = context(releaseParameters, values);
    const familyDrift: DecisionPolicyContext = {
      ...familyDriftBase,
      policy: { ...familyDriftBase.policy, comparisonFamilyResultId: 'composite-table' },
    };
    await expect(RELEASE_DECISION_POLICY.decide(familyDrift)).resolves.toEqual({
      decisionStatus: 'not-decided',
      reasonCodes: ['release-analysis-source-lineage-mismatch'],
    });
    const missingInterval = tables({
      sampleIds,
      targetScores: {
        control: [4, 4, 4, 4],
        treatment: [undefined, undefined, undefined, undefined],
      },
    });
    await expect(decide(releaseParameters, missingInterval)).resolves.toEqual({
      decisionStatus: 'not-decided',
      reasonCodes: ['release-comparison-interval-unavailable'],
    });
    const controller = new AbortController();
    controller.abort();
    await expect(RELEASE_DECISION_POLICY.decide({
      ...context(releaseParameters, values), signal: controller.signal,
    })).resolves.toEqual({
      decisionStatus: 'not-decided', reasonCodes: ['decision-cancelled'],
    });
  });
});
