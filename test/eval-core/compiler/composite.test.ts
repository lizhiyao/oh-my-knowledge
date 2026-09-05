import { describe, expect, it } from 'vitest';
import {
  createBuiltinAnalysisSchemaValidators,
  resolveBuiltinAnalysisRuntime,
} from '../../../src/eval-core/analysis/index.js';
import { prepareEvaluationPlan } from '../../../src/eval-core/compiler/index.js';
import type { EvaluationDefinition } from '../../../src/eval-core/contracts/index.js';
import { testRuntime, validDefinition, validPolicy } from './fixtures.js';

function runtime() {
  const fallback = testRuntime({ evaluatorValueTypes: ['boolean', 'numeric'] });
  return {
    ...fallback,
    schemaValidators: new Map([
      ...fallback.schemaValidators,
      ...createBuiltinAnalysisSchemaValidators(),
    ]),
    resolveAnalysis(requirement: Parameters<typeof fallback.resolveAnalysis>[0]) {
      return resolveBuiltinAnalysisRuntime(requirement) ?? fallback.resolveAnalysis(requirement);
    },
  };
}

function definition(componentOrder: 'canonical' | 'reversed' = 'canonical'): EvaluationDefinition {
  const result = validDefinition();
  result.evaluators.push({
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
    inputs: [{ bindingId: 'latency', sourceKind: 'execution-facts', pointer: '' }],
  });
  result.metrics.push({
    metricId: 'latency-ms',
    valueType: 'numeric',
    scope: 'sample',
    scale: { min: 0, max: 10_000 },
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
  const components = [{ metricId: 'correct', weight: 0.7 }, {
    metricId: 'latency-ms', weight: 0.3,
  }];
  const ordered = componentOrder === 'canonical' ? components : [...components].reverse();
  result.experiment.sampling.estimatorId = 'bootstrap.composite-mean-percentile/v1';
  result.analysisGraph.nodes = [{
    analysisNodeKind: 'estimator',
    nodeId: 'overall-quality',
    implementationId: 'bootstrap.composite-mean-percentile/v1',
    inputs: ordered.map((component) => ({
      inputKind: 'metric-observations' as const,
      referenceId: component.metricId,
    })),
    outputResultId: 'overall-quality-result',
    targetFilter: { includeTargetIds: ['treatment'] },
    parameters: {
      compositeMetricId: 'overall-quality',
      components: ordered,
      aggregation: { method: 'weighted-mean', missing: 'require-complete' },
      resamples: 100,
      alpha: 0.05,
    },
  }];
  result.decisionPolicy = {
    decisionPolicyId: 'release-gate',
    implementationId: 'progress/v2',
    analysisResultIds: ['overall-quality-result'],
    minimumEvidenceStatus: 'complete',
    parameters: { threshold: 0.5, equivalence: 0 },
  };
  return result;
}

describe('Composite Analysis compiler semantics', () => {
  it('canonicalizes declaration order into one Definition and Plan identity', async () => {
    const canonical = await prepareEvaluationPlan(definition(), validPolicy(), runtime());
    const reversed = await prepareEvaluationPlan(definition('reversed'), validPolicy(), runtime());

    expect(reversed.definition).toEqual(canonical.definition);
    expect(reversed.digests.analysisPlanDigest).toBe(canonical.digests.analysisPlanDigest);
    expect(reversed.digests.runContractDigest).toBe(canonical.digests.runContractDigest);
    expect(canonical.definition.analysisGraph.nodes[0].inputs.map((input) => input.referenceId))
      .toEqual(['correct', 'latency-ms']);
    expect(canonical.definition.analysisGraph.nodes[0].parameters).toMatchObject({
      components: [{ metricId: 'correct' }, { metricId: 'latency-ms' }],
    });
  });

  it('rejects derived Metric and source utility contracts that are not sealed', async () => {
    const invalidDerived = definition();
    invalidDerived.metrics.find((candidate) => candidate.metricId === 'overall-quality')!.unit = 'score';
    await expect(prepareEvaluationPlan(invalidDerived, validPolicy(), runtime()))
      .rejects.toThrow(/Composite derived Metric/);

    const missingScale = definition();
    delete missingScale.metrics.find((candidate) => candidate.metricId === 'latency-ms')!.scale;
    await expect(prepareEvaluationPlan(missingScale, validPolicy(), runtime()))
      .rejects.toThrow(/sealed monotonic utility/);

    const producedDerived = definition();
    producedDerived.evaluators[0].metricIds.push('overall-quality');
    await expect(prepareEvaluationPlan(producedDerived, validPolicy(), runtime()))
      .rejects.toThrow(/Composite derived Metric/);
  });

  it('requires every source Evaluator to be represented by its component aggregation', async () => {
    const ambiguous = definition();
    ambiguous.evaluators.push({
      ...structuredClone(ambiguous.evaluators[0]),
      evaluatorId: 'exact-replicate',
      measurement: {
        instrumentId: 'exact-assertion',
        ensembleMemberId: 'exact-local',
        replicateGroupId: 'exact-primary',
        replicateIndex: 1,
      },
    });
    await expect(prepareEvaluationPlan(ambiguous, validPolicy(), runtime()))
      .rejects.toThrow(/measurement aggregation/);
  });

  it('requires quality composites to seal exactly one Variant', async () => {
    const missing = definition();
    delete missing.analysisGraph.nodes[0].targetFilter;
    await expect(prepareEvaluationPlan(missing, validPolicy(), runtime()))
      .rejects.toThrow(/精确封存一个 Variant/);

    const multiple = definition();
    multiple.analysisGraph.nodes[0].targetFilter = {
      includeTargetIds: ['control', 'treatment'],
    };
    await expect(prepareEvaluationPlan(multiple, validPolicy(), runtime()))
      .rejects.toThrow(/精确封存一个 Variant/);
  });
});
