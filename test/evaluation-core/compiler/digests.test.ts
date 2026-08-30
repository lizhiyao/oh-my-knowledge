import { describe, expect, it } from 'vitest';
import { prepareEvaluationPlan } from '../../../src/evaluation-core/compiler/index.js';
import { testRuntime, validDefinition, validPolicy } from './fixtures.js';

async function compile(
  mutateDefinition?: (definition: ReturnType<typeof validDefinition>) => void,
  mutatePolicy?: (policy: ReturnType<typeof validPolicy>) => void,
  runtime = testRuntime(),
) {
  const definition = validDefinition();
  const policy = validPolicy();
  mutateDefinition?.(definition);
  mutatePolicy?.(policy);
  return prepareEvaluationPlan(definition, policy, runtime);
}

function expectStages(
  before: Awaited<ReturnType<typeof compile>>,
  after: Awaited<ReturnType<typeof compile>>,
  changed: Array<'execution' | 'evaluation' | 'analysis' | 'decision' | 'run'>,
): void {
  const fields = {
    execution: 'executionPlanDigest',
    evaluation: 'evaluationPlanDigest',
    analysis: 'analysisPlanDigest',
    decision: 'decisionPlanDigest',
    run: 'runContractDigest',
  } as const;
  for (const [stage, field] of Object.entries(fields)) {
    if (changed.includes(stage as keyof typeof fields)) {
      expect(after.digests[field], `${stage} should change`).not.toBe(before.digests[field]);
    } else {
      expect(after.digests[field], `${stage} should remain stable`).toBe(before.digests[field]);
    }
  }
}

