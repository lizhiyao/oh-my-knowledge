import { describe, expect, it } from 'vitest';
import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  MEASUREMENT_POLICY_SCHEMA_VERSION,
  computeDatasetDigests,
  computePlanDigests,
  computeRunContractDigest,
  computeRuntimeIdentityDigest,
  computeRuntimeImplementationDigest,
  deriveAssignmentMemberships,
  digestArtifactPayload,
  digestCanonicalJson,
  generateRunContractSchemaIdentities,
  projectEvaluationInputs,
  projectAnalysisInputs,
  projectAnalysisCohorts,
  projectExecutionInputs,
  type EvaluationDataset,
  type EvaluationDefinition,
  type MeasurementPolicy,
} from '../../../src/eval-core/contracts/index.js';

const dataset: EvaluationDataset = {
  datasetId: 'support-cases',
  samples: [{
    sampleId: 's1',
    input: { question: 'Q' },
    executionContext: { locale: 'zh-CN' },
    expected: { answer: 'A' },
    evaluationContext: { rubric: 'correctness' },
    analysis: { memberships: [{ cohortId: 'validation' }] },
    annotations: { owner: 'team-a' },
  }],
  analysisCohorts: [{
    cohortId: 'validation',
    cohortSetId: 'selection-split',
    cohortSetKind: 'partition',
    classification: 'sensitive',
    disclosure: 'identity-only',
    derivation: { algorithmId: 'seeded-hash/v1', seed: 'split-seed' },
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
  budget: {
    run: {},
    stages: { execution: {}, evaluation: {} },
    coordinate: {},
    attempt: {},
    providerCostAdmission: {
      admissionMode: 'bounded-overshoot',
      unknownCostMode: 'fail-run',
    },
  },
  evaluation: {
    maxConcurrency: 2,
    retry: {
      maxAttempts: 1,
      retryableErrorCodes: [],
      backoff: { backoffKind: 'none', initialDelayMs: 0 },
    },
  },
  cache: { executionMode: 'disabled', evaluationMode: 'disabled' },
  evidence: {
    output: 'full',
    trace: 'reference',
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
    executionRequirements: {
      systemInstructions: 'not-required',
      workspace: 'not-required',
      mcp: 'not-required',
      mockInterception: 'not-required',
      toolPolicy: 'runtime-default',
      skillDiscovery: 'runtime-default',
    },
    executionControls: {
      defaults: {
        workspace: { workspaceMode: 'not-required' },
        tools: { toolPolicyKind: 'runtime-default' },
        mcp: { mcpMode: 'not-required' },
        mockInterception: { mockInterceptionMode: 'not-required' },
      },
      sampleOverrides: [],
    },
  }],
  evaluators: [{
    evaluatorId: 'exact',
    evaluatorKind: 'assertion',
    implementationId: 'exact/v1',
    measurement: {
      instrumentId: 'exact-assertion',
      ensembleMemberId: 'exact-local',
      replicateGroupId: 'exact-primary',
      replicateIndex: 0,
    },
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
    assignment: {
      assignmentKind: 'complete-block',
      algorithmId: 'assignment.complete-block/v1',
      randomizationSlotIds: ['slot-control'],
    },
    randomizationSlots: [{
      targetId: 'control',
      randomizationSlotId: 'slot-control',
    }],
    sampling: {
      experimentalUnit: 'sample',
      repeatedMeasures: false,
      resamplingUnit: 'sample',
      estimatorId: 'bootstrap.mean-percentile/v1',
      seedCoupling: 'independent-by-target',
    },
    scheduling: { schedulingKind: 'sequential' },
  },
  analysisGraph: { analysisMode: 'preregistered', nodes: [] },
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
    decisionRuntimes: [],
    schemaIdentities: generateRunContractSchemaIdentities(),
    ...(current.seriesMembership === undefined
      ? {}
      : { seriesMembership: current.seriesMembership }),
  });
}

