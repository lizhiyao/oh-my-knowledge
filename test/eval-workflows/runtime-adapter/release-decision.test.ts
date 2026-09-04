import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOTSTRAP_SEED } from '../../../src/eval-workflows/analysis/bootstrap.js';
import {
  PAIRED_NORMAL_POWER_METHOD_ID,
  requiredPairedComparisonUnits,
} from '../../../src/eval-workflows/analysis/sample-size.js';
import type { DecisionPolicyContext } from '../../../src/eval-core/analysis/index.js';
import {
  canonicalizeJson,
  digestCanonicalJson,
  type JsonValue,
} from '../../../src/eval-core/contracts/index.js';
import { DecisionPolicyCapabilitiesSchema } from '../../../src/eval-core/compiler/index.js';
import {
  BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
  BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
  BOOTSTRAP_FAMILY_TABLE_SCHEMA,
  BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
  COMPOSITE_TABLE_SCHEMA,
  JUDGE_ENSEMBLE_TABLE_SCHEMA,
  JUDGE_ENSEMBLE_TABLE_SCHEMA_VERSION,
  RELEASE_DECISION_PARAMETERS_SCHEMA,
  RELEASE_DECISION_POLICY,
  RELEASE_DECISION_POLICY_IDENTITY,
  RELEASE_DECISION_POLICY_V1,
  RELEASE_DECISION_POLICY_V1_IDENTITY,
  RELEASE_DECISION_POLICY_V1_IMPLEMENTATION_ID,
  RELEASE_DECISION_POLICY_V2,
  RELEASE_DECISION_POLICY_V2_IDENTITY,
  RELEASE_DECISION_POLICY_V2_IMPLEMENTATION_ID,
  RELEASE_DECISION_POLICY_V3_IDENTITY,
  RELEASE_DECISION_POLICY_V3_IMPLEMENTATION_ID,
  RELEASE_DECISION_POLICY_V5,
  RELEASE_DECISION_POLICY_V5_IDENTITY,
  RELEASE_DECISION_POLICY_V5_IMPLEMENTATION_ID,
  RELEASE_DECISION_POLICY_V6,
  RELEASE_DECISION_POLICY_V6_IDENTITY,
  RELEASE_DECISION_POLICY_V6_IMPLEMENTATION_ID,
  buildBootstrapFamilyTable,
  buildBootstrapFamilyTableV2,
  compareCompositeGroups,
  compositeAggregate,
  compositeCoverage,
  compositeGroupId,
  createReleaseDecisionPolicies,
  parseCompositeTableEnvelope,
  parseJudgeEnsembleTableEnvelope,
  parseReleaseDecisionParameters,
  parseReleaseDecisionParametersV1,
  type BootstrapFamilyParameters,
  type BootstrapObservation,
  type CompositeGroup,
  type CompositeLayerEntry,
  type ReleaseDecisionParameters,
  type ReleaseDecisionParametersV1,
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
      judgeDissentPearson: 0.4,
      holdoutGap: 0.5,
    },
    sampleSizeRequirement: {
      sampleSizePlanningKind: 'minimum-count',
      minimumComparisonUnits: 20,
    },
    ...(input.holdout === undefined ? {} : { holdout: input.holdout }),
  });
}

