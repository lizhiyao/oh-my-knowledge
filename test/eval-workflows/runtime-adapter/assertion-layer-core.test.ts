import { describe, expect, it } from 'vitest';
import {
  verifyAnalysisBundle,
  type RuntimeIdentity,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  prepareEvaluationPlan,
  type AnalysisRuntimeRequirement,
  type PreparationRuntime,
} from '../../../src/evaluation-core/compiler/index.js';
import {
  analyzeEvaluationBundleSource,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinMissingPolicies,
  resolveBuiltinAnalysisRuntime,
  type AnalysisNodeImplementation,
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
  ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
  createAssertionLayerAnalysisNodes,
} from '../../../src/eval-workflows/runtime-adapter/analysis/assertion-layer-node.js';
import {
  createAssertionLayerParameterSchemaValidators,
  parseAssertionLayerParameters,
  type AssertionLayerCriterionParameter,
} from '../../../src/eval-workflows/runtime-adapter/analysis/assertion-layer-parameters.js';
import {
  createAssertionLayerTableSchemaValidators,
} from '../../../src/eval-workflows/runtime-adapter/analysis/assertion-layer.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from '../../evaluation-core/compiler/fixtures.js';

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

interface Criterion extends AssertionLayerCriterionParameter {
  value: boolean;
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

function sealedCriteria(source: readonly Criterion[] = criteria) {
  return source.map((criterion) => ({
    criterionId: criterion.criterionId,
    metricId: criterion.metricId,
    layerDisposition: criterion.layerDisposition,
    weight: criterion.weight,
  }));
}

describe('assertion-layer Evaluation Core integration', () => {
  it('prepares, executes, verifies, and preserves the raw Evaluation boundary', async () => {
    const implementations = createAssertionLayerAnalysisNodes();
    const base = testRuntime({ evaluatorValueTypes: ['boolean'] });
    const schemaValidators = new Map([
      ...base.schemaValidators,
      ...createBuiltinAnalysisSchemaValidators(),
      ...createAssertionLayerParameterSchemaValidators(),
      ...createAssertionLayerTableSchemaValidators(),
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
    definition.evaluators = criteria.map((criterion) => ({
      evaluatorId: `evaluator-${criterion.criterionId}`,
      evaluatorKind: 'deterministic-assertion' as const,
      implementationId: 'assertion-fixture/v1',
      measurement: {
        instrumentId: criterion.criterionId,
        ensembleMemberId: 'deterministic',
        replicateGroupId: 'primary',
        replicateIndex: 0,
      },
      metricIds: [criterion.metricId],
      inputs: [{ bindingId: 'actual', sourceKind: 'output' as const, pointer: '/answer' }],
    }));
    definition.metrics = criteria.map((criterion) => ({
      metricId: criterion.metricId,
      valueType: 'boolean' as const,
      scope: 'sample' as const,
      direction: 'higher-is-better' as const,
      missingPolicyId: 'exclude/v1',
    }));
    definition.analysisGraph.nodes = [{
      analysisNodeKind: 'reducer',
      nodeId: 'assertion-layer-table',
      implementationId: ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
      inputs: [...criteria].reverse().map((criterion) => ({
        inputKind: 'metric-observations' as const,
        referenceId: criterion.metricId,
      })),
      outputResultId: 'assertion-layer-table',
      parameters: { criteria: sealedCriteria([...criteria].reverse()) },
    }];
    definition.comparisons[0].metricIds = criteria.map((criterion) => criterion.metricId);
    delete definition.decisionPolicy;
    const policy = validPolicy();
    delete policy.execution.timeoutMs;
    delete policy.evaluation.timeoutMs;
    policy.evidence.trace = 'none';
    policy.evidence.evidence = 'full';
    policy.retry.maxAttempts = 1;
    policy.evaluation.retry.maxAttempts = 1;
    const plan = await prepareEvaluationPlan(definition, policy, preparationRuntime);
    expect(plan.analysis.analysisGraph.nodes[0].parameters).toEqual(
      parseAssertionLayerParameters({ criteria: sealedCriteria() }),
    );

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
                  output: { value: { answer: 'Hello world' }, classification: 'public' as const },
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
    }, { runId: 'assertion-core-run', bundleId: 'assertion-execution' });

    const criterionByEvaluator = new Map(criteria.map((criterion) => [
      `evaluator-${criterion.criterionId}`,
      criterion,
    ]));
    const evaluatorPorts = new Map(plan.evaluation.evaluators.map((plannedEvaluator) => {
      const evaluatorRuntime = plan.evaluation.runtimes.find((runtime) => (
        runtime.runtimeKind === 'evaluator'
        && runtime.referenceId === plannedEvaluator.evaluatorId
      ));
      const criterion = criterionByEvaluator.get(plannedEvaluator.evaluatorId);
      if (evaluatorRuntime?.runtimeKind !== 'evaluator' || criterion === undefined) {
        throw new Error(`missing evaluator runtime ${plannedEvaluator.evaluatorId}`);
      }
      const evaluator: EvaluationEvaluator = {
        identity: structuredClone(evaluatorRuntime.identity) as RuntimeIdentity,
        async openRun() {
          return {
            async openRecord() {
              return {
                async evaluate() {
                  return {
                    observations: [{
                      metricId: criterion.metricId,
                      observationStatus: 'observed' as const,
                      valueType: 'boolean' as const,
                      value: criterion.value,
                      evidence: {
                        value: { marker: 'assertion-secret-token' },
                        classification: 'public' as const,
                      },
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
    }, { runId: 'assertion-core-run', bundleId: 'assertion-evaluation' });

    const implementation = implementations.get(ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID);
    if (implementation === undefined) throw new Error('missing assertion implementation');
    const lifecycle = { opened: 0, executed: 0, disposed: 0 };
    const observedImplementation: AnalysisNodeImplementation = {
      identity: implementation.identity,
      outputSchema: implementation.outputSchema,
      async openRun(runContext) {
        lifecycle.opened += 1;
        const run = await implementation.openRun(runContext);
        return {
          async execute(nodeContext) {
            lifecycle.executed += 1;
            return run.execute(nodeContext);
          },
          async dispose() {
            lifecycle.disposed += 1;
            await run.dispose();
          },
        };
      },
    };
    const analysis = await analyzeEvaluationBundleSource(plan, execution, evaluation, {
      analysisNodesByNodeId: new Map([['assertion-layer-table', observedImplementation]]),
      schemaValidators,
      missingPoliciesByPolicyId: createBuiltinMissingPolicies(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      clock,
      eventSequencer,
    }, { runId: 'assertion-core-run', bundleId: 'assertion-analysis' });

    expect(() => verifyAnalysisBundle(
      analysis.bundle,
      plan,
      execution,
      evaluation,
      { schemaValidators },
    )).not.toThrow();
    expect(analysis.bundle.analysisBundleStatus).toBe('completed');
    expect(lifecycle).toEqual({ opened: 1, executed: 1, disposed: 1 });
    const record = analysis.bundle.records[0];
    expect(record.analysisStatus).toBe('completed');
    if (record.analysisStatus !== 'completed') return;
    expect(record.value).toMatchObject({
      groups: expect.arrayContaining([expect.objectContaining({
        layers: {
          fact: expect.objectContaining({ layerStatus: 'observed', score: 3.29 }),
          behavior: expect.objectContaining({ layerStatus: 'observed', score: 5 }),
        },
      })]),
    });
    expect(JSON.stringify(evaluation.bundle)).toContain('assertion-secret-token');
    expect(JSON.stringify(evaluation.bundle)).toContain('providerCost');
    expect(JSON.stringify(analysis.bundle)).not.toContain('assertion-secret-token');
    expect(JSON.stringify(analysis.bundle)).not.toContain('providerCost');
    expect(JSON.stringify(analysis.bundle)).not.toContain('inputTokens');
  });
});