function independentDefinition(seed = 'independent-seed'): EvaluationDefinition {
  return {
    ...structuredClone(definition),
    dataset: {
      datasetId: 'independent-cases',
      samples: Array.from({ length: 8 }, (_, index) => ({
        ...structuredClone(dataset.samples[0]),
        sampleId: `sample-${index + 1}`,
        executionContext: { stratum: index < 4 ? 'a' : 'b' },
      })),
    },
    targets: [
      structuredClone(definition.targets[0]),
      { ...structuredClone(definition.targets[0]), targetId: 'treatment' },
    ],
    experiment: {
      trials: 2,
      seed,
      assignment: {
        assignmentKind: 'independent-groups',
        algorithmId: 'assignment.stratified-fixed-quota/v1',
        stratumKey: '/executionContext/stratum',
        allocations: [
          { randomizationSlotId: 'slot-control', weight: 1 },
          { randomizationSlotId: 'slot-treatment', weight: 1 },
        ],
        minimumUnitsPerTarget: 2,
        minimumUnitsPerTargetPerStratum: 1,
      },
      randomizationSlots: [
        { targetId: 'control', randomizationSlotId: 'slot-control' },
        { targetId: 'treatment', randomizationSlotId: 'slot-treatment' },
      ],
      sampling: {
        experimentalUnit: 'sample',
        repeatedMeasures: true,
        resamplingUnit: 'sample',
        estimatorId: 'bootstrap.unpaired-difference-percentile/v1',
        seedCoupling: 'independent-by-target',
      },
      scheduling: { schedulingKind: 'interleaved' },
    },
    comparisons: [{
      comparisonId: 'control-vs-treatment',
      controlTargetId: 'control',
      treatmentTargetIds: ['treatment'],
      metricIds: ['correct'],
    }],
  };
}

