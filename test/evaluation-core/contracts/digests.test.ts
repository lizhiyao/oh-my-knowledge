import { describe, expect, it } from 'vitest';
import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  MEASUREMENT_POLICY_SCHEMA_VERSION,
  computeDatasetDigests,
  computePlanDigests,
  computeRunContractDigest,
  digestArtifactPayload,
  digestCanonicalJson,
  generateWireSchemaIdentities,
  projectEvaluationInputs,
  projectExecutionInputs,
  type EvaluationDataset,
  type EvaluationDefinition,
  type MeasurementPolicy,
} from '../../../src/evaluation-core/contracts/index.js';

const dataset: EvaluationDataset = {
  datasetId: 'support-cases',
  samples: [{
    sampleId: 's1',
    input: { question: 'Q' },
    executionContext: { locale: 'zh-CN' },
    expected: { answer: 'A' },
    evaluationContext: { rubric: 'correctness' },
    annotations: { owner: 'team-a' },
  }],
  annotations: { project: 'omk' },
};

const policy: MeasurementPolicy = {
  schemaVersion: MEASUREMENT_POLICY_SCHEMA_VERSION,
  execution: { maxConcurrency: 2, timeoutMs: 10_000 },
  retry: {
    maxAttempts: 1,
    retryableErrorCodes: [],
    backoff: { backoffKind: 'none', initialDelayMs: 0 },
  },
  budget: {},
  cache: { executionMode: 'disabled', evaluationMode: 'disabled' },
  evidence: {
    input: 'digest',
    output: 'full',
    trace: 'reference',
    expected: 'digest',
    evidence: 'full',
    maximumClassification: 'gold',
  },
  failure: { failureMode: 'continue' },
  eventDelivery: {
    writerMode: 'disabled',
    backpressureMode: 'block',
    writerFailureMode: 'ignore',
  },
};

const definition: EvaluationDefinition = {
  schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
  dataset,
  targets: [{
    targetId: 'control',
    targetKind: 'function',
    protocolId: 'omk.invoke/v1',
    executorId: 'local',
  }],
  evaluators: [{
    evaluatorId: 'exact',
    evaluatorKind: 'assertion',
    implementationId: 'exact/v1',
    metricIds: ['correct'],
    inputs: [
      { bindingId: 'output', sourceKind: 'output', pointer: '' },
      { bindingId: 'expected', sourceKind: 'expected', pointer: '' },
    ],
  }],
  metrics: [{
    metricId: 'correct',
    valueType: 'boolean',
    scope: 'sample',
    direction: 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  }],
  experiment: {
    trials: 1,
    seed: 'seed-1',
    sampling: {
      experimentalUnit: 'sample',
      repeatedMeasures: false,
      resamplingUnit: 'sample',
      estimatorId: 'bootstrap.mean-percentile/v1',
      seedCoupling: 'independent-by-target',
    },
    scheduling: { schedulingKind: 'sequential' },
  },
  analysisGraph: { nodes: [] },
  comparisons: [],
};

function planDigests(current: EvaluationDefinition, currentPolicy = policy) {
  return computePlanDigests({
    dataset: current.dataset,
    targets: current.targets,
    evaluators: current.evaluators,
    metrics: current.metrics,
    experiment: current.experiment,
    analysisGraph: current.analysisGraph,
    comparisons: current.comparisons,
    decisionPolicy: current.decisionPolicy,
    measurementPolicy: currentPolicy,
    executorRuntimes: [],
    evaluatorRuntimes: [],
    analysisRuntimes: [],
    schemaIdentities: generateWireSchemaIdentities(),
  });
}

