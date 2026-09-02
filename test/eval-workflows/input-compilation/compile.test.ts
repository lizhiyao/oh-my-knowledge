import { describe, expect, it } from 'vitest';
import {
  EvaluationDefinitionSchema,
  MeasurementPolicySchema,
  canonicalizeJson,
  digestCanonicalJson,
  projectAnalysisInputs,
  projectEvaluationInputs,
  projectExecutionInputs,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  CliEvaluationInputError,
  compileCliEvaluationInput,
} from '../../../src/eval-workflows/input-compilation/index.js';
import { validResolvedCliInput } from './fixtures.js';

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function deepClone<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe('compileCliEvaluationInput', () => {
  it('rejects the superseded resolved-input v1 shape without inference', () => {
    const input = deepClone(validResolvedCliInput()) as { schemaVersion: string };
    input.schemaVersion = 'omk.resolved-cli-evaluation-input/v3';

    expect(() => compileCliEvaluationInput(
      input as ReturnType<typeof validResolvedCliInput>,
    )).toThrowError(expect.objectContaining({
      code: 'CLI_INPUT_INVALID',
      fieldPath: 'schemaVersion',
    }));
  });

  it('produces schema-valid, immutable and independently owned contracts', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());

    expect(EvaluationDefinitionSchema.parse(result.definition)).toEqual(result.definition);
    expect(MeasurementPolicySchema.parse(result.policy)).toEqual(result.policy);
    expectDeepFrozen(result);
    expect(result.canonicalDigests).toEqual({
      definition: digestCanonicalJson(result.definition),
      policy: digestCanonicalJson(result.policy),
    });
    expect(result.definition.targets.map((target) => target.targetId)).toEqual(['control', 'treatment']);
    expect(result.definition.targets[0].config).toMatchObject({
      behavior: { allowedSkills: [] },
      runtime: { model: 'gpt-example', effort: 'low' },
    });
    expect(result.policy.budget).toMatchObject({
      run: { maxInvocations: 100, maxProviderCost: { amount: 10, currency: 'USD' } },
      stages: {
        execution: { maxInvocations: 40 },
        evaluation: { maxInvocations: 60 },
      },
      coordinate: {
        maxProviderCost: { amount: 1, currency: 'USD' },
        maxActiveDurationMs: 30_000,
      },
    });
    expect(result.policy.retry.maxAttempts).toBe(3);
    expect(result.policy.cache).toEqual({
      executionMode: 'disabled',
      evaluationMode: 'disabled',
    });
  });

  it('keeps execution replay and evaluation reuse independent and host-sourced', () => {
    const input = deepClone(validResolvedCliInput());
    delete input.orchestration.independentSeries;
    delete input.orchestration.resumeSourceLocator;
    input.policy.cache = {
      executionMode: 'replay-only',
      evaluationMode: 'reuse',
    };
    input.orchestration.cacheSources = {
      executionSourceLocator: 'cache://execution/snapshot-a',
      evaluationSourceLocator: 'cache://evaluation/snapshot-b',
    };

    const result = compileCliEvaluationInput(input);

    expect(result.policy.cache).toEqual({
      executionMode: 'replay-only',
      evaluationMode: 'reuse',
    });
    expect(result.orchestration.cacheSources).toEqual({
      executionSourceLocator: 'cache://execution/snapshot-a',
      evaluationSourceLocator: 'cache://evaluation/snapshot-b',
    });
    expect(canonicalizeJson(result.policy)).not.toContain('snapshot-a');
    expect(canonicalizeJson(result.policy)).not.toContain('snapshot-b');

    const moved = deepClone(input);
    moved.orchestration.cacheSources = {
      executionSourceLocator: 'cache://other-host/execution',
      evaluationSourceLocator: 'cache://other-host/evaluation',
    };
    expect(compileCliEvaluationInput(moved).canonicalDigests).toEqual(result.canonicalDigests);
  });

  it.each([
    ['execution replay', 'replay-only', 'disabled', 'executionSourceLocator'],
    ['execution transparent cache', 'transparent-deterministic', 'disabled', 'executionSourceLocator'],
    ['evaluation reuse', 'disabled', 'reuse', 'evaluationSourceLocator'],
  ] as const)(
    'requires an explicit cache source for %s',
    (_label, executionMode, evaluationMode, field) => {
      const input = deepClone(validResolvedCliInput());
      delete input.orchestration.independentSeries;
      delete input.orchestration.resumeSourceLocator;
      input.policy.cache = { executionMode, evaluationMode };

      expect(() => compileCliEvaluationInput(input)).toThrowError(expect.objectContaining({
        code: 'CLI_INPUT_CACHE_SOURCE_REQUIRED',
        fieldPath: `orchestration.cacheSources.${field}`,
      }));
    },
  );

  it('rejects a cache source when its stage is disabled', () => {
    const input = deepClone(validResolvedCliInput());
    input.orchestration.cacheSources = {
      executionSourceLocator: 'cache://execution/unused',
    };

    expect(() => compileCliEvaluationInput(input)).toThrowError(expect.objectContaining({
      code: 'CLI_INPUT_CACHE_SOURCE_UNUSED',
      fieldPath: 'orchestration.cacheSources.executionSourceLocator',
    }));
  });

  it.each([
    ['independent Series', 'CLI_INPUT_CACHE_SERIES_CONFLICT'],
    ['resume', 'CLI_INPUT_RESUME_CACHE_CONFLICT'],
  ] as const)('does not let replay masquerade as %s evidence', (flow, code) => {
    const input = deepClone(validResolvedCliInput());
    input.policy.cache.executionMode = 'replay-only';
    input.orchestration.cacheSources = {
      executionSourceLocator: 'cache://execution/snapshot',
    };
    if (flow === 'independent Series') delete input.orchestration.resumeSourceLocator;
    else delete input.orchestration.independentSeries;

    expect(() => compileCliEvaluationInput(input)).toThrowError(expect.objectContaining({ code }));
  });

  it('keeps expected, evaluation context and analysis-only membership out of target execution', () => {
    const { definition } = compileCliEvaluationInput(validResolvedCliInput());
    const execution = projectExecutionInputs(definition.dataset);
    const evaluation = projectEvaluationInputs(definition.dataset);
    const analysis = projectAnalysisInputs(definition.dataset);

    expect(canonicalizeJson(execution)).not.toContain('expected');
    expect(canonicalizeJson(execution)).not.toContain('evaluationContext');
    expect(canonicalizeJson(execution)).not.toContain('memberships');
    expect(canonicalizeJson(evaluation)).toContain('expected');
    expect(canonicalizeJson(evaluation)).toContain('evaluationContext');
    expect(canonicalizeJson(evaluation)).not.toContain('memberships');
    expect(canonicalizeJson(analysis)).toContain('memberships');
    expect(canonicalizeJson(analysis)).not.toContain('expected');
  });

  it('expands judge ensemble and replicates into explicit Core measurement identities', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());
    const judges = result.definition.evaluators.filter((evaluator) => evaluator.evaluatorKind === 'llm-rubric');
    expect(judges).toHaveLength(4);
    expect(judges.map((evaluator) => evaluator.measurement)).toEqual([
      {
        instrumentId: 'rubric-correctness-v1', ensembleMemberId: 'judge-a',
        replicateGroupId: 'rubric-primary', replicateIndex: 0,
      },
      {
        instrumentId: 'rubric-correctness-v1', ensembleMemberId: 'judge-a',
        replicateGroupId: 'rubric-primary', replicateIndex: 1,
      },
      {
        instrumentId: 'rubric-correctness-v1', ensembleMemberId: 'judge-b',
        replicateGroupId: 'rubric-primary', replicateIndex: 0,
      },
      {
        instrumentId: 'rubric-correctness-v1', ensembleMemberId: 'judge-b',
        replicateGroupId: 'rubric-primary', replicateIndex: 1,
      },
    ]);
    const judgeBindings = result.runtimeBinding.bindings.filter((binding) => (
      binding.runtimeKind === 'evaluator'
      && binding.implementationId === 'omk.rubric-judge/v1'
    ));
    expect(judgeBindings).toHaveLength(4);
  });

  it('does not resolve or bind unused judges when judging is disabled', () => {
    const input = deepClone(validResolvedCliInput());
    input.judges.enabled = false;
    input.judges.members = [];
    const result = compileCliEvaluationInput(input);

    expect(result.definition.evaluators.map((evaluator) => evaluator.evaluatorKind)).toEqual(['assertion']);
    expect(result.runtimeBinding.bindings.some((binding) => (
      binding.runtimeKind === 'evaluator' && binding.implementationId.includes('judge')
    ))).toBe(false);
  });

  it('compiles independent repeats as an explicit Evaluation Series design', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());
    const series = result.orchestration.independentSeries;
    expect(series?.definition.experimentalUnit).toBe('run');
    expect(series?.definition.members).toHaveLength(3);
    expect(series?.memberships.map((membership) => membership.replicateIndex)).toEqual([0, 1, 2]);
    expect(series?.memberships.every((membership) => (
      membership.seriesDesignDigest === series.definition.seriesDesignDigest
    ))).toBe(true);
    expect(series?.definition.comparabilityPolicy.minimumStatus).toBe('conditional');
    expect(result.definition.experiment.trials).toBe(1);
    expect(result.policy.retry.maxAttempts).toBe(3);
  });

  it('binds Series identity to both the host instance and the complete Series design', () => {
    const twoRuns = deepClone(validResolvedCliInput());
    const threeRuns = deepClone(validResolvedCliInput());
    if (twoRuns.orchestration.independentSeries === undefined
        || threeRuns.orchestration.independentSeries === undefined) {
      throw new Error('fixture is incomplete');
    }
    twoRuns.orchestration.independentSeries.repeatCount = 2;
    threeRuns.orchestration.independentSeries.repeatCount = 3;

    const twoRunSeries = compileCliEvaluationInput(twoRuns).orchestration.independentSeries;
    const threeRunSeries = compileCliEvaluationInput(threeRuns).orchestration.independentSeries;
    expect(twoRunSeries?.definition.seriesId).not.toBe(threeRunSeries?.definition.seriesId);
    expect(twoRunSeries?.definition.seriesId).toContain('repeat-series-run-20260830');
  });

  it('requires the host to allocate a Series instance identity before compilation', () => {
    const input = deepClone(validResolvedCliInput());
    if (input.orchestration.independentSeries === undefined) {
      throw new Error('fixture is incomplete');
    }
    delete (input.orchestration.independentSeries as { seriesInstanceId?: string }).seriesInstanceId;

    expect(() => compileCliEvaluationInput(input)).toThrowError(expect.objectContaining({
      code: 'CLI_INPUT_SERIES_INVALID',
      fieldPath: 'orchestration.independentSeries.seriesInstanceId',
    }));
  });

  it('keeps holdout, bootstrap, composite and gate semantics in explicit Core fields', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());
    expect(result.definition.dataset.analysisCohorts?.map((cohort) => cohort.cohortId))
      .toEqual(['holdout', 'train']);
    expect(result.definition.analysisGraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'bootstrap-difference',
        cohortFilter: { includeCohortIds: ['holdout'] },
        parameters: { resamples: 1000, alpha: 0.05 },
      }),
      expect.objectContaining({
        nodeId: 'composite-score',
        parameters: { weights: { assertion: 0.5, rubric: 0.5 } },
      }),
    ]));
    expect(result.definition.decisionPolicy).toMatchObject({
      decisionPolicyId: 'release-gate',
      parameters: { threshold: 3.5, trivialDifference: 0.1 },
    });
  });

  it('treats report-only as presentation and preserves the Core decision', () => {
    const input = deepClone(validResolvedCliInput());
    input.presentation.exitMode = 'report-only';
    const result = compileCliEvaluationInput(input);

    expect(result.presentation.exitMode).toBe('report-only');
    expect(result.definition.decisionPolicy?.decisionPolicyId).toBe('release-gate');
  });

  it('makes CLI/YAML source, property order, locator and lineage irrelevant to measurement digests', () => {
    const left = validResolvedCliInput();
    const right = deepClone(left);
    right.hostResources.resources.reverse();
    for (const resource of right.hostResources.resources) {
      resource.locator = `/other-machine/${resource.descriptor.resourceId}`;
      resource.lineage = { sourcePath: `moved/${resource.descriptor.resourceId}`, commit: 'different' };
    }
    right.targets.reverse();
    right.dataset.samples.reverse();
    right.judges.members.reverse();
    right.staticRunMetadata = { annotations: { source: 'eval.yaml' } };

    const leftResult = compileCliEvaluationInput(left);
    const rightResult = compileCliEvaluationInput(right);
    expect(rightResult.canonicalDigests).toEqual(leftResult.canonicalDigests);
    expect(rightResult.hostResources).not.toEqual(leftResult.hostResources);
  });

  it('canonicalizes nested analysis memberships and cohort filters with Core rules', () => {
    const left = deepClone(validResolvedCliInput());
    left.dataset.analysisCohorts?.push({
      cohortId: 'tag-a',
      cohortSetId: 'tags',
      cohortSetKind: 'cohort',
      classification: 'gold',
      disclosure: 'identity-only',
    });
    left.dataset.samples[0].analysis?.memberships.push({ cohortId: 'tag-a' });
    const bootstrap = left.analysisGraph.nodes.find((node) => node.nodeId === 'bootstrap-difference');
    if (bootstrap?.cohortFilter?.includeCohortIds === undefined) {
      throw new Error('fixture is incomplete');
    }
    bootstrap.cohortFilter.includeCohortIds.push('tag-a');
    const right = deepClone(left);
    right.dataset.samples[0].analysis?.memberships.reverse();
    const rightBootstrap = right.analysisGraph.nodes.find((node) => (
      node.nodeId === 'bootstrap-difference'
    ));
    rightBootstrap?.cohortFilter?.includeCohortIds?.reverse();

    const leftResult = compileCliEvaluationInput(left);
    const rightResult = compileCliEvaluationInput(right);
    expect(rightResult.canonicalDigests).toEqual(leftResult.canonicalDigests);
    expect(rightResult.definition).toEqual(leftResult.definition);
  });

  it('changes behavior identity when injected artifact bytes change', () => {
    const left = validResolvedCliInput();
    const right = deepClone(left);
    const target = right.targets.find((candidate) => candidate.targetId === 'treatment');
    const resource = right.hostResources.resources.find((candidate) => (
      candidate.descriptor.resourceId === 'artifact-treatment'
    ));
    const changedDigest = digestCanonicalJson({ body: '# Skill\nChanged behavior.' });
    if (target === undefined || resource === undefined) throw new Error('fixture is incomplete');
    target.behavior.artifact.digest = changedDigest;
    resource.descriptor.digest = changedDigest;
    resource.verification.verifiedDigest = changedDigest;

    expect(compileCliEvaluationInput(right).canonicalDigests.definition)
      .not.toBe(compileCliEvaluationInput(left).canonicalDigests.definition);
  });

  it('keeps locators, presentation and orchestration fields out of Core canonical JSON', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());
    const core = canonicalizeJson({ definition: result.definition, policy: result.policy });
    expect(core).not.toContain('/repo/');
    expect(core).not.toContain('resumeSourceLocator');
    expect(core).not.toContain('outputDirectoryLocator');
    expect(core).not.toContain('report-only');
    expect(core).not.toContain('sourcePath');
    expect(core).not.toContain('RunConfig');
    expect(core).not.toContain('VariantSpec');
    expect(canonicalizeJson(result.runOptions)).not.toContain('runId');
    expect(canonicalizeJson(result.runOptions)).not.toContain('AbortSignal');
    expect(canonicalizeJson(result.runOptions)).not.toContain('EventWriter');
  });

  it('fails with a stable host error when a resource binding is dishonest', () => {
    const input = deepClone(validResolvedCliInput());
    input.hostResources.resources[0].verification.verifiedDigest = digestCanonicalJson('different');

    expect(() => compileCliEvaluationInput(input)).toThrowError(CliEvaluationInputError);
    try {
      compileCliEvaluationInput(input);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'CLI_INPUT_RESOURCE_DIGEST_MISMATCH',
        fieldPath: expect.stringContaining('verification'),
      });
      expect((error as Error).message).toContain('验证摘要');
    }
  });

  it('requires HostResource v3 size, verification and secret control invariants', () => {
    const missingSize = deepClone(validResolvedCliInput());
    delete (missingSize.hostResources.resources[0].descriptor as { size?: number }).size;
    expect(() => compileCliEvaluationInput(missingSize)).toThrowError(expect.objectContaining({
      code: 'CLI_INPUT_INVALID',
      fieldPath: expect.stringContaining('hostResources.'),
    }));

    const invalidVerification = deepClone(validResolvedCliInput());
    const content = invalidVerification.hostResources.resources.find((resource) => (
      resource.resourceKind === 'content'
    ));
    if (content === undefined) throw new Error('fixture is incomplete');
    content.verification = {
      verificationKind: 'tree-digest',
      verifiedDigest: content.descriptor.digest,
    };
    expect(() => compileCliEvaluationInput(invalidVerification)).toThrowError(
      expect.objectContaining({
        code: 'CLI_INPUT_INVALID',
        fieldPath: `hostResources.${content.descriptor.resourceId}`,
      }),
    );

    for (const resourceKind of ['mcp-config', 'mock-rule', 'mock-payload'] as const) {
      const invalidClassification = deepClone(validResolvedCliInput());
      const resource = invalidClassification.hostResources.resources.find((candidate) => (
        candidate.resourceKind === resourceKind
      ));
      if (resource === undefined) throw new Error('fixture is incomplete');
      resource.descriptor.classification = 'sensitive';
      expect(() => compileCliEvaluationInput(invalidClassification)).toThrowError(
        expect.objectContaining({
          code: 'CLI_INPUT_INVALID',
          fieldPath: `hostResources.${resource.descriptor.resourceId}`,
        }),
      );
    }

    const invalidMockRuleMediaType = deepClone(validResolvedCliInput());
    const mockRule = invalidMockRuleMediaType.hostResources.resources.find((resource) => (
      resource.resourceKind === 'mock-rule'
    ));
    if (mockRule === undefined) throw new Error('fixture is incomplete');
    mockRule.descriptor.mediaType = 'text/plain';
    expect(() => compileCliEvaluationInput(invalidMockRuleMediaType)).toThrowError(
      expect.objectContaining({
        code: 'CLI_INPUT_INVALID',
        fieldPath: `hostResources.${mockRule.descriptor.resourceId}`,
      }),
    );
  });

  it.each([
    ['artifact-control', 'workspace', 'targets.control.behavior.artifact'],
    [
      'workspace-tree',
      'artifact',
      'targets.treatment.executionControls.workspace.0.descriptor',
    ],
    ['mcp-config', 'artifact', 'targets.treatment.behavior.mcpConfig'],
    ['mock-search-rule', 'content', 'targets.treatment.behavior.mocks.0.rule'],
    ['mock-search-response', 'content', 'targets.treatment.behavior.mocks.0.payloads.0'],
    ['rubric-correctness', 'artifact', 'evaluatorTemplates.rubric.resources.0'],
    ['gold-dataset', 'content', 'orchestration.gold.resourceId'],
  ] as const)(
    'rejects a host resource kind that contradicts its reference role: %s',
    (resourceId, resourceKind, fieldPath) => {
      const input = deepClone(validResolvedCliInput());
      const resource = input.hostResources.resources.find((candidate) => (
        candidate.descriptor.resourceId === resourceId
      ));
      if (resource === undefined) throw new Error('fixture is incomplete');
      resource.resourceKind = resourceKind;

      expect(() => compileCliEvaluationInput(input)).toThrowError(expect.objectContaining({
        code: 'CLI_INPUT_RESOURCE_KIND_MISMATCH',
        fieldPath,
        details: expect.objectContaining({ resourceId, actualResourceKind: resourceKind }),
      }));
    },
  );

  it('wraps Core reference and static semantic failures in a stable host error', () => {
    const input = deepClone(validResolvedCliInput());
    input.evaluatorTemplates[0].metricIds = ['missing-metric'];

    expect(() => compileCliEvaluationInput(input)).toThrowError(expect.objectContaining({
      code: 'CLI_INPUT_CORE_SEMANTICS_INVALID',
      fieldPath: 'definition',
      details: expect.objectContaining({ coreCode: 'EVAL_DEFINITION_MISSING_REFERENCE' }),
    }));
  });

  it('derives Runtime bindings from Definition requirements without override fields', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());
    expect(result.definition.targets.find((target) => target.targetId === 'treatment')
      ?.executionRequirements).toEqual({
      systemInstructions: 'required',
      workspace: 'copy-on-write-overlay',
      mcp: 'native-config',
      mockInterception: 'pre-tool-call',
      toolPolicy: 'allow-list',
      skillDiscovery: 'runtime-default',
      sandboxId: 'omk.local-sandbox/v1',
    });
    expect(result.definition.targets.find((target) => target.targetId === 'control')
      ?.executionRequirements).toEqual({
      systemInstructions: 'not-required',
      workspace: 'copy-on-write-overlay',
      mcp: 'native-config',
      mockInterception: 'pre-tool-call',
      toolPolicy: 'allow-list',
      skillDiscovery: 'disabled',
    });
    for (const target of result.definition.targets) {
      const binding = result.runtimeBinding.bindings.find((candidate) => (
        candidate.runtimeKind === 'executor' && candidate.targetId === target.targetId
      ));
      expect(binding).toMatchObject({
        runtimeKind: 'executor',
        targetId: target.targetId,
        implementationId: target.executorId,
        protocolId: target.protocolId,
        behaviorConfigDigest: digestCanonicalJson(target.config ?? null),
        executionControlsDigest: digestCanonicalJson(target.executionControls),
      });
      expect(JSON.stringify(target.config)).not.toContain('allowedTools');
      expect(JSON.stringify(target.config)).not.toContain('workspace');
      expect(binding).not.toHaveProperty('model');
      expect(binding).not.toHaveProperty('config');
      if (binding?.runtimeKind === 'executor') {
        expect(binding.qualification).toMatchObject({
          model: 'gpt-example',
          effort: 'low',
          executionRequirements: {
            workspace: 'copy-on-write-overlay',
            mcp: 'native-config',
            mockInterception: 'pre-tool-call',
            toolPolicy: 'allow-list',
          },
          resourceIntegrity: 'digest-before-use',
        });
        expect(binding.qualification.executionRequirements)
          .toEqual(target.executionRequirements);
      }
    }
    const treatmentBinding = result.runtimeBinding.bindings.find((binding) => (
      binding.runtimeKind === 'executor' && binding.targetId === 'treatment'
    ));
    expect(treatmentBinding).toMatchObject({
      qualification: {
        executionRequirements: { sandboxId: 'omk.local-sandbox/v1' },
      },
    });
    const judgeBinding = result.runtimeBinding.bindings.find((binding) => (
      binding.runtimeKind === 'evaluator'
      && binding.implementationId === 'omk.rubric-judge/v1'
      && binding.measurement.ensembleMemberId === 'judge-a'
    ));
    expect(judgeBinding).toMatchObject({
      qualification: {
        executorId: 'anthropic-api',
        model: 'judge-a',
        promptVariant: 'rubric-length-debias-on/v1',
        resourceIntegrity: 'digest-before-use',
      },
    });
    const bindingJson = canonicalizeJson(result.runtimeBinding);
    expect(result.runtimeBinding.schemaVersion).toBe('omk.runtime-binding-request/v4');
    expect(bindingJson).not.toContain('capabilities');
    expect(bindingJson).not.toContain('fingerprint');
    expect(bindingJson).not.toContain('assuranceLevel');
    expect(result.runtimeBinding.bindings).toContainEqual({
      runtimeKind: 'missing-policy',
      bindingId: 'missing-policy-exclude/v1',
      policyId: 'exclude/v1',
      implementationId: 'exclude/v1',
    });
    expect(result.runtimeBinding.bindings).toContainEqual({
      runtimeKind: 'analysis-node',
      bindingId: 'sampling-estimator-bootstrap.mean-difference/v1',
      referenceId: 'bootstrap.mean-difference/v1',
      requirementKind: 'sampling-estimator',
      analysisNodeKind: 'estimator',
      implementationId: 'bootstrap.mean-difference/v1',
    });
  });

  it('does not claim mock interception for an explicitly empty mock set', () => {
    const input = deepClone(validResolvedCliInput());
    for (const target of input.targets) target.behavior.mocks = [];
    const result = compileCliEvaluationInput(input);

    expect(result.definition.targets.every((target) => (
      target.executionRequirements.mockInterception === 'not-required'
    ))).toBe(true);
    expect(result.runtimeBinding.bindings.filter((binding) => binding.runtimeKind === 'executor')
      .every((binding) => (
        binding.qualification.executionRequirements.mockInterception === 'not-required'
      ))).toBe(true);
  });

  it('preserves mock return-sequence order as observable Target behavior', () => {
    const input = deepClone(validResolvedCliInput());
    const resource = input.hostResources.resources.find((candidate) => (
      candidate.resourceKind === 'mock-payload'
    ))!;
    const second = {
      ...structuredClone(resource),
      descriptor: { ...structuredClone(resource.descriptor), resourceId: 'mock-second' },
      locator: '/repo/mocks/second.json',
    };
    input.hostResources.resources.push(second);
    const target = input.targets.find((candidate) => candidate.targetId === 'treatment')!;
    target.behavior.mocks![0].payloads = [second.descriptor, resource.descriptor];

    const compiled = compileCliEvaluationInput(input);
    const behavior = compiled.definition.targets.find((candidate) => (
      candidate.targetId === 'treatment'
    ))!.config as { behavior: { mocks: Array<{ payloads: Array<{ resourceId: string }> }> } };

    expect(behavior.behavior.mocks[0].payloads.map((payload) => payload.resourceId)).toEqual([
      'mock-second', 'mock-search-response',
    ]);
  });

  it('rejects inline secret evaluator or target configuration', () => {
    const input = deepClone(validResolvedCliInput());
    const target = input.targets.find((candidate) => candidate.targetId === 'treatment');
    if (target === undefined) throw new Error('fixture is incomplete');
    target.behavior.config = {
      classification: 'public',
      value: { token: 'secret' },
    };
    (target.behavior.config as { classification: string }).classification = 'secret';

    expect(() => compileCliEvaluationInput(input)).toThrowError(expect.objectContaining({
      code: 'CLI_INPUT_RESTRICTED_INLINE_CONTENT',
    }));
  });

  it('rejects accessor-backed input rather than executing effectful getters', () => {
    const input = deepClone(validResolvedCliInput());
    let getterCalls = 0;
    Object.defineProperty(input.presentation, 'unexpected', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'effect';
      },
    });

    expect(() => compileCliEvaluationInput(input)).toThrowError(expect.objectContaining({
      code: 'CLI_INPUT_INVALID',
    }));
    expect(getterCalls).toBe(0);
  });
});