describe('Compiler digest invalidation boundaries', () => {
  it('keeps property order and annotations out of measurement identity', async () => {
    const before = await compile();
    const reordered = await compile((definition) => {
      definition.dataset.samples[0].input = { cohort: 'a', question: 'Q' };
      definition.dataset.samples[0].annotations = { owner: 'team-b' };
      definition.dataset.annotations = { project: 'changed' };
    });

    expectStages(before, reordered, []);
    expect(reordered.digests.datasetRevisionDigest).not.toBe(before.digests.datasetRevisionDigest);
  });

  it('invalidates Evaluation and downstream for Gold', async () => {
    const before = await compile();
    const after = await compile((definition) => {
      definition.dataset.samples[0].expected = { answer: 'B' };
    });
    expectStages(before, after, ['evaluation', 'analysis', 'decision', 'run']);
  });

  it('invalidates Evaluation and downstream for Evaluator and Metric changes', async () => {
    const before = await compile();
    const after = await compile((definition) => {
      definition.evaluators[0].config = { strict: true };
    });
    expectStages(before, after, ['evaluation', 'analysis', 'decision', 'run']);
  });

  it('invalidates Analysis and downstream for AnalysisGraph changes', async () => {
    const before = await compile();
    const after = await compile((definition) => {
      definition.analysisGraph.nodes[0].parameters = { minimumCoverage: 0.9 };
    });
    expectStages(before, after, ['analysis', 'decision', 'run']);
  });

  it('keeps the Analysis estimator out of the Execution plan and identity', async () => {
    const before = await compile();
    const after = await compile((definition) => {
      definition.experiment.sampling.estimatorId = 'bootstrap.other-estimator/v1';
    });

    expect(before.execution.experiment.sampling).not.toHaveProperty('estimatorId');
    expect(before.analysis.experiment.sampling.estimatorId).toBe(
      'bootstrap.mean-percentile/v1',
    );
    expectStages(before, after, ['analysis', 'decision', 'run']);
  });

  it('invalidates only Decision and root for DecisionPolicy changes', async () => {
    const before = await compile();
    const after = await compile((definition) => {
      definition.decisionPolicy!.parameters = { threshold: 0.1 };
    });
    expectStages(before, after, ['decision', 'run']);
  });

  it('invalidates Analysis and downstream for non-scheduling Comparison changes', async () => {
    const before = await compile();
    const after = await compile((definition) => {
      definition.comparisons[0].comparisonId = 'renamed-comparison';
    });
    expectStages(before, after, ['analysis', 'decision', 'run']);
  });

  it('keeps evaluation cache out of Execution identity', async () => {
    const before = await compile();
    const after = await compile(undefined, (policy) => {
      policy.cache.evaluationMode = 'reuse';
    });
    expectStages(before, after, ['evaluation', 'analysis', 'decision', 'run']);
  });

  it('binds Execution evidence capture and classification to Execution identity', async () => {
    const before = await compile();
    const after = await compile(undefined, (policy) => {
      policy.evidence.output = 'reference';
      policy.evidence.maximumClassification = 'secret';
    });
    expectStages(before, after, ['execution', 'evaluation', 'analysis', 'decision', 'run']);
  });

  it('keeps evaluator-produced evidence capture out of Execution identity', async () => {
    const before = await compile();
    const after = await compile(undefined, (policy) => {
      policy.evidence.evidence = 'digest';
    });

    expect(before.evaluation.policy.evidence).toEqual({
      output: 'full',
      trace: 'reference',
      evidence: 'full',
      maximumClassification: 'gold',
    });
    expect(before.evaluation.policy.evidence).not.toHaveProperty('input');
    expect(before.evaluation.policy.evidence).not.toHaveProperty('expected');
    expectStages(before, after, ['evaluation', 'analysis', 'decision', 'run']);
  });

  it('keeps EventDeliveryPolicy out of all stage plans and binds it at root', async () => {
    const before = await compile();
    const after = await compile(undefined, (policy) => {
      policy.eventDelivery = {
        writerMode: 'required',
        backpressureMode: 'block',
        writerFailureMode: 'fail-run',
      };
    });
    expectStages(before, after, ['run']);
  });

  it('invalidates Execution and all downstream plans for executor fingerprint changes', async () => {
    const before = await compile();
    const after = await compile(undefined, undefined, testRuntime({
      executorFingerprint: 'executor-fingerprint-2',
    }));
    expectStages(before, after, ['execution', 'evaluation', 'analysis', 'decision', 'run']);
  });

  it('binds extensions only to the stage declared by their validator', async () => {
    const namespace = 'urn:example:stage-extension';
    const compileExtension = async (data: string, impactStage: 'execution' | 'audit') => {
      const definition = validDefinition();
      definition.extensions = {
        [namespace]: {
          schemaUri: 'urn:example:schema:stage-extension:v1',
          schemaDigest: `sha256:${'a'.repeat(64)}`,
          data: { value: data },
        },
      };
      return prepareEvaluationPlan(
        definition,
        validPolicy(),
        testRuntime({ extensionStages: { [namespace]: impactStage } }),
      );
    };
    const executionBefore = await compileExtension('a', 'execution');
    const executionAfter = await compileExtension('b', 'execution');
    expectStages(
      executionBefore,
      executionAfter,
      ['execution', 'evaluation', 'analysis', 'decision', 'run'],
    );

    const auditBefore = await compileExtension('a', 'audit');
    const auditAfter = await compileExtension('b', 'audit');
    expectStages(auditBefore, auditAfter, []);
  });

  it('binds runtime schema identity changes into the affected stage and root contract', async () => {
    const before = await compile();
    const runtime = testRuntime();
    const originalResolve = runtime.resolveEvaluator.bind(runtime);
    runtime.resolveEvaluator = async (requirement) => {
      const resolution = await originalResolve(requirement) as {
        identity: { capabilities: { schemas: Array<{ schemaDigest: string }> } };
      } & Record<string, unknown>;
      resolution.identity.capabilities.schemas[0].schemaDigest = `sha256:${'f'.repeat(64)}`;
      return resolution;
    };
    const after = await compile(undefined, undefined, runtime);

    expectStages(before, after, ['evaluation', 'analysis', 'decision', 'run']);
    expect(after.schemaIdentities).not.toEqual(before.schemaIdentities);
  });
});
