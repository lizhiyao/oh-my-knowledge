import { describe, expect, it } from 'vitest';
import {
  EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION,
  createEvaluationSeriesDefinition,
  createEvaluationSeriesMemberSource,
  digestCanonicalJson,
  prepareEvaluationSeriesPlan,
  runEvaluationSeries,
  startEvaluationSeries,
  schemaIdentityKey,
  type EvaluationSeriesDefinition,
  type EvaluationSeriesDefinitionInput,
  type EvaluationSeriesMemberSource,
  type EvaluationSeriesRunResult,
  type CompletedEvaluationSeriesRunResult,
  type RuntimeIdentity,
} from '../../../src/eval-core/index.js';
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

const seriesClock = Object.freeze({
  timestamp: () => '2026-01-01T00:00:00.000Z',
});

function completed(
  result: EvaluationSeriesRunResult,
): CompletedEvaluationSeriesRunResult {
  expect(result.status).toBe('completed');
  if (result.status !== 'completed') throw new Error('Expected completed Series result.');
  return result;
}

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

async function lifecycleFixture() {
  const series = createEvaluationSeriesDefinition(definition());
  const [firstPlan, secondPlan] = await Promise.all([
    memberPlan(series, 'repeat-1', 0),
    memberPlan(series, 'repeat-2', 1),
  ]);
  const [first, second] = await Promise.all([
    runConformanceScenario('function', { plan: firstPlan, suffix: 'series-lifecycle-1' }),
    runConformanceScenario('function', { plan: secondPlan, suffix: 'series-lifecycle-2' }),
  ]);
  const analysisIdentity = identity('stability.rate/v1');
  const decisionIdentity = identity('series-release-gate/v1');
  return {
    plan: prepareEvaluationSeriesPlan(series, [
      {
        runtimeKind: 'series-analysis-node' as const,
        referenceId: 'stability',
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
      },
      {
        runtimeKind: 'series-decision-policy' as const,
        referenceId: 'series-release-gate',
        identity: decisionIdentity,
      },
    ]),
    sources: [
      memberSource('repeat-1', 0, first),
      memberSource('repeat-2', 1, second),
    ],
    analysisIdentity,
    decisionIdentity,
  };
}

