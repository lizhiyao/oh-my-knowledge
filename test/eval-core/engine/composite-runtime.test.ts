import { describe, expect, it } from 'vitest';
import {
  createEvaluationEngine,
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
  resolveBuiltinAnalysisRuntime,
  type SealedRunPlan,
  type EvaluationEngineRuntime,
  type EvaluationEvent,
  type EvaluationRunResult,
  type Evaluator,
  type Executor,
  type RuntimeResolution,
  type RuntimeIdentity,
} from '../../../src/eval-core/index.js';
import { prepareEvaluationPlan } from '../../../src/eval-core/compiler/index.js';
import { testRuntime, validDefinition, validPolicy } from '../compiler/fixtures.js';

class Clock {
  #elapsed = 0;
  #timestamps = 0;

  monotonicNow(): number { return this.#elapsed; }

  timestamp(): string {
    const value = new Date(Date.UTC(2026, 8, 5) + this.#timestamps).toISOString();
    this.#timestamps += 1;
    return value;
  }

  async sleep(delayMs: number): Promise<void> { this.#elapsed += delayMs; }
}

function runtimeIdentity(
  plan: SealedRunPlan,
  runtimeKind: 'executor' | 'evaluator',
  referenceId: string,
): RuntimeIdentity {
  const runtimes = runtimeKind === 'executor'
    ? plan.execution.runtimes
    : plan.evaluation.runtimes;
  const resolved = runtimes.find((candidate) => (
    candidate.runtimeKind === runtimeKind && candidate.referenceId === referenceId
  ));
  if (resolved === undefined) throw new Error(`Missing ${runtimeKind} ${referenceId}.`);
  return structuredClone(resolved.identity) as RuntimeIdentity;
}

function executor(identity: RuntimeIdentity): Executor {
  return {
    identity,
    async openRun() {
      return {
        async openTrial() {
          return {
            async execute() {
              return {
                output: { value: { answer: 'A' }, classification: 'public' as const },
              };
            },
            dispose() {},
          };
        },
        dispose() {},
      };
    },
  };
}

function evaluator(
  identity: RuntimeIdentity,
  evaluatorId: string,
  latencyValue?: number,
): Evaluator {
  return {
    identity,
    async openRun() {
      return {
        async openRecord(context) {
          return {
            async evaluate() {
              return evaluatorId === 'exact' ? {
                observations: [{
                  metricId: 'correct',
                  observationStatus: 'observed' as const,
                  valueType: 'boolean' as const,
                  value: true,
                }],
              } : {
                observations: [{
                  metricId: 'latency-ms',
                  observationStatus: 'observed' as const,
                  valueType: 'numeric' as const,
                  value: latencyValue ?? (context.targetId === 'control' ? 80 : 20),
                }],
              };
            },
            dispose() {},
          };
        },
        dispose() {},
      };
    },
  };
}

type CompositeScenario = 'quality' | 'paired-difference' | 'unpaired-difference' | 'invalid';

async function fixture(scenario: CompositeScenario = 'quality'): Promise<{
  runtime: EvaluationEngineRuntime;
  definition: ReturnType<typeof validDefinition>;
  policy: ReturnType<typeof validPolicy>;
}> {
  const definition = validDefinition();
  definition.dataset.samples = Array.from(
    { length: scenario === 'unpaired-difference' ? 6 : 2 },
    (_, index) => ({
      ...structuredClone(definition.dataset.samples[0]),
      sampleId: `sample-${index + 1}`,
      input: { question: 'Q', pair: `pair-${index + 1}` },
    }),
  );
  definition.evaluators.push({
    evaluatorId: 'latency',
    evaluatorKind: 'custom',
    implementationId: 'latency/v1',
    measurement: {
      instrumentId: 'latency-v1',
      ensembleMemberId: 'latency-local',
      replicateGroupId: 'latency-primary',
      replicateIndex: 0,
    },
    metricIds: ['latency-ms'],
    inputs: [{ bindingId: 'facts', sourceKind: 'execution-facts', pointer: '' }],
  });
  definition.metrics.push({
    metricId: 'latency-ms',
    valueType: 'numeric',
    scope: 'sample',
    scale: { min: 0, max: 100 },
    unit: 'ms',
    direction: 'lower-is-better',
    missingPolicyId: 'exclude/v1',
  }, {
    metricId: 'overall-quality',
    valueType: 'numeric',
    scope: 'sample',
    scale: { min: 0, max: 1 },
    unit: 'utility',
    direction: 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  });
  const implementationId = scenario === 'paired-difference'
    ? 'bootstrap.composite-paired-difference-percentile/v1'
    : scenario === 'unpaired-difference'
      ? 'bootstrap.composite-unpaired-difference-percentile/v1'
      : 'bootstrap.composite-mean-percentile/v1';
  if (scenario === 'paired-difference') {
    definition.experiment.sampling = {
      experimentalUnit: 'sample',
      repeatedMeasures: true,
      resamplingUnit: 'paired-block',
      estimatorId: implementationId,
      seedCoupling: 'shared-within-block',
      pairingKey: '/input/pair',
    };
  } else if (scenario === 'unpaired-difference') {
    definition.experiment.assignment = {
      assignmentKind: 'independent-groups',
      algorithmId: 'assignment.stratified-fixed-quota/v1',
      allocations: [
        { randomizationSlotId: 'slot-control', weight: 1 },
        { randomizationSlotId: 'slot-treatment', weight: 1 },
      ],
      minimumUnitsPerTarget: 2,
      minimumUnitsPerTargetPerStratum: 1,
    };
    definition.experiment.sampling = {
      experimentalUnit: 'sample',
      repeatedMeasures: false,
      resamplingUnit: 'sample',
      estimatorId: implementationId,
      seedCoupling: 'independent-by-target',
    };
  } else {
    definition.experiment.sampling.estimatorId = implementationId;
  }
  if (scenario === 'paired-difference' || scenario === 'unpaired-difference') {
    definition.comparisons[0].metricIds.push('overall-quality');
  }
  definition.analysisGraph.nodes = [{
    analysisNodeKind: 'estimator',
    nodeId: 'overall-quality',
    implementationId,
    inputs: [
      { inputKind: 'metric-observations', referenceId: 'correct' },
      { inputKind: 'metric-observations', referenceId: 'latency-ms' },
      ...(scenario === 'paired-difference' || scenario === 'unpaired-difference' ? [{
        inputKind: 'comparison' as const,
        referenceId: 'control-vs-treatment',
        treatmentTargetId: 'treatment',
        metricId: 'overall-quality',
      }] : []),
    ],
    outputResultId: 'overall-quality-result',
    ...(scenario === 'paired-difference' || scenario === 'unpaired-difference'
      ? {}
      : { targetFilter: { includeTargetIds: ['treatment'] } }),
    parameters: {
      compositeMetricId: 'overall-quality',
      components: [
        { metricId: 'correct', weight: 0.5 },
        { metricId: 'latency-ms', weight: 0.5 },
      ],
      aggregation: { method: 'weighted-mean', missing: 'require-complete' },
      resamples: 64,
      alpha: 0.1,
    },
  }];
  definition.decisionPolicy = {
    decisionPolicyId: 'release-gate',
    implementationId: 'progress/v2',
    analysisResultIds: ['overall-quality-result'],
    minimumEvidenceStatus: 'complete',
    parameters: {
      threshold: scenario === 'paired-difference' || scenario === 'unpaired-difference' ? 0 : 0.5,
      equivalence: 0,
    },
  };
  const policy = validPolicy();
  policy.retry.maxAttempts = 1;
  policy.evaluation.retry.maxAttempts = 1;
  delete policy.execution.timeoutMs;
  delete policy.evaluation.timeoutMs;
  policy.evidence.trace = 'none';

  const base = testRuntime({
    evaluatorValueTypes: ['boolean', 'numeric'],
    samplingAssignmentKinds: scenario === 'unpaired-difference'
      ? ['independent-groups']
      : ['complete-block'],
    samplingResamplingUnits: scenario === 'paired-difference'
      ? ['paired-block']
      : ['sample'],
  });
  const analysisNodes = createBuiltinAnalysisNodes();
  const missingPolicies = createBuiltinMissingPolicies();
  const decisionPolicies = createBuiltinDecisionPolicies();
  const schemaValidators = new Map([
    ...base.schemaValidators,
    ...createBuiltinAnalysisSchemaValidators(),
  ]);
  const plan = await prepareEvaluationPlan(definition, policy, {
    schemaValidators,
    resolveExecutor: (requirement) => base.resolveExecutor(requirement),
    resolveEvaluator: (requirement) => base.resolveEvaluator(requirement),
    resolveAnalysis(requirement) {
      const resolution = resolveBuiltinAnalysisRuntime(requirement);
      if (resolution === undefined) throw new Error('Missing built-in Analysis Runtime.');
      return resolution;
    },
  });
  return {
    definition,
    policy,
    runtime: {
      bindings: {
        resolveExecutor(requirement) {
          const identity = runtimeIdentity(plan, 'executor', requirement.referenceId);
          const resolution: RuntimeResolution = {
            identity,
            satisfiesVersionConstraint: true,
          };
          return {
            runtimeKind: 'executor',
            resolution,
            port: executor(identity),
          };
        },
        resolveEvaluator(requirement) {
          const identity = runtimeIdentity(plan, 'evaluator', requirement.referenceId);
          const resolution: RuntimeResolution = {
            identity,
            satisfiesVersionConstraint: true,
          };
          return {
            runtimeKind: 'evaluator',
            resolution,
            port: evaluator(
              identity,
              requirement.referenceId,
              scenario === 'invalid' ? 101 : undefined,
            ),
          };
        },
        resolveAnalysis(requirement) {
          const resolution = resolveBuiltinAnalysisRuntime(requirement);
          if (resolution === undefined) throw new Error('Missing built-in Analysis Runtime.');
          if (requirement.requirementKind === 'missing-policy') {
            return {
              runtimeKind: 'missing-policy',
              resolution,
              port: missingPolicies.get(requirement.implementationId)!,
            };
          }
          if (requirement.requirementKind === 'decision-policy') {
            return {
              runtimeKind: 'decision-policy',
              resolution,
              port: decisionPolicies.get(requirement.implementationId)!,
            };
          }
          return {
            runtimeKind: 'analysis-node',
            resolution,
            port: analysisNodes.get(requirement.implementationId)!,
          };
        },
      },
      clock: new Clock(),
      schemaValidators,
    },
  };
}

async function consume(run: {
  events: AsyncIterable<EvaluationEvent>;
  result: Promise<EvaluationRunResult>;
}): Promise<EvaluationRunResult> {
  const consuming = (async () => {
    for await (const event of run.events) void event;
  })();
  const result = await run.result;
  await consuming;
  return result;
}

describe('composite Evaluation Engine conformance', () => {
  it('runs prepare through Decision with recomputable interval and source-row lineage', async () => {
    const test = await fixture();
    const result = await consume(createEvaluationEngine(test.runtime).start(
      test.definition,
      { policy: test.policy, runId: 'composite-run' },
    ));

    if (result.status === 'failed') {
      throw new Error(`Expected completed composite run: ${JSON.stringify(result, null, 2)}`);
    }
    expect(result.status).toBe('completed');
    const record = result.artifacts.analysis.records[0];
    if (record?.analysisStatus !== 'completed') {
      throw new Error(JSON.stringify({
        evaluation: result.artifacts.evaluation.records,
        analysis: record,
      }, null, 2));
    }
    expect(record).toMatchObject({
      analysisStatus: 'completed',
      resultType: 'interval',
      value: { estimate: 0.9, unitCount: 2 },
      coverage: { planned: 4, included: 4, comparable: 4 },
      assumptionChecks: [{
        assumptionId: 'sufficient-resampling-units',
        checkStatus: 'passed',
      }, {
        assumptionId: 'composite-require-complete',
        checkStatus: 'passed',
        details: {
          unitKind: 'target-sample-trial', planned: 2, complete: 2, missing: 0,
        },
      }],
    });
    expect(result.artifacts.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
      analysisResultIds: ['overall-quality-result'],
    });
  });

  it.each([
    ['paired-difference', 2],
    ['unpaired-difference', 6],
  ] as const)('runs %s through canonical comparison materialization', async (scenario, unitCount) => {
    const test = await fixture(scenario);
    const result = await consume(createEvaluationEngine(test.runtime).start(
      test.definition,
      { policy: test.policy, runId: `composite-${scenario}` },
    ));

    if (result.status === 'failed') {
      throw new Error(`Expected completed composite comparison: ${JSON.stringify(result, null, 2)}`);
    }
    const record = result.artifacts.analysis.records[0];
    expect(record).toMatchObject({
      analysisStatus: 'completed',
      resultType: 'interval',
      value: { unitCount },
      coverage: {
        included: scenario === 'paired-difference' ? 8 : 12,
        comparable: scenario === 'paired-difference' ? 8 : 12,
      },
    });
    if (record.analysisStatus !== 'completed' || record.resultType !== 'interval'
        || record.value === null || Array.isArray(record.value)
        || typeof record.value !== 'object') throw new Error('Expected completed interval.');
    expect((record.value as { estimate: number }).estimate).toBeCloseTo(0.3);
    expect(result.artifacts.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
    });
  });

  it('excludes invalid source observations and preserves composite coordinate coverage', async () => {
    const test = await fixture('invalid');
    const result = await consume(createEvaluationEngine(test.runtime).start(
      test.definition,
      { policy: test.policy, runId: 'composite-invalid' },
    ));

    if (result.status === 'failed') {
      throw new Error(`Expected inconclusive composite run: ${JSON.stringify(result, null, 2)}`);
    }
    expect(result.artifacts.analysis.records[0]).toMatchObject({
      analysisStatus: 'inconclusive',
      reasonCodes: ['analysis-insufficient-resampling-units'],
      coverage: {
        planned: 4, observed: 2, invalid: 2, included: 0, comparable: 0, excluded: 4,
      },
      assumptionChecks: [{
        assumptionId: 'sufficient-units',
        checkStatus: 'failed',
        reasonCode: 'analysis-insufficient-resampling-units',
      }, {
        assumptionId: 'composite-require-complete',
        checkStatus: 'passed',
        details: {
          unitKind: 'target-sample-trial', planned: 2, complete: 0, missing: 2,
        },
      }],
    });
  });
});
