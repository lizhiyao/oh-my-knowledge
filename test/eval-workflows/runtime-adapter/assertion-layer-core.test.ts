import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOTSTRAP_SEED } from '../../../src/shared/statistics/bootstrap.js';
import {
  canonicalizeJson,
  schemaIdentityKey,
  verifyAnalysisBundle,
  type RuntimeIdentity,
} from '../../../src/eval-core/contracts/index.js';
import {
  prepareEvaluationPlan,
  type AnalysisRuntimeRequirement,
  type PreparationRuntime,
} from '../../../src/eval-core/compiler/index.js';
import {
  analyzeEvaluationBundleSource,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinMissingPolicies,
  resolveBuiltinAnalysisRuntime,
  type AnalysisNodeImplementation,
  type AnalysisNodeRunContext,
} from '../../../src/eval-core/analysis/index.js';
import {
  executeRunPlanSource,
  InMemoryRuntimeEventSequencer,
  type ExecutionClock,
  type ExecutionExecutor,
} from '../../../src/eval-core/execution/index.js';
import {
  evaluateExecutionBundleSource,
  type EvaluationEvaluator,
} from '../../../src/eval-core/evaluation/index.js';
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
  COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
  createCompositeAnalysisNodes,
} from '../../../src/eval-workflows/runtime-adapter/analysis/composite-node.js';
import {
  createCompositeParameterSchemaValidators,
} from '../../../src/eval-workflows/runtime-adapter/analysis/composite-parameters.js';
import {
  createCompositeTableSchemaValidators,
} from '../../../src/eval-workflows/runtime-adapter/analysis/composite-table.js';
import {
  BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
  createBootstrapFamilyAnalysisNodes,
} from '../../../src/eval-workflows/runtime-adapter/analysis/bootstrap-family-node.js';
import {
  createBootstrapFamilyParameterSchemaValidators,
} from '../../../src/eval-workflows/runtime-adapter/analysis/bootstrap-family-parameters.js';
import {
  createBootstrapFamilyTableSchemaValidators,
} from '../../../src/eval-workflows/runtime-adapter/analysis/bootstrap-family-table.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from '../../eval-core/compiler/fixtures.js';

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
    const implementations = new Map([
      ...createAssertionLayerAnalysisNodes(),
      ...createCompositeAnalysisNodes(),
      ...createBootstrapFamilyAnalysisNodes(),
    ]);
    const base = testRuntime({ evaluatorValueTypes: ['boolean'] });
    const schemaValidators = new Map([
      ...base.schemaValidators,
      ...createBuiltinAnalysisSchemaValidators(),
      ...createAssertionLayerParameterSchemaValidators(),
      ...createAssertionLayerTableSchemaValidators(),
      ...createCompositeParameterSchemaValidators(),
      ...createCompositeTableSchemaValidators(),
      ...createBootstrapFamilyParameterSchemaValidators(),
      ...createBootstrapFamilyTableSchemaValidators(),
    ]);
    const preparationRuntime: PreparationRuntime = {
      schemaValidators,
      resolveExecutor: (requirement) => base.resolveExecutor(requirement),
      resolveEvaluator: (requirement) => base.resolveEvaluator(requirement),
      resolveAnalysis(requirement: Readonly<AnalysisRuntimeRequirement>) {
        if (requirement.requirementKind === 'analysis-node'
            || requirement.requirementKind === 'sampling-estimator') {
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
    definition.dataset.samples[0].input = {
      question: 'Q', cohort: 'a', pair: 'sample-1',
    };
    definition.experiment.sampling = {
      experimentalUnit: 'sample',
      repeatedMeasures: false,
      resamplingUnit: 'paired-block',
      estimatorId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
      seedCoupling: 'shared-within-block',
      pairingKey: '/input/pair',
    };
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
    }, {
      analysisNodeKind: 'reducer',
      nodeId: 'composite-table',
      implementationId: COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
      inputs: [{ inputKind: 'analysis-result', referenceId: 'assertion-layer-table' }],
      outputResultId: 'composite-table',
      parameters: {
        layers: [{
          layerId: 'fact', analysisResultId: 'assertion-layer-table',
          sourceKind: 'assertion-layer', selector: 'fact',
        }, {
          layerId: 'behavior', analysisResultId: 'assertion-layer-table',
          sourceKind: 'assertion-layer', selector: 'behavior',
        }],
      },
    }, {
      analysisNodeKind: 'estimator',
      nodeId: 'bootstrap-family-table',
      implementationId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
      inputs: [{ inputKind: 'analysis-result', referenceId: 'composite-table' }],
      outputResultId: 'bootstrap-family-table',
      parameters: {
        source: {
          analysisResultId: 'composite-table',
          sourceKind: 'composite',
          selector: 'aggregate',
        },
        targetIds: ['control', 'treatment'],
        sampleIds: ['sample-1'],
        comparisons: [{
          comparisonId: 'control-vs-treatment',
          controlTargetId: 'control',
          treatmentTargetId: 'treatment',
          comparisonDesign: 'paired',
        }],
        resamples: 100,
        alpha: 0.05,
        seed: DEFAULT_BOOTSTRAP_SEED,
      },
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
            async execute(nodeContext) {
              counts.executed += 1;
              return run.execute(nodeContext);
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
    for (const node of plan.analysis.analysisGraph.nodes) {
      const runtime = plan.analysis.runtimes.find((candidate) => (
        candidate.runtimeKind === 'analysis-node' && candidate.referenceId === node.nodeId
      ));
      const implementation = analysisNodesByNodeId.get(node.nodeId);
      if (runtime === undefined || implementation === undefined) {
        throw new Error(`missing sealed runtime ${node.nodeId}`);
      }
      expect(canonicalizeJson(runtime.identity)).toBe(canonicalizeJson(implementation.identity));
      expect(schemaValidators.get(schemaIdentityKey(implementation.outputSchema))).toBeDefined();
    }
    const analysis = await analyzeEvaluationBundleSource(plan, execution, evaluation, {
      analysisNodesByNodeId,
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
    expect([...lifecycle.values()]).toEqual([
      { opened: 1, executed: 1, disposed: 1 },
      { opened: 1, executed: 1, disposed: 1 },
      { opened: 1, executed: 1, disposed: 1 },
    ]);
    const record = analysis.bundle.records.find((candidate) => (
      candidate.resultId === 'assertion-layer-table'
    ));
    if (record === undefined) throw new Error('missing assertion-layer record');
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
    const compositeRecord = analysis.bundle.records.find((candidate) => (
      candidate.resultId === 'composite-table'
    ));
    expect(compositeRecord?.analysisStatus).toBe('completed');
    if (compositeRecord?.analysisStatus !== 'completed') {
      throw new Error('missing composite record');
    }
    expect(compositeRecord.coverage).toMatchObject({ planned: 0, included: 0, comparable: 0 });
    expect(compositeRecord.value).toMatchObject({
      groups: expect.arrayContaining([expect.objectContaining({
        coverage: { plannedLayers: 2, observedLayers: 2, missingLayers: 0 },
        aggregate: { aggregateStatus: 'observed', score: 4.14 },
      })]),
    });
    const bootstrapRecord = analysis.bundle.records.find((candidate) => (
      candidate.resultId === 'bootstrap-family-table'
    ));
    expect(bootstrapRecord?.analysisStatus).toBe('completed');
    if (bootstrapRecord?.analysisStatus !== 'completed') {
      throw new Error('missing Bootstrap family record');
    }
    expect(bootstrapRecord.coverage).toMatchObject({ planned: 0, included: 0, comparable: 0 });
    expect(bootstrapRecord.value).toMatchObject({
      targetIntervals: [{
        targetId: 'control',
        intervalStatus: 'observed',
        unitCount: 1,
        interval: { lower: 4.14, upper: 4.14, estimate: 4.14, samples: 0 },
      }, {
        targetId: 'treatment',
        intervalStatus: 'observed',
        unitCount: 1,
        interval: { lower: 4.14, upper: 4.14, estimate: 4.14, samples: 0 },
      }],
      comparisons: [{
        binding: { comparisonId: 'control-vs-treatment', comparisonDesign: 'paired' },
        comparisonStatus: 'observed',
        counts: { controlUnits: 1, treatmentUnits: 1, comparableUnits: 1 },
        interval: { lower: 0, upper: 0, estimate: 0, samples: 100, significant: false },
      }],
      family: {
        plannedComparisons: 1,
        observedComparisons: 1,
        missingComparisons: 0,
        nominalAlpha: 0.05,
        effectiveAlpha: 0.05,
      },
    });

    const implementation = implementations.get(ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID);
    const compositeImplementation = implementations.get(COMPOSITE_ANALYSIS_IMPLEMENTATION_ID);
    const bootstrapImplementation = implementations.get(
      BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
    );
    if (implementation === undefined
        || compositeImplementation === undefined
        || bootstrapImplementation === undefined) {
      throw new Error('missing assertion, composite, or Bootstrap implementation');
    }
    let failedDisposeCalls = 0;
    let blockedCompositeOpened = 0;
    let blockedBootstrapOpened = 0;
    const failedAnalysis = await analyzeEvaluationBundleSource(plan, execution, evaluation, {
      analysisNodesByNodeId: new Map([
        ['assertion-layer-table', {
          identity: implementation.identity,
          outputSchema: implementation.outputSchema,
          async openRun() {
            return {
              async execute() {
                throw new Error('assertion-layer-private-failure');
              },
              dispose() { failedDisposeCalls += 1; },
            };
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
        ['bootstrap-family-table', {
          identity: bootstrapImplementation.identity,
          outputSchema: bootstrapImplementation.outputSchema,
          async openRun(runContext: Readonly<AnalysisNodeRunContext>) {
            blockedBootstrapOpened += 1;
            return bootstrapImplementation.openRun(runContext);
          },
        }],
      ]),
      schemaValidators,
      missingPoliciesByPolicyId: createBuiltinMissingPolicies(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      clock,
      eventSequencer,
    }, { runId: 'assertion-core-failure', bundleId: 'assertion-analysis-failure' });
    expect(failedAnalysis.bundle).toMatchObject({
      analysisBundleStatus: 'failed',
      records: [{
        analysisStatus: 'failed',
        error: { code: 'analysis-runtime-failed' },
      }, { analysisStatus: 'not-evaluated' }, { analysisStatus: 'not-evaluated' }],
    });
    expect(failedDisposeCalls).toBe(1);
    expect(blockedCompositeOpened).toBe(0);
    expect(blockedBootstrapOpened).toBe(0);
    expect(JSON.stringify(failedAnalysis.bundle)).not.toContain('assertion-layer-private-failure');

    let cancelledOpenCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const cancelledAnalysis = await analyzeEvaluationBundleSource(plan, execution, evaluation, {
      analysisNodesByNodeId: new Map([
        ['assertion-layer-table', {
          identity: implementation.identity,
          outputSchema: implementation.outputSchema,
          async openRun(runContext) {
            cancelledOpenCalls += 1;
            return implementation.openRun(runContext);
          },
        }],
        ['composite-table', compositeImplementation],
        ['bootstrap-family-table', bootstrapImplementation],
      ]),
      schemaValidators,
      missingPoliciesByPolicyId: createBuiltinMissingPolicies(),
      decisionPoliciesByDecisionPolicyId: new Map(),
      clock,
      eventSequencer,
    }, {
      runId: 'assertion-core-cancelled',
      bundleId: 'assertion-analysis-cancelled',
      signal: controller.signal,
    });
    expect(cancelledAnalysis.bundle).toMatchObject({
      analysisBundleStatus: 'cancelled',
      records: [
        { analysisStatus: 'not-evaluated', runtimeDependencies: [] },
        { analysisStatus: 'not-evaluated' },
        { analysisStatus: 'not-evaluated' },
      ],
    });
    expect(cancelledOpenCalls).toBe(0);
  });
});
