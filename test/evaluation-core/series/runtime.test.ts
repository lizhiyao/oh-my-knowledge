import { describe, expect, it } from 'vitest';
import {
  EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION,
  createEvaluationSeriesDefinition,
  createEvaluationSeriesMemberSource,
  digestCanonicalJson,
  prepareEvaluationSeriesPlan,
  runEvaluationSeries,
  schemaIdentityKey,
  type EvaluationSeriesDefinition,
  type EvaluationSeriesDefinitionInput,
  type EvaluationSeriesMemberSource,
  type RuntimeIdentity,
} from '../../../src/index.js';
import {
  importConformanceResult,
  prepareConformancePlan,
  runConformanceScenario,
  type ConformanceResult,
} from '../conformance/harness.js';

const seriesOutputSchema = {
  schemaVersion: 'omk.series-scalar-envelope/v1',
  schemaUri: 'urn:omk:series:scalar-envelope:v1',
  schemaDigest: digestCanonicalJson({ schema: 'series-scalar-envelope', version: 1 }),
};

const seriesSchemaValidators = new Map([[schemaIdentityKey(seriesOutputSchema), {
  schema: seriesOutputSchema,
  parse(value: unknown) {
    return value as never;
  },
}]]);

function identity(implementationId: string): RuntimeIdentity {
  return {
    implementationId,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({ implementationId, version: 1 }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'verified',
    capabilities: { experimentalUnit: 'run' },
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  };
}

function memberSource(
  memberId: string,
  replicateIndex: number,
  result: ConformanceResult,
): EvaluationSeriesMemberSource {
  return createEvaluationSeriesMemberSource({
    memberId,
    replicateIndex,
    plan: result.plan,
    execution: result.executionSource,
    evaluation: result.evaluationSource,
    analysis: result.analysisSource,
    ...(result.decisionSource === undefined ? {} : { decision: result.decisionSource }),
    report: result.report,
  });
}

function importedMemberSource(
  memberId: string,
  replicateIndex: number,
  result: ConformanceResult,
): EvaluationSeriesMemberSource {
  const imported = importConformanceResult(result);
  return createEvaluationSeriesMemberSource({
    memberId,
    replicateIndex,
    plan: result.plan,
    execution: imported.executionSource,
    evaluation: imported.evaluationSource,
    analysis: imported.analysisSource,
    decision: imported.decisionSource,
    report: imported.report,
  });
}

function definition(): EvaluationSeriesDefinitionInput {
  return {
    schemaVersion: EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION,
    seriesId: 'release-stability',
    analysisMode: 'preregistered',
    experimentalUnit: 'run',
    members: [
      { memberId: 'repeat-2', replicateIndex: 1 },
      { memberId: 'repeat-1', replicateIndex: 0 },
    ],
    comparabilityPolicy: {
      designMode: 'exact-measurement-design',
      comparisonScope: 'analysis',
      minimumStatus: 'conditional',
    },
    analysisGraph: {
      nodes: [{
        nodeId: 'stability',
        implementationId: 'stability.rate/v1',
        analysisStandardId: 'stability.rate/v1',
        minimumMemberEvidenceStatus: 'complete',
        inputs: [{ seriesInputKind: 'members', referenceId: 'release-stability' }],
        outputResultId: 'stability-result',
        parameters: { threshold: 0.9 },
      }],
    },
    decisionPolicy: {
      decisionPolicyId: 'series-release-gate',
      implementationId: 'series-release-gate/v1',
      analysisResultIds: ['stability-result'],
      minimumCoverageRatio: 1,
      minimumMemberEvidenceStatus: 'complete',
    },
  };
}

async function memberPlan(
  series: EvaluationSeriesDefinition,
  memberId: string,
  replicateIndex: number,
) {
  return prepareConformancePlan('function', (runDefinition) => {
    runDefinition.seriesMembership = {
      seriesDesignDigest: series.seriesDesignDigest,
      memberId,
      replicateIndex,
    };
  });
}

describe('Evaluation Series Runtime', () => {
  it('canonicalizes Series identity and seals exploratory member eligibility', () => {
    const leftInput = definition();
    const rightInput = structuredClone(leftInput);
    rightInput.members.reverse();
    const left = createEvaluationSeriesDefinition(leftInput);
    const right = createEvaluationSeriesDefinition(rightInput);

    expect(right.seriesDesignDigest).toBe(left.seriesDesignDigest);
    expect(right.members).toEqual(left.members);

    const exploratory = definition();
    exploratory.analysisMode = 'exploratory';
    exploratory.members[0].expectedRunContractDigest = digestCanonicalJson({ run: 1 });
    const first = createEvaluationSeriesDefinition(exploratory);
    exploratory.members[0].expectedRunContractDigest = digestCanonicalJson({ run: 2 });
    const second = createEvaluationSeriesDefinition(exploratory);
    expect(second.seriesDesignDigest).not.toBe(first.seriesDesignDigest);

    const duplicate = definition();
    duplicate.members[1].replicateIndex = duplicate.members[0].replicateIndex;
    expect(() => createEvaluationSeriesDefinition(duplicate)).toThrow(
      'unique memberId and replicateIndex',
    );
  });

  it('binds the declared implementation and run experimental unit', () => {
    const series = createEvaluationSeriesDefinition(definition());
    const decisionIdentity = identity('series-release-gate/v1');
    expect(() => prepareEvaluationSeriesPlan(series, [
      {
        runtimeKind: 'series-analysis-node',
        referenceId: 'stability',
        identity: identity('different-analysis/v1'),
        outputSchema: seriesOutputSchema,
      },
      {
        runtimeKind: 'series-decision-policy',
        referenceId: 'series-release-gate',
        identity: decisionIdentity,
      },
    ])).toThrow('must match the declared implementation and run unit');

    const wrongUnit = identity('stability.rate/v1');
    wrongUnit.capabilities = { experimentalUnit: 'sample' };
    expect(() => prepareEvaluationSeriesPlan(series, [
      {
        runtimeKind: 'series-analysis-node',
        referenceId: 'stability',
        identity: wrongUnit,
        outputSchema: seriesOutputSchema,
      },
      {
        runtimeKind: 'series-decision-policy',
        referenceId: 'series-release-gate',
        identity: decisionIdentity,
      },
    ])).toThrow('must match the declared implementation and run unit');
  });

  it('rejects cyclic Series analysis dependencies before issuing a design digest', () => {
    const input = definition();
    const base = input.analysisGraph.nodes[0];
    input.analysisGraph.nodes = [
      {
        ...base,
        nodeId: 'a',
        outputResultId: 'result-a',
        inputs: [{ seriesInputKind: 'analysis-result', referenceId: 'result-b' }],
      },
      {
        ...base,
        nodeId: 'b',
        outputResultId: 'result-b',
        inputs: [{ seriesInputKind: 'analysis-result', referenceId: 'result-a' }],
      },
    ];
    delete input.decisionPolicy;
    expect(() => createEvaluationSeriesDefinition(input)).toThrow('must be acyclic');
  });

  it('materializes all-missing coverage without inventing member evidence', async () => {
    const series = createEvaluationSeriesDefinition(definition());
    const analysisIdentity = identity('stability.rate/v1');
    const decisionIdentity = identity('series-release-gate/v1');
    const plan = prepareEvaluationSeriesPlan(series, [
      {
        runtimeKind: 'series-analysis-node',
        referenceId: 'stability',
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
      },
      {
        runtimeKind: 'series-decision-policy',
        referenceId: 'series-release-gate',
        identity: decisionIdentity,
      },
    ]);
    const result = await runEvaluationSeries(plan, [], {
      analysisNodesByNodeId: new Map(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      schemaValidators: new Map(),
    }, { bundleId: 'series-all-missing', reportId: 'series-all-missing' });

    expect(result.analysis.coverage).toMatchObject({
      planned: 2,
      missing: 2,
      comparable: 0,
    });
    expect(result.analysis.records[0]).toMatchObject({
      runtimeExecutionStatus: 'not-executed',
      analysisStatus: 'inconclusive',
    });
    expect(result.decision).toMatchObject({
      policyExecutionStatus: 'not-executed',
      decisionStatus: 'not-decided',
    });
  });

  it('rejects a post-hoc Run that claims preregistered Series membership', async () => {
    const series = createEvaluationSeriesDefinition(definition());
    const unboundPlan = await prepareConformancePlan('function');
    const result = await runConformanceScenario('function', {
      plan: unboundPlan,
      suffix: 'series-unbound',
    });
    const analysisIdentity = identity('stability.rate/v1');
    const decisionIdentity = identity('series-release-gate/v1');
    const plan = prepareEvaluationSeriesPlan(series, [
      {
        runtimeKind: 'series-analysis-node',
        referenceId: 'stability',
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
      },
      {
        runtimeKind: 'series-decision-policy',
        referenceId: 'series-release-gate',
        identity: decisionIdentity,
      },
    ]);

    await expect(runEvaluationSeries(
      plan,
      [memberSource('repeat-1', 0, result)],
      {
        analysisNodesByNodeId: new Map(),
        decisionPoliciesByDecisionPolicyId: new Map(),
        schemaValidators: seriesSchemaValidators,
      },
      { bundleId: 'series-unbound', reportId: 'series-unbound' },
    )).rejects.toThrow('must bind the Series design before Run execution');
  });

  it('aggregates authenticated independent runs in canonical member order', async () => {
    const series = createEvaluationSeriesDefinition(definition());
    const [firstPlan, secondPlan] = await Promise.all([
      memberPlan(series, 'repeat-1', 0),
      memberPlan(series, 'repeat-2', 1),
    ]);
    const [first, second] = await Promise.all([
      runConformanceScenario('function', { plan: firstPlan, suffix: 'series-1' }),
      runConformanceScenario('function', { plan: secondPlan, suffix: 'series-2' }),
    ]);
    const analysisIdentity = identity('stability.rate/v1');
    const decisionIdentity = identity('series-release-gate/v1');
    const plan = prepareEvaluationSeriesPlan(series, [
      {
        runtimeKind: 'series-decision-policy',
        referenceId: 'series-release-gate',
        identity: decisionIdentity,
      },
      {
        runtimeKind: 'series-analysis-node',
        referenceId: 'stability',
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
      },
    ]);
    const memberInputs = [
      importedMemberSource('repeat-2', 1, second),
      importedMemberSource('repeat-1', 0, first),
    ];
    expect(memberInputs.every((member) => Object.isFrozen(member.sources))).toBe(true);
    const result = await runEvaluationSeries(
      plan,
      memberInputs,
      {
        analysisNodesByNodeId: new Map([['stability', {
          identity: analysisIdentity,
          outputSchema: seriesOutputSchema,
          async analyze(context) {
            return {
              analysisStatus: 'completed' as const,
              resultType: 'scalar' as const,
              value: context.members.length / context.coverage.planned,
              assumptionChecks: [{ assumptionId: 'minimum-runs', checkStatus: 'passed' as const }],
            };
          },
        }]]),
        decisionPoliciesByDecisionPolicyId: new Map([['series-release-gate', {
          identity: decisionIdentity,
          async decide() {
            return { decisionStatus: 'decided' as const, verdict: 'stable' };
          },
        }]]),
        schemaValidators: seriesSchemaValidators,
      },
      { bundleId: 'series-analysis-1', reportId: 'series-report-1' },
    );

    expect(plan.definition.members.map((member) => member.memberId)).toEqual([
      'repeat-1',
      'repeat-2',
    ]);
    expect(result.analysis.members.map((member) => member.memberId)).toEqual([
      'repeat-1',
      'repeat-2',
    ]);
    expect(result.analysis.coverage).toMatchObject({ planned: 2, comparable: 2, missing: 0 });
    expect(result.analysis.comparability).toHaveLength(1);
    expect(result.analysis.comparability[0]).toMatchObject({
      anchorMemberId: 'repeat-1',
      memberId: 'repeat-2',
      assessment: { comparabilityStatus: 'conditional' },
    });
    expect(result.analysis.records[0]).toMatchObject({
      runtimeExecutionStatus: 'executed',
      analysisStatus: 'completed',
      analysisStandardId: 'stability.rate/v1',
      value: 1,
    });
    expect(result.decision).toMatchObject({
      policyExecutionStatus: 'executed',
      decisionStatus: 'decided',
      verdict: 'stable',
    });
  });

  it('keeps a missing independent run in coverage and blocks a directional verdict', async () => {
    const series = createEvaluationSeriesDefinition(definition());
    const runPlan = await memberPlan(series, 'repeat-1', 0);
    const first = await runConformanceScenario('function', {
      plan: runPlan,
      suffix: 'series-partial',
    });
    const analysisIdentity = identity('stability.rate/v1');
    const decisionIdentity = identity('series-release-gate/v1');
    const plan = prepareEvaluationSeriesPlan(series, [
      {
        runtimeKind: 'series-analysis-node',
        referenceId: 'stability',
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
      },
      {
        runtimeKind: 'series-decision-policy',
        referenceId: 'series-release-gate',
        identity: decisionIdentity,
      },
    ]);
    const result = await runEvaluationSeries(
      plan,
      [memberSource('repeat-1', 0, first)],
      {
        analysisNodesByNodeId: new Map(),
        decisionPoliciesByDecisionPolicyId: new Map(),
        schemaValidators: new Map(),
      },
      { bundleId: 'series-analysis-partial', reportId: 'series-report-partial' },
    );

    expect(result.analysis.coverage).toMatchObject({ planned: 2, missing: 1, comparable: 1 });
    expect(result.analysis.records[0]).toMatchObject({
      runtimeExecutionStatus: 'not-executed',
      analysisStatus: 'inconclusive',
      reasonCodes: ['series-comparable-members-insufficient'],
    });
    expect(result.decision).toMatchObject({
      policyExecutionStatus: 'not-executed',
      decisionStatus: 'not-decided',
      reasonCodes: ['series-coverage-or-assumption-gate-failed'],
    });
  });

  it('retains a cancelled Run in coverage without counting it as a resampling unit', async () => {
    const series = createEvaluationSeriesDefinition(definition());
    const [firstPlan, secondPlan] = await Promise.all([
      memberPlan(series, 'repeat-1', 0),
      memberPlan(series, 'repeat-2', 1),
    ]);
    const controller = new AbortController();
    controller.abort('cancel before admission');
    const [first, second] = await Promise.all([
      runConformanceScenario('function', { plan: firstPlan, suffix: 'series-complete' }),
      runConformanceScenario('function', {
        plan: secondPlan,
        suffix: 'series-cancelled',
        executionSignal: controller.signal,
      }),
    ]);
    const analysisIdentity = identity('stability.rate/v1');
    const decisionIdentity = identity('series-release-gate/v1');
    const plan = prepareEvaluationSeriesPlan(series, [
      {
        runtimeKind: 'series-analysis-node',
        referenceId: 'stability',
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
      },
      {
        runtimeKind: 'series-decision-policy',
        referenceId: 'series-release-gate',
        identity: decisionIdentity,
      },
    ]);
    const result = await runEvaluationSeries(plan, [
      memberSource('repeat-1', 0, first),
      memberSource('repeat-2', 1, second),
    ], {
      analysisNodesByNodeId: new Map(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      schemaValidators: new Map(),
    }, { bundleId: 'series-cancelled', reportId: 'series-cancelled' });

    expect(result.analysis.coverage).toMatchObject({
      planned: 2,
      completed: 1,
      cancelled: 1,
      missing: 0,
    });
    expect(result.analysis.records[0]).toMatchObject({
      memberIds: ['repeat-1'],
      runtimeExecutionStatus: 'not-executed',
      analysisStatus: 'inconclusive',
    });
    expect(result.decision).toMatchObject({
      policyExecutionStatus: 'not-executed',
      decisionStatus: 'not-decided',
    });
  });

  it('rejects aliases of the same authenticated Run', async () => {
    const input = definition();
    input.analysisMode = 'exploratory';
    const series = createEvaluationSeriesDefinition(input);
    const run = await runConformanceScenario('function', {
      suffix: 'series-duplicate-run',
    });
    const analysisIdentity = identity('stability.rate/v1');
    const decisionIdentity = identity('series-release-gate/v1');
    const plan = prepareEvaluationSeriesPlan(series, [
      {
        runtimeKind: 'series-analysis-node',
        referenceId: 'stability',
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
      },
      {
        runtimeKind: 'series-decision-policy',
        referenceId: 'series-release-gate',
        identity: decisionIdentity,
      },
    ]);

    await expect(runEvaluationSeries(plan, [
      memberSource('repeat-1', 0, run),
      memberSource('repeat-2', 1, run),
    ], {
      analysisNodesByNodeId: new Map(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      schemaValidators: seriesSchemaValidators,
    }, { bundleId: 'series-duplicate-run', reportId: 'series-duplicate-run' }))
      .rejects.toThrow('duplicate member identity');
  });

  it('turns failed assumptions into inconclusive and sanitizes Runtime failures', async () => {
    const series = createEvaluationSeriesDefinition(definition());
    const [firstPlan, secondPlan] = await Promise.all([
      memberPlan(series, 'repeat-1', 0),
      memberPlan(series, 'repeat-2', 1),
    ]);
    const [first, second] = await Promise.all([
      runConformanceScenario('function', { plan: firstPlan, suffix: 'series-assumption-1' }),
      runConformanceScenario('function', { plan: secondPlan, suffix: 'series-assumption-2' }),
    ]);
    const sources = [
      memberSource('repeat-1', 0, first),
      memberSource('repeat-2', 1, second),
    ];
    const analysisIdentity = identity('stability.rate/v1');
    const decisionIdentity = identity('series-release-gate/v1');
    const plan = prepareEvaluationSeriesPlan(series, [
      {
        runtimeKind: 'series-analysis-node',
        referenceId: 'stability',
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
      },
      {
        runtimeKind: 'series-decision-policy',
        referenceId: 'series-release-gate',
        identity: decisionIdentity,
      },
    ]);
    let decisionCalls = 0;
    const assumptionResult = await runEvaluationSeries(plan, sources, {
      analysisNodesByNodeId: new Map([['stability', {
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
        async analyze() {
          return {
            analysisStatus: 'completed' as const,
            resultType: 'scalar' as const,
            value: 1,
            assumptionChecks: [{
              assumptionId: 'minimum-runs',
              checkStatus: 'failed' as const,
              reasonCode: 'minimum-runs-not-met',
            }],
          };
        },
      }]]),
      decisionPoliciesByDecisionPolicyId: new Map([['series-release-gate', {
        identity: decisionIdentity,
        async decide() {
          decisionCalls += 1;
          return { decisionStatus: 'decided' as const, verdict: 'must-not-run' };
        },
      }]]),
      schemaValidators: seriesSchemaValidators,
    }, { bundleId: 'series-assumption', reportId: 'series-assumption' });

    expect(assumptionResult.analysis.records[0]).toMatchObject({
      runtimeExecutionStatus: 'executed',
      analysisStatus: 'inconclusive',
      reasonCodes: ['series-analysis-assumption-failed'],
    });
    expect(assumptionResult.decision).toMatchObject({
      policyExecutionStatus: 'not-executed',
      decisionStatus: 'not-decided',
    });
    expect(decisionCalls).toBe(0);

    const secret = 'must-not-cross-series-error-boundary';
    const failedDecision = await runEvaluationSeries(plan, sources, {
      analysisNodesByNodeId: new Map([['stability', {
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
        async analyze() {
          return {
            analysisStatus: 'completed' as const,
            resultType: 'scalar' as const,
            value: 1,
          };
        },
      }]]),
      decisionPoliciesByDecisionPolicyId: new Map([['series-release-gate', {
        identity: decisionIdentity,
        async decide() {
          throw {
            code: 'host-secret',
            stage: 'analysis',
            message: secret,
            details: { secret },
          };
        },
      }]]),
      schemaValidators: seriesSchemaValidators,
    }, { bundleId: 'series-failed-decision', reportId: 'series-failed-decision' });

    expect(failedDecision.decision).toMatchObject({
      policyExecutionStatus: 'executed',
      decisionStatus: 'failed',
      error: { code: 'series-decision-runtime-failed' },
    });
    expect(JSON.stringify(failedDecision)).not.toContain(secret);
  });
});
