import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  digestCanonicalJson,
  schemaIdentityKey,
  verifyAnalysisBundle,
  type AnalysisRecord,
  type JsonValue,
  type RuntimeIdentity,
  type SamplingUnitIds,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  AnalysisNodeCapabilitiesSchema,
  prepareEvaluationPlan,
  type AnalysisRuntimeRequirement,
  type PreparationRuntime,
} from '../../../src/evaluation-core/compiler/index.js';
import type {
  AnalysisMetricRow,
  AnalysisNodeExecutionContext,
  AnalysisNodeExecutionResult,
  AnalysisNodeImplementation,
  AnalysisNodeInput,
  AnalysisNodeRunContext,
} from '../../../src/evaluation-core/analysis/index.js';
import {
  analyzeEvaluationBundleSource,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinMissingPolicies,
  resolveBuiltinAnalysisRuntime,
} from '../../../src/evaluation-core/analysis/index.js';
import {
  executeRunPlanSource,
  InMemoryRuntimeEventSequencer,
  type ExecutionClock,
  type ExecutionExecutor,
} from '../../../src/evaluation-core/execution/index.js';
import {
  evaluateExecutionBundleSource,
  type EvaluationEvaluator,
} from '../../../src/evaluation-core/evaluation/index.js';
import {
  createJudgeAggregationAnalysisNodes,
  createJudgeAggregationSchemaValidators,
  createDimensionAnalysisNodes,
  createDimensionParameterSchemaValidators,
  createDimensionTableSchemaValidators,
  createCompositeAnalysisNodes,
  createCompositeParameterSchemaValidators,
  createCompositeTableSchemaValidators,
  COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
  DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
  JUDGE_ENSEMBLE_ANALYSIS_IDENTITY,
  JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
  JUDGE_ENSEMBLE_TABLE_SCHEMA,
  JUDGE_REPLICATE_ANALYSIS_IDENTITY,
  JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
  JUDGE_REPLICATE_TABLE_SCHEMA,
} from '../../../src/eval-workflows/runtime-adapter/index.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from '../../evaluation-core/compiler/fixtures.js';

const ANALYSIS_PLAN_DIGEST = digestCanonicalJson({ fixture: 'analysis-plan' });
const EVALUATION_BUNDLE_DIGEST = digestCanonicalJson({ fixture: 'evaluation-bundle' });
const TRIAL_ID = digestCanonicalJson({ fixture: 'trial-0' });
const PAIRING_BLOCK_ID = digestCanonicalJson({ fixture: 'pairing-block' });
const CLUSTER_ID = digestCanonicalJson({ fixture: 'cluster' });
const STRATUM_ID = digestCanonicalJson({ fixture: 'stratum' });

interface ScoringFixture {
  judgeRepeat: {
    replayScores: number[];
    expected: { score: number; scoreStddev: number; judgeFailureCount: number };
  };
  judgeEnsemble: {
    members: Array<{ executor: string; replayScores: number[] }>;
    expected: {
      score: number;
      ensemble: Array<{ judge: string; score: number; scoreStddev: number }>;
      agreement: { meanAbsDiff: number; pairCount: number };
    };
  };
}

const scoringFixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../fixtures/evaluation-core/scoring-equivalence-v1.json',
  import.meta.url,
)), 'utf8')) as ScoringFixture;

class FakeClock implements ExecutionClock {
  #now = 0;

  monotonicNow(): number {
    return this.#now++;
  }