describe('Evaluation Core layered digests', () => {
  it('derives deterministic balanced independent assignments at the sample unit', () => {
    const current = independentDefinition();
    const input = {
      samples: projectExecutionInputs(current.dataset),
      experiment: current.experiment,
    };
    const first = deriveAssignmentMemberships(input);
    const reordered = deriveAssignmentMemberships({
      ...input,
      samples: [...input.samples].reverse(),
    });

    expect(first).toEqual(reordered);
    expect(first).toHaveLength(8);
    expect(new Set(first.map((membership) => membership.sampleId)).size).toBe(8);
    expect(first.filter((membership) => membership.targetId === 'control')).toHaveLength(4);
    expect(first.filter((membership) => membership.targetId === 'treatment')).toHaveLength(4);
  });

  it('honors fixed allocation weights independently within each stratum', () => {
    const current = independentDefinition();
    if (current.experiment.assignment.assignmentKind !== 'independent-groups') return;
    current.experiment.assignment.allocations = [
      { randomizationSlotId: 'slot-control', weight: 3 },
      { randomizationSlotId: 'slot-treatment', weight: 1 },
    ];
    const memberships = deriveAssignmentMemberships({
      samples: projectExecutionInputs(current.dataset),
      experiment: current.experiment,
    });
    const stratumBySample = new Map(current.dataset.samples.map((sample) => [
      sample.sampleId,
      (sample.executionContext as { stratum: string }).stratum,
    ]));

    expect(memberships.filter((membership) => membership.targetId === 'control')).toHaveLength(6);
    expect(memberships.filter((membership) => membership.targetId === 'treatment')).toHaveLength(2);
    for (const stratum of ['a', 'b']) {
      const stratumMemberships = memberships.filter((membership) => (
        stratumBySample.get(membership.sampleId) === stratum
      ));
      expect(stratumMemberships.filter((membership) => membership.targetId === 'control'))
        .toHaveLength(3);
      expect(stratumMemberships.filter((membership) => membership.targetId === 'treatment'))
        .toHaveLength(1);
    }
  });

  it('binds independent assignment seed, weights, and sealed memberships into identity', () => {
    const current = independentDefinition();
    const first = planDigests(current);
    const reseeded = planDigests(independentDefinition('other-seed'));
    const reweighted = structuredClone(current);
    if (reweighted.experiment.assignment.assignmentKind !== 'independent-groups') return;
    reweighted.experiment.assignment.allocations[0].weight = 3;
    const second = planDigests(reweighted);

    expect(reseeded.randomizationDesignDigest).not.toBe(first.randomizationDesignDigest);
    expect(reseeded.executionPlanDigest).not.toBe(first.executionPlanDigest);
    expect(second.randomizationDesignDigest).not.toBe(first.randomizationDesignDigest);
    expect(second.executionPlanDigest).not.toBe(first.executionPlanDigest);
  });
  it('binds Target execution requirements into Execution and downstream plan identity', () => {
    const first = planDigests(definition);
    const second = planDigests({
      ...definition,
      targets: definition.targets.map((target) => ({
        ...target,
        executionRequirements: {
          ...target.executionRequirements,
          systemInstructions: 'required',
        },
      })),
    });

    expect(second.executionPlanDigest).not.toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).not.toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).not.toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).not.toBe(first.decisionPlanDigest);
    expect(second.runContractDigest).not.toBe(first.runContractDigest);
  });

  it('separates Runtime behavior identity from evidence qualification', () => {
    const runtime = {
      implementationId: 'remote-model/v1',
      version: '1.0.0',
      fingerprint: 'deployment:primary',
      fingerprintBasis: 'self-reported' as const,
      assuranceLevel: 'declared' as const,
      capabilities: { protocol: 'omk.invoke/v1' },
      implementationManifest: {
        coverageKind: 'fingerprint-plus-facets' as const,
        facets: [{
          facetId: 'toolSchemaDigest',
          value: `sha256:${'1'.repeat(64)}`,
        }],
      },
      provenanceFacets: { observation: { observerId: 'runtime-resolver' } },
    };
    const requalified = {
      ...runtime,
      fingerprintBasis: 'content-derived' as const,
      assuranceLevel: 'verified' as const,
      provenanceFacets: {
        attestation: { attestationDigest: `sha256:${'3'.repeat(64)}` },
      },
    };
    const changedBehavior = {
      ...runtime,
      implementationManifest: {
        coverageKind: 'fingerprint-plus-facets' as const,
        facets: [{
          facetId: 'toolSchemaDigest',
          value: `sha256:${'2'.repeat(64)}`,
        }],
      },
    };

    expect(computeRuntimeIdentityDigest(requalified)).not.toBe(
      computeRuntimeIdentityDigest(runtime),
    );
    expect(computeRuntimeImplementationDigest(requalified)).toBe(
      computeRuntimeImplementationDigest(runtime),
    );
    expect(computeRuntimeImplementationDigest(changedBehavior)).not.toBe(
      computeRuntimeImplementationDigest(runtime),
    );
  });

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
    expect(projectEvaluationInputs(dataset)[0]).not.toHaveProperty('analysis');
    expect(projectAnalysisInputs(dataset)).toEqual([{
      sampleId: 's1',
      analysis: { memberships: [{ cohortId: 'validation' }] },
    }]);
    expect(projectAnalysisCohorts(dataset).map((cohort) => cohort.cohortId)).toEqual([
      'validation',
    ]);
  });

  it('invalidates only Analysis and downstream identity when cohort membership changes', () => {
    const first = planDigests(definition);
    const changed: EvaluationDefinition = {
      ...definition,
      dataset: {
        ...definition.dataset,
        samples: [{
          ...definition.dataset.samples[0],
          analysis: { memberships: [] },
        }],
      },
    };
    const second = planDigests(changed);

    expect(second.executionInputDigest).toBe(first.executionInputDigest);
    expect(second.evaluationInputDigest).toBe(first.evaluationInputDigest);
    expect(second.analysisInputDigest).not.toBe(first.analysisInputDigest);
    expect(second.executionPlanDigest).toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).not.toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).not.toBe(first.decisionPlanDigest);
    expect(second.runContractDigest).not.toBe(first.runContractDigest);
  });

  it('canonicalizes cohort and membership set order', () => {
    const training = {
      cohortId: 'training',
      cohortSetId: 'quality-tags',
      cohortSetKind: 'cohort' as const,
      classification: 'sensitive' as const,
      disclosure: 'identity-only' as const,
    };
    const validation = definition.dataset.analysisCohorts?.[0];
    if (validation === undefined) throw new Error('fixture cohort missing');
    const left: EvaluationDataset = {
      ...definition.dataset,
      analysisCohorts: [validation, training],
      samples: [{
        ...definition.dataset.samples[0],
        analysis: { memberships: [{ cohortId: 'validation' }, { cohortId: 'training' }] },
      }],
    };
    const right: EvaluationDataset = {
      ...left,
      analysisCohorts: [training, validation],
      samples: [{
        ...left.samples[0],
        analysis: { memberships: [{ cohortId: 'training' }, { cohortId: 'validation' }] },
      }],
    };

    expect(computeDatasetDigests(right).analysisInputDigest).toBe(
      computeDatasetDigests(left).analysisInputDigest,
    );
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

  it('keeps the Analysis estimator out of execution randomization identity', () => {
    const first = planDigests(definition);
    const second = planDigests({
      ...definition,
      experiment: {
        ...definition.experiment,
        sampling: {
          ...definition.experiment.sampling,
          estimatorId: 'bootstrap.other-estimator/v1',
        },
      },
    });

    expect(second.randomizationDesignDigest).toBe(first.randomizationDesignDigest);
    expect(second.executionPlanDigest).toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).toBe(first.evaluationPlanDigest);
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

  it('binds preregistered Series membership only at the Run contract root', () => {
    const first = planDigests(definition);
    const second = planDigests({
      ...definition,
      seriesMembership: {
        seriesDesignDigest: digestCanonicalJson({ series: 'release-stability' }),
        memberId: 'repeat-1',
        replicateIndex: 0,
      },
    });

    expect(second.executionPlanDigest).toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).toBe(first.decisionPlanDigest);
    expect(second.runContractDigest).not.toBe(first.runContractDigest);
  });

  it('invalidates Execution and every downstream plan when an executor fingerprint changes', () => {
    const identities = generateRunContractSchemaIdentities();
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
      decisionRuntimes: [],
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
        implementationManifest: { coverageKind: 'fingerprint-complete' as const },
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
        analysisMode: 'preregistered',
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

  it('invalidates Analysis and Decision when a comparison changes', () => {
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
    expect(second.analysisPlanDigest).not.toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).not.toBe(first.decisionPlanDigest);
  });

  it('binds paired comparison connectivity into Execution identity', () => {
    const paired: EvaluationDefinition = {
      ...definition,
      targets: [
        definition.targets[0],
        { ...definition.targets[0], targetId: 'variant-a' },
        { ...definition.targets[0], targetId: 'variant-b' },
      ],
      experiment: {
        ...definition.experiment,
        randomizationSlots: [
          { targetId: 'control', randomizationSlotId: 'slot-control' },
          { targetId: 'variant-a', randomizationSlotId: 'slot-variant-a' },
          { targetId: 'variant-b', randomizationSlotId: 'slot-variant-b' },
        ],
        sampling: {
          ...definition.experiment.sampling,
          pairingKey: '/sampleId',
          resamplingUnit: 'paired-block',
        },
      },
      comparisons: [{
        comparisonId: 'control-vs-a',
        controlTargetId: 'control',
        treatmentTargetIds: ['variant-a'],
        metricIds: ['correct'],
      }],
    };
    const first = planDigests(paired);
    const changedConnectivity: EvaluationDefinition = {
      ...paired,
      comparisons: [{
        ...paired.comparisons[0],
        treatmentTargetIds: ['variant-b'],
      }],
    };
    const second = planDigests(changedConnectivity);

    expect(second.executionPlanDigest).not.toBe(first.executionPlanDigest);
    expect(second.evaluationPlanDigest).not.toBe(first.evaluationPlanDigest);
    expect(second.analysisPlanDigest).not.toBe(first.analysisPlanDigest);
    expect(second.decisionPlanDigest).not.toBe(first.decisionPlanDigest);
  });

  it('keeps comparison labels out of Execution and Evaluation identities', () => {
    const paired: EvaluationDefinition = {
      ...definition,
      targets: [
        definition.targets[0],
        { ...definition.targets[0], targetId: 'treatment' },
      ],
      experiment: {
        ...definition.experiment,
        randomizationSlots: [
          { targetId: 'control', randomizationSlotId: 'slot-control' },
          { targetId: 'treatment', randomizationSlotId: 'slot-treatment' },
        ],
        sampling: {
          ...definition.experiment.sampling,
          pairingKey: '/sampleId',
          resamplingUnit: 'paired-block',
        },
      },
      comparisons: [{
        comparisonId: 'control-vs-treatment',
        controlTargetId: 'control',
        treatmentTargetIds: ['treatment'],
        metricIds: ['correct'],
      }],
    };
    const first = planDigests(paired);
    const changed = planDigests({
      ...paired,
      comparisons: [{
        ...paired.comparisons[0],
        comparisonId: 'renamed-comparison',
      }],
    });

    expect(changed.executionPlanDigest).toBe(first.executionPlanDigest);
    expect(changed.evaluationPlanDigest).toBe(first.evaluationPlanDigest);
    expect(changed.analysisPlanDigest).not.toBe(first.analysisPlanDigest);
    expect(changed.decisionPlanDigest).not.toBe(first.decisionPlanDigest);
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
    const schemaIdentities = generateRunContractSchemaIdentities();
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