describe('Evaluation Core layered digests', () => {
  it('projects Gold away from executor-visible inputs', () => {
    expect(projectExecutionInputs(dataset)).toEqual([{
      sampleId: 's1',
      input: { question: 'Q' },
      executionContext: { locale: 'zh-CN' },
    }]);
    expect(projectEvaluationInputs(dataset)[0]).toMatchObject({
      expected: { answer: 'A' },
      evaluationContext: { rubric: 'correctness' },
    });
    expect(projectEvaluationInputs(dataset)[0]).not.toHaveProperty('annotations');
  });

  it('changes lineage and evaluation identities for Gold without changing execution identity', () => {
    const first = computeDatasetDigests(dataset);
    const changedGold: EvaluationDataset = {
      ...dataset,
      samples: [{ ...dataset.samples[0], expected: { answer: 'B' } }],
    };
    const second = computeDatasetDigests(changedGold);

    expect(second.datasetRevisionDigest).not.toBe(first.datasetRevisionDigest);
    expect(second.evaluationInputDigest).not.toBe(first.evaluationInputDigest);
    expect(second.executionInputDigest).toBe(first.executionInputDigest);
  });

  it('keeps audit annotations out of all measurement plan digests', () => {
    const first = planDigests(definition);
    const annotated: EvaluationDefinition = {
      ...definition,
      dataset: {
        ...definition.dataset,
        annotations: { project: 'changed' },
        samples: [{ ...definition.dataset.samples[0], annotations: { owner: 'team-b' } }],
      },
    };
    const second = planDigests(annotated);

    expect(second.datasetRevisionDigest).not.toBe(first.datasetRevisionDigest);
    expect(second.executionPlanDigest).toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).toBe(first.decisionPlanDigest);
    expect(second.runContractDigest).toBe(first.runContractDigest);
  });

  it('invalidates only Evaluation and downstream plans when an evaluator changes', () => {
    const first = planDigests(definition);
    const changed: EvaluationDefinition = {
      ...definition,
      evaluators: [{ ...definition.evaluators[0], implementationId: 'exact/v2' }],
    };
    const second = planDigests(changed);

    expect(second.executionPlanDigest).toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).not.toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).not.toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).not.toBe(first.decisionPlanDigest);
  });

  it('invalidates Execution and every downstream plan when execution policy changes', () => {
    const first = planDigests(definition);
    const changedPolicy: MeasurementPolicy = {
      ...policy,
      execution: { ...policy.execution, timeoutMs: 20_000 },
    };
    const second = planDigests(definition, changedPolicy);

    expect(second.executionPlanDigest).not.toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).not.toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).not.toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).not.toBe(first.decisionPlanDigest);
  });

  it('keeps evaluation cache policy out of Execution identity', () => {
    const first = planDigests(definition);
    const changedPolicy: MeasurementPolicy = {
      ...policy,
      cache: { ...policy.cache, evaluationMode: 'reuse' },
    };
    const second = planDigests(definition, changedPolicy);

    expect(second.executionPlanDigest).toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).not.toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).not.toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).not.toBe(first.decisionPlanDigest);
  });

  it('keeps EventWriter delivery policy out of stage identities but binds the root contract', () => {
    const first = planDigests(definition);
    const changedPolicy: MeasurementPolicy = {
      ...policy,
      eventDelivery: {
        writerMode: 'required',
        backpressureMode: 'block',
        writerFailureMode: 'fail-run',
      },
    };
    const second = planDigests(definition, changedPolicy);

    expect(second.executionPlanDigest).toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).toBe(first.decisionPlanDigest);
    expect(second.runContractDigest).not.toBe(first.runContractDigest);
  });

  it('invalidates Execution and every downstream plan when an executor fingerprint changes', () => {
    const identities = generateWireSchemaIdentities();
    const base = {
      dataset: definition.dataset,
      targets: definition.targets,
      evaluators: definition.evaluators,
      metrics: definition.metrics,
      experiment: definition.experiment,
      analysisGraph: definition.analysisGraph,
      comparisons: definition.comparisons,
      measurementPolicy: policy,
      evaluatorRuntimes: [],
      analysisRuntimes: [],
      schemaIdentities: identities,
    };
    const runtime = {
      runtimeKind: 'executor' as const,
      referenceId: 'local',
      identity: {
        implementationId: 'local/v1',
        fingerprint: `sha256:${'1'.repeat(64)}`,
        fingerprintBasis: 'content-derived' as const,
        assuranceLevel: 'verified' as const,
        capabilities: {},
      },
    };
    const first = computePlanDigests({ ...base, executorRuntimes: [runtime] });
    const second = computePlanDigests({
      ...base,
      executorRuntimes: [{
        ...runtime,
        identity: { ...runtime.identity, fingerprint: `sha256:${'2'.repeat(64)}` },
      }],
    });

    expect(second.executionPlanDigest).not.toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).not.toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).not.toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).not.toBe(first.decisionPlanDigest);
  });

  it('invalidates only Analysis and Decision when the analysis graph changes', () => {
    const first = planDigests(definition);
    const changed: EvaluationDefinition = {
      ...definition,
      analysisGraph: {
        nodes: [{
          analysisNodeKind: 'reducer',
          nodeId: 'mean-correct',
          implementationId: 'descriptive.mean/v1',
          inputs: [{ inputKind: 'metric-observations', referenceId: 'correct' }],
          outputResultId: 'mean-correct',
        }],
      },
    };
    const second = planDigests(changed);

    expect(second.executionPlanDigest).toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).not.toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).not.toBe(first.decisionPlanDigest);
  });

  it('invalidates only Decision when a comparison changes', () => {
    const first = planDigests(definition);
    const changed: EvaluationDefinition = {
      ...definition,
      comparisons: [{
        comparisonId: 'control-vs-treatment',
        controlTargetId: 'control',
        treatmentTargetIds: ['treatment'],
        metricIds: ['correct'],
      }],
    };
    const second = planDigests(changed);

    expect(second.executionPlanDigest).toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).not.toBe(first.decisionPlanDigest);
  });

  it('computes Bundle and Report identities without self-referencing digest fields', () => {
    const artifact = {
      schemaVersion: 'omk.example/v1',
      value: { answer: 42 },
      bundleDigest: `sha256:${'a'.repeat(64)}`,
    };

    expect(digestArtifactPayload(artifact, 'bundleDigest')).toBe(digestCanonicalJson({
      schemaVersion: 'omk.example/v1',
      value: { answer: 42 },
    }));
  });

  it('treats schema identities as an order-independent set in the root contract', () => {
    const schemaIdentities = generateWireSchemaIdentities();
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const input = {
      executionPlanDigest: digest,
      evaluationPlanDigest: digest,
      analysisPlanDigest: digest,
      decisionPlanDigest: digest,
      eventDeliveryPolicy: policy.eventDelivery,
    };

    expect(computeRunContractDigest({ ...input, schemaIdentities })).toBe(
      computeRunContractDigest({ ...input, schemaIdentities: [...schemaIdentities].reverse() }),
    );
  });
});