  timestamp(): string {
    return new Date(Date.UTC(2026, 7, 31) + this.#now++).toISOString();
  }

  async sleep(delayMs: number): Promise<void> {
    this.#now += delayMs;
  }
}

function row(input: Readonly<{
  member: string;
  replicateIndex: number;
  score?: number;
  rowStatus?: Exclude<AnalysisMetricRow['rowStatus'], 'observed'>;
  reasonCode?: string;
  censored?: boolean;
  samplingUnitIds?: SamplingUnitIds;
}>): AnalysisMetricRow {
  const common = {
    rowId: digestCanonicalJson({ member: input.member, replicateIndex: input.replicateIndex }),
    targetId: 'target-a',
    sampleId: 'sample-a',
    trialIndex: 0,
    trialId: TRIAL_ID,
    evaluatorId: `rubric-${input.member}-${input.replicateIndex}`,
    measurement: {
      instrumentId: 'rubric-correctness',
      ensembleMemberId: input.member,
      replicateGroupId: 'primary',
      replicateIndex: input.replicateIndex,
    },
    cohortIds: [],
    metricId: 'rubric-score',
    valueType: 'numeric' as const,
    samplingUnitIds: input.samplingUnitIds ?? {},
    censored: input.censored ?? false,
  };
  if (input.rowStatus !== undefined) {
    return {
      ...common,
      rowStatus: input.rowStatus,
      reasonCode: input.reasonCode ?? 'judge-provider-failure',
    };
  }
  return { ...common, rowStatus: 'observed', value: input.score ?? 1 };
}

function context(
  implementationId: string,
  inputs: readonly AnalysisNodeInput[],
  signal: AbortSignal = new AbortController().signal,
): AnalysisNodeExecutionContext {
  return {
    node: {
      analysisNodeKind: 'reducer',
      nodeId: implementationId.includes('replicate') ? 'replicate-table' : 'ensemble-table',
      implementationId,
      inputs: inputs.map((input) => ({
        inputKind: input.inputKind,
        referenceId: input.referenceId,
      })),
      outputResultId: implementationId.includes('replicate')
        ? 'replicate-table'
        : 'ensemble-table',
      parameters: {},
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

function metricInput(rows: readonly AnalysisMetricRow[]): Extract<
  AnalysisNodeInput,
  { inputKind: 'metric-observations' }
> {
  return {
    inputKind: 'metric-observations',
    referenceId: 'rubric-score',
    metric: {
      metricId: 'rubric-score',
      valueType: 'numeric',
      scope: 'sample',
      scale: { min: 1, max: 5 },
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    },
    rows,
  } as Extract<AnalysisNodeInput, { inputKind: 'metric-observations' }>;
}

async function execute(
  implementationId: string,
  executionContext: AnalysisNodeExecutionContext,
): Promise<AnalysisNodeExecutionResult> {
  const node = createJudgeAggregationAnalysisNodes().get(implementationId);
  if (node === undefined) throw new Error(`missing ${implementationId}`);
  const run = await node.openRun({
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

function analysisInput(value: JsonValue): Extract<
  AnalysisNodeInput,
  { inputKind: 'analysis-result' }
> {
  return {
    inputKind: 'analysis-result',
    referenceId: 'replicate-table',
    record: {
      resultType: 'table',
      value,
      outputSchema: JUDGE_REPLICATE_TABLE_SCHEMA,
    } as Extract<AnalysisRecord, { analysisStatus: 'completed' }>,
  };
}

describe('judge aggregation Analysis nodes', () => {
  it('declares compiler-valid, fingerprint-bound Analysis capabilities', () => {
    const replicate = AnalysisNodeCapabilitiesSchema.parse(
      JUDGE_REPLICATE_ANALYSIS_IDENTITY.capabilities,
    );
    const ensemble = AnalysisNodeCapabilitiesSchema.parse(
      JUDGE_ENSEMBLE_ANALYSIS_IDENTITY.capabilities,
    );
    expect(replicate.schemas).toEqual([]);
    expect(ensemble.schemas).toEqual([JUDGE_REPLICATE_TABLE_SCHEMA]);
    expect(Object.isFrozen(JUDGE_REPLICATE_ANALYSIS_IDENTITY)).toBe(true);
    expect(Object.isFrozen(JUDGE_REPLICATE_ANALYSIS_IDENTITY.capabilities)).toBe(true);
    expect(JUDGE_REPLICATE_ANALYSIS_IDENTITY.fingerprint).not.toBe(
      JUDGE_ENSEMBLE_ANALYSIS_IDENTITY.fingerprint,
    );
    const implementations = createJudgeAggregationAnalysisNodes();
    expect(implementations.has('omk.judge-replicate-table/v1')).toBe(false);
    expect(implementations.has('omk.judge-ensemble-table/v1')).toBe(false);
  });

  it('preserves failed replicates while aggregating only observed rubric readings', async () => {
    const fixture = scoringFixture.judgeRepeat;
    const samplingUnitIds = {
      pairingBlockId: PAIRING_BLOCK_ID,
      clusterId: CLUSTER_ID,
      stratumId: STRATUM_ID,
    };
    expect(fixture.replayScores[1]).toBe(0);
    const result = await execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([
        row({
          member: 'alpha',
          replicateIndex: 0,
          score: fixture.replayScores[0],
          samplingUnitIds,
        }),
        row({
          member: 'alpha',
          replicateIndex: 2,
          rowStatus: 'evaluation-failed',
          samplingUnitIds,
        }),
        row({
          member: 'alpha',
          replicateIndex: 5,
          score: fixture.replayScores[2],
          samplingUnitIds,
        }),
      ])]),
    );
    expect(result.analysisStatus).toBe('completed');
    expect(completedValue(result)).toMatchObject({
      groups: [{
        ensembleMemberId: 'alpha',
        aggregateStatus: 'observed',
        mean: fixture.expected.score,
        sampleStddev: fixture.expected.scoreStddev,
        samplingUnitIds,
        coverage: {
          planned: 3,
          observed: 2,
          evaluationFailed: fixture.expected.judgeFailureCount,
        },
        replicates: [
          { replicateIndex: 0, rowStatus: 'observed', score: 5 },
          { replicateIndex: 2, rowStatus: 'evaluation-failed' },
          { replicateIndex: 5, rowStatus: 'observed', score: 3 },
        ],
      }],
    });
    if (result.analysisStatus === 'completed') {
      expect(result.includedRowIds).toEqual([...result.includedRowIds ?? []].sort());
      expect(result.includedRowIds).toHaveLength(2);
    }
  });

  it('computes equal-member consensus and agreement without failed-member zero pollution', async () => {
    const fixture = scoringFixture.judgeEnsemble;
    const [alpha, beta] = fixture.members;
    const replicate = await execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([
        row({ member: alpha.executor, replicateIndex: 0, score: alpha.replayScores[0] }),
        row({ member: alpha.executor, replicateIndex: 1, score: alpha.replayScores[1] }),
        row({ member: beta.executor, replicateIndex: 0, score: beta.replayScores[0] }),
        row({ member: beta.executor, replicateIndex: 1, score: beta.replayScores[1] }),
        row({ member: 'failed', replicateIndex: 0, rowStatus: 'evaluation-failed' }),
      ])]),
    );
    const ensemble = await execute(
      JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID, [
        analysisInput(completedValue(replicate)),
      ]),
    );
    expect(completedValue(ensemble)).toMatchObject({
      groups: [{
        aggregateStatus: 'observed',
        consensus: fixture.expected.score,
        coverage: { plannedMembers: 3, observedMembers: 2, missingMembers: 1 },
        agreement: {
          agreementStatus: 'observed',
          meanAbsDiff: fixture.expected.agreement.meanAbsDiff,
          pairCount: fixture.expected.agreement.pairCount,
        },
        members: [
          {
            ensembleMemberId: 'alpha',
            memberStatus: 'observed',
            mean: fixture.expected.ensemble[0].score,
            sampleStddev: fixture.expected.ensemble[0].scoreStddev,
          },
          {
            ensembleMemberId: 'beta',
            memberStatus: 'observed',
            mean: fixture.expected.ensemble[1].score,
            sampleStddev: fixture.expected.ensemble[1].scoreStddev,
          },
          { ensembleMemberId: 'failed', memberStatus: 'missing' },
        ],
      }],
    });
  });

  it('emits missing aggregates and agreement instead of numeric zero', async () => {
    const replicate = await execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([
        row({ member: 'alpha', replicateIndex: 0, score: 4 }),
        row({ member: 'failed', replicateIndex: 0, rowStatus: 'invalid' }),
      ])]),
    );
    const ensemble = await execute(
      JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID, [
        analysisInput(completedValue(replicate)),
      ]),
    );
    expect(completedValue(ensemble)).toMatchObject({
      groups: [{
        consensus: 4,
        agreement: {
          agreementStatus: 'missing',
          reasonCode: 'judge-agreement-insufficient-members',
          pairCount: 0,
        },
      }],
    });

    const allFailed = await execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([
        row({ member: 'failed', replicateIndex: 0, rowStatus: 'evaluation-failed' }),
        row({
          member: 'failed',
          replicateIndex: 1,
          rowStatus: 'evaluation-failed',
          reasonCode: 'evaluation-cancelled',
        }),
        row({ member: 'failed', replicateIndex: 2, rowStatus: 'missing' }),
        row({ member: 'failed', replicateIndex: 3, rowStatus: 'invalid' }),
        row({
          member: 'failed',
          replicateIndex: 4,
          rowStatus: 'source-unavailable',
          censored: true,
        }),
        row({ member: 'failed', replicateIndex: 5, rowStatus: 'not-started' }),
      ])]),
    );
    expect(completedValue(allFailed)).toMatchObject({
      groups: [{
        aggregateStatus: 'missing',
        reasonCode: 'judge-replicates-unobserved',
        coverage: {
          planned: 6,
          observed: 0,
          missing: 1,
          invalid: 1,
          evaluationFailed: 2,
          sourceUnavailable: 1,
          notStarted: 1,
          censored: 1,
        },
      }],
    });
  });

  it('is byte-stable under input permutation', async () => {
    const rows = [
      row({ member: 'beta', replicateIndex: 3, score: 4 }),
      row({ member: 'alpha', replicateIndex: 5, score: 3 }),
      row({ member: 'alpha', replicateIndex: 0, score: 5 }),
      row({ member: 'beta', replicateIndex: 0, score: 2 }),
    ];
    const forward = await execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput(rows)]),
    );
    const reverse = await execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([...rows].reverse())]),
    );
    expect(canonicalizeJson(forward as unknown as JsonValue)).toBe(
      canonicalizeJson(reverse as unknown as JsonValue),
    );
  });

  it('rejects tampered aggregates, coverage, ordering, and lineage', async () => {
    const result = await execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([
        row({ member: 'alpha', replicateIndex: 0, score: 5 }),
        row({ member: 'alpha', replicateIndex: 1, score: 3 }),
      ])]),
    );
    const validator = createJudgeAggregationSchemaValidators().get(
      schemaIdentityKey(JUDGE_REPLICATE_TABLE_SCHEMA),
    );
    if (validator === undefined) throw new Error('missing replicate validator');
    const envelope = { resultType: 'table', value: completedValue(result) };
    expect(() => validator.parse(envelope)).not.toThrow();

    type MutableEnvelope = {
      value: {
        groups: Array<{
          mean: number;
          sampleStddev: number;
          samplingUnitIds: SamplingUnitIds;
          coverage: { observed: number };
          replicates: unknown[];
          groupId: string;
        }>;
      };
    };
    const mutations: Array<(candidate: MutableEnvelope) => void> = [
      (candidate) => { candidate.value.groups[0].mean = 1; },
      (candidate) => { candidate.value.groups[0].sampleStddev = 0; },
      (candidate) => {
        candidate.value.groups[0].samplingUnitIds = { clusterId: CLUSTER_ID };
      },
      (candidate) => { candidate.value.groups[0].coverage.observed = 1; },
      (candidate) => { candidate.value.groups[0].replicates.reverse(); },
      (candidate) => { candidate.value.groups[0].groupId = digestCanonicalJson('tampered'); },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(envelope) as unknown as MutableEnvelope;
      mutate(tampered);
      expect(() => validator.parse(tampered)).toThrow();
    }
  });

  it('rejects tampered ensemble consensus, agreement, coverage, and row lineage', async () => {
    const replicate = await execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([
        row({ member: 'alpha', replicateIndex: 0, score: 4 }),
        row({ member: 'beta', replicateIndex: 0, score: 2 }),
      ])]),
    );
    const ensemble = await execute(
      JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID, [
        analysisInput(completedValue(replicate)),
      ]),
    );
    const validator = createJudgeAggregationSchemaValidators().get(
      schemaIdentityKey(JUDGE_ENSEMBLE_TABLE_SCHEMA),
    );
    if (validator === undefined) throw new Error('missing ensemble validator');
    const envelope = { resultType: 'table', value: completedValue(ensemble) };
    expect(() => validator.parse(envelope)).not.toThrow();

    type MutableEnvelope = {
      value: {
        groups: Array<{
          consensus: number;
          samplingUnitIds: SamplingUnitIds;
          coverage: { observedMembers: number };
          agreement: { meanAbsDiff: number };
          members: Array<{ sourceRowIds: string[] }>;
        }>;
      };
    };
    const mutations: Array<(candidate: MutableEnvelope) => void> = [
      (candidate) => { candidate.value.groups[0].consensus = 4; },
      (candidate) => { candidate.value.groups[0].agreement.meanAbsDiff = 1; },
      (candidate) => { candidate.value.groups[0].coverage.observedMembers = 1; },
      (candidate) => {
        candidate.value.groups[0].samplingUnitIds = { clusterId: CLUSTER_ID };
      },
      (candidate) => {
        candidate.value.groups[0].members[1].sourceRowIds = [
          ...candidate.value.groups[0].members[0].sourceRowIds,
        ];
      },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(envelope) as unknown as MutableEnvelope;
      mutate(tampered);
      expect(() => validator.parse(tampered)).toThrow();
    }
  });

  it('returns inconclusive for an empty cohort and cooperatively cancels before work', async () => {
    const empty = await execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([])]),
    );
    expect(empty).toEqual({
      analysisStatus: 'inconclusive',
      reasonCodes: ['judge-analysis-no-planned-rows'],
      includedRowIds: [],
      comparableRowIds: [],
      assumptionChecks: [{
        assumptionId: 'judge-replicate-contract',
        checkStatus: 'failed',
        reasonCode: 'judge-analysis-no-planned-rows',
      }],
    });

    const controller = new AbortController();
    controller.abort(new Error('cancelled-by-test'));
    await expect(execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([
        row({ member: 'alpha', replicateIndex: 0, score: 5 }),
      ])], controller.signal),
    )).rejects.toThrow('cancelled-by-test');
  });

  it('fails closed when replicate rows or ensemble members disagree on sampling lineage', async () => {
    await expect(execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([
        row({
          member: 'alpha',
          replicateIndex: 0,
          score: 5,
          samplingUnitIds: { pairingBlockId: PAIRING_BLOCK_ID },
        }),
        row({
          member: 'alpha',
          replicateIndex: 1,
          score: 3,
          samplingUnitIds: { pairingBlockId: digestCanonicalJson('other-pairing-block') },
        }),
      ])]),
    )).rejects.toThrow('sampling-unit lineage');

    const replicate = await execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([
        row({
          member: 'alpha',
          replicateIndex: 0,
          score: 5,
          samplingUnitIds: { pairingBlockId: PAIRING_BLOCK_ID },
        }),
        row({
          member: 'beta',
          replicateIndex: 0,
          score: 3,
          samplingUnitIds: { pairingBlockId: digestCanonicalJson('other-pairing-block') },
        }),
      ])]),
    );
    await expect(execute(
      JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID, [
        analysisInput(completedValue(replicate)),
      ]),
    )).rejects.toThrow('sampling-unit lineage');
  });

  it('rejects a same-URI Analysis input with a different schema digest', async () => {
    const replicate = await execute(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID, [metricInput([
        row({ member: 'alpha', replicateIndex: 0, score: 5 }),
      ])]),
    );
    const input = analysisInput(completedValue(replicate));
    input.record.outputSchema = {
      ...JUDGE_REPLICATE_TABLE_SCHEMA,
      schemaDigest: digestCanonicalJson('wrong-schema'),
    };
    await expect(execute(
      JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
      context(JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID, [input]),
    )).rejects.toThrow('sealed replicate table schema');
  });

  it('runs through the sealed Evaluation Core Analysis DAG and emits verifiable artifacts', async () => {
    const implementations = new Map([
      ...createJudgeAggregationAnalysisNodes(),
      ...createDimensionAnalysisNodes(),
      ...createCompositeAnalysisNodes(),
    ]);
    const base = testRuntime({ evaluatorValueTypes: ['numeric'] });
    const customValidators = new Map([
      ...createJudgeAggregationSchemaValidators(),
      ...createDimensionParameterSchemaValidators(),
      ...createDimensionTableSchemaValidators(),
      ...createCompositeParameterSchemaValidators(),
      ...createCompositeTableSchemaValidators(),
    ]);
    const schemaValidators = new Map([
      ...base.schemaValidators,
      ...createBuiltinAnalysisSchemaValidators(),
      ...customValidators,
    ]);
    const preparationRuntime: PreparationRuntime = {
      schemaValidators,
      resolveExecutor: (requirement) => base.resolveExecutor(requirement),
      resolveEvaluator: (requirement) => base.resolveEvaluator(requirement),
      resolveAnalysis(requirement: Readonly<AnalysisRuntimeRequirement>) {
        if (requirement.requirementKind === 'analysis-node') {
          const implementation = implementations.get(requirement.implementationId);
          if (implementation !== undefined) {
            return { identity: implementation.identity, satisfiesVersionConstraint: true };
          }
        }
        const builtin = resolveBuiltinAnalysisRuntime(requirement);
        if (builtin === undefined) throw new Error(`unknown ${requirement.implementationId}`);
        return builtin;
      },
      validateExtension: (request) => base.validateExtension?.(request),
    };
    const definition = validDefinition();
    definition.evaluators = [
      ['alpha', 0],
      ['alpha', 1],
      ['beta', 0],
      ['beta', 1],
      ['failed', 0],
    ].map(([member, replicateIndex]) => ({
      evaluatorId: `rubric-${member}-${replicateIndex}`,
      evaluatorKind: 'llm-rubric' as const,
      implementationId: 'rubric-fixture/v1',
      measurement: {
        instrumentId: 'rubric-correctness',
        ensembleMemberId: String(member),
        replicateGroupId: 'primary',
        replicateIndex: Number(replicateIndex),
      },
      metricIds: ['rubric-score'],
      inputs: [{ bindingId: 'actual', sourceKind: 'output' as const, pointer: '/answer' }],
    }));
    definition.metrics = [{
      metricId: 'rubric-score',
      valueType: 'numeric',
      scope: 'sample',
      scale: { min: 1, max: 5 },
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    }];
    definition.analysisGraph.nodes = [{
      analysisNodeKind: 'reducer',
      nodeId: 'replicate-table',
      implementationId: JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      inputs: [{ inputKind: 'metric-observations', referenceId: 'rubric-score' }],
      outputResultId: 'replicate-table',
    }, {
      analysisNodeKind: 'reducer',
      nodeId: 'ensemble-table',
      implementationId: JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
      inputs: [{ inputKind: 'analysis-result', referenceId: 'replicate-table' }],
      outputResultId: 'ensemble-table',
    }, {
      analysisNodeKind: 'reducer',
      nodeId: 'dimension-table',
      implementationId: DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
      inputs: [{ inputKind: 'analysis-result', referenceId: 'ensemble-table' }],
      outputResultId: 'dimension-table',
      parameters: {
        dimensions: [{
          dimensionId: 'correctness',
          metricId: 'rubric-score',
          analysisResultId: 'ensemble-table',
        }],
      },
    }, {
      analysisNodeKind: 'reducer',
      nodeId: 'composite-table',
      implementationId: COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
      inputs: [{ inputKind: 'analysis-result', referenceId: 'dimension-table' }],
      outputResultId: 'composite-table',
      parameters: {
        layers: [{
          layerId: 'judge', analysisResultId: 'dimension-table',
          sourceKind: 'dimension', selector: 'aggregate',
        }],
      },
    }];
    definition.comparisons[0].metricIds = ['rubric-score'];
    definition.experiment.sampling = {
      experimentalUnit: 'sample',
      pairingKey: '/sampleId',
      repeatedMeasures: true,
      resamplingUnit: 'paired-block',
      estimatorId: 'bootstrap.paired-difference-percentile/v1',
      seedCoupling: 'shared-within-block',
    };
    definition.experiment.scheduling = { schedulingKind: 'randomized-block', blockSize: 2 };
    delete definition.decisionPolicy;
    const policy = validPolicy();
    delete policy.execution.timeoutMs;
    delete policy.evaluation.timeoutMs;
    policy.evidence.trace = 'none';
    policy.retry.maxAttempts = 1;
    policy.evaluation.retry.maxAttempts = 1;
    const plan = await prepareEvaluationPlan(definition, policy, preparationRuntime);
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const executorRuntime = plan.execution.runtimes.find((runtime) => (
      runtime.runtimeKind === 'executor'
    ));
    if (executorRuntime?.runtimeKind !== 'executor') throw new Error('missing executor runtime');
    const executor: ExecutionExecutor = {
      identity: structuredClone(executorRuntime.identity) as RuntimeIdentity,
      async openRun() {
        return {
          async openTrial() {
            return {
              async execute() {
                return {
                  output: { value: { answer: 'fixture' }, classification: 'public' as const },
                };
              },
              dispose() {},
            };
          },
          dispose() {},
        };
      },
    };
    const execution = await executeRunPlanSource(plan, {
      executorsByTargetId: new Map(plan.execution.targets.map((target) => [
        target.targetId,
        executor,
      ])),
      clock,
      eventSequencer,
    }, { runId: 'judge-analysis-run', bundleId: 'judge-execution' });
    const evaluatorPorts = new Map(plan.evaluation.evaluators.map((plannedEvaluator) => {
      const evaluatorRuntime = plan.evaluation.runtimes.find((runtime) => (
        runtime.runtimeKind === 'evaluator'
        && runtime.referenceId === plannedEvaluator.evaluatorId
      ));
      if (evaluatorRuntime?.runtimeKind !== 'evaluator') {
        throw new Error(`missing evaluator runtime ${plannedEvaluator.evaluatorId}`);
      }
      const evaluator: EvaluationEvaluator = {
        identity: structuredClone(evaluatorRuntime.identity) as RuntimeIdentity,
        async openRun() {
          return {
            async openRecord() {
              return {
                async evaluate() {
                  const evaluatorId = plannedEvaluator.evaluatorId;
                  const scores: Record<string, number> = {
                    'rubric-alpha-0': 4,
                    'rubric-alpha-1': 5,
                    'rubric-beta-0': 2,
                    'rubric-beta-1': 4,
                  };
                  const score = scores[evaluatorId];
                  return {
                    observations: [score === undefined ? {
                      metricId: 'rubric-score',
                      observationStatus: 'missing' as const,
                      valueType: 'numeric' as const,
                      reasonCode: 'judge-provider-failure',
                    } : {
                      metricId: 'rubric-score',
                      observationStatus: 'observed' as const,
                      valueType: 'numeric' as const,
                      value: score,
                    }],
                    usage: {
                      inputTokens: 10,
                      outputTokens: 2,
                      totalTokens: 12,
                      providerCost: {
                        amount: 0.001,
                        currency: 'USD',
                        reportedByProvider: true,
                      },
                    },
                  };
                },
                dispose() {},
              };
            },
            dispose() {},
          };
        },
      };
      return [plannedEvaluator.evaluatorId, evaluator] as const;
    }));
    const evaluation = await evaluateExecutionBundleSource(plan, execution, {
      evaluatorsByEvaluatorId: evaluatorPorts,
      clock,
      eventSequencer,
    }, { runId: 'judge-analysis-run', bundleId: 'judge-evaluation' });
    const lifecycle = new Map<string, { opened: number; executed: number; disposed: number }>();
    const analysisNodesByNodeId = new Map(plan.analysis.analysisGraph.nodes.map((node) => {
      const implementation = implementations.get(node.implementationId);
      if (implementation === undefined) throw new Error(`missing ${node.implementationId}`);
      const counts = { opened: 0, executed: 0, disposed: 0 };
      lifecycle.set(node.nodeId, counts);
      const observed: AnalysisNodeImplementation = {
        identity: implementation.identity,
        outputSchema: implementation.outputSchema,
        async openRun(runContext) {
          counts.opened += 1;
          const run = await implementation.openRun(runContext);
          return {
            async execute(executionContext) {
              counts.executed += 1;
              return run.execute(executionContext);
            },
            async dispose() {
              counts.disposed += 1;
              await run.dispose();
            },
          };
        },
      };
      return [node.nodeId, observed] as const;
    }));
    const analysis = await analyzeEvaluationBundleSource(plan, execution, evaluation, {
      analysisNodesByNodeId,
      schemaValidators,
      missingPoliciesByPolicyId: createBuiltinMissingPolicies(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      clock,
      eventSequencer,
    }, { runId: 'judge-analysis-run', bundleId: 'judge-analysis' });

    expect(() => verifyAnalysisBundle(
      analysis.bundle,
      plan,
      execution,
      evaluation,
      { schemaValidators },
    )).not.toThrow();
    expect(analysis.bundle.analysisBundleStatus).toBe('completed');
    expect(analysis.bundle.records).toHaveLength(4);
    expect(analysis.bundle.records.map((record) => record.analysisStatus)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect([...lifecycle.values()]).toEqual([
      { opened: 1, executed: 1, disposed: 1 },
      { opened: 1, executed: 1, disposed: 1 },
      { opened: 1, executed: 1, disposed: 1 },
      { opened: 1, executed: 1, disposed: 1 },
    ]);
    const ensembleRecord = analysis.bundle.records.find((record) => (
      record.resultId === 'ensemble-table'
    ));
    expect(ensembleRecord?.analysisStatus).toBe('completed');
    if (ensembleRecord?.analysisStatus !== 'completed') throw new Error('missing ensemble result');
    const executionPairingBlockId = execution.bundle.records[0]?.samplingUnitIds.pairingBlockId;
    expect(executionPairingBlockId).toBeDefined();
    const completedEvaluations = evaluation.bundle.records.filter((record) => (
      record.evaluationStatus === 'completed'
    ));
    expect(completedEvaluations).not.toHaveLength(0);
    expect(completedEvaluations.every((record) => record.usage?.providerCost?.amount === 0.001))
      .toBe(true);
    expect(JSON.stringify(analysis.bundle)).not.toContain('providerCost');
    expect(JSON.stringify(analysis.bundle)).not.toContain('inputTokens');
    expect(ensembleRecord.value).toMatchObject({
      groups: expect.arrayContaining([expect.objectContaining({
        consensus: 3.75,
        samplingUnitIds: { pairingBlockId: executionPairingBlockId },
        agreement: { agreementStatus: 'observed', meanAbsDiff: 1.5, pairCount: 1 },
      })]),
    });
    const dimensionRecord = analysis.bundle.records.find((record) => (
      record.resultId === 'dimension-table'
    ));
    expect(dimensionRecord?.analysisStatus).toBe('completed');
    if (dimensionRecord?.analysisStatus !== 'completed') {
      throw new Error('missing dimension result');
    }
    expect(dimensionRecord.coverage).toMatchObject({
      planned: 0,
      included: 0,
      comparable: 0,
    });
    expect(dimensionRecord.value).toMatchObject({
      groups: expect.arrayContaining([expect.objectContaining({
        samplingUnitIds: { pairingBlockId: executionPairingBlockId },
        coverage: { plannedDimensions: 1, observedDimensions: 1, missingDimensions: 0 },
        aggregate: { aggregateStatus: 'observed', mean: 3.75 },
      })]),
    });
    const dimensionGroups = (dimensionRecord.value as { groups: Array<{
      aggregate: unknown;
      coverage: unknown;
      samplingUnitIds: unknown;
    }> }).groups;
    expect(dimensionGroups).toHaveLength(2);
    expect(dimensionGroups.every((group) => canonicalizeJson(group.aggregate)
      === canonicalizeJson({ aggregateStatus: 'observed', mean: 3.75 }))).toBe(true);
    const compositeRecord = analysis.bundle.records.find((record) => (
      record.resultId === 'composite-table'
    ));
    expect(compositeRecord?.analysisStatus).toBe('completed');
    if (compositeRecord?.analysisStatus !== 'completed') {
      throw new Error('missing composite result');
    }
    expect(compositeRecord.coverage).toMatchObject({ planned: 0, included: 0, comparable: 0 });
    expect(compositeRecord.value).toMatchObject({
      groups: expect.arrayContaining([expect.objectContaining({
        coverage: { plannedLayers: 1, observedLayers: 1, missingLayers: 0 },
        aggregate: { aggregateStatus: 'observed', score: 3.75 },
      })]),
    });

    const replicateImplementation = implementations.get(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
    );
    const ensembleImplementation = implementations.get(
      JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
    );
    const dimensionImplementation = implementations.get(DIMENSION_ANALYSIS_IMPLEMENTATION_ID);
    const compositeImplementation = implementations.get(COMPOSITE_ANALYSIS_IMPLEMENTATION_ID);
    if (replicateImplementation === undefined
        || ensembleImplementation === undefined
        || dimensionImplementation === undefined
        || compositeImplementation === undefined) {
      throw new Error('missing judge aggregation implementations');
    }
    let failedReplicateDisposed = 0;
    let blockedEnsembleOpened = 0;
    let blockedDimensionOpened = 0;
    let blockedCompositeOpened = 0;
    const failure = await analyzeEvaluationBundleSource(plan, execution, evaluation, {
      analysisNodesByNodeId: new Map([
        ['replicate-table', {
          identity: replicateImplementation.identity,
          outputSchema: replicateImplementation.outputSchema,
          async openRun() {
            return {
              async execute() {
                throw new Error('replicate-analysis-fixture-failure');
              },
              dispose() { failedReplicateDisposed += 1; },
            };
          },
        }],
        ['ensemble-table', {
          identity: ensembleImplementation.identity,
          outputSchema: ensembleImplementation.outputSchema,
          async openRun(runContext: Readonly<AnalysisNodeRunContext>) {
            blockedEnsembleOpened += 1;
            return ensembleImplementation.openRun(runContext);
          },
        }],
        ['dimension-table', {
          identity: dimensionImplementation.identity,
          outputSchema: dimensionImplementation.outputSchema,
          async openRun(runContext: Readonly<AnalysisNodeRunContext>) {
            blockedDimensionOpened += 1;
            return dimensionImplementation.openRun(runContext);
          },
        }],
        ['composite-table', {
          identity: compositeImplementation.identity,
          outputSchema: compositeImplementation.outputSchema,
          async openRun(runContext: Readonly<AnalysisNodeRunContext>) {
            blockedCompositeOpened += 1;
            return compositeImplementation.openRun(runContext);
          },
        }],
      ]),
      schemaValidators,
      missingPoliciesByPolicyId: createBuiltinMissingPolicies(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      clock,
      eventSequencer,
    }, { runId: 'judge-analysis-failure', bundleId: 'judge-analysis-failure' });
    expect(failure.bundle.analysisBundleStatus).toBe('failed');
    expect(Object.fromEntries(failure.bundle.records.map((record) => [
      record.resultId,
      record.analysisStatus,
    ]))).toEqual({
      'replicate-table': 'failed',
      'ensemble-table': 'not-evaluated',
      'dimension-table': 'not-evaluated',
      'composite-table': 'not-evaluated',
    });
    expect(failedReplicateDisposed).toBe(1);
    expect(blockedEnsembleOpened).toBe(0);
    expect(blockedDimensionOpened).toBe(0);
    expect(blockedCompositeOpened).toBe(0);

    const cancellation = new AbortController();
    cancellation.abort(new Error('cancelled-before-analysis'));
    const cancelled = await analyzeEvaluationBundleSource(plan, execution, evaluation, {
      analysisNodesByNodeId: new Map([
        ['replicate-table', replicateImplementation],
        ['ensemble-table', ensembleImplementation],
        ['dimension-table', dimensionImplementation],
        ['composite-table', compositeImplementation],
      ]),
      schemaValidators,
      missingPoliciesByPolicyId: createBuiltinMissingPolicies(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      clock,
      eventSequencer,
    }, {
      runId: 'judge-analysis-cancelled',
      bundleId: 'judge-analysis-cancelled',
      signal: cancellation.signal,
    });
    expect(cancelled.bundle.analysisBundleStatus).toBe('cancelled');
    expect(cancelled.bundle.records.map((record) => record.analysisStatus)).toEqual([
      'not-evaluated',
      'not-evaluated',
      'not-evaluated',
      'not-evaluated',
    ]);
  });
});
