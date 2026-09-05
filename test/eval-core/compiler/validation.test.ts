import { describe, expect, it } from 'vitest';
import {
  EvaluationDefinitionError,
  prepareEvaluationPlan,
  type PreparationRuntime,
} from '../../../src/eval-core/compiler/index.js';
import {
  derivePlannedEvaluationCoordinates,
  type RuntimeIdentity,
} from '../../../src/eval-core/contracts/index.js';
import {
  validateAnalysisInputs,
  validateDefinitionSemantics,
  validateMaterializedAnalysisSemantics,
  validateMaterializedDecisionSemantics,
} from '../../../src/eval-core/compiler/validation.js';
import { testRuntime, validDefinition, validPolicy } from './fixtures.js';

function independentDefinition() {
  const definition = validDefinition();
  definition.dataset.samples = Array.from({ length: 8 }, (_, index) => ({
    ...structuredClone(definition.dataset.samples[0]),
    sampleId: `sample-${index + 1}`,
    executionContext: { stratum: index < 4 ? 'a' : 'b' },
  }));
  definition.experiment.assignment = {
    assignmentKind: 'independent-groups',
    algorithmId: 'assignment.stratified-fixed-quota/v1',
    stratumKey: '/executionContext/stratum',
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
    estimatorId: 'bootstrap.unpaired-difference-percentile/v1',
    seedCoupling: 'independent-by-target',
  };
  return definition;
}