function legacyParameters(
  current: ReleaseDecisionParameters,
): ReleaseDecisionParametersV1 {
  return parseReleaseDecisionParametersV1({
    sources: current.sources,
    targetIds: current.targetIds,
    sampleIds: current.sampleIds,
    thresholds: {
      ...current.thresholds,
      minimumSampleCount: current.sampleSizeRequirement.minimumComparisonUnits,
    },
    ...(current.holdout === undefined ? {} : { holdout: current.holdout }),
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
    bootstrapV2: buildBootstrapFamilyTableV2(bootstrapParameters, observations),
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

function judgeEnsemble(
  composite: ReturnType<typeof tables>['composite'],
  mode: 'aligned' | 'dissenting' | 'single',
) {
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
    const beta = mode === 'dissenting' && source.targetId === TREATMENT
      ? [4, 3, 2, 1][sampleIndex]
      : alpha;
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
    const memberScores = [
      { ensembleMemberId: 'alpha', mean: alpha },
      { ensembleMemberId: 'beta', mean: beta },
    ];
    const members = (mode === 'single' ? memberScores.slice(0, 1) : memberScores).map((member) => ({
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
      coverage: {
        plannedMembers: members.length,
        observedMembers: members.length,
        missingMembers: 0,
      },
      members,
      agreement: mode === 'single'
        ? {
            agreementStatus: 'missing' as const,
            reasonCode: 'judge-agreement-insufficient-members' as const,
            pairCount: 0 as const,
          }
        : { agreementStatus: 'observed' as const, meanAbsDiff, pairCount: 1 },
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
  releaseParameters: ReleaseDecisionParameters | ReleaseDecisionParametersV1,
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

function contextV5(
  releaseParameters: ReleaseDecisionParameters,
  values: ReturnType<typeof tables>,
): DecisionPolicyContext {
  const legacy = context(releaseParameters, values);
  const comparisons = values.bootstrapV2.configuration.comparisons;
  return {
    ...legacy,
    policy: {
      ...legacy.policy,
      implementationId: RELEASE_DECISION_POLICY_V5_IMPLEMENTATION_ID,
      ...(comparisons.length > 1 ? {
        multipleComparisonPolicyId: BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
      } : {}),
    },
    results: [
      legacy.results[0],
      completedResult(
        'bootstrap-family',
        BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA as typeof COMPOSITE_TABLE_SCHEMA,
        values.bootstrapV2 as JsonValue,
      ),
    ],
  } as DecisionPolicyContext;
}

function contextV6(
  releaseParameters: ReleaseDecisionParameters,
  values: ReturnType<typeof tables>,
): DecisionPolicyContext {
  const current = contextV5(releaseParameters, values);
  return {
    ...current,
    policy: {
      ...current.policy,
      implementationId: RELEASE_DECISION_POLICY_V6_IMPLEMENTATION_ID,
    },
  };
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
    expect(RELEASE_DECISION_POLICY_V1_IDENTITY.fingerprint).toBe(
      'sha256:0c13bef0733f511a6b17ffd3e9e3274231f36262a0e2aa23668b17aaf484bc5c',
    );
    expect(RELEASE_DECISION_POLICY_V2_IDENTITY.fingerprint).toBe(
      'sha256:e905b666e7b0ec35fbb0a4c005ceb19eaf072fd807d97bb359e58f7910af5cc9',
    );
    expect(RELEASE_DECISION_POLICY_V3_IDENTITY.fingerprint).toBe(
      'sha256:fec0a532957eb6ce17cd5866ec7851a0bca0e9cc70e70748c60049d1766839a9',
    );
    expect(RELEASE_DECISION_POLICY_IDENTITY.fingerprint).toBe(
      'sha256:310b31c9cd1c3a689c5c760f35a6b5ab869b6959bc70047c0fb4362024f821ee',
    );
    expect([...createReleaseDecisionPolicies().keys()]).toEqual([
      RELEASE_DECISION_POLICY_V1_IMPLEMENTATION_ID,
      RELEASE_DECISION_POLICY_V2_IMPLEMENTATION_ID,
      RELEASE_DECISION_POLICY_V3_IMPLEMENTATION_ID,
      RELEASE_DECISION_POLICY.identity.implementationId,
      RELEASE_DECISION_POLICY_V5_IMPLEMENTATION_ID,
      RELEASE_DECISION_POLICY_V6_IMPLEMENTATION_ID,
    ]);
  });

  it('v5 consumes v2 tail evidence and declares its implementation identity', async () => {
    const capabilities = DecisionPolicyCapabilitiesSchema.parse(
      RELEASE_DECISION_POLICY_V5_IDENTITY.capabilities,
    );
    expect(capabilities.analysisResultSchemaUris).toContain(
      BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA.schemaUri,
    );
    expect(capabilities.analysisResultSchemaUris).not.toContain(
      BOOTSTRAP_FAMILY_TABLE_SCHEMA.schemaUri,
    );
    expect(capabilities.multipleComparisonPolicyIds).toEqual([
      BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
    ]);
    expect(RELEASE_DECISION_POLICY_V5_IDENTITY.fingerprint).toBe(
      'sha256:2ef98d77984528a583cce8eeb4e4bc108865d29e270d42f87ac9de731dad8e86',
    );

    const sampleIds = Array.from({ length: 4 }, (_, index) => `sample-${index + 1}`);
    const values = tables({
      sampleIds,
      targetScores: {
        control: [4, 4, 4, 4],
        treatment: [5, 5, 5, 5],
      },
    });
    await expect(RELEASE_DECISION_POLICY_V5.decide(
      contextV5(parameters({ sampleIds }), values),
    )).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
      reasonCodes: ['comparison-significant-progress', 'release-gates-passed'],
    });
  });

  it('v5 fails closed when finite resampling cannot resolve the significance boundary', async () => {
    const sampleIds = Array.from({ length: 20 }, (_, index) => `sample-${index + 1}`);
    const values = tables({
      sampleIds,
      targetScores: {
        control: Array.from({ length: 20 }, () => 3),
        treatment: Array.from({ length: 20 }, (_, index) => index < 5 ? 2 : 4),
      },
    });
    const comparison = values.bootstrapV2.comparisons[0];
    expect(comparison?.comparisonStatus).toBe('observed');
    if (comparison?.comparisonStatus !== 'observed') return;
    expect(comparison.significance).toMatchObject({
      significanceStatus: 'indeterminate',
      tailCount: 17,
    });
    await expect(RELEASE_DECISION_POLICY_V5.decide(
      contextV5(parameters({ sampleIds }), values),
    )).resolves.toEqual({
      decisionStatus: 'not-decided',
      reasonCodes: ['release-bootstrap-monte-carlo-indeterminate'],
    });
  });

  it('v5 distinguishes a resolved nonsignificant result from interval display wording', async () => {
    const sampleIds = Array.from({ length: 20 }, (_, index) => `sample-${index + 1}`);
    const values = tables({
      sampleIds,
      targetScores: {
        control: Array.from({ length: 20 }, () => 4),
        treatment: Array.from({ length: 20 }, () => 4),
      },
    });
    await expect(RELEASE_DECISION_POLICY_V5.decide(
      contextV5(parameters({ sampleIds }), values),
    )).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'NOISE',
      reasonCodes: [
        'comparison-not-significant',
        'comparison-sample-size-sufficient',
      ],
    });
  });

  it('v6 requires the confidence-interval lower bound to meet the practical-effect threshold', async () => {
    const sampleIds = Array.from({ length: 4 }, (_, index) => `sample-${index + 1}`);
    const values = tables({
      sampleIds,
      targetScores: {
        control: [4, 4, 4, 4],
        treatment: [4.01, 4.01, 4.01, 4.77],
      },
    });
    const comparison = values.bootstrapV2.comparisons[0];
    expect(comparison).toMatchObject({
      comparisonStatus: 'observed',
      interval: { estimate: 0.2, lower: 0.01 },
      significance: { significanceStatus: 'significant', direction: 'positive' },
    });
    await expect(RELEASE_DECISION_POLICY_V5.decide(
      contextV5(parameters({ sampleIds }), values),
    )).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
      reasonCodes: ['comparison-significant-progress', 'release-gates-passed'],
    });
    await expect(RELEASE_DECISION_POLICY_V6.decide(
      contextV6(parameters({ sampleIds }), values),
    )).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'CAUTIOUS',
      reasonCodes: [
        'comparison-effect-practically-trivial',
        'comparison-significant-progress',
      ],
    });
  });

  it('v6 declares the lower-bound practical-effect contract in its identity', () => {
    expect(RELEASE_DECISION_POLICY_V6_IDENTITY.implementationId).toBe(
      RELEASE_DECISION_POLICY_V6_IMPLEMENTATION_ID,
    );
    expect(RELEASE_DECISION_POLICY_V6_IDENTITY.fingerprint).toBe(
      'sha256:3214ed21b603d3faa6b175cddf7fe701e0ca9c25055f4d7154d053ecacd1283a',
    );
  });

  it('v6 treats a practical-effect lower bound equal to the threshold as sufficient', async () => {
    const sampleIds = Array.from({ length: 4 }, (_, index) => `sample-${index + 1}`);
    const values = tables({
      sampleIds,
      targetScores: {
        control: [4, 4, 4, 4],
        treatment: [4.1, 4.1, 4.1, 4.1],
      },
    });
    await expect(RELEASE_DECISION_POLICY_V6.decide(
      contextV6(parameters({ sampleIds }), values),
    )).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
      reasonCodes: ['comparison-significant-progress', 'release-gates-passed'],
    });
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

  it('uses complete paired units instead of authored samples for the sample-size guard', async () => {
    const sampleIds = Array.from({ length: 20 }, (_, index) => `sample-${index + 1}`);
    const observed = [3, 4, 3, 4];
    const missing = Array.from({ length: 16 }, () => undefined);
    const values = tables({
      sampleIds,
      targetScores: {
        control: [...observed, ...missing],
        treatment: [...observed, ...missing],
      },
    });
    const releaseParameters = parameters({ sampleIds });

    await expect(decide(releaseParameters, values)).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'UNDERPOWERED',
      reasonCodes: [
        'comparison-interval-overlaps-zero',
        'comparison-sample-size-below-minimum',
      ],
    });
    const v2Context = context(legacyParameters(releaseParameters), values);
    await expect(RELEASE_DECISION_POLICY_V2.decide({
      ...v2Context,
      policy: {
        ...v2Context.policy,
        implementationId: RELEASE_DECISION_POLICY_V2_IMPLEMENTATION_ID,
      },
    })).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'NOISE',
      reasonCodes: [
        'comparison-interval-overlaps-zero',
        'comparison-sample-size-sufficient',
      ],
    });
  });

  it('uses the smaller observed arm for an independent comparison sample-size guard', async () => {
    const sampleIds = Array.from({ length: 20 }, (_, index) => `sample-${index + 1}`);
    const values = tables({
      sampleIds,
      targetScores: {
        control: Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? 3 : 4),
        treatment: [3, 4, 3, 4, ...Array.from({ length: 16 }, () => undefined)],
      },
      comparisons: [{
        comparisonId: 'control-vs-treatment',
        controlTargetId: CONTROL,
        treatmentTargetId: TREATMENT,
        comparisonDesign: 'independent',
      }],
    });

    await expect(decide(parameters({ sampleIds }), values)).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'UNDERPOWERED',
      reasonCodes: [
        'comparison-interval-overlaps-zero',
        'comparison-sample-size-below-minimum',
      ],
    });
  });

  it('gates against the recomputable a priori plan without using observed variance', async () => {
    const sampleIds = Array.from({ length: 20 }, (_, index) => `sample-${index + 1}`);
    const assumptions = {
      minimumDetectableDifference: 0.5,
      expectedDifferenceStandardDeviation: 1,
      targetPower: 0.8,
      familywiseAlpha: 0.05,
      plannedComparisonCount: 1,
    } as const;
    const releaseParameters = parseReleaseDecisionParameters({
      ...parameters({ sampleIds }),
      sampleSizeRequirement: {
        sampleSizePlanningKind: 'a-priori-power',
        methodId: PAIRED_NORMAL_POWER_METHOD_ID,
        ...assumptions,
        minimumComparisonUnits: requiredPairedComparisonUnits(assumptions),
        assumptionSource: 'pilot-2026-q3',
      },
    });
    const values = tables({
      sampleIds,
      targetScores: {
        control: Array.from({ length: 20 }, () => 4),
        treatment: Array.from({ length: 20 }, () => 4),
      },
    });

    await expect(decide(releaseParameters, values)).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'UNDERPOWERED',
      reasonCodes: [
        'comparison-interval-overlaps-zero',
        'comparison-sample-size-below-minimum',
      ],
    });
    expect(() => parseReleaseDecisionParameters({
      ...releaseParameters,
      sampleSizeRequirement: {
        ...releaseParameters.sampleSizeRequirement,
        minimumComparisonUnits: 20,
      },
    })).toThrow(/not recomputable/);
    expect(() => parseReleaseDecisionParameters({
      ...releaseParameters,
      sampleSizeRequirement: {
        ...releaseParameters.sampleSizeRequirement,
        plannedComparisonCount: Number.MAX_SAFE_INTEGER,
        minimumComparisonUnits: 2,
      },
    })).toThrow(/cannot be represented safely/);
  });

  it('fails closed when an a priori plan does not match the sealed comparison design', async () => {
    const sampleIds = Array.from({ length: 20 }, (_, index) => `sample-${index + 1}`);
    const assumptions = {
      minimumDetectableDifference: 0.5,
      expectedDifferenceStandardDeviation: 1,
      targetPower: 0.8,
      familywiseAlpha: 0.05,
      plannedComparisonCount: 2,
    } as const;
    const releaseParameters = parseReleaseDecisionParameters({
      ...parameters({ sampleIds }),
      sampleSizeRequirement: {
        sampleSizePlanningKind: 'a-priori-power',
        methodId: PAIRED_NORMAL_POWER_METHOD_ID,
        ...assumptions,
        minimumComparisonUnits: requiredPairedComparisonUnits(assumptions),
        assumptionSource: 'pilot-2026-q3',
      },
    });
    const values = tables({
      sampleIds,
      targetScores: {
        control: Array.from({ length: 20 }, () => 4),
        treatment: Array.from({ length: 20 }, () => 4),
      },
    });

    await expect(decide(releaseParameters, values)).resolves.toEqual({
      decisionStatus: 'not-decided',
      reasonCodes: ['release-analysis-source-lineage-mismatch'],
    });

    const alphaAssumptions = {
      ...assumptions,
      familywiseAlpha: 0.1,
      plannedComparisonCount: 1,
    };
    const alphaMismatch = parseReleaseDecisionParameters({
      ...parameters({ sampleIds }),
      sampleSizeRequirement: {
        sampleSizePlanningKind: 'a-priori-power',
        methodId: PAIRED_NORMAL_POWER_METHOD_ID,
        ...alphaAssumptions,
        minimumComparisonUnits: requiredPairedComparisonUnits(alphaAssumptions),
        assumptionSource: 'pilot-2026-q3',
      },
    });
    await expect(decide(alphaMismatch, values)).resolves.toEqual({
      decisionStatus: 'not-decided',
      reasonCodes: ['release-analysis-source-lineage-mismatch'],
    });
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
          judgeEnsemble(values.composite, 'dissenting') as JsonValue,
        ),
      ],
    };

    await expect(RELEASE_DECISION_POLICY.decide(decisionContext)).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'CAUTIOUS',
      reasonCodes: ['comparison-significant-progress', 'judge-ensemble-dissent'],
    });
  });

  it('gates a positive comparison when configured judge uncertainty is unmeasured', async () => {
    const sampleIds = ['sample-1', 'sample-2', 'sample-3', 'sample-4'];
    const values = tables({
      sampleIds,
      targetScores: { control: [4, 4, 4, 4], treatment: [5, 5, 5, 5] },
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
          judgeEnsemble(values.composite, 'single') as JsonValue,
        ),
      ],
    };

    await expect(RELEASE_DECISION_POLICY.decide(decisionContext)).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'CAUTIOUS',
      reasonCodes: ['comparison-significant-progress', 'judge-uncertainty-unmeasured'],
    });
    await expect(RELEASE_DECISION_POLICY_V2.decide({
      ...decisionContext,
      policy: {
        ...decisionContext.policy,
        implementationId: RELEASE_DECISION_POLICY_V2_IMPLEMENTATION_ID,
        parameters: legacyParameters(releaseParameters),
      },
    })).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'CAUTIOUS',
      reasonCodes: ['comparison-significant-progress', 'judge-uncertainty-unmeasured'],
    });
    await expect(RELEASE_DECISION_POLICY_V1.decide({
      ...decisionContext,
      policy: {
        ...decisionContext.policy,
        implementationId: RELEASE_DECISION_POLICY_V1_IMPLEMENTATION_ID,
        parameters: legacyParameters(releaseParameters),
      },
    })).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
      reasonCodes: ['comparison-significant-progress', 'release-gates-passed'],
    });
  });

  it('keeps release open when configured judge agreement is measurable and aligned', async () => {
    const sampleIds = ['sample-1', 'sample-2', 'sample-3', 'sample-4'];
    const values = tables({
      sampleIds,
      targetScores: { control: [4, 4, 4, 4], treatment: [5, 5, 5, 5] },
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
    await expect(RELEASE_DECISION_POLICY.decide({
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
          judgeEnsemble(values.composite, 'aligned') as JsonValue,
        ),
      ],
    })).resolves.toEqual({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
      reasonCodes: ['comparison-significant-progress', 'release-gates-passed'],
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