async function collectEvents(events: AsyncIterable<{ eventKind: string; sequence: number }>) {
  const collected: Array<{ eventKind: string; sequence: number }> = [];
  for await (const event of events) collected.push(event);
  return collected;
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
    const result = completed(await runEvaluationSeries(plan, [], {
      analysisNodesByNodeId: new Map(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      schemaValidators: new Map(),
      clock: seriesClock,
    }, {
      runId: 'series-all-missing',
      bundleId: 'series-all-missing',
      reportId: 'series-all-missing',
    }));

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
        clock: seriesClock,
      },
      { runId: 'series-unbound', bundleId: 'series-unbound', reportId: 'series-unbound' },
    )).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'series-run-configuration-invalid', stage: 'configuration' },
    });
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
    const result = completed(await runEvaluationSeries(
      plan,
      memberInputs,
      {
        analysisNodesByNodeId: new Map([['stability', {
          identity: analysisIdentity,
          outputSchema: seriesOutputSchema,
          async openRun() {
            return {
              async analyze(context) {
                return {
                  analysisStatus: 'completed' as const,
                  resultType: 'scalar' as const,
                  value: context.members.length / context.coverage.planned,
                  assumptionChecks: [{
                    assumptionId: 'minimum-runs',
                    checkStatus: 'passed' as const,
                  }],
                };
              },
              dispose() {},
            };
          },
        }]]),
        decisionPoliciesByDecisionPolicyId: new Map([['series-release-gate', {
          identity: decisionIdentity,
          async openRun() {
            return {
              async decide() {
                return {
                  decisionStatus: 'decided' as const,
                  verdict: 'stable',
                  reasonCodes: ['stability-gate-passed'],
                };
              },
              dispose() {},
            };
          },
        }]]),
        schemaValidators: seriesSchemaValidators,
        clock: seriesClock,
      },
      { runId: 'series-run-1', bundleId: 'series-analysis-1', reportId: 'series-report-1' },
    ));

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
      reasonCodes: ['stability-gate-passed'],
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
    const result = completed(await runEvaluationSeries(
      plan,
      [memberSource('repeat-1', 0, first)],
      {
        analysisNodesByNodeId: new Map(),
        decisionPoliciesByDecisionPolicyId: new Map(),
        schemaValidators: new Map(),
        clock: seriesClock,
      },
      {
        runId: 'series-run-partial',
        bundleId: 'series-analysis-partial',
        reportId: 'series-report-partial',
      },
    ));

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
    const result = completed(await runEvaluationSeries(plan, [
      memberSource('repeat-1', 0, first),
      memberSource('repeat-2', 1, second),
    ], {
      analysisNodesByNodeId: new Map(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      schemaValidators: new Map(),
      clock: seriesClock,
    }, {
      runId: 'series-member-cancelled',
      bundleId: 'series-cancelled',
      reportId: 'series-cancelled',
    }));

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
      clock: seriesClock,
    }, {
      runId: 'series-duplicate-run',
      bundleId: 'series-duplicate-run',
      reportId: 'series-duplicate-run',
    })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'series-run-configuration-invalid', stage: 'configuration' },
    });
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
    const assumptionResult = completed(await runEvaluationSeries(plan, sources, {
      analysisNodesByNodeId: new Map([['stability', {
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
        async openRun() {
          return {
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
            dispose() {},
          };
        },
      }]]),
      decisionPoliciesByDecisionPolicyId: new Map([['series-release-gate', {
        identity: decisionIdentity,
        async openRun() {
          return {
            async decide() {
              decisionCalls += 1;
              return {
                decisionStatus: 'decided' as const,
                verdict: 'must-not-run',
                reasonCodes: ['test-policy-ran'],
              };
            },
            dispose() {},
          };
        },
      }]]),
      schemaValidators: seriesSchemaValidators,
      clock: seriesClock,
    }, {
      runId: 'series-assumption',
      bundleId: 'series-assumption',
      reportId: 'series-assumption',
    }));

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
    const failedDecision = completed(await runEvaluationSeries(plan, sources, {
      analysisNodesByNodeId: new Map([['stability', {
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
        async openRun() {
          return {
            async analyze() {
              return {
                analysisStatus: 'completed' as const,
                resultType: 'scalar' as const,
                value: 1,
              };
            },
            dispose() {},
          };
        },
      }]]),
      decisionPoliciesByDecisionPolicyId: new Map([['series-release-gate', {
        identity: decisionIdentity,
        async openRun() {
          return {
            async decide() {
              throw {
                code: 'host-secret',
                stage: 'analysis',
                message: secret,
                details: { secret },
              };
            },
            dispose() {},
          };
        },
      }]]),
      schemaValidators: seriesSchemaValidators,
      clock: seriesClock,
    }, {
      runId: 'series-failed-decision',
      bundleId: 'series-failed-decision',
      reportId: 'series-failed-decision',
    }));

    expect(failedDecision.decision).toMatchObject({
      policyExecutionStatus: 'executed',
      decisionStatus: 'failed',
      error: { code: 'series-decision-runtime-failed' },
    });
    expect(JSON.stringify(failedDecision)).not.toContain(secret);
  });

  it('publishes ordered bounded events without requiring a live consumer', async () => {
    const fixture = await lifecycleFixture();
    let analysisDisposals = 0;
    let decisionDisposals = 0;
    let writerCalls = 0;
    const analysisNodesByNodeId = new Map([['stability', {
        identity: fixture.analysisIdentity,
        outputSchema: seriesOutputSchema,
        async openRun() {
          return {
            async analyze() {
              return {
                analysisStatus: 'completed' as const,
                resultType: 'scalar' as const,
                value: 1,
              };
            },
            dispose() { analysisDisposals += 1; },
          };
        },
      }]]);
    const decisionPoliciesByDecisionPolicyId = new Map([['series-release-gate', {
        identity: fixture.decisionIdentity,
        async openRun() {
          return {
            async decide() {
              return {
                decisionStatus: 'decided' as const,
                verdict: 'stable',
                reasonCodes: ['stability-gate-passed'],
              };
            },
            dispose() { decisionDisposals += 1; },
          };
        },
      }]]);
    const validator = {
      schema: structuredClone(seriesOutputSchema),
      parse(value: unknown) { return value as never; },
    };
    const validators = new Map([[schemaIdentityKey(seriesOutputSchema), validator]]);
    const run = startEvaluationSeries(fixture.plan, fixture.sources, {
      analysisNodesByNodeId,
      decisionPoliciesByDecisionPolicyId,
      schemaValidators: validators,
      clock: seriesClock,
    }, {
      runId: 'series-events',
      bundleId: 'series-events-bundle',
      reportId: 'series-events-report',
      eventBufferCapacity: 16,
      eventWriter: {
        async write() {
          writerCalls += 1;
          throw new Error('best-effort writer unavailable');
        },
      },
    });
    analysisNodesByNodeId.clear();
    decisionPoliciesByDecisionPolicyId.clear();
    validators.clear();
    validator.schema.schemaVersion = 'mutated-after-series-start';
    validator.parse = () => { throw new Error('mutated validator must not run'); };

    const result = completed(await run.result);
    const events = await collectEvents(run.events);

    expect(result.report.reportId).toBe('series-events-report');
    expect(writerCalls).toBe(1);
    expect(analysisDisposals).toBe(1);
    expect(decisionDisposals).toBe(1);
    expect(events.map(({ eventKind }) => eventKind)).toEqual([
      'series.run.started',
      'series.analysis-node.started',
      'series.analysis-node.completed',
      'series.decision.started',
      'series.decision.completed',
      'series.run.completed',
    ]);
    expect(events.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps event clock failures observational', async () => {
    const fixture = await lifecycleFixture();
    const run = startEvaluationSeries(fixture.plan, [], {
      analysisNodesByNodeId: new Map(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      schemaValidators: new Map(),
      clock: { timestamp: () => 'invalid-timestamp' },
    }, {
      runId: 'series-event-clock-failed',
      bundleId: 'series-event-clock-failed-bundle',
      reportId: 'series-event-clock-failed-report',
    });

    const result = completed(await run.result);
    expect(result.analysis.coverage.missing).toBe(2);
    await expect(collectEvents(run.events)).resolves.toEqual([]);
  });

  it('cancels before opening Runtime sessions and emits a terminal event', async () => {
    const fixture = await lifecycleFixture();
    const controller = new AbortController();
    controller.abort('cancel before Series start');
    const run = startEvaluationSeries(fixture.plan, fixture.sources, {
      analysisNodesByNodeId: new Map(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      schemaValidators: seriesSchemaValidators,
      clock: seriesClock,
    }, {
      runId: 'series-pre-cancelled',
      bundleId: 'series-pre-cancelled-bundle',
      reportId: 'series-pre-cancelled-report',
      signal: controller.signal,
    });

    await expect(run.result).resolves.toEqual({ status: 'cancelled' });
    await expect(collectEvents(run.events)).resolves.toMatchObject([
      { eventKind: 'series.run.started', sequence: 0 },
      { eventKind: 'series.run.cancelled', sequence: 1 },
    ]);
  });

  it('propagates in-flight cancellation and disposes only the opened Analysis session', async () => {
    const fixture = await lifecycleFixture();
    const controller = new AbortController();
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let analysisDisposals = 0;
    let decisionOpens = 0;
    const run = startEvaluationSeries(fixture.plan, fixture.sources, {
      analysisNodesByNodeId: new Map([['stability', {
        identity: fixture.analysisIdentity,
        outputSchema: seriesOutputSchema,
        async openRun() {
          return {
            async analyze({ signal }) {
              enteredResolve?.();
              await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
              });
              return {
                analysisStatus: 'completed' as const,
                resultType: 'scalar' as const,
                value: 1,
              };
            },
            dispose() { analysisDisposals += 1; },
          };
        },
      }]]),
      decisionPoliciesByDecisionPolicyId: new Map([['series-release-gate', {
        identity: fixture.decisionIdentity,
        async openRun() {
          decisionOpens += 1;
          return {
            async decide() {
              return { decisionStatus: 'not-decided' as const, reasonCodes: ['not-reached'] };
            },
            dispose() {},
          };
        },
      }]]),
      schemaValidators: seriesSchemaValidators,
      clock: seriesClock,
    }, {
      runId: 'series-analysis-cancelled',
      bundleId: 'series-analysis-cancelled-bundle',
      reportId: 'series-analysis-cancelled-report',
      signal: controller.signal,
    });

    await entered;
    controller.abort('cancel Analysis');
    await expect(run.result).resolves.toEqual({ status: 'cancelled' });
    expect(analysisDisposals).toBe(1);
    expect(decisionOpens).toBe(0);
    const events = await collectEvents(run.events);
    expect(events.at(-1)?.eventKind).toBe('series.run.cancelled');
  });

  it('retains completed Analysis when cancellation interrupts Decision', async () => {
    const fixture = await lifecycleFixture();
    const controller = new AbortController();
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let analysisDisposals = 0;
    let decisionDisposals = 0;
    const run = startEvaluationSeries(fixture.plan, fixture.sources, {
      analysisNodesByNodeId: new Map([['stability', {
        identity: fixture.analysisIdentity,
        outputSchema: seriesOutputSchema,
        async openRun() {
          return {
            async analyze() {
              return {
                analysisStatus: 'completed' as const,
                resultType: 'scalar' as const,
                value: 1,
              };
            },
            dispose() { analysisDisposals += 1; },
          };
        },
      }]]),
      decisionPoliciesByDecisionPolicyId: new Map([['series-release-gate', {
        identity: fixture.decisionIdentity,
        async openRun() {
          return {
            async decide({ signal }) {
              enteredResolve?.();
              await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
              });
              return {
                decisionStatus: 'decided' as const,
                verdict: 'must-not-publish',
                reasonCodes: ['cancelled-decision'],
              };
            },
            dispose() { decisionDisposals += 1; },
          };
        },
      }]]),
      schemaValidators: seriesSchemaValidators,
      clock: seriesClock,
    }, {
      runId: 'series-decision-cancelled',
      bundleId: 'series-decision-cancelled-bundle',
      reportId: 'series-decision-cancelled-report',
      signal: controller.signal,
    });

    await entered;
    controller.abort('cancel Decision');
    const result = await run.result;
    expect(result.status).toBe('cancelled');
    expect(result.analysis?.bundleId).toBe('series-decision-cancelled-bundle');
    expect(result.decision).toBeUndefined();
    expect(analysisDisposals).toBe(1);
    expect(decisionDisposals).toBe(1);
  });

  it('isolates concurrent Series sessions and cancellation ownership', async () => {
    const fixture = await lifecycleFixture();
    const cancelledController = new AbortController();
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const opens: string[] = [];
    const disposals: string[] = [];
    const analysisRuntime = {
      identity: fixture.analysisIdentity,
      outputSchema: seriesOutputSchema,
      async openRun({ runId }: { runId: string }) {
        opens.push(runId);
        return {
          async analyze({ signal }: { signal: AbortSignal }) {
            if (runId === 'series-concurrent-cancelled') {
              await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
                enteredResolve?.();
              });
            }
            return {
              analysisStatus: 'completed' as const,
              resultType: 'scalar' as const,
              value: 1,
            };
          },
          dispose() { disposals.push(runId); },
        };
      },
    };
    const decisionRuntime = {
      identity: fixture.decisionIdentity,
      async openRun() {
        return {
          async decide() {
            return {
              decisionStatus: 'decided' as const,
              verdict: 'stable',
              reasonCodes: ['stability-gate-passed'],
            };
          },
          dispose() {},
        };
      },
    };
    const ports = {
      analysisNodesByNodeId: new Map([['stability', analysisRuntime]]),
      decisionPoliciesByDecisionPolicyId: new Map([['series-release-gate', decisionRuntime]]),
      schemaValidators: seriesSchemaValidators,
      clock: seriesClock,
    };
    const cancelled = startEvaluationSeries(fixture.plan, fixture.sources, ports, {
      runId: 'series-concurrent-cancelled',
      bundleId: 'series-concurrent-cancelled-bundle',
      reportId: 'series-concurrent-cancelled-report',
      signal: cancelledController.signal,
    });
    const completedRun = startEvaluationSeries(fixture.plan, fixture.sources, ports, {
      runId: 'series-concurrent-completed',
      bundleId: 'series-concurrent-completed-bundle',
      reportId: 'series-concurrent-completed-report',
    });

    await entered;
    cancelledController.abort('cancel only one Series run');
    const [cancelledResult, completedResult] = await Promise.all([
      cancelled.result,
      completedRun.result,
    ]);

    expect(cancelledResult.status).toBe('cancelled');
    expect(completedResult.status).toBe('completed');
    expect(opens.sort()).toEqual([
      'series-concurrent-cancelled',
      'series-concurrent-completed',
    ]);
    expect(disposals.sort()).toEqual(opens);
  });

  it('fails the run on resource disposal failure without leaking host details', async () => {
    const fixture = await lifecycleFixture();
    const secret = 'series-dispose-secret';
    const controller = new AbortController();
    const run = startEvaluationSeries(fixture.plan, fixture.sources, {
      analysisNodesByNodeId: new Map([['stability', {
        identity: fixture.analysisIdentity,
        outputSchema: seriesOutputSchema,
        async openRun() {
          return {
            async analyze() {
              controller.abort('dispose failure must take precedence');
              return {
                analysisStatus: 'completed' as const,
                resultType: 'scalar' as const,
                value: 1,
              };
            },
            dispose() { throw new Error(secret); },
          };
        },
      }]]),
      decisionPoliciesByDecisionPolicyId: new Map(),
      schemaValidators: seriesSchemaValidators,
      clock: seriesClock,
    }, {
      runId: 'series-dispose-failed',
      bundleId: 'series-dispose-failed-bundle',
      reportId: 'series-dispose-failed-report',
      signal: controller.signal,
    });

    const result = await run.result;
    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'series-analysis-runtime-dispose-failed',
        stage: 'infrastructure',
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    const events = await collectEvents(run.events);
    expect(events.at(-1)?.eventKind).toBe('series.run.failed');
  });

  it('keeps completed Analysis when Decision resource disposal fails', async () => {
    const fixture = await lifecycleFixture();
    const run = startEvaluationSeries(fixture.plan, fixture.sources, {
      analysisNodesByNodeId: new Map([['stability', {
        identity: fixture.analysisIdentity,
        outputSchema: seriesOutputSchema,
        async openRun() {
          return {
            async analyze() {
              return {
                analysisStatus: 'completed' as const,
                resultType: 'scalar' as const,
                value: 1,
              };
            },
            dispose() {},
          };
        },
      }]]),
      decisionPoliciesByDecisionPolicyId: new Map([['series-release-gate', {
        identity: fixture.decisionIdentity,
        async openRun() {
          return {
            async decide() {
              return {
                decisionStatus: 'decided' as const,
                verdict: 'must-not-publish',
                reasonCodes: ['decision-dispose-failed'],
              };
            },
            dispose() { throw new Error('decision dispose secret'); },
          };
        },
      }]]),
      schemaValidators: seriesSchemaValidators,
      clock: seriesClock,
    }, {
      runId: 'series-decision-dispose-failed',
      bundleId: 'series-decision-dispose-failed-bundle',
      reportId: 'series-decision-dispose-failed-report',
    });

    const result = await run.result;
    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'series-decision-runtime-dispose-failed',
        stage: 'infrastructure',
      },
      analysis: { bundleId: 'series-decision-dispose-failed-bundle' },
    });
    expect(result.decision).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('decision dispose secret');
  });
});