async function expectCode(
  definition: unknown,
  policy: unknown,
  code: string,
  runtime: PreparationRuntime = testRuntime(),
): Promise<void> {
  try {
    await prepareEvaluationPlan(definition, policy, runtime);
    throw new Error('expected prepareEvaluationPlan to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluationDefinitionError);
    expect(error).toMatchObject({ code });
  }
}

describe('Compiler definition validation', () => {
  it('does not let arbitrary estimators impersonate a composite comparison', () => {
    const definition = validDefinition();
    const node = definition.analysisGraph.nodes[0];
    if (node === undefined) throw new Error('Expected one analysis node.');
    node.inputs = [
      { inputKind: 'metric-observations', referenceId: 'correct' },
      { inputKind: 'metric-observations', referenceId: 'source-score' },
      {
        inputKind: 'comparison',
        referenceId: 'control-vs-treatment',
        treatmentTargetId: 'treatment',
        metricId: 'derived-score',
      },
    ];
    node.parameters = {
      compositeMetricId: 'derived-score',
      components: [
        { metricId: 'correct', weight: 0.5 },
        { metricId: 'source-score', weight: 0.5 },
      ],
    };
    definition.metrics.push({
      metricId: 'source-score',
      valueType: 'numeric',
      scope: 'sample',
      scale: { min: 0, max: 1 },
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    }, {
      metricId: 'derived-score',
      valueType: 'numeric',
      scope: 'sample',
      scale: { min: 0, max: 1 },
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    });
    definition.evaluators[0].metricIds.push('source-score');
    definition.comparisons[0].metricIds.push('derived-score');
    definition.decisionPolicy = {
      decisionPolicyId: 'derived-decision',
      implementationId: 'progress/v2',
      analysisResultIds: [node.outputResultId],
      comparisonFamily: [{
        comparisonId: 'control-vs-treatment',
        treatmentTargetId: 'treatment',
        metricId: 'derived-score',
        analysisResultId: node.outputResultId,
      }],
      minimumEvidenceStatus: 'complete',
      parameters: { threshold: 0, equivalence: 0 },
    };

    expect(() => validateDefinitionSemantics(definition, validPolicy())).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_MISSING_REFERENCE' }),
    );
  });

  function simultaneousIntervalDefinition() {
    const definition = validDefinition();
    definition.metrics.push({
      ...structuredClone(definition.metrics[0]),
      metricId: 'safety',
    });
    definition.evaluators[0].metricIds.push('safety');
    definition.comparisons[0].metricIds.push('safety');
    definition.analysisGraph.nodes = [
      {
        analysisNodeKind: 'estimator',
        nodeId: 'correct-interval',
        implementationId: 'bootstrap.paired-difference-percentile/v1',
        inputs: [
          { inputKind: 'metric-observations', referenceId: 'correct' },
          {
            inputKind: 'comparison',
            referenceId: 'control-vs-treatment',
            treatmentTargetId: 'treatment',
            metricId: 'correct',
          },
        ],
        outputResultId: 'correct-result',
        parameters: { alpha: 0.025, resamples: 1000 },
      },
      {
        analysisNodeKind: 'estimator',
        nodeId: 'safety-interval',
        implementationId: 'bootstrap.paired-difference-percentile/v1',
        inputs: [
          { inputKind: 'metric-observations', referenceId: 'safety' },
          {
            inputKind: 'comparison',
            referenceId: 'control-vs-treatment',
            treatmentTargetId: 'treatment',
            metricId: 'safety',
          },
        ],
        outputResultId: 'safety-result',
        parameters: { alpha: 0.025, resamples: 1000 },
      },
      {
        analysisNodeKind: 'correction',
        nodeId: 'release-family',
        implementationId: 'simultaneous-intervals.bonferroni/v1',
        inputs: [
          { inputKind: 'analysis-result', referenceId: 'correct-result' },
          { inputKind: 'analysis-result', referenceId: 'safety-result' },
        ],
        outputResultId: 'release-family-result',
        parameters: { familyConfidenceLevel: 0.95, resamples: 1000 },
      },
    ];
    definition.decisionPolicy = undefined;
    return definition;
  }

  it('seals canonical simultaneous-interval family membership and Bonferroni parameters', () => {
    const valid = simultaneousIntervalDefinition();
    expect(() => validateDefinitionSemantics(valid, validPolicy())).not.toThrow();
    expect(() => validateMaterializedAnalysisSemantics(valid)).not.toThrow();

    const nonCanonical = simultaneousIntervalDefinition();
    nonCanonical.analysisGraph.nodes[2].inputs.reverse();
    expect(() => validateDefinitionSemantics(nonCanonical, validPolicy())).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID' }),
    );

    const wrongAlpha = simultaneousIntervalDefinition();
    const parameters = wrongAlpha.analysisGraph.nodes[0].parameters as Record<string, unknown>;
    parameters.alpha = 0.05;
    expect(() => validateMaterializedAnalysisSemantics(wrongAlpha)).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID' }),
    );

    const duplicateContrast = simultaneousIntervalDefinition();
    duplicateContrast.analysisGraph.nodes[1].inputs = structuredClone(
      duplicateContrast.analysisGraph.nodes[0].inputs,
    );
    expect(() => validateMaterializedAnalysisSemantics(duplicateContrast)).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID' }),
    );

    const nonEstimator = simultaneousIntervalDefinition();
    nonEstimator.analysisGraph.nodes[0].analysisNodeKind = 'reducer';
    expect(() => validateMaterializedAnalysisSemantics(nonEstimator)).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID' }),
    );
  });

  it('rejects schema and semantic failures before any runtime resolution', async () => {
    const schemaRuntime = testRuntime();
    await expectCode(
      { ...validDefinition(), typo: true },
      validPolicy(),
      'EVAL_DEFINITION_SCHEMA_INVALID',
      schemaRuntime,
    );
    expect(schemaRuntime.calls).toEqual({ executor: 0, evaluator: 0, analysis: 0, extension: 0 });

    const duplicate = validDefinition();
    duplicate.dataset.samples.push(structuredClone(duplicate.dataset.samples[0]));
    const semanticRuntime = testRuntime();
    await expectCode(
      duplicate,
      validPolicy(),
      'EVAL_DEFINITION_DUPLICATE_ID',
      semanticRuntime,
    );
    expect(semanticRuntime.calls).toEqual({ executor: 0, evaluator: 0, analysis: 0, extension: 0 });
  });

  it.each(['input', 'expected'] as const)(
    'rejects the removed EvidencePolicy.%s field without compatibility parsing',
    async (field) => {
      const policy = structuredClone(validPolicy()) as unknown as {
        evidence: Record<string, unknown>;
      };
      policy.evidence[field] = 'full';
      const runtime = testRuntime();

      await expectCode(
        validDefinition(),
        policy,
        'EVAL_DEFINITION_SCHEMA_INVALID',
        runtime,
      );
      expect(runtime.calls).toEqual({ executor: 0, evaluator: 0, analysis: 0, extension: 0 });
    },
  );

  it('rejects missing references and invalid Metric value domains', async () => {
    const missing = validDefinition();
    missing.evaluators[0].metricIds = ['missing'];
    await expectCode(
      missing,
      validPolicy(),
      'EVAL_DEFINITION_MISSING_REFERENCE',
    );

    const invalidDomain = validDefinition();
    invalidDomain.metrics[0] = {
      ...invalidDomain.metrics[0],
      valueType: 'boolean',
      scale: { min: 0, max: 1 },
    };
    await expectCode(
      invalidDomain,
      validPolicy(),
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
    );
  });

  it('seals Evaluator applicability and omits non-applicable evaluation coordinates', async () => {
    const definition = validDefinition();
    definition.dataset.samples.push({
      sampleId: 'sample-2',
      input: { question: 'Q2' },
      expected: { incompatible: true },
    });
    definition.evaluators[0].applicableSampleIds = ['sample-1'];

    const plan = await prepareEvaluationPlan(definition, validPolicy(), testRuntime());
    const coordinates = derivePlannedEvaluationCoordinates(plan);

    expect(coordinates).toHaveLength(2);
    expect(coordinates.every((coordinate) => coordinate.sampleId === 'sample-1')).toBe(true);
  });

  it('rejects duplicate or unknown Evaluator applicability references', async () => {
    const duplicate = validDefinition();
    duplicate.evaluators[0].applicableSampleIds = ['sample-1', 'sample-1'];
    await expectCode(duplicate, validPolicy(), 'EVAL_DEFINITION_DUPLICATE_ID');

    const unknown = validDefinition();
    unknown.evaluators[0].applicableSampleIds = ['missing-sample'];
    await expectCode(unknown, validPolicy(), 'EVAL_DEFINITION_MISSING_REFERENCE');
  });

  it('rejects ambiguous or unknown sample execution-control overrides', async () => {
    const duplicate = validDefinition();
    duplicate.targets[0].executionControls.sampleOverrides = [
      { sampleId: 'sample-1', tools: { toolPolicyKind: 'allow-list', allowedTools: [] } },
      { sampleId: 'sample-1', workspace: { workspaceMode: 'not-required' } },
    ];
    duplicate.targets[0].executionRequirements.toolPolicy = 'allow-list';
    await expectCode(duplicate, validPolicy(), 'EVAL_DEFINITION_DUPLICATE_ID');

    const unknown = validDefinition();
    unknown.targets[0].executionControls.sampleOverrides = [{
      sampleId: 'missing-sample',
      tools: { toolPolicyKind: 'allow-list', allowedTools: [] },
    }];
    unknown.targets[0].executionRequirements.toolPolicy = 'allow-list';
    await expectCode(unknown, validPolicy(), 'EVAL_DEFINITION_MISSING_REFERENCE');

    const duplicateTools = validDefinition();
    duplicateTools.targets[0].executionControls.defaults.tools = {
      toolPolicyKind: 'allow-list',
      allowedTools: ['read', 'read'],
    };
    duplicateTools.targets[0].executionRequirements.toolPolicy = 'allow-list';
    await expectCode(duplicateTools, validPolicy(), 'EVAL_DEFINITION_DUPLICATE_ID');
  });

  it('requires every applicable sample to satisfy evaluator input bindings', async () => {
    const definition = validDefinition();
    definition.dataset.samples.push({
      sampleId: 'sample-2',
      input: { question: 'Q2' },
    });
    definition.evaluators[0].applicableSampleIds = ['sample-1', 'sample-2'];

    await expectCode(definition, validPolicy(), 'EVAL_DEFINITION_MISSING_REFERENCE');
  });

  it('requires execution-facts bindings to consume the complete canonical projection', async () => {
    const definition = validDefinition();
    definition.evaluators[0].inputs = [{
      bindingId: 'facts',
      sourceKind: 'execution-facts',
      pointer: '/usage',
    }];

    await expectCode(
      definition,
      validPolicy(),
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
    );
  });

  it('rejects AnalysisGraph cycles and duplicate outputs', async () => {
    const cycle = validDefinition();
    cycle.analysisGraph.nodes = [
      {
        analysisNodeKind: 'reducer',
        nodeId: 'a',
        implementationId: 'reducer-a/v1',
        inputs: [{ inputKind: 'analysis-result', referenceId: 'result-b' }],
        outputResultId: 'result-a',
      },
      {
        analysisNodeKind: 'reducer',
        nodeId: 'b',
        implementationId: 'reducer-b/v1',
        inputs: [{ inputKind: 'analysis-result', referenceId: 'result-a' }],
        outputResultId: 'result-b',
      },
    ];
    cycle.decisionPolicy!.analysisResultIds = ['result-a'];
    await expectCode(cycle, validPolicy(), 'EVAL_DEFINITION_GRAPH_CYCLE');

    const duplicate = validDefinition();
    duplicate.analysisGraph.nodes.push({
      ...structuredClone(duplicate.analysisGraph.nodes[0]),
      nodeId: 'second-node',
    });
    await expectCode(
      duplicate,
      validPolicy(),
      'EVAL_DEFINITION_DUPLICATE_ID',
    );
  });

  it('rejects duplicate or unknown Analysis target filters before runtime resolution', async () => {
    const duplicate = validDefinition();
    duplicate.analysisGraph.nodes[0].targetFilter = {
      includeTargetIds: ['control', 'control'],
    };
    const duplicateRuntime = testRuntime();
    await expectCode(
      duplicate,
      validPolicy(),
      'EVAL_DEFINITION_DUPLICATE_ID',
      duplicateRuntime,
    );
    expect(duplicateRuntime.calls).toEqual({ executor: 0, evaluator: 0, analysis: 0, extension: 0 });

    const unknown = validDefinition();
    unknown.analysisGraph.nodes[0].targetFilter = {
      includeTargetIds: ['missing-target'],
    };
    const unknownRuntime = testRuntime();
    await expectCode(
      unknown,
      validPolicy(),
      'EVAL_DEFINITION_MISSING_REFERENCE',
      unknownRuntime,
    );
    expect(unknownRuntime.calls).toEqual({ executor: 0, evaluator: 0, analysis: 0, extension: 0 });
  });

  it('rejects an empty Analysis cohort filter before runtime resolution', async () => {
    const definition = validDefinition();
    definition.analysisGraph.nodes[0].cohortFilter = {};
    const runtime = testRuntime();
    await expectCode(
      definition,
      validPolicy(),
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      runtime,
    );
    expect(runtime.calls).toEqual({ executor: 0, evaluator: 0, analysis: 0, extension: 0 });
  });

  it('rejects inconsistent SamplingDesign and MeasurementPolicy combinations', async () => {
    const sampling = validDefinition();
    sampling.experiment.trials = 2;
    await expectCode(
      sampling,
      validPolicy(),
      'EVAL_DEFINITION_POLICY_INVALID',
    );

    const policy = validPolicy();
    policy.failure = { failureMode: 'failure-threshold' };
    await expectCode(
      validDefinition(),
      policy,
      'EVAL_DEFINITION_POLICY_INVALID',
    );
  });

  it('requires a canonical one-to-one randomization slot for every Target', async () => {
    const missing = validDefinition();
    missing.experiment.randomizationSlots.pop();
    await expectCode(missing, validPolicy(), 'EVAL_DEFINITION_POLICY_INVALID');

    const duplicate = validDefinition();
    duplicate.experiment.randomizationSlots[1] = {
      ...duplicate.experiment.randomizationSlots[1],
      randomizationSlotId: duplicate.experiment.randomizationSlots[0].randomizationSlotId,
    };
    await expectCode(duplicate, validPolicy(), 'EVAL_DEFINITION_DUPLICATE_ID');

    const nonCanonical = validDefinition();
    nonCanonical.experiment.randomizationSlots.reverse();
    await expectCode(nonCanonical, validPolicy(), 'EVAL_DEFINITION_POLICY_INVALID');
  });

  it('fails closed when independent assignment minima cannot be satisfied', async () => {
    const definition = independentDefinition();
    if (definition.experiment.assignment.assignmentKind !== 'independent-groups') return;
    definition.experiment.assignment.minimumUnitsPerTargetPerStratum = 3;
    const runtime = testRuntime({ samplingAssignmentKinds: ['independent-groups'] });

    await expectCode(
      definition,
      validPolicy(),
      'EVAL_DEFINITION_POLICY_INVALID',
      runtime,
    );
    expect(runtime.calls).toEqual({ executor: 0, evaluator: 0, analysis: 0, extension: 0 });
  });

  it('requires estimator capabilities to match the sealed assignment kind', async () => {
    await expectCode(
      independentDefinition(),
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ samplingAssignmentKinds: ['complete-block'] }),
    );
    await expectCode(
      validDefinition(),
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ samplingAssignmentKinds: ['independent-groups'] }),
    );

    const plan = await prepareEvaluationPlan(
      independentDefinition(),
      validPolicy(),
      testRuntime({ samplingAssignmentKinds: ['independent-groups'] }),
    );
    expect(plan.execution.assignments).toHaveLength(8);
  });

  it('rejects a Runtime that hides behavior-affecting facts in provenance facets', async () => {
    const base = testRuntime();
    const runtime: PreparationRuntime = {
      ...base,
      async resolveExecutor(requirement) {
        const resolution = await base.resolveExecutor(requirement) as {
          identity: RuntimeIdentity;
          satisfiesVersionConstraint: boolean;
        };
        return {
          ...resolution,
          identity: {
            ...resolution.identity,
            provenanceFacets: { deployment: 'hidden-behavior-change' },
          },
        };
      },
    };

    await expectCode(
      validDefinition(),
      validPolicy(),
      'EVAL_DEFINITION_RUNTIME_RESOLUTION_FAILED',
      runtime,
    );
  });

  it('keeps scheduling pointers inside the execution-visible projection', async () => {
    const definition = validDefinition();
    definition.experiment.sampling = {
      ...definition.experiment.sampling,
      pairingKey: '/expected/answer',
      resamplingUnit: 'paired-block',
    };
    await expectCode(
      definition,
      validPolicy(),
      'EVAL_DEFINITION_MISSING_REFERENCE',
    );
  });

  it('treats overlapping paired comparisons as one atomic scheduling group', async () => {
    const definition = validDefinition();
    definition.targets.push({
      ...structuredClone(definition.targets[1]),
      targetId: 'treatment-b',
    });
    definition.experiment.randomizationSlots.push({
      targetId: 'treatment-b',
      randomizationSlotId: 'slot-treatment-b',
    });
    definition.comparisons.push({
      comparisonId: 'treatment-vs-treatment-b',
      controlTargetId: 'treatment',
      treatmentTargetIds: ['treatment-b'],
      metricIds: ['correct'],
    });
    definition.experiment.sampling.pairingKey = '/input/cohort';
    definition.experiment.sampling.resamplingUnit = 'paired-block';
    definition.experiment.scheduling = {
      schedulingKind: 'randomized-block',
      blockSize: 2,
    };
    await expectCode(
      definition,
      validPolicy(),
      'EVAL_DEFINITION_POLICY_INVALID',
      testRuntime({ samplingResamplingUnits: ['paired-block'] }),
    );

    definition.experiment.scheduling = { schedulingKind: 'interleaved' };
    const policy = validPolicy();
    policy.budget.stages.execution.maxInvocations = 2;
    await expectCode(
      definition,
      policy,
      'EVAL_DEFINITION_POLICY_INVALID',
      testRuntime({ samplingResamplingUnits: ['paired-block'] }),
    );

    const stricterRunPolicy = validPolicy();
    stricterRunPolicy.budget.run.maxInvocations = 2;
    stricterRunPolicy.budget.stages.execution.maxInvocations = 100;
    await expectCode(
      definition,
      stricterRunPolicy,
      'EVAL_DEFINITION_POLICY_INVALID',
      testRuntime({ samplingResamplingUnits: ['paired-block'] }),
    );
  });

  it('retains normalized provider-cost capabilities in the sealed runtime identity', async () => {
    const plan = await prepareEvaluationPlan(
      validDefinition(),
      validPolicy(),
      testRuntime({
        evaluatorProviderCost: {
          reporting: 'required',
          trustedUpperBound: { amount: 0.5, currency: 'USD' },
        },
      }),
    );
    const runtime = plan.evaluation.runtimes.find((candidate) => (
      candidate.runtimeKind === 'evaluator'
    ));
    expect(runtime?.identity.capabilities).toMatchObject({
      providerCost: {
        reporting: 'required',
        trustedUpperBound: { amount: 0.5, currency: 'USD' },
      },
    });
  });

  it.each(['native', 'prepended'] as const)(
    'accepts %s system-instruction delivery and seals the actual mode',
    async (systemInstructions) => {
      const definition = validDefinition();
      definition.targets[0].executionRequirements.systemInstructions = 'required';
      const plan = await prepareEvaluationPlan(
        definition,
        validPolicy(),
        testRuntime({ systemInstructions }),
      );
      const runtime = plan.execution.runtimes.find((candidate) => (
        candidate.runtimeKind === 'executor' && candidate.referenceId === 'control'
      ));
      expect(runtime?.identity.capabilities).toMatchObject({
        protocols: [{ execution: { features: { systemInstructions } } }],
      });
    },
  );

  it('treats the actual system-instruction delivery mode as execution design identity', async () => {
    const definition = validDefinition();
    definition.targets[0].executionRequirements.systemInstructions = 'required';
    const native = await prepareEvaluationPlan(
      definition,
      validPolicy(),
      testRuntime({ systemInstructions: 'native' }),
    );
    const prepended = await prepareEvaluationPlan(
      definition,
      validPolicy(),
      testRuntime({ systemInstructions: 'prepended' }),
    );

    expect(prepended.execution.executionPlanDigest)
      .not.toBe(native.execution.executionPlanDigest);
  });

  it('matches every Target execution requirement against the selected protocol', async () => {
    const required = validDefinition();
    required.targets[0].executionRequirements = {
      systemInstructions: 'required',
      workspace: 'copy-on-write-overlay',
      mcp: 'native-config',
      mockInterception: 'pre-tool-call',
      toolPolicy: 'allow-list',
      skillDiscovery: 'disabled',
      sandboxId: 'sandbox-required',
    };
    required.targets[0].executionControls = {
      defaults: {
        workspace: {
          workspaceMode: 'copy-on-write-overlay',
          descriptor: {
            resourceId: 'workspace-1',
            digest: `sha256:${'a'.repeat(64)}`,
            mediaType: 'application/vnd.omk.workspace-tree',
            classification: 'sensitive',
            size: 1,
          },
        },
        tools: { toolPolicyKind: 'allow-list', allowedTools: ['read'] },
      },
      sampleOverrides: [],
    };

    await expectCode(
      required,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ systemInstructions: 'unsupported', sandboxIds: ['sandbox-required'] }),
    );
    await expectCode(
      required,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ workspace: [], sandboxIds: ['sandbox-required'] }),
    );
    await expectCode(
      required,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ mcp: [], sandboxIds: ['sandbox-required'] }),
    );
    await expectCode(
      required,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ mockInterception: [], sandboxIds: ['sandbox-required'] }),
    );
    await expectCode(
      required,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ toolPolicies: ['runtime-default'], sandboxIds: ['sandbox-required'] }),
    );
    await expectCode(
      required,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ skillDiscovery: ['runtime-default'], sandboxIds: ['sandbox-required'] }),
    );
    await expectCode(
      required,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ sandboxIds: [] }),
    );

    await expect(prepareEvaluationPlan(
      required,
      validPolicy(),
      testRuntime({ sandboxIds: ['sandbox-required'] }),
    )).resolves.toBeDefined();

    const skillAllowList = structuredClone(required);
    skillAllowList.targets[0].executionRequirements.skillDiscovery = 'allow-list';
    await expectCode(
      skillAllowList,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({
        skillDiscovery: ['disabled', 'runtime-default'],
        sandboxIds: ['sandbox-required'],
      }),
    );
    await expect(prepareEvaluationPlan(
      skillAllowList,
      validPolicy(),
      testRuntime({ sandboxIds: ['sandbox-required'] }),
    )).resolves.toBeDefined();
  });

  it('does not require optional features when the Target declares none', async () => {
    await expect(prepareEvaluationPlan(
      validDefinition(),
      validPolicy(),
      testRuntime({
        systemInstructions: 'unsupported',
        workspace: [],
        mcp: [],
        mockInterception: [],
        toolPolicies: ['runtime-default'],
        skillDiscovery: ['runtime-default'],
        sandboxIds: [],
      }),
    )).resolves.toBeDefined();
  });

  it('rejects duplicate feature declarations and seals canonical capability order', async () => {
    await expectCode(
      validDefinition(),
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ omitExecutorCapabilitySchemaVersion: true }),
    );
    await expectCode(
      validDefinition(),
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ toolPolicies: ['runtime-default', 'runtime-default'] }),
    );

    const plan = await prepareEvaluationPlan(
      validDefinition(),
      validPolicy(),
      testRuntime({
        toolPolicies: ['runtime-default', 'allow-list'],
        skillDiscovery: ['runtime-default', 'disabled', 'allow-list'],
        sandboxIds: ['sandbox-z', 'sandbox-a'],
      }),
    );
    const runtime = plan.execution.runtimes[0];
    expect(runtime.identity.capabilities).toMatchObject({
      protocols: [{
        execution: {
          features: {
            toolPolicies: ['allow-list', 'runtime-default'],
            skillDiscovery: ['allow-list', 'disabled', 'runtime-default'],
            sandboxIds: ['sandbox-a', 'sandbox-z'],
          },
        },
      }],
    });
  });

  it('rejects unsupported protocol, deterministic cache, and evaluator capabilities', async () => {
    const protocol = validDefinition();
    protocol.targets[0].protocolId = 'omk.session/v1';
    await expectCode(
      protocol,
      validPolicy(),
      'EVAL_DEFINITION_PROTOCOL_INVALID',
    );

    const cachePolicy = validPolicy();
    cachePolicy.cache.executionMode = 'transparent-deterministic';
    await expectCode(
      validDefinition(),
      cachePolicy,
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ deterministic: false }),
    );

    await expectCode(
      validDefinition(),
      cachePolicy,
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ executorAssurance: 'declared' }),
    );

    await expectCode(
      validDefinition(),
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ evaluatorValueTypes: ['numeric'] }),
    );

    const executionFacts = validDefinition();
    executionFacts.evaluators[0].inputs = [{
      bindingId: 'facts',
      sourceKind: 'execution-facts',
      pointer: '',
    }];
    await expectCode(
      executionFacts,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({
        evaluatorInputSourceKinds: ['output', 'expected', 'evaluation-context'],
      }),
    );
  });

  it('rejects capture, cancellation, trace, and session-isolation mismatches', async () => {
    const capturePolicy = validPolicy();
    capturePolicy.evidence.output = 'digest';
    await expectCode(
      validDefinition(),
      capturePolicy,
      'EVAL_DEFINITION_POLICY_INVALID',
    );

    await expectCode(
      validDefinition(),
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ cancellation: 'unsupported' }),
    );

    const traceDefinition = validDefinition();
    traceDefinition.evaluators[0].inputs.push({
      bindingId: 'trajectory',
      sourceKind: 'trace',
      pointer: '',
    });
    await expectCode(
      traceDefinition,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime(),
    );

    const sessionDefinition = validDefinition();
    sessionDefinition.targets[0].protocolId = 'omk.session/v1';
    await expectCode(
      sessionDefinition,
      validPolicy(),
      'EVAL_DEFINITION_PROTOCOL_INVALID',
      testRuntime({
        executorProtocols: ['omk.invoke/v1', 'omk.session/v1'],
        trialState: 'stateless',
      }),
    );
  });

  it('binds seed coupling to Runtime seed-control capability', async () => {
    await expectCode(
      validDefinition(),
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ deterministic: false, seedControl: 'unsupported' }),
    );

    const uncontrolled = validDefinition();
    uncontrolled.experiment.sampling.seedCoupling = 'uncontrolled';
    await expectCode(
      uncontrolled,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ deterministic: false, seedControl: 'required' }),
    );
    await expect(prepareEvaluationPlan(
      uncontrolled,
      validPolicy(),
      testRuntime({ deterministic: false, seedControl: 'unsupported' }),
    )).resolves.toBeDefined();
  });

  it('rejects Analysis value-domain and SamplingDesign capability mismatches', async () => {
    await expectCode(
      validDefinition(),
      validPolicy(),
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      testRuntime({ analysisValueTypes: ['numeric'] }),
    );
    await expectCode(
      validDefinition(),
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      testRuntime({ samplingResamplingUnits: ['cluster'] }),
    );
  });

  it('rejects an Analysis node that exceeds its sealed Metric input cardinality', async () => {
    const definition = validDefinition();
    definition.metrics.push({
      ...structuredClone(definition.metrics[0]),
      metricId: 'correct-secondary',
    });
    definition.evaluators[0].metricIds.push('correct-secondary');
    definition.analysisGraph.nodes[0].inputs.push({
      inputKind: 'metric-observations',
      referenceId: 'correct-secondary',
    });

    await expectCode(
      definition,
      validPolicy(),
      'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
    );
  });

  it('requires an explicit and internally consistent multiple-comparison family', async () => {
    const unboundSingleton = validDefinition();
    unboundSingleton.decisionPolicy!.comparisonFamily = [{
      comparisonId: 'control-vs-treatment',
      treatmentTargetId: 'treatment',
      metricId: 'correct',
      analysisResultId: 'correct-rate',
    }];
    await expectCode(
      unboundSingleton,
      validPolicy(),
      'EVAL_DEFINITION_MISSING_REFERENCE',
    );

    const missingContrast = validDefinition();
    missingContrast.decisionPolicy!.comparisonFamily = [{
      comparisonId: 'missing-comparison',
      treatmentTargetId: 'treatment',
      metricId: 'correct',
      analysisResultId: 'correct-rate',
    }];
    await expectCode(
      missingContrast,
      validPolicy(),
      'EVAL_DEFINITION_MISSING_REFERENCE',
    );

    const uncorrectedFamily = validDefinition();
    uncorrectedFamily.targets.push({
      ...structuredClone(uncorrectedFamily.targets[1]),
      targetId: 'treatment-secondary',
    });
    uncorrectedFamily.comparisons[0].treatmentTargetIds.push('treatment-secondary');
    uncorrectedFamily.decisionPolicy!.comparisonFamily = [
      {
        comparisonId: 'control-vs-treatment',
        treatmentTargetId: 'treatment',
        metricId: 'correct',
        analysisResultId: 'correct-rate',
      },
      {
        comparisonId: 'control-vs-treatment',
        treatmentTargetId: 'treatment-secondary',
        metricId: 'correct',
        analysisResultId: 'missing-result',
      },
    ];
    await expectCode(
      uncorrectedFamily,
      validPolicy(),
      'EVAL_DEFINITION_MISSING_REFERENCE',
    );

    const disguisedSingleTest = validDefinition();
    disguisedSingleTest.decisionPolicy!.comparisonFamily = [{
      comparisonId: 'control-vs-treatment',
      treatmentTargetId: 'treatment',
      metricId: 'correct',
      analysisResultId: 'correct-rate',
    }];
    disguisedSingleTest.decisionPolicy!.multipleComparisonPolicyId = 'bonferroni/v1';
    await expectCode(
      disguisedSingleTest,
      validPolicy(),
      'EVAL_DEFINITION_MISSING_REFERENCE',
    );
  });

  it('binds every family member to an exact and exclusive contrast producer', () => {
    const definition = validDefinition();
    definition.targets.push({
      ...structuredClone(definition.targets[1]),
      targetId: 'treatment-secondary',
    });
    definition.experiment.randomizationSlots.push({
      targetId: 'treatment-secondary',
      randomizationSlotId: 'slot-treatment-secondary',
    });
    if (definition.experiment.assignment.assignmentKind === 'complete-block') {
      definition.experiment.assignment.randomizationSlotIds.push('slot-treatment-secondary');
    }
    definition.comparisons[0].treatmentTargetIds.push('treatment-secondary');
    definition.analysisGraph.nodes = [
      {
        analysisNodeKind: 'estimator',
        nodeId: 'raw-primary',
        implementationId: 'hypothesis/v1',
          inputs: [
            { inputKind: 'metric-observations', referenceId: 'correct' },
            {
              inputKind: 'comparison',
              referenceId: 'control-vs-treatment',
              treatmentTargetId: 'treatment',
              metricId: 'correct',
          },
        ],
        outputResultId: 'raw-primary-result',
      },
      {
        analysisNodeKind: 'estimator',
        nodeId: 'raw-secondary',
        implementationId: 'hypothesis/v1',
        inputs: [
          { inputKind: 'metric-observations', referenceId: 'correct' },
          {
            inputKind: 'comparison',
            referenceId: 'control-vs-treatment',
            treatmentTargetId: 'treatment-secondary',
            metricId: 'correct',
          },
        ],
        outputResultId: 'raw-secondary-result',
      },
      {
        analysisNodeKind: 'correction',
        nodeId: 'correct-family',
        implementationId: 'bonferroni/v1',
        inputs: [
          { inputKind: 'analysis-result', referenceId: 'raw-primary-result' },
          { inputKind: 'analysis-result', referenceId: 'raw-secondary-result' },
        ],
        outputResultId: 'corrected-result',
      },
    ];
    definition.decisionPolicy = {
      decisionPolicyId: 'release-gate',
      implementationId: 'progress/v1',
      analysisResultIds: ['corrected-result'],
      comparisonFamily: [
        {
          hypothesisId: 'h-primary',
          analysisResultId: 'raw-primary-result',
          comparisonId: 'control-vs-treatment',
          treatmentTargetId: 'treatment',
          metricId: 'correct',
        },
        {
          hypothesisId: 'h-secondary',
          analysisResultId: 'raw-secondary-result',
          comparisonId: 'control-vs-treatment',
          treatmentTargetId: 'treatment-secondary',
          metricId: 'correct',
        },
      ],
      multipleComparisonPolicyId: 'bonferroni/v1',
      minimumEvidenceStatus: 'complete',
    };

    expect(() => validateDefinitionSemantics(definition, validPolicy())).not.toThrow();
    definition.analysisGraph.nodes[0].inputs.push({
      inputKind: 'analysis-result',
      referenceId: 'raw-secondary-result',
    });
    expect(() => validateDefinitionSemantics(definition, validPolicy())).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_MISSING_REFERENCE' }),
    );
    definition.analysisGraph.nodes[0].inputs.pop();
    definition.decisionPolicy.comparisonFamilyResultId = 'corrected-result';
    expect(() => validateDefinitionSemantics(definition, validPolicy())).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_MISSING_REFERENCE' }),
    );
    definition.decisionPolicy.comparisonFamily = definition.decisionPolicy.comparisonFamily?.map(
      (member) => {
        if (!('hypothesisId' in member)) return member;
        return {
          analysisResultId: member.analysisResultId,
          comparisonId: member.comparisonId,
          treatmentTargetId: member.treatmentTargetId,
          metricId: member.metricId,
        };
      },
    );
    expect(() => validateDefinitionSemantics(definition, validPolicy())).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_MISSING_REFERENCE' }),
    );
  });

  it('binds one authoritative family result to distinct exact member results', () => {
    const definition = validDefinition();
    definition.targets.push({
      ...structuredClone(definition.targets[1]),
      targetId: 'treatment-secondary',
    });
    definition.experiment.randomizationSlots.push({
      targetId: 'treatment-secondary',
      randomizationSlotId: 'slot-treatment-secondary',
    });
    if (definition.experiment.assignment.assignmentKind === 'complete-block') {
      definition.experiment.assignment.randomizationSlotIds.push('slot-treatment-secondary');
    }
    definition.comparisons[0].treatmentTargetIds.push('treatment-secondary');
    definition.analysisGraph.nodes = [{
      analysisNodeKind: 'estimator',
      nodeId: 'primary-member',
      implementationId: 'interval/v1',
      inputs: [
        { inputKind: 'metric-observations', referenceId: 'correct' },
        {
          inputKind: 'comparison',
          referenceId: 'control-vs-treatment',
          treatmentTargetId: 'treatment',
          metricId: 'correct',
        },
      ],
      outputResultId: 'primary-result',
    }, {
      analysisNodeKind: 'estimator',
      nodeId: 'secondary-member',
      implementationId: 'interval/v1',
      inputs: [
        { inputKind: 'metric-observations', referenceId: 'correct' },
        {
          inputKind: 'comparison',
          referenceId: 'control-vs-treatment',
          treatmentTargetId: 'treatment-secondary',
          metricId: 'correct',
        },
      ],
      outputResultId: 'secondary-result',
    }, {
      analysisNodeKind: 'correction',
      nodeId: 'family-result',
      implementationId: 'family-standard/v1',
      inputs: [
        { inputKind: 'analysis-result', referenceId: 'primary-result' },
        { inputKind: 'analysis-result', referenceId: 'secondary-result' },
      ],
      outputResultId: 'authoritative-family',
    }];
    definition.decisionPolicy = {
      decisionPolicyId: 'release-gate',
      implementationId: 'progress/v1',
      analysisResultIds: ['authoritative-family'],
      comparisonFamily: [
        {
          comparisonId: 'control-vs-treatment',
          treatmentTargetId: 'treatment',
          metricId: 'correct',
          analysisResultId: 'primary-result',
        },
        {
          comparisonId: 'control-vs-treatment',
          treatmentTargetId: 'treatment-secondary',
          metricId: 'correct',
          analysisResultId: 'secondary-result',
        },
      ],
      comparisonFamilyResultId: 'authoritative-family',
      multipleComparisonPolicyId: 'family-standard/v1',
      minimumEvidenceStatus: 'complete',
    };

    expect(() => validateDefinitionSemantics(definition, validPolicy())).not.toThrow();
    const singletonDefinition = structuredClone(definition);
    if (singletonDefinition.decisionPolicy === undefined) throw new Error('missing policy');
    singletonDefinition.decisionPolicy.comparisonFamily =
      singletonDefinition.decisionPolicy.comparisonFamily?.slice(0, 1);
    singletonDefinition.decisionPolicy.multipleComparisonPolicyId = undefined;
    expect(() => validateDefinitionSemantics(singletonDefinition, validPolicy())).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_MISSING_REFERENCE' }),
    );
    const releaseDefinition = structuredClone(definition);
    if (releaseDefinition.decisionPolicy === undefined) throw new Error('missing policy');
    releaseDefinition.decisionPolicy.implementationId = 'release-family/v1';
    releaseDefinition.decisionPolicy.multipleComparisonPolicyId =
      'simultaneous-intervals.bonferroni/v1';
    releaseDefinition.decisionPolicy.parameters = {
      rule: 'all',
      criteria: [
        { analysisResultId: 'primary-result', minimumEffect: 0 },
        { analysisResultId: 'secondary-result', maximumEffect: 1 },
      ],
    };
    expect(() => validateMaterializedDecisionSemantics(releaseDefinition)).not.toThrow();
    releaseDefinition.decisionPolicy.analysisResultIds.push('primary-result');
    expect(() => validateMaterializedDecisionSemantics(releaseDefinition)).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID' }),
    );

    definition.analysisGraph.nodes[2].implementationId = 'other-family/v1';
    expect(() => validateDefinitionSemantics(definition, validPolicy())).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_MISSING_REFERENCE' }),
    );
    definition.analysisGraph.nodes[2].implementationId = 'family-standard/v1';
    definition.analysisGraph.nodes[2].inputs.pop();
    expect(() => validateDefinitionSemantics(definition, validPolicy())).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_MISSING_REFERENCE' }),
    );
    definition.analysisGraph.nodes[2].inputs.push({
      inputKind: 'analysis-result',
      referenceId: 'secondary-result',
    });
    definition.decisionPolicy.comparisonFamilyResultId = 'primary-result';
    definition.decisionPolicy.analysisResultIds = ['primary-result'];
    expect(() => validateDefinitionSemantics(definition, validPolicy())).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_MISSING_REFERENCE' }),
    );
    definition.decisionPolicy.comparisonFamilyResultId = 'authoritative-family';
    definition.decisionPolicy.analysisResultIds = ['authoritative-family'];
    definition.decisionPolicy.comparisonFamily = definition.decisionPolicy.comparisonFamily?.map(
      (member) => ({ ...member, analysisResultId: 'authoritative-family' }),
    );
    definition.analysisGraph.nodes[2] = {
      ...definition.analysisGraph.nodes[2],
      analysisNodeKind: 'estimator',
      inputs: [{ inputKind: 'analysis-result', referenceId: 'primary-result' }],
    };
    expect(() => validateDefinitionSemantics(definition, validPolicy())).not.toThrow();
  });

  it('enforces declared cardinality for every Analysis input kind', () => {
    const node = {
      analysisNodeKind: 'estimator' as const,
      nodeId: 'paired',
      implementationId: 'paired/v1',
      inputs: [
        { inputKind: 'metric-observations' as const, referenceId: 'correct' },
        {
          inputKind: 'comparison' as const,
          referenceId: 'comparison-1',
          treatmentTargetId: 'treatment-1',
          metricId: 'correct',
        },
        {
          inputKind: 'comparison' as const,
          referenceId: 'comparison-2',
          treatmentTargetId: 'treatment-2',
          metricId: 'correct',
        },
      ],
      outputResultId: 'paired-result',
    };
    const schema = {
      schemaVersion: 'test/v1',
      schemaUri: 'urn:test:v1',
      schemaDigest: `sha256:${'a'.repeat(64)}`,
    };
    expect(() => validateAnalysisInputs(
      node,
      {
        capabilityKind: 'analysis-node',
        analysisNodeKinds: ['estimator'],
        inputDomains: [
          { inputKind: 'metric-observations', valueTypes: ['boolean'] },
          { inputKind: 'comparison' },
        ],
        outputSchema: schema,
        parameterSchema: schema,
        inputCardinalities: {
          metricObservations: { min: 1, max: 1 },
          analysisResults: { min: 0, max: 0 },
          comparisons: { min: 1, max: 1 },
        },
        schemas: [],
      },
      new Map([['correct', validDefinition().metrics[0]]]),
      new Map(),
    )).toThrowError(expect.objectContaining({ code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED' }));
  });

  it('keeps evaluator output record-scoped and delegates aggregation to AnalysisGraph', async () => {
    const definition = validDefinition();
    definition.metrics[0].scope = 'target';
    await expectCode(
      definition,
      validPolicy(),
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      testRuntime(),
    );
  });

  it('rejects unresolved versions and invalid extensions', async () => {
    await expectCode(
      validDefinition(),
      validPolicy(),
      'EVAL_DEFINITION_RUNTIME_RESOLUTION_FAILED',
      testRuntime({ versionSatisfied: false }),
    );

    const definition = validDefinition();
    definition.extensions = {
      'urn:example:unknown': {
        schemaUri: 'urn:example:schema:extension:v1',
        schemaDigest: `sha256:${'a'.repeat(64)}`,
        data: { enabled: true },
      },
    };
    await expectCode(
      definition,
      validPolicy(),
      'EVAL_DEFINITION_EXTENSION_INVALID',
      testRuntime(),
    );
    await expectCode(
      definition,
      validPolicy(),
      'EVAL_DEFINITION_EXTENSION_INVALID',
      testRuntime({
        extensionStages: { 'urn:example:unknown': 'execution' },
        rejectExtension: 'urn:example:unknown',
      }),
    );
  });

  it('returns equivalent error identity for property-order variations', async () => {
    const first = validDefinition();
    first.evaluators[0].metricIds = ['missing'];
    const second = structuredClone(first);
    second.dataset.samples[0].input = { cohort: 'a', question: 'Q' };

    const errors: EvaluationDefinitionError[] = [];
    for (const definition of [first, second]) {
      try {
        await prepareEvaluationPlan(definition, validPolicy(), testRuntime());
      } catch (error) {
        errors.push(error as EvaluationDefinitionError);
      }
    }
    expect(errors).toHaveLength(2);
    expect(errors[1].code).toBe(errors[0].code);
    expect(errors[1].details).toEqual(errors[0].details);
  });

  it('requires a coherent analysis partition definition', () => {
    const definition = validDefinition();
    definition.dataset.analysisCohorts = [
      {
        cohortId: 'train',
        cohortSetId: 'split',
        cohortSetKind: 'partition',
        classification: 'sensitive',
        disclosure: 'identity-only',
        derivation: { algorithmId: 'seeded-hash/v1', seed: 'split-seed' },
      },
      {
        cohortId: 'holdout',
        cohortSetId: 'split',
        cohortSetKind: 'cohort',
        classification: 'secret',
        disclosure: 'identity-only',
      },
    ];

    expect(() => validateDefinitionSemantics(definition, validPolicy())).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID' }),
    );

    definition.dataset.analysisCohorts[1].cohortSetKind = 'partition';
    expect(() => validateDefinitionSemantics(definition, validPolicy())).toThrowError(
      expect.objectContaining({ code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID' }),
    );
  });
});
